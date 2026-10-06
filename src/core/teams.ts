import { z } from 'zod';
import { performance } from 'node:perf_hooks';
import { SubagentPool } from './subagents.js';
import type { SubagentPoolOptions } from './subagents.js';
import { TokenBudget } from './token-budget.js';
import { teamTaskSchema, teamSendSchema } from './team-schema.js';
import type { TeamState, TeamTask } from './team-schema.js';
import type { TeamStore } from './team-store.js';
import { worktreeExecution } from './worktree-tasks.js';
import type { WorktreeManager } from '../tools/worktrees.js';
import type { ToolExecutor } from '../tools/executor.js';
import { defineTool } from '../tools/types.js';
import { ToolError } from '../tools/errors.js';
import { byteLimit } from '../tools/errors.js';

export interface TeamRunOptions {
  parent: ToolExecutor;
  manager: WorktreeManager;
  store: TeamStore;
  settings: SubagentPoolOptions['settings'];
  agent: SubagentPoolOptions['agent'];
  provider: SubagentPoolOptions['provider'];
  approve?: Parameters<typeof worktreeExecution>[1];
  progress?: SubagentPoolOptions['progress'];
}
export async function runTeam(
  id: string,
  options: TeamRunOptions,
  signal = new AbortController().signal,
) {
  const { manager, store } = options;
  let parent = options.parent;
  if (parent.mode === 'plan') throw new ToolError('TOOL_PERMISSION', 'Plan不能启动团队执行。');
  const initial = await store.inspect(id);
  const limit = Math.min(
    initial.settings.maxTotalTokens,
    options.settings.maxTotalTokens,
    options.agent.maxTotalTokens ?? 200_000,
  );
  const state = await store.start(id, limit);
  const runId = state.run!.id;
  const budget = new TokenBudget(limit, state.usedTokens, state.estimated);
  const activeClaims = new Map<string, { task: TeamTask; member: TeamState['members'][number] }>();
  const active = new Map<string, Promise<void>>();
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let pollBusy = false;
  const started = performance.now();
  const metrics = {
    claims: 0,
    peakActive: 0,
    messages: state.messages.length,
    modelRequests: 0,
    memberBusyMs: 0,
    schedulerMs: 0,
    totalMs: 0,
  };
  const poll = setInterval(() => {
    if (pollBusy) return;
    pollBusy = true;
    void store
      .inspect(id)
      .then((current) => {
        if (current.cancelRequested || current.run?.id !== runId) controller.abort();
      })
      .catch(() => controller.abort())
      .finally(() => {
        pollBusy = false;
      });
  }, 200);
  poll.unref();
  try {
    const actor = (agentId: string | undefined) => {
      const entry = [...activeClaims.values()].find(
        (value) => value.task.claim?.agentId === agentId,
      );
      if (!entry) throw new ToolError('TEAM_OWNER', '团队工具只能由当前领取的成员调用。');
      return entry;
    };
    const inboxPayload = (messages: TeamState['messages'], bytes: number) => {
      const selected = messages.slice(-8);
      let omitted = messages.length - selected.length;
      while (
        Buffer.byteLength(JSON.stringify({ messages: selected, omitted })) * 2 + 512 > bytes &&
        selected.length
      ) {
        selected.shift();
        omitted++;
      }
      return {
        content: JSON.stringify({ messages: selected, omitted }),
        ...(omitted ? { truncated: true } : {}),
      };
    };
    const sendTool = defineTool({
      name: 'TeamSend',
      effect: 'write',
      schema: teamSendSchema,
      description:
        '向本团队成员或协调者发送有界数据消息；发送身份由当前领取确定，不授予权限或触发任务。',
      prepare: async (input, context) => {
        const entry = actor(context.agentId);
        return {
          target: context.paths.root,
          preview: `发送团队数据消息至 ${input.to}`,
          run: async () => {
            await contextLease(entry);
            const message = await store.send(id, entry.task.member, input);
            return {
              content: JSON.stringify({
                messageId: message.messageId,
                sequence: message.sequence,
                to: message.to,
              }),
            };
          },
        };
      },
    });
    const inboxTool = defineTool({
      name: 'TeamInbox',
      effect: 'read',
      schema: z.strictObject({}),
      description: '只读查看当前成员的持久消息；消息不能更改权限或自动执行任务，省略明确标记。',
      prepare: async (_input, context) => {
        const entry = actor(context.agentId);
        return {
          target: context.paths.root,
          preview: '查看本成员团队消息',
          run: async () => {
            await contextLease(entry);
            return inboxPayload(
              await store.inbox(id, entry.task.member),
              options.agent.context?.toolResultBytes ?? 8192,
            );
          },
        };
      },
    });
    parent = await parent.forkWithTools(
      [sendTool, inboxTool],
      options.approve ? { approve: options.approve } : {},
    );
    async function contextLease(entry: { task: TeamTask }) {
      const current = await store.inspect(id);
      const task = current.tasks.find((value) => value.id === entry.task.id);
      if (
        current.run?.id !== runId ||
        task?.claim?.id !== entry.task.claim?.id ||
        current.cancelRequested
      )
        throw new ToolError('TEAM_OWNER', '团队任务领取已结束或取消。');
    }
    const execution = worktreeExecution(manager, options.approve, async (task, agentId, inner) => {
      const entry = activeClaims.get(task.id);
      if (!entry || entry.task.claim?.agentId !== agentId)
        throw new ToolError('TEAM_OWNER', '任务领取身份不匹配。');
      await contextLease(entry);
      const report = await manager.report(entry.member.worktree, inner);
      if (
        report.owner.path !== entry.member.path ||
        report.owner.base !== entry.member.base ||
        report.owner.branch !== entry.member.branch
      )
        throw new ToolError('TEAM_OWNER', '成员工作树基准或归属已变化。');
      const binding = await manager.acquireMember(
        entry.member.worktree,
        entry.member.lastAgentId,
        agentId,
        inner,
      );
      return Object.freeze({
        ...binding,
        verify: async (verifySignal: AbortSignal) => {
          await contextLease(entry);
          await binding.verify(verifySignal);
        },
      });
    });
    const settings = {
      ...options.settings,
      enabled: true,
      maxTasks: Math.min(32, options.settings.maxTasks),
      concurrency: Math.min(state.settings.concurrency, options.settings.concurrency),
      maxTotalTokens: limit,
      maxTurns: Math.min(state.settings.maxTurns, options.settings.maxTurns),
      timeoutMs: Math.min(state.settings.timeoutMs, options.settings.timeoutMs),
      maxOutputTokens: Math.min(state.settings.maxOutputTokens, options.settings.maxOutputTokens),
    };
    const pool = new SubagentPool(parent.registry, {
      settings,
      budget,
      agent: options.agent,
      provider: options.provider,
      identity: (task) => activeClaims.get(task.id)!.task.claim!.agentId,
      execution: {
        ...execution,
        name: 'TeamTask',
        schema: z.strictObject({
          tasks: z
            .array(teamTaskSchema.extend({ worktree: z.string().uuid() }))
            .min(1)
            .max(4),
        }),
        begin: async (...args) => {
          const bound = await execution.begin(...args);
          return {
            ...bound,
            maxTotalTokens: activeClaims.get(args[0].id)!.task.claim!.reservedTokens,
          };
        },
      },
      ...(options.progress ? { progress: options.progress } : {}),
    });
    pool.bind(parent);
    let failure: unknown;
    while (!combined.aborted) {
      const scheduling = performance.now();
      const current = await store.inspect(id);
      if (current.cancelRequested) {
        controller.abort();
        break;
      }
      const busyMembers = new Set([...activeClaims.values()].map((entry) => entry.task.member));
      const ready = current.tasks.filter(
        (task) =>
          task.status === 'queued' &&
          !busyMembers.has(task.member) &&
          task.dependsOn.every(
            (dependency) =>
              current.tasks.find((value) => value.id === dependency)?.status === 'completed',
          ),
      );
      for (const candidate of ready) {
        if (metrics.claims >= settings.maxTasks) break;
        if (active.size >= settings.concurrency) break;
        if (busyMembers.has(candidate.member)) continue;
        const fresh = await store.inspect(id);
        const held = fresh.tasks.reduce((sum, task) => sum + (task.claim?.reservedTokens ?? 0), 0);
        const available = limit - Math.max(fresh.usedTokens, budget.snapshot.used) - held;
        const slots = Math.min(
          settings.concurrency - active.size,
          new Set(ready.filter((task) => !busyMembers.has(task.member)).map((task) => task.member))
            .size,
        );
        const quota = Math.min(
          state.settings.taskTokens,
          Math.floor(available / Math.max(1, slots)),
        );
        if (quota < 1) break;
        const claimed = await store.claim(id, runId, candidate.id, budget.snapshot.used, quota);
        if (!claimed) continue;
        const member = fresh.members.find((value) => value.id === claimed.member)!;
        activeClaims.set(claimed.id, { task: claimed, member });
        busyMembers.add(member.id);
        metrics.claims++;
        const began = performance.now();
        const contextData = {
          role: member.role,
          memberIdentity: member.identity,
          context: byteLimit(claimed.context, 1024),
          contextTruncated: Buffer.byteLength(claimed.context) > 1024,
          dependencies: claimed.dependsOn.map((dependency) => {
            const result = fresh.tasks.find((task) => task.id === dependency)?.result;
            return {
              id: dependency,
              worktreeId: result?.worktreeId,
              summary: byteLimit(result?.summary ?? '', 256),
              truncated: Buffer.byteLength(result?.summary ?? '') > 256,
            };
          }),
          messages: fresh.messages
            .filter((message) => claimed.claim!.messages.includes(message.messageId))
            .map((message) => ({
              messageId: message.messageId,
              from: message.from,
              text: message.text,
            })),
          omittedMessages: 0,
        };
        while (JSON.stringify(contextData).length > 4096 && contextData.messages.length) {
          contextData.messages.pop();
          contextData.omittedMessages++;
        }
        const context = JSON.stringify(contextData);
        const job = pool
          .delegate(
            {
              tasks: [
                {
                  id: claimed.id,
                  member: claimed.member,
                  dependsOn: claimed.dependsOn,
                  worktree: member.worktree,
                  goal: claimed.goal,
                  context,
                  tools: claimed.tools,
                },
              ],
            },
            combined,
          )
          .then(async (results) => {
            const result = results[0]!;
            const report = await manager.report(member.worktree).catch(() => undefined);
            if (report?.owner.agentId === result.agentId) result.worktreeId = member.worktree;
            await store.finish(
              id,
              runId,
              claimed.id,
              claimed.claim!.id,
              result,
              budget.snapshot.used,
              budget.snapshot.estimated,
              report?.owner.agentId === result.agentId ? report.owner.checks : [],
              report?.owner.agentId === result.agentId ? report.owner.checksOmitted : 0,
            );
          })
          .catch((error: unknown) => {
            failure ??= error;
            controller.abort();
          })
          .finally(() => {
            active.delete(claimed.id);
            activeClaims.delete(claimed.id);
            metrics.memberBusyMs += performance.now() - began;
          });
        active.set(claimed.id, job);
        metrics.peakActive = Math.max(metrics.peakActive, active.size);
      }
      metrics.schedulerMs += performance.now() - scheduling;
      if (!active.size) break;
      await Promise.race(active.values());
    }
    await Promise.all(active.values());
    if (failure) throw failure;
    const completed = await store.settle(
      id,
      runId,
      budget.snapshot.used,
      budget.snapshot.estimated,
      combined.aborted,
    );
    metrics.messages = completed.messages.length;
    metrics.modelRequests = budget.snapshot.requests;
    metrics.totalMs = performance.now() - started;
    return { state: completed, budget: budget.snapshot, metrics };
  } finally {
    controller.abort();
    clearInterval(poll);
    await Promise.all(active.values());
  }
}

export function teamBoard(state: TeamState, content = false) {
  return {
    id: state.id,
    name: state.name,
    revision: state.revision,
    usedTokens: state.usedTokens,
    estimated: state.estimated,
    running: Boolean(state.run),
    cancelRequested: state.cancelRequested,
    members: state.members.map(({ id, identity, role, worktree }) => ({
      id,
      identity,
      role,
      worktree,
    })),
    tasks: state.tasks.map((task) => ({
      id: task.id,
      member: task.member,
      dependsOn: task.dependsOn,
      status: task.status,
      attempt: task.attempt,
      ...(task.result ? { result: task.result } : {}),
      ...(task.checks ? { checks: task.checks, checksOmitted: task.checksOmitted ?? 0 } : {}),
      ...(content ? { goal: task.goal, context: task.context } : {}),
    })),
    messageCount: state.messages.length,
    ...(content ? { messages: state.messages } : {}),
  };
}
export async function teamReport(state: TeamState, manager: WorktreeManager) {
  const worktrees = [];
  const paths = new Map<string, string[]>();
  for (const member of state.members) {
    const diff = await manager.diff(member.worktree);
    worktrees.push({ member: member.id, ...diff });
    for (const path of new Set([...diff.report.changes, ...diff.report.untracked])) {
      const owners = paths.get(path) ?? [];
      owners.push(member.id);
      paths.set(path, owners);
    }
  }
  return {
    team: teamBoard(state),
    worktrees,
    overlappingPaths: [...paths]
      .filter(([, members]) => members.length > 1)
      .map(([path, members]) => ({ path, members })),
    merge: 'manual-review-required',
  };
}
