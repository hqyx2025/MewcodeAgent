import { randomUUID } from 'node:crypto';
import type { LoadedConfiguration } from '../config/load.js';
import { memoryScopeSchema, memoryKindSchema, memoryTextSchema } from '../core/memory-schema.js';
import { memoryCandidates } from '../core/memory-candidates.js';
import type { MemorySnapshot } from '../core/memory.js';
import { SessionStore } from '../core/session.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { ToolExecutor } from '../tools/executor.js';
import { AppError } from '../shared/errors.js';
import { memoryRuntime, memorySecrets } from './memory-runtime.js';
import { permissionRuntime } from './permissions.js';
import { approveTool } from './run.js';

interface MemoryCLIOptions {
  scope?: string;
  kind?: string;
  text?: string;
  revision?: string;
  candidate?: string;
  checkpoint?: string;
  approve?: boolean;
  auditFile?: string;
}
export async function manageMemory(
  loaded: LoadedConfiguration,
  action: string,
  id: string | undefined,
  options: MemoryCLIOptions,
): Promise<void> {
  if (!['list', 'show', 'add', 'edit', 'delete', 'candidates', 'accept', 'unlock'].includes(action))
    throw new AppError(
      'CONFIG_INVALID',
      'memory支持list/show/add/edit/delete/candidates/accept/unlock。',
    );
  const scopeResult = memoryScopeSchema.safeParse(options.scope ?? 'project');
  if (!scopeResult.success)
    throw new AppError('CONFIG_INVALID', 'memory scope必须为user或project。');
  const scope = scopeResult.data;
  const registry = createBuiltinRegistry();
  const memory = await memoryRuntime(loaded, registry);
  const runtime = await permissionRuntime(loaded, options.auditFile);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(loaded.settings.limits.timeoutMs),
  ]);
  try {
    const executor = await ToolExecutor.create(registry, {
      root: loaded.cwd,
      mode: loaded.settings.mode,
      rules: [...runtime.rules, ...memory.rules],
      audit: runtime.audit,
      approve: options.approve ? async () => true : approveTool,
    });
    const execute = async (name: string, input: unknown) => {
      const result = await executor.execute({ callId: randomUUID(), name, input }, signal);
      if (!result.ok) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        process.exitCode = result.error?.code === 'CANCELLED' ? 130 : 1;
      }
      return result;
    };
    if (action === 'unlock') {
      const result = await execute('MemoryUnlock', { scope });
      if (result.ok) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    const read = await execute('MemoryRead', { scope });
    if (!read.ok) return;
    const snapshot = read.data as MemorySnapshot;
    if (action === 'list' || action === 'show') {
      const entries =
        action === 'show' && id
          ? snapshot.entries.filter((entry) => entry.id === id)
          : snapshot.entries;
      if (action === 'show' && id && !entries.length)
        throw new AppError('MEMORY_INVALID', '记忆条目不存在或已过滤。');
      process.stdout.write(
        `${JSON.stringify({ scope, revision: snapshot.revision, filtered: snapshot.filtered, entries }, null, 2)}\n`,
      );
      return;
    }
    let source:
      { type: 'manual' } | ReturnType<typeof memoryCandidates>['candidates'][number]['source'] = {
      type: 'manual',
    };
    let kind =
      options.kind ??
      (action === 'edit' ? snapshot.entries.find((entry) => entry.id === id)?.kind : 'preference');
    let text = options.text;
    if (action === 'candidates' || action === 'accept') {
      if (!id) throw new AppError('CONFIG_INVALID', '候选提取或接受需要当前项目的会话UUID。');
      const inspected = await SessionStore.inspect(loaded.paths.storageDirectory, id);
      if (inspected.owner.cwd !== loaded.cwd)
        throw new AppError('SESSION_INVALID', '会话属于另一项目；未提取或输出候选。');
      if (options.checkpoint && !/^[1-9]\d{0,4}$/.test(options.checkpoint))
        throw new AppError('CONFIG_INVALID', 'checkpoint必须为正整数。');
      const sequence = options.checkpoint ? Number(options.checkpoint) : inspected.sequence;
      const state = options.checkpoint
        ? await SessionStore.checkpoint(loaded.paths.storageDirectory, id, sequence)
        : inspected.state;
      const candidates = memoryCandidates(
        state.messages,
        id,
        sequence,
        scope,
        memorySecrets(loaded),
      );
      if (action === 'candidates') {
        process.stdout.write(
          `${JSON.stringify({ scope, checkpoint: sequence, ...candidates }, null, 2)}\n`,
        );
        return;
      }
      const candidate = candidates.candidates.find((value) => value.id === options.candidate);
      if (!candidate)
        throw new AppError(
          'MEMORY_CONFLICT',
          '候选不存在或会话检查点已变化；重新提取或显式指定原检查点。',
        );
      ({ source, kind, text } = candidate);
    }
    const revision =
      options.revision === undefined
        ? snapshot.revision
        : options.revision === 'new'
          ? null
          : options.revision;
    let result;
    if (action === 'delete') {
      if (!id) throw new AppError('CONFIG_INVALID', '删除需要条目UUID。');
      result = await execute('MemoryDelete', { scope, revision, id });
    } else {
      const parsedKind = memoryKindSchema.safeParse(kind);
      const parsedText = memoryTextSchema.safeParse(text);
      if (!parsedKind.success || !parsedText.success || (action === 'edit' && !id))
        throw new AppError('CONFIG_INVALID', '需要有效kind、单行text；edit还需要条目UUID。');
      result = await execute('MemoryUpdate', {
        scope,
        revision,
        kind: parsedKind.data,
        text: parsedText.data,
        source,
        ...(action === 'edit' ? { id } : {}),
      });
    }
    if (result.ok) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    process.removeListener('SIGINT', cancel);
    await runtime.close();
  }
}
