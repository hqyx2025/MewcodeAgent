import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfiguration } from '../../src/config/load.js';
import { configPatchSchema } from '../../src/config/schema.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

describe('hook configuration contracts', () => {
  it('appends known hooks in source order and rejects duplicate ids across layers', async () => {
    const box = await createSandbox();
    try {
      const yaml = (id: string) =>
        `hooks:\n  - id: ${id}\n    event: PreToolUse\n    script: guard.mjs\n`;
      await writeFile(join(box.userDirectory, 'config.yaml'), yaml('user'));
      await writeFile(join(box.projectDirectory, 'config.yaml'), yaml('project'));
      const load = () => loadConfiguration({ cwd: box.cwd, userHome: box.home, env: {} });
      expect((await load()).settings.hooks.map((hook) => hook.id)).toEqual(['user', 'project']);
      expect((await load()).settings.hooks[0]).toMatchObject({ timeoutMs: 5000, env: [] });
      await writeFile(join(box.projectDirectory, 'config.yaml'), yaml('user'));
      await expect(load()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    } finally {
      await removeSandbox(box.root);
    }
  });
  it.each([
    { id: 'guard', event: 'Unknown', script: 'a.mjs' },
    { id: 'guard', event: 'SessionStart', script: 'a.mjs', tool: 'ReadFile' },
    { id: 'guard', event: 'PreToolUse', script: 'a.mjs', env: ['NODE_OPTIONS'] },
    { id: 'guard', event: 'PreToolUse', script: 'a.mjs', env: ['PATH'] },
    { id: 'guard', event: 'PreToolUse', script: 'a.mjs', timeoutMs: 0 },
    { id: 'guard', event: 'PreToolUse', script: 'a.mjs', command: 'unauthorized' },
  ])('rejects invalid/unknown fields %#', (hook) => {
    expect(configPatchSchema.safeParse({ hooks: [hook] }).success).toBe(false);
  });
});
