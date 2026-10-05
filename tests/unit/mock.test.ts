import { describe, expect, it } from 'vitest';
import { MockProvider } from '../../src/providers/mock.js';
import type { LLMEvent, LLMRequest } from '../../src/providers/types.js';

const request: LLMRequest = {
  model: 'mock-v1',
  messages: [{ role: 'user', content: '你好 🐈' }],
  maxOutputTokens: 4096,
};

describe('offline provider', () => {
  it('preserves Chinese and supplementary Unicode characters across stream chunks', async () => {
    const provider = new MockProvider({ delayMs: 0, chunkSize: 1, response: '你好🐈完成' });
    const events: LLMEvent[] = [];
    for await (const event of provider.stream(request, new AbortController().signal))
      events.push(event);
    const text = events
      .filter((event) => event.type === 'text_delta')
      .map((event) => event.text)
      .join('');
    expect(text).toBe('你好🐈完成');
    expect(events.at(-2)).toMatchObject({ type: 'usage', estimated: true });
    expect(events.at(-1)).toEqual({ type: 'finish', reason: 'stop' });
  });

  it('rejects a request cancelled before it starts', async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = new MockProvider({ delayMs: 0 }).stream(request, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('cancels a pending chunk without emitting success or more content', async () => {
    const controller = new AbortController();
    const stream = new MockProvider({ delayMs: 1000 }).stream(request, controller.signal);
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
  });

  it('stops when cancelled between emitted chunks', async () => {
    const controller = new AbortController();
    const stream = new MockProvider({ delayMs: 0, chunkSize: 1 }).stream(
      request,
      controller.signal,
    );
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'text_delta' });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
