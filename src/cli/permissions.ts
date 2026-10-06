import { realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { LoadedConfiguration } from '../config/load.js';
import { AuditFile } from '../security/audit.js';
import type { PermissionAudit } from '../security/audit.js';
import type { HookAudit } from '../tools/hook-types.js';
import type { ScopedPermissionRule } from '../security/rules.js';
import { rulePathSchema } from '../security/rules.js';
import { AppError } from '../shared/errors.js';

export function inspectPermissions(loaded: LoadedConfiguration): void {
  process.stdout.write(
    JSON.stringify(
      {
        mode: loaded.settings.mode,
        rules: loaded.permissionRules,
        precedence: ['mode/path', 'deny', 'ask', 'trusted-file-allow', 'defaults'],
        shell: 'ask (exact command + cwd; no prefix grants)',
        session: 'exact input + target + preview + shell + policy revision; process-local',
      },
      null,
      2,
    ) + '\n',
  );
}

export async function permissionRuntime(
  loaded: LoadedConfiguration,
  auditPath?: string,
  json = false,
) {
  const path = auditPath === undefined ? undefined : resolve(loaded.cwd, auditPath);
  if (path !== undefined) {
    const parent = await realpath(dirname(path)).catch(() => {
      throw new AppError('AUDIT_FAILED', '审计父目录不存在或无法访问。');
    });
    const local = relative(loaded.cwd, join(parent, basename(path)))
      .split(sep)
      .join('/');
    if (
      local &&
      local !== '..' &&
      !local.startsWith('../') &&
      !local.includes(':') &&
      !local.toLowerCase().startsWith('.mewcode/audit/') &&
      (!rulePathSchema.safeParse(local).success || loaded.permissionRules.length >= 400)
    )
      throw new AppError(
        'AUDIT_FAILED',
        '项目内审计路径需符合字面规则且有剩余规则预算；可改用项目外或.mewcode/audit/内的新文件。',
      );
  }
  const file =
    path === undefined
      ? undefined
      : await AuditFile.create(path).catch(() => {
          throw new AppError(
            'AUDIT_FAILED',
            '审计文件无法创建；父目录须为现有普通目录且目标不能存在。',
          );
        });
  const rules: ScopedPermissionRule[] = [...loaded.permissionRules];
  if (file) {
    const local = relative(loaded.cwd, file.path).split(sep).join('/');
    if (
      local &&
      local !== '..' &&
      !local.startsWith('../') &&
      !local.includes(':') &&
      !local.toLowerCase().startsWith('.mewcode/audit/')
    )
      rules.push({ source: 'cli', decision: 'deny', path: local });
  }
  return {
    rules,
    async audit(record: Readonly<PermissionAudit>) {
      await file?.write(record);
      if (json) process.stdout.write(JSON.stringify({ type: 'permission', record }) + '\n');
    },
    async hookAudit(record: Readonly<HookAudit>) {
      await file?.write(record);
      if (json) process.stdout.write(JSON.stringify({ type: 'hook', record }) + '\n');
      else if (record.outcome !== 'continue')
        process.stderr.write(
          `Hook ${record.hookId} / ${record.event}：${record.code ?? record.outcome}；详情见审计。\n`,
        );
    },
    async close() {
      await file?.close();
    },
  };
}
