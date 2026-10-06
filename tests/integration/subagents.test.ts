import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SubagentPool, SUBAGENT_PROMPT } from '../../src/core/subagents.js';
import type { SubagentPoolOptions, SubagentProgress } from '../../src/core/subagents.js';
import { TokenBudget } from '../../src/core/token-budget.js';
import { defaultSubagents } from '../../src/core/subagent-schema.js';
import { defaultContext } from '../../src/core/context.js';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { SessionStore, recoverState } from '../../src/core/session.js';
import { SubagentEvidence } from '../../src/core/subagent-evidence.js';
import { MockProvider } from '../../src/providers/mock.js';
import type { LLMEvent, LLMProvider, LLMRequest } from '../../src/providers/types.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import type { ExecutorOptions } from '../../src/tools/executor.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const limits = {
  model: 'fixture',
  maxTurns: 6,
  timeoutMs: 5000,
  maxOutputTokens: 512,
  maxTotalTokens: 200_000,
  context: defaultContext,
};
function call(name: string, input: unknown): LLMEvent {
  return {
    type: 'tool_call_delta',
    index: 0,
    callId: 'same-child-call',
    name,
    arguments: JSON.stringify(input),
  };
}
function answer(summary = 'summary', evidence: unknown[] = []): LLMEvent {
  return { type: 'text_delta', text: JSON.stringify({ summary, evidence }) };
}
class Script implements LLMProvider {
  readonly id = 'fixture';
  readonly capabilities = { streaming: true, toolCalling: true };
  readonly requests: LLMRequest[] = [];
  constructor(
    private readonly fn: (
      request: LLMRequest,
      round: number,
      signal: AbortSignal,
    ) => AsyncIterable<LLMEvent>,
  ) {}
  stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    this.requests.push(structuredClone(request));
    return this.fn(request, this.requests.length, signal);
  }
}
const usage: LLMEvent = { type: 'usage', inputTokens: 40, outputTokens: 10, estimated: false };
function reader(wait = 0): Script {
  return new Script(async function* (request, round, signal) {
    if (wait) await delay(wait, undefined, { signal });
    const prompt = request.messages.find((message) => message.role === 'user')!.content;
    const { goal } = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as { goal: string };
    if (round === 1) {
      yield call('ReadFile', { path: goal });
      yield usage;
      yield { type: 'finish', reason: 'tool_calls' };
    } else {
      yield answer(`read ${goal}`, [{ path: goal, line: 1 }]);
      yield usage;
      yield { type: 'finish', reason: 'stop' };
    }
  });
}

describe('read-only SubAgent pool', () => {
  let box: Awaited<ReturnType<typeof createSandbox>>;
  beforeEach(async () => {
    box = await createSandbox();
    await writeFile(join(box.cwd, 'a.txt'), 'first\nsecond');
    await writeFile(join(box.cwd, 'b.txt'), 'other');
  });
  afterEach(async () => {
    await removeSandbox(box.root);
  });
  async function setup(
    extra: Partial<SubagentPoolOptions> = {},
    policy: Omit<ExecutorOptions, 'root'> = {},
  ) {
    const registry = createBuiltinRegistry();
    const providers: Script[] = [];
    const progress: SubagentProgress[] = [];
    const budget = extra.budget ?? new TokenBudget(200_000);
    const pool = new SubagentPool(registry, {
      settings: { ...defaultSubagents, enabled: true },
      budget,
      agent: limits,
      provider: () => {
        const provider = reader(30);
        providers.push(provider);
        return provider;
      },
      progress: (event) => progress.push(event),
      ...extra,
    });
    const executor = await ToolExecutor.create(registry, { root: box.cwd, ...policy });
    pool.bind(executor);
    return { registry, pool, executor, providers, progress, budget };
  }
  it('executes independent reads concurrently with isolated histories/call ids and trusted attribution', async () => {
    const { pool, providers, progress, budget, executor } = await setup();
    const results = await pool.delegate({
      tasks: [
        { id: 'one', goal: 'a.txt' },
        { id: 'two', goal: 'b.txt' },
      ],
    });
    expect(results.map((result) => result.status)).toEqual(['completed', 'completed']);
    expect(results[0]!.evidence[0]).toMatchObject({
      path: 'a.txt',
      line: 1,
      kind: 'read',
      revision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(new Set(results.map((result) => result.agentId)).size).toBe(2);
    expect(pool.metrics.peakActive).toBe(2);
    expect(providers).toHaveLength(2);
    expect(providers[0]!.requests[0]!.tools!.map((tool) => tool.name)).toEqual([
      'ReadFile',
      'Glob',
      'Grep',
    ]);
    expect(JSON.stringify(providers[0]!.requests)).not.toContain('read b.txt');
    for (const provider of providers) {
      expect(provider.requests[0]!.messages).toHaveLength(2);
      const result = JSON.parse(provider.requests[1]!.messages.at(-1)!.content);
      expect(result.agentId).toBe(
        results.find((item) => item.evidence[0]?.path === result.data.path)!.agentId,
      );
    }
    expect(progress.every((event) => event.parentAgentId === executor.agentId)).toBe(true);
    expect(progress.map((event) => event.sequence)).toEqual(progress.map((_, index) => index + 1));
    expect(JSON.stringify(progress)).not.toContain('first');
    expect(budget.snapshot).toMatchObject({ used: 200, reserved: 0, requests: 4 });
  });
  it('keeps successful results beside failure, rejects duplicates, and supports explicit retry with a new id', async () => {
    let fail = true;
    const other = await setup({
      provider: () =>
        new Script(async function* (request) {
          if (fail && request.messages[1]!.content.includes('b.txt'))
            throw new Error('private failure');
          yield answer();
          yield usage;
          yield { type: 'finish', reason: 'stop' };
        }),
    });
    const results = await other.pool.delegate({
      tasks: [
        { id: 'one', goal: 'a.txt' },
        { id: 'two', goal: 'b.txt' },
      ],
    });
    expect(results.map((item) => item.status)).toEqual(['completed', 'failed']);
    expect(JSON.stringify(results)).not.toContain('private failure');
    fail = false;
    expect((await other.pool.delegate({ tasks: [{ id: 'two', goal: 'b.txt' }] }))[0]!.code).toBe(
      'SUBAGENT_DUPLICATE',
    );
    expect(
      (await other.pool.delegate({ tasks: [{ id: 'retry', goal: 'b.txt', retryOf: 'two' }] }))[0]!
        .status,
    ).toBe('completed');
    expect(
      (
        await other.pool.delegate({ tasks: [{ id: 'bad-retry', goal: 'a.txt', retryOf: 'one' }] })
      )[0]!.code,
    ).toBe('SUBAGENT_RETRY_INVALID');
  });
  it('cancels running and queued children, stops new requests and releases all reservations', async () => {
    let start!: () => void;
    const started = new Promise<void>((done) => {
      start = done;
    });
    let requests = 0;
    const { pool, budget } = await setup({
      settings: { ...defaultSubagents, enabled: true, concurrency: 1 },
      provider: () =>
        new Script(async function* (_request, _round, signal) {
          requests++;
          start();
          await delay(3000, undefined, { signal });
          yield answer();
          yield { type: 'finish', reason: 'stop' };
        }),
    });
    const cancel = new AbortController();
    const pending = pool.delegate(
      {
        tasks: [
          { id: 'one', goal: 'a' },
          { id: 'two', goal: 'b' },
          { id: 'three', goal: 'c' },
        ],
      },
      cancel.signal,
    );
    await started;
    cancel.abort();
    expect((await pending).map((result) => result.status)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
    expect(requests).toBe(1);
    expect(budget.snapshot).toMatchObject({ reserved: 0, estimated: true });
    expect(pool.metrics.queued).toBe(0);
  });
  it('includes queue time in deadlines and isolates timeout failure', async () => {
    const { pool, budget } = await setup({
      settings: { ...defaultSubagents, enabled: true, concurrency: 1, timeoutMs: 100 },
      provider: () =>
        new Script(async function* (_request, _round, signal) {
          await delay(1000, undefined, { signal });
          yield answer();
          yield { type: 'finish', reason: 'stop' };
        }),
    });
    const results = await pool.delegate({
      tasks: [
        { id: 'one', goal: 'a' },
        { id: 'two', goal: 'b' },
      ],
    });
    expect(
      results.every((result) => result.status === 'failed' && result.code === 'SUBAGENT_TIMEOUT'),
    ).toBe(true);
    expect(budget.snapshot.reserved).toBe(0);
  });
  it('does not start a provider stream when shared or aggregate child budget is insufficient', async () => {
    let requests = 0;
    const factory = () =>
      new Script(async function* () {
        requests++;
        yield answer();
        yield { type: 'finish', reason: 'stop' };
      });
    const { pool, budget } = await setup({ budget: new TokenBudget(1024), provider: factory });
    expect(
      (
        await pool.delegate({
          tasks: [
            { id: 'one', goal: 'a' },
            { id: 'two', goal: 'b' },
          ],
        })
      ).every((result) => result.status === 'budget_exhausted'),
    ).toBe(true);
    expect(requests).toBe(0);
    expect(budget.snapshot.requests).toBe(0);
    const other = await setup({
      settings: { ...defaultSubagents, enabled: true, maxTotalTokens: 1024 },
      provider: factory,
    });
    expect((await other.pool.delegate({ tasks: [{ id: 'three', goal: 'c' }] }))[0]!.status).toBe(
      'budget_exhausted',
    );
    expect(requests).toBe(0);
  });
  it('consumes unknown usage and admits only requests that fit concurrent reservations', async () => {
    const { pool, budget } = await setup({
      budget: new TokenBudget(15_000),
      settings: { ...defaultSubagents, enabled: true, concurrency: 4 },
      provider: () =>
        new Script(async function* (_request, _round, signal) {
          await delay(50, undefined, { signal });
          yield answer();
          yield { type: 'finish', reason: 'stop' };
        }),
    });
    const results = await pool.delegate({
      tasks: ['one', 'two', 'three', 'four'].map((id) => ({ id, goal: 'a' })),
    });
    expect(results.some((result) => result.status === 'budget_exhausted')).toBe(true);
    expect(results.some((result) => result.status === 'completed')).toBe(true);
    expect(budget.snapshot).toMatchObject({ reserved: 0, estimated: true });
    expect(budget.snapshot.used).toBeLessThanOrEqual(15_000);
    expect(results.reduce((total, result) => total + result.tokens, 0)).toBe(budget.snapshot.used);
  });
  it.each(['WriteFile', 'Bash', 'Task', 'MCP_fixture', 'SkillRead'])(
    'denies forged %s calls despite allow/approval settings',
    async (name) => {
      const provider = new Script(async function* (_request, round) {
        if (round === 1) {
          yield call(
            name,
            name === 'WriteFile'
              ? { path: 'pwn.txt', content: 'changed' }
              : name === 'Task'
                ? { tasks: [{ id: 'nested', goal: 'x' }] }
                : name === 'Bash'
                  ? { command: 'echo changed' }
                  : { resource: 'x' },
          );
          yield { type: 'finish', reason: 'tool_calls' };
        } else {
          yield answer();
          yield { type: 'finish', reason: 'stop' };
        }
      });
      const { pool, executor } = await setup(
        { provider: () => provider },
        { mode: 'accept-edits', approve: async () => true },
      );
      await pool.delegate({ tasks: [{ id: 'one', goal: 'a' }] });
      const result = JSON.parse(provider.requests.at(-1)!.messages.at(-1)!.content);
      expect(result.ok).toBe(false);
      expect(result.agentId).not.toBe(executor.agentId);
      await expect(readFile(join(box.cwd, 'pwn.txt'))).rejects.toThrow();
      expect(provider.requests[0]!.tools!.some((tool) => tool.name === name)).toBe(false);
    },
  );
  it('enforces inherited deny paths and cannot turn a denied read into evidence', async () => {
    const { pool, providers } = await setup(
      {},
      { rules: [{ source: 'user', decision: 'deny', path: 'a.txt' }] },
    );
    const [result] = await pool.delegate({ tasks: [{ id: 'one', goal: 'a.txt' }] });
    expect(result!.status).toBe('failed');
    expect(JSON.parse(providers[0]!.requests.at(-1)!.messages.at(-1)!.content).ok).toBe(false);
  });
  it('rechecks parent policy after a child read approval and attributes denied audits to the child', async () => {
    const parent = await ToolExecutor.create(createBuiltinRegistry(), {
      root: box.cwd,
      rules: [{ source: 'user', decision: 'ask', tool: 'ReadFile' }],
    });
    let entered!: () => void, release!: (value: boolean) => void;
    const gate = new Promise<void>((done) => {
      entered = done;
    });
    const child = await parent.fork({
      mode: 'plan',
      agentId: 'child-policy',
      allowTools: ['ReadFile'],
      approve: async () => {
        entered();
        return new Promise<boolean>((done) => {
          release = done;
        });
      },
    });
    const pending = child.execute({ callId: 'read', name: 'ReadFile', input: { path: 'a.txt' } });
    await gate;
    parent.setMode('plan');
    release(true);
    expect(await pending).toMatchObject({
      ok: false,
      agentId: 'child-policy',
      error: { code: 'TOOL_PERMISSION' },
    });
    expect(child.auditLog.at(-1)).toMatchObject({ agentId: 'child-policy', decision: 'deny' });
  });
  it('cancels an unstarted request reservation when the event consumer returns', async () => {
    const budget = new TokenBudget(200_000);
    const provider = reader();
    const executor = await ToolExecutor.create(createBuiltinRegistry(), {
      root: box.cwd,
      mode: 'plan',
    });
    const agent = new AgentLoop(provider, executor, {
      ...limits,
      mode: 'plan',
      accounting: budget,
    });
    for await (const event of agent.run('a.txt')) if (event.type === 'turn_start') break;
    expect(provider.requests).toHaveLength(0);
    expect(budget.snapshot).toMatchObject({ reserved: 0, used: 0, requests: 0 });
  });
  it('inherits lifecycle hooks in Plan and blocks model requests when a required hook refuses', async () => {
    const modes: string[] = [];
    const { pool, providers } = await setup(
      {},
      {
        hooks: async (event) => {
          modes.push(event.mode);
          return { decision: event.event === 'SessionStart' ? 'block' : 'continue' };
        },
      },
    );
    const [result] = await pool.delegate({ tasks: [{ id: 'one', goal: 'a' }] });
    expect(result!.code).toBe('HOOK_FAILED');
    expect(providers[0]!.requests).toHaveLength(0);
    expect(modes.every((mode) => mode === 'plan')).toBe(true);
  });
  it('does not reuse parent history, skills, memory or widen the parent whitelist', async () => {
    const { pool, providers } = await setup({}, { allowTools: ['Task', 'ReadFile'] });
    await pool.delegate({ tasks: [{ id: 'one', goal: 'a.txt', tools: ['ReadFile', 'Glob'] }] });
    expect(providers[0]!.requests[0]!.tools!.map((tool) => tool.name)).toEqual(['ReadFile']);
    expect(providers[0]!.requests[0]!.messages[1]!.content.startsWith(SUBAGENT_PROMPT)).toBe(true);
  });
  it('rejects unobserved citations, listing line numbers and truncated read lines', async () => {
    const evidence = new SubagentEvidence();
    evidence.observe({
      name: 'ReadFile',
      callId: 'x',
      ok: true,
      content: '1: first\n2: parti...',
      truncated: true,
      data: { path: 'a.txt', revision: 'a'.repeat(64), endLine: 999 },
    });
    expect(() => evidence.verify([{ path: 'a.txt', line: 999, note: '' }])).toThrow();
    expect(() => evidence.verify([{ path: 'a.txt', line: 2, note: '' }])).toThrow();
    expect(evidence.verify([{ path: 'a.txt', line: 1, note: '' }])[0]!.kind).toBe('read');
    evidence.observe({
      name: 'Glob',
      callId: 'y',
      ok: true,
      content: 'b.txt',
      data: { paths: ['b.txt'] },
    });
    expect(() => evidence.verify([{ path: 'b.txt', line: 1, note: '' }])).toThrow();
    expect(evidence.verify([{ path: 'b.txt', note: '' }])[0]!.kind).toBe('listing');
    evidence.observe({
      name: 'Grep',
      callId: 'z',
      ok: true,
      content: 'b.txt:2: other',
      data: { matches: [{ path: 'b.txt', line: 2, text: 'other' }] },
    });
    expect(evidence.verify([{ path: 'b.txt', line: 2, note: '' }])[0]!.kind).toBe('match');
    evidence.observe({
      name: 'ReadFile',
      callId: 'new',
      ok: true,
      content: '2: changed',
      data: { path: 'a.txt', revision: 'b'.repeat(64) },
    });
    expect(() => evidence.verify([{ path: 'a.txt', line: 1, note: '' }])).toThrow();
  });
  it('bounds evidence metadata and explicitly marks overflow', () => {
    const evidence = new SubagentEvidence();
    evidence.observe({
      name: 'Glob',
      callId: 'x',
      ok: true,
      content: '',
      data: { paths: Array.from({ length: 200 }, (_, index) => `${index}.txt`) },
    });
    expect(evidence.overflow).toBe(true);
    expect(() => evidence.verify([{ path: '199.txt', note: '' }])).toThrow();
  });
  it('rejects credentials before invoking a new model and redacts final summaries', async () => {
    let requests = 0;
    const secret = 'fixture-private-key-long-value';
    const { pool } = await setup({
      agent: { ...limits, sensitiveValues: [secret] },
      provider: () =>
        new Script(async function* () {
          requests++;
          yield answer(`found ${secret}`);
          yield { type: 'finish', reason: 'stop' };
        }),
    });
    const result = await pool.delegate({
      tasks: [
        { id: 'secret', goal: secret },
        { id: 'safe', goal: 'safe' },
      ],
    });
    expect(result[0]!.code).toBe('SUBAGENT_SENSITIVE_INPUT');
    expect(requests).toBe(1);
    expect(result[1]!.summary).toContain('[REDACTED]');
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('keeps all task statuses in bounded valid JSON even when large summaries contain escapes', async () => {
    await mkdir(join(box.cwd, 'dir'));
    const { executor } = await setup({
      agent: { ...limits, context: { ...defaultContext, toolResultBytes: 2048 } },
      provider: () =>
        new Script(async function* () {
          yield answer('中文"\\\n'.repeat(400));
          yield usage;
          yield { type: 'finish', reason: 'stop' };
        }),
    });
    const tasks = ['one', 'two', 'three', 'four'].map((id) => ({ id, goal: 'a' }));
    const result = await executor.execute({
      callId: 'x'.repeat(128),
      name: 'Task',
      input: { tasks },
    });
    const parsed = JSON.parse(result.content);
    expect(parsed.tasks.map((item: { id: string }) => item.id)).toEqual(
      tasks.map((item) => item.id),
    );
    expect(
      parsed.tasks.every(
        (item: { truncated: boolean; status: string }) =>
          item.truncated && item.status === 'completed',
      ),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(2048);
  });
  it('enforces total task count, validates schemas and treats duplicate ids within a batch once', async () => {
    const { pool, providers } = await setup({
      settings: { ...defaultSubagents, enabled: true, maxTasks: 1 },
    });
    const results = await pool.delegate({
      tasks: [
        { id: 'one', goal: 'a.txt' },
        { id: 'one', goal: 'b.txt' },
        { id: 'two', goal: 'b.txt' },
      ],
    });
    expect(results.map((item) => item.code)).toEqual([
      'OK',
      'SUBAGENT_DUPLICATE',
      'SUBAGENT_LIMIT',
    ]);
    expect(providers).toHaveLength(1);
    await expect(
      pool.delegate({ tasks: [{ id: 'bad', goal: 'a', tools: ['WriteFile'] }] }),
    ).rejects.toMatchObject({ code: 'SUBAGENT_INVALID' });
  });
  it('accounts parent plus children, persists ids across compaction and blocks restored delegation', async () => {
    const registry = createBuiltinRegistry();
    const budget = new TokenBudget(200_000);
    let intent: Awaited<ReturnType<typeof SessionStore.inspect>>['state'] | undefined;
    const pool = new SubagentPool(registry, {
      settings: { ...defaultSubagents, enabled: true },
      budget,
      agent: limits,
      provider: () =>
        new Script(async function* (request, round, signal) {
          if (round === 1)
            intent = (await SessionStore.inspect(box.userDirectory, session.owner.id)).state;
          const prompt = request.messages[1]!.content;
          const { goal } = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)) as {
            goal: string;
          };
          if (round === 1) yield call('ReadFile', { path: goal });
          else yield answer(`read ${goal}`, [{ path: goal, line: 1 }]);
          if (signal.aborted) throw new Error('cancelled');
          yield usage;
          yield { type: 'finish', reason: round === 1 ? 'tool_calls' : 'stop' };
        }),
    });
    const parent = await ToolExecutor.create(registry, { root: box.cwd, mode: 'plan' });
    pool.bind(parent);
    const session = await SessionStore.create(box.userDirectory, {
      cwd: box.cwd,
      provider: 'fixture',
      model: 'fixture',
      mode: 'plan',
    });
    const provider = new Script(async function* (_request, round) {
      yield round === 1
        ? call('Task', {
            tasks: [
              { id: 'one', goal: 'a.txt' },
              { id: 'two', goal: 'b.txt' },
            ],
          })
        : { type: 'text_delta', text: 'parent summary' };
      yield usage;
      yield { type: 'finish', reason: round === 1 ? 'tool_calls' : 'stop' };
    });
    try {
      const loop = new AgentLoop(provider, parent, {
        ...limits,
        mode: 'plan',
        accounting: budget,
        aggregateTokens: true,
        session,
        subagentIds: () => pool.usedIds,
        subagentRecoveryLimit: defaultSubagents.maxTotalTokens,
      });
      let final;
      for await (const event of loop.run('parent-private-history'))
        if (event.type === 'finish') final = event;
      expect(final!.totalTokens).toBe(300);
      expect(intent!.pendingSubagentTokens).toBe(60_000);
      const crash = recoverState(intent!);
      expect(crash.totalTokens).toBe(60_050);
      expect(crash.estimated).toBe(true);
      expect(crash.pendingSubagentTokens).toBeUndefined();
      const { state } = await SessionStore.inspect(box.userDirectory, session.owner.id);
      expect(state.subagentIds).toEqual(['one', 'two']);
      expect(state.totalTokens).toBe(300);
      expect(state.pendingSubagentTokens).toBeUndefined();
      // IDs remain independently persisted when original Task messages are compacted away.
      const resumed = await setup({
        usedIds: state.subagentIds!,
        budget: new TokenBudget(200_000, state.totalTokens, state.estimated),
      });
      expect(
        (await resumed.pool.delegate({ tasks: [{ id: 'one', goal: 'a.txt' }] }))[0]!.code,
      ).toBe('SUBAGENT_REPLAY_BLOCKED');
      expect(resumed.providers).toHaveLength(0);
    } finally {
      await session.close();
    }
  });
  it('blocks uncertain Task calls in historical checkpoints without calling the provider', async () => {
    const { pool, providers } = await setup({
      history: [
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              callId: 'old',
              name: 'Task',
              arguments: JSON.stringify({ tasks: [{ id: 'one', goal: 'a' }] }),
            },
          ],
        },
      ],
    });
    expect((await pool.delegate({ tasks: [{ id: 'one', goal: 'a' }] }))[0]!.code).toBe(
      'SUBAGENT_REPLAY_BLOCKED',
    );
    expect(providers).toHaveLength(0);
  });
  it('handles strict invalid final JSON and limited turns without accepting prose as evidence', async () => {
    const { pool } = await setup({
      provider: () => new MockProvider({ delayMs: 0, response: 'not-json-private-output' }),
    });
    expect((await pool.delegate({ tasks: [{ id: 'one', goal: 'a' }] }))[0]).toMatchObject({
      status: 'failed',
      code: 'SUBAGENT_INVALID_RESULT',
      summary: '',
    });
    const other = await setup({ settings: { ...defaultSubagents, enabled: true, maxTurns: 1 } });
    expect((await other.pool.delegate({ tasks: [{ id: 'one', goal: 'a.txt' }] }))[0]!.code).toBe(
      'SUBAGENT_STOPPED',
    );
  });
});
