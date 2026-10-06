import { createInterface } from 'node:readline/promises';
import type { LoadedConfiguration } from '../config/load.js';
import { AgentLoop } from '../core/agent-loop.js';
import { createProvider } from '../providers/create.js';
import { AppError } from '../shared/errors.js';
import { terminalText } from '../shared/terminal-text.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { ToolExecutor } from '../tools/executor.js';
import type { ApprovalRequest } from '../tools/types.js';

export interface RunCLIOptions {
  json?: boolean;
  maxTurns?: string;
  maxTotalTokens?: string;
  timeoutMs?: string;
}

function positive(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max)
    throw new AppError('CONFIG_INVALID', 'run 预算参数必须为有效范围内的正整数。');
  return number;
}

export async function approveTool(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(`需要审批的 ${terminalText(request.name)} 已拒绝：非交互终端无法确认。\n`);
    return false;
  }
  process.stderr.write(
    terminalText(
      `\n授权本次 ${request.name}：${request.target}\n${request.preview}\n参数：${JSON.stringify(request.input, null, 2)}\n`,
    ),
  );
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  // readline handles Ctrl+C itself while it owns the terminal input.
  reader.once('SIGINT', () => process.emit('SIGINT'));
  try {
    return /^(y|yes)$/i.test((await reader.question('允许本次操作？[y/N] ', { signal })).trim());
  } catch {
    return false;
  } finally {
    reader.close();
  }
}

export async function runAgent(
  loaded: LoadedConfiguration,
  task: string,
  options: RunCLIOptions,
): Promise<void> {
  const maxTurns = positive(options.maxTurns, loaded.settings.limits.maxTurns, 1000);
  const timeoutMs = positive(options.timeoutMs, loaded.settings.limits.timeoutMs, 3_600_000);
  const maxTotalTokens = positive(options.maxTotalTokens, 200_000, 100_000_000);
  const provider = await createProvider(loaded.settings);
  const executor = await ToolExecutor.create(createBuiltinRegistry(), {
    root: loaded.cwd,
    mode: loaded.settings.mode,
    timeoutMs,
    approve: approveTool,
  });
  const agent = new AgentLoop(provider, executor, {
    model: loaded.settings.provider.model,
    mode: loaded.settings.mode,
    maxTurns,
    timeoutMs,
    maxOutputTokens: loaded.settings.limits.maxOutputTokens,
    maxTotalTokens,
  });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  try {
    for await (const event of agent.run(task, controller.signal)) {
      if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`);
      else if (event.type === 'text_delta') process.stdout.write(terminalText(event.text));
      else if (event.type === 'tool_start')
        process.stderr.write(terminalText(`\n调用 ${event.name} (${event.callId})\n`));
      else if (event.type === 'tool_result')
        process.stderr.write(
          `${terminalText(event.result.name)}：${event.result.ok ? '成功' : terminalText(event.result.error?.code ?? '失败')}\n`,
        );
      if (event.type === 'finish') {
        if (!options.json) {
          process.stdout.write('\n');
          process.stderr.write(
            `任务停止：${event.reason}；${event.turns} 轮，${event.toolCalls} 次工具调用，${event.estimated ? '估算' : '报告'} token ${event.totalTokens}。\n`,
          );
        }
        if (event.reason !== 'completed') process.exitCode = 1;
      }
    }
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}
