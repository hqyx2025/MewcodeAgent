import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentLoop } from '../src/core/agent-loop.js';
import { SubagentPool } from '../src/core/subagents.js';
import { TokenBudget } from '../src/core/token-budget.js';
import { defaultSubagents } from '../src/core/subagent-schema.js';
import type { LLMEvent, LLMProvider, LLMRequest } from '../src/providers/types.js';
import { createBuiltinRegistry } from '../src/tools/builtins.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { createSandbox, removeSandbox } from '../tests/support/sandbox.js';

const box = await createSandbox();
const tasks = ['one', 'two', 'three', 'four'].map((id) => ({ id, goal: `${id}/read.txt` }));
const limits = {
  model: 'benchmark',
  maxTurns: 6,
  timeoutMs: 10_000,
  maxOutputTokens: 512,
  maxTotalTokens: 200_000,
};
class Fixture implements LLMProvider {
  readonly id = 'fixture';
  readonly capabilities = { streaming: true, toolCalling: true };
  private round = 0;
  constructor(
    private readonly parent: boolean,
    private readonly request: () => void,
  ) {}
  async *stream(input: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    this.request();
    this.round++;
    await delay(100, undefined, { signal });
    if (this.round === 1) {
      const prompt = input.messages[1]!.content;
      const path = this.parent
        ? ''
        : (JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { goal: string }).goal;
      yield {
        type: 'tool_call_delta',
        index: 0,
        callId: 'fixture-call',
        name: this.parent ? 'Task' : 'ReadFile',
        arguments: JSON.stringify(this.parent ? { tasks } : { path }),
      };
    } else
      yield {
        type: 'text_delta',
        text: this.parent
          ? '父任务已收到全部摘要'
          : JSON.stringify({
              summary: '读到固定基准文件',
              evidence: [{ path: JSON.parse(input.messages.at(-1)!.content).data.path, line: 1 }],
            }),
      };
    yield { type: 'usage', inputTokens: 40, outputTokens: 10, estimated: false };
    yield { type: 'finish', reason: this.round === 1 ? 'tool_calls' : 'stop' };
  }
}
try {
  for (const task of tasks) {
    await mkdir(join(box.cwd, task.id));
    await writeFile(join(box.cwd, task.goal), 'benchmark evidence');
  }
  const results = [];
  for (const concurrency of [1, 2, 4]) {
    const samples = [];
    let requests = 0,
      peakHeap = 0,
      peakQueue = 0,
      peakActive = 0,
      totalTokens = 0;
    for (let sample = 0; sample < 3; sample++) {
      const registry = createBuiltinRegistry();
      const budget = new TokenBudget(200_000);
      const heapStart = process.memoryUsage().heapUsed;
      const pool = new SubagentPool(registry, {
        settings: { ...defaultSubagents, enabled: true, concurrency },
        budget,
        agent: limits,
        provider: () => new Fixture(false, () => requests++),
        progress: () => {
          peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed - heapStart);
        },
      });
      const executor = await ToolExecutor.create(registry, { root: box.cwd, mode: 'plan' });
      pool.bind(executor);
      const agent = new AgentLoop(new Fixture(true, () => requests++), executor, {
        ...limits,
        mode: 'plan',
        accounting: budget,
        aggregateTokens: true,
      });
      const start = performance.now();
      let finish;
      for await (const event of agent.run('固定四目录独立读取与父汇总')) {
        if (event.type === 'tool_result')
          assert(
            JSON.parse(event.result.content).tasks.every(
              (item: { status: string }) => item.status === 'completed',
            ),
          );
        if (event.type === 'finish') finish = event;
        peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed - heapStart);
      }
      assert.equal(finish!.reason, 'completed');
      assert.equal(budget.snapshot.reserved, 0);
      assert.equal(finish!.totalTokens, 500);
      samples.push(performance.now() - start);
      totalTokens = finish!.totalTokens;
      peakQueue = Math.max(peakQueue, pool.metrics.peakQueue);
      peakActive = Math.max(peakActive, pool.metrics.peakActive);
    }
    results.push({
      concurrency,
      samples: 3,
      medianMs: Number(samples.sort((a, b) => a - b)[1]!.toFixed(3)),
      requestsPerRun: requests / 3,
      totalTokensPerRun: totalTokens,
      peakQueue,
      peakActive,
      sampledHeapGrowthBytes: peakHeap,
    });
  }
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        conditions:
          'Four independent ReadFile children, two requests each, parent delegation+summary two requests; 100ms artificial delay per request, fixed synthetic usage 40+10/request. Three sequential samples per concurrency; normal filesystem cache/JIT, no forced GC; heap sampled at progress/events, not process peak. Includes parent/child prompt and result processing, no network/paid model.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await removeSandbox(box.root);
}
