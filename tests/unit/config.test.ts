import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfiguration } from '../../src/config/load.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

describe('layered configuration', () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>>;

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await removeSandbox(sandbox.root);
  });

  const load = (extra: Parameters<typeof loadConfiguration>[0] = {}) =>
    loadConfiguration({ cwd: sandbox.cwd, userHome: sandbox.home, env: {}, ...extra });

  it('allows only trusted opt-in and lets project subagent limits tighten user ceilings', async () => {
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'subagents:\n  enabled: true\n  concurrency: 4\n',
    );
    expect((await load()).settings.subagents).toMatchObject({ enabled: false, concurrency: 2 });
    await writeFile(
      join(sandbox.userDirectory, 'config.yaml'),
      'subagents:\n  enabled: true\n  concurrency: 3\n  maxTasks: 12\n',
    );
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'subagents:\n  concurrency: 4\n  maxTasks: 5\n',
    );
    expect((await load()).settings.subagents).toMatchObject({
      enabled: true,
      concurrency: 3,
      maxTasks: 5,
    });
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'subagents:\n  enabled: false\n',
    );
    expect((await load()).settings.subagents.enabled).toBe(false);
    expect(
      (await load({ overrides: { subagents: { enabled: true } } })).settings.subagents.enabled,
    ).toBe(true);
    await expect(
      load({ overrides: { subagents: { enabled: true }, context: { toolResultBytes: 1024 } } }),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(load({ overrides: { subagents: { concurrency: 5 } } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it('works without files or credentials in a Unicode path', async () => {
    const loaded = await load();
    expect(loaded.settings.provider).toEqual({ kind: 'mock', model: 'mock-v1' });
    expect(loaded.settings.limits.maxTurns).toBe(20);
    expect(loaded.cwd).toContain('中文 项目');
    expect(loaded.paths.logFile).toBe(join(loaded.paths.storageDirectory, 'logs', 'mewcode.log'));
    expect(loaded.sources).toEqual([{ kind: 'defaults' }]);
  });

  it('merges known nested fields in the documented precedence order', async () => {
    await writeFile(
      join(sandbox.userDirectory, 'config.yaml'),
      'provider:\n  model: user-model\n  apiKeyEnv: CUSTOM_TOKEN\nlimits:\n  maxTurns: 5\n  timeoutMs: 9000\n',
    );
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'provider:\n  model: project-model\nlimits:\n  maxTurns: 7\n',
    );
    const loaded = await load({
      env: { MEWCODE_MODEL: 'environment-model', MEWCODE_MAX_TURNS: '11' },
      overrides: { provider: { model: 'cli-model', kind: undefined }, mode: 'plan' },
    });
    expect(loaded.settings.provider).toEqual({
      kind: 'mock',
      model: 'cli-model',
      apiKeyEnv: 'CUSTOM_TOKEN',
    });
    expect(loaded.settings.limits).toEqual({
      maxTurns: 11,
      timeoutMs: 9000,
      maxOutputTokens: 4096,
    });
    expect(loaded.settings.mode).toBe('plan');
    expect(loaded.sources.map((source) => source.kind)).toEqual([
      'defaults',
      'user',
      'project',
      'environment',
      'cli',
    ]);
  });

  it('uses an explicit config file instead of the project default', async () => {
    await writeFile(join(sandbox.projectDirectory, 'config.yaml'), 'mode: plan\n');
    await writeFile(join(sandbox.cwd, '指定 配置.yaml'), 'mode: accept-edits\n');
    expect((await load({ configFile: '指定 配置.yaml' })).settings.mode).toBe('default');
    expect(
      (await load({ configFile: '指定 配置.yaml', overrides: { mode: 'accept-edits' } })).settings
        .mode,
    ).toBe('accept-edits');
    await expect(load({ configFile: 'missing.yaml' })).rejects.toMatchObject({
      code: 'CONFIG_READ',
    });
  });

  it('merges only known memory fields and prevents a project from enabling disabled user memory', async () => {
    await writeFile(
      join(sandbox.userDirectory, 'config.yaml'),
      'memory:\n  enabled: false\n  injectionBytes: 4096\n',
    );
    await writeFile(join(sandbox.projectDirectory, 'config.yaml'), 'memory:\n  enabled: true\n');
    expect((await load()).settings.memory).toEqual({ enabled: false, injectionBytes: 4096 });
    expect((await load({ env: { MEWCODE_MEMORY: 'true' } })).settings.memory.enabled).toBe(true);
    await expect(load({ env: { MEWCODE_MEMORY: 'yes' } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    await writeFile(join(sandbox.projectDirectory, 'config.yaml'), 'memory:\n  unknown: true\n');
    await expect(load()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('resolves storage and log overrides relative to the working directory', async () => {
    const loaded = await load({
      env: {
        MEWCODE_HOME: '配置 home',
        MEWCODE_STORAGE_DIR: '缓存 空间',
        MEWCODE_LOG_FILE: '日志/agent.log',
      },
    });
    expect(loaded.paths.userDirectory).toBe(join(loaded.cwd, '配置 home'));
    expect(loaded.paths.storageDirectory).toBe(join(loaded.cwd, '缓存 空间'));
    expect(loaded.paths.logFile).toBe(join(loaded.cwd, '日志', 'agent.log'));
  });

  it.each([
    'null',
    '- item',
    'unknown: true',
    'provider:\n  kind: invalid',
    'limits:\n  maxTurns: 0',
  ])('rejects invalid YAML settings: %s', async (yaml) => {
    await writeFile(join(sandbox.projectDirectory, 'config.yaml'), yaml);
    await expect(load()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('does not hide an invalid lower-priority file with a later override', async () => {
    await writeFile(join(sandbox.userDirectory, 'config.yaml'), 'mode: invalid\n');
    await expect(load({ overrides: { mode: 'plan' } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });

  it.each(['0', '-1', '1.5', '1e3', '', '9007199254740993'])(
    'rejects malformed or out-of-range environment limits: %s',
    async (value) => {
      await expect(load({ env: { MEWCODE_TIMEOUT_MS: value } })).rejects.toMatchObject({
        code: 'CONFIG_INVALID',
      });
    },
  );

  it('requires a real model name but does not resolve credentials for inspection', async () => {
    await expect(load({ env: { MEWCODE_PROVIDER: 'openai-compatible' } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
    const loaded = await load({
      env: {
        MEWCODE_PROVIDER: 'openai-compatible',
        MEWCODE_MODEL: 'my-model',
        MEWCODE_API_KEY_ENV: 'CUSTOM_TOKEN',
        CUSTOM_TOKEN: 'never-display-this-secret',
      },
    });
    expect(loaded.settings.provider.model).toBe('my-model');
    expect(JSON.stringify(loaded)).not.toContain('never-display-this-secret');
  });

  it('does not echo a sensitive YAML source line on parsing failure', async () => {
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'provider: [ secret-do-not-display\n',
    );
    const error = await load().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as Error).message).not.toContain('secret-do-not-display');
  });

  it('rejects duplicate YAML keys', async () => {
    await writeFile(join(sandbox.projectDirectory, 'config.yaml'), 'mode: plan\nmode: default\n');
    await expect(load()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('rejects executable tags and inline API keys', async () => {
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'provider: !!js/function >\n  function() {}\n',
    );
    await expect(load()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'provider:\n  apiKey: secret-do-not-display\n',
    );
    const error = await load().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as Error).message).not.toContain('secret-do-not-display');
  });

  it.each([
    'https://user:secret@example.com/v1',
    'https://example.com/v1?key=secret',
    'file:///tmp/provider',
    'not-a-url',
    'https://',
  ])('rejects credential-bearing or non-HTTP service URLs', async (baseUrl) => {
    const error = await load({ overrides: { provider: { baseUrl } } }).catch(
      (error: unknown) => error,
    );
    expect(error).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((error as Error).message).not.toContain(baseUrl);
  });

  it('rejects oversized files before YAML parsing', async () => {
    await writeFile(join(sandbox.projectDirectory, 'config.yaml'), `#${'a'.repeat(256 * 1024)}`);
    await expect(load()).rejects.toMatchObject({ code: 'CONFIG_READ' });
  });

  it('rejects absent and non-directory workspaces', async () => {
    await expect(load({ cwd: join(sandbox.root, 'missing') })).rejects.toMatchObject({
      code: 'INVALID_WORKDIR',
    });
    const file = join(sandbox.root, 'not-a-directory');
    await writeFile(file, 'text');
    await expect(load({ cwd: file })).rejects.toMatchObject({ code: 'INVALID_WORKDIR' });
  });

  it('rejects empty explicit paths rather than silently falling back', async () => {
    await expect(load({ configFile: '' })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(load({ cwd: '' })).rejects.toMatchObject({ code: 'INVALID_WORKDIR' });
    await expect(load({ env: { MEWCODE_HOME: '' } })).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
    });
  });
});
