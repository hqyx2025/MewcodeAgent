import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createBuiltinRegistry } from '../src/tools/builtins.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { HookRuntime } from '../src/tools/hooks.js';
import { createSandbox, removeSandbox } from '../tests/support/sandbox.js';
import { writeHook } from '../tests/support/hooks.js';

const box = await createSandbox();
try {
  await writeFile(join(box.cwd, 'read.txt'), 'fixed hook benchmark');
  const configurations = await Promise.all(
    ['PreToolUse', 'PostToolUse'].map((event, i) =>
      writeHook(box.cwd, {
        id: `hook-${i}`,
        script: `hook-${i}.mjs`,
        event: event as 'PreToolUse' | 'PostToolUse',
      }),
    ),
  );
  const plain = await ToolExecutor.create(createBuiltinRegistry(), { root: box.cwd });
  const registry = createBuiltinRegistry();
  let approvals = 0;
  const hooks = new HookRuntime(registry, configurations);
  const executor = await ToolExecutor.create(registry, {
    root: box.cwd,
    hooks: hooks.handle,
    approve: async () => {
      approvals++;
      return true;
    },
  });
  const baseline: number[] = [],
    withHooks: number[] = [];
  for (let sample = 0; sample < 7; sample++) {
    for (const [target, times] of [
      [plain, baseline],
      [executor, withHooks],
    ] as const) {
      const start = performance.now();
      assert(
        (
          await target.execute({
            callId: randomUUID(),
            name: 'ReadFile',
            input: { path: 'read.txt' },
          })
        ).ok,
      );
      times.push(performance.now() - start);
    }
  }
  const median = (values: number[]) => Number([...values].sort((a, b) => a - b)[3]!.toFixed(3));
  assert.equal(hooks.auditLog.length, 14);
  assert.equal(approvals, 14);
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        samples: 7,
        tools: 7,
        hookEvents: hooks.auditLog.length,
        scriptStarts: executor.auditLog.filter((item) => item.name === 'HookScript').length,
        approvalCalls: approvals,
        baselineMedianMs: median(baseline),
        withHooksMedianMs: median(withHooks),
        hookDurationTotalMs: Number(
          hooks.auditLog.reduce((sum, item) => sum + item.durationMs, 0).toFixed(3),
        ),
        extraModelCalls: 0,
        conditions:
          'fixed local ReadFile, one Pre and one Post Node script; seven sequential samples; immediate mock approval, no network/model/audit fsync; normal filesystem/Node warm-up; complete safety checks and two fresh processes per tool',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await removeSandbox(box.root);
}
