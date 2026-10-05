import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { processEnvironment } from '../../src/tools/process.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const quote = (text: string) =>
  process.platform === 'win32'
    ? `'${text.replaceAll("'", "''")}'`
    : `'${text.replaceAll("'", "'\\''")}'`;
const nodeCommand = (script: string) => {
  const wrapped = `eval(Buffer.from('${Buffer.from(script).toString('base64')}','base64').toString())`;
  return `${process.platform === 'win32' ? '& ' : ''}${quote(process.execPath)} -e ${quote(wrapped)}`;
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('shell adapter and process cleanup', () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>>;
  let executor: ToolExecutor;
  const children: number[] = [];
  beforeEach(async () => {
    sandbox = await createSandbox();
    executor = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      approve: async () => true,
      timeoutMs: 30_000,
    });
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const pid of children.splice(0)) {
      if (!alive(pid)) continue;
      if (process.platform === 'win32')
        await promisify(execFile)('taskkill.exe', ['/PID', String(pid), '/T', '/F']).catch(
          () => {},
        );
      else {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }
    }
    await removeSandbox(sandbox.root);
  });
  const call = (input: unknown, signal?: AbortSignal) =>
    executor.execute({ callId: randomUUID(), name: 'Bash', input }, signal);

  it('uses UTF-8 output, project cwd and a credential-free environment', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'fake-private-env-value');
    vi.stubEnv('ARBITRARY_SECRET', 'another-private-env-value');
    expect(processEnvironment()).not.toHaveProperty('OPENAI_API_KEY');
    expect(processEnvironment()).not.toHaveProperty('ARBITRARY_SECRET');
    const result = await call({
      command: nodeCommand(
        'console.log("你好🐈");console.log(process.cwd());console.log(process.env.OPENAI_API_KEY ?? "KEY_UNSET")',
      ),
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('你好🐈');
    expect(result.content).toContain(executor.paths.root);
    expect(result.content).toContain('KEY_UNSET');
    expect(result.content).not.toContain('fake-private-env-value');
    expect(result.data).toMatchObject({
      exitCode: 0,
      cwd: '.',
      shell: process.platform === 'win32' ? 'powershell' : 'bash',
    });
  });

  it('preserves failed command output and exit code', async () => {
    const result = await call({
      command: nodeCommand('console.error("failure evidence");process.exit(7)'),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'COMMAND_FAILED' },
      data: { exitCode: 7 },
    });
    expect(result.content).toContain('failure evidence');
  });

  it('never treats accept-edits as shell authorization and denies Plan even with approval', async () => {
    for (const options of [
      { mode: 'accept-edits' as const },
      { mode: 'plan' as const, approve: async () => true },
    ]) {
      const guarded = await ToolExecutor.create(createBuiltinRegistry(), {
        root: sandbox.cwd,
        ...options,
      });
      expect(
        (
          await guarded.execute({
            callId: randomUUID(),
            name: 'Bash',
            input: { command: nodeCommand('console.log("never")') },
          })
        ).error?.code,
      ).toBe('TOOL_PERMISSION');
    }
  });

  it('bounds output without broken Unicode code points', async () => {
    const result = await call({
      command: nodeCommand('process.stdout.write("猫".repeat(100000))'),
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('TOOL_OUTPUT_LIMIT');
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.content)).toBeLessThan(33 * 1024);
    expect(result.content).not.toContain('\ufffd');
  });

  it('times out a command and proves its child process has exited', async () => {
    const marker = join(sandbox.cwd, 'timeout-child-pid');
    const script = `const cp=require('node:child_process');const fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000);`;
    const pending = call({ command: nodeCommand(script), timeoutMs: 4000 });
    await vi.waitFor(() => stat(marker), { timeout: 10_000 });
    const pid = Number(await readFile(marker, 'utf8'));
    children.push(pid);
    expect((await pending).error?.code).toBe('TOOL_TIMEOUT');
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
  });

  it('cancels a parent and proves its child process has exited', async () => {
    const marker = join(sandbox.cwd, 'child-pid');
    const script = `const cp=require('node:child_process');const fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));setInterval(()=>{},1000);`;
    const controller = new AbortController();
    const pending = call({ command: nodeCommand(script), timeoutMs: 20_000 }, controller.signal);
    await vi.waitFor(() => stat(marker), { timeout: 10_000 });
    const pid = Number(await readFile(marker, 'utf8'));
    children.push(pid);
    controller.abort();
    expect((await pending).error?.code).toBe('CANCELLED');
    await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
  }, 20_000);

  it.skipIf(process.platform !== 'win32')(
    'cleans up a child when PowerShell exits normally',
    async () => {
      const marker = join(sandbox.cwd, 'orphan-pid');
      const script = `const cp=require('node:child_process');const fs=require('node:fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true});fs.writeFileSync(${JSON.stringify(marker)},String(child.pid));child.unref();`;
      const result = await call({ command: nodeCommand(script) });
      expect(result.ok).toBe(true);
      const pid = Number(await readFile(marker, 'utf8'));
      children.push(pid);
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
    },
  );
});
