import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
describe('confirmed memory CLI', () => {
  it('reviews candidates without persisting, accepts with source, edits and deletes; respects nonTTY, Plan and deny', async () => {
    const box = await createSandbox();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = box.userDirectory;
    const cli = (args: string[], cwd = box.cwd) =>
      exec(
        process.execPath,
        ['--import', 'tsx', join(repo, 'src/cli/index.ts'), '--cwd', cwd, ...args],
        { cwd: repo, env, timeout: 15000 },
      );
    try {
      expect(JSON.parse((await cli(['memory', 'list'])).stdout)).toMatchObject({
        revision: null,
        entries: [],
      });
      const saved = (
        await cli([
          '--mode',
          'plan',
          'run',
          '用户偏好：回答使用中文\n项目约定：使用npm test\n已验证事实：缓存使用Redis',
          '--save-session',
          '--json',
        ])
      ).stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const session = saved.find((event) => event.type === 'session').id as string;
      const reviewed = JSON.parse((await cli(['memory', 'candidates', session])).stdout);
      expect(reviewed.candidates).toHaveLength(3);
      expect(JSON.parse((await cli(['memory', 'list'])).stdout).entries).toEqual([]);
      await expect(
        cli(['memory', 'accept', session, '--candidate', reviewed.candidates[0].id]),
      ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('TOOL_PERMISSION') });
      await expect(
        cli([
          '--mode',
          'plan',
          'memory',
          'accept',
          session,
          '--candidate',
          reviewed.candidates[0].id,
          '--approve',
        ]),
      ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('TOOL_PERMISSION') });
      const accepted = JSON.parse(
        (
          await cli([
            'memory',
            'accept',
            session,
            '--candidate',
            reviewed.candidates[0].id,
            '--approve',
            '--audit-file',
            'memory-audit.jsonl',
          ])
        ).stdout,
      );
      const id = accepted.data.entry.id as string;
      expect(accepted.data.entry).toMatchObject({
        source: { type: 'session', sessionId: session, checkpoint: reviewed.checkpoint },
        confirmed: true,
      });
      const audit = await readFile(join(box.cwd, 'memory-audit.jsonl'), 'utf8');
      expect(audit).not.toContain('回答使用中文');
      expect(audit).toContain('MemoryUpdate');
      const prompt = (await cli(['prompt', '--json'])).stdout;
      expect(JSON.parse(prompt).memory).toMatchObject({ selected: 1 });
      expect(prompt).not.toContain('回答使用中文');
      await cli(['memory', 'edit', id, '--text', '回答使用简体中文', '--approve']);
      expect(JSON.parse((await cli(['memory', 'show', id])).stdout).entries[0].text).toBe(
        '回答使用简体中文',
      );
      const duplicate = JSON.parse(
        (await cli(['memory', 'add', '--text', '回答使用简体中文', '--approve'])).stdout,
      );
      expect(duplicate.data.duplicate).toBe(true);
      await cli(['memory', 'delete', id, '--approve']);
      expect(JSON.parse((await cli(['prompt', '--json'])).stdout).memory.selected).toBe(0);
      const other = join(box.root, 'other-project');
      await mkdir(other);
      await expect(cli(['memory', 'candidates', session], other)).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('SESSION_INVALID'),
      });
      await writeFile(
        join(box.projectDirectory, 'config.yaml'),
        'permissions:\n  rules:\n    - tool: MemoryUpdate\n      decision: deny\n',
      );
      await expect(cli(['memory', 'add', '--text', 'blocked', '--approve'])).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('TOOL_PERMISSION'),
      });
      await expect(
        cli(['memory', 'add', '--text', 'password: never-save', '--approve']),
      ).rejects.toMatchObject({ code: 1 });
      await expect(cli(['memory', 'delete', '../foreign', '--approve'])).rejects.toMatchObject({
        code: 1,
      });
      await cli(['sessions', 'delete', session]);
    } finally {
      await removeSandbox(box.root);
    }
  }, 30000);
  it('protects a custom user directory inside the project and honors memory disable', async () => {
    const box = await createSandbox();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = join(box.cwd, '用户偏好');
    const cli = (args: string[]) =>
      exec(
        process.execPath,
        ['--import', 'tsx', join(repo, 'src/cli/index.ts'), '--cwd', box.cwd, ...args],
        { cwd: repo, env, timeout: 15000 },
      );
    try {
      await cli([
        'memory',
        'add',
        '--scope',
        'user',
        '--text',
        'global-private-marker',
        '--approve',
      ]);
      const prompt = (await cli(['prompt', '--json'])).stdout;
      expect(JSON.parse(prompt).memory.selected).toBe(1);
      expect(prompt).not.toContain('global-private-marker');
      await expect(
        cli(['tool', 'ReadFile', '--input', JSON.stringify({ path: '用户偏好/memory.md' })]),
      ).rejects.toMatchObject({ code: 1 });
      await expect(
        cli([
          '--mode',
          'accept-edits',
          'tool',
          'WriteFile',
          '--input',
          JSON.stringify({ path: '用户偏好/memory.md', content: 'overwrite' }),
        ]),
      ).rejects.toMatchObject({ code: 1 });
      env.MEWCODE_MEMORY = 'false';
      expect(JSON.parse((await cli(['prompt', '--json'])).stdout).memory.selected).toBe(0);
    } finally {
      await removeSandbox(box.root);
    }
  }, 20000);
});
