import { describe, expect, it } from 'vitest';
import { createProvider } from '../../src/providers/create.js';
import { defaultSettings } from '../../src/config/schema.js';
import { terminalText } from '../../src/shared/terminal-text.js';

describe('provider selection and terminal text', () => {
  it('creates Mock without credentials and reports a missing real-provider key', async () => {
    expect((await createProvider(defaultSettings, {})).id).toBe('mock');
    const settings = {
      ...defaultSettings,
      provider: { kind: 'openai-compatible' as const, model: 'test', apiKeyEnv: 'CUSTOM_TOKEN' },
    };
    await expect(createProvider(settings, {})).rejects.toMatchObject({ code: 'MODEL_MISSING_KEY' });
    expect((await createProvider(settings, { CUSTOM_TOKEN: 'fake-key-for-tests' })).id).toBe(
      'openai-compatible',
    );
  });

  it('creates Anthropic lazily with its own key environment variable', async () => {
    await expect(
      createProvider({ ...defaultSettings, provider: { kind: 'anthropic', model: 'test' } }, {}),
    ).rejects.toMatchObject({ code: 'MODEL_MISSING_KEY' });
    expect(
      (
        await createProvider(
          { ...defaultSettings, provider: { kind: 'anthropic', model: 'test' } },
          { ANTHROPIC_API_KEY: 'fake-key' },
        )
      ).id,
    ).toBe('anthropic');
  });

  it('strips terminal controls without breaking Unicode or newlines', () => {
    expect(terminalText('\u001b[31m中文🐈\u001b[0m\u0007\n下一行')).toBe('中文🐈\n下一行');
    expect(terminalText('\u001b]0;malicious-title\u0007正文')).toBe('正文');
  });
});
