import { it, expect } from 'vitest';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
it('only removes an exact sandbox root created by this module', async () => {
  const box = await createSandbox();
  try {
    await writeFile(join(box.cwd, 'keep.txt'), 'retained');
    await expect(removeSandbox(box.cwd)).rejects.toThrow('Refusing');
    await expect(removeSandbox(box.root + '-lookalike')).rejects.toThrow('Refusing');
    expect(await readFile(join(box.cwd, 'keep.txt'), 'utf8')).toBe('retained');
  } finally {
    await removeSandbox(box.root);
  }
  await expect(removeSandbox(box.root)).rejects.toThrow('Refusing');
});
