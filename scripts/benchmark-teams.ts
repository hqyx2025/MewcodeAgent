import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { WorktreeManager } from '../src/tools/worktrees.js';
import { TeamStore } from '../src/core/team-store.js';
import { runTeam } from '../src/core/teams.js';
import { ToolExecutor } from '../src/tools/executor.js';
import { createBuiltinRegistry } from '../src/tools/builtins.js';
import { defaultSubagents } from '../src/core/subagent-schema.js';
import type { LLMProvider, LLMRequest, LLMEvent } from '../src/providers/types.js';
import { createGitSandbox } from '../tests/support/git-repo.js';
import { removeSandbox } from '../tests/support/sandbox.js';
class Fixture implements LLMProvider {
  readonly id = 'fixture';
  readonly capabilities = { streaming: true, toolCalling: true };
  private round = 0;
  async *stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    this.round++;
    await delay(100, undefined, { signal });
    if (this.round === 1)
      yield {
        type: 'tool_call_delta',
        index: 0,
        callId: 'read',
        name: 'ReadFile',
        arguments: '{"path":"same.txt"}',
      };
    else
      yield {
        type: 'text_delta',
        text: JSON.stringify({
          summary: 'observed fixture',
          evidence: [{ path: 'same.txt', line: 1 }],
        }),
      };
    yield { type: 'usage', inputTokens: 40, outputTokens: 10, estimated: false };
    yield { type: 'finish', reason: this.round === 1 ? 'tool_calls' : 'stop' };
  }
}
const box = await createGitSandbox();
try {
  const manager = await WorktreeManager.open(box.cwd, box.userDirectory);
  const store = await TeamStore.open(manager, box.userDirectory);
  const results = [];
  for (const concurrency of [1, 2]) {
    const samples: (Awaited<ReturnType<typeof runTeam>>['metrics'] & {
      capacityIdleMs: number;
      tokens: number;
    })[] = [];
    for (let sample = 0; sample < 3; sample++) {
      const a = await manager.create({ task: 'alice' }),
        b = await manager.create({ task: 'bob' });
      const team = await store.create(
        {
          name: 'benchmark',
          members: [
            { id: 'alice', role: 'read fixture', worktree: a.id },
            { id: 'bob', role: 'read fixture', worktree: b.id },
          ],
          tasks: [
            { id: 'one', member: 'alice', goal: 'read fixture', tools: ['ReadFile'] },
            { id: 'two', member: 'bob', goal: 'read fixture', tools: ['ReadFile'] },
            {
              id: 'three',
              member: 'alice',
              goal: 'read fixture',
              dependsOn: ['one'],
              tools: ['ReadFile'],
            },
            {
              id: 'four',
              member: 'bob',
              goal: 'read fixture',
              dependsOn: ['two'],
              tools: ['ReadFile'],
            },
          ],
          settings: { concurrency },
        },
        manager,
      );
      for (const member of team.members)
        await store.send(team.id, 'coordinator', {
          messageId: randomUUID(),
          to: member.id,
          text: 'fixed coordination message',
        });
      const parent = await ToolExecutor.create(createBuiltinRegistry(), {
        root: box.cwd,
        mode: 'accept-edits',
      });
      const began = performance.now();
      const run = await runTeam(team.id, {
        parent,
        manager,
        store,
        settings: { ...defaultSubagents, enabled: true },
        agent: {
          model: 'fixture',
          maxTurns: 6,
          timeoutMs: 30_000,
          maxOutputTokens: 512,
          maxTotalTokens: 200_000,
        },
        provider: () => new Fixture(),
      });
      const totalMs = performance.now() - began;
      assert(run.state.tasks.every((task) => task.status === 'completed'));
      assert.equal(run.state.usedTokens, 400);
      assert.equal(run.metrics.modelRequests, 8);
      assert.equal(run.budget.reserved, 0);
      samples.push({
        ...run.metrics,
        totalMs,
        capacityIdleMs: Math.max(0, totalMs * 2 - run.metrics.memberBusyMs),
        tokens: run.state.usedTokens,
      });
      await manager.remove(a.id);
      await manager.remove(b.id);
    }
    const median = (key: keyof (typeof samples)[number]) =>
      Number(
        samples
          .map((item) => item[key])
          .sort((a, b) => a - b)[1]!
          .toFixed(3),
      );
    results.push({
      concurrency,
      samples: 3,
      medianTotalMs: median('totalMs'),
      medianSchedulerMs: median('schedulerMs'),
      medianMemberBusyMs: median('memberBusyMs'),
      medianCapacityIdleMs: median('capacityIdleMs'),
      messages: 2,
      requests: 8,
      syntheticTokens: 400,
      peakActive: Math.max(...samples.map((item) => item.peakActive)),
    });
  }
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        git: (await box.git(['--version'])).stdout.trim(),
        conditions:
          'Two persistent members, two ReadFile tasks per member; second task depends on first. Two fixed coordinator messages; deterministic coordinator with no model calls. Each child makes two requests with 100ms artificial delay and synthetic usage 40+10/request. Three sequential samples per setting. Includes ownership verification, Git subprocesses, atomic board writes and bounded context; excludes initial team/worktree creation and cleanup. Natural caches, no forced GC. Capacity idle is 2 * total time minus summed task busy time, not CPU idle. No paid model or money-cost measurement.',
        results,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await removeSandbox(box.root);
}
