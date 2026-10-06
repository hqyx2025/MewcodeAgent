import { execFile } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { WorktreeManager } from '../../src/tools/worktrees.js';
import { createGitSandbox } from '../support/git-repo.js';
import { removeSandbox } from '../support/sandbox.js';
const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const events = (stdout: string) =>
  stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
describe('team CLI', () => {
  let box: Awaited<ReturnType<typeof createGitSandbox>>;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    box = await createGitSandbox();
    env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = box.userDirectory;
    const manager = await WorktreeManager.open(box.cwd, box.userDirectory);
    const a = await manager.create({ task: 'alice' }),
      b = await manager.create({ task: 'bob' });
    await writeFile(
      join(box.cwd, '团队.json'),
      JSON.stringify({
        name: 'fixture',
        members: [
          { id: 'alice', role: 'editor', worktree: a.id },
          { id: 'bob', role: 'reviewer', worktree: b.id },
        ],
        tasks: [
          { id: 'first', member: 'alice', goal: 'private-task-source-marker' },
          { id: 'second', member: 'bob', goal: 'offline demo', dependsOn: ['first'] },
        ],
      }),
    );
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
      { cwd: repo, env, timeout: 30_000 },
    );
  const output = (stdout: string) => JSON.parse(events(stdout).at(-1).result.content);
  const create = async () =>
    output((await cli(['teams', 'create', '--file', '团队.json', '--approve'])).stdout);
  it('requires approval, honors Plan and exposes metadata by default', async () => {
    await expect(cli(['teams', 'create', '--file', '团队.json'])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('TOOL_PERMISSION'),
    });
    await expect(
      cli(['--mode', 'plan', 'teams', 'create', '--file', '团队.json', '--approve']),
    ).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('TOOL_PERMISSION') });
    const team = await create();
    const listed = output((await cli(['teams', 'list'])).stdout);
    expect(listed[0].id).toBe(team.id);
    const metadata = (await cli(['teams', 'show', team.id])).stdout;
    expect(metadata).not.toContain('private-task-source-marker');
    expect((await cli(['teams', 'show', team.id, '--content'])).stdout).toContain(
      'private-task-source-marker',
    );
  }, 30_000);
  it('runs two dependent offline members, persists results and does not replay completed tasks', async () => {
    const team = await create();
    const result = output(
      (await cli(['--mode', 'accept-edits', 'teams', 'run', team.id, '--approve', '--json']))
        .stdout,
    );
    expect(result.team.tasks.map((task: { status: string }) => task.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(result.budget.reserved).toBe(0);
    expect(result.metrics.claims).toBe(2);
    for (const member of team.members) {
      const report = output((await cli(['worktrees', 'show', member.worktree])).stdout);
      expect(await readFile(join(report.owner.path, 'mewcode-demo.txt'), 'utf8')).toContain(
        '离线工作树隔离演示',
      );
    }
    const replay = output(
      (await cli(['--mode', 'accept-edits', 'teams', 'run', team.id, '--approve'])).stdout,
    );
    expect(replay.metrics.modelRequests).toBe(0);
    expect(replay.team.usedTokens).toBe(result.team.usedTokens);
    const report = output((await cli(['teams', 'report', team.id])).stdout);
    expect(report.overlappingPaths).toEqual([
      { path: 'mewcode-demo.txt', members: ['alice', 'bob'] },
    ]);
  }, 30_000);
  it('deduplicates explicit messages and preserves cancel/retry state', async () => {
    const team = await create();
    await writeFile(
      join(box.cwd, '消息.json'),
      JSON.stringify({
        messageId: randomUUID(),
        to: 'alice',
        task: 'first',
        text: 'delayed message',
      }),
    );
    await cli(['teams', 'send', team.id, '--file', '消息.json', '--approve']);
    await cli(['teams', 'send', team.id, '--file', '消息.json', '--approve']);
    expect(
      output((await cli(['teams', 'inbox', team.id, '--member', 'alice'])).stdout),
    ).toHaveLength(1);
    await cli(['teams', 'cancel', team.id, '--approve']);
    expect(
      output((await cli(['teams', 'show', team.id])).stdout).tasks.map(
        (task: { status: string }) => task.status,
      ),
    ).toEqual(['cancelled', 'cancelled']);
    await cli(['teams', 'retry', team.id, '--task', 'first', '--approve']);
    expect(output((await cli(['teams', 'show', team.id])).stdout).tasks[0].status).toBe('queued');
  }, 30_000);
});
