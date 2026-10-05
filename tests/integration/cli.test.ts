import { execFile, spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import metadata from '../../package.json' with { type: 'json' };
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = join(root, 'src', 'cli', 'index.ts');

describe('CLI process behavior', () => {
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
    exec(process.execPath, ['--import', 'tsx', entry, ...args], {
      cwd: root,
      env,
      timeout: 10_000,
    });

  it('shows help and version without loading bad configuration', async () => {
    env.MEWCODE_MODE = 'invalid';
    expect((await cli(['--cwd', 'missing-directory', '--help'])).stdout).toContain(
      'Usage: mewcode',
    );
    expect((await cli(['--version'])).stdout.trim()).toBe(metadata.version);
  });

  it('shows help when no subcommand is supplied', async () => {
    expect((await cli([])).stdout).toContain('demo');
  });

  it('prints valid configuration JSON but never resolves secret environment values', async () => {
    env.CUSTOM_TOKEN = 'integration-secret-never-print';
    const result = await cli([
      '--cwd',
      sandbox.cwd,
      '--api-key-env',
      'CUSTOM_TOKEN',
      '--model',
      'cli-model',
      'config',
      '--json',
    ]);
    const loaded = JSON.parse(result.stdout) as {
      settings: { provider: { model: string; apiKeyEnv: string } };
      cwd: string;
    };
    expect(loaded.settings.provider).toMatchObject({
      model: 'cli-model',
      apiKeyEnv: 'CUSTOM_TOKEN',
    });
    expect(loaded.cwd).toContain('中文 项目');
    expect(result.stdout + result.stderr).not.toContain(env.CUSTOM_TOKEN);
  });

  it('runs offline even when a real provider is configured and no key exists', async () => {
    const result = await cli([
      '--cwd',
      sandbox.cwd,
      '--provider',
      'anthropic',
      '--model',
      'configured-model',
      'demo',
      '检查 中文输出 🐈',
    ]);
    expect(result.stdout).toContain('MockProvider');
    expect(result.stdout).toContain('检查 中文输出 🐈');
    expect(result.stdout).toContain('M02');
    expect(result.stderr).toBe('');
  });

  it('returns exit code one for unknown options', async () => {
    await expect(cli(['--not-a-real-option'])).rejects.toMatchObject({ code: 1 });
  });

  it('supports one-shot chat without credentials using the selected Mock provider', async () => {
    const result = await cli(['--cwd', sandbox.cwd, 'chat', '一次对话 🐈']);
    expect(result.stdout).toContain('一次对话 🐈');
    expect(result.stdout).not.toContain('Usage:');
    expect(result.stderr).toBe('');
  });

  it('fails before networking when a configured provider key is absent', async () => {
    delete env.OPENAI_API_KEY;
    await expect(
      cli([
        '--cwd',
        sandbox.cwd,
        '--provider',
        'openai-compatible',
        '--model',
        'gpt-5.5',
        'chat',
        '问题',
      ]),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('MODEL_MISSING_KEY') });
  });

  it.each([
    ['管道输入中文 🐈\n', 0],
    ['   \n', 1],
    ['字'.repeat(100_000), 1],
  ] as const)(
    'handles bounded UTF-8 piped input with exit code %s',
    async (input, expectedCode) => {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', entry, '--cwd', sandbox.cwd, 'chat'],
            { cwd: root, env },
          );
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => child.kill(), 10_000);
          child.stdout.setEncoding('utf8');
          child.stderr.setEncoding('utf8');
          child.stdout.on('data', (data: string) => {
            stdout += data;
          });
          child.stderr.on('data', (data: string) => {
            stderr += data;
          });
          child.stdin.on('error', () => {
            /* early input rejection may close stdin */
          });
          child.once('error', reject);
          child.once('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
          });
          child.stdin.end(input);
        },
      );
      expect(result.code).toBe(expectedCode);
      if (expectedCode === 0) {
        expect(result.stdout).toContain('管道输入中文 🐈');
        expect(result.stdout).not.toContain('MewCode Agent ·');
        expect(result.stderr).toBe('');
      } else expect(result.stderr).toContain('INVALID_PROMPT');
    },
  );

  it('reports invalid configuration without a raw stack or sensitive source line', async () => {
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'provider: [ sensitive-source-line\n',
    );
    const error = await cli(['--cwd', sandbox.cwd, 'config']).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 1 });
    const stderr = (error as { stderr: string }).stderr;
    expect(stderr).toContain('CONFIG_INVALID');
    expect(stderr).not.toContain('sensitive-source-line');
    expect(stderr).not.toContain(' at ');
  });
});
