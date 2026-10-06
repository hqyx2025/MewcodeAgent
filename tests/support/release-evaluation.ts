import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentLoop } from '../../src/core/agent-loop.js';
import type { AgentEvent, AgentOptions } from '../../src/core/agent-loop.js';
import { SessionStore } from '../../src/core/session.js';
import { defaultContext, validateHistory } from '../../src/core/context.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import type { ToolResult } from '../../src/tools/types.js';
import type { LLMEvent, LLMProvider, LLMRequest } from '../../src/providers/types.js';
import { MCPManager, mcpToolName } from '../../src/mcp/manager.js';
import { WorktreeManager } from '../../src/tools/worktrees.js';
import { TeamStore } from '../../src/core/team-store.js';
import { runTeam, teamReport } from '../../src/core/teams.js';
import { defaultSubagents } from '../../src/core/subagent-schema.js';
import { createGitSandbox } from './git-repo.js';
import { removeSandbox } from './sandbox.js';

const limits = {
  model: 'scripted-release-fixture',
  mode: 'accept-edits' as const,
  maxTurns: 12,
  maxOutputTokens: 512,
  maxTotalTokens: 200_000,
  timeoutMs: 60_000,
};
const stop: LLMEvent[] = [
  { type: 'text_delta', text: 'fixture checked' },
  { type: 'finish', reason: 'stop' },
];
function call(name: string, input: unknown, id: string): LLMEvent[] {
  return [
    { type: 'tool_call_delta', index: 0, callId: id, name, arguments: JSON.stringify(input) },
    { type: 'finish', reason: 'tool_calls' },
  ];
}
function scripted(reply: (request: LLMRequest, turn: number) => LLMEvent[]): LLMProvider {
  let turn = 0;
  return {
    id: 'release-fixture',
    capabilities: { streaming: true, toolCalling: true },
    async *stream(request, signal) {
      signal.throwIfAborted();
      const events = reply(request, ++turn);
      yield* events.slice(0, -1);
      yield { type: 'usage', inputTokens: 40, outputTokens: 10, estimated: false };
      yield events.at(-1)!;
    },
  };
}
const last = (request: LLMRequest) =>
  JSON.parse(request.messages.at(-1)!.content) as ToolResult & {
    data: { revision: string; exitCode: number };
  };
const command = (file: string) =>
  `${process.platform === 'win32' ? '& ' : ''}'${process.execPath.replaceAll("'", process.platform === 'win32' ? "''" : "'\\''")}' '${file}'`;
async function collect(agent: AgentLoop, prompt = 'fixed release task') {
  const events: AgentEvent[] = [];
  for await (const event of agent.run(prompt)) events.push(event);
  assert.equal(events.at(-1)?.type, 'finish');
  assert.equal((events.at(-1) as Extract<AgentEvent, { type: 'finish' }>).reason, 'completed');
  return events;
}
async function executor(cwd: string) {
  return ToolExecutor.create(createBuiltinRegistry(), {
    root: cwd,
    mode: 'accept-edits',
    approve: async () => true,
  });
}
const toolResults = (events: AgentEvent[]) =>
  events.filter((event) => event.type === 'tool_result').map((event) => event.result);
async function stopped(pid: number) {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (process.platform === 'linux') {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
      if (!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return;
    }
    await delay(25);
  }
  assert.fail('Owned fixture process did not stop');
}
type Box = Awaited<ReturnType<typeof createGitSandbox>>;
const cases: Record<string, (box: Box) => Promise<Record<string, unknown>>> = {
  async 'bug-fix'(box) {
    await writeFile(join(box.cwd, 'sum.mjs'), 'export const sum = (a,b) => a-b;\n');
    await writeFile(
      join(box.cwd, 'check.mjs'),
      "import assert from 'node:assert/strict';import {sum} from './sum.mjs';assert.equal(sum(2,3),5);assert.equal(sum(-2,3),1);console.log('verified');\n",
    );
    const model = scripted((request, turn) => {
      if (turn === 1) return call('Bash', { command: command('check.mjs') }, 'before');
      if (turn === 2) {
        assert.notEqual(last(request).data.exitCode, 0);
        return call('ReadFile', { path: 'sum.mjs' }, 'read');
      }
      if (turn === 3)
        return call(
          'EditFile',
          {
            path: 'sum.mjs',
            oldText: 'a-b',
            newText: 'a+b',
            expectedRevision: last(request).data.revision,
          },
          'edit',
        );
      if (turn === 4) return call('Bash', { command: command('check.mjs') }, 'after');
      assert.equal(last(request).data.exitCode, 0);
      assert(last(request).content.includes('verified'));
      return stop;
    });
    const events = await collect(new AgentLoop(model, await executor(box.cwd), limits));
    const results = toolResults(events);
    assert.equal(results.length, 4);
    assert((await readFile(join(box.cwd, 'sum.mjs'), 'utf8')).includes('a+b'));
    return {
      requests: 5,
      syntheticTokens: 250,
      beforeExit: (results[0]!.data as { exitCode: number }).exitCode,
      afterExit: (results[3]!.data as { exitCode: number }).exitCode,
      assertions: 'two actual Node arithmetic assertions',
    };
  },
  async 'file-refactor'(box) {
    await writeFile(join(box.cwd, 'sum.mjs'), 'export const sum = (a,b) => a+b;\n');
    await writeFile(
      join(box.cwd, 'check.mjs'),
      "import assert from 'node:assert/strict';import {sum} from './sum.mjs';for(const [a,b] of [[2,3],[-2,3],[0,0],[0.5,0.25]])assert.equal(sum(a,b),a+b);console.log('refactor verified');\n",
    );
    const events = await collect(
      new AgentLoop(
        scripted((request, turn) => {
          if (turn === 1) return call('ReadFile', { path: 'sum.mjs' }, 'read');
          if (turn === 2)
            return call(
              'WriteFile',
              { path: 'math.mjs', content: 'export const add = (a,b) => a+b;\n' },
              'extract',
            );
          if (turn === 3) {
            const read = request.messages.findLast(
              (message) =>
                message.role === 'tool' && JSON.parse(message.content).name === 'ReadFile',
            )!;
            return call(
              'EditFile',
              {
                path: 'sum.mjs',
                oldText: 'export const sum = (a,b) => a+b;',
                newText: "import {add} from './math.mjs';\nexport const sum = add;",
                expectedRevision: JSON.parse(read.content).data.revision,
              },
              'replace',
            );
          }
          if (turn === 4) return call('Bash', { command: command('check.mjs') }, 'check');
          assert.equal(last(request).data.exitCode, 0);
          return stop;
        }),
        await executor(box.cwd),
        limits,
      ),
    );
    assert(toolResults(events).every((result) => result.ok));
    assert((await readFile(join(box.cwd, 'sum.mjs'), 'utf8')).includes("from './math.mjs'"));
    return {
      requests: 5,
      syntheticTokens: 250,
      files: 2,
      assertions: 'four actual Node behavior assertions after module extraction',
    };
  },
  async 'long-session'(box) {
    await writeFile(join(box.cwd, 'guide.txt'), 'fixed evidence data\n'.repeat(1000));
    let store = await SessionStore.create(box.userDirectory, {
      cwd: box.cwd,
      provider: 'release-fixture',
      model: limits.model,
      mode: limits.mode,
    });
    const id = store.owner.id;
    try {
      const settings: AgentOptions = {
        ...limits,
        maxTurns: 110,
        session: store,
        context: {
          ...defaultContext,
          windowTokens: 32_768,
          triggerRatio: 0.7,
          summaryBytes: 1024,
          toolResultBytes: 1024,
          recentTurns: 2,
        },
      };
      const events = await collect(
        new AgentLoop(
          scripted((_request, turn) => {
            if (turn === 1)
              return call(
                'WriteFile',
                { path: 'delivery.txt', content: 'created exactly once' },
                'write-once',
              );
            if (turn <= 101) return call('ReadFile', { path: 'guide.txt' }, `read-${turn - 1}`);
            return stop;
          }),
          await executor(box.cwd),
          settings,
        ),
        'original fixed goal',
      );
      const results = toolResults(events);
      assert.equal(results.filter((result) => result.name === 'ReadFile' && result.ok).length, 100);
      const compactions = events.filter((event) => event.type === 'compacted').length;
      assert(compactions > 0);
      await store.close();
      const resumed = await SessionStore.resume(box.userDirectory, id, box.cwd);
      store = resumed.store;
      assert(resumed.state.messages.some((message) => message.content === 'original fixed goal'));
      assert.deepEqual(validateHistory(resumed.state.messages), []);
      const replay = await collect(
        new AgentLoop(
          scripted((request, turn) => {
            if (turn === 1)
              return call(
                'WriteFile',
                { path: 'delivery.txt', content: 'created exactly once' },
                'new-replay-id',
              );
            assert.equal(last(request).error?.code, 'ACTION_REPLAY_BLOCKED');
            return stop;
          }),
          await executor(box.cwd),
          { ...settings, session: store, resume: resumed.state },
        ),
        'verify saved delivery',
      );
      assert.equal(toolResults(replay)[0]!.error?.code, 'ACTION_REPLAY_BLOCKED');
      assert.equal(await readFile(join(box.cwd, 'delivery.txt'), 'utf8'), 'created exactly once');
      const persisted = await SessionStore.inspect(box.userDirectory, id);
      assert.equal(persisted.state.actions.length, 1);
      assert.equal(persisted.state.totalTokens, 5200);
      return {
        requests: 104,
        syntheticTokens: 5200,
        toolReads: 100,
        compactions,
        persistedActions: 1,
        replay: 'blocked by action digest',
        checkpointMessages: persisted.state.messages.length,
      };
    } finally {
      await store.close();
    }
  },
  async 'mcp-lifecycle'(box) {
    const registry = createBuiltinRegistry();
    const path = join(box.cwd, 'pids.json');
    const manager = new MCPManager(registry, {
      fixture: {
        transport: 'stdio',
        command: process.execPath,
        args: [fileURLToPath(new URL('./mcp-server.mjs', import.meta.url)), 'children', path],
        cwd: '.',
        env: {},
        connectTimeoutMs: 15_000,
        callTimeoutMs: 5000,
      },
    });
    const tools = await ToolExecutor.create(registry, { root: box.cwd, approve: async () => true });
    let pids: { pid: number; child: number } | undefined;
    try {
      assert((await manager.connect('fixture', tools, AbortSignal.timeout(15_000))).ok);
      pids = JSON.parse(await readFile(path, 'utf8'));
      const result = await tools.execute({
        callId: 'echo',
        name: mcpToolName('fixture', 'echo'),
        input: { text: 'fixed release record' },
      });
      assert(result.ok);
      assert.equal(result.content, 'fixed release record');
    } finally {
      await manager.close();
    }
    assert(pids);
    await stopped(pids.pid);
    await stopped(pids.child);
    const closed = await tools.execute({
      callId: 'closed',
      name: mcpToolName('fixture', 'echo'),
      input: { text: 'must not execute' },
    });
    assert(!closed.ok);
    return {
      requests: 0,
      ownedProcessesStopped: 2,
      afterClose: 'call refused',
      assertions: 'actual paged MCP discovery and correlated echo',
    };
  },
  async 'team-repairs'(box) {
    for (const [file, operator] of [
      ['sum', '-'],
      ['product', '+'],
    ]) {
      await writeFile(
        join(box.cwd, `${file}.mjs`),
        `export const calculate = (a,b) => a${operator}b;\n`,
      );
      await writeFile(
        join(box.cwd, `check-${file}.mjs`),
        `import assert from 'node:assert/strict';import {calculate} from './${file}.mjs';assert.equal(calculate(2,3),${file === 'sum' ? 5 : 6});console.log('verified ${file}');\n`,
      );
    }
    await box.git(['add', '.']);
    await box.git(['commit', '-m', 'fixed repair inputs']);
    const manager = await WorktreeManager.open(box.cwd, box.userDirectory);
    const store = await TeamStore.open(manager, box.userDirectory);
    const trees = [
      await manager.create({ task: 'sum' }),
      await manager.create({ task: 'product' }),
    ];
    const team = await store.create(
      {
        name: 'release',
        members: trees.map((tree, index) => ({
          id: index ? 'bob' : 'alice',
          role: 'fix and validate dedicated module',
          worktree: tree.id,
        })),
        tasks: [
          { id: 'sum', member: 'alice', goal: 'sum', tools: ['ReadFile', 'EditFile', 'Bash'] },
          {
            id: 'product',
            member: 'bob',
            goal: 'product',
            tools: ['ReadFile', 'EditFile', 'Bash'],
          },
        ],
      },
      manager,
    );
    const run = await runTeam(team.id, {
      parent: await executor(box.cwd),
      manager,
      store,
      settings: { ...defaultSubagents, enabled: true },
      agent: limits,
      approve: async () => true,
      provider: () =>
        scripted((request, turn) => {
          const goal = JSON.parse(request.messages[1]!.content.split('\n').at(-1)!).goal as string;
          if (turn === 1) return call('ReadFile', { path: `${goal}.mjs` }, 'read');
          if (turn === 2)
            return call(
              'EditFile',
              {
                path: `${goal}.mjs`,
                oldText: goal === 'sum' ? 'a-b' : 'a+b',
                newText: goal === 'sum' ? 'a+b' : 'a*b',
                expectedRevision: last(request).data.revision,
              },
              'edit',
            );
          if (turn === 3) return call('ReadFile', { path: `${goal}.mjs` }, 'reread');
          if (turn === 4) return call('Bash', { command: command(`check-${goal}.mjs`) }, 'check');
          assert.equal(last(request).data.exitCode, 0);
          return [
            {
              type: 'text_delta',
              text: JSON.stringify({
                summary: `verified ${goal}`,
                evidence: [{ path: `${goal}.mjs`, line: 1 }],
              }),
            },
            { type: 'finish', reason: 'stop' },
          ];
        }),
    });
    assert(
      run.state.tasks.every(
        (task) => task.status === 'completed' && task.checks?.[0]?.exitCode === 0,
      ),
    );
    assert.equal(run.state.usedTokens, 500);
    const report = await teamReport(run.state, manager);
    assert.deepEqual(report.overlappingPaths, []);
    assert.equal(report.merge, 'manual-review-required');
    assert((await readFile(join(box.cwd, 'sum.mjs'), 'utf8')).includes('a-b'));
    assert((await readFile(join(box.cwd, 'product.mjs'), 'utf8')).includes('a+b'));
    for (const [index, tree] of trees.entries()) {
      const file = index ? 'product' : 'sum';
      await box.git(['add', `${file}.mjs`], tree.path);
      await box.git(['commit', '-m', 'reviewed fixture repair'], tree.path);
      await manager.remove(tree.id);
    }
    return {
      requests: 10,
      syntheticTokens: 500,
      peakActive: run.metrics.peakActive,
      assertions:
        'two actual Node checks in distinct worktrees; original bugs stay in main; reviewed cleanup keeps branches',
    };
  },
};
export const releaseScenarioNames = Object.keys(cases);
export async function evaluateScenario(name: string) {
  assert(Object.hasOwn(cases, name), 'Unknown release scenario');
  const box = await createGitSandbox();
  const began = performance.now();
  try {
    const observations = await cases[name]!(box);
    return {
      name,
      status: 'passed',
      durationMs: Number((performance.now() - began).toFixed(3)),
      observedHeapBytes: process.memoryUsage().heapUsed,
      ...observations,
    };
  } finally {
    await removeSandbox(box.root);
  }
}
