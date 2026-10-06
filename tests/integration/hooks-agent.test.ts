import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../../src/core/agent-loop.js';
import type { AgentEvent } from '../../src/core/agent-loop.js';
import { SessionStore } from '../../src/core/session.js';
import { MockProvider } from '../../src/providers/mock.js';
import type { LLMProvider, LLMEvent } from '../../src/providers/types.js';
import { HookRuntime } from '../../src/tools/hooks.js';
import { hookEvents } from '../../src/tools/hook-schema.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
import { respond, writeHook } from '../support/hooks.js';

const options = {
  model: 'mock-v1',
  mode: 'default' as const,
  maxTurns: 4,
  timeoutMs: 15000,
  maxOutputTokens: 128,
};
const collect = async (agent: AgentLoop, prompt = 'read fixture', signal?: AbortSignal) => {
  const events: AgentEvent[] = [];
  for await (const event of agent.run(prompt, signal)) events.push(event);
  return events;
};

describe('hook lifecycle ownership and completion', () => {
  it('runs all five events in order with minimal fields, no hidden tool exposure or output injection', async () => {
    const box = await createSandbox();
    try {
      await writeFile(join(box.cwd, 'read.txt'), 'fixture');
      const source = `import{appendFileSync}from'node:fs';let text='';for await(const part of process.stdin)text+=part;
      const event=JSON.parse(text);appendFileSync('events.jsonl',JSON.stringify(event)+'\\n');${respond({ decision: 'continue' })}`;
      const configs = await Promise.all(
        hookEvents.map((event, i) =>
          writeHook(box.cwd, { id: `event-${i}`, event, script: `event-${i}.mjs` }, source),
        ),
      );
      const registry = createBuiltinRegistry();
      const hooks = new HookRuntime(registry, configs);
      const executor = await ToolExecutor.create(registry, {
        root: box.cwd,
        approve: async () => true,
        hooks: hooks.handle,
      });
      let turn = 0;
      const provider: LLMProvider = {
        id: 'fixture',
        capabilities: { streaming: true, toolCalling: true },
        stream: async function* (request): AsyncIterable<LLMEvent> {
          expect(request.tools?.some((tool) => tool.name === 'HookScript')).toBe(false);
          expect(JSON.stringify(request.messages)).not.toContain('events.jsonl');
          if (++turn === 1) {
            yield {
              type: 'tool_call_delta',
              index: 0,
              callId: randomUUID(),
              name: 'ReadFile',
              arguments: '{"path":"read.txt"}',
            };
            yield { type: 'finish', reason: 'tool_calls' };
          } else {
            yield { type: 'text_delta', text: 'done' };
            yield { type: 'finish', reason: 'stop' };
          }
        },
      };
      const events = await collect(new AgentLoop(provider, executor, options));
      expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'completed', toolCalls: 1 });
      const seen = (await readFile(join(box.cwd, 'events.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(seen.map((event) => event.event)).toEqual(hookEvents);
      expect(seen[2].tool).toMatchObject({ name: 'ReadFile' });
      expect(seen[2].tool).not.toHaveProperty('input');
      expect(seen[2].result).toEqual({ ok: true });
      expect(seen[4].reason).toBe('completed');
      expect(new Set(seen.map((event) => event.sessionId)).size).toBe(1);
      expect(new Set(seen.map((event) => event.eventId)).size).toBe(5);
      expect(hooks.auditLog).toHaveLength(5);
    } finally {
      await removeSandbox(box.root);
    }
  });

  it.each(['SessionStart', 'Stop'] as const)(
    'fails closed on %s and still notifies SessionEnd',
    async (event) => {
      const box = await createSandbox();
      try {
        const registry = createBuiltinRegistry();
        const guard = await writeHook(box.cwd, { event }, respond({ decision: 'block' }));
        const end = await writeHook(box.cwd, { event: 'SessionEnd', id: 'end', script: 'end.mjs' });
        const hooks = new HookRuntime(registry, [guard, end]);
        const executor = await ToolExecutor.create(registry, {
          root: box.cwd,
          approve: async () => true,
          hooks: hooks.handle,
        });
        let requests = 0;
        const provider: LLMProvider = {
          id: 'fixture',
          capabilities: { streaming: true, toolCalling: true },
          stream: async function* () {
            requests++;
            yield { type: 'finish', reason: 'stop' };
          },
        };
        let initializations = 0;
        await expect(
          collect(
            new AgentLoop(provider, executor, {
              ...options,
              initializeTools: async () => {
                initializations++;
              },
            }),
          ),
        ).rejects.toMatchObject({
          code: 'HOOK_FAILED',
        });
        expect(requests).toBe(event === 'SessionStart' ? 0 : 1);
        expect(initializations).toBe(event === 'SessionStart' ? 0 : 1);
        expect(hooks.auditLog.map((item) => item.event)).toEqual([event, 'SessionEnd']);
      } finally {
        await removeSandbox(box.root);
      }
    },
  );

  it('does not start SessionEnd scripts after cancellation and never reports completion', async () => {
    const box = await createSandbox();
    try {
      const registry = createBuiltinRegistry();
      const start = await writeHook(
        box.cwd,
        { event: 'SessionStart' },
        `import{writeFileSync}from'node:fs';writeFileSync('started.txt','ready');setInterval(()=>{},1000);`,
      );
      const end = await writeHook(
        box.cwd,
        { event: 'SessionEnd', id: 'end', script: 'end.mjs' },
        `import{writeFileSync}from'node:fs';writeFileSync('ended.txt','wrong');${respond({ decision: 'continue' })}`,
      );
      const hooks = new HookRuntime(registry, [start, end]);
      const executor = await ToolExecutor.create(registry, {
        root: box.cwd,
        approve: async () => true,
        hooks: hooks.handle,
      });
      const controller = new AbortController();
      const pending = collect(
        new AgentLoop(new MockProvider({ delayMs: 0 }), executor, options),
        'task',
        controller.signal,
      );
      // Attach the rejection handler before aborting to avoid an unhandled-promise window.
      const checked = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
      await vi.waitFor(() => stat(join(box.cwd, 'started.txt')), { timeout: 5000 });
      controller.abort();
      await checked;
      await expect(stat(join(box.cwd, 'ended.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(hooks.auditLog.at(-1)).toMatchObject({
        event: 'SessionEnd',
        outcome: 'error',
        code: 'CANCELLED',
      });
    } finally {
      await removeSandbox(box.root);
    }
  });

  it('notifies early consumer termination once and does not attempt Stop', async () => {
    const box = await createSandbox();
    try {
      const registry = createBuiltinRegistry();
      const hooks = new HookRuntime(
        registry,
        await Promise.all(
          hookEvents.map((event, i) =>
            writeHook(box.cwd, { event, id: `hook-${i}`, script: `hook-${i}.mjs` }),
          ),
        ),
      );
      const executor = await ToolExecutor.create(registry, {
        root: box.cwd,
        hooks: hooks.handle,
        approve: async () => true,
      });
      const task = new AgentLoop(new MockProvider({ delayMs: 0 }), executor, options).run('task');
      const stream = task[Symbol.asyncIterator]();
      expect((await stream.next()).value).toMatchObject({ type: 'prompt_info' });
      await stream.return?.();
      expect(hooks.auditLog.map((item) => item.event)).toEqual(['SessionStart', 'SessionEnd']);
    } finally {
      await removeSandbox(box.root);
    }
  });

  it('preserves a stopped checkpoint when Stop rejects and reloads hooks on resume without replaying tools', async () => {
    const box = await createSandbox();
    let store: SessionStore | undefined;
    try {
      store = await SessionStore.create(box.userDirectory, {
        cwd: box.cwd,
        model: 'mock-v1',
        provider: 'mock',
        mode: 'default',
      });
      const registry = createBuiltinRegistry();
      const guard = await writeHook(box.cwd, { event: 'Stop' }, respond({ decision: 'block' }));
      const hooks = new HookRuntime(registry, [guard]);
      const executor = await ToolExecutor.create(registry, {
        root: box.cwd,
        hooks: hooks.handle,
        approve: async () => true,
      });
      const provider: LLMProvider = {
        id: 'mock',
        capabilities: { streaming: true, toolCalling: true },
        stream: async function* () {
          yield { type: 'finish', reason: 'stop' };
        },
      };
      await expect(
        collect(new AgentLoop(provider, executor, { ...options, session: store })),
      ).rejects.toMatchObject({ code: 'HOOK_FAILED' });
      const id = store.owner.id;
      await store.close();
      store = undefined;
      const resumed = await SessionStore.resume(box.userDirectory, id, box.cwd);
      store = resumed.store;
      expect(resumed.state.status).toBe('stopped');
      await writeHook(box.cwd, { event: 'Stop' });
      const events = await collect(
        new AgentLoop(provider, executor, { ...options, session: store, resume: resumed.state }),
        'continue',
      );
      expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'completed', toolCalls: 0 });
      expect(hooks.auditLog.map((item) => item.outcome)).toEqual(['block', 'continue']);
    } finally {
      await store?.close();
      await removeSandbox(box.root);
    }
  });
});
