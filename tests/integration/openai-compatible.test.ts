import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';
import { Conversation } from '../../src/core/conversation.js';
import type { LLMEvent, LLMRequest } from '../../src/providers/types.js';
import { chunk, modelServer, sse } from '../support/model-server.js';

const request: LLMRequest = {
  model: 'configured-model',
  messages: [{ role: 'user', content: '你好 🐈' }],
  maxOutputTokens: 512,
};
async function collect(provider: OpenAICompatibleProvider, signal = new AbortController().signal) {
  const events: LLMEvent[] = [];
  for await (const event of provider.stream(request, signal)) events.push(event);
  return events;
}

describe('OpenAI-compatible HTTP/SSE adapter', () => {
  let server: Awaited<ReturnType<typeof modelServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const provider = (extra = {}) =>
    new OpenAICompatibleProvider({
      apiKey: 'fake-key-for-local-tests',
      baseUrl: server!.url,
      timeoutMs: 2000,
      ...extra,
    });

  it('streams Unicode, usage and finish while sending the configured request', async () => {
    server = await modelServer((res) =>
      sse(res, [
        chunk('你好'),
        chunk(' 🐈'),
        chunk('', 'stop'),
        { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
      ]),
    );
    const events = await collect(provider());
    expect(events).toEqual([
      { type: 'text_delta', text: '你好' },
      { type: 'text_delta', text: ' 🐈' },
      { type: 'usage', inputTokens: 7, outputTokens: 3, estimated: false },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(server.requests[0]).toMatchObject({
      url: '/v1/chat/completions',
      authorization: 'Bearer fake-key-for-local-tests',
      body: {
        model: 'configured-model',
        stream: true,
        max_tokens: 512,
        stream_options: { include_usage: true },
      },
    });
  });

  it('supports max_completion_tokens and opting out of stream usage', async () => {
    server = await modelServer((res) => sse(res, [chunk('', 'stop')]));
    expect(
      await collect(provider({ maxTokensParameter: 'max_completion_tokens', includeUsage: false })),
    ).toEqual([{ type: 'finish', reason: 'stop' }]);
    expect(server.requests[0]?.body.max_completion_tokens).toBe(512);
    expect(server.requests[0]?.body).not.toHaveProperty('max_tokens');
    expect(server.requests[0]?.body).not.toHaveProperty('stream_options');
  });

  it('preserves output truncation as a distinct ending', async () => {
    server = await modelServer((res) => sse(res, [chunk('未完'), chunk('', 'length')]));
    expect((await collect(provider())).at(-1)).toEqual({ type: 'finish', reason: 'length' });
  });

  it.each([
    [400, 'MODEL_PROTOCOL', 1],
    [401, 'MODEL_AUTH', 1],
    [403, 'MODEL_AUTH', 1],
    [429, 'MODEL_RATE_LIMIT', 2],
    [503, 'MODEL_SERVER', 2],
  ] as const)('classifies HTTP %s without leaking its body', async (status, code, attempts) => {
    server = await modelServer((res) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ error: { message: 'sensitive-vendor-body fake-key-for-local-tests' } }),
      );
    });
    const error = await collect(provider()).catch((error: unknown) => error);
    expect(error).toMatchObject({ code });
    expect((error as Error).message).not.toContain('sensitive-vendor-body');
    expect((error as Error).message).not.toContain('fake-key-for-local-tests');
    expect(server.requests).toHaveLength(attempts);
  });

  it('retries one rate-limit response before any stream event', async () => {
    server = await modelServer((res, _record, count) => {
      if (count === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end('{"error":{"message":"limited"}}');
      } else sse(res, [chunk('成功'), chunk('', 'stop')]);
    });
    expect((await collect(provider())).filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: '成功' },
    ]);
    expect(server.requests).toHaveLength(2);
  });

  it('retries a connection failure before receiving events', async () => {
    server = await modelServer((res, _record, count) => {
      if (count === 1) res.destroy();
      else sse(res, [chunk('恢复'), chunk('', 'stop')]);
    });
    expect((await collect(provider())).at(-1)).toMatchObject({ type: 'finish' });
    expect(server.requests).toHaveLength(2);
  });

  it('does not retry a stream broken after visible output', async () => {
    server = await modelServer((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(chunk('部分回答'))}\n\n`);
      setTimeout(() => res.destroy(), 20);
    });
    const events: LLMEvent[] = [];
    const read = async () => {
      for await (const event of provider().stream(request, new AbortController().signal))
        events.push(event);
    };
    await expect(read()).rejects.toMatchObject({ code: 'MODEL_NETWORK' });
    expect(events).toEqual([{ type: 'text_delta', text: '部分回答' }]);
    expect(server.requests).toHaveLength(1);
  });

  it('rejects missing finish markers and malformed JSON without retrying', async () => {
    server = await modelServer((res, _record, count) => {
      if (count === 1) sse(res, [chunk('不完整')]);
      else {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end('data: {broken-json\n\n');
      }
    });
    await expect(collect(provider())).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    await expect(collect(provider())).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    expect(server.requests).toHaveLength(2);
  });

  it('rejects tool requests and content filters explicitly', async () => {
    server = await modelServer((res, _record, count) =>
      sse(res, [chunk('', count === 1 ? 'tool_calls' : 'content_filter')]),
    );
    await expect(collect(provider())).rejects.toMatchObject({ code: 'MODEL_UNSUPPORTED' });
    await expect(collect(provider())).rejects.toMatchObject({ code: 'MODEL_REJECTED' });
  });

  it('aborts a waiting response and closes the connection', async () => {
    server = await modelServer((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
    });
    const controller = new AbortController();
    const pending = collect(provider(), controller.signal);
    await vi.waitFor(() => expect(server?.requests).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(server?.requests[0]?.closed).toBe(true));
    expect(server.requests).toHaveLength(1);
  });

  it('enforces the whole-conversation deadline', async () => {
    server = await modelServer((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
    });
    const conversation = new Conversation(provider(), {
      model: 'test-model',
      maxOutputTokens: 512,
      timeoutMs: 80,
    });
    const read = async () => {
      for await (const _event of conversation.send('超时')) {
        void _event;
      }
    };
    await expect(read()).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
    expect(conversation.history).toEqual([]);
  });
});
