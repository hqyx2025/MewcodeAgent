import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hookSchema } from '../../src/tools/hook-schema.js';
import type { HookConfiguration, HookDecision } from '../../src/tools/hook-schema.js';

export const respond = (decision: HookDecision) =>
  `console.log(${JSON.stringify(JSON.stringify(decision))});`;
export async function writeHook(
  cwd: string,
  patch: Partial<HookConfiguration> = {},
  source = respond({ decision: 'continue' }),
) {
  const hook = hookSchema.parse({
    id: 'guard',
    event: 'PreToolUse',
    script: 'guard.mjs',
    ...patch,
  });
  await writeFile(join(cwd, hook.script), source);
  return hook;
}
