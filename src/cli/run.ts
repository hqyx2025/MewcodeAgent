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
import { MCPManager } from '../mcp/manager.js';
import { SessionStore } from '../core/session.js';
import type { SessionState } from '../core/session.js';
import { relative, join, sep } from 'node:path';
import { referencedValues } from '../mcp/config.js';
import { memoryRuntime, memoryProtection, printMemoryWarnings } from './memory-runtime.js';
import { commandRuntime } from './commands.js';
import { skillRuntime, printSkills } from './skills.js';
import { hookRuntime } from './hooks.js';

export interface RunCLIOptions {
  json?: boolean;
  maxTurns?: string;
  maxTotalTokens?: string;
  timeoutMs?: string;
  auditFile?: string;
  mcp?: string[];
  saveSession?: boolean;
  resume?: string;
  skill?: string[];
}

function sensitiveValues(loaded: LoadedConfiguration): string[] {
  const name =
    loaded.settings.provider.apiKeyEnv ??
    (loaded.settings.provider.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  const value = process.env[name]?.trim();
  return value ? [value] : [];
}

function printPrompt(manifest: PromptManifest, shownWarnings: Set<string>): void {
  if (manifest.skills) printSkills(manifest.skills, shownWarnings);
  if (manifest.memory) {
    if (manifest.memory.selected)
      process.stderr.write(
        `记忆：加载${manifest.memory.selected}条，${manifest.memory.bytes} bytes；省略${manifest.memory.omitted}条。\n`,
      );
    printMemoryWarnings(manifest.memory.warnings, shownWarnings);
  }
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

export async function inspectPrompt(
  loaded: LoadedConfiguration,
  json: boolean,
  options: { skill?: string[]; task?: string } = {},
): Promise<void> {
  const registry = createBuiltinRegistry();
  const memory = await memoryRuntime(loaded, registry);
  const skills = skillRuntime(loaded, registry);
  const executor = await ToolExecutor.create(registry, {
    root: loaded.cwd,
    mode: loaded.settings.mode,
    rules: [...loaded.permissionRules, ...memory.rules],
  });
  skills.bind(executor);
  const manifest = await new AgentLoop(new MockProvider({ delayMs: 0 }), executor, {
    model: loaded.settings.provider.model,
    mode: loaded.settings.mode,
    ...loaded.settings.limits,
    sensitiveValues: sensitiveValues(loaded),
    memory: { store: memory.store, settings: loaded.settings.memory },
    skills: { catalog: skills.catalog, ...(options.skill ? { explicit: options.skill } : {}) },
  }).inspectPrompt(AbortSignal.timeout(loaded.settings.limits.timeoutMs), options.task);
  if (json) process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  else {
    if (manifest.skills) printSkills(manifest.skills, new Set());
    process.stdout.write(
      terminalText(
        `系统提示 ${manifest.version}：${manifest.characters} 字符，估算 ${manifest.estimatedTokens} token。\n提示段：${manifest.sections.map((section) => section.id).join(' → ')}\n模式：${manifest.environment.mode}；Shell：${manifest.environment.shell.kind}\n项目指令：${manifest.sources.map((source) => `${source.path} [scope=${source.scope}]`).join('，') || '无'}\n${manifest.warnings.map((warning) => `警告 ${warning.code}：${warning.path}；${warning.message}`).join('\n')}\n`,
      ),
    );
    if (manifest.memory) {
      process.stdout.write(
        `记忆：${manifest.memory.selected}条，${manifest.memory.bytes} bytes；省略${manifest.memory.omitted}条。\n`,
      );
      printMemoryWarnings(manifest.memory.warnings, new Set());
    }
  }
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
  // Expand only the original user input. Template output is never reparsed as a local command.
  if (task.trim().startsWith('/')) {
    const registry = createBuiltinRegistry();
    const skills = skillRuntime(loaded, registry);
    const executor = await ToolExecutor.create(registry, {
      root: loaded.cwd,
      mode: loaded.settings.mode,
      rules: [...loaded.permissionRules, ...(await memoryProtection(loaded))],
    });
    skills.bind(executor);
    const result = await commandRuntime(loaded, executor, undefined, skills.catalog).execute(task);
    if (result.kind === 'local') {
      process.stdout.write(
        options.json ? `${JSON.stringify(result)}\n` : `${terminalText(result.text)}\n`,
      );
      return;
    }
    task = result.prompt;
    if (result.kind === 'task' && result.skills)
      options = { ...options, skill: [...(options.skill ?? []), ...result.skills] };
    if (result.kind === 'agent') {
      if (options.resume && result.resume && options.resume !== result.resume)
        throw new AppError('COMMAND_INVALID', '恢复命令与 --resume 指定的会话不一致。');
      loaded = { ...loaded, settings: { ...loaded.settings, mode: result.mode } };
      options = { ...options, ...(result.resume ? { resume: result.resume } : {}) };
    }
  }
  await runAgentTask(loaded, task, options);
}

export async function runAgentTask(
  loaded: LoadedConfiguration,
  task: string,
  options: RunCLIOptions,
): Promise<void> {
  const maxTurns = positive(options.maxTurns, loaded.settings.limits.maxTurns, 1000);
  const timeoutMs = positive(options.timeoutMs, loaded.settings.limits.timeoutMs, 3_600_000);
  const maxTotalTokens = positive(options.maxTotalTokens, 200_000, 100_000_000);
  const selected = Object.fromEntries(
    [...new Set(options.mcp ?? [])].map((id) => {
      const config = loaded.settings.mcp.servers[id];
      if (!config) throw new AppError('CONFIG_INVALID', '选择的 MCP 服务不存在。');
      return [id, config];
    }),
  );
  const registry = createBuiltinRegistry();
  const memory = await memoryRuntime(loaded, registry);
  const skills = skillRuntime(loaded, registry);
  const mcp = new MCPManager(registry, selected, process.env, sensitiveValues(loaded));
  const provider = await createProvider(loaded.settings);
  let session: SessionStore | undefined;
  let restored: SessionState | undefined;
  if (options.resume && options.saveSession)
    throw new AppError('CONFIG_INVALID', '--save-session 和 --resume 不能同时使用。');
  if (!task.trim() && !options.resume)
    throw new AppError('INVALID_PROMPT', '请输入任务或显式使用--resume。');
  const secrets = [
    ...sensitiveValues(loaded),
    ...Object.values(selected).flatMap((config) => referencedValues(config, process.env)),
  ];
  if (options.resume) {
    const resumed = await SessionStore.resume(
      loaded.paths.storageDirectory,
      options.resume,
      loaded.cwd,
      secrets,
    );
    session = resumed.store;
    restored = resumed.state;
    if (
      session.owner.provider !== provider.id ||
      session.owner.model !== loaded.settings.provider.model
    ) {
      await session.close();
      throw new AppError('SESSION_INVALID', '恢复必须使用原provider和model，避免续传格式不兼容。');
    }
  } else if (options.saveSession)
    session = await SessionStore.create(
      loaded.paths.storageDirectory,
      {
        cwd: loaded.cwd,
        model: loaded.settings.provider.model,
        provider: provider.id,
        mode: loaded.settings.mode,
      },
      secrets,
    );
  const runtime = await permissionRuntime(loaded, options.auditFile, options.json).catch(
    async (error: unknown) => {
      await session?.close();
      throw error;
    },
  );
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
  try {
    const modeRank = { plan: 0, default: 1, 'accept-edits': 2 };
    const ceilings = [
      loaded.settings.mode,
      ...(session ? [session.owner.mode] : []),
      ...(restored ? [restored.mode] : []),
    ];
    const mode = ceilings.reduce((strict, candidate) =>
      modeRank[strict] < modeRank[candidate] ? strict : candidate,
    );
    if (session) {
      const local = relative(loaded.cwd, join(loaded.paths.storageDirectory, 'sessions'))
        .split(sep)
        .join('/');
      if (local && local !== '..' && !local.startsWith('../') && !local.includes(':'))
        runtime.rules.push({ source: 'cli', decision: 'deny', path: local });
      if (options.json)
        process.stdout.write(
          `${JSON.stringify({ type: 'session', id: session.owner.id, restored: Boolean(restored), mode })}\n`,
        );
      else process.stderr.write(`会话 ${session.owner.id}${restored ? '（恢复）' : ''}\n`);
    }
    const hooks = hookRuntime(loaded, registry, runtime.hookAudit, secrets);
    const executor = await ToolExecutor.create(registry, {
      root: loaded.cwd,
      mode,
      ...(loaded.settings.hooks.length ? { hooks: hooks.handle } : {}),
      timeoutMs,
      approve: approveTool,
      rules: [...runtime.rules, ...memory.rules],
      audit: runtime.audit,
    });
    skills.bind(executor);
    const agent = new AgentLoop(provider, executor, {
      initializeTools: async (setupSignal) => {
        for (const id of Object.keys(selected)) {
          const result = await mcp.connect(id, executor, setupSignal);
          if (!result.ok)
            process.stderr.write(`${result.name}：${result.error?.code ?? 'MCP_CONNECT_FAILED'}\n`);
        }
      },
      model: loaded.settings.provider.model,
      mode,
      maxTurns,
      timeoutMs,
      maxOutputTokens: loaded.settings.limits.maxOutputTokens,
      maxTotalTokens,
      sensitiveValues: sensitiveValues(loaded),
      context: loaded.settings.context,
      memory: { store: memory.store, settings: loaded.settings.memory },
      skills: { catalog: skills.catalog, ...(options.skill ? { explicit: options.skill } : {}) },
      ...(session ? { session } : {}),
      ...(restored ? { resume: restored } : {}),
    });
    const shownWarnings = new Set<string>();
    try {
      for await (const event of agent.run(task, signal)) {
        if (options.json) process.stdout.write(`${JSON.stringify(event)}\n`);
        else if (event.type === 'prompt_info') printPrompt(event.manifest, shownWarnings);
        else if (event.type === 'text_delta') process.stdout.write(terminalText(event.text));
        else if (event.type === 'tool_start')
          process.stderr.write(terminalText(`\n调用 ${event.name} (${event.callId})\n`));
        else if (event.type === 'tool_result')
          process.stderr.write(
            `${terminalText(event.result.name)}：${event.result.ok ? '成功' : terminalText(event.result.error?.code ?? '失败')}\n`,
          );
        else if (event.type === 'compacted')
          process.stderr.write(
            `上下文压缩：${event.beforeBytes} → ${event.afterBytes} bytes（本地摘录）\n`,
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
    await mcp.close();
    process.removeListener('SIGINT', cancel);
    try {
      await runtime.close();
    } finally {
      await session?.close();
    }
  }
}
