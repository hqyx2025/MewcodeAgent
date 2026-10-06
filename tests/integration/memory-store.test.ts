import {
  lstat,
  readFile,
  writeFile,
  mkdir,
  rm,
  symlink,
  link,
  readdir,
  realpath,
  rename,
} from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MemoryStore } from '../../src/core/memory.js';
import type { MemoryEntry, MemoryScope } from '../../src/core/memory-schema.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
import type { ExecutorOptions } from '../../src/tools/executor.js';
import type * as FS from 'node:fs/promises';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FS>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

async function setup(
  options: Omit<ExecutorOptions, 'root' | 'approve'> & {
    approve?: ExecutorOptions['approve'];
  } = {},
  secrets: string[] = [],
) {
  const box = await createSandbox();
  const store = new MemoryStore(box.cwd, box.userDirectory, secrets);
  const registry = createBuiltinRegistry();
  store.register(registry);
  const { approve, ...otherOptions } = options;
  const approval = Object.hasOwn(options, 'approve') ? approve : async (): Promise<boolean> => true;
  const executor = await ToolExecutor.create(registry, {
    root: box.cwd,
    mode: 'accept-edits',
    ...otherOptions,
    ...(approval ? { approve: approval } : {}),
  });
  const run = (name: string, input: unknown, signal = new AbortController().signal) =>
    executor.execute({ callId: randomUUID(), name, input }, signal);
  const add = async (
    text: string,
    kind: MemoryEntry['kind'] = 'preference',
    scope: MemoryScope = 'project',
  ) =>
    run('MemoryUpdate', {
      scope,
      kind,
      text,
      source: { type: 'manual' },
      revision: (await store.read(scope)).revision,
    });
  return { box, store, registry, executor, run, add, close: () => removeSandbox(box.root) };
}
async function modify(path: string, change: (document: Record<string, unknown>) => void) {
  const text = await readFile(path, 'utf8');
  const document = JSON.parse(text.split('```json\n')[1]!.split('\n```')[0]!) as Record<
    string,
    unknown
  >;
  change(document);
  await writeFile(
    path,
    '# MewCode memory\n\n```json\n' + JSON.stringify(document, null, 2) + '\n```\n',
  );
}
describe('bounded confirmed memory store', () => {
  it('reads empty without creating files; hides management from model and blocks ordinary file tools', async () => {
    const h = await setup();
    try {
      expect((await h.store.read('user')).entries).toEqual([]);
      await expect(lstat(h.store.paths.user)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(h.registry.definitions()).toHaveLength(6);
      expect((await h.add('回答使用中文')).ok).toBe(true);
      for (const name of ['ReadFile', 'WriteFile', 'EditFile']) {
        const input =
          name === 'ReadFile'
            ? { path: '.mewcode/memory.md' }
            : name === 'WriteFile'
              ? { path: '.mewcode/memory.md', content: 'override' }
              : {
                  path: '.mewcode/memory.md',
                  oldText: '中文',
                  newText: 'override',
                  expectedRevision: 'a'.repeat(64),
                };
        expect((await h.run(name, input)).ok).toBe(false);
      }
      expect((await h.store.read('project')).entries[0]!.text).toBe('回答使用中文');
    } finally {
      await h.close();
    }
  });
  it.each([
    { mode: 'plan' as const, approve: async (): Promise<boolean> => true },
    { mode: 'accept-edits' as const, approve: async (): Promise<boolean> => false },
    { mode: 'accept-edits' as const, approve: undefined },
    {
      mode: 'default' as const,
      approve: async (): Promise<boolean> => true,
      rules: [{ source: 'project' as const, tool: 'MemoryUpdate', decision: 'deny' as const }],
    },
  ])('requires confirmation and preserves mode/deny: %o', async (options) => {
    const h = await setup(options);
    try {
      const result = await h.add('未经允许不保存');
      expect(result.error?.code).toBe('TOOL_PERMISSION');
      expect((await h.store.read('project')).entries).toEqual([]);
    } finally {
      await h.close();
    }
  });
  it('deduplicates normalized text, edits with new source, and removes only selected entry', async () => {
    const h = await setup();
    try {
      await h.add('Prefer TypeScript');
      const first = await h.store.read('project');
      expect((await h.add('prefer   typescript')).data).toMatchObject({ duplicate: true });
      expect((await h.store.read('project')).revision).toBe(first.revision);
      await h.add('运行npm test', 'convention');
      const current = await h.store.read('project');
      const id = first.entries[0]!.id;
      expect(
        (
          await h.run('MemoryUpdate', {
            scope: 'project',
            revision: current.revision,
            id,
            kind: 'preference',
            text: 'Prefer 中文',
            source: { type: 'manual' },
          })
        ).ok,
      ).toBe(true);
      expect(
        (
          await h.run('MemoryDelete', {
            scope: 'project',
            revision: (await h.store.read('project')).revision,
            id,
          })
        ).ok,
      ).toBe(true);
      expect((await h.store.read('project')).entries.map((e) => e.text)).toEqual(['运行npm test']);
      expect(await readdir(h.box.projectDirectory)).toEqual(['memory.md']);
    } finally {
      await h.close();
    }
  });
  it('shares explicitly global preferences but never project facts across projects', async () => {
    const h = await setup();
    try {
      await h.add('回答使用中文', 'preference', 'user');
      await h.add('项目A接口使用GraphQL', 'fact');
      expect((await h.add('项目A事实', 'fact', 'user')).error?.code).toBe('MEMORY_INVALID');
      const projectB = join(h.box.root, 'project B');
      await mkdir(projectB);
      const other = new MemoryStore(projectB, h.box.userDirectory);
      expect((await other.read('project')).entries).toEqual([]);
      expect((await other.read('user')).entries[0]?.text).toBe('回答使用中文');
      await mkdir(join(projectB, '.mewcode'));
      await writeFile(other.paths.project, await readFile(h.store.paths.project));
      await expect(other.read('project')).rejects.toMatchObject({ code: 'MEMORY_INVALID' });
      const executorB = await ToolExecutor.create(h.registry, { root: projectB });
      const result = await executorB.execute(
        { callId: randomUUID(), name: 'MemoryRead', input: { scope: 'project' } },
        new AbortController().signal,
      );
      expect(result.error?.code).toBe('MEMORY_INVALID');
    } finally {
      await h.close();
    }
  });
  it('rejects stale revisions and changes during approval without overwriting either update', async () => {
    const h = await setup();
    try {
      await h.add('original');
      const before = await h.store.read('project');
      const concurrent = await ToolExecutor.create(h.registry, {
        root: h.box.cwd,
        approve: async () => {
          await h.add('concurrent');
          return true;
        },
      });
      const result = await concurrent.execute(
        {
          callId: randomUUID(),
          name: 'MemoryUpdate',
          input: {
            scope: 'project',
            revision: before.revision,
            kind: 'preference',
            text: 'stale',
            source: { type: 'manual' },
          },
        },
        new AbortController().signal,
      );
      expect(result.error?.code).toBe('MEMORY_CONFLICT');
      expect((await h.store.read('project')).entries.map((e) => e.text)).toEqual([
        'original',
        'concurrent',
      ]);
      expect(await readdir(h.box.projectDirectory)).toEqual(['memory.md']);
    } finally {
      await h.close();
    }
  });
  it('enforces exclusive locks; explicit unlock requires a dead same-host owner', async () => {
    const h = await setup();
    try {
      await h.add('original');
      const path = join(h.box.projectDirectory, 'memory.lock');
      const ownedLock = (pid: number, host = hostname()) =>
        JSON.stringify({ app: 'mewcode-agent-memory', token: randomUUID(), pid, host });
      await writeFile(path, ownedLock(process.pid));
      expect((await h.add('blocked')).error?.code).toBe('MEMORY_LOCKED');
      expect((await h.run('MemoryUnlock', { scope: 'project' })).error?.code).toBe('MEMORY_LOCKED');
      const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
      await once(child, 'close');
      await writeFile(path, ownedLock(child.pid!, 'other-host'));
      expect((await h.run('MemoryUnlock', { scope: 'project' })).error?.code).toBe(
        'MEMORY_INVALID',
      );
      await writeFile(path, ownedLock(child.pid!));
      expect((await h.run('MemoryUnlock', { scope: 'project' })).ok).toBe(true);
      expect((await h.add('after unlock')).ok).toBe(true);
    } finally {
      await h.close();
    }
  });
  it('bounds concurrent writers without losing an acknowledged update', async () => {
    const h = await setup();
    try {
      const revision = (await h.store.read('project')).revision;
      const other = await ToolExecutor.create(h.registry, {
        root: h.box.cwd,
        approve: async () => true,
      });
      const input = (text: string) => ({
        scope: 'project',
        revision,
        text,
        kind: 'preference',
        source: { type: 'manual' },
      });
      const results = await Promise.all([
        h.run('MemoryUpdate', input('writer A')),
        other.execute(
          { callId: randomUUID(), name: 'MemoryUpdate', input: input('writer B') },
          new AbortController().signal,
        ),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(['MEMORY_LOCKED', 'MEMORY_CONFLICT']).toContain(
        results.find((r) => !r.ok)?.error?.code,
      );
      expect((await h.store.read('project')).entries).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
  it('enforces 100-entry and 64KiB limits without overwriting the previous document', async () => {
    const h = await setup();
    try {
      await h.add('fixture');
      await modify(h.store.paths.project, (document) => {
        const template = (document.entries as MemoryEntry[])[0]!;
        document.entries = Array.from({ length: 100 }, (_, i) => ({
          ...template,
          id: randomUUID(),
          text: `fact-${i}`,
        }));
      });
      const before = await readFile(h.store.paths.project);
      expect((await h.add('101st entry')).error?.code).toBe('MEMORY_INVALID');
      expect(await readFile(h.store.paths.project)).toEqual(before);
      await modify(h.store.paths.project, (document) => {
        const template = (document.entries as MemoryEntry[])[0]!;
        const entries: MemoryEntry[] = [];
        document.entries = entries;
        for (let i = 0; i < 100; i++) {
          entries.push({ ...template, id: randomUUID(), text: `${i} ${'a'.repeat(1010)}` });
          if (Buffer.byteLength(JSON.stringify(document, null, 2)) > 64 * 1024 - 1024) {
            entries.pop();
            break;
          }
        }
      });
      const current = await h.store.read('project');
      expect((await h.add('中文'.repeat(500))).error?.code).toBe('MEMORY_INVALID');
      expect((await h.store.read('project')).revision).toBe(current.revision);
    } finally {
      await h.close();
    }
  });
  it.each([
    'tiny',
    'quote"token',
    'sk-' + 'x'.repeat(30),
    'password: do-not-save',
    '银行卡：6222000000000000',
    ['-----BEGIN', 'PRIVATE', 'KEY-----data'].join(' '),
  ])('rejects sensitive text without echoing it: %s', async (secret) => {
    const h = await setup({}, ['tiny', 'quote"token']);
    try {
      const result = await h.add(secret);
      expect(result.error?.code).toBe('MEMORY_INVALID');
      expect(JSON.stringify(result)).not.toContain(secret);
      expect((await h.store.read('project')).entries).toEqual([]);
    } finally {
      await h.close();
    }
  });
  it('filters sensitive entries introduced by external edits before showing or injecting', async () => {
    const h = await setup({}, ['known-sensitive-value']);
    try {
      await h.add('safe');
      await modify(h.store.paths.project, (document) => {
        (document.entries as MemoryEntry[])[0]!.text = 'known-sensitive-value';
      });
      const result = await h.run('MemoryRead', { scope: 'project' });
      expect(result.data).toMatchObject({ entries: [], filtered: 1 });
      expect(JSON.stringify(result)).not.toContain('known-sensitive-value');
    } finally {
      await h.close();
    }
  });
  it.each(['version', 'owner', 'duplicate', 'invalid-json', 'invalid-utf8', 'oversize'])(
    'rejects corrupted or foreign memory: %s',
    async (scenario) => {
      const h = await setup();
      try {
        await h.add('source-private-marker');
        if (scenario === 'invalid-json')
          await writeFile(h.store.paths.project, 'source-private-marker');
        else if (scenario === 'invalid-utf8')
          await writeFile(h.store.paths.project, Buffer.from([0xff, 0xfe]));
        else if (scenario === 'oversize') await writeFile(h.store.paths.project, 'x'.repeat(65537));
        else
          await modify(h.store.paths.project, (document) => {
            if (scenario === 'version') document.schemaVersion = 2;
            if (scenario === 'owner') document.owner = 'foreign-project';
            if (scenario === 'duplicate')
              (document.entries as MemoryEntry[]).push((document.entries as MemoryEntry[])[0]!);
          });
        const result = await h.run('MemoryRead', { scope: 'project' });
        expect(result.error?.code).toBe('MEMORY_INVALID');
        expect(JSON.stringify(result)).not.toContain('source-private-marker');
      } finally {
        await h.close();
      }
    },
  );
  it('rejects junction directories and hardlinked files without touching the other paths', async () => {
    const h = await setup();
    try {
      await h.add('owned');
      const other = join(h.box.root, 'other-memory');
      await link(h.store.paths.project, other);
      expect((await h.run('MemoryRead', { scope: 'project' })).error?.code).toBe('MEMORY_INVALID');
      await rm(other);
      await rm(h.box.projectDirectory, { recursive: true });
      const foreign = join(h.box.root, 'foreign');
      await mkdir(foreign);
      await writeFile(join(foreign, 'memory.md'), 'do-not-read');
      await symlink(
        await realpath(foreign),
        h.box.projectDirectory,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      expect((await h.run('MemoryRead', { scope: 'project' })).error?.code).toBe('MEMORY_INVALID');
      expect((await h.add('blocked').catch((error) => error)).code).toBe('MEMORY_INVALID');
      expect(await readFile(join(foreign, 'memory.md'), 'utf8')).toBe('do-not-read');
    } finally {
      await h.close();
    }
  });
  it('aborts before persistence and retains the old file on a failed atomic rename', async () => {
    const h = await setup();
    try {
      await h.add('original');
      const original = await readFile(h.store.paths.project);
      const controller = new AbortController();
      controller.abort();
      expect(
        (
          await h.run(
            'MemoryDelete',
            {
              scope: 'project',
              revision: (await h.store.read('project')).revision,
              id: (await h.store.read('project')).entries[0]!.id,
            },
            controller.signal,
          )
        ).error?.code,
      ).toBe('CANCELLED');
      vi.mocked(rename).mockRejectedValueOnce(new Error('mock rename failure'));
      expect((await h.add('failure')).error?.code).toBe('MEMORY_IO');
      expect(await readFile(h.store.paths.project)).toEqual(original);
      expect(await readdir(h.box.projectDirectory)).toEqual(['memory.md']);
    } finally {
      vi.restoreAllMocks();
      await h.close();
    }
  });
});
