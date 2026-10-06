import type { LoadedConfiguration } from '../config/load.js';
import { SubagentPool } from '../core/subagents.js';
import { TokenBudget } from '../core/token-budget.js';
import { createProvider } from '../providers/create.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { ToolExecutor } from '../tools/executor.js';
import { permissionRuntime } from './permissions.js';
import { memoryProtection } from './memory-runtime.js';
import { hookRuntime } from './hooks.js';
import { printSubagentProgress } from './subagent-progress.js';
import { readTaskFile } from './task-file.js';

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
    const input = await readTaskFile(executor, options.tasksFile);
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
