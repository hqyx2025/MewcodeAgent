import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { compactHistory, defaultContext, validateHistory } from '../src/core/context.js';
import type { LLMMessage } from '../src/providers/types.js';
import { SessionStore } from '../src/core/session.js';
import { createSandbox, removeSandbox } from '../tests/support/sandbox.js';

const history: LLMMessage[] = [
  { role: 'system', content: 'runtime policy' },
  { role: 'user', content: 'fixed original goal and unfinished validation' },
];
for (let turn = 0; turn < 100; turn++)
  history.push(
    {
      role: 'assistant',
      content: `step-${turn}`,
      toolCalls: [{ callId: `call-${turn}`, name: 'ReadFile', arguments: '{}' }],
    },
    {
      role: 'tool',
      callId: `call-${turn}`,
      content: JSON.stringify({
        name: 'ReadFile',
        ok: true,
        content: `evidence-${turn} ${'fixture '.repeat(1000)}`,
      }),
    },
  );
const samples = [];
let result;
for (let sample = 0; sample < 5; sample++) {
  const start = performance.now();
  result = compactHistory(history, defaultContext)!;
  samples.push(performance.now() - start);
  assert.deepEqual(result.messages.slice(0, 2), history.slice(0, 2));
  assert.deepEqual(result.messages.slice(-8), history.slice(-8));
  validateHistory(result.messages);
}
const box = await createSandbox();
const store = await SessionStore.create(box.userDirectory, {
  cwd: box.cwd,
  provider: 'mock',
  model: 'mock-v1',
  mode: 'plan',
});
try {
  const output = {
    callId: 'spill',
    name: 'ReadFile',
    ok: true,
    content: 'fixed mock output '.repeat(12_000),
    data: { revision: 'fixed-revision' },
  };
  const start = performance.now();
  const inline = await store.spill(output, defaultContext.toolResultBytes);
  const spillMs = performance.now() - start;
  assert.deepEqual(inline.data, { revision: 'fixed-revision' });
  const reference = inline.spill!;
  assert.deepEqual(
    await SessionStore.result(box.userDirectory, store.owner.id, reference.file),
    output,
  );
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        samples: 5,
        rounds: 100,
        beforeBytes: result!.beforeBytes,
        afterBytes: result!.afterBytes,
        compactMedianMs: Number(samples.sort((a, b) => a - b)[2]!.toFixed(2)),
        archivedMessages: result!.archivedMessages,
        preserved:
          'exact goal, current policy, latest 4 complete tool groups; bounded historical excerpts',
        spill: {
          originalBytes: reference.bytes,
          inlineBytes: Buffer.byteLength(JSON.stringify(inline)),
          writeMs: Number(spillMs.toFixed(2)),
          retrieval: 'exact round trip',
        },
        extraModelCalls: 0,
        extraModelTokens: 0,
        conditions:
          'fixed in-memory 100-round history, 5 local compaction samples; one mock output spill including sync and hash, no model/network/human wait',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await store.close();
  await removeSandbox(box.root);
}
