import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { ToolError } from '../tools/errors.js';
import { within } from './rules.js';

export const SEARCH_IGNORES = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/coverage/**',
  '**/.env',
  '**/.env.*',
  '**/.mewcode/config.yaml',
  '**/.mewcode/sessions/**',
  '**/.mewcode/cache/**',
  '**/.mewcode/audit/**',
  '**/.mewcode/memory.md',
  '**/.mewcode/memory.lock',
  '**/.mewcode/memory-*.tmp',
];

export class ProjectPaths {
  private constructor(
    readonly root: string,
    private readonly deniedScopes: readonly string[],
  ) {}

  static async create(root: string, deniedScopes: readonly string[] = []): Promise<ProjectPaths> {
    const canonical = await realpath(root);
    if (!(await lstat(canonical)).isDirectory())
      throw new ToolError('PATH_DENIED', '工具项目根必须是目录。');
    return new ProjectPaths(canonical, [...deniedScopes]);
  }

  async resolve(input: string, allowMissing = false): Promise<string> {
    if (!input || input.includes('\0')) throw new ToolError('PATH_DENIED', '路径无效。');
    const rootStat = await lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new ToolError('PATH_DENIED', '项目根已变化或成为链接，拒绝操作。');
    const target = resolve(this.root, input);
    const local = relative(this.root, target);
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`))
      throw new ToolError('PATH_DENIED', '文件工具路径必须位于项目根内。');
    const parts = local.split(sep).filter(Boolean);
    if (this.deniedScopes.some((scope) => within(parts.join('/') || '.', scope)))
      throw new ToolError('TOOL_PERMISSION', '权限规则禁止访问该路径。');
    if (
      parts.some(
        (part) =>
          part.includes(':') ||
          [...part].some((char) => char.charCodeAt(0) < 32) ||
          /[. ]$/.test(part),
      )
    )
      throw new ToolError('PATH_DENIED', '路径含不支持的别名或特殊字符。');
    const lower = parts.map((part) => part.toLowerCase());
    if (
      lower.some((part) => part === '.git' || part === '.env' || part.startsWith('.env.')) ||
      lower.some(
        (part, index) =>
          part === '.mewcode' &&
          (['config.yaml', 'sessions', 'cache', 'audit', 'memory.md', 'memory.lock'].includes(
            lower[index + 1] ?? '',
          ) ||
            /^memory-.*\.tmp$/.test(lower[index + 1] ?? '')),
      ) ||
      parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
    ) {
      throw new ToolError('PATH_DENIED', '该路径保留给凭据、内部存储或系统资源。');
    }
    let current = this.root;
    for (const [index, part] of parts.entries()) {
      current = resolve(current, part);
      try {
        const stat = await lstat(current);
        if (stat.isSymbolicLink())
          throw new ToolError('PATH_DENIED', '文件工具不跟随符号链接或junction。');
        if (index < parts.length - 1 && !stat.isDirectory())
          throw new ToolError('PATH_DENIED', '父路径必须为目录。');
        const canonical = await realpath(current);
        if (
          (process.platform === 'win32' ? canonical.toLowerCase() : canonical) !==
          (process.platform === 'win32' ? current.toLowerCase() : current)
        )
          throw new ToolError('PATH_DENIED', '路径存在文件系统别名，需使用规范路径。');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          if (allowMissing && index === parts.length - 1) return target;
          throw new ToolError('FILE_NOT_FOUND', '目标或父目录不存在。');
        }
        throw error;
      }
    }
    return target;
  }

  display(target: string): string {
    return relative(this.root, target).split(sep).join('/') || '.';
  }
}
