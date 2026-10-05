import { opendir, lstat } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import picomatch from 'picomatch';
import { z } from 'zod';
import { SEARCH_IGNORES } from '../security/paths.js';
import { byteLimit, checkCancelled, ToolError } from './errors.js';
import { runProcess } from './process.js';
import { defineTool } from './types.js';

const patternSchema = z.string().min(1).max(512);
function checkPattern(pattern: string): void {
  if (
    isAbsolute(pattern) ||
    /[\\:{}()]/.test(pattern) ||
    [...pattern].some((char) => char.charCodeAt(0) < 32) ||
    pattern.startsWith('!') ||
    pattern.split('/').includes('..')
  )
    throw new ToolError(
      'TOOL_INPUT',
      'glob必须是项目相对模式，支持*、**、?和字符类，不支持展开表达式。',
    );
}

export const globTool = defineTool({
  name: 'Glob',
  description: '有界查找项目文件。支持*、**、?、字符类，默认排除依赖/构建/凭据与链接。',
  effect: 'read',
  schema: z.strictObject({
    pattern: patternSchema,
    includeHidden: z.boolean().default(false),
    ignore: z.array(patternSchema).max(20).default([]),
    maxResults: z.number().int().min(1).max(2000).default(200),
  }),
  async prepare(input, context) {
    checkPattern(input.pattern);
    input.ignore.forEach(checkPattern);
    return {
      target: context.paths.root,
      preview: `查找 ${input.pattern}`,
      async run() {
        const paths: string[] = [];
        let bytes = 0;
        let visited = 0;
        let truncated = false;
        const match = picomatch(input.pattern, {
          dot: input.includeHidden,
          nobrace: true,
          noext: true,
          nonegate: true,
        });
        const ignored = picomatch([...SEARCH_IGNORES, ...input.ignore], {
          dot: true,
          nobrace: true,
          noext: true,
          nonegate: true,
        });
        const scanned = picomatch.scan(input.pattern, { nonegate: true });
        const prefix = scanned.isGlob ? scanned.base : posix.dirname(input.pattern);
        if (
          !input.includeHidden &&
          prefix.split('/').some((part) => part.startsWith('.') && part !== '.')
        )
          return { content: '无匹配文件。', data: { paths: [] }, truncated: false };
        let start: string;
        try {
          start = await context.paths.resolve(prefix || '.');
          if (!(await lstat(start)).isDirectory())
            return { content: '无匹配文件。', data: { paths: [] }, truncated: false };
          if (start !== context.paths.root && ignored(context.paths.display(start)))
            return { content: '无匹配文件。', data: { paths: [] }, truncated: false };
        } catch (error) {
          if (error instanceof ToolError && error.code === 'FILE_NOT_FOUND')
            return { content: '无匹配文件。', data: { paths: [] }, truncated: false };
          throw error;
        }
        const directories = [{ path: start, depth: 0 }];
        outer: while (directories.length > 0) {
          const directory = directories.pop()!;
          checkCancelled(context.signal);
          await context.paths.resolve(directory.path);
          const entries = await opendir(directory.path);
          for await (const entry of entries) {
            checkCancelled(context.signal);
            if (++visited > 100_000)
              throw new ToolError('TOOL_LIMIT', '遍历超过100000个目录项上限。');
            const path = join(directory.path, entry.name);
            const local = context.paths.display(path);
            if (
              entry.isSymbolicLink() ||
              ['node_modules', '.git', 'dist', 'coverage'].includes(entry.name.toLowerCase()) ||
              (!input.includeHidden && entry.name.startsWith('.')) ||
              ignored(local)
            )
              continue;
            if (entry.isDirectory()) {
              if (directory.depth >= 64)
                throw new ToolError('TOOL_LIMIT', '目录深度超过64层上限。');
              try {
                await context.paths.resolve(path);
              } catch (error) {
                if (
                  error instanceof ToolError &&
                  ['PATH_DENIED', 'FILE_NOT_FOUND'].includes(error.code)
                )
                  continue;
                throw error;
              }
              directories.push({ path, depth: directory.depth + 1 });
              continue;
            }
            if (!entry.isFile() || !match(local)) continue;
            try {
              await context.paths.resolve(path);
            } catch (error) {
              if (
                error instanceof ToolError &&
                ['PATH_DENIED', 'FILE_NOT_FOUND'].includes(error.code)
              )
                continue;
              throw error;
            }
            bytes += Buffer.byteLength(local) + 1;
            if (paths.length >= input.maxResults || bytes > 16 * 1024) {
              truncated = true;
              break outer;
            }
            paths.push(local);
          }
        }
        paths.sort();
        return { content: paths.join('\n') || '无匹配文件。', data: { paths }, truncated };
      },
    };
  },
});

export const grepTool = defineTool({
  name: 'Grep',
  description: '使用rg搜索项目文本，支持正则/字面量，返回路径和行号并遵守rg忽略规则。',
  effect: 'read',
  schema: z.strictObject({
    pattern: z.string().min(1).max(4096),
    path: z.string().min(1).max(4096).default('.'),
    literal: z.boolean().default(false),
    includeHidden: z.boolean().default(false),
    fileGlob: patternSchema.optional(),
    maxResults: z.number().int().min(1).max(1000).default(200),
  }),
  async prepare(input, context) {
    const target = await context.paths.resolve(input.path);
    if (input.fileGlob) checkPattern(input.fileGlob);
    return {
      target,
      preview: `搜索 ${input.pattern}`,
      async run() {
        await context.paths.resolve(target);
        const args = [
          '--json',
          '--no-follow',
          '--no-require-git',
          '--max-filesize',
          '1M',
          '--max-count',
          String(input.maxResults + 1),
          '--max-columns',
          '2000',
          '--max-columns-preview',
        ];
        if (input.literal) args.push('--fixed-strings');
        if (input.includeHidden) args.push('--hidden');
        if (input.fileGlob)
          args.push(
            '--type-add',
            `mewcodeuser:${posix.basename(input.fileGlob)}`,
            '--type',
            'mewcodeuser',
          );
        for (const pattern of SEARCH_IGNORES) args.push('--glob', `!${pattern}`);
        args.push('-e', input.pattern, '--', target);
        const output = await runProcess({
          executable: context.rgExecutable,
          args,
          cwd: context.paths.root,
          signal: context.signal,
          timeoutMs: 15_000,
          maxBytes: 256 * 1024,
        });
        if (!output.truncated && output.exitCode !== 0 && output.exitCode !== 1)
          throw new ToolError('GREP_FAILED', 'rg搜索失败，请检查正则表达式和文件权限。');
        const matches: { path: string; line: number; text: string }[] = [];
        const fileMatch = input.fileGlob
          ? picomatch(input.fileGlob, { dot: true, nobrace: true, noext: true, nonegate: true })
          : undefined;
        let bytes = 0;
        let truncated = output.truncated;
        for (const line of output.stdout.split('\n')) {
          if (!line) continue;
          let event: {
            type: string;
            data: { path?: { text?: string }; lines?: { text?: string }; line_number?: number };
          };
          try {
            event = JSON.parse(line) as typeof event;
          } catch {
            if (output.truncated) {
              truncated = true;
              continue;
            }
            throw new ToolError('GREP_FAILED', 'rg返回无效JSON。');
          }
          if (event.type !== 'match') continue;
          const matchPath = event.data.path?.text;
          const text = event.data.lines?.text;
          if (!matchPath || text === undefined || !event.data.line_number) continue;
          const local = context.paths.display(matchPath);
          if (fileMatch && !fileMatch(local)) continue;
          try {
            await context.paths.resolve(matchPath);
            if (!(await lstat(matchPath)).isFile()) continue;
          } catch (error) {
            if (
              error instanceof ToolError &&
              ['PATH_DENIED', 'FILE_NOT_FOUND'].includes(error.code)
            )
              continue;
            throw error;
          }
          const match = {
            path: local,
            line: event.data.line_number,
            text: byteLimit(text.trimEnd(), 2000),
          };
          bytes += Buffer.byteLength(JSON.stringify(match));
          if (matches.length >= input.maxResults || bytes > 16 * 1024) {
            truncated = true;
            break;
          }
          matches.push(match);
        }
        return {
          content:
            matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join('\n') ||
            '无匹配。',
          data: { matches },
          truncated,
        };
      },
    };
  },
});
