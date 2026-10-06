import assert from 'node:assert/strict';
import { Profiler, createElement } from 'react';
import { render, cleanup } from 'ink-testing-library';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { Chat } from '../src/ui/chat.js';
import { Conversation } from '../src/core/conversation.js';
import type { LLMProvider } from '../src/providers/types.js';
async function until(check: () => boolean) {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    assert(performance.now() < deadline, 'UI fixture timeout');
    await delay(5);
  }
}
const results = [];
for (let sample = 0; sample < 3; sample++) {
  let commits = 0;
  const text = '片🐈'.repeat(1000);
  const provider: LLMProvider = {
    id: 'ui-fixture',
    capabilities: { streaming: true, toolCalling: false },
    async *stream(_request, signal) {
      for (let chunk = 0; chunk < 1000; chunk++) {
        if (chunk % 10 === 0) await delay(1, undefined, { signal });
        yield { type: 'text_delta', text: '片🐈' };
      }
      yield { type: 'finish', reason: 'stop' };
    },
  };
  const conversation = new Conversation(provider, {
    model: 'fixture',
    maxOutputTokens: 4096,
    timeoutMs: 10_000,
  });
  const view = render(
    createElement(
      Profiler,
      {
        id: 'chat',
        onRender: () => {
          commits++;
        },
      },
      createElement(Chat, { conversation, model: 'fixture', provider: 'fixture' }),
    ),
  );
  try {
    await until(() => view.lastFrame()?.includes('输入问题') ?? false);
    view.stdin.write('stream fixture');
    await until(() => view.lastFrame()?.includes('stream fixture') ?? false);
    const initial = commits,
      began = performance.now();
    view.stdin.write('\r');
    await until(
      () => conversation.history.length === 2 || (view.lastFrame()?.includes('[') ?? false),
    );
    assert.equal(conversation.history.length, 2, view.lastFrame());
    await until(() => view.lastFrame()?.includes('输入问题') ?? false);
    assert.equal(conversation.history[1]!.content, text);
    assert(view.lastFrame()?.includes('片🐈'));
    results.push({
      elapsedMs: Number((performance.now() - began).toFixed(2)),
      commits: commits - initial,
      observedHeapBytes: process.memoryUsage().heapUsed,
      answerCharacters: text.length,
    });
  } finally {
    view.unmount();
    cleanup();
  }
}
process.stdout.write(
  JSON.stringify(
    {
      platform: process.platform,
      node: process.version,
      samples: 3,
      chunks: 1000,
      conditions:
        'Ink testing renderer with React Profiler; 1000 Chinese/emoji chunks in bursts of 10 with 1ms artificial delay per burst; real chat 30ms flush, sequential samples. Timing includes injected delay, React commits do not equal terminal paints or production FPS. Exact committed answer checked. Heap sampled at completion, natural caches, no forced GC or model/network.',
      results,
    },
    null,
    2,
  ) + '\n',
);
