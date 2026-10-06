import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { AgentLoop } from '../src/core/agent-loop.js';
import { MockProvider } from '../src/providers/mock.js';
import type { LLMProvider } from '../src/providers/types.js';
import { createBuiltinRegistry } from '../src/tools/builtins.js';
import { ToolExecutor } from '../src/tools/executor.js';

const temporary = await mkdtemp(join(tmpdir(), 'mewcode-agent-bench-'));
try {
  for (let index = 0; index < 100; index++)
    await writeFile(join(temporary, `file-${index}.txt`), 'fixture');
  const timings: number[] = [];
  let metrics: Record<string, unknown> = {};
  for (let sample = 0; sample < 5; sample++) {
    const context: number[] = [];
    const mock = new MockProvider({ delayMs: 0 });
    const provider: LLMProvider = {
      id: mock.id,
      capabilities: mock.capabilities,
      stream(request, signal) {
        context.push(JSON.stringify(request).length);
        return mock.stream(request, signal);
      },
    };
    const agent = new AgentLoop(
      provider,
      await ToolExecutor.create(createBuiltinRegistry(), { root: temporary, mode: 'plan' }),
      { model: 'mock-v1', mode: 'plan', maxTurns: 3, maxOutputTokens: 512, timeoutMs: 5000 },
    );
    const start = performance.now();
    const events = [];
    for await (const event of agent.run('list files')) events.push(event);
    timings.push(performance.now() - start);
    assert.equal(events.at(-1)?.type, 'finish');
    metrics = { events: events.length, requestCharacters: context, completion: events.at(-1) };
  }
  timings.sort((a, b) => a - b);
  process.stdout.write(
    `${JSON.stringify({ platform: process.platform, node: process.version, fixtureFiles: 100, samples: 5, provider: 'mock (zero model/network delay)', timingScope: 'two model rounds + bounded Glob + event consumption; excludes initialization', medianMs: Number(timings[2]!.toFixed(2)), minMs: Number(timings[0]!.toFixed(2)), maxMs: Number(timings[4]!.toFixed(2)), ...metrics }, null, 2)}\n`,
  );
} finally {
  assert(resolve(temporary).startsWith(resolve(join(tmpdir(), 'mewcode-agent-bench-'))));
  await rm(temporary, { recursive: true, force: true });
}
