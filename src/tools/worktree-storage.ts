import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { parse, relative, resolve, sep, join } from 'node:path';
import { hostname } from 'node:os';
import { ToolError } from './errors.js';
const queues = new Map<string, Promise<void>>();

export const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export const inside = (root: string, path: string) => {
  const local = relative(root, path);
  return !local || (!local.startsWith(`..${sep}`) && local !== '..' && !parse(local).root);
};
export async function safeDirectory(
  path: string,
  create = false,
  canonicalize = false,
): Promise<string> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (create)
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ToolError('WORKTREE_OWNER', '工作树目录不能是链接或其他文件类型。');
  }
  const canonical = await realpath(absolute);
  if (!canonicalize && !samePath(canonical, absolute))
    throw new ToolError('WORKTREE_OWNER', '工作树存储路径存在别名。');
  return canonical;
}
export async function readOwned(path: string, limit = 64 * 1024): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > limit)
    throw new ToolError('WORKTREE_OWNER', '工作树归属文件类型或大小无效。');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await file.stat();
    if (!current.isFile() || current.nlink !== 1 || current.size > limit)
      throw new ToolError('WORKTREE_OWNER', '工作树归属文件无效。');
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await file.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > limit) throw new ToolError('WORKTREE_OWNER', '工作树归属文件过大。');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}
export async function writeOwned(path: string, text: string, newFile = false): Promise<void> {
  if (!newFile) await readOwned(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(newFile ? path : temporary, 'wx', 0o600);
  try {
    await file.writeFile(text, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  if (!newFile) {
    try {
      await readOwned(path);
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }
}
/** Process-scoped lock; never silently steals a stale lock. */
export async function withWorktreeLock<T>(
  directory: string,
  repository: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(directory) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((done) => {
    release = done;
  });
  queues.set(directory, tail);
  await previous;
  try {
    return await locked(directory, repository, fn);
  } finally {
    release();
    if (queues.get(directory) === tail) queues.delete(directory);
  }
}
async function locked<T>(directory: string, repository: string, fn: () => Promise<T>): Promise<T> {
  await safeDirectory(directory);
  const path = join(directory, 'manager.lock');
  const text = JSON.stringify({
    app: 'mewcode-worktrees',
    repository,
    host: hostname(),
    pid: process.pid,
    id: randomUUID(),
  });
  try {
    await writeOwned(path, text, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new ToolError('WORKTREE_LOCKED', '工作树管理器已锁定；不能并发修改或自动抢占。');
    throw error;
  }
  try {
    return await fn();
  } finally {
    if ((await readOwned(path)) === text) await unlink(path);
  }
}
