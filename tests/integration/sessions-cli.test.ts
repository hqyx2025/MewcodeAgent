import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
describe('persistent session CLI', () => {
  it('saves, lists, inspects, resumes completed tasks without calls and deletes owned session', async () => {
    const box = await createSandbox();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = box.userDirectory;
    const cli = (args: string[]) =>
      exec(
        process.execPath,
        ['--import', 'tsx', join(root, 'src/cli/index.ts'), '--cwd', box.cwd, ...args],
        { cwd: root, env, timeout: 10_000 },
      );
    try {
      expect(JSON.parse((await cli(['sessions', 'list'])).stdout)).toEqual([]);
      const run = await cli([
        '--mode',
        'plan',
        'run',
        'private-task-marker',
        '--save-session',
        '--json',
      ]);
      const events = run.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const id = events.find((event) => event.type === 'session').id as string;
      expect(events.at(-1).reason).toBe('completed');
      expect(JSON.parse((await cli(['sessions', 'list'])).stdout)).toMatchObject([
        { id, mode: 'plan' },
      ]);
      const metadata = (await cli(['sessions', 'show', id])).stdout;
      expect(metadata).not.toContain('private-task-marker');
      expect(JSON.parse(metadata)).toMatchObject({ status: 'completed', toolCalls: 1 });
      expect((await cli(['sessions', 'show', id, '--content'])).stdout).toContain(
        'private-task-marker',
      );
      expect(JSON.parse((await cli(['sessions', 'compact', id])).stdout)).toEqual({
        compacted: false,
      });
      const restored = (
        await cli(['--mode', 'accept-edits', 'run', '--resume', id, '--json'])
      ).stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(restored.find((event) => event.type === 'session').mode).toBe('plan');
      expect(restored.filter((event) => event.type === 'tool_start')).toHaveLength(0);
      expect(restored.at(-1).reason).toBe('completed');
      await cli(['sessions', 'delete', id]);
      expect(JSON.parse((await cli(['sessions', 'list'])).stdout)).toEqual([]);
      await expect(
        readFile(join(box.userDirectory, 'sessions', id, 'owner.json')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(cli(['run'])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('INVALID_PROMPT'),
      });
    } finally {
      await removeSandbox(box.root);
    }
  }, 20_000);
  it('uses saved results after stopped round and closes session locks on setup failure', async () => {
    const box = await createSandbox();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = box.userDirectory;
    const cli = (args: string[]) =>
      exec(
        process.execPath,
        ['--import', 'tsx', join(root, 'src/cli/index.ts'), '--cwd', box.cwd, ...args],
        { cwd: root, env, timeout: 10_000 },
      );
    try {
      const stopped = (await cli([
        '--mode',
        'plan',
        'run',
        'inspect',
        '--save-session',
        '--max-turns',
        '1',
        '--json',
      ]).catch((error: unknown) => error)) as { stdout: string; code: number };
      expect(stopped.code).toBe(1);
      const id = stopped.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .find((event) => event.type === 'session').id as string;
      const resumed = (
        await cli(['--mode', 'plan', 'run', '--resume', id, '--max-turns', '3', '--json'])
      ).stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(resumed.filter((event) => event.type === 'tool_start')).toHaveLength(0);
      expect(resumed.at(-1).reason).toBe('completed');
      await writeFile(join(box.cwd, 'existing-audit'), 'keep');
      await expect(
        cli(['run', '--resume', id, '--audit-file', 'existing-audit']),
      ).rejects.toMatchObject({ code: 1 });
      expect((await cli(['run', '--resume', id, '--json'])).stdout).toContain('completed');
      await expect(cli(['sessions', 'show', '../user-file'])).rejects.toMatchObject({ code: 1 });
    } finally {
      await removeSandbox(box.root);
    }
  }, 20_000);
});
