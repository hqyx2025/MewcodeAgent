import { execFile } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
import { respond } from '../support/hooks.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
describe('hook CLI and audit visibility', () => {
  it('lists without activation, refuses noninteractive scripts, and applies explicitly approved hooks with private JSONL audit', async () => {
    const box = await createSandbox();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = box.userDirectory;
    const cli = (args: string[]) =>
      exec(
        process.execPath,
        ['--import', 'tsx', join(repo, 'src/cli/index.ts'), '--cwd', box.cwd, ...args],
        { cwd: repo, env, timeout: 10000 },
      );
    try {
      await writeFile(join(box.cwd, 'read.txt'), 'original');
      await writeFile(join(box.cwd, 'changed.txt'), 'rewritten');
      await writeFile(
        join(box.cwd, 'guard.mjs'),
        `import{writeFileSync}from'node:fs';writeFileSync('activated.txt','yes');${respond({ decision: 'continue', updatedInput: { path: 'changed.txt' } })}`,
      );
      await writeFile(
        join(box.projectDirectory, 'config.yaml'),
        'hooks:\n  - id: guard\n    event: PreToolUse\n    script: guard.mjs\n    tool: ReadFile\n',
      );
      expect(JSON.parse((await cli(['hooks'])).stdout).hooks[0].id).toBe('guard');
      await cli(['prompt', '--json']);
      await cli(['chat', 'plain question']);
      await expect(stat(join(box.cwd, 'activated.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      const refused = (await cli(['tool', 'ReadFile', '--input', '{"path":"read.txt"}']).catch(
        (error: unknown) => error,
      )) as { stdout: string; code: number };
      expect(refused.code).toBe(1);
      expect(JSON.parse(refused.stdout)).toMatchObject({
        ok: false,
        error: { code: 'TOOL_PERMISSION' },
      });
      const approved = JSON.parse(
        (
          await cli([
            'tool',
            'ReadFile',
            '--approve',
            '--audit-file',
            'hooks-audit.jsonl',
            '--input',
            '{"path":"read.txt"}',
          ])
        ).stdout,
      );
      expect(approved).toMatchObject({ ok: true, content: '1: rewritten' });
      expect(approved.hooks).toHaveLength(1);
      const log = await readFile(join(box.cwd, 'hooks-audit.jsonl'), 'utf8');
      expect(log).not.toContain('rewritten');
      expect(log).not.toContain('activated.txt');
      const rows = log
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(rows.map((row) => row.event ?? row.name)).toEqual([
        'HookScript',
        'PreToolUse',
        'ReadFile',
      ]);
    } finally {
      await removeSandbox(box.root);
    }
  });
  it('emits structured lifecycle failure diagnostics with no model or script-output exposure', async () => {
    const box = await createSandbox();
    try {
      await writeFile(
        join(box.projectDirectory, 'config.yaml'),
        'hooks:\n  - id: start\n    event: SessionStart\n    script: guard.mjs\n',
      );
      await writeFile(join(box.cwd, 'guard.mjs'), respond({ decision: 'continue' }));
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('MEWCODE_')),
      );
      env.MEWCODE_HOME = box.userDirectory;
      const failed = (await exec(
        process.execPath,
        [
          '--import',
          'tsx',
          join(repo, 'src/cli/index.ts'),
          '--cwd',
          box.cwd,
          'run',
          'task',
          '--json',
        ],
        { cwd: repo, env, timeout: 10000 },
      ).catch((error: unknown) => error)) as { stdout: string; stderr: string; code: number };
      expect(failed.code).toBe(1);
      const rows = failed.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        rows.some(
          (row) =>
            row.type === 'hook' &&
            row.record.event === 'SessionStart' &&
            row.record.outcome === 'error',
        ),
      ).toBe(true);
      expect(rows.some((row) => row.type === 'turn_start' || row.type === 'finish')).toBe(false);
      expect(failed.stderr).toContain('HOOK_FAILED');
    } finally {
      await removeSandbox(box.root);
    }
  });
});
