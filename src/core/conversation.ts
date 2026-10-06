import { AppError } from '../shared/errors.js';
import type { LLMEvent, LLMMessage, LLMProvider } from '../providers/types.js';
import type { MemorySelection } from './memory.js';
import { memoryPrompt, skillsPrompt } from './prompt.js';
import { compactHistory, defaultContext } from './context.js';
import { skillManifest } from './skills.js';
import type { SkillSelection, SkillManifest } from './skills.js';

export interface ConversationOptions {
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  maxHistoryMessages?: number;
  maxContextCharacters?: number;
  maxResponseCharacters?: number;
  memory?: (query: string, signal: AbortSignal) => Promise<MemorySelection>;
  skills?: (
    query: string,
    signal: AbortSignal,
    explicit: readonly string[],
  ) => Promise<SkillSelection>;
}

const SYSTEM_MESSAGE: LLMMessage = {
  role: 'system',
  content:
    "You are MewCode Agent, a programming conversation assistant. You currently have no file, shell or external tools. Do not claim to have inspected or changed files. Answer in the user's language.",
};

export class Conversation {
  private messages: LLMMessage[] = [];
  private busy = false;
  private selectedSkills: SkillManifest | undefined;

  constructor(
    private readonly provider: LLMProvider,
    private readonly options: ConversationOptions,
  ) {}

  get history(): readonly LLMMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  get model(): string {
    return this.options.model;
  }

  get skillSources(): SkillManifest | undefined {
    return this.selectedSkills ? structuredClone(this.selectedSkills) : undefined;
  }

  private idle(): void {
    if (this.busy) throw new AppError('BUSY', '当前回答尚未结束，不能更改会话。');
  }

  clear(): void {
    this.idle();
    this.messages = [];
    this.selectedSkills = undefined;
  }

  setModel(model: string): void {
    this.idle();
    if (!/^[\p{L}\p{N}_.:/-]{1,128}$/u.test(model))
      throw new AppError('COMMAND_INVALID', '模型名称无效。');
    this.options.model = model;
  }

  compact(): string {
    this.idle();
    if (!this.messages.length) return '当前没有可压缩的历史。';
    const result = compactHistory([SYSTEM_MESSAGE, ...this.messages], defaultContext);
    if (!result) return '历史较短或压缩不能减小体积，保留原文。';
    this.messages = result.messages.slice(1);
    return `本地历史摘录：${result.beforeBytes} → ${result.afterBytes} bytes；细节可能省略。`;
  }

  async *send(
    prompt: string,
    signal: AbortSignal = new AbortController().signal,
    explicitSkills: readonly string[] = [],
  ): AsyncIterable<LLMEvent> {
    if (this.busy) throw new AppError('BUSY', '当前回答尚未结束。');
    if (!prompt.trim()) throw new AppError('INVALID_PROMPT', '请输入非空问题。');
    if (signal.aborted) throw new AppError('CANCELLED', '请求已取消。');
    const user: LLMMessage = { role: 'user', content: prompt };
    const requestMessages = [{ ...SYSTEM_MESSAGE }, ...this.messages, user];
    if (
      this.messages.length + 2 > (this.options.maxHistoryMessages ?? 40) ||
      requestMessages.reduce((size, message) => size + message.content.length, 0) >
        (this.options.maxContextCharacters ?? 100_000)
    ) {
      throw new AppError(
        'CONTEXT_LIMIT',
        '会话已达到当前上下文上限，请使用 /compact 或 /clear 后重试。',
      );
    }
    this.busy = true;
    this.selectedSkills = undefined;
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, this.options.timeoutMs);
    timer.unref();
    const combined = AbortSignal.any([signal, deadline.signal]);
    let response = '';
    let finish: 'stop' | 'length' | undefined;
    try {
      if (this.options.memory) {
        const memory = await this.options.memory(prompt, combined);
        if (memory.entries.length)
          requestMessages[0] = {
            role: 'system',
            content: `${SYSTEM_MESSAGE.content}\n\n## memory\n${memoryPrompt(memory)}`,
          };
        if (
          requestMessages.reduce((size, message) => size + message.content.length, 0) >
          (this.options.maxContextCharacters ?? 100_000)
        )
          throw new AppError('CONTEXT_LIMIT', '记忆与会话超过上下文上限，本轮未发送模型请求。');
      }
      if (this.options.skills) {
        const selected = await this.options.skills(prompt, combined, explicitSkills);
        this.selectedSkills = skillManifest(selected);
        if (selected.entries.length)
          requestMessages[0]!.content += `\n\n## skills\n${skillsPrompt(selected, false)}`;
        if (
          requestMessages.reduce((size, message) => size + message.content.length, 0) >
          (this.options.maxContextCharacters ?? 100_000)
        )
          throw new AppError('CONTEXT_LIMIT', '技能与会话超过上下文上限，本轮未发送模型请求。');
      } else if (explicitSkills.length)
        throw new AppError('SKILL_INVALID', '当前会话未配置技能来源。');
      if (combined.aborted) throw new AppError('CANCELLED', '请求已取消，未调用模型。');
      for await (const event of this.provider.stream(
        {
          model: this.options.model,
          messages: requestMessages,
          maxOutputTokens: this.options.maxOutputTokens,
        },
        combined,
      )) {
        if (combined.aborted) throw new AppError('CANCELLED', '请求已取消。');
        if (finish !== undefined)
          throw new AppError('MODEL_PROTOCOL', '模型在结束后继续返回事件。');
        if (
          event.type === 'tool_call_delta' ||
          (event.type === 'finish' && event.reason === 'tool_calls')
        )
          throw new AppError('MODEL_UNSUPPORTED', 'chat 不执行工具，请使用 run 命令。');
        if (event.type === 'text_delta') {
          response += event.text;
          if (response.length > (this.options.maxResponseCharacters ?? 200_000)) {
            deadline.abort();
            throw new AppError('CONTEXT_LIMIT', '回答超过当前输出上限，本轮残缺内容未加入会话。');
          }
        }
        if (event.type === 'finish') {
          if (event.reason === 'tool_calls')
            throw new AppError('MODEL_UNSUPPORTED', 'chat 不执行工具，请使用 run 命令。');
          finish = event.reason;
        } else yield event;
      }
      if (combined.aborted) throw new AppError('CANCELLED', '请求已取消。');
      if (finish === undefined)
        throw new AppError('MODEL_PROTOCOL', '模型流未正常结束，本轮未加入会话。');
      this.messages.push(user, { role: 'assistant', content: response });
      yield { type: 'finish', reason: finish };
    } catch (error) {
      if (timedOut && !signal.aborted)
        throw new AppError('MODEL_TIMEOUT', '模型请求超过总时间限制，本轮残缺内容未加入会话。');
      if (signal.aborted) throw new AppError('CANCELLED', '请求已取消，本轮残缺内容未加入会话。');
      if (error instanceof AppError) throw error;
      throw new AppError('MODEL_PROTOCOL', '模型请求失败，本轮未加入会话。');
    } finally {
      clearTimeout(timer);
      deadline.abort();
      this.busy = false;
    }
  }
}
