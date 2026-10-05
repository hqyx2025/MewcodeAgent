import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { checkCancelled, ToolError } from './errors.js';

export function processEnvironment(): NodeJS.ProcessEnv {
  const allow = new Set([
    'PATH',
    'PATHEXT',
    'SYSTEMROOT',
    'WINDIR',
    'SYSTEMDRIVE',
    'COMSPEC',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'PROGRAMDATA',
    'ALLUSERSPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'USERNAME',
    'USERDOMAIN',
    'PSMODULEPATH',
    'OS',
    'PROCESSOR_ARCHITECTURE',
    'NUMBER_OF_PROCESSORS',
    'LANG',
    'LC_ALL',
    'TZ',
  ]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) => allow.has(name.toUpperCase())),
  );
}

export interface ProcessOutput {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}

export async function runProcess(options: {
  executable: string;
  args: string[];
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxBytes?: number;
}): Promise<ProcessOutput> {
  checkCancelled(options.signal);
  return new Promise((resolve, reject) => {
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: processEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let reason: 'cancel' | 'timeout' | 'limit' | undefined;
    let killed: Promise<void> | undefined;
    let bytes = 0;
    let stdout = '';
    let stderr = '';
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');
    const kill = () => {
      if (killed) return;
      killed = new Promise<void>((done) => {
        if (!child.pid) {
          done();
          return;
        }
        if (process.platform === 'win32') {
          const taskkill = join(
            process.env.SystemRoot ?? 'C:\\Windows',
            'System32',
            'taskkill.exe',
          );
          const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            env: processEnvironment(),
          });
          killer.once('error', () => {
            child.kill();
            done();
          });
          killer.once('close', () => {
            child.kill();
            done();
          });
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            child.kill('SIGKILL');
          }
          done();
        }
      });
    };
    const stop = (cause: 'cancel' | 'timeout' | 'limit') => {
      if (reason !== undefined) return;
      reason = cause;
      kill();
    };
    const abort = () => stop('cancel');
    options.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop('timeout'), options.timeoutMs);
    const consume = (chunk: Buffer, decoder: StringDecoder, output: 'stdout' | 'stderr') => {
      const remaining = Math.max(0, (options.maxBytes ?? 64 * 1024) - bytes);
      const portion = chunk.subarray(0, remaining);
      bytes += portion.length;
      const text = decoder.write(portion);
      if (output === 'stdout') stdout += text;
      else stderr += text;
      if (portion.length < chunk.length) stop('limit');
    };
    child.stdout.on('data', (chunk: Buffer) => consume(chunk, outDecoder, 'stdout'));
    child.stderr.on('data', (chunk: Buffer) => consume(chunk, errDecoder, 'stderr'));
    child.once('error', () => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      reject(new ToolError('TOOL_UNAVAILABLE', '可执行程序不可用，请检查rg或shell安装路径。'));
    });
    child.once('close', (exitCode) => {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', abort);
      void (async () => {
        await killed;
        if (reason === 'cancel') throw new ToolError('CANCELLED', '子进程已取消并清理。');
        if (reason === 'timeout') throw new ToolError('TOOL_TIMEOUT', '子进程超时并已清理。');
        if (reason !== 'limit') {
          stdout += outDecoder.end();
          stderr += errDecoder.end();
        }
        resolve({ stdout, stderr, exitCode, truncated: reason === 'limit' });
      })().catch(reject);
    });
    if (options.signal.aborted) abort();
  });
}
