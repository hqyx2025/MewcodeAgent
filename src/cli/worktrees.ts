import type { LoadedConfiguration } from '../config/load.js';
import { WorktreeManager } from '../tools/worktrees.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { ToolExecutor } from '../tools/executor.js';
import { SubagentPool } from '../core/subagents.js';
import { worktreeExecution } from '../core/worktree-tasks.js';
import { TokenBudget } from '../core/token-budget.js';
import { createProvider } from '../providers/create.js';
import { AppError } from '../shared/errors.js';
import { permissionRuntime } from './permissions.js';
import { memoryProtection, memorySecrets } from './memory-runtime.js';
import { hookRuntime } from './hooks.js';
import { approveTool } from './run.js';
import { printSubagentProgress } from './subagent-progress.js';
import { readTaskFile } from './task-file.js';

export async function manageWorktrees(
  loaded: LoadedConfiguration,
  action: string,
  id: string | undefined,
  options: {
    task?: string;
    base?: string;
    branch?: string;
    approve?: boolean;
    tasksFile?: string;
    json?: boolean;
    auditFile?: string;
  },
): Promise<void> {
  const names: Record<string, string> = {
    list: 'WorktreeList',
    create: 'WorktreeCreate',
    show: 'WorktreeInspect',
    diff: 'WorktreeInspect',
    reuse: 'WorktreeReuse',
    remove: 'WorktreeRemove',
    recover: 'WorktreeRecover',
    unlock: 'WorktreeUnlock',
    delegate: 'WorktreeTask',
  };
  const name = names[action];
  if (
    !name ||
    (['show', 'diff', 'reuse', 'remove', 'recover'].includes(action) && !id) ||
    (action === 'create' && !options.task) ||
    (action === 'delegate' && !options.tasksFile)
  )
    throw new AppError(
      'CONFIG_INVALID',
      'worktrees list/create --task <id>/show|diff|reuse|remove|recover <uuid>/unlock/delegate --tasks-file <file>',
    );
  const registry = createBuiltinRegistry();
  const secrets = memorySecrets(loaded);
  const manager = await WorktreeManager.open(loaded.cwd, loaded.paths.storageDirectory, {
    sensitiveValues: secrets,
    resultBytes: 1024 * 1024,
  });
  manager.register(registry);
  const runtime = await permissionRuntime(loaded, options.auditFile, options.json);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(loaded.settings.limits.timeoutMs),
  ]);
  try {
    const hooks = hookRuntime(loaded, registry, runtime.hookAudit, secrets);
    const executor = await ToolExecutor.create(registry, {
      root: loaded.cwd,
      mode: loaded.settings.mode,
      timeoutMs: loaded.settings.limits.timeoutMs,
      rules: [...runtime.rules, ...(await memoryProtection(loaded))],
      audit: runtime.audit,
      ...(loaded.settings.hooks.length ? { hooks: hooks.handle } : {}),
      approve: async (request, inner) =>
        request.name === name && options.approve ? true : approveTool(request, inner),
    });
    const budget = new TokenBudget(200_000);
    if (action === 'delegate') {
      const pool = new SubagentPool(registry, {
        settings: { ...loaded.settings.subagents, enabled: true },
        budget,
        agent: {
          model: loaded.settings.provider.model,
          ...loaded.settings.limits,
          maxTotalTokens: 200_000,
          context: loaded.settings.context,
          sensitiveValues: secrets,
        },
        provider: () => createProvider(loaded.settings),
        execution: worktreeExecution(manager, approveTool),
        progress: (event) => printSubagentProgress(event, options.json ?? false),
      });
      pool.bind(executor);
    }
    const input =
      action === 'create'
        ? {
            task: options.task,
            base: options.base ?? 'HEAD',
            ...(options.branch ? { branch: options.branch } : {}),
          }
        : action === 'delegate'
          ? await readTaskFile(executor, options.tasksFile!)
          : action === 'reuse'
            ? { id, base: options.base ?? 'HEAD' }
            : ['show', 'diff'].includes(action)
              ? { id, diff: action === 'diff' }
              : id
                ? { id }
                : {};
    const result = await executor.execute({ callId: 'worktree-cli-1', name, input }, signal);
    process.stdout.write(
      `${JSON.stringify({ type: 'worktree', result, ...(action === 'delegate' ? { budget: budget.snapshot } : {}) })}\n`,
    );
    if (
      !result.ok ||
      (action === 'delegate' &&
        (JSON.parse(result.content) as { tasks: { status: string }[] }).tasks.some(
          (task) => task.status !== 'completed',
        ))
    )
      process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    await runtime.close();
  }
}
