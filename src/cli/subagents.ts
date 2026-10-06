import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { LoadedConfiguration } from '../config/load.js';
import { SubagentPool } from '../core/subagents.js';
import { TokenBudget } from '../core/token-budget.js';
import { createProvider } from '../providers/create.js';
import { AppError } from '../shared/errors.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { ToolExecutor } from '../tools/executor.js';
import { permissionRuntime } from './permissions.js';
import { memoryProtection } from './memory-runtime.js';
import { hookRuntime } from './hooks.js';
import { printSubagentProgress } from './subagent-progress.js';

export async function delegateTasks(
  loaded: LoadedConfiguration,
  options: { tasksFile: string; json?: boolean },
): Promise<void> {
  const registry = createBuiltinRegistry();
  const runtime = await permissionRuntime(loaded, undefined, options.json);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(loaded.settings.limits.timeoutMs),
  ]);
  const name =
    loaded.settings.provider.apiKeyEnv ??
    (loaded.settings.provider.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  const secrets = process.env[name] ? [process.env[name]!] : [];
  try {
    const hooks = hookRuntime(loaded, registry, runtime.hookAudit, secrets);
    const executor = await ToolExecutor.create(registry, {
      root: loaded.cwd,
      mode: 'plan',
      rules: [...runtime.rules, ...(await memoryProtection(loaded))],
      audit: runtime.audit,
      ...(loaded.settings.hooks.length ? { hooks: hooks.handle } : {}),
      timeoutMs: loaded.settings.limits.timeoutMs,
    });
    let input: unknown;
    try {
      const path = await executor.paths.resolve(options.tasksFile);
      if (!executor.allowsRead('ReadFile', path)) throw new Error('Denied');
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 32 * 1024) throw new Error('Size');
        const bytes = Buffer.alloc(32 * 1024 + 1);
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
        if (bytesRead > 32 * 1024) throw new Error('Size');
        input = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)),
        );
      } finally {
        await file.close();
      }
    } catch {
      throw new AppError(
        'SUBAGENT_INVALID',
        '任务文件不可读、被禁止、超过32KiB或不是有效UTF-8 JSON。',
      );
    }
    const budget = new TokenBudget(200_000);
    const pool = new SubagentPool(registry, {
      settings: loaded.settings.subagents,
      budget,
      provider: () => createProvider(loaded.settings),
      agent: {
        model: loaded.settings.provider.model,
        ...loaded.settings.limits,
        maxTotalTokens: 200_000,
        context: loaded.settings.context,
        sensitiveValues: secrets,
      },
      progress: (event) => printSubagentProgress(event, options.json ?? false),
    });
    pool.bind(executor);
    const result = await executor.execute({ callId: 'delegate-1', name: 'Task', input }, signal);
    process.stdout.write(
      `${JSON.stringify({ type: 'delegation', result, budget: budget.snapshot })}\n`,
    );
    if (
      !result.ok ||
      (JSON.parse(result.content) as { tasks: { status: string }[] }).tasks.some(
        (task) => task.status !== 'completed',
      )
    )
      process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    await runtime.close();
  }
}
