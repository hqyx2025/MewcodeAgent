import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
describe('Slash Command CLI', () => {
  it('runs local commands with no key, expands templates as data and hands Plan/resume to Agent', async () => {
    const box = await createSandbox();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = box.userDirectory;
    delete env.OPENAI_API_KEY;
    const cli = (args: string[]) =>
      exec(
        process.execPath,
        ['--import', 'tsx', join(root, 'src/cli/index.ts'), '--cwd', box.cwd, ...args],
        { cwd: root, env, timeout: 10000 },
      );
    try {
      const remote = [
        '--provider',
        'openai-compatible',
        '--model',
        'fixture-model',
        '--base-url',
        'http://127.0.0.1:1/v1',
      ];
      expect((await cli([...remote, 'chat', '/help'])).stdout).toContain('/compact');
      expect((await cli([...remote, 'commands', 'model'])).stdout).toContain('[builtin; local]');
      expect((await cli([...remote, 'run', '/model different-model'])).stdout).toContain(
        'different-model',
      );
      expect((await cli([...remote, 'chat', '/clear'])).stdout).toContain('已清空');
      await expect(cli(['--mode', 'plan', 'chat', '/plan off'])).rejects.toMatchObject({
        stderr: expect.stringContaining('权限上限'),
      });
      await expect(cli(['run', '/clear'])).rejects.toMatchObject({
        stderr: expect.stringContaining('COMMAND_INVALID'),
      });
      await expect(cli(['chat', '/resume'])).rejects.toMatchObject({
        stderr: expect.stringContaining('COMMAND_INVALID'),
      });
      await expect(cli(['chat', '/unknown sensitive-source-marker'])).rejects.toMatchObject({
        stderr: expect.not.stringContaining('sensitive-source-marker'),
      });
      await mkdir(join(box.projectDirectory, 'commands'));
      await writeFile(
        join(box.projectDirectory, 'commands', 'review.md'),
        'Review $1; raw=$ARGUMENTS',
      );
      expect((await cli(['chat', '/review "中文 文件.ts" $(whoami)'])).stdout).toContain(
        'Review 中文 文件.ts; raw="中文 文件.ts" $(whoami)',
      );
      await writeFile(
        join(box.projectDirectory, 'commands', 'literal.md'),
        '/permissions accept-edits',
      );
      expect((await cli(['chat', '/literal'])).stdout).toContain(
        '已收到任务：“/permissions accept-edits”',
      );
      await expect(
        cli(['--mode', 'plan', 'run', '/review source', '--json']),
      ).resolves.toMatchObject({ stdout: expect.stringContaining('tool_result') });
      const planned = (await cli(['run', '/plan 查看项目', '--save-session', '--json'])).stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const id = planned.find((event) => event.type === 'session').id as string;
      expect(planned.find((event) => event.type === 'session').mode).toBe('plan');
      const restored = (await cli(['run', `/resume ${id}`, '--json'])).stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(restored.find((event) => event.type === 'session').mode).toBe('plan');
      expect(restored.filter((event) => event.type === 'tool_start')).toEqual([]);
      expect(restored.at(-1).reason).toBe('completed');
      expect((await cli(['chat', `/resume ${id}`])).stderr).toContain('恢复');
    } finally {
      await removeSandbox(box.root);
    }
  });
});
