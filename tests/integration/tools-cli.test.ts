import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = join(root, 'src/cli/index.ts');

describe('explicit tool CLI', () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>>;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    sandbox = await createSandbox();
    env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = sandbox.userDirectory;
  });
  afterEach(async () => {
    await removeSandbox(sandbox.root);
  });
  const cli = (args: string[]) =>
    exec(process.execPath, ['--import', 'tsx', entry, '--cwd', sandbox.cwd, ...args], {
      cwd: root,
      env,
      timeout: 10_000,
    });

  it('lists definitions without resolving configured model credentials', async () => {
    env.MEWCODE_MODE = 'invalid';
    const result = await cli(['tools']);
    const definitions = JSON.parse(result.stdout) as { name: string }[];
    expect(definitions.map((tool) => tool.name)).toEqual([
      'ReadFile',
      'WriteFile',
      'EditFile',
      'Glob',
      'Grep',
      'Bash',
    ]);
    expect(result.stderr).toBe('');
  });

  it('reads safely escaped JSON output and defaults mutations to denial', async () => {
    await writeFile(join(sandbox.cwd, 'read.txt'), '你好🐈\u001b[31m');
    const read = await cli(['tool', 'ReadFile', '--input', JSON.stringify({ path: 'read.txt' })]);
    expect(JSON.parse(read.stdout)).toMatchObject({ ok: true, content: '1: 你好🐈\u001b[31m' });
    expect(read.stdout).not.toContain('\u001b');
    const error = await cli([
      'tool',
      'WriteFile',
      '--input',
      JSON.stringify({ path: 'denied.txt', content: 'never' }),
    ]).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: 1 });
    expect(JSON.parse((error as { stdout: string }).stdout).error.code).toBe('TOOL_PERMISSION');
  });

  it('loads an input file and scopes explicit approval to one operation', async () => {
    await writeFile(
      join(sandbox.cwd, 'input.json'),
      JSON.stringify({ path: 'new.txt', content: 'created 🐈' }),
    );
    const created = await cli(['tool', 'WriteFile', '--input-file', 'input.json', '--approve']);
    expect(JSON.parse(created.stdout).ok).toBe(true);
    expect(created.stderr).toContain('--approve');
    expect(await readFile(join(sandbox.cwd, 'new.txt'), 'utf8')).toBe('created 🐈');
    await expect(
      cli([
        '--mode',
        'plan',
        'tool',
        'WriteFile',
        '--input',
        JSON.stringify({ path: 'other.txt', content: 'never' }),
        '--approve',
      ]),
    ).rejects.toMatchObject({ code: 1 });
  });

  it('rejects malformed/oversized inputs without echoing input secrets', async () => {
    for (const args of [
      ['tool', 'ReadFile', '--input', 'secret-source-invalid-json'],
      ['tool', 'ReadFile'],
      ['tool', 'ReadFile', '--input', '{}', '--input-file', 'input.json'],
    ]) {
      const error = await cli(args).catch((failure: unknown) => failure);
      expect(error).toMatchObject({ code: 1 });
      expect((error as { stderr: string }).stderr).not.toContain('secret-source-invalid-json');
    }
    await writeFile(join(sandbox.cwd, 'huge.json'), 'x'.repeat(256 * 1024 + 1));
    await expect(cli(['tool', 'ReadFile', '--input-file', 'huge.json'])).rejects.toMatchObject({
      code: 1,
    });
  });

  it.skipIf(process.platform !== 'win32')(
    'requires an explicit executable for Windows Bash',
    async () => {
      await expect(
        cli([
          'tool',
          'Bash',
          '--input',
          JSON.stringify({ command: 'echo never' }),
          '--shell',
          'bash',
          '--approve',
        ]),
      ).rejects.toMatchObject({ code: 1 });
    },
  );
});
