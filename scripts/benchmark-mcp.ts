import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createSandbox, removeSandbox } from '../tests/support/sandbox.js';
import { MCPManager, mcpToolName } from '../src/mcp/manager.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { ToolExecutor } from '../src/tools/executor.js';

const sandbox = await createSandbox();
const starts: number[] = [];
const calls: number[] = [];
const snapshots: number[] = [];
try {
  for (let sample = 0; sample < 5; sample++) {
    const registry = new ToolRegistry();
    const manager = new MCPManager(registry, {
      local: {
        transport: 'stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('../tests/support/mcp-server.mjs', import.meta.url))],
        cwd: '.',
        env: {},
        connectTimeoutMs: 15_000,
        callTimeoutMs: 5000,
      },
    });
    const executor = await ToolExecutor.create(registry, {
      root: sandbox.cwd,
      approve: async () => true,
    });
    try {
      const start = performance.now();
      assert((await manager.connect('local', executor, AbortSignal.timeout(15_000))).ok);
      starts.push(performance.now() - start);
      const snapshot = performance.now();
      for (let i = 0; i < 100; i++) assert.equal(manager.catalog('local').length, 2);
      snapshots.push(performance.now() - snapshot);
      const call = performance.now();
      for (let i = 0; i < 20; i++)
        assert(
          (
            await executor.execute({
              callId: `call-${i}`,
              name: mcpToolName('local', 'echo'),
              input: { text: 'fixed mock payload' },
            })
          ).ok,
        );
      calls.push(performance.now() - call);
    } finally {
      await manager.close();
    }
  }
  const median = (values: number[]) => Number(values.sort((a, b) => a - b)[2]!.toFixed(2));
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        samples: 5,
        initializeAndTwoPageDiscoveryMedianMs: median(starts),
        snapshot100ReadsMedianMs: median(snapshots),
        calls20MedianMs: median(calls),
        conditions:
          'local stdio fixture, cold connection per sample; calls include validation, exact approval callback and in-memory audit; no human wait/model/network/disk audit; Windows Job Object relay startup included',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await removeSandbox(sandbox.root);
}
