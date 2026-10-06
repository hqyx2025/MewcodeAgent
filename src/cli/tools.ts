import { randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { AppError } from '../shared/errors.js';
import { terminalText } from '../shared/terminal-text.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { ToolExecutor } from '../tools/executor.js';
import type { LoadedConfiguration } from '../config/load.js';
import type { ToolContext } from '../tools/types.js';
import { permissionRuntime } from './permissions.js';

export interface ToolCLIOptions {
  input?: string;
  inputFile?: string;
  approve?: boolean;
  shell?: string;
  shellExecutable?: string;
  auditFile?: string;
}

export function listTools(): void {
  process.stdout.write(`${JSON.stringify(createBuiltinRegistry().definitions(), null, 2)}\n`);
}

export async function runTool(
  loaded: LoadedConfiguration,
  name: string,
  options: ToolCLIOptions,
): Promise<void> {
  if ((options.input === undefined) === (options.inputFile === undefined))
    throw new AppError('INVALID_PROMPT', '指定且仅指定--input或--input-file。');
  let raw = options.input;
  if (options.inputFile !== undefined) {
    const inputPath = resolve(loaded.cwd, options.inputFile);
    const inputStat = await lstat(inputPath).catch(() => {
      throw new AppError('INVALID_PROMPT', '参数文件不存在或无法访问。');
    });
    if (!inputStat.isFile() || inputStat.size > 256 * 1024)
      throw new AppError('INVALID_PROMPT', '参数文件必须是最多256KiB的普通文件。');
    const file = await open(inputPath, 'r').catch(() => {
      throw new AppError('INVALID_PROMPT', '无法读取参数文件，请检查路径和权限。');
    });
    try {
      if (!(await file.stat()).isFile()) throw new Error('Not a file');
      const bytes = Buffer.alloc(256 * 1024 + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > 256 * 1024) throw new Error('Too large');
      raw = new TextDecoder('utf8', { fatal: true }).decode(bytes.subarray(0, bytesRead));
    } catch {
      throw new AppError('INVALID_PROMPT', '参数文件必须是最多256KiB的UTF-8 JSON普通文件。');
    } finally {
      await file.close();
    }
  }
  let input: unknown;
  try {
    if (raw === undefined || Buffer.byteLength(raw) > 256 * 1024) throw new Error('Too large');
    input = JSON.parse(raw);
  } catch {
    throw new AppError('INVALID_PROMPT', '工具输入必须是最多256KiB的JSON。');
  }
  let shell: ToolContext['shell'] | undefined;
  if (options.shell !== undefined || options.shellExecutable !== undefined) {
    if (!['powershell', 'bash'].includes(options.shell ?? ''))
      throw new AppError('CONFIG_INVALID', '--shell必须是powershell或bash。');
    if (options.shellExecutable !== undefined && !isAbsolute(options.shellExecutable))
      throw new AppError('CONFIG_INVALID', '--shell-executable必须为绝对路径。');
    if (process.platform === 'win32' && options.shell === 'bash' && !options.shellExecutable)
      throw new AppError('CONFIG_INVALID', 'Windows Bash需显式指定Git Bash可执行路径。');
    shell = {
      kind: options.shell as 'powershell' | 'bash',
      executable:
        options.shellExecutable ??
        (options.shell === 'bash'
          ? '/bin/bash'
          : process.platform === 'win32'
            ? 'powershell.exe'
            : 'pwsh'),
    };
  }
  const runtime = await permissionRuntime(loaded, options.auditFile);
  try {
    const executor = await ToolExecutor.create(createBuiltinRegistry(), {
      root: loaded.cwd,
      mode: loaded.settings.mode,
      timeoutMs: loaded.settings.limits.timeoutMs,
      rules: runtime.rules,
      audit: runtime.audit,
      ...(shell ? { shell } : {}),
      ...(options.approve
        ? {
            approve: async (request) => {
              process.stderr.write(
                terminalText(
                  `已按--approve授权本次${request.name}：${request.target}\n${request.preview}\n`,
                ),
              );
              return true;
            },
          }
        : {}),
    });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    process.once('SIGINT', cancel);
    try {
      const result = await executor.execute(
        { callId: randomUUID(), name, input },
        controller.signal,
      );
      process.stdout.write(`${JSON.stringify({ ...result, audit: executor.auditLog }, null, 2)}\n`);
      if (!result.ok) process.exitCode = result.error?.code === 'CANCELLED' ? 130 : 1;
    } finally {
      process.removeListener('SIGINT', cancel);
    }
  } finally {
    await runtime.close();
  }
}
