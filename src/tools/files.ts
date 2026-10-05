import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { byteLimit, checkCancelled, ToolError } from './errors.js';
import { defineTool } from './types.js';
import type { ToolContext } from './types.js';

const MAX_FILE = 1024 * 1024;
const pathSchema = z.string().min(1).max(4096);
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const contentSchema = z.string().max(MAX_FILE);

export async function snapshot(path: string, context: ToolContext) {
  checkCancelled(context.signal);
  await context.paths.resolve(path);
  if (!(await lstat(path)).isFile()) throw new ToolError('TOOL_INPUT', '目标必须是普通文件。');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new ToolError('TOOL_INPUT', '目标必须是普通文件。');
    if (stat.size > MAX_FILE) throw new ToolError('FILE_TOO_LARGE', '文件超过1MiB读取上限。');
    const bytes = Buffer.alloc(MAX_FILE + 1);
    let length = 0;
    while (length < bytes.length) {
      checkCancelled(context.signal);
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_FILE) throw new ToolError('FILE_TOO_LARGE', '文件超过1MiB读取上限。');
    await context.paths.resolve(path);
    const buffer = bytes.subarray(0, length);
    if (buffer.includes(0)) throw new ToolError('FILE_BINARY', '不读取二进制文件。');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
    } catch {
      throw new ToolError('FILE_BINARY', '文件不是有效UTF-8文本。');
    }
    return {
      text,
      revision: createHash('sha256').update(buffer).digest('hex'),
      mode: stat.mode,
    };
  } finally {
    await handle.close();
  }
}

async function current(path: string, context: ToolContext) {
  try {
    return await snapshot(path, context);
  } catch (error) {
    if (error instanceof ToolError && error.code === 'FILE_NOT_FOUND') return undefined;
    throw error;
  }
}

async function atomicWrite(
  target: string,
  text: string,
  expected: string | undefined,
  context: ToolContext,
) {
  if (Buffer.byteLength(text) > MAX_FILE)
    throw new ToolError('FILE_TOO_LARGE', '写入内容超过1MiB。');
  checkCancelled(context.signal);
  await context.paths.resolve(target, true);
  const before = await current(target, context);
  if (before?.revision !== expected)
    throw new ToolError('FILE_CONFLICT', '文件已变化，请重新读取后再修改。');
  const temporary = join(dirname(target), `.mewcode-tmp-${randomUUID()}`);
  const handle = await open(temporary, 'wx', before?.mode ?? 0o600);
  try {
    if (before) await handle.chmod(before.mode & 0o777);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    checkCancelled(context.signal);
    await context.paths.resolve(target, true);
    if ((await current(target, context))?.revision !== expected)
      throw new ToolError('FILE_CONFLICT', '文件在写入前发生变化，未覆盖。');
    checkCancelled(context.signal);
    if (before) await rename(temporary, target);
    else {
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw new ToolError('FILE_CONFLICT', '创建目标已存在，未覆盖。');
        throw error;
      }
    }
    return createHash('sha256').update(text, 'utf8').digest('hex');
  } finally {
    await handle.close();
    await rm(temporary, { force: true });
  }
}

function preview(before: string | undefined, after: string): string {
  return `${before === undefined ? '创建文件' : '覆盖文件'}\n--- 原内容（最多1536 bytes）\n${byteLimit(before ?? '(不存在)', 1536)}\n+++ 新内容（最多2048 bytes）\n${byteLimit(after, 2048)}`;
}

export const readFileTool = defineTool({
  name: 'ReadFile',
  description: '读取项目内UTF-8文件，返回行号与修改所需SHA-256 revision。',
  effect: 'read',
  schema: z.strictObject({
    path: pathSchema,
    startLine: z.number().int().min(1).default(1),
    endLine: z.number().int().min(1).optional(),
  }),
  async prepare(input, context) {
    const target = await context.paths.resolve(input.path);
    if (input.endLine !== undefined && input.endLine < input.startLine)
      throw new ToolError('TOOL_INPUT', 'endLine不得小于startLine。');
    return {
      target,
      preview: `读取 ${context.paths.display(target)}`,
      async run() {
        const file = await snapshot(target, context);
        const lines = file.text.split(/\r?\n/);
        const end = Math.min(input.endLine ?? lines.length, input.startLine + 1999, lines.length);
        const selected = lines
          .slice(input.startLine - 1, end)
          .map((line, index) => `${input.startLine + index}: ${line}`)
          .join('\n');
        const content = byteLimit(selected, 32 * 1024);
        return {
          content,
          truncated: content !== selected || end < (input.endLine ?? lines.length),
          data: {
            path: context.paths.display(target),
            revision: file.revision,
            totalLines: lines.length,
            startLine: input.startLine,
            endLine: end,
          },
        };
      },
    };
  },
});

export const writeFileTool = defineTool({
  name: 'WriteFile',
  description: '创建或原子覆盖UTF-8文件。覆盖必须提供ReadFile所得expectedRevision。',
  effect: 'write',
  schema: z.strictObject({
    path: pathSchema,
    content: contentSchema,
    expectedRevision: revisionSchema.optional(),
  }),
  async prepare(input, context) {
    const target = await context.paths.resolve(input.path, true);
    if (Buffer.byteLength(input.content) > MAX_FILE)
      throw new ToolError('FILE_TOO_LARGE', '写入内容超过1MiB。');
    const before = await current(target, context);
    if (before?.revision !== input.expectedRevision)
      throw new ToolError('FILE_CONFLICT', '覆盖需提供最新读取版本；创建目标必须不存在。');
    return {
      target,
      preview: preview(before?.text, input.content),
      async run() {
        const revision = await atomicWrite(target, input.content, input.expectedRevision, context);
        return {
          content: '文件写入成功。',
          data: { path: context.paths.display(target), revision },
        };
      },
    };
  },
});

export const editFileTool = defineTool({
  name: 'EditFile',
  description: '精确文本替换，默认要求唯一匹配。必须提供ReadFile所得expectedRevision。',
  effect: 'write',
  schema: z.strictObject({
    path: pathSchema,
    oldText: contentSchema.min(1),
    newText: contentSchema,
    expectedRevision: revisionSchema,
    replaceAll: z.boolean().default(false),
  }),
  async prepare(input, context) {
    const target = await context.paths.resolve(input.path);
    const before = await snapshot(target, context);
    if (before.revision !== input.expectedRevision)
      throw new ToolError('FILE_CONFLICT', '读取版本已过期，请重新读取。');
    const pieces = before.text.split(input.oldText);
    const matches = pieces.length - 1;
    if (matches === 0) throw new ToolError('EDIT_NO_MATCH', '原文本未匹配，未修改文件。');
    if (matches > 1 && !input.replaceAll)
      throw new ToolError('EDIT_AMBIGUOUS', '匹配不唯一，请扩大原文本或显式replaceAll。');
    const outputBytes =
      Buffer.byteLength(before.text) +
      matches * (Buffer.byteLength(input.newText) - Buffer.byteLength(input.oldText));
    if (outputBytes > MAX_FILE)
      throw new ToolError('FILE_TOO_LARGE', '替换后的文件超过1MiB，未修改。');
    const after = pieces.join(input.newText);
    return {
      target,
      preview: preview(before.text, after),
      async run() {
        const revision = await atomicWrite(target, after, input.expectedRevision, context);
        return {
          content: `文件编辑成功，替换${matches}处。`,
          data: { path: context.paths.display(target), revision, replacements: matches },
        };
      },
    };
  },
});
