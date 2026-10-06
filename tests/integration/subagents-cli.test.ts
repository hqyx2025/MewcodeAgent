import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
describe('SubAgent CLI', () => {
  let box: Awaited<ReturnType<typeof createSandbox>>;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    box = await createSandbox();
    env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = box.userDirectory;
    await writeFile(join(box.cwd, 'entry.txt'), 'entry');
    await writeFile(
      join(box.cwd, '任务.json'),
      JSON.stringify({
        tasks: [
          { id: 'one', goal: '列出目录' },
          { id: 'two', goal: '另一项目录检查' },
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
      { cwd: repo, env, timeout: 10_000 },
    );
  it('requires opt-in and exposes only metadata during prompt inspection', async () => {
    const before = JSON.parse((await cli(['prompt', '--json'])).stdout);
    expect(before.environment.tools.some((tool: { name: string }) => tool.name === 'Task')).toBe(
      false,
    );
    await writeFile(join(box.projectDirectory, 'config.yaml'), 'subagents:\n  enabled: true\n');
    const project = JSON.parse((await cli(['config', '--json'])).stdout);
    expect(project.settings.subagents.enabled).toBe(false);
    const after = JSON.parse((await cli(['--subagents', 'prompt', '--json'])).stdout);
    expect(after.environment.tools.some((tool: { name: string }) => tool.name === 'Task')).toBe(
      true,
    );
    expect(after.sources).toEqual([]);
  });
  it('executes explicit tasks offline and emits JSONL with separate agent IDs', async () => {
    const output = await cli(['delegate', '--tasks-file', '任务.json', '--json']);
    const events = output.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.at(-1).type).toBe('delegation');
    const results = JSON.parse(events.at(-1).result.content).tasks;
    expect(results.map((item: { status: string }) => item.status)).toEqual([
      'completed',
      'completed',
    ]);
    expect(new Set(results.map((item: { agentId: string }) => item.agentId)).size).toBe(2);
    expect(
      events
        .filter((item) => item.type === 'subagent')
        .every((item) => item.sequence > 0 && item.parentAgentId),
    ).toBe(true);
    expect(events.at(-1).budget.reserved).toBe(0);
    expect(output.stderr).toBe('');
  });
  it('integrates parent Task results and checkpoints with shared usage', async () => {
    const output = await cli([
      '--subagents',
      '--mode',
      'plan',
      'run',
      '检查目录',
      '--json',
      '--save-session',
    ]);
    const events = output.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'completed', estimated: true });
    expect(events.some((event) => event.type === 'subagent' && event.state === 'completed')).toBe(
      true,
    );
    const task = events.find(
      (event) => event.type === 'tool_result' && event.result.name === 'Task',
    );
    expect(JSON.parse(task.result.content).tasks[0].status).toBe('completed');
    const id = events.find((event) => event.type === 'session').id;
    const session = JSON.parse((await cli(['sessions', 'show', id, '--content'])).stdout);
    expect(JSON.stringify(session)).toContain('mock-directory');
    const resumed = await cli(['--subagents', '--mode', 'plan', 'run', '--resume', id, '--json']);
    expect(resumed.stdout).not.toContain('"type":"subagent"');
  });
  it('rejects invalid, oversized, denied and credential task files without echoing source', async () => {
    for (const [text, args] of [
      ['{"private-source-marker":', []],
      ['private-source-marker'.repeat(3000), []],
      [JSON.stringify({ tasks: [{ id: 'bad', goal: 'x', tools: ['WriteFile'] }] }), []],
    ] as const) {
      await writeFile(join(box.cwd, '任务.json'), text);
      try {
        await cli(['delegate', '--tasks-file', '任务.json', ...args]);
        throw new Error('should fail');
      } catch (error) {
        expect((error as { stderr: string }).stderr).not.toContain('private-source-marker');
        expect((error as { code: number }).code).toBe(1);
      }
    }
    await writeFile(
      join(box.projectDirectory, 'config.yaml'),
      'permissions:\n  rules:\n    - decision: deny\n      tool: ReadFile\n      path: 任务.json\n',
    );
    await expect(cli(['delegate', '--tasks-file', '任务.json'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('SUBAGENT_INVALID'),
    });
  });
});
