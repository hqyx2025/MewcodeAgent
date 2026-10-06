import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { evaluatePermission } from '../src/security/policy.js';
import type { ScopedPermissionRule } from '../src/security/rules.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { defineTool } from '../src/tools/types.js';

const temporary = await mkdtemp(join(tmpdir(), 'mewcode-permission-bench-'));
try {
  const rules: ScopedPermissionRule[] = Array.from({ length: 400 }, (_, i) => ({
    source: 'user',
    decision: i % 2 ? 'ask' : 'deny',
    path: `area-${i}`,
  }));
  const samples: number[] = [];
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now();
    for (let i = 0; i < 10_000; i++) {
      const decision = evaluatePermission(
        'default',
        'ReadFile',
        'read',
        [],
        rules,
        `area-${i % 401}/file`,
      ).decision;
      assert.equal(decision, i % 401 === 400 ? 'allow' : (i % 401) % 2 ? 'ask' : 'deny');
    }
    samples.push(performance.now() - start);
  }
  const median = (numbers: number[]) =>
    Number([...numbers].sort((a, b) => a - b)[Math.floor(numbers.length / 2)]!.toFixed(2));
  const consentResults = [];
  for (const scope of ['once', 'session'] as const) {
    const timings: number[] = [];
    let approvals = 0;
    for (let sample = 0; sample < 5; sample++) {
      let executions = 0;
      approvals = 0;
      const registry = new ToolRegistry().register(
        defineTool({
          name: 'Bash',
          description: 'benchmark mock only',
          effect: 'shell',
          schema: z.strictObject({ command: z.string() }),
          async prepare(input, context) {
            return {
              target: context.paths.root,
              preview: input.command,
              async run() {
                executions++;
                return { content: 'mock' };
              },
            };
          },
        }),
      );
      const executor = await ToolExecutor.create(registry, {
        root: temporary,
        approve: async () => {
          approvals++;
          return { allow: true, scope };
        },
      });
      const start = performance.now();
      for (let i = 0; i < 100; i++)
        assert(
          (
            await executor.execute({
              callId: `call-${i}`,
              name: 'Bash',
              input: { command: 'mock-command' },
            })
          ).ok,
        );
      timings.push(performance.now() - start);
      assert.equal(executions, 100);
      assert.equal(approvals, scope === 'once' ? 100 : 1);
    }
    consentResults.push({ scope, calls: 100, approvals, medianMs: median(timings) });
  }
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        samples: 5,
        policy: { rules: 400, decisionsPerSample: 10_000, medianMs: median(samples) },
        consent: consentResults,
        timingScope:
          'policy includes loop/assertion; consent includes preparation/fingerprint/in-memory audit, excludes initialization, actual shell, human wait, disk audit and model/network',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  assert(resolve(temporary).startsWith(resolve(join(tmpdir(), 'mewcode-permission-bench-'))));
  await rm(temporary, { recursive: true, force: true });
}
