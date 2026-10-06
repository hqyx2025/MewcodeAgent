import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, parse, relative, resolve, sep } from 'node:path';

/** Validate every existing directory before canonicalization; never follow a junction. */
export async function safeDirectory(path: string): Promise<string> {
  const target = resolve(path);
  let current = parse(target).root;
  for (const part of relative(current, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe directory');
  }
  return realpath(target);
}

/** Read a bounded stable regular file, optionally decoding only its header prefix. */
export async function readBoundedText(
  path: string,
  limit: number,
  prefixBytes = limit,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit)
    throw new Error('Unsafe file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.ino !== info.ino ||
      before.dev !== info.dev ||
      before.size !== info.size ||
      before.mtimeMs !== info.mtimeMs
    )
      throw new Error('Changed file');
    const buffer = Buffer.alloc(Math.min(prefixBytes, before.size));
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error('Changed file');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.nlink !== 1 || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw new Error('Changed file');
    signal?.throwIfAborted();
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer, {
      stream: buffer.length < before.size,
    });
  } finally {
    await handle.close();
  }
}
