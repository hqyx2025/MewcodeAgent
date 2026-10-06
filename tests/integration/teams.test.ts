import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { TeamStore } from '../../src/core/team-store.js';
import { runTeam, teamReport } from '../../src/core/teams.js';
import { WorktreeManager } from '../../src/tools/worktrees.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { defaultSubagents } from '../../src/core/subagent-schema.js';
import type { LLMProvider, LLMRequest, LLMEvent } from '../../src/providers/types.js';
import { createGitSandbox } from '../support/git-repo.js';
import { removeSandbox } from '../support/sandbox.js';

const limits = {
  model: 'fixture',
  maxTurns: 8,
  timeoutMs: 30_000,
  maxOutputTokens: 512,
  maxTotalTokens: 200_000,
};
const call = (name: string, input: unknown, suffix = ''): LLMEvent => ({
  type: 'tool_call_delta',
  index: 0,
  callId: `call-${name}${suffix}`,
  name,
  arguments: JSON.stringify(input),
});
class Editor implements LLMProvider {
  readonly id = 'fixture';
  readonly capabilities = { streaming: true, toolCalling: true };
  private round = 0;
  constructor(
    private readonly requests: LLMRequest[],
    private readonly wait = 0,
    private readonly fail = false,
  ) {}
  async *stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    this.requests.push(request);
    this.round++;
    if (this.wait) await delay(this.wait, undefined, { signal });
    const goal = JSON.parse(
      request.messages[1]!.content.slice(request.messages[1]!.content.lastIndexOf('\n') + 1),
    ).goal as string;
    const last = request.messages.at(-1)!;
    if (this.round === 1) yield call('ReadFile', { path: 'same.txt' });
    else if (this.round === 2)
      yield call('EditFile', {
        path: 'same.txt',
        oldText: JSON.parse(last.content)
          .content.split('\n')[0]
          .replace(/^\d+: /, ''),
        newText: goal,
        expectedRevision: JSON.parse(last.content).data.revision,
      });
    else if (this.round === 3) yield call('ReadFile', { path: 'same.txt' }, '-again');
    else
      yield {
        type: 'text_delta',
        text: this.fail
          ? 'invalid-json'
          : JSON.stringify({ summary: goal, evidence: [{ path: 'same.txt', line: 1 }] }),
      };
    yield { type: 'usage', inputTokens: 40, outputTokens: 10, estimated: false };
    yield { type: 'finish', reason: this.round < 4 ? 'tool_calls' : 'stop' };
  }
}
describe('persistent agent teams', () => {
  let box: Awaited<ReturnType<typeof createGitSandbox>>;
  let manager: WorktreeManager;
  let store: TeamStore;
  let ids: string[];
  beforeEach(async () => {
    box = await createGitSandbox();
    manager = await WorktreeManager.open(box.cwd, box.userDirectory);
    store = await TeamStore.open(manager, box.userDirectory, ['test-secret-value']);
    ids = [];
    for (const task of ['alice', 'bob']) ids.push((await manager.create({ task })).id);
  });
  afterEach(async () => {
    await removeSandbox(box.root);
  });
  const definition = (tasks: unknown[], settings = {}) => ({
    name: 'fixture',
    members: [
      { id: 'alice', role: 'editor', worktree: ids[0] },
      { id: 'bob', role: 'reviewer', worktree: ids[1] },
    ],
    tasks,
    settings,
  });
  const task = (id: string, member = 'alice', dependsOn: string[] = []) => ({
    id,
    member,
    dependsOn,
    goal: id,
    tools: ['ReadFile', 'EditFile'],
  });
  const execute = async (
    id: string,
    provider: () => LLMProvider,
    mode: 'plan' | 'default' | 'accept-edits' = 'accept-edits',
    signal?: AbortSignal,
    rules: Parameters<typeof ToolExecutor.create>[1]['rules'] = [],
  ) => {
    const parent = await ToolExecutor.create(createBuiltinRegistry(), {
      root: box.cwd,
      mode,
      approve: async () => true,
      rules,
    });
    return runTeam(
      id,
      {
        parent,
        manager,
        store,
        settings: { ...defaultSubagents, enabled: true, maxTurns: 8 },
        agent: limits,
        provider,
        approve: async () => true,
      },
      signal,
    );
  };
  it('binds member message identity, limits child tools and reports actual failing shell checks', async () => {
    const team = await store.create(
      definition([{ ...task('one'), tools: ['ReadFile', 'TeamSend', 'TeamInbox', 'Bash'] }]),
      manager,
    );
    const requests: LLMRequest[] = [];
    const messageId = randomUUID();
    let round = 0;
    const provider: LLMProvider = {
      id: 'messenger',
      capabilities: { streaming: true, toolCalling: true },
      async *stream(request) {
        requests.push(request);
        round++;
        if (round === 1)
          yield call(
            'TeamSend',
            { messageId, to: 'bob', text: 'bad', from: 'coordinator' },
            '-fake',
          );
        else if (round === 2)
          yield call('TeamSend', { messageId, to: 'bob', text: 'actual member message' });
        else if (round === 3) yield call('TeamInbox', {});
        else if (round === 4) yield call('Bash', { command: 'node -e "process.exit(2)"' });
        else if (round === 5) yield call('ReadFile', { path: 'same.txt' });
        else
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              summary: 'observed shell failure',
              evidence: [{ path: 'same.txt', line: 1 }],
            }),
          };
        yield { type: 'usage', inputTokens: 40, outputTokens: 10, estimated: false };
        yield { type: 'finish', reason: round < 6 ? 'tool_calls' : 'stop' };
      },
    };
    const result = await execute(team.id, () => provider);
    expect(result.state.tasks[0]!.status).toBe('completed');
    expect(JSON.parse(requests[1]!.messages.at(-1)!.content)).toMatchObject({
      ok: false,
      error: { code: 'TOOL_INPUT' },
    });
    expect((await store.inbox(team.id, 'bob'))[0]).toMatchObject({
      from: 'alice',
      text: 'actual member message',
    });
    expect(requests[0]!.tools!.map((tool) => tool.name)).toEqual([
      'ReadFile',
      'Bash',
      'TeamSend',
      'TeamInbox',
    ]);
    expect((await manager.report(ids[0]!)).owner.checks).toMatchObject([
      { ok: false, exitCode: 2 },
    ]);
  });
  it('does not call a model when persistent task quota is insufficient', async () => {
    const team = await store.create(definition([task('one')], { maxTotalTokens: 1024 }), manager);
    let calls = 0;
    const provider: LLMProvider = {
      id: 'no-request',
      capabilities: { streaming: true, toolCalling: true },
      async *stream() {
        calls++;
        yield { type: 'finish', reason: 'stop' };
      },
    };
    const result = await execute(team.id, () => provider);
    expect(result.state.tasks[0]!.result?.code).toBe('TOKEN_BUDGET');
    expect(calls).toBe(0);
    expect(result.state.usedTokens).toBe(0);
    expect(result.budget.reserved).toBe(0);
  });
  it('honors trusted per-run task limits and preserves remaining work for a later explicit run', async () => {
    const team = await store.create(
      definition([
        task('one'),
        task('two', 'bob'),
        task('three', 'alice', ['one']),
        task('four', 'bob', ['two']),
      ]),
      manager,
    );
    const parent = await ToolExecutor.create(createBuiltinRegistry(), {
      root: box.cwd,
      mode: 'accept-edits',
    });
    const options = {
      parent,
      manager,
      store,
      settings: { ...defaultSubagents, enabled: true, maxTasks: 1, maxTurns: 8 },
      agent: limits,
      provider: () => new Editor([]),
    };
    const first = await runTeam(team.id, options);
    expect(first.metrics.claims).toBe(1);
    expect(first.state.tasks.map((item) => item.status)).toEqual([
      'completed',
      'queued',
      'queued',
      'queued',
    ]);
    expect(parent.registry.definitions().map((tool) => tool.name)).not.toContain('TeamSend');
    const second = await runTeam(team.id, options);
    expect(second.metrics.claims).toBe(1);
    expect(second.state.usedTokens).toBe(400);
    expect(second.state.tasks[0]!.attempt).toBe(1);
  });
  it('marks acquisition timeout as a failure without starting a provider', async () => {
    const team = await store.create(definition([task('one')], { timeoutMs: 1 }), manager);
    let starts = 0;
    const result = await execute(team.id, () => {
      starts++;
      return new Editor([]);
    });
    expect(result.state.tasks[0]!.status).toBe('failed');
    expect(result.state.tasks[0]!.result?.code).toBe('SUBAGENT_TIMEOUT');
    expect(starts).toBe(0);
  });
  it('refuses a replaced member ownership before continuing earlier edits and rejects live metadata locks', async () => {
    const team = await store.create(definition([task('one')]), manager);
    await execute(team.id, () => new Editor([]));
    await store.add(team.id, { tasks: [task('two')] });
    const file = join(manager.directory, ids[0] + '.json');
    const owner = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...owner, agentId: randomUUID() }));
    const result = await execute(team.id, () => new Editor([]));
    expect(result.state.tasks[1]!.status).toBe('failed');
    expect(result.state.tasks[1]!.result?.code).toBe('WORKTREE_BUSY');
    expect(await readFile(join(team.members[0]!.path, 'same.txt'), 'utf8')).toBe('one\n');
    const lock = join(store.directory, 'manager.lock');
    await writeFile(
      lock,
      JSON.stringify({
        app: 'mewcode-teams',
        repository: store.repository,
        host: hostname(),
        pid: process.pid,
        id: randomUUID(),
      }),
    );
    await expect(store.unlock()).rejects.toMatchObject({ code: 'TEAM_BUSY' });
    await writeFile(
      lock,
      JSON.stringify({
        app: 'mewcode-teams',
        repository: store.repository,
        host: hostname(),
        pid: 2147483647,
        id: randomUUID(),
      }),
    );
    await store.unlock();
  });
  it('serializes each member, honors dependencies, continues owned changes and persists the shared ledger', async () => {
    const team = await store.create(
      definition([
        { ...task('one'), context: '\u0000'.repeat(4096) },
        task('two', 'bob', ['one']),
        task('three', 'alice', ['two']),
      ]),
      manager,
    );
    const requests: LLMRequest[] = [];
    const result = await execute(team.id, () => new Editor(requests));
    expect(result.state.tasks.map((item) => item.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    expect(result.state.usedTokens).toBe(600);
    expect(result.metrics.modelRequests).toBe(12);
    expect(result.metrics.peakActive).toBe(1);
    const firstContext = JSON.parse(requests[0]!.messages[1]!.content.split('\n').at(-1)!).context;
    expect(firstContext.length).toBeLessThanOrEqual(4096);
    expect(JSON.parse(firstContext)).toMatchObject({ contextTruncated: true });
    expect(await readFile(join(team.members[0]!.path, 'same.txt'), 'utf8')).toBe('three\n');
    expect(await readFile(join(team.members[1]!.path, 'same.txt'), 'utf8')).toBe('two\n');
    expect(await readFile(join(box.cwd, 'same.txt'), 'utf8')).toBe('base\n');
    const context = JSON.parse(
      JSON.parse(requests[4]!.messages[1]!.content.split('\n').at(-1)!).context,
    );
    expect(context.dependencies[0]).toMatchObject({
      id: 'one',
      summary: 'one',
      worktreeId: ids[0],
    });
    const reports = await teamReport(result.state, manager);
    expect(reports.overlappingPaths).toEqual([{ path: 'same.txt', members: ['alice', 'bob'] }]);
    expect(reports.worktrees.every((item) => item.report.dirty)).toBe(true);
    const replay = await execute(team.id, () => {
      throw new Error('must not run');
    });
    expect(replay.metrics.claims).toBe(0);
    expect(replay.state.usedTokens).toBe(600);
    await store.add(team.id, { tasks: [task('four')] });
    const again = await execute(team.id, () => new Editor(requests));
    expect(again.state.usedTokens).toBe(800);
    expect(again.state.members[0]!.identity).toBe(team.members[0]!.identity);
  }, 30_000);
  it('runs independent members in parallel and blocks duplicate coordinator/claims', async () => {
    const team = await store.create(definition([task('one'), task('two', 'bob')]), manager);
    const requests: LLMRequest[] = [];
    const running = execute(team.id, () => new Editor(requests, 100));
    while (!(await store.inspect(team.id)).run) await delay(10);
    await expect(store.start(team.id, 60_000)).rejects.toMatchObject({ code: 'TEAM_BUSY' });
    const result = await running;
    expect(result.metrics.peakActive).toBe(2);
    expect(result.state.usedTokens).toBe(400);
    const started = await store.start(team.id, 60_000);
    expect(await store.claim(team.id, started.run!.id, 'one', 400, 1000)).toBeUndefined();
    await store.settle(team.id, started.run!.id, 400, false, false);
  });
  it('validates graph, storage, worktree ownership and sensitive source without echoing inputs', async () => {
    for (const tasks of [
      [task('one', 'missing')],
      [task('one', 'alice', ['one'])],
      [task('one', 'alice', ['missing'])],
      [task('one'), task('one')],
    ])
      await expect(store.create(definition(tasks), manager)).rejects.toMatchObject({
        code: 'TEAM_INPUT',
      });
    await expect(
      store.create(definition([{ ...task('one'), goal: 'test-secret-value' }]), manager),
    ).rejects.toMatchObject({
      code: 'TEAM_SENSITIVE',
      message: expect.not.stringContaining('test-secret-value'),
    });
    const team = await store.create(definition([task('one')]), manager);
    const file = join(store.directory, team.id + '.json');
    const message = await store.send(team.id, 'coordinator', {
      messageId: randomUUID(),
      to: 'alice',
      text: 'fixture',
    });
    const valid = await store.inspect(team.id);
    for (const invalid of [
      {
        ...valid,
        members: valid.members.map((member) => ({
          ...member,
          identity: valid.members[0]!.identity,
        })),
      },
      { ...valid, messages: [{ ...message, from: 'bob' }] },
      { ...valid, tasks: valid.tasks.map((task) => ({ ...task, status: 'running' })) },
    ]) {
      await writeFile(file, JSON.stringify(invalid));
      await expect(store.inspect(team.id)).rejects.toMatchObject({ code: 'TEAM_OWNER' });
    }
    await writeFile(file, '{"private-source-marker":');
    await expect(store.inspect(team.id)).rejects.toMatchObject({
      code: 'TEAM_OWNER',
      message: expect.not.stringContaining('private-source-marker'),
    });
  });
  it('deduplicates concurrent messages, rejects changed IDs, bounds queues and preserves delayed deliveries', async () => {
    const team = await store.create(definition([task('one')], { maxMessages: 2 }), manager);
    const message = {
      messageId: randomUUID(),
      to: 'alice',
      task: 'one',
      text: 'untrusted message; no permission grant',
    };
    const sent = await Promise.all([
      store.send(team.id, 'coordinator', message),
      store.send(team.id, 'coordinator', message),
    ]);
    expect(sent[0]!.sequence).toBe(sent[1]!.sequence);
    expect(await store.inbox(team.id, 'alice')).toHaveLength(1);
    await expect(
      store.send(team.id, 'coordinator', { ...message, text: 'changed' }),
    ).rejects.toMatchObject({ code: 'TEAM_DUPLICATE' });
    await expect(store.send(team.id, 'unknown', message)).rejects.toMatchObject({
      code: 'TEAM_MESSAGE',
    });
    const requests: LLMRequest[] = [];
    await execute(team.id, () => new Editor(requests));
    const context = JSON.parse(
      JSON.parse(requests[0]!.messages[1]!.content.split('\n').at(-1)!).context,
    );
    expect(context.messages[0].text).toBe(message.text);
    await store.send(team.id, 'coordinator', {
      messageId: randomUUID(),
      to: 'alice',
      text: 'late',
    });
    expect((await store.inbox(team.id, 'alice'))[1]!.deliveredTo).toBeUndefined();
    await expect(
      store.send(team.id, 'coordinator', {
        messageId: randomUUID(),
        to: 'bob',
        text: 'over limit',
      }),
    ).rejects.toMatchObject({ code: 'TEAM_LIMIT' });
  });
  it('retains failed edits, blocks descendants, and requires bounded explicit retry', async () => {
    const team = await store.create(
      definition([task('one'), task('two', 'bob', ['one'])]),
      manager,
    );
    const requests: LLMRequest[] = [];
    const failed = await execute(team.id, () => new Editor(requests, 0, true));
    expect(failed.state.tasks.map((item) => item.status)).toEqual(['failed', 'blocked']);
    expect(failed.state.usedTokens).toBe(200);
    await store.retry(team.id, 'one');
    const retried = await execute(team.id, () => new Editor(requests));
    expect(retried.state.tasks.map((item) => item.status)).toEqual(['completed', 'completed']);
    expect(retried.state.usedTokens).toBe(600);
    expect(retried.state.tasks[0]!.attempt).toBe(2);
    await expect(store.retry(team.id, 'one')).rejects.toMatchObject({ code: 'TEAM_RETRY' });
    // Three real Git-bound task executions, including recovery of earlier edits.
    // Allow the same cold/shared-runner budget as the longer dependency fixture.
  }, 30_000);
  it('propagates coordinator cancellation and enforces Plan and parent deny', async () => {
    const team = await store.create(
      definition([task('one'), task('two', 'bob', ['one'])]),
      manager,
    );
    const requests: LLMRequest[] = [];
    const pending = execute(team.id, () => new Editor(requests, 500));
    while (!requests.length) await delay(10);
    await store.cancel(team.id);
    const stopped = await pending;
    expect(stopped.state.tasks.map((item) => item.status)).toEqual(['cancelled', 'cancelled']);
    expect(stopped.budget.reserved).toBe(0);
    expect(stopped.state.run).toBeUndefined();
    await expect(execute(team.id, () => new Editor([]), 'plan')).rejects.toMatchObject({
      code: 'TOOL_PERMISSION',
    });
    await store.retry(team.id, 'one');
    await execute(team.id, () => new Editor(requests), 'accept-edits', undefined, [
      { source: 'user', decision: 'deny', tool: 'EditFile', path: 'same.txt' },
    ]);
    expect(await readFile(join(team.members[0]!.path, 'same.txt'), 'utf8')).toBe('base\n');
  });
  it('recovers only a dead owning process, keeps deliveries, conservatively charges unknown work and blocks automatic replay', async () => {
    const team = await store.create(definition([task('one'), task('two', 'bob')]), manager);
    const running = await store.start(team.id, 60_000);
    const claimed = await store.claim(team.id, running.run!.id, 'one', 0, 20_000);
    const binding = await manager.acquire(
      ids[0]!,
      claimed!.claim!.agentId,
      new AbortController().signal,
    );
    await writeFile(join(binding.root, 'same.txt'), 'interrupted');
    await expect(store.recover(team.id, manager)).rejects.toMatchObject({ code: 'TEAM_BUSY' });
    const file = join(store.directory, team.id + '.json');
    const state = await store.inspect(team.id);
    state.run!.pid = 2147483647;
    await writeFile(file, JSON.stringify(state));
    const ownerFile = join(manager.directory, ids[0] + '.json');
    const owner = JSON.parse(await readFile(ownerFile, 'utf8'));
    await writeFile(ownerFile, JSON.stringify({ ...owner, pid: 2147483647, host: hostname() }));
    const recovered = await store.recover(team.id, manager);
    expect(recovered.tasks[0]!.status).toBe('uncertain');
    expect(recovered.usedTokens).toBe(20_000);
    expect(recovered.estimated).toBe(true);
    expect(await readFile(join(binding.root, 'same.txt'), 'utf8')).toBe('interrupted');
    const done = await execute(team.id, () => new Editor([]));
    expect(done.state.tasks[0]!.status).toBe('uncertain');
    expect(done.state.tasks[1]!.status).toBe('completed');
    expect(done.state.usedTokens).toBe(20_200);
    await store.retry(team.id, 'one');
    const replay = await execute(team.id, () => new Editor([]));
    expect(replay.state.usedTokens).toBe(20_400);
    expect(replay.state.tasks[0]!.attempt).toBe(2);
  });
});
