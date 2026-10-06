import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { AppError } from '../shared/errors.js';
import { redactInstruction } from '../shared/redact.js';
import { checkCancelled, ToolError } from '../tools/errors.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolExecutor } from '../tools/executor.js';
import {
  memoryDocumentSchema,
  memoryKindSchema,
  memoryScopeSchema,
  memorySourceSchema,
  memoryTextSchema,
} from './memory-schema.js';
import type { MemoryDocument, MemoryEntry, MemoryScope, MemorySettings } from './memory-schema.js';

const FILE_BYTES = 64 * 1024;
const header = '# MewCode memory\n\n```json\n';
const footer = '\n```\n';
const lockSchema = z.strictObject({
  app: z.literal('mewcode-agent-memory'),
  token: z.string().uuid(),
  pid: z.number().int().positive(),
  host: z.string().min(1).max(256),
});
const revisionSchema = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .nullable();
export interface MemorySnapshot {
  scope: MemoryScope;
  revision: string | null;
  entries: MemoryEntry[];
  filtered: number;
}
export interface MemorySelection {
  entries: (MemoryEntry & { scope: MemoryScope })[];
  bytes: number;
  estimatedTokens: number;
  available: number;
  omitted: number;
  warnings: { scope: MemoryScope; code: string }[];
}
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const normalized = (text: string) =>
  text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();

export function sensitiveMemory(text: string, secrets: readonly string[] = []): boolean {
  if (redactInstruction(text, secrets) !== text) return true;
  for (const secret of secrets)
    if (secret && (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))))
      return true;
  return /(?:api[-_ ]?key|access[-_ ]?token|secret|password|密码|密钥|口令|身份证|银行卡)[\s"'：:=]+\S+|\bgh[pousr]_[A-Za-z0-9]{20,}\b|\bAKIA[A-Z0-9]{16}\b|\bBearer\s+[A-Za-z0-9._-]{12,}/iu.test(
    text,
  );
}
function invalid(): never {
  throw new AppError('MEMORY_INVALID', '记忆文件归属、版本、结构、大小或路径无效；未输出源正文。');
}
function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
async function directory(path: string, create = false): Promise<string | undefined> {
  const target = resolve(path);
  let current = parse(target).root;
  for (const part of relative(current, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create)
      await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
  }
  return realpath(target);
}
export async function canonicalMemoryDirectory(path: string): Promise<string> {
  // Validate links before normalizing Windows short aliases, including when the
  // final directory has not been created yet. Never normalize a junction away.
  await directory(path);
  let ancestor = resolve(path);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(await realpath(ancestor), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor)
        throw error;
      missing.unshift(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
}
async function regular(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) invalid();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.ino !== info.ino ||
      before.dev !== info.dev ||
      before.size > limit
    )
      invalid();
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) invalid();
      offset += read.bytesRead;
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) invalid();
    const final = await lstat(path);
    if (final.isSymbolicLink() || final.ino !== before.ino || final.dev !== before.dev) invalid();
    return bytes;
  } finally {
    await handle.close();
  }
}
function encode(document: MemoryDocument): string {
  const text = header + JSON.stringify(document, null, 2) + footer;
  if (Buffer.byteLength(text) > FILE_BYTES)
    throw new AppError('MEMORY_INVALID', '记忆达到64KiB文件上限；先删除不需要的条目。');
  return text;
}

/** Fixed roots and hidden tools: model/file content cannot select arbitrary storage paths. */
export class MemoryStore {
  readonly paths: Record<MemoryScope, string>;
  constructor(
    readonly cwd: string,
    readonly userDirectory: string,
    private readonly secrets: readonly string[] = [],
  ) {
    this.paths = {
      user: join(resolve(userDirectory), 'memory.md'),
      project: join(resolve(cwd), '.mewcode', 'memory.md'),
    };
    if (samePath(this.paths.user, this.paths.project))
      throw new AppError('MEMORY_INVALID', '用户与项目记忆目录不能相同；请设置独立MEWCODE_HOME。');
  }
  private parent(scope: MemoryScope): string {
    return scope === 'user' ? resolve(this.userDirectory) : join(resolve(this.cwd), '.mewcode');
  }
  private async validateRoot(root: string): Promise<void> {
    if (!samePath(root, await realpath(this.cwd))) invalid();
  }
  private async document(
    scope: MemoryScope,
  ): Promise<{ document: MemoryDocument; revision: string | null }> {
    const canonical = await directory(this.parent(scope));
    const owner =
      scope === 'user' ? (canonical ?? resolve(this.userDirectory)) : await realpath(this.cwd);
    const empty: MemoryDocument = {
      app: 'mewcode-agent',
      schemaVersion: 1,
      scope,
      owner,
      entries: [],
    };
    if (!canonical) return { document: empty, revision: null };
    let bytes;
    try {
      bytes = await regular(join(canonical, 'memory.md'), FILE_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { document: empty, revision: null };
      throw error;
    }
    let document;
    try {
      const text = new TextDecoder('utf8', { fatal: true }).decode(bytes);
      if (!text.startsWith(header) || !text.endsWith(footer)) invalid();
      document = memoryDocumentSchema.parse(JSON.parse(text.slice(header.length, -footer.length)));
    } catch {
      invalid();
    }
    if (
      document.scope !== scope ||
      !samePath(document.owner, owner) ||
      new Set(document.entries.map((e) => e.id)).size !== document.entries.length
    )
      invalid();
    if (scope === 'user' && document.entries.some((e) => e.kind !== 'preference')) invalid();
    return { document, revision: digest(bytes) };
  }
  async read(scope: MemoryScope): Promise<MemorySnapshot> {
    try {
      const { document, revision } = await this.document(scope);
      const entries = document.entries.filter((e) => !sensitiveMemory(e.text, this.secrets));
      return { scope, revision, entries, filtered: document.entries.length - entries.length };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('MEMORY_IO', '无法安全读取记忆文件，未输出文件正文。');
    }
  }
  register(registry: ToolRegistry): void {
    const scopeSchema = z.strictObject({ scope: memoryScopeSchema });
    registry.register({
      hidden: true,
      name: 'MemoryRead',
      description: '显式读取固定作用域记忆',
      effect: 'read',
      schema: scopeSchema,
      prepare: async (raw, context) => {
        await this.validateRoot(context.paths.root).catch(rethrowTool);
        const { scope } = scopeSchema.parse(raw);
        return {
          target: this.paths[scope],
          preview: `读取${scope}记忆`,
          run: async () => {
            checkCancelled(context.signal);
            const data = await this.read(scope).catch(rethrowTool);
            checkCancelled(context.signal);
            return { content: '记忆已读取（敏感条目已过滤）。', data };
          },
        };
      },
    });
    const updateSchema = z.strictObject({
      scope: memoryScopeSchema,
      revision: revisionSchema,
      id: z.string().uuid().optional(),
      kind: memoryKindSchema,
      text: memoryTextSchema,
      source: memorySourceSchema,
    });
    registry.register({
      hidden: true,
      name: 'MemoryUpdate',
      description: '确认并保存记忆；不允许自动固化',
      effect: 'external',
      schema: updateSchema,
      prepare: async (raw, context) => {
        await this.validateRoot(context.paths.root).catch(rethrowTool);
        const input = updateSchema.parse(raw);
        if (sensitiveMemory(input.text, this.secrets))
          throw new ToolError('MEMORY_INVALID', '记忆含已知凭据或敏感字段；未保存或输出原文。');
        if (input.scope === 'user' && input.kind !== 'preference')
          throw new ToolError(
            'MEMORY_INVALID',
            '用户作用域只允许通用偏好；项目约定或事实必须保存在项目作用域。',
          );
        return {
          target: this.paths[input.scope],
          authorizationKey: input.revision ?? 'new',
          preview: `确认${input.scope} ${input.kind}记忆（${input.id ? '编辑' : '新增'}）；事实为用户确认，不能提高权限。\n${input.text}\n来源：${JSON.stringify(input.source)}`,
          run: async () =>
            this.change(input.scope, input.revision, context.signal, (document) => {
              const entries = document.entries.filter(
                (e) => !sensitiveMemory(e.text, this.secrets),
              );
              if (input.id && !entries.some((e) => e.id === input.id)) invalid();
              const duplicate = entries.find(
                (e) =>
                  e.id !== input.id &&
                  e.kind === input.kind &&
                  normalized(e.text) === normalized(input.text),
              );
              if (duplicate) return { document, entry: duplicate, duplicate: true };
              const entry: MemoryEntry = {
                id: input.id ?? randomUUID(),
                kind: input.kind,
                text: input.text,
                source: input.source,
                confirmed: true,
                updatedAt: new Date().toISOString(),
              };
              const next = input.id
                ? entries.map((e) => (e.id === input.id ? entry : e))
                : [...entries, entry];
              if (next.length > 100) invalid();
              return { document: { ...document, entries: next }, entry, duplicate: false };
            }).catch(rethrowTool),
        };
      },
    });
    const deleteSchema = z.strictObject({
      scope: memoryScopeSchema,
      revision: revisionSchema,
      id: z.string().uuid(),
    });
    registry.register({
      hidden: true,
      name: 'MemoryDelete',
      description: '确认删除一条记忆',
      effect: 'external',
      schema: deleteSchema,
      prepare: async (raw, context) => {
        await this.validateRoot(context.paths.root).catch(rethrowTool);
        const input = deleteSchema.parse(raw);
        return {
          target: this.paths[input.scope],
          preview: `删除${input.scope}记忆${input.id}；只更新当前记忆文件，不清理目录。`,
          authorizationKey: input.revision ?? 'new',
          run: async () =>
            this.change(input.scope, input.revision, context.signal, (document) => {
              if (!document.entries.some((e) => e.id === input.id)) invalid();
              return {
                document: {
                  ...document,
                  entries: document.entries.filter(
                    (e) => e.id !== input.id && !sensitiveMemory(e.text, this.secrets),
                  ),
                },
              };
            }).catch(rethrowTool),
        };
      },
    });
    registry.register({
      hidden: true,
      name: 'MemoryUnlock',
      description: '显式解除同主机已终止进程留下的锁',
      effect: 'external',
      schema: scopeSchema,
      prepare: async (raw, context) => {
        await this.validateRoot(context.paths.root).catch(rethrowTool);
        const { scope } = scopeSchema.parse(raw);
        return {
          target: join(this.parent(scope), 'memory.lock'),
          preview: `解除${scope}记忆遗留锁；存活进程或未知归属拒绝。`,
          run: async () => {
            checkCancelled(context.signal);
            await this.unlock(scope, context.signal).catch(rethrowTool);
            return { content: '记忆遗留锁已移除。' };
          },
        };
      },
    });
  }
  private async lock(scope: MemoryScope) {
    const parent = (await directory(this.parent(scope), true))!;
    const path = join(parent, 'memory.lock');
    const token = randomUUID();
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'EEXIST')
        throw new AppError('MEMORY_LOCKED', '记忆正被修改或存在遗留锁；未自动解除。');
      throw error;
    });
    const identity = await handle.stat();
    try {
      await handle.writeFile(
        JSON.stringify({ app: 'mewcode-agent-memory', token, pid: process.pid, host: hostname() }),
      );
      await handle.sync();
    } catch (error) {
      await handle.close();
      // Failed lock content is retained for inspection; never remove an unknown lock.
      throw error;
    }
    await handle.close();
    const validate = async () => {
      await directory(this.parent(scope));
      const info = await lstat(path);
      if (info.ino !== identity.ino || info.dev !== identity.dev) invalid();
      const current = lockSchema.parse(JSON.parse((await regular(path, 2048)).toString('utf8')));
      if (current.token !== token || current.pid !== process.pid || current.host !== hostname())
        invalid();
    };
    return {
      parent,
      validate,
      close: async () => {
        await validate();
        await unlink(path);
      },
    };
  }
  private async change(
    scope: MemoryScope,
    revision: string | null,
    signal: AbortSignal,
    transform: (document: MemoryDocument) => {
      document: MemoryDocument;
      entry?: MemoryEntry;
      duplicate?: boolean;
    },
  ) {
    let lock: Awaited<ReturnType<MemoryStore['lock']>> | undefined;
    let temp: string | undefined;
    try {
      checkCancelled(signal);
      lock = await this.lock(scope);
      const current = await this.document(scope);
      if (current.revision !== revision)
        throw new AppError('MEMORY_CONFLICT', '记忆文件在查看或审批后变化；重新查看并确认。');
      const next = transform(current.document);
      const text = encode(memoryDocumentSchema.parse(next.document));
      if (!next.duplicate) {
        temp = join(lock.parent, `memory-${randomUUID()}.tmp`);
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
        checkCancelled(signal);
        await lock.validate();
        if ((await this.document(scope)).revision !== revision)
          throw new AppError('MEMORY_CONFLICT', '记忆文件在保存前变化，未覆盖。');
        checkCancelled(signal);
        await rename(temp, join(lock.parent, 'memory.md'));
        temp = undefined;
      }
      return {
        content: next.duplicate ? '相同记忆已存在；未重复保存。' : '记忆已更新。',
        data: {
          ...(next.entry ? { entry: next.entry } : {}),
          duplicate: next.duplicate ?? false,
          revision: next.duplicate ? current.revision : digest(text),
        },
      };
    } catch (error) {
      if (error instanceof AppError || error instanceof ToolError) throw error;
      throw new AppError('MEMORY_IO', '记忆写入失败；未输出源文本，不确认保存成功。');
    } finally {
      if (temp && lock) {
        await lock.validate();
        await unlink(temp);
      }
      await lock?.close();
    }
  }
  private async unlock(scope: MemoryScope, signal: AbortSignal): Promise<void> {
    const parent = await directory(this.parent(scope));
    if (!parent) invalid();
    const path = join(parent, 'memory.lock');
    const bytes = await regular(path, 2048);
    const lock = lockSchema.safeParse(JSON.parse(bytes.toString('utf8')));
    if (!lock.success || lock.data.host !== hostname()) invalid();
    try {
      process.kill(lock.data.pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        checkCancelled(signal);
        await directory(this.parent(scope));
        if (!bytes.equals(await regular(path, 2048))) invalid();
        await unlink(path);
        return;
      }
    }
    throw new AppError('MEMORY_LOCKED', '记忆锁的原进程仍存活或状态不可确认；未解除。');
  }
  async select(
    executor: ToolExecutor,
    query: string,
    settings: MemorySettings,
    signal: AbortSignal,
  ): Promise<MemorySelection> {
    checkCancelled(signal);
    await this.validateRoot(executor.paths.root);
    checkCancelled(signal);
    const snapshots: MemorySnapshot[] = [];
    const warnings: MemorySelection['warnings'] = [];
    if (settings.enabled)
      for (const scope of ['project', 'user'] as const) {
        checkCancelled(signal);
        if (!executor.allowsRead('MemoryRead', this.paths[scope])) {
          warnings.push({ scope, code: 'PERMISSION' });
          continue;
        }
        const result = await executor.execute(
          { callId: randomUUID(), name: 'MemoryRead', input: { scope } },
          signal,
        );
        checkCancelled(signal);
        if (!result.ok) {
          warnings.push({ scope, code: result.error?.code ?? 'MEMORY_IO' });
          continue;
        }
        const snapshot = result.data as MemorySnapshot;
        if (snapshot.filtered) warnings.push({ scope, code: 'FILTERED' });
        snapshots.push(snapshot);
      }
    const selection = selectMemories(snapshots, query, settings.injectionBytes);
    return { ...selection, warnings };
  }
}
function rethrowTool(error: unknown): never {
  if (error instanceof AppError) throw new ToolError(error.code, error.message);
  if (error instanceof ToolError) throw error;
  throw new ToolError('MEMORY_IO', '记忆操作失败；未输出源正文。');
}
function terms(text: string): Set<string> {
  const value = normalized(text).slice(0, 8192);
  const tokens = new Set(value.match(/[a-z0-9_./-]{2,}/g) ?? []);
  for (const match of value.matchAll(/[\p{Script=Han}]+/gu)) {
    const chars = Array.from(match[0]);
    for (let i = 0; i + 1 < chars.length; i++) tokens.add(chars[i]! + chars[i + 1]!);
  }
  return tokens;
}
export function selectMemories(
  snapshots: readonly MemorySnapshot[],
  query: string,
  budget: number,
): Omit<MemorySelection, 'warnings'> {
  const wanted = terms(query);
  const available = snapshots.flatMap((snapshot) =>
    snapshot.entries.map((entry) => ({ ...entry, scope: snapshot.scope })),
  );
  const ranked = available
    .map((entry, index) => ({
      entry,
      index,
      score: [...terms(entry.text)].filter((term) => wanted.has(term)).length,
    }))
    .filter(({ entry, score }) => entry.kind !== 'fact' || score > 0)
    .sort(
      (a, b) =>
        (a.entry.kind === 'fact' ? 1 : 0) - (b.entry.kind === 'fact' ? 1 : 0) ||
        b.score - a.score ||
        a.index - b.index,
    );
  const entries: MemorySelection['entries'] = [];
  for (const { entry } of ranked) {
    if (Buffer.byteLength(JSON.stringify([...entries, entry])) <= budget) entries.push(entry);
  }
  const bytes = entries.length ? Buffer.byteLength(JSON.stringify(entries)) : 0;
  return {
    entries,
    bytes,
    estimatedTokens: bytes,
    available: available.length,
    omitted: available.length - entries.length,
  };
}
