import type { LoadedConfiguration } from '../config/load.js';
import { SessionStore } from '../core/session.js';
import { compactHistory } from '../core/context.js';
import { AppError } from '../shared/errors.js';

export async function manageSessions(
  loaded: LoadedConfiguration,
  action: string,
  id: string | undefined,
  file: string | undefined,
  options: { content?: boolean; checkpoint?: string },
): Promise<void> {
  const storage = loaded.paths.storageDirectory;
  if (action === 'list') {
    process.stdout.write(
      `${JSON.stringify(
        (await SessionStore.list(storage)).filter((owner) => owner.cwd === loaded.cwd),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (!id) throw new AppError('CONFIG_INVALID', 'sessions 操作需要会话 UUID。');
  if (action === 'unlock' || action === 'delete') {
    if ((await SessionStore.owner(storage, id)).cwd !== loaded.cwd)
      throw new AppError('SESSION_INVALID', '会话属于另一项目。');
    if (action === 'unlock') await SessionStore.unlock(storage, id);
    else await SessionStore.delete(storage, id);
    process.stdout.write(action === 'unlock' ? '会话锁已移除。\n' : '会话及溢写结果已删除。\n');
    return;
  }
  const inspected = await SessionStore.inspect(storage, id);
  if (inspected.owner.cwd !== loaded.cwd)
    throw new AppError('SESSION_INVALID', '会话属于另一项目。');
  if (action === 'show') {
    if (options.checkpoint && (!options.content || !/^[1-9]\d{0,4}$/.test(options.checkpoint)))
      throw new AppError('CONFIG_INVALID', '检查点必须为正整数且显式使用--content。');
    const state = options.checkpoint
      ? await SessionStore.checkpoint(storage, id, Number(options.checkpoint))
      : inspected.state;
    process.stdout.write(
      `${JSON.stringify({ owner: inspected.owner, sequence: inspected.sequence, tailBytes: inspected.tailBytes, status: state.status, turns: state.turns, toolCalls: state.toolCalls, totalTokens: state.totalTokens, estimated: state.estimated, messages: options.content ? state.messages : state.messages.length }, null, 2)}\n`,
    );
    return;
  }
  if (action === 'result' && file) {
    process.stdout.write(
      `${JSON.stringify(await SessionStore.result(storage, id, file), null, 2)}\n`,
    );
    return;
  }
  if (action === 'compact') {
    const { store, state } = await SessionStore.resume(storage, id, loaded.cwd);
    try {
      const candidate = compactHistory(state.messages, loaded.settings.context);
      if (candidate) {
        await store.commit(state);
        await store.commit({ ...state, messages: candidate.messages }, 'compact');
      }
      process.stdout.write(
        `${JSON.stringify(candidate ? { compacted: true, beforeBytes: candidate.beforeBytes, afterBytes: candidate.afterBytes } : { compacted: false }, null, 2)}\n`,
      );
    } finally {
      await store.close();
    }
    return;
  }
  throw new AppError('CONFIG_INVALID', 'sessions 支持 list/show/compact/result/unlock/delete。');
}
