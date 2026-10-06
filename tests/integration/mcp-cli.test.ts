import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dump } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = join(root, 'src/cli/index.ts');

describe('MCP CLI', () => {
  it('static viewing is inert, startup/call approvals are separate, Plan and nonTTY deny', async () => {
    const sandbox = await createSandbox();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = sandbox.userDirectory;
    const cli = (args: string[]) =>
      exec(process.execPath, ['--import', 'tsx', entry, '--cwd', sandbox.cwd, ...args], {
        cwd: root,
        env,
        timeout: 20_000,
      });
    try {
      await writeFile(
        join(sandbox.projectDirectory, 'config.yaml'),
        dump({
          mcp: {
            servers: {
              local: {
                transport: 'stdio',
                command: process.execPath,
                args: [
                  join(root, 'tests/support/mcp-server.mjs'),
                  'children',
                  join(sandbox.cwd, 'pids.json'),
                ],
                cwd: '.',
              },
            },
          },
        }),
      );
      expect(JSON.parse((await cli(['mcp', 'list'])).stdout).local.transport).toBe('stdio');
      expect(
        JSON.parse((await cli(['config', '--json'])).stdout).settings.mcp.servers.local.transport,
      ).toBe('stdio');
      await expect(readFile(join(sandbox.cwd, 'pids.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const denied = (await cli(['mcp', 'discover', 'local']).catch((error: unknown) => error)) as {
        stdout: string;
        code: number;
      };
      expect(denied.code).toBe(1);
      expect(JSON.parse(denied.stdout).error.code).toBe('TOOL_PERMISSION');
      await expect(readFile(join(sandbox.cwd, 'pids.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      const plan = (await cli([
        '--mode',
        'plan',
        'mcp',
        'discover',
        'local',
        '--approve-start',
      ]).catch((error: unknown) => error)) as { stdout: string; code: number };
      expect(plan.code).toBe(1);
      expect(JSON.parse(plan.stdout).error.code).toBe('TOOL_PERMISSION');
      const catalog = JSON.parse(
        (await cli(['mcp', 'discover', 'local', '--approve-start'])).stdout,
      );
      expect(catalog).toHaveLength(2);
      const callDenied = (await cli([
        'mcp',
        'call',
        'local',
        'echo',
        '--approve-start',
        '--input',
        JSON.stringify({ text: 'hello' }),
      ]).catch((error: unknown) => error)) as { stdout: string; code: number };
      expect(callDenied.code).toBe(1);
      expect(JSON.parse(callDenied.stdout).error.code).toBe('TOOL_PERMISSION');
      const called = JSON.parse(
        (
          await cli([
            'mcp',
            'call',
            'local',
            'echo',
            '--approve-start',
            '--approve',
            '--input',
            JSON.stringify({ text: 'hello' }),
          ])
        ).stdout,
      );
      expect(called.ok).toBe(true);
      expect(called.content).toBe('hello');
      const agent = await cli(['run', 'inspect', '--json']);
      expect(JSON.parse(agent.stdout.trim().split('\n').at(-1)!).reason).toBe('completed');
    } finally {
      await removeSandbox(sandbox.root);
    }
  }, 30_000);
});
