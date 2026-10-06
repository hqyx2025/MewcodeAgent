import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { AppError } from '../shared/errors.js';
import { redactInstruction } from '../shared/redact.js';
import { validateHistory, prefix } from './context.js';
import type { LLMMessage } from '../providers/types.js';
import type { ToolResult, ToolMode } from '../tools/types.js';

const idSchema = z.string().uuid();
const callSchema = z.strictObject({
  callId: z.string().regex(/^[\w.-]{1,128}$/),
  name: z.string().min(1).max(128),
  arguments: z.string().max(262_144),
});
const messageSchema = z
  .strictObject({
    role: z.enum(['system', 'user', 'assistant', 'tool']),
    content: z.string().max(1_048_576),
    contextSummary: z.literal(true).optional(),
    callId: z
      .string()
      .regex(/^[\w.-]{1,128}$/)
      .optional(),
    toolCalls: z.array(callSchema).max(32).optional(),
    continuation: z
      .strictObject({
        provider: z.enum(['responses', 'anthropic']),
        items: z.array(z.unknown()).max(256),
      })
      .optional(),
  })
  .transform((value): LLMMessage => ({
    role: value.role,
    content: value.content,
    ...(value.contextSummary ? { contextSummary: true } : {}),
    ...(value.callId === undefined ? {} : { callId: value.callId }),
    ...(value.toolCalls === undefined ? {} : { toolCalls: value.toolCalls }),
    ...(value.continuation === undefined ? {} : { continuation: value.continuation }),
  }));
export const sessionStateSchema = z.strictObject({
  worktreeTaskIds: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,23}$/))
    .max(32)
    .optional(),
  pendingSubagentTokens: z.number().int().min(0).max(400_000).optional(),
  subagentIds: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,23}$/))
    .max(32)
    .optional(),
  mode: z.enum(['plan', 'default', 'accept-edits']),
  messages: z.array(messageSchema).max(4096),
  seenIds: z.array(z.string().regex(/^[\w.-]{1,128}$/)).max(10_000),
  actions: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(10_000),
  totalTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  estimated: z.boolean(),
  turns: z.number().int().min(0).max(10_000),
  toolCalls: z.number().int().min(0).max(10_000),
  failures: z.number().int().min(0).max(10_000),
  status: z.enum(['running', 'completed', 'stopped', 'uncertain']),
});
export type SessionState = z.infer<typeof sessionStateSchema>;
const ownerSchema = z.strictObject({
  app: z.literal('mewcode-agent'),
  schemaVersion: z.literal(1),
  id: idSchema,
  cwd: z.string(),
  model: z.string(),
  provider: z.string(),
  mode: z.enum(['plan', 'default', 'accept-edits']),
  createdAt: z.string().datetime(),
});
export type SessionOwner = z.infer<typeof ownerSchema>;
const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sequence: z.number().int().min(1).max(10_000),
  event: z.enum(['checkpoint', 'compact', 'intent', 'result', 'recovery', 'finish']),
  file: z.string().regex(/^state-[0-9]{5}-[a-f0-9-]{36}\.json$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(2 * 1024 * 1024),
});
const spillSchema = z.strictObject({
  file: z.string().regex(/^[a-f0-9]{64}\.json$/),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  bytes: z
    .number()
    .int()
    .min(1)
    .max(2 * 1024 * 1024),
});
export type SpillReference = z.infer<typeof spillSchema>;
const MAX_DISK = 64 * 1024 * 1024;

function digest(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}
function fail(): never {
  throw new AppError('SESSION_INVALID', '会话归属、结构、版本或完整性无效；未读取或清理其他路径。');
}
function safeJSON(value: unknown, secrets: readonly string[]): string {
  const safe = (entry: unknown): unknown => {
    if (typeof entry === 'string') {
      let text = redactInstruction(entry, secrets);
      for (const secret of secrets)
        if (secret) {
          text = text
            .replaceAll(secret, '[REDACTED]')
            .replaceAll(JSON.stringify(secret).slice(1, -1), '[REDACTED]');
        }
      return text;
    }
    if (Array.isArray(entry)) return entry.map(safe);
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry).map(([key, child]) => [safe(key), safe(child)]),
      );
    return entry;
  };
  return JSON.stringify(safe(value));
}

async function safeDirectory(path: string, create = false): Promise<string> {
  const target = resolve(path);
  let current = parse(target).root;
  for (const part of relative(current, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
  }
  const canonical = await realpath(target);
  return canonical;
}

async function readRegular(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit || info.nlink !== 1) fail();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (before.ino !== info.ino || before.dev !== info.dev || before.size > limit) fail();
    const data = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(data, offset, data.length - offset, offset);
      if (!bytesRead) fail();
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail();
    return data;
  } finally {
    await handle.close();
  }
}

async function atomicNew(path: string, text: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    // Names are immutable and unique; refuse stale/orphan snapshot overwrites.
    try {
      await lstat(path);
      fail();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export class SessionStore {
  private sequence = 0;
  private diskBytes = 0;
  private poisoned = false;
  private closed = false;
  private readonly lockToken = randomUUID();
  private constructor(
    readonly directory: string,
    readonly owner: SessionOwner,
    private readonly secrets: readonly string[],
  ) {}

  static async create(
    storage: string,
    identity: { cwd: string; model: string; provider: string; mode: ToolMode },
    secrets: readonly string[] = [],
  ): Promise<SessionStore> {
    try {
      const root = await safeDirectory(join(storage, 'sessions'), true);
      const id = randomUUID();
      const directory = join(root, id);
      await mkdir(directory, { mode: 0o700 });
      await mkdir(join(directory, 'outputs'), { mode: 0o700 });
      const owner = ownerSchema.parse({
        app: 'mewcode-agent',
        schemaVersion: 1,
        id,
        ...identity,
        cwd: await realpath(identity.cwd),
        createdAt: new Date().toISOString(),
      });
      await atomicNew(join(directory, 'owner.json'), safeJSON(owner, secrets));
      await atomicNew(join(directory, 'events.jsonl'), '');
      const store = new SessionStore(directory, owner, secrets);
      await store.lock();
      return store;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SESSION_IO', '无法创建会话目录或归属文件。');
    }
  }

  private async lock() {
    try {
      const handle = await open(
        join(this.directory, 'lock.json'),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(
          JSON.stringify({ token: this.lockToken, pid: process.pid, host: hostname() }),
        );
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      throw new AppError('SESSION_LOCKED', '会话已锁定；崩溃后请核对并显式使用 sessions unlock。');
    }
  }

  private static async owned(storage: string, id: string) {
    if (!idSchema.safeParse(id).success) fail();
    const root = await safeDirectory(join(storage, 'sessions'));
    const directory = await safeDirectory(join(root, id));
    const owner = ownerSchema.parse(
      JSON.parse((await readRegular(join(directory, 'owner.json'), 16_384)).toString('utf8')),
    );
    if (owner.id !== id) fail();
    return { directory, owner };
  }

  private static async loaded(
    directory: string,
  ): Promise<{ state: SessionState; sequence: number; tailBytes: number }> {
    const journal = await readRegular(join(directory, 'events.jsonl'), 4 * 1024 * 1024);
    const last = journal.lastIndexOf(10);
    const committed = journal.subarray(0, last + 1).toString('utf8');
    const records = committed
      ? committed
          .trimEnd()
          .split('\n')
          .map((line) => recordSchema.parse(JSON.parse(line)))
      : [];
    if (!records.length) throw new AppError('SESSION_INVALID', '会话尚无已提交检查点。');
    let previous = 0;
    let totalBytes = 0;
    for (const record of records) {
      totalBytes += record.bytes;
      if (totalBytes > MAX_DISK) fail();
      if (
        record.sequence !== ++previous ||
        !record.file.startsWith(`state-${String(record.sequence).padStart(5, '0')}-`)
      )
        fail();
      const archived = await readRegular(join(directory, record.file), 2 * 1024 * 1024);
      if (archived.length !== record.bytes || digest(archived) !== record.digest) fail();
    }
    const record = records.at(-1)!;
    const data = await readRegular(join(directory, record.file), 2 * 1024 * 1024);
    if (data.length !== record.bytes || digest(data) !== record.digest) fail();
    const state = sessionStateSchema.parse(JSON.parse(data.toString('utf8')));
    const pending = validateHistory(state.messages, true);
    if (state.messages[0]?.role !== 'system' || state.messages[1]?.role !== 'user') fail();
    if (
      new Set(state.seenIds).size !== state.seenIds.length ||
      new Set(state.actions).size !== state.actions.length ||
      state.messages
        .flatMap((message) => message.toolCalls ?? [])
        .some((call) => !state.seenIds.includes(call.callId)) ||
      state.messages.slice(1).some((message) => message.role === 'system') ||
      (pending.length && state.status === 'completed')
    )
      fail();
    return { state, sequence: record.sequence, tailBytes: journal.length - last - 1 };
  }

  static async inspect(storage: string, id: string) {
    try {
      const { directory, owner } = await this.owned(storage, id);
      return { owner, ...(await this.loaded(directory)) };
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail();
    }
  }

  static async owner(storage: string, id: string): Promise<SessionOwner> {
    try {
      return (await this.owned(storage, id)).owner;
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail();
    }
  }

  static async resume(
    storage: string,
    id: string,
    cwd: string,
    secrets: readonly string[] = [],
  ): Promise<{ store: SessionStore; state: SessionState }> {
    try {
      const { directory, owner } = await this.owned(storage, id);
      if (owner.cwd !== (await realpath(cwd)))
        throw new AppError('SESSION_INVALID', '会话属于另一项目，拒绝恢复。');
      const store = new SessionStore(directory, owner, secrets);
      await store.lock();
      try {
        const loaded = await this.loaded(directory);
        store.sequence = loaded.sequence;
        store.diskBytes = await store.measureDisk();
        if (loaded.tailBytes) {
          const handle = await open(
            join(directory, 'events.jsonl'),
            constants.O_WRONLY | constants.O_NOFOLLOW,
          );
          try {
            await handle.truncate((await handle.stat()).size - loaded.tailBytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        // Leave orphan files untouched; unique snapshot names cannot overwrite them.
        return { store, state: loaded.state };
      } catch (error) {
        await store.close();
        throw error;
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SESSION_INVALID', '会话无法安全恢复。');
    }
  }

  private async measureDisk(): Promise<number> {
    let bytes = 0;
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (entry.name === 'outputs') {
        for (const name of await readdir(await safeDirectory(join(this.directory, 'outputs')))) {
          if (!/^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name)) fail();
          bytes += (await readRegular(join(this.directory, 'outputs', name), 2 * 1024 * 1024))
            .length;
          if (bytes > MAX_DISK) fail();
        }
      } else {
        if (
          !['owner.json', 'events.jsonl', 'lock.json'].includes(entry.name) &&
          !/^state-[0-9]{5}-[a-f0-9-]{36}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(entry.name)
        )
          fail();
        bytes += (
          await readRegular(
            join(this.directory, entry.name),
            entry.name === 'events.jsonl' ? 4 * 1024 * 1024 : 2 * 1024 * 1024,
          )
        ).length;
      }
      if (bytes > MAX_DISK) fail();
    }
    return bytes;
  }

  async commit(
    state: SessionState,
    event: z.infer<typeof recordSchema>['event'] = 'checkpoint',
  ): Promise<SessionState> {
    if (this.closed || this.poisoned)
      throw new AppError('SESSION_IO', '会话已关闭或此前持久化失败，不能继续动作。');
    try {
      await this.verifyLock();
      const text = safeJSON(state, this.secrets);
      const safeState = sessionStateSchema.parse(JSON.parse(text));
      if (
        safeState.messages
          .slice(1)
          .some(
            (message) =>
              message.role === 'system' || (message.contextSummary && message.role !== 'user'),
          )
      )
        fail();
      validateHistory(safeState.messages, true);
      const bytes = Buffer.byteLength(text);
      if (bytes > 2 * 1024 * 1024 || this.diskBytes + bytes > MAX_DISK || this.sequence >= 10_000)
        throw new AppError('SESSION_IO', '会话记录或总存储达到上限。');
      const sequence = this.sequence + 1;
      const file = `state-${String(sequence).padStart(5, '0')}-${randomUUID()}.json`;
      await atomicNew(join(this.directory, file), text);
      const record =
        JSON.stringify({ schemaVersion: 1, sequence, event, file, digest: digest(text), bytes }) +
        '\n';
      const handle = await open(
        join(this.directory, 'events.jsonl'),
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
      try {
        await handle.writeFile(record);
        await handle.sync();
      } finally {
        await handle.close();
      }
      this.sequence = sequence;
      this.diskBytes += bytes + Buffer.byteLength(record);
      return safeState;
    } catch (error) {
      this.poisoned = true;
      if (error instanceof AppError) throw error;
      throw new AppError('SESSION_IO', '会话保存失败；后续动作已停止，既有外部操作可能已完成。');
    }
  }

  async spill(result: ToolResult, limit: number): Promise<ToolResult & { spill?: SpillReference }> {
    try {
      return await this.writeSpill(result, limit);
    } catch (error) {
      this.poisoned = true;
      if (error instanceof AppError) throw error;
      throw new AppError('SESSION_IO', '工具结果溢写失败，后续动作已停止；外部操作可能已完成。');
    }
  }

  private async writeSpill(
    result: ToolResult,
    limit: number,
  ): Promise<ToolResult & { spill?: SpillReference }> {
    await this.verifyLock();
    await safeDirectory(join(this.directory, 'outputs'));
    const text = safeJSON(result, this.secrets);
    if (Buffer.byteLength(text) <= limit) return JSON.parse(text) as ToolResult;
    if (
      Buffer.byteLength(text) > 2 * 1024 * 1024 ||
      this.diskBytes + Buffer.byteLength(text) > MAX_DISK
    )
      throw new AppError('SESSION_IO', '工具结果溢写达到存储上限。');
    const hash = digest(text);
    const file = `${hash}.json`;
    const path = join(this.directory, 'outputs', file);
    try {
      const existing = await readRegular(path, 2 * 1024 * 1024);
      if (digest(existing) !== hash) fail();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await atomicNew(path, text);
      this.diskBytes += Buffer.byteLength(text);
    }
    return inlineResult(JSON.parse(text) as ToolResult, limit, {
      file,
      digest: hash,
      bytes: Buffer.byteLength(text),
    });
  }

  static async result(storage: string, id: string, file: string): Promise<unknown> {
    const reference = spillSchema.safeParse({ file, digest: file.slice(0, -5), bytes: 1 });
    if (!reference.success) fail();
    const { directory } = await this.owned(storage, id);
    await safeDirectory(join(directory, 'outputs'));
    const data = await readRegular(join(directory, 'outputs', file), 2 * 1024 * 1024);
    if (digest(data) !== reference.data.digest) fail();
    return JSON.parse(data.toString('utf8'));
  }

  static async checkpoint(storage: string, id: string, sequence: number): Promise<SessionState> {
    const { directory } = await this.owned(storage, id);
    const journal = await readRegular(join(directory, 'events.jsonl'), 4 * 1024 * 1024);
    const record = journal
      .subarray(0, journal.lastIndexOf(10) + 1)
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => recordSchema.parse(JSON.parse(line)))
      .find((record) => record.sequence === sequence);
    if (!record) fail();
    const data = await readRegular(join(directory, record.file), 2 * 1024 * 1024);
    if (data.length !== record.bytes || digest(data) !== record.digest) fail();
    return sessionStateSchema.parse(JSON.parse(data.toString('utf8')));
  }

  static async list(storage: string): Promise<SessionOwner[]> {
    let names: string[];
    try {
      names = await readdir(await safeDirectory(join(storage, 'sessions')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (names.length > 1000)
      throw new AppError('SESSION_INVALID', '会话目录数量超过1000；请缩小存储目录。');
    const owners = [];
    for (const name of names)
      if (idSchema.safeParse(name).success) owners.push((await this.owned(storage, name)).owner);
    return owners;
  }

  static async unlock(storage: string, id: string): Promise<void> {
    const { directory } = await this.owned(storage, id);
    const lock = JSON.parse(
      (await readRegular(join(directory, 'lock.json'), 4096)).toString('utf8'),
    ) as { pid: number; host: string };
    if (!Number.isSafeInteger(lock.pid) || lock.pid <= 0 || lock.host !== hostname()) fail();
    try {
      process.kill(lock.pid, 0);
      throw new AppError('SESSION_LOCKED', '锁拥有进程仍存在，拒绝解锁。');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await unlink(join(directory, 'lock.json'));
  }

  static async delete(storage: string, id: string): Promise<void> {
    const { directory, owner } = await this.owned(storage, id);
    const store = new SessionStore(directory, owner, []);
    await store.lock();
    try {
      await store.measureDisk();
      const again = await this.owned(storage, id);
      if (again.directory !== directory) fail();
      await rm(directory, { recursive: true });
      store.closed = true;
    } finally {
      await store.close();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const lock = JSON.parse(
        (await readRegular(join(this.directory, 'lock.json'), 4096)).toString('utf8'),
      ) as { token?: string };
      if (lock.token === this.lockToken) await unlink(join(this.directory, 'lock.json'));
    } catch {
      /* Never remove a lock whose ownership cannot be verified. */
    }
  }

  private async verifyLock(): Promise<void> {
    if (this.closed || this.poisoned) throw new AppError('SESSION_IO', '会话存储已关闭或失败。');
    await safeDirectory(this.directory);
    const lock = JSON.parse(
      (await readRegular(join(this.directory, 'lock.json'), 4096)).toString('utf8'),
    ) as { token?: string };
    if (lock.token !== this.lockToken)
      throw new AppError('SESSION_LOCKED', '会话锁已变化，拒绝写入或执行后续动作。');
  }
}

export function inlineResult(
  result: ToolResult,
  limit: number,
  spill?: SpillReference,
): ToolResult & { spill?: SpillReference } {
  if (Buffer.byteLength(JSON.stringify(result)) <= limit) return result;
  const data =
    result.data && typeof result.data === 'object' ? (result.data as Record<string, unknown>) : {};
  const inline: ToolResult & { spill?: SpillReference } = {
    ...(result.agentId ? { agentId: result.agentId } : {}),
    callId: result.callId,
    name: result.name,
    ok: result.ok,
    content: prefix(result.content, Math.max(128, limit - 1024)),
    truncated: true,
    ...(typeof data.revision === 'string'
      ? {
          data: {
            revision: prefix(data.revision, 128),
            ...(typeof data.path === 'string' ? { path: prefix(data.path, 256) } : {}),
          },
        }
      : {}),
    ...(result.error
      ? {
          error: {
            code: prefix(result.error.code, 128),
            message: prefix(result.error.message, 256),
          },
        }
      : {}),
    ...(spill ? { spill } : {}),
  };
  while (Buffer.byteLength(JSON.stringify(inline)) > limit && inline.content.length > 8)
    inline.content = prefix(inline.content, Math.floor(Buffer.byteLength(inline.content) / 2));
  if (Buffer.byteLength(JSON.stringify(inline)) > limit) {
    delete inline.data;
    if (inline.error) inline.error.message = '';
    inline.content = '';
  }
  return inline;
}

export function recoverState(state: SessionState): SessionState {
  const next = structuredClone(state);
  if (next.pendingSubagentTokens) {
    next.totalTokens += next.pendingSubagentTokens;
    if (!Number.isSafeInteger(next.totalTokens))
      throw new AppError('SESSION_INVALID', '恢复预算无效。');
    next.estimated = true;
  }
  delete next.pendingSubagentTokens;
  const pending = new Set(validateHistory(next.messages, true));
  for (const message of next.messages)
    for (const call of message.toolCalls ?? [])
      if (pending.has(call.callId))
        next.messages.push({
          role: 'tool',
          callId: call.callId,
          content: JSON.stringify({
            callId: call.callId,
            name: call.name,
            ok: false,
            content: '恢复时此调用的完成状态不确定；未重放。先核对外部状态，再决定新的操作。',
            error: { code: 'ACTION_UNCERTAIN', message: '调用未重放，需核对外部状态。' },
          }),
        });
  if (pending.size) next.status = 'uncertain';
  validateHistory(next.messages);
  return next;
}
