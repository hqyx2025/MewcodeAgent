import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { OpenAICompatibleProvider } from '../../src/providers/openai-compatible.js';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import type { LLMEvent, LLMProvider, LLMRequest } from '../../src/providers/types.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
import { chunk, modelServer, sse } from '../support/model-server.js';

const args = '{"path":"evidence.txt"}';
const functionItem = (id = 'read-1') => ({
  type: 'function_call',
  id: `item-${id}`,
  call_id: id,
  name: 'ReadFile',
  arguments: args,
  status: 'completed',
});
const reasoning = {
  type: 'reasoning',
  id: 'reason-1',
  summary: [],
  encrypted_content: 'opaque-test-state',
};
function responseCall(index: number, id = 'read-1') {
  return [
    {
      type: 'response.output_item.added',
      output_index: index,
      item: { ...functionItem(id), arguments: '', status: 'in_progress' },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: index,
      item_id: `item-${id}`,
      delta: args.slice(0, 9),
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: index,
      item_id: `item-${id}`,
      delta: args.slice(9),
    },
  ];
}
const responseEnd = (output: unknown[], type = 'response.completed') => ({
  type,
  response: {
    output,
    usage: { input_tokens: 20, output_tokens: 8 },
    incomplete_details: type === 'response.incomplete' ? { reason: 'max_output_tokens' } : null,
  },
});
const chatCall = (calls: unknown[], finish_reason: string | null = null) => ({
  ...chunk(''),
  choices: [{ index: 0, delta: { tool_calls: calls }, finish_reason }],
});
function anthropicSse(res: ServerResponse, events: { type: string; [key: string]: unknown }[]) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}
const start = {
  type: 'message_start',
  message: {
    id: 'msg-test',
    role: 'assistant',
    content: [],
    usage: {
      input_tokens: 11,
      output_tokens: 1,
      cache_read_input_tokens: 2,
      cache_creation_input_tokens: 3,
    },
  },
};
const end = (stop_reason = 'tool_use') => [
  { type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
];
function anthropicCall(index: number, id: string) {
  return [
    {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name: 'ReadFile', input: {} },
    },
    {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: args.slice(0, 10) },
    },
    {
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: args.slice(10) },
    },
    { type: 'content_block_stop', index },
  ];
}

describe('native streaming tool protocols', () => {
  let server: Awaited<ReturnType<typeof modelServer>> | undefined;
  let box: Awaited<ReturnType<typeof createSandbox>>;
  beforeEach(async () => {
    box = await createSandbox();
    await writeFile(join(box.cwd, 'evidence.txt'), 'verified');
  });
  afterEach(async () => {
    await server?.close();
    server = undefined;
    await removeSandbox(box.root);
  });
  const openai = (wireApi: 'responses' | 'chat-completions') =>
    new OpenAICompatibleProvider({
      apiKey: 'fake-test-key',
      baseUrl: server!.url,
      timeoutMs: 2000,
      wireApi,
    });
  async function loop(provider: LLMProvider) {
    const agent = new AgentLoop(
      provider,
      await ToolExecutor.create(createBuiltinRegistry(), { root: box.cwd, mode: 'plan' }),
      { model: 'exact-model', mode: 'plan', timeoutMs: 2000, maxTurns: 3, maxOutputTokens: 256 },
    );
    const events = [];
    for await (const event of agent.run('read evidence')) events.push(event);
    return events;
  }
  const request: LLMRequest = {
    model: 'test',
    maxOutputTokens: 256,
    messages: [{ role: 'user', content: 'read' }],
    tools: [
      {
        name: 'ReadFile',
        description: 'read',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
  };
  async function collect(provider: LLMProvider) {
    const events: LLMEvent[] = [];
    for await (const event of provider.stream(request, new AbortController().signal))
      events.push(event);
    return events;
  }

  it('maps Chat Completions parallel fragmented calls and tool_call_id results', async () => {
    server = await modelServer((res, _record, turn) =>
      turn === 1
        ? sse(res, [
            chatCall([
              {
                index: 0,
                id: 'read-1',
                type: 'function',
                function: { name: 'Read', arguments: args.slice(0, 9) },
              },
              {
                index: 1,
                id: 'read-2',
                type: 'function',
                function: { name: 'ReadFile', arguments: args.slice(0, 12) },
              },
            ]),
            chatCall([
              { index: 1, function: { arguments: args.slice(12) } },
              { index: 0, function: { name: 'File', arguments: args.slice(9) } },
            ]),
            chunk('', 'tool_calls'),
          ])
        : sse(res, [chunk('verified'), chunk('', 'stop')]),
    );
    expect((await loop(openai('chat-completions'))).at(-1)).toMatchObject({
      reason: 'completed',
      toolCalls: 2,
    });
    const body = server.requests[1]!.body;
    expect(body.messages.filter((m) => m.role === 'tool')).toMatchObject([
      { tool_call_id: 'read-1' },
      { tool_call_id: 'read-2' },
    ]);
    expect(body.messages.find((m) => m.role === 'assistant')).toMatchObject({
      tool_calls: [
        { id: 'read-1', function: { arguments: args } },
        { id: 'read-2', function: { arguments: args } },
      ],
    });
    expect(body.tools).toHaveLength(3);
    expect(JSON.stringify(body)).not.toContain('continuation');
  });

  it('replays Responses opaque reasoning and native output once with store:false', async () => {
    server = await modelServer((res, _record, turn) =>
      turn === 1
        ? sse(res, [
            { type: 'response.output_item.added', output_index: 0, item: reasoning },
            ...responseCall(1),
            ...responseCall(2, 'read-2'),
            responseEnd([reasoning, functionItem(), functionItem('read-2')]),
          ])
        : sse(res, [{ type: 'response.output_text.delta', delta: 'verified' }, responseEnd([])]),
    );
    expect((await loop(openai('responses'))).at(-1)).toMatchObject({
      reason: 'completed',
      toolCalls: 2,
      totalTokens: 56,
      estimated: false,
    });
    const body = server.requests[1]!.body;
    expect(body.store).toBe(false);
    expect(body.include).toEqual(['reasoning.encrypted_content']);
    const input = body.input as unknown as {
      type?: string;
      call_id?: string;
      encrypted_content?: string;
      output?: string;
    }[];
    expect(input.filter((i) => i.type === 'reasoning')).toEqual([reasoning]);
    expect(input.filter((i) => i.type === 'function_call')).toEqual([
      functionItem(),
      functionItem('read-2'),
    ]);
    expect(input.filter((i) => i.type === 'function_call_output').map((i) => i.call_id)).toEqual([
      'read-1',
      'read-2',
    ]);
    expect(
      input
        .filter((i) => i.type === 'function_call_output')
        .every((i) => i.output?.includes('verified')),
    ).toBe(true);
    expect(body.tools?.[0]).toMatchObject({ type: 'function', strict: false, name: 'ReadFile' });
  });

  it.each(['mismatched-item', 'mismatched-completion', 'missing-finish'])(
    'rejects Responses %s without replay or execution',
    async (mode) => {
      const events = responseCall(0);
      if (mode === 'mismatched-item')
        events[1] = {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'different',
          delta: args.slice(0, 9),
        };
      server = await modelServer((res) =>
        sse(res, [
          ...events,
          ...(mode === 'missing-finish'
            ? []
            : [
                responseEnd([
                  {
                    ...functionItem(),
                    call_id: mode === 'mismatched-completion' ? 'different' : 'read-1',
                  },
                ]),
              ]),
        ]),
      );
      await expect(loop(openai('responses'))).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
      expect(server.requests).toHaveLength(1);
    },
  );

  it('does not parse or execute Responses tool arguments when truncated', async () => {
    server = await modelServer((res) =>
      sse(res, [
        responseCall(0)[0],
        {
          type: 'response.function_call_arguments.delta',
          output_index: 0,
          item_id: 'item-read-1',
          delta: '{broken',
        },
        responseEnd([], 'response.incomplete'),
      ]),
    );
    expect((await loop(openai('responses'))).at(-1)).toMatchObject({
      reason: 'length',
      toolCalls: 0,
    });
  });

  it('maps Anthropic tool_use, merged tool_result blocks, signed thinking and cached usage', async () => {
    server = await modelServer((res, _record, turn) =>
      anthropicSse(
        res,
        turn === 1
          ? [
              start,
              {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'thinking', thinking: '', signature: '' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'thinking_delta', thinking: 'opaque-test-thinking' },
              },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'signature_delta', signature: 'test-signature' },
              },
              { type: 'content_block_stop', index: 0 },
              ...anthropicCall(1, 'read-1'),
              ...anthropicCall(2, 'read-2'),
              ...end(),
            ]
          : [
              start,
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'verified' },
              },
              { type: 'content_block_stop', index: 0 },
              ...end('end_turn'),
            ],
      ),
    );
    const model = new AnthropicProvider({
      apiKey: 'fake-anthropic-key',
      baseUrl: server.url.replace(/\/v1$/, ''),
      timeoutMs: 2000,
    });
    const events = await loop(model);
    expect(events.at(-1)).toMatchObject({
      reason: 'completed',
      toolCalls: 2,
      totalTokens: 46,
      estimated: false,
    });
    expect(JSON.stringify(events)).not.toContain('opaque-test-thinking');
    const body = server.requests[1]!.body as unknown as {
      model: string;
      messages: { role: string; content: unknown[] }[];
      tools: unknown[];
    };
    expect(server.requests[1]?.url).toBe('/v1/messages');
    expect(body.messages[1]?.content[0]).toMatchObject({
      type: 'thinking',
      signature: 'test-signature',
    });
    expect(body.messages[2]?.content).toHaveLength(2);
    expect(body.messages[2]?.content).toMatchObject([
      { type: 'tool_result', tool_use_id: 'read-1' },
      { type: 'tool_result', tool_use_id: 'read-2' },
    ]);
    expect(body.tools[0]).toMatchObject({ name: 'ReadFile', input_schema: { type: 'object' } });
  });

  it.each(['malformed-json', 'missing-stop', 'wrong-index'])(
    'rejects Anthropic %s and keeps vendor text out of errors',
    async (mode) => {
      const events = anthropicCall(0, 'read-1');
      if (mode === 'malformed-json')
        events[2] = {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{broken' },
        };
      if (mode === 'wrong-index')
        events[1] = {
          type: 'content_block_delta',
          index: 3,
          delta: { type: 'input_json_delta', partial_json: args.slice(0, 10) },
        };
      server = await modelServer((res) =>
        anthropicSse(res, [start, ...events, ...(mode === 'missing-stop' ? [] : end())]),
      );
      await expect(
        collect(
          new AnthropicProvider({
            apiKey: 'fake-key',
            baseUrl: server.url.replace(/\/v1$/, ''),
            timeoutMs: 1000,
          }),
        ),
      ).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
      expect(server.requests).toHaveLength(1);
    },
  );

  it('classifies Anthropic authentication failures without echoing credentials or response bodies', async () => {
    server = await modelServer((res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'sensitive-vendor-body' },
        }),
      );
    });
    const error = await collect(
      new AnthropicProvider({
        apiKey: 'fake-key',
        baseUrl: server.url.replace(/\/v1$/, ''),
        timeoutMs: 1000,
      }),
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'MODEL_AUTH' });
    expect((error as Error).message).not.toContain('sensitive-vendor-body');
    expect(server.requests).toHaveLength(1);
  });
});
