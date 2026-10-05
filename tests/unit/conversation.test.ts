import { describe, expect, it } from 'vitest';
import { Conversation } from '../../src/core/conversation.js';
import { MockProvider } from '../../src/providers/mock.js';
import type { LLMEvent, LLMProvider, LLMRequest } from '../../src/providers/types.js';
import { AppError } from '../../src/shared/errors.js';

const options = { model: 'test-model', maxOutputTokens: 512, timeoutMs: 1000 };
async function consume(conversation: Conversation, prompt: string, signal?: AbortSignal) {
  const events: LLMEvent[] = [];
  for await (const event of conversation.send(prompt, signal)) events.push(event);
  return events;
}

describe('conversation history and lifecycle', () => {
  it('sends successful user/assistant history to the next request', async () => {
    const requests: LLMRequest[] = [];
    const mock = new MockProvider({ delayMs: 0, response: '回答' });
    const provider: LLMProvider = {
      id: 'capture',
      capabilities: mock.capabilities,
      stream: (request, signal) => {
        requests.push(request);
        return mock.stream(request, signal);
      },
    };
    const conversation = new Conversation(provider, options);
    await consume(conversation, '第一个问题');
    await consume(conversation, '后续问题');
    expect(requests[1]?.messages.slice(1)).toEqual([
      { role: 'user', content: '第一个问题' },
      { role: 'assistant', content: '回答' },
      { role: 'user', content: '后续问题' },
    ]);
    expect(conversation.history).toHaveLength(4);
  });

  it('keeps prior history but rolls back a failed partial turn', async () => {
    const provider: LLMProvider = {
      id: 'failure',
      capabilities: { streaming: true, toolCalling: false },
      async *stream(request) {
        yield { type: 'text_delta', text: '部分内容' };
        if (request.messages.at(-1)?.content === '失败')
          throw new AppError('MODEL_NETWORK', '连接中断。');
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const conversation = new Conversation(provider, options);
    await consume(conversation, '成功');
    const before = conversation.history;
    await expect(consume(conversation, '失败')).rejects.toMatchObject({ code: 'MODEL_NETWORK' });
    expect(conversation.history).toEqual(before);
    await consume(conversation, '重试');
    expect(conversation.history).toHaveLength(4);
  });

  it('rejects overlapping requests and can run again after cancellation', async () => {
    const conversation = new Conversation(
      new MockProvider({ delayMs: 50, response: '中文' }),
      options,
    );
    const controller = new AbortController();
    const iterator = conversation.send('第一轮', controller.signal)[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'text_delta' });
    await expect(consume(conversation, '重叠')).rejects.toMatchObject({ code: 'BUSY' });
    controller.abort();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(conversation.history).toEqual([]);
    await consume(conversation, '新的问题');
    expect(conversation.history).toHaveLength(2);
  });

  it('rejects incomplete streams and preserves a length-limited successful answer', async () => {
    const provider: LLMProvider = {
      id: 'incomplete',
      capabilities: { streaming: true, toolCalling: false },
      async *stream() {
        yield { type: 'text_delta', text: '中断' };
      },
    };
    const incomplete = new Conversation(provider, options);
    await expect(consume(incomplete, '问题')).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    expect(incomplete.history).toEqual([]);
    provider.stream = async function* () {
      yield { type: 'text_delta', text: '截断' };
      yield { type: 'finish', reason: 'length' };
    };
    const limited = new Conversation(provider, options);
    expect((await consume(limited, '问题')).at(-1)).toEqual({ type: 'finish', reason: 'length' });
    expect(limited.history.at(-1)?.content).toBe('截断');
  });

  it('rejects blank prompts and bounded context/output without changing committed history', async () => {
    const conversation = new Conversation(new MockProvider({ delayMs: 0, response: '中文' }), {
      ...options,
      maxHistoryMessages: 2,
    });
    await expect(consume(conversation, '  ')).rejects.toMatchObject({ code: 'INVALID_PROMPT' });
    await consume(conversation, '第一轮');
    await expect(consume(conversation, '第二轮')).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
    expect(conversation.history).toHaveLength(2);
    const large = new Conversation(new MockProvider({ delayMs: 0, response: '超过限额' }), {
      ...options,
      maxResponseCharacters: 2,
    });
    await expect(consume(large, '问题')).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
    expect(large.history).toEqual([]);
  });

  it('returns independent history snapshots', async () => {
    const conversation = new Conversation(
      new MockProvider({ delayMs: 0, response: '回答' }),
      options,
    );
    await consume(conversation, '问题');
    const snapshot = conversation.history;
    snapshot[0]!.content = '外部修改';
    expect(conversation.history[0]?.content).toBe('问题');
  });
});
