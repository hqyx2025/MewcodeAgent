import { z } from 'zod';
import type { LoadedConfiguration } from '../config/load.js';
import { TeamStore } from '../core/team-store.js';
import { teamBoard, teamReport, runTeam } from '../core/teams.js';
import { teamCreateSchema, teamAddSchema, teamSendSchema } from '../core/team-schema.js';
import { WorktreeManager } from '../tools/worktrees.js';
import { ToolExecutor } from '../tools/executor.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { defineTool } from '../tools/types.js';
import { AppError } from '../shared/errors.js';
import { createProvider } from '../providers/create.js';
import { permissionRuntime } from './permissions.js';
import { memoryProtection, memorySecrets } from './memory-runtime.js';
import { hookRuntime } from './hooks.js';
import { approveTool } from './run.js';
import { readTaskFile } from './task-file.js';
import { printSubagentProgress } from './subagent-progress.js';

export async function manageTeams(
  loaded: LoadedConfiguration,
  action: string,
  id: string | undefined,
  options: {
    file?: string;
    task?: string;
    member?: string;
    content?: boolean;
    approve?: boolean;
    json?: boolean;
    auditFile?: string;
  },
) {
  const names: Record<string, string> = {
    list: 'TeamList',
    show: 'TeamShow',
    create: 'TeamCreate',
    add: 'TeamAdd',
    send: 'TeamSendMessage',
    inbox: 'TeamMessages',
    run: 'TeamRun',
    cancel: 'TeamCancel',
    retry: 'TeamRetry',
    recover: 'TeamRecover',
    unlock: 'TeamUnlock',
    report: 'TeamReport',
  };
  const name = names[action];
  if (
    !name ||
    (!['list', 'create', 'unlock'].includes(action) && !id) ||
    (['create', 'add', 'send'].includes(action) && !options.file) ||
    (action === 'retry' && !options.task)
  )
    throw new AppError(
      'TEAM_INPUT',
      'teams list/create --file <file>/show|run|cancel|recover|report <uuid>/add|send <uuid> --file <file>/inbox <uuid> --member <id>/retry <uuid> --task <id>/unlock',
    );
  const registry = createBuiltinRegistry();
  const secrets = memorySecrets(loaded);
  const manager = await WorktreeManager.open(loaded.cwd, loaded.paths.storageDirectory, {
    sensitiveValues: secrets,
    resultBytes: 1024 * 1024,
  });
  const store = await TeamStore.open(manager, loaded.paths.storageDirectory, secrets);
  const runtime = await permissionRuntime(loaded, options.auditFile, options.json);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(loaded.settings.limits.timeoutMs),
  ]);
  let executor: ToolExecutor;
  try {
    const hooks = hookRuntime(loaded, registry, runtime.hookAudit, secrets);
    executor = await ToolExecutor.create(registry, {
      root: loaded.cwd,
      mode: loaded.settings.mode,
      timeoutMs: loaded.settings.limits.timeoutMs,
      rules: [...runtime.rules, ...(await memoryProtection(loaded))],
      audit: runtime.audit,
      ...(loaded.settings.hooks.length ? { hooks: hooks.handle } : {}),
      approve: async (request, inner) =>
        request.name === name && options.approve ? true : approveTool(request, inner),
    });
    const schema =
      action === 'create'
        ? teamCreateSchema
        : action === 'add'
          ? teamAddSchema
          : action === 'send'
            ? teamSendSchema
            : z.strictObject({});
    const effect = ['list', 'show', 'inbox', 'report'].includes(action)
      ? 'read'
      : ['recover', 'unlock'].includes(action)
        ? 'shell'
        : 'write';
    registry.register(
      defineTool({
        name,
        effect,
        schema,
        description: '显式团队管理入口；模型数据不能改变权限，执行和恢复需要既有授权。',
        prepare: async (input, context) => ({
          target: loaded.cwd,
          preview: `团队 ${action} ${id ?? ''}`,
          run: async () => {
            let value: unknown;
            if (action === 'create') value = teamBoard(await store.create(input, manager));
            else if (action === 'list') value = await store.list();
            else if (action === 'show')
              value = teamBoard(await store.inspect(id!), options.content);
            else if (action === 'add') value = teamBoard(await store.add(id!, input));
            else if (action === 'send') value = await store.send(id!, 'coordinator', input);
            else if (action === 'inbox')
              value = await store.inbox(id!, options.member ?? 'coordinator');
            else if (action === 'cancel') {
              await store.cancel(id!);
              value = teamBoard(await store.inspect(id!));
            } else if (action === 'retry') {
              await store.retry(id!, options.task!);
              value = teamBoard(await store.inspect(id!));
            } else if (action === 'recover') value = teamBoard(await store.recover(id!, manager));
            else if (action === 'unlock') {
              await store.unlock();
              value = { unlocked: true };
            } else if (action === 'report')
              value = await teamReport(await store.inspect(id!), manager);
            else {
              const result = await runTeam(
                id!,
                {
                  parent: executor,
                  manager,
                  store,
                  settings: loaded.settings.subagents,
                  agent: {
                    model: loaded.settings.provider.model,
                    ...loaded.settings.limits,
                    maxTotalTokens: 200_000,
                    context: loaded.settings.context,
                    sensitiveValues: secrets,
                  },
                  provider: () => createProvider(loaded.settings),
                  approve: approveTool,
                  progress: (event) => printSubagentProgress(event, options.json ?? false),
                },
                context.signal,
              );
              value = {
                team: teamBoard(result.state),
                budget: result.budget,
                metrics: result.metrics,
              };
            }
            const content = JSON.stringify(value);
            if (Buffer.byteLength(content) > 1024 * 1024)
              throw new AppError('TEAM_LIMIT', '团队报告超过1MiB上限。');
            return { content };
          },
        }),
      }),
    );
    const input = ['create', 'add', 'send'].includes(action)
      ? await readTaskFile(executor, options.file!)
      : {};
    const result = await executor.execute({ callId: 'team-cli-1', name, input }, signal);
    process.stdout.write(JSON.stringify({ type: 'team', result }) + '\n');
    if (
      !result.ok ||
      (action === 'run' &&
        (JSON.parse(result.content) as { team: { tasks: { status: string }[] } }).team.tasks.some(
          (task) => task.status !== 'completed',
        ))
    )
      process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    await runtime.close();
  }
}
