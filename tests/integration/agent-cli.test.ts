import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chunk, modelServer, sse } from '../support/model-server.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
describe('Agent CLI', () => {
  let box: Awaited<ReturnType<typeof createSandbox>>;
  let server: Awaited<ReturnType<typeof modelServer>> | undefined;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    box = await createSandbox();
    env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = box.userDirectory;
    env.MEW_TEST_API_KEY = 'fake-cli-key';
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    await removeSandbox(box.root);
  });
  const cli = (args: string[]) =>
    exec(
      process.execPath,
      ['--import', 'tsx', join(repo, 'src/cli/index.ts'), '--cwd', box.cwd, ...args],
      { cwd: repo, env, timeout: 10_000 },
    );
  async function configure() {
    await writeFile(
      join(box.projectDirectory, 'config.yaml'),
      `provider:\n  kind: openai-compatible\n  model: cli-model\n  baseUrl: ${server!.url}\n  apiKeyEnv: MEW_TEST_API_KEY\n`,
    );
  }
  it('runs an offline read loop with parseable JSONL, clean stdout and no heavy UI', async () => {
    await writeFile(join(box.cwd, 'entry.txt'), 'fixture');
    const result = await cli([
      '--provider',
      'mock',
      '--model',
      'mock-v1',
      '--mode',
      'plan',
      'run',
      '查看目录',
      '--json',
    ]);
    const events = result.stdout
      .trim()
      .split('\n')
      .map(
        (line) => JSON.parse(line) as { type: string; reason?: string; result?: { ok: boolean } },
      );
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'completed' });
    expect(events.find((e) => e.type === 'tool_result')?.result?.ok).toBe(true);
    expect(result.stderr).toBe('');
  });

  it('inspects prompt metadata without model credentials or leaking project text', async () => {
    await writeFile(
      join(box.projectDirectory, 'config.yaml'),
      'provider:\n  kind: anthropic\n  model: fixture-model\n  apiKeyEnv: MEW_TEST_API_KEY\n',
    );
    await writeFile(join(box.cwd, 'AGENTS.md'), `private-guidance-marker ${env.MEW_TEST_API_KEY}`);
    const result = await cli(['--mode', 'plan', 'prompt', '--json']);
    const metadata = JSON.parse(result.stdout) as {
      version: string;
      environment: { tools: { name: string }[] };
      sources: { path: string; redacted: boolean }[];
      warnings: { code: string }[];
    };
    expect(metadata.version).toBe('m05-v1');
    expect(metadata.environment.tools.map((t) => t.name)).toEqual(['ReadFile', 'Glob', 'Grep']);
    expect(metadata.sources).toMatchObject([{ path: 'AGENTS.md', redacted: true }]);
    expect(metadata.warnings).toMatchObject([{ code: 'REDACTED' }]);
    expect(result.stdout + result.stderr).not.toContain('private-guidance-marker');
    expect(result.stdout + result.stderr).not.toContain(env.MEW_TEST_API_KEY);
    delete env.MEW_TEST_API_KEY;
    expect((await cli(['prompt'])).stdout).toContain('AGENTS.md');
  });
  it.each(['write', 'shell'])('refuses non-TTY %s approvals through the executor', async (kind) => {
    server = await modelServer((res, _record, count) =>
      sse(res, [
        {
          ...chunk(''),
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: `call-${count}`,
                    type: 'function',
                    function: {
                      name: kind === 'write' ? 'WriteFile' : 'Bash',
                      arguments: JSON.stringify(
                        kind === 'write'
                          ? { path: 'denied.txt', content: 'no' }
                          : { command: 'echo not-authorized' },
                      ),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
    );
    await configure();
    const result = (await cli([
      '--mode',
      kind === 'shell' ? 'accept-edits' : 'default',
      'run',
      '执行操作',
      '--json',
    ]).catch((error: unknown) => error)) as { code: number; stdout: string; stderr: string };
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('非交互终端');
    const events = result.stdout
      .trim()
      .split('\n')
      .map(
        (line) =>
          JSON.parse(line) as {
            type: string;
            reason?: string;
            result?: { error?: { code: string } };
          },
      );
    expect(
      events
        .filter((e) => e.type === 'tool_result')
        .every((e) => e.result?.error?.code === 'TOOL_PERMISSION'),
    ).toBe(true);
    expect(events.at(-1)?.reason).toBe('repeated_failures');
    await expect(readFile(join(box.cwd, 'denied.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(result.stdout + result.stderr).not.toContain('fake-cli-key');
  });
  it('allows file creation in accept-edits without granting shell permission', async () => {
    server = await modelServer((res, _record, count) =>
      count === 1
        ? sse(res, [
            {
              ...chunk(''),
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'write',
                        type: 'function',
                        function: {
                          name: 'WriteFile',
                          arguments: JSON.stringify({ path: 'created.txt', content: 'saved' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            },
          ])
        : sse(res, [chunk('已创建'), chunk('', 'stop')]),
    );
    await configure();
    const result = await cli(['--mode', 'accept-edits', 'run', '创建文件']);
    expect(await readFile(join(box.cwd, 'created.txt'), 'utf8')).toBe('saved');
    expect(result.stderr).toContain('WriteFile：成功');
    expect(result.stdout).toContain('已创建');
  });
  it('rejects invalid budgets and returns a nonzero status for round exhaustion', async () => {
    await expect(cli(['run', '任务', '--max-turns', '0'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('CONFIG_INVALID'),
    });
    const result = (await cli(['run', '任务', '--max-turns', '1', '--json']).catch(
      (error: unknown) => error,
    )) as { code: number; stdout: string };
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toMatchObject({
      reason: 'max_turns',
      toolCalls: 1,
    });
  });
});
