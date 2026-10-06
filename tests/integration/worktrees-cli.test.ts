import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitSandbox } from '../support/git-repo.js';
import { removeSandbox } from '../support/sandbox.js';
import { SessionStore } from '../../src/core/session.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const events = (stdout: string) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
describe('owned worktree CLI', () => {
  let box: Awaited<ReturnType<typeof createGitSandbox>>;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    box = await createGitSandbox();
    env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = box.userDirectory;
  });
  afterEach(async () => {
    await removeSandbox(box.root);
  });
  const cli = (args: string[]) =>
    exec(
      process.execPath,
      [
        '--import',
        'tsx',
        join(repo, 'src/cli/index.ts'),
        '--cwd',
        box.cwd,
        '--provider',
        'mock',
        '--model',
        'mock-v1',
        ...args,
      ],
      { cwd: repo, env, timeout: 20_000 },
    );
  const create = async (task: string) =>
    JSON.parse(
      events((await cli(['worktrees', 'create', '--task', task, '--approve'])).stdout).at(-1).result
        .content,
    ) as { id: string; path: string; branch: string };
  it('requires shell approval, honors Plan, and manages clean owned worktrees', async () => {
    await expect(cli(['worktrees', 'create', '--task', 'one'])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('TOOL_PERMISSION'),
    });
    await expect(
      cli(['--mode', 'plan', 'worktrees', 'create', '--task', 'one', '--approve']),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('TOOL_PERMISSION') });
    const a = await create('one');
    const listed = events((await cli(['worktrees', 'list'])).stdout).at(-1);
    expect(JSON.parse(listed.result.content)).toMatchObject([{ id: a.id, status: 'ready' }]);
    const shown = JSON.parse(
      events((await cli(['worktrees', 'show', a.id])).stdout).at(-1).result.content,
    );
    expect(shown).toMatchObject({ head: box.base, dirty: false, owner: { branch: a.branch } });
    await cli(['worktrees', 'reuse', a.id, '--approve']);
    await cli(['worktrees', 'remove', a.id, '--approve']);
    expect((await box.git(['show-ref', '--verify', `refs/heads/${a.branch}`])).stdout).toContain(
      a.branch,
    );
  }, 30_000);
  it('delegates two offline writes with separate bindings and preserves dirty deliveries', async () => {
    const a = await create('one'),
      b = await create('two');
    await writeFile(
      join(box.cwd, '写入任务.json'),
      JSON.stringify({
        tasks: [
          { id: 'one', worktree: a.id, goal: '演示' },
          { id: 'two', worktree: b.id, goal: '演示' },
        ],
      }),
    );
    const output = events(
      (
        await cli([
          '--mode',
          'accept-edits',
          'worktrees',
          'delegate',
          '--tasks-file',
          '写入任务.json',
          '--approve',
          '--json',
        ])
      ).stdout,
    );
    const delegated = JSON.parse(output.at(-1).result.content).tasks;
    expect(delegated.map((task: { status: string }) => task.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(delegated.map((task: { worktreeId: string }) => task.worktreeId)).toEqual([a.id, b.id]);
    expect(new Set(delegated.map((task: { agentId: string }) => task.agentId)).size).toBe(2);
    expect(output.at(-1).budget.reserved).toBe(0);
    for (const item of [a, b]) {
      expect(await readFile(join(item.path, 'mewcode-demo.txt'), 'utf8')).toContain(
        '离线工作树隔离演示',
      );
      const report = JSON.parse(
        events((await cli(['worktrees', 'diff', item.id])).stdout).at(-1).result.content,
      ).report;
      expect(report).toMatchObject({
        dirty: true,
        untracked: ['mewcode-demo.txt'],
        owner: { status: 'completed', checks: [] },
      });
      await expect(cli(['worktrees', 'remove', item.id, '--approve'])).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('WORKTREE_DIRTY'),
      });
    }
    await expect(readFile(join(box.cwd, 'mewcode-demo.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }, 30_000);
  it('keeps management opt-in for run and rejects denied/malformed task input without source leakage', async () => {
    const before = events((await cli(['--mode', 'plan', 'run', '检查目录', '--json'])).stdout);
    const after = events(
      (
        await cli([
          '--mode',
          'default',
          'run',
          '检查目录',
          '--worktrees',
          '--json',
          '--save-session',
        ])
      ).stdout,
    );
    const tools = (items: ReturnType<typeof events>) =>
      items
        .find((event) => event.type === 'prompt_info')
        .manifest.environment.tools.map((tool: { name: string }) => tool.name);
    expect(tools(before)).not.toContain('WorktreeTask');
    expect(tools(after)).toContain('WorktreeTask');
    expect(tools(after)).toContain('WorktreeCreate');
    const session = after.find((event) => event.type === 'session').id;
    const { state } = await SessionStore.inspect(box.userDirectory, session);
    expect(state.worktreeTaskIds).toEqual([]);
    await writeFile(join(box.cwd, 'bad.json'), '{"private-source-marker":');
    await expect(
      cli(['worktrees', 'delegate', '--tasks-file', 'bad.json', '--approve']),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('SUBAGENT_INVALID') });
    await writeFile(
      join(box.projectDirectory, 'config.yaml'),
      'permissions:\n  rules:\n    - decision: deny\n      tool: ReadFile\n      path: bad.json\n',
    );
    try {
      await cli(['worktrees', 'delegate', '--tasks-file', 'bad.json', '--approve']);
      throw new Error('should reject');
    } catch (error) {
      expect((error as { stderr: string }).stderr).not.toContain('private-source-marker');
    }
  }, 30_000);
});
