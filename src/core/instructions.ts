import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { AppError } from '../shared/errors.js';
import { ToolError } from '../tools/errors.js';
import type { ProjectPaths } from '../security/paths.js';

export interface InstructionSource {
  path: string;
  scope: string;
  format: 'AGENTS.md' | 'CLAUDE.md';
  text: string;
  bytes: number;
  originalBytes: number;
  digest: string;
  truncated: boolean;
  redacted: boolean;
}
export type InstructionMetadata = Omit<InstructionSource, 'text'>;
export interface InstructionWarning {
  path: string;
  code: 'UNREADABLE' | 'INVALID_TEXT' | 'TRUNCATED' | 'REDACTED';
  message: string;
}

const FILE_BUDGET = 16 * 1024;
const TOTAL_BUDGET = 32 * 1024;

export class ProjectInstructions {
  private readonly checked = new Set<string>();
  private readonly loaded: InstructionSource[] = [];
  private readonly warnings: InstructionWarning[] = [];
  private readonly history: InstructionWarning[] = [];
  private usedBytes = 0;

  constructor(
    private readonly paths: ProjectPaths,
    private readonly sensitiveValues: readonly string[] = [],
  ) {}

  get sources(): readonly InstructionSource[] {
    return structuredClone(this.loaded);
  }
  get metadata(): readonly InstructionMetadata[] {
    return this.loaded.map(({ text: _text, ...source }) => ({ ...source }));
  }
  get checkedDirectories(): number {
    return this.checked.size;
  }
  get warningHistory(): readonly InstructionWarning[] {
    return structuredClone(this.history);
  }
  takeWarnings(): InstructionWarning[] {
    return this.warnings.splice(0);
  }

  async discover(
    input: string,
    kind: 'file' | 'directory' | 'auto',
    signal: AbortSignal,
  ): Promise<boolean> {
    this.cancelled(signal);
    let directory: string;
    try {
      const target = await this.paths.resolve(input, kind !== 'directory');
      directory =
        kind === 'file'
          ? dirname(target)
          : kind === 'directory'
            ? target
            : (await lstat(target).catch(() => undefined))?.isDirectory()
              ? target
              : dirname(target);
      await this.paths.resolve(directory);
      if (!(await lstat(directory)).isDirectory()) return false;
    } catch (error) {
      // Invalid tool targets are handled by the executor; never follow them for discovery.
      if (error instanceof ToolError) return false;
      throw error;
    }
    const local = relative(this.paths.root, directory);
    const parts = local ? local.split(sep) : [];
    if (parts.length > 32)
      throw new AppError('INSTRUCTIONS_LIMIT', '项目指令发现超过32层目录上限，任务已停止。');
    let current = this.paths.root;
    let changed = false;
    for (let index = 0; index <= parts.length; index++) {
      this.cancelled(signal);
      if (index > 0) current = join(current, parts[index - 1]!);
      if (this.checked.has(current)) continue;
      if (this.checked.size >= 128)
        throw new AppError('INSTRUCTIONS_LIMIT', '项目指令发现超过128个目录上限，任务已停止。');
      await this.paths.resolve(current);
      this.checked.add(current);
      changed = (await this.readDirectory(current, signal)) || changed;
    }
    return changed;
  }

  private async readDirectory(directory: string, signal: AbortSignal): Promise<boolean> {
    for (const format of ['AGENTS.md', 'CLAUDE.md'] as const) {
      const path = join(directory, format);
      const display = this.paths.display(path);
      let stat;
      try {
        stat = await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        this.warn(display, 'UNREADABLE', '指令文件无法访问，未加载；不改读同目录兼容文件。');
        return false;
      }
      if (!stat.isFile() || stat.isSymbolicLink()) {
        this.warn(display, 'UNREADABLE', '指令文件必须是无链接的普通文件，未加载。');
        return false;
      }
      const allowance = Math.min(FILE_BUDGET, TOTAL_BUDGET - this.usedBytes);
      let text: string;
      let truncated: boolean;
      try {
        await this.paths.resolve(path);
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await handle.stat();
          if (
            !before.isFile() ||
            before.dev !== stat.dev ||
            before.ino !== stat.ino ||
            before.size !== stat.size ||
            before.mtimeMs !== stat.mtimeMs
          )
            throw new Error('Changed');
          const bytes = Buffer.alloc(allowance + 4);
          let size = 0;
          while (size < bytes.length) {
            this.cancelled(signal);
            const read = await handle.read(bytes, size, bytes.length - size, size);
            if (!read.bytesRead) break;
            size += read.bytesRead;
          }
          let end = Math.min(size, allowance);
          if (size > allowance) while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
          const prefix = bytes.subarray(0, end);
          if (prefix.includes(0)) throw new TypeError('Binary');
          text = new TextDecoder('utf8', { fatal: true }).decode(prefix);
          const after = await handle.stat();
          if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
            throw new Error('Changed');
          await this.paths.resolve(path);
          truncated = stat.size > end;
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (signal.aborted) throw new AppError('CANCELLED', '指令发现已取消。');
        this.warn(
          display,
          error instanceof TypeError ? 'INVALID_TEXT' : 'UNREADABLE',
          '指令文件不是有效UTF-8文本、已变化或无法安全读取，未加载。',
        );
        return false;
      }
      this.cancelled(signal);
      const safe = redactInstruction(text, this.sensitiveValues);
      const source: InstructionSource = {
        path: display,
        scope: this.paths.display(directory),
        format,
        text: safe,
        bytes: Buffer.byteLength(safe),
        originalBytes: stat.size,
        digest: createHash('sha256').update(safe).digest('hex'),
        truncated,
        redacted: safe !== text,
      };
      this.usedBytes += source.bytes;
      this.loaded.push(source);
      if (truncated)
        this.warn(
          display,
          'TRUNCATED',
          '项目指令按单文件16KiB/总计32KiB上限截断，未加载完整规则。',
        );
      if (source.redacted)
        this.warn(display, 'REDACTED', '项目指令中的已知凭据或常见密钥形式已脱敏。');
      return true;
    }
    return false;
  }

  private warn(path: string, code: InstructionWarning['code'], message: string): void {
    this.warnings.push({ path, code, message });
    this.history.push({ path, code, message });
  }
  private cancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new AppError('CANCELLED', '指令发现已取消。');
  }
}

export function redactInstruction(text: string, sensitiveValues: readonly string[] = []): string {
  let safe = text.replace(
    /-----BEGIN [^\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^\r\n]*PRIVATE KEY-----|$)/g,
    '[REDACTED]',
  );
  safe = safe.replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]');
  for (const value of sensitiveValues)
    if (value.length >= 12) safe = safe.replaceAll(value, '[REDACTED]');
  return safe;
}
