import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { defaultContext, validateHistory } from '../../src/core/context.js';
import { SessionStore } from '../../src/core/session.js';
import type { SessionState } from '../../src/core/session.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import type { LLMProvider, LLMRequest, LLMEvent } from '../../src/providers/types.js';
import type { AgentEvent } from '../../src/core/agent-loop.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const options = {
  model: 'mock-v1',
  mode: 'accept-edits' as const,
  maxTurns: 100,
  timeoutMs: 30_000,
  maxOutputTokens: 512,
  maxTotalTokens: 2_000_000,
};
const stop: LLMEvent = { type: 'finish', reason: 'stop' };
function provider(round: (request: LLMRequest, turn: number) => LLMEvent[]): LLMProvider {
  let turn = 0;
  return {
    id: 'mock',
    capabilities: { streaming: true, toolCalling: true },
    async *stream(request) {
      yield* round(request, ++turn);
    },
  };
}
function call(name: string, input: unknown, callId: string): LLMEvent[] {
  return [
    { type: 'tool_call_delta', index: 0, callId, name, arguments: JSON.stringify(input) },
    { type: 'finish', reason: 'tool_calls' },
  ];
}
async function collect(agent: AgentLoop) {
  const events: AgentEvent[] = [];
  for await (const event of agent.run('original goal: inspect and validate')) events.push(event);
  return events;
}

describe('durable Agent context', () => {
  it('keeps previous context when compact candidate persistence fails', async () => {
    const box = await createSandbox();
    const store = await SessionStore.create(box.userDirectory, {
      cwd: box.cwd,
      provider: 'mock',
      model: 'mock-v1',
      mode: 'accept-edits',
    });
    try {
      await writeFile(join(box.cwd, 'source'), 'fixed-line\n'.repeat(5000));
      const executor = await ToolExecutor.create(createBuiltinRegistry(), {
        root: box.cwd,
        mode: 'accept-edits',
      });
      const original = store.commit.bind(store);
      let before: SessionState | undefined;
      vi.spyOn(store, 'commit').mockImplementation(async (state, event) => {
        if (event === 'compact') throw new Error('mock compact commit failure');
        before = structuredClone(state);
        return original(state, event);
      });
      const agent = new AgentLoop(
        provider((_request, turn) => call('ReadFile', { path: 'source' }, `read-${turn}`)),
        executor,
        {
          ...options,
          session: store,
          context: {
            ...defaultContext,
            windowTokens: 25_000,
            triggerRatio: 0.7,
            recentTurns: 2,
            summaryBytes: 1024,
            toolResultBytes: 2048,
          },
        },
      );
      await expect(collect(agent)).rejects.toThrow();
      expect(before).toBeDefined();
      expect(agent.history).toEqual(before!.messages);
      expect(agent.history.some((message) => message.contextSummary)).toBe(false);
      expect(validateHistory(agent.history)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await store.close();
      await removeSandbox(box.root);
    }
  });
  it('survives an actual process exit after external side effect and blocks replay', async () => {
    const box = await createSandbox();
    try {
      const repo = fileURLToPath(new URL('../../', import.meta.url));
      const crash = (await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          join(repo, 'tests/support/session-crash.ts'),
          box.cwd,
          box.userDirectory,
        ],
        { cwd: repo, timeout: 10_000 },
      ).catch((error: unknown) => error)) as { code: number };
      expect(crash.code).toBe(17);
      const id = await readFile(join(box.userDirectory, 'crash-session-id'), 'utf8');
      const recorded = await SessionStore.inspect(box.userDirectory, id);
      expect(recorded.state.actions).toHaveLength(1);
      expect(validateHistory(recorded.state.messages, true)).toEqual(['crash-call']);
      expect(await readFile(join(box.cwd, 'crash-effect'), 'utf8')).toContain('committed');
      await expect(SessionStore.resume(box.userDirectory, id, box.cwd)).rejects.toMatchObject({
        code: 'SESSION_LOCKED',
      });
      await SessionStore.unlock(box.userDirectory, id);
      const { store, state } = await SessionStore.resume(box.userDirectory, id, box.cwd);
      try {
        let executions = 0;
        const registry = createBuiltinRegistry();
        registry.register({
          name: 'ExternalMutation',
          description: 'never replay',
          effect: 'external',
          schema: z.strictObject({}),
          prepare: async (_input, context) => ({
            target: context.paths.root,
            preview: 'mock',
            run: async () => {
              executions++;
              return { content: 'unexpected' };
            },
          }),
        });
        const executor = await ToolExecutor.create(registry, {
          root: box.cwd,
          mode: 'default',
          approve: async () => true,
        });
        const model = provider((_request, turn) =>
          turn === 1 ? call('ExternalMutation', {}, 'new-call') : [stop],
        );
        const events = await collect(
          new AgentLoop(model, executor, {
            ...options,
            mode: 'default',
            resume: state,
            session: store,
          }),
        );
        expect(executions).toBe(0);
        expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
          result: { error: { code: 'ACTION_REPLAY_BLOCKED' } },
        });
      } finally {
        await store.close();
      }
    } finally {
      await removeSandbox(box.root);
    }
  });
  it('spills large read results, auto compacts full groups and preserves evidence access', async () => {
    const box = await createSandbox();
    const store = await SessionStore.create(box.userDirectory, {
      cwd: box.cwd,
      provider: 'mock',
      model: 'mock-v1',
      mode: 'accept-edits',
    });
    try {
      await writeFile(join(box.cwd, 'source'), 'fixed-line\n'.repeat(5000));
      const executor = await ToolExecutor.create(createBuiltinRegistry(), {
        root: box.cwd,
        mode: 'accept-edits',
      });
      const model = provider((request, turn) => {
        if (turn > 1) expect(() => validateHistory(request.messages)).not.toThrow();
        return turn <= 20 ? call('ReadFile', { path: 'source' }, `read-${turn}`) : [stop];
      });
      const agent = new AgentLoop(model, executor, {
        ...options,
        session: store,
        context: {
          ...defaultContext,
          windowTokens: 25_000,
          triggerRatio: 0.7,
          recentTurns: 2,
          summaryBytes: 1024,
          toolResultBytes: 2048,
        },
      });
      const events = await collect(agent);
      expect(events.filter((event) => event.type === 'compacted').length).toBeGreaterThan(0);
      const result = events.find((event) => event.type === 'tool_result') as Extract<
        AgentEvent,
        { type: 'tool_result' }
      >;
      expect(result.result).toMatchObject({
        truncated: true,
        data: { revision: expect.any(String) },
        spill: { file: expect.any(String) },
      });
      const spill = result.result as typeof result.result & { spill: { file: string } };
      expect(
        await SessionStore.result(box.userDirectory, store.owner.id, spill.spill.file),
      ).toMatchObject({ content: expect.stringContaining('fixed-line') });
      const saved = (await SessionStore.inspect(box.userDirectory, store.owner.id)).state;
      expect(saved.status).toBe('completed');
      expect(saved.seenIds).toHaveLength(20);
      expect(saved.messages[1]?.content).toContain('original goal');
      expect(validateHistory(saved.messages)).toEqual([]);
    } finally {
      await store.close();
      await removeSandbox(box.root);
    }
  });
  it('restores completed writes without replaying old IDs or same actions', async () => {
    const box = await createSandbox();
    const store = await SessionStore.create(box.userDirectory, {
      cwd: box.cwd,
      provider: 'mock',
      model: 'mock-v1',
      mode: 'accept-edits',
    });
    try {
      const executor = await ToolExecutor.create(createBuiltinRegistry(), {
        root: box.cwd,
        mode: 'accept-edits',
      });
      const model = provider((_request, turn) =>
        turn === 1 ? call('WriteFile', { path: 'saved', content: 'once' }, 'write-1') : [stop],
      );
      const first = new AgentLoop(model, executor, { ...options, session: store });
      for await (const event of first.run('create once')) if (event.type === 'tool_result') break;
      await store.close();
      expect(await readFile(join(box.cwd, 'saved'), 'utf8')).toBe('once');
      const { store: resumed, state } = await SessionStore.resume(
        box.userDirectory,
        store.owner.id,
        box.cwd,
      );
      try {
        const freshExecutor = await ToolExecutor.create(createBuiltinRegistry(), {
          root: box.cwd,
          mode: 'accept-edits',
        });
        const freshModel = provider((_request, turn) =>
          turn === 1 ? call('WriteFile', { content: 'once', path: 'saved' }, 'new-id') : [stop],
        );
        const events = await collect(
          new AgentLoop(freshModel, freshExecutor, { ...options, session: resumed, resume: state }),
        );
        expect(events.find((event) => event.type === 'tool_result')).toMatchObject({
          result: { error: { code: 'ACTION_REPLAY_BLOCKED' } },
        });
        expect(await readFile(join(box.cwd, 'saved'), 'utf8')).toBe('once');
        const repeated = new AgentLoop(
          provider(() => call('WriteFile', { path: 'other', content: 'no' }, 'write-1')),
          freshExecutor,
          { ...options, resume: state },
        );
        await expect(collect(repeated)).rejects.toMatchObject({ code: 'MODEL_PROTOCOL' });
      } finally {
        await resumed.close();
      }
    } finally {
      await store.close();
      await removeSandbox(box.root);
    }
  });
  it('persists an uncertain call when cancellation happens during a mutating operation', async () => {
    const box = await createSandbox();
    const store = await SessionStore.create(box.userDirectory, {
      cwd: box.cwd,
      provider: 'mock',
      model: 'mock-v1',
      mode: 'accept-edits',
    });
    try {
      const controller = new AbortController();
      const registry = createBuiltinRegistry();
      registry.register({
        name: 'ExternalMutation',
        description: 'local simulated side effect',
        effect: 'external',
        schema: z.strictObject({}),
        prepare: async (_input, context) => ({
          target: context.paths.root,
          preview: 'fixture',
          run: async () => {
            await writeFile(join(box.cwd, 'side-effect'), 'done');
            controller.abort();
            return { content: 'done' };
          },
        }),
      });
      const executor = await ToolExecutor.create(registry, {
        root: box.cwd,
        mode: 'accept-edits',
        approve: async () => true,
      });
      const agent = new AgentLoop(
        provider(() => call('ExternalMutation', {}, 'external-1')),
        executor,
        { ...options, session: store },
      );
      await expect(
        (async () => {
          for await (const _event of agent.run('perform mutation', controller.signal)) {
            void _event;
            /* drain */
          }
        })(),
      ).rejects.toMatchObject({ code: 'CANCELLED' });
      const state = (await SessionStore.inspect(box.userDirectory, store.owner.id)).state;
      expect(state.actions).toHaveLength(1);
      expect(await readFile(join(box.cwd, 'side-effect'), 'utf8')).toBe('done');
      expect(state.messages.at(-1)?.content).toContain('CANCELLED');
    } finally {
      await store.close();
      await removeSandbox(box.root);
    }
  });
  it('checkpoint failure blocks tool execution and compaction failure preserves history', async () => {
    const box = await createSandbox();
    const store = await SessionStore.create(box.userDirectory, {
      cwd: box.cwd,
      provider: 'mock',
      model: 'mock-v1',
      mode: 'accept-edits',
    });
    try {
      const original = store.commit.bind(store);
      vi.spyOn(store, 'commit').mockImplementation(async (state, event) => {
        if (event === 'intent') throw new Error('mock disk failure');
        return original(state, event);
      });
      const executor = await ToolExecutor.create(createBuiltinRegistry(), {
        root: box.cwd,
        mode: 'accept-edits',
      });
      const agent = new AgentLoop(
        provider(() => call('WriteFile', { path: 'never', content: 'no' }, 'write')),
        executor,
        { ...options, session: store },
      );
      await expect(collect(agent)).rejects.toThrow();
      await expect(readFile(join(box.cwd, 'never'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(validateHistory(agent.history)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
      await store.close();
      await removeSandbox(box.root);
    }
  });
  it('recovers incomplete invocation as data without automatically executing it', async () => {
    const box = await createSandbox();
    try {
      const state: SessionState = {
        mode: 'accept-edits',
        messages: [
          { role: 'system', content: 'old instructions' },
          { role: 'user', content: 'goal' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ callId: 'uncertain', name: 'Bash', arguments: '{"command":"danger"}' }],
          },
        ],
        seenIds: ['uncertain'],
        actions: [],
        turns: 1,
        toolCalls: 0,
        totalTokens: 100,
        estimated: false,
        failures: 0,
        status: 'running',
      };
      const executor = await ToolExecutor.create(createBuiltinRegistry(), {
        root: box.cwd,
        mode: 'accept-edits',
      });
      const model = provider((request) => {
        expect(request.messages[0]?.content).not.toBe('old instructions');
        expect(request.messages.at(-2)?.content).toContain('ACTION_UNCERTAIN');
        return [stop];
      });
      expect(
        (await collect(new AgentLoop(model, executor, { ...options, resume: state }))).at(-1),
      ).toMatchObject({ reason: 'completed', toolCalls: 0 });
      expect(executor.auditLog).toHaveLength(0);
    } finally {
      await removeSandbox(box.root);
    }
  });
});
