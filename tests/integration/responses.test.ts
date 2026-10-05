import { afterEach, describe, expect, it } from 'vitest';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';
import { Conversation } from '../../src/core/conversation.js';
import type { LLMEvent } from '../../src/providers/types.js';
import { modelServer, sse } from '../support/model-server.js';

const options = { model: 'gpt-5.5', maxOutputTokens: 256, timeoutMs: 1000 };
const delta = (text: string) => ({
  type: 'response.output_text.delta',
  delta: text,
  item_id: 'item-test',
  output_index: 0,
  content_index: 0,
  sequence_number: 1,
});
const complete = (type = 'response.completed', reason: string | null = null) => ({
  type,
  sequence_number: 2,
  response: {
    id: 'response-test',
    status: type === 'response.completed' ? 'completed' : 'incomplete',
    incomplete_details: reason ? { reason } : null,
    usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
    output: [],
  },
});
async function collect(conversation: Conversation, prompt = '你好') {
  const events: LLMEvent[] = [];
  for await (const event of conversation.send(prompt)) events.push(event);
  return events;
}

describe('Responses wire API', () => {
  let server: Awaited<ReturnType<typeof modelServer>> | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });
  const conversation = () =>
    new Conversation(
      new OpenAICompatibleProvider({
        apiKey: 'fake-responses-key',
        baseUrl: server!.url,
        timeoutMs: 1000,
        wireApi: 'responses',
      }),
      options,
    );

  it('uses the exact model and store:false, preserving multi-turn input and usage', async () => {
    server = await modelServer((res) => sse(res, [delta('你好 🐈'), complete()]));
    const chat = conversation();
    const events = await collect(chat, '第一轮');
    expect(events).toEqual([
      { type: 'text_delta', text: '你好 🐈' },
      { type: 'usage', inputTokens: 7, outputTokens: 2, estimated: false },
      { type: 'finish', reason: 'stop' },
    ]);
    await collect(chat, '第二轮');
    expect(server.requests[0]).toMatchObject({
      url: '/v1/responses',
      body: { model: 'gpt-5.5', stream: true, store: false, max_output_tokens: 256 },
    });
    expect(server.requests[1]?.body.input?.slice(1)).toEqual([
      { role: 'user', content: '第一轮' },
      { role: 'assistant', content: '你好 🐈' },
      { role: 'user', content: '第二轮' },
    ]);
    expect(server.requests.every((record) => record.body.store === false)).toBe(true);
  });

  it('distinguishes output-token truncation from rejection', async () => {
    server = await modelServer((res, _record, count) =>
      sse(res, [
        delta('部分'),
        complete('response.incomplete', count === 1 ? 'max_output_tokens' : 'content_filter'),
      ]),
    );
    expect((await collect(conversation())).at(-1)).toEqual({ type: 'finish', reason: 'length' });
    const rejected = conversation();
    await expect(collect(rejected)).rejects.toMatchObject({ code: 'MODEL_REJECTED' });
    expect(rejected.history).toEqual([]);
  });

  it.each(['response.failed', 'error'])(
    'sanitizes %s events without retry or history commit',
    async (type) => {
      server = await modelServer((res) =>
        sse(res, [
          {
            type,
            message: 'sensitive-vendor-error',
            response: { error: { message: 'sensitive-vendor-error' } },
          },
        ]),
      );
      const chat = conversation();
      const error = await collect(chat).catch((error: unknown) => error);
      expect((error as Error).message).not.toContain('sensitive-vendor-error');
      expect(chat.history).toEqual([]);
      expect(server.requests).toHaveLength(1);
    },
  );

  it('does not retry once a response.created event has arrived', async () => {
    server = await modelServer((res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"type":"response.created","response":{}}\n\n');
      setTimeout(() => res.destroy(), 20);
    });
    await expect(collect(conversation())).rejects.toMatchObject({ code: 'MODEL_NETWORK' });
    expect(server.requests).toHaveLength(1);
  });

  it('rejects missing completion markers and tool requests', async () => {
    server = await modelServer((res, _record, count) =>
      sse(
        res,
        count === 1
          ? [delta('缺失完成事件')]
          : [
              {
                type: 'response.output_item.added',
                item: { type: 'function_call', name: 'Bash', arguments: '{}' },
              },
            ],
      ),
    );
    await expect(collect(conversation())).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    await expect(collect(conversation())).rejects.toMatchObject({ code: 'MODEL_UNSUPPORTED' });
  });
});
