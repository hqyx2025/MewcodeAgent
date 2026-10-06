import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join, parse, relative, resolve, sep } from 'node:path';
import { ToolError } from '../tools/errors.js';
import type { ToolEffect, ToolMode } from '../tools/types.js';
import type { HookAudit } from '../tools/hook-types.js';

export interface PermissionAudit {
  version: 1;
  executorId: string;
  sequence: number;
  timestamp: string;
  callIdHash: string;
  name: string;
  effect: ToolEffect;
  mode: ToolMode;
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
  sources: readonly string[];
  fingerprint: string;
  authorization: 'policy' | 'once' | 'session' | 'refused' | 'unavailable';
  cached: boolean;
}

// Explicit user-selected path; exclusive new file, never append to an untrusted file.
export class AuditFile {
  private pending: Promise<void> = Promise.resolve();
  private constructor(
    private readonly handle: FileHandle,
    readonly path: string,
  ) {}

  static async create(path: string): Promise<AuditFile> {
    const target = resolve(path);
    try {
      let current = parse(target).root;
      for (const part of relative(current, dirname(target)).split(sep).filter(Boolean)) {
        current = resolve(current, part);
        const stat = await lstat(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe parent');
      }
      const canonical = await realpath(dirname(target));
      const canonicalTarget = join(canonical, basename(target));
      const handle = await open(
        canonicalTarget,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      return new AuditFile(handle, canonicalTarget);
    } catch {
      throw new ToolError(
        'AUDIT_FAILED',
        '审计路径必须是现有普通目录内的新文件，不允许覆盖或链接。',
      );
    }
  }

  write(record: Readonly<PermissionAudit | HookAudit>): Promise<void> {
    this.pending = this.pending.then(() => this.append(record));
    return this.pending;
  }

  private async append(record: Readonly<PermissionAudit | HookAudit>): Promise<void> {
    try {
      await this.handle.writeFile(JSON.stringify(record) + '\n', 'utf8');
      await this.handle.sync();
    } catch {
      throw new ToolError('AUDIT_FAILED', '审计写入失败，本次动作未获准执行。');
    }
  }

  async close(): Promise<void> {
    await this.pending.catch(() => {});
    await this.handle.close();
  }
}
