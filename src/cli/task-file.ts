import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { ToolExecutor } from '../tools/executor.js';
import { AppError } from '../shared/errors.js';

export async function readTaskFile(executor: ToolExecutor, name: string): Promise<unknown> {
  try {
    const path = await executor.paths.resolve(name);
    if (!executor.allowsRead('ReadFile', path)) throw new Error('Denied');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 32 * 1024) throw new Error('Size');
      const bytes = Buffer.alloc(32 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > 32 * 1024) throw new Error('Size');
      return JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)),
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
}
