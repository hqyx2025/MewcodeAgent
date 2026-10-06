import { createInterface } from 'node:readline/promises';
import type { LoadedConfiguration } from '../config/load.js';
import { AgentLoop } from '../core/agent-loop.js';
import { createProvider } from '../providers/create.js';
import { AppError } from '../shared/errors.js';
import { terminalText } from '../shared/terminal-text.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { ToolExecutor } from '../tools/executor.js';
import type { ApprovalAnswer, ApprovalRequest } from '../tools/types.js';
import { permissionRuntime } from './permissions.js';
import { MockProvider } from '../providers/mock.js';
import type { PromptManifest } from '../core/prompt.js';

export interface RunCLIOptions {
  json?: boolean;
  maxTurns?: string;
  maxTotalTokens?: string;
  timeoutMs?: string;
  auditFile?: string;
}

function sensitiveValues(loaded: LoadedConfiguration): string[] {
  const name =
    loaded.settings.provider.apiKeyEnv ??
    (loaded.settings.provider.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  const value = process.env[name]?.trim();
  return value ? [value] : [];
}

function printPrompt(manifest: PromptManifest, shownWarnings: Set<string>): void {
  if (manifest.sources.length)
    process.stderr.write(
      terminalText(
        `项目指令来源：${manifest.sources.map((source) => `${source.path} [scope=${source.scope}${source.truncated ? ', truncated' : ''}]`).join('，')}\n`,
      ),
    );
  for (const warning of manifest.warnings) {
    const key = `${warning.path}:${warning.code}`;
    if (shownWarnings.has(key)) continue;
    shownWarnings.add(key);
    process.stderr.write(
      terminalText(`指令警告 ${warning.code}：${warning.path}；${warning.message}\n`),
    );
  }
}

export async function inspectPrompt(loaded: LoadedConfiguration, json: boolean): Promise<void> {
  const executor = await ToolExecutor.create(createBuiltinRegistry(), {
    root: loaded.cwd,
    mode: loaded.settings.mode,
    rules: loaded.permissionRules,
  });
  const manifest = await new AgentLoop(new MockProvider({ delayMs: 0 }), executor, {
    model: loaded.settings.provider.model,
    mode: loaded.settings.mode,
    ...loaded.settings.limits,
    sensitiveValues: sensitiveValues(loaded),
  }).inspectPrompt(AbortSignal.timeout(loaded.settings.limits.timeoutMs));
  if (json) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  else
    process.stdout.write(
      terminalText(
        `系统提示 ${manifest.version}：${manifest.characters} 字符，估算 ${manifest.estimatedTokens} token。\n提示段：${manifest.sections.map((section) => section.id).join(' → ')}\n模式：${manifest.environment.mode}；Shell：${manifest.environment.shell.kind}\n项目指令：${manifest.sources.map((source) => `${source.path} [scope=${source.scope}]`).join('，') || '无'}\n${manifest.warnings.map((warning) => `警告 ${warning.code}：${warning.path}；${warning.message}`).join('\n')}\n`,
      ),
    );
}

function positive(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1 || number > max)
    throw new AppError('CONFIG_INVALID', 'run 预算参数必须为有效范围内的正整数。');
  return number;
}

export async function approveTool(
  request: ApprovalRequest,
  signal: AbortSignal,
): Promise<ApprovalAnswer> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    process.stderr.write(`需要审批的 ${terminalText(request.name)} 已拒绝：非交互终端无法确认。\n`);
    return false;
  }
  process.stderr.write(
    terminalText(
      `\n审批 ${request.name}：${request.target}\n模式：${request.mode}；cwd：${request.cwd}\nShell：${request.shell.kind} (${request.shell.executable})\n${request.preview}\n参数：${JSON.stringify(request.input, null, 2)}\n会话授权仅复用完全相同的参数、目标与预览，不授权命令前缀或整个目录。\n`,
    ),
  );
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  // readline handles Ctrl+C itself while it owns the terminal input.
  reader.once('SIGINT', () => process.emit('SIGINT'));
  try {
    const answer = (
      await reader.question('允许本次[y] / 会话内相同操作[s] / 拒绝[N]：', { signal })
    )
      .trim()
      .toLowerCase();
    return {
      allow: ['y', 'yes', 's'].includes(answer),
      scope: answer === 's' ? 'session' : 'once',
    };
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
  const runtime = await permissionRuntime(loaded, options.auditFile, options.json);
  try {
    const executor = await ToolExecutor.create(createBuiltinRegistry(), {
      root: loaded.cwd,
      mode: loaded.settings.mode,
      timeoutMs,
      approve: approveTool,
      rules: runtime.rules,
      audit: runtime.audit,
    });
    const agent = new AgentLoop(provider, executor, {
      model: loaded.settings.provider.model,
      mode: loaded.settings.mode,
      maxTurns,
      timeoutMs,
      maxOutputTokens: loaded.settings.limits.maxOutputTokens,
      maxTotalTokens,
      sensitiveValues: sensitiveValues(loaded),
    });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    const shownWarnings = new Set<string>();
    try {
      for await (const event of agent.run(task, controller.signal)) {
        if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`);
        else if (event.type === 'prompt_info') printPrompt(event.manifest, shownWarnings);
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
  } finally {
    await runtime.close();
  }
}
