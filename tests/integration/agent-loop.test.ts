import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentLoop } from '../../src/core/agent-loop.js';
import type { AgentEvent, AgentOptions } from '../../src/core/agent-loop.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import type { LLMEvent, LLMProvider, LLMRequest } from '../../src/providers/types.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const options: AgentOptions = {
  model: 'test',
  mode: 'default',
  maxTurns: 10,
  timeoutMs: 10_000,
  maxOutputTokens: 512,
};
const call = (name: string, input: unknown, callId = 'call-1', index = 0): LLMEvent => ({
  type: 'tool_call_delta',
  index,
  callId,
  name,
  arguments: JSON.stringify(input),
});
const stop: LLMEvent = { type: 'finish', reason: 'stop' };
const tools: LLMEvent = { type: 'finish', reason: 'tool_calls' };
async function collect(agent: AgentLoop, signal?: AbortSignal) {
  const events: AgentEvent[] = [];
  for await (const event of agent.run('修复加法并验证', signal)) events.push(event);
  return events;
}

describe('Agent Loop with real tools in a temporary project', () => {
  let box: Awaited<ReturnType<typeof createSandbox>>;
  let requests: LLMRequest[];
  beforeEach(async () => {
    box = await createSandbox();
    requests = [];
  });
  afterEach(async () => {
    await removeSandbox(box.root);
  });
  function provider(round: (request: LLMRequest, turn: number) => LLMEvent[]): LLMProvider {
    return {
      id: 'scripted-test',
      capabilities: { streaming: true, toolCalling: true },
      async *stream(request) {
        requests.push(structuredClone(request));
        yield* round(request, requests.length);
      },
    };
  }
  async function create(model: LLMProvider, patch: Partial<AgentOptions> = {}, approve = false) {
    const settings = { ...options, ...patch };
    const executor = await ToolExecutor.create(createBuiltinRegistry(), {
      root: box.cwd,
      mode: settings.mode,
      approve: async () => approve,
    });
    return new AgentLoop(model, executor, settings);
  }

  it('searches, reads, edits using the returned revision, executes a test and reports evidence', async () => {
    await writeFile(join(box.cwd, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
    await writeFile(
      join(box.cwd, 'check.mjs'),
      "import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; assert.equal(sum(2,3),5); console.log('verified');",
    );
    const agent = await create(
      provider((request, turn) => {
        const result = JSON.parse(
          request.messages.at(-1)?.role === 'tool' ? request.messages.at(-1)!.content : '{}',
        ) as { data?: { revision?: string }; content?: string };
        if (turn === 1) return [call('Glob', { pattern: '*.mjs' }, 'search'), tools];
        if (turn === 2)
          return [call('Grep', { pattern: 'a - b', fileGlob: '*.mjs' }, 'grep'), tools];
        if (turn === 3) return [call('ReadFile', { path: 'sum.mjs' }, 'read'), tools];
        if (turn === 4)
          return [
            call(
              'EditFile',
              {
                path: 'sum.mjs',
                oldText: 'a - b',
                newText: 'a + b',
                expectedRevision: result.data?.revision,
              },
              'edit',
            ),
            tools,
          ];
        if (turn === 5)
          return [
            call(
              'Bash',
              {
                command: `${process.platform === 'win32' ? '& ' : ''}'${process.execPath}' check.mjs`,
              },
              'test',
            ),
            tools,
          ];
        expect(result.content).toContain('verified');
        return [{ type: 'text_delta', text: '加法已修复，测试 verified。' }, stop];
      }),
      {},
      true,
    );
    const events = await collect(agent);
    expect(events.filter((e) => e.type === 'tool_result').map((e) => e.result.ok)).toEqual([
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(events.at(-1)).toMatchObject({
      reason: 'completed',
      turns: 6,
      toolCalls: 5,
      estimated: true,
    });
    expect(await readFile(join(box.cwd, 'sum.mjs'), 'utf8')).toContain('a + b');
    expect(requests[5]?.messages.filter((m) => m.role === 'tool').map((m) => m.callId)).toEqual([
      'search',
      'grep',
      'read',
      'edit',
      'test',
    ]);
  });

  it('returns tool failures to the model and lets it correct its request', async () => {
    await writeFile(join(box.cwd, 'exists.txt'), 'evidence');
    const agent = await create(
      provider((request, turn) => {
        if (turn === 1) return [call('ReadFile', { path: 'missing.txt' }, 'missing'), tools];
        if (turn === 2) {
          expect(JSON.parse(request.messages.at(-1)!.content)).toMatchObject({
            ok: false,
            error: { code: 'FILE_NOT_FOUND' },
          });
          return [call('ReadFile', { path: 'exists.txt' }, 'corrected'), tools];
        }
        return [stop];
      }),
    );
    expect((await collect(agent)).at(-1)).toMatchObject({ reason: 'completed', toolCalls: 2 });
  });

  it('validates the entire batch before any tool executes', async () => {
    const agent = await create(
      provider(() => [
        call('WriteFile', { path: 'must-not-exist.txt', content: 'bad' }),
        {
          type: 'tool_call_delta',
          index: 1,
          callId: 'call-2',
          name: 'WriteFile',
          arguments: '{broken',
        },
        tools,
      ]),
      { mode: 'accept-edits' },
    );
    await expect(collect(agent)).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    await expect(readFile(join(box.cwd, 'must-not-exist.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(agent.history).toHaveLength(2);
  });

  it.each(
    (
      [
        [{ type: 'tool_call_delta', index: -1, callId: 'a', name: 'ReadFile', arguments: '{}' }],
        [call('ReadFile', {}, 'bad/id')],
        [call('ReadFile', {}, 'a'), call('ReadFile', {}, 'a', 1)],
        [call('ReadFile', {}, 'a'), { type: 'tool_call_delta', index: 0, callId: 'different' }],
        [{ type: 'tool_call_delta', index: 0, callId: 'a', name: 'ReadFile', arguments: '[]' }],
        [
          {
            type: 'tool_call_delta',
            index: 0,
            callId: 'a',
            name: 'ReadFile',
            arguments: 'x'.repeat(256 * 1024 + 1),
          },
        ],
      ] as LLMEvent[][]
    ).map((deltas) => ({ deltas })),
  )('rejects invalid call identifiers, indexes, JSON or size (%#)', async ({ deltas }) => {
    await expect(collect(await create(provider(() => [...deltas, tools])))).rejects.toMatchObject({
      code: 'MODEL_PROTOCOL',
    });
  });

  it('exposes only read tools in Plan and the executor blocks a model that still requests a write', async () => {
    const agent = await create(
      provider((request, turn) => {
        expect(request.tools?.map((t) => t.name)).toEqual(['ReadFile', 'Glob', 'Grep']);
        return [
          call('WriteFile', { path: 'blocked.txt', content: 'write' }, `write-${turn}`),
          tools,
        ];
      }),
      { mode: 'plan' },
      true,
    );
    const events = await collect(agent);
    expect(events.at(-1)).toMatchObject({ reason: 'repeated_failures', toolCalls: 3 });
    expect(
      events
        .filter((e) => e.type === 'tool_result')
        .every((e) => e.result.error?.code === 'TOOL_PERMISSION'),
    ).toBe(true);
    await expect(readFile(join(box.cwd, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects repeated call IDs across turns without executing them twice', async () => {
    const agent = await create(provider(() => [call('Glob', { pattern: '*' }), tools]));
    const events: AgentEvent[] = [];
    const run = async () => {
      for await (const event of agent.run('inspect')) events.push(event);
    };
    await expect(run()).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1);
  });

  it('never executes a truncated tool call or a call without successful finish', async () => {
    for (const tail of [[{ type: 'finish', reason: 'length' }], []] as LLMEvent[][]) {
      const agent = await create(
        provider(() => [call('WriteFile', { path: 'truncated.txt', content: 'write' }), ...tail]),
        { mode: 'accept-edits' },
      );
      if (tail.length)
        expect((await collect(agent)).at(-1)).toMatchObject({ reason: 'length', toolCalls: 0 });
      else await expect(collect(agent)).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    }
    await expect(readFile(join(box.cwd, 'truncated.txt'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('stops at round, token and context budgets', async () => {
    const agent = await create(
      provider((_request, turn) => [call('Glob', { pattern: '*' }, `c-${turn}`), tools]),
      { maxTurns: 2 },
    );
    expect((await collect(agent)).at(-1)).toMatchObject({
      reason: 'max_turns',
      turns: 2,
      toolCalls: 2,
    });
    const budget = await create(
      provider(() => [
        call('WriteFile', { path: 'budget.txt', content: 'no' }),
        { type: 'usage', inputTokens: 2, outputTokens: 9, estimated: false },
        tools,
      ]),
      { maxTotalTokens: 10, mode: 'accept-edits' },
    );
    expect((await collect(budget)).at(-1)).toMatchObject({
      reason: 'token_budget',
      toolCalls: 0,
      estimated: false,
    });
    await expect(
      collect(
        await create(
          provider(() => [stop]),
          { maxContextCharacters: 10 },
        ),
      ),
    ).rejects.toMatchObject({ code: 'CONTEXT_LIMIT' });
  });

  it('preserves a completed write when the user cancels and skips subsequent calls', async () => {
    const controller = new AbortController();
    const agent = await create(
      provider(() => [
        call('WriteFile', { path: 'committed.txt', content: 'saved' }, 'saved'),
        call('WriteFile', { path: 'skipped.txt', content: 'no' }, 'skipped', 1),
        tools,
      ]),
      { mode: 'accept-edits' },
    );
    const run = async () => {
      for await (const event of agent.run('write', controller.signal))
        if (event.type === 'tool_result' && event.result.ok) controller.abort();
    };
    await expect(run()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(await readFile(join(box.cwd, 'committed.txt'), 'utf8')).toBe('saved');
    expect(
      agent.history
        .filter((m) => m.role === 'tool')
        .map((m) => JSON.parse(m.content) as { callId: string; error?: { code: string } }),
    ).toMatchObject([{ callId: 'saved' }, { callId: 'skipped', error: { code: 'AGENT_STOPPED' } }]);
    await expect(readFile(join(box.cwd, 'skipped.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('enforces a deadline while the model is waiting and refuses concurrent runs', async () => {
    const model: LLMProvider = {
      id: 'waiting',
      capabilities: { streaming: true, toolCalling: true },
      async *stream(_request, signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        yield stop;
      },
    };
    const agent = await create(model, { timeoutMs: 50 });
    const iterator = agent.run('wait')[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await expect(collect(agent)).rejects.toMatchObject({ code: 'BUSY' });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'MODEL_TIMEOUT' });
    await expect(collect(agent, AbortSignal.abort())).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects events after finish and stops unbounded event streams', async () => {
    await expect(
      collect(await create(provider(() => [stop, { type: 'text_delta', text: 'late' }]))),
    ).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
    await expect(
      collect(
        await create(
          provider(() => Array.from({ length: 10_001 }, () => ({ type: 'text_delta', text: '' }))),
        ),
      ),
    ).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
  });
});
