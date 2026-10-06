import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { WorktreeManager } from '../../src/tools/worktrees.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { SubagentPool } from '../../src/core/subagents.js';
import { worktreeExecution } from '../../src/core/worktree-tasks.js';
import { defaultSubagents } from '../../src/core/subagent-schema.js';
import { TokenBudget } from '../../src/core/token-budget.js';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { SessionStore, recoverState } from '../../src/core/session.js';
import { MockProvider } from '../../src/providers/mock.js';
import type { LLMEvent, LLMRequest, LLMProvider } from '../../src/providers/types.js';
import { createGitSandbox } from '../support/git-repo.js';
import { removeSandbox } from '../support/sandbox.js';

const limits = {
  model: 'fixture',
  maxTurns: 8,
  timeoutMs: 30_000,
  maxOutputTokens: 512,
  maxTotalTokens: 200_000,
};
const call = (name: string, input: unknown): LLMEvent => ({
  type: 'tool_call_delta',
  index: 0,
  callId: `call-${name}`,
  name,
  arguments: JSON.stringify(input),
});
const text: LLMEvent = {
  type: 'text_delta',
  text: JSON.stringify({ summary: 'observed change', evidence: [{ path: 'same.txt', line: 1 }] }),
};
class Editor implements LLMProvider {
  readonly id = 'editor';
  readonly capabilities = { streaming: true, toolCalling: true };
  round = 0;
  requests: LLMRequest[] = [];
  async *stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    this.requests.push(request);
    this.round++;
    const goal = JSON.parse(
      request.messages[1]!.content.slice(request.messages[1]!.content.lastIndexOf('\n') + 1),
    ).goal as string;
    const last = request.messages.at(-1)!;
    if (this.round === 1) yield call('ReadFile', { path: 'same.txt' });
    else if (this.round === 2)
      yield call('EditFile', {
        path: 'same.txt',
        expectedRevision: JSON.parse(last.content).data.revision,
        oldText: 'base',
        newText: goal,
      });
    else if (this.round === 3)
      yield call('Bash', { command: 'node -e "console.log(process.cwd()); process.exit(0)"' });
    else yield text;
    if (signal.aborted) throw new Error('cancelled');
    yield { type: 'usage', inputTokens: 40, outputTokens: 10, estimated: false };
    yield { type: 'finish', reason: this.round < 4 ? 'tool_calls' : 'stop' };
  }
}
describe('isolated writable children', () => {
  let box: Awaited<ReturnType<typeof createGitSandbox>>;
  let manager: WorktreeManager;
  beforeEach(async () => {
    box = await createGitSandbox();
    manager = await WorktreeManager.open(box.cwd, box.userDirectory);
  });
  afterEach(async () => {
    await removeSandbox(box.root);
  });
  it('persists writable task IDs and uncertain budget separately from read-only tasks', async () => {
    const a = await manager.create({ task: 'one' });
    const { pool, parent, budget } = await setup(
      () => new MockProvider({ delayMs: 0 }),
      'accept-edits',
    );
    const session = await SessionStore.create(box.userDirectory, {
      cwd: box.cwd,
      model: 'fixture',
      provider: 'parent',
      mode: 'accept-edits',
    });
    let round = 0;
    let pending: number | undefined;
    const original = session.commit.bind(session);
    session.commit = async (state, event) => {
      if (state.pendingSubagentTokens) {
        pending = state.pendingSubagentTokens;
        expect(recoverState(state).estimated).toBe(true);
      }
      return original(state, event);
    };
    const provider: LLMProvider = {
      id: 'parent',
      capabilities: { streaming: true, toolCalling: true },
      async *stream() {
        round++;
        yield round === 1
          ? call('WorktreeTask', { tasks: [{ id: 'one', worktree: a.id, goal: '离线演示' }] })
          : { type: 'text_delta', text: 'reviewable delivery' };
        yield { type: 'usage', inputTokens: 40, outputTokens: 10, estimated: false };
        yield { type: 'finish', reason: round === 1 ? 'tool_calls' : 'stop' };
      },
    };
    try {
      const loop = new AgentLoop(provider, parent, {
        ...limits,
        mode: 'accept-edits',
        accounting: budget,
        aggregateTokens: true,
        session,
        worktreeTaskIds: () => pool.usedIds,
        subagentRecoveryLimit: 120_000,
      });
      for await (const event of loop.run('isolated task'))
        if (event.type === 'finish') expect(event.reason).toBe('completed');
      expect(pending).toBe(120_000);
      const { state } = await SessionStore.inspect(box.userDirectory, session.owner.id);
      expect(state.worktreeTaskIds).toEqual(['one']);
      expect(state.pendingSubagentTokens).toBeUndefined();
      expect(state.totalTokens).toBe(budget.snapshot.used);
      const registry = createBuiltinRegistry();
      let starts = 0;
      const restored = new SubagentPool(registry, {
        settings: { ...defaultSubagents, enabled: true },
        budget: new TokenBudget(200_000, state.totalTokens, state.estimated),
        agent: limits,
        execution: worktreeExecution(manager),
        usedIds: state.worktreeTaskIds ?? [],
        provider: () => {
          starts++;
          return new MockProvider();
        },
      });
      restored.bind(parent);
      expect(
        (
          await restored.delegate({ tasks: [{ id: 'one', worktree: a.id, goal: 'do not replay' }] })
        )[0]!.code,
      ).toBe('SUBAGENT_REPLAY_BLOCKED');
      expect(starts).toBe(0);
    } finally {
      await session.close();
    }
  });
  async function setup(
    factory: () => LLMProvider = () => new Editor(),
    mode: 'plan' | 'default' | 'accept-edits' = 'default',
    deny = false,
  ) {
    const registry = createBuiltinRegistry();
    manager.register(registry);
    const budget = new TokenBudget(200_000);
    const approvals: string[] = [];
    const pool = new SubagentPool(registry, {
      settings: { ...defaultSubagents, enabled: true, maxTurns: 8 },
      budget,
      agent: limits,
      provider: factory,
      execution: worktreeExecution(manager, async (request) => {
        approvals.push(request.cwd);
        return true;
      }),
    });
    const parent = await ToolExecutor.create(registry, {
      root: box.cwd,
      mode,
      rules: deny ? [{ source: 'user', decision: 'deny', tool: 'EditFile', path: 'same.txt' }] : [],
      approve: async () => true,
    });
    pool.bind(parent);
    return { pool, parent, budget, approvals };
  }
  it('edits identical filenames concurrently, binds process cwd, and reports real shell results', async () => {
    const a = await manager.create({ task: 'one' }),
      b = await manager.create({ task: 'two' });
    const providers: Editor[] = [];
    const { pool, budget, approvals } = await setup(() => {
      const provider = new Editor();
      providers.push(provider);
      return provider;
    });
    const results = await pool.delegate({
      tasks: [
        { id: 'one', worktree: a.id, goal: 'one', tools: ['ReadFile', 'EditFile', 'Bash'] },
        { id: 'two', worktree: b.id, goal: 'two', tools: ['ReadFile', 'EditFile', 'Bash'] },
      ],
    });
    expect(results.map((item) => item.status)).toEqual(['completed', 'completed']);
    expect(results.map((item) => item.worktreeId)).toEqual([a.id, b.id]);
    expect(await readFile(join(box.cwd, 'same.txt'), 'utf8')).toBe('base\n');
    expect(await readFile(join(a.path, 'same.txt'), 'utf8')).toBe('one\n');
    expect(await readFile(join(b.path, 'same.txt'), 'utf8')).toBe('two\n');
    expect(new Set(approvals)).toEqual(new Set([a.path, b.path]));
    expect(budget.snapshot).toMatchObject({ used: 400, reserved: 0 });
    for (const provider of providers) {
      const shell = JSON.parse(provider.requests.at(-1)!.messages.at(-1)!.content);
      expect(shell.name).toBe('Bash');
      expect(shell.content).toMatch(/worktrees/);
    }
    const report = await manager.report(a.id);
    expect(report.owner.status).toBe('completed');
    expect(report.owner.checks).toMatchObject([{ ok: true, exitCode: 0 }]);
    expect(report.dirty).toBe(true);
    await expect(manager.remove(a.id)).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
  }, 30_000);
  it('refuses Plan and inherited deny even with trusted approvals, and never exposes delegation tools to children', async () => {
    const a = await manager.create({ task: 'one' });
    let starts = 0;
    const provider = new Editor();
    const { pool } = await setup(() => {
      starts++;
      return provider;
    }, 'plan');
    expect(
      (await pool.delegate({ tasks: [{ id: 'one', worktree: a.id, goal: 'one' }] }))[0]!.code,
    ).toBe('TOOL_PERMISSION');
    expect(starts).toBe(0);
    const other = await setup(() => provider, 'accept-edits', true);
    await other.pool.delegate({
      tasks: [{ id: 'two', worktree: a.id, goal: 'two', tools: ['ReadFile', 'EditFile', 'Bash'] }],
    });
    expect(await readFile(join(a.path, 'same.txt'), 'utf8')).toBe('base\n');
    const visible = provider.requests[0]!.tools!.map((tool) => tool.name);
    expect(visible).toEqual(['ReadFile', 'EditFile', 'Bash']);
    expect(visible).not.toContain('WorktreeTask');
    expect(JSON.parse(provider.requests[2]!.messages.at(-1)!.content)).toMatchObject({
      ok: false,
      error: { code: 'TOOL_PERMISSION' },
    });
  });
  it('blocks absolute primary paths and invalidates a lease when ownership changes', async () => {
    const a = await manager.create({ task: 'one' });
    const binding = await manager.acquire(a.id, 'worker', new AbortController().signal);
    const parent = await ToolExecutor.create(createBuiltinRegistry(), {
      root: box.cwd,
      mode: 'accept-edits',
    });
    const child = await parent.forkForWorktree(binding, { allowTools: ['ReadFile', 'WriteFile'] });
    expect(
      await child.execute({
        callId: 'outside',
        name: 'WriteFile',
        input: { path: join(box.cwd, 'same.txt'), content: 'wrong' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'PATH_DENIED' } });
    await manager.release(a.id, 'worker', 'failed', 'TEST_STOP');
    expect(
      await child.execute({
        callId: 'late',
        name: 'WriteFile',
        input: { path: 'late.txt', content: 'wrong' },
      }),
    ).toMatchObject({ ok: false, error: { code: 'WORKTREE_OWNER' } });
    expect(await readFile(join(box.cwd, 'same.txt'), 'utf8')).toBe('base\n');
  });
  it('resolves duplicate workspace submission once and retains failed/cancelled changes', async () => {
    const a = await manager.create({ task: 'one' });
    let reached!: () => void;
    const ready = new Promise<void>((done) => {
      reached = done;
    });
    let starts = 0;
    class CancelEditor extends Editor {
      override async *stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
        if (this.round === 2) {
          reached();
          await delay(5000, undefined, { signal });
        }
        yield* super.stream(request, signal);
      }
    }
    const { pool, budget } = await setup(() => {
      starts++;
      return new CancelEditor();
    }, 'accept-edits');
    const controller = new AbortController();
    const pending = pool.delegate(
      {
        tasks: [
          { id: 'one', worktree: a.id, goal: 'changed', tools: ['ReadFile', 'EditFile'] },
          { id: 'two', worktree: a.id, goal: 'duplicate' },
        ],
      },
      controller.signal,
    );
    await ready;
    controller.abort();
    const results = await pending;
    expect(results.map((item) => item.status)).toEqual(['cancelled', 'failed']);
    expect(starts).toBe(1);
    expect((await manager.report(a.id)).owner.status).toBe('cancelled');
    expect(await readFile(join(a.path, 'same.txt'), 'utf8')).toBe('changed\n');
    expect(budget.snapshot.reserved).toBe(0);
    await expect(manager.remove(a.id)).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
  });
});
