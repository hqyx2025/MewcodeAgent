import { appendFile, readFile, readdir, writeFile, symlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SessionStore, recoverState } from '../../src/core/session.js';
import type { SessionState } from '../../src/core/session.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
import type { LLMMessage } from '../../src/providers/types.js';

function longHistory(turns: number): LLMMessage[] {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'runtime' },
    { role: 'user', content: 'goal' },
  ];
  for (let i = 0; i < turns; i++)
    messages.push(
      {
        role: 'assistant',
        content: 'step',
        toolCalls: [{ callId: `call-${i}`, name: 'ReadFile', arguments: '{}' }],
      },
      { role: 'tool', callId: `call-${i}`, content: 'result' },
    );
  return messages;
}

const state = (): SessionState => ({
  mode: 'default',
  messages: longHistory(3),
  seenIds: ['call-0', 'call-1', 'call-2'],
  actions: [],
  totalTokens: 100,
  estimated: false,
  turns: 3,
  toolCalls: 3,
  failures: 0,
  status: 'running',
});
async function withStore(
  action: (store: SessionStore, storage: string, cwd: string) => Promise<void>,
  secrets: string[] = [],
) {
  const box = await createSandbox();
  const store = await SessionStore.create(
    box.userDirectory,
    { cwd: box.cwd, model: 'mock-v1', provider: 'mock', mode: 'default' },
    secrets,
  );
  try {
    await action(store, box.userDirectory, box.cwd);
  } finally {
    await store.close();
    await removeSandbox(box.root);
  }
}

describe('owned JSONL session storage', () => {
  it('round trips checkpoints, recovers torn tail and never adopts orphan snapshots', async () => {
    await withStore(async (store, storage, cwd) => {
      await store.commit(state());
      const first = await SessionStore.inspect(storage, store.owner.id);
      expect(first.state).toEqual(state());
      expect(await SessionStore.checkpoint(storage, store.owner.id, 1)).toEqual(state());
      await store.close();
      await appendFile(join(store.directory, 'events.jsonl'), '{"incomplete":');
      const orphan = join(store.directory, 'state-00002-00000000-0000-4000-8000-000000000001.json');
      await writeFile(orphan, 'orphan must not replace committed history');
      const resumed = await SessionStore.resume(storage, store.owner.id, cwd);
      try {
        expect(resumed.state).toEqual(state());
        await resumed.store.commit({ ...resumed.state, turns: 4 });
      } finally {
        await resumed.store.close();
      }
      expect((await SessionStore.inspect(storage, store.owner.id)).state.turns).toBe(4);
      expect(await readFile(orphan, 'utf8')).toContain('orphan');
    });
  });
  it('blocks concurrent locks, cross-project restore and active-process unlock', async () => {
    await withStore(async (store, storage, cwd) => {
      await store.commit(state());
      await expect(SessionStore.resume(storage, store.owner.id, cwd)).rejects.toMatchObject({
        code: 'SESSION_LOCKED',
      });
      await expect(SessionStore.unlock(storage, store.owner.id)).rejects.toMatchObject({
        code: 'SESSION_LOCKED',
      });
      await expect(SessionStore.delete(storage, store.owner.id)).rejects.toMatchObject({
        code: 'SESSION_LOCKED',
      });
      await expect(SessionStore.resume(storage, store.owner.id, storage)).rejects.toMatchObject({
        code: 'SESSION_INVALID',
      });
    });
  });
  it('redacts short/escaped secrets and preserves revision with complete spill retrieval', async () => {
    const secret = 'fixture-private-"-quoted';
    await withStore(
      async (store, storage) => {
        const initial = state();
        initial.messages[1]!.content += ` ${secret} tiny`;
        await store.commit(initial);
        const result = (await store.spill(
          {
            callId: 'result',
            name: 'ReadFile',
            ok: true,
            content: `${secret} ${JSON.stringify(secret)} tiny ${'x'.repeat(20_000)}`,
            data: { revision: 'rev-1', path: 'source' },
          },
          1024,
        )) as { content: string; data: { revision: string }; spill: { file: string } };
        expect(result.data.revision).toBe('rev-1');
        const restored = JSON.stringify(
          await SessionStore.result(storage, store.owner.id, result.spill.file),
        );
        expect(restored).not.toContain('fixture-private');
        expect(restored).not.toContain('tiny');
        expect(restored).toContain('[REDACTED]');
        const keyed = await store.spill(
          {
            callId: 'keyed',
            name: 'ReadFile',
            ok: true,
            content: 'small',
            data: { [secret]: 'value' },
          },
          1024,
        );
        expect(JSON.stringify(keyed)).not.toContain('fixture-private');
        expect(restored.length).toBeGreaterThan(20_000);
        const files = await readdir(store.directory);
        for (const file of files.filter((file) => file.endsWith('.json')))
          expect(await readFile(join(store.directory, file), 'utf8')).not.toContain(secret);
      },
      [secret, 'tiny'],
    );
  });
  it.each(['middle', 'version', 'snapshot'])(
    'rejects corrupted committed data: %s',
    async (kind) => {
      await withStore(async (store, storage) => {
        await store.commit(state());
        await store.close();
        if (kind === 'middle')
          await writeFile(
            join(store.directory, 'events.jsonl'),
            'bad\n' + (await readFile(join(store.directory, 'events.jsonl'), 'utf8')),
          );
        if (kind === 'version')
          await writeFile(
            join(store.directory, 'events.jsonl'),
            (await readFile(join(store.directory, 'events.jsonl'), 'utf8')).replace(
              '"schemaVersion":1',
              '"schemaVersion":999',
            ),
          );
        if (kind === 'snapshot') {
          const file = (await readdir(store.directory)).find((file) => file.startsWith('state-'))!;
          await appendFile(join(store.directory, file), 'tamper');
        }
        await expect(SessionStore.inspect(storage, store.owner.id)).rejects.toMatchObject({
          code: 'SESSION_INVALID',
        });
        await SessionStore.delete(storage, store.owner.id);
        expect(await SessionStore.list(storage)).toEqual([]);
      });
    },
  );
  it('persistent failure poisons the writer and preserves previous checkpoint', async () => {
    await withStore(async (store, storage) => {
      await store.commit(state());
      await writeFile(
        join(store.directory, 'lock.json'),
        JSON.stringify({ token: 'changed', pid: process.pid, host: hostname() }),
      );
      await expect(store.commit({ ...state(), turns: 4 })).rejects.toMatchObject({
        code: 'SESSION_LOCKED',
      });
      await expect(store.commit(state())).rejects.toMatchObject({ code: 'SESSION_IO' });
      expect((await SessionStore.inspect(storage, store.owner.id)).state.turns).toBe(3);
    });
  });
  it('rejects traversal and linked output directories before deleting', async () => {
    const box = await createSandbox();
    try {
      await expect(SessionStore.inspect(box.userDirectory, '../project')).rejects.toMatchObject({
        code: 'SESSION_INVALID',
      });
      const target = join(box.cwd, 'keep');
      await mkdir(target);
      await writeFile(join(target, 'user-file'), 'keep');
      await symlink(
        target,
        join(box.userDirectory, 'sessions'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(
        SessionStore.create(box.userDirectory, {
          cwd: box.cwd,
          model: 'mock',
          provider: 'mock',
          mode: 'plan',
        }),
      ).rejects.toMatchObject({ code: 'SESSION_INVALID' });
      expect(await readFile(join(target, 'user-file'), 'utf8')).toBe('keep');
    } finally {
      await removeSandbox(box.root);
    }
  });
  it('fills uncertain call pairs without executing or inventing success', () => {
    const pending = state();
    pending.messages.pop();
    const recovered = recoverState(pending);
    expect(recovered.status).toBe('uncertain');
    expect(JSON.parse(recovered.messages.at(-1)!.content).error.code).toBe('ACTION_UNCERTAIN');
    expect(pending.messages.length).toBe(7);
  });
});
