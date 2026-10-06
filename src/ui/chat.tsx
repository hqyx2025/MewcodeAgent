import { useEffect, useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import type { Conversation } from '../core/conversation.js';
import { AppError } from '../shared/errors.js';
import { terminalText } from '../shared/terminal-text.js';
import type { CommandRegistry, CommandResult } from '../core/commands.js';

interface Turn {
  id: number;
  prompt: string;
  answer: string;
  status: 'streaming' | 'done' | 'length' | 'cancelled' | 'error';
  error?: string;
}

export interface ChatProps {
  conversation: Conversation;
  model: string;
  provider: string;
  commands?: CommandRegistry;
  onAgent?: (result: Extract<CommandResult, { kind: 'agent' }>) => void;
}

function TurnView({ turn }: { turn: Turn }) {
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color="cyan">你 › {terminalText(turn.prompt)}</Text>
      <Text>
        {terminalText(turn.answer) ||
          (turn.status === 'streaming' ? '正在等待模型…' : '（空回答）')}
      </Text>
      {turn.error && (
        <Text color={turn.status === 'cancelled' ? 'yellow' : 'red'}>{turn.error}</Text>
      )}
      {turn.status === 'length' && <Text color="yellow">达到输出限制，回答已截断。</Text>}
    </Box>
  );
}

export function Chat({ conversation, model, provider, commands, onAgent }: ChatProps) {
  const { exit } = useApp();
  const [input, setInput] = useState('');
  const [completed, setCompleted] = useState<Turn[]>([]);
  const [active, setActive] = useState<Turn | undefined>();
  const [usage, setUsage] = useState('');
  const [notice, setNotice] = useState('');
  const [currentModel, setCurrentModel] = useState(model);
  const running = useRef(false);
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);
  const nextId = useRef(0);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(
    () => () => {
      mounted.current = false;
      controller.current?.abort();
      clearTimeout(flushTimer.current);
    },
    [],
  );

  const send = async (prompt: string, skills: readonly string[] = []) => {
    running.current = true;
    const signalController = new AbortController();
    controller.current = signalController;
    const turn: Turn = { id: nextId.current++, prompt, answer: '', status: 'streaming' };
    setActive({ ...turn });
    setInput('');
    setUsage('');
    const flush = () => {
      flushTimer.current = undefined;
      if (mounted.current) setActive({ ...turn });
    };
    try {
      for await (const event of conversation.send(prompt, signalController.signal, skills)) {
        const sources = conversation.skillSources;
        if (mounted.current && sources)
          setNotice(
            terminalText(
              [
                ...sources.sources.map(
                  (source) => `技能：${source.name} [${source.reason}] ${source.path}`,
                ),
                ...sources.warnings.map((warning) => `技能警告：${warning.source} ${warning.code}`),
              ].join('\n'),
            ),
          );
        if (event.type === 'text_delta') {
          turn.answer += event.text;
          if (flushTimer.current === undefined) flushTimer.current = setTimeout(flush, 30);
        }
        if (event.type === 'usage' && mounted.current) {
          setUsage(
            `${event.estimated ? '估算 ' : ''}token：输入 ${event.inputTokens} / 输出 ${event.outputTokens}`,
          );
        }
        if (event.type === 'finish') turn.status = event.reason === 'length' ? 'length' : 'done';
      }
    } catch (error) {
      turn.status = error instanceof AppError && error.code === 'CANCELLED' ? 'cancelled' : 'error';
      turn.error =
        error instanceof AppError ? `[${error.code}] ${error.message}` : '请求失败，请重试。';
    } finally {
      clearTimeout(flushTimer.current);
      flushTimer.current = undefined;
      running.current = false;
      controller.current = undefined;
      if (mounted.current) {
        setCompleted((turns) => [...turns, { ...turn }]);
        setActive(undefined);
      }
    }
  };

  const submit = async (text: string) => {
    if (!commands) {
      await send(text);
      return;
    }
    running.current = true;
    setInput('');
    setNotice('正在处理命令…');
    try {
      const result = await commands.execute(text);
      if (!mounted.current) return;
      if (result.kind === 'local') {
        if (result.clear) {
          setCompleted([]);
          setUsage('');
        }
        setCurrentModel(conversation.model);
        setNotice(terminalText(result.text));
      } else if (result.kind === 'agent') {
        if (!onAgent) throw new AppError('COMMAND_INVALID', '当前界面没有 Agent 任务入口。');
        onAgent(result);
        exit();
      } else {
        if (completed.length >= 200)
          throw new AppError('CONTEXT_LIMIT', '展示已达上限，请先使用 /clear。');
        setNotice('');
        await send(result.prompt, result.skills);
      }
    } catch (error) {
      if (mounted.current)
        setNotice(
          error instanceof AppError ? `[${error.code}] ${error.message}` : '命令处理失败。',
        );
    } finally {
      running.current = false;
    }
  };

  useInput((text, key) => {
    if (key.ctrl && text === 'c') {
      mounted.current = false;
      controller.current?.abort();
      exit();
      return;
    }
    if (key.escape) {
      controller.current?.abort();
      return;
    }
    if (running.current) return;
    if (key.return) {
      if (input.trim() && (completed.length < 200 || input.trim().startsWith('/')))
        void submit(input);
      return;
    }
    if (key.tab && commands) {
      const matches = commands.complete(input);
      if (matches.length === 1) setInput(`${matches[0]} `);
      else if (matches.length) setNotice(matches.join('  '));
      return;
    }
    if (key.backspace || key.delete) {
      const segments = Array.from(
        new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(input),
        (part) => part.segment,
      );
      setInput(segments.slice(0, -1).join(''));
      return;
    }
    if (
      !key.ctrl &&
      !key.meta &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.tab
    ) {
      setInput((value) => (value + terminalText(text).replace(/\n/g, ' ')).slice(0, 65_536));
    }
  });

  return (
    <Box flexDirection="column">
      {completed.slice(-20).map((turn) => (
        <TurnView key={turn.id} turn={turn} />
      ))}
      <Text bold color="green">
        MewCode Agent · {terminalText(provider)} / {terminalText(currentModel)}
      </Text>
      {active && <TurnView turn={active} />}
      <Text color="cyan">› {input || (active ? '生成中…' : '输入问题')}</Text>
      <Text dimColor>
        {completed.length >= 200
          ? '展示已达上限，请退出并开启新会话。'
          : active
            ? 'Esc 取消当前回答 · Ctrl+C 退出'
            : 'Enter 发送 · Ctrl+C 退出'}
      </Text>
      {usage && <Text dimColor>{usage}</Text>}
      {notice && <Text color="yellow">{notice}</Text>}
    </Box>
  );
}
