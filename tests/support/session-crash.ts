import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SessionStore } from '../../src/core/session.js';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { LLMProvider } from '../../src/providers/types.js';

const [cwd, storage] = process.argv.slice(2);
if (!cwd || !storage) throw new Error('fixture arguments');
const store = await SessionStore.create(storage, {
  cwd,
  model: 'mock-v1',
  provider: 'mock',
  mode: 'default',
});
await writeFile(join(storage, 'crash-session-id'), store.owner.id);
const registry = new ToolRegistry().register({
  name: 'ExternalMutation',
  description: 'crash fixture',
  effect: 'external',
  schema: z.strictObject({}),
  prepare: async (input, context) => ({
    target: context.paths.root,
    preview: 'simulated external operation',
    run: async () => {
      await writeFile(join(cwd, 'crash-effect'), 'committed external side effect');
      // Exit without finally to simulate loss between side effect and result commit.
      process.exit(17);
    },
  }),
});
const executor = await ToolExecutor.create(registry, { root: cwd, approve: async () => true });
const model: LLMProvider = {
  id: 'mock',
  capabilities: { streaming: true, toolCalling: true },
  async *stream() {
    yield {
      type: 'tool_call_delta',
      index: 0,
      callId: 'crash-call',
      name: 'ExternalMutation',
      arguments: '{}',
    };
    yield { type: 'finish', reason: 'tool_calls' };
  },
};
const agent = new AgentLoop(model, executor, {
  model: 'mock-v1',
  mode: 'default',
  maxTurns: 2,
  maxOutputTokens: 512,
  timeoutMs: 10_000,
  session: store,
});
for await (const event of agent.run('one external mutation')) void event;
