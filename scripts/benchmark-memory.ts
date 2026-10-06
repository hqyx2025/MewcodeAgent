import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { MemoryStore, selectMemories } from '../src/core/memory.js';
import type { MemorySnapshot } from '../src/core/memory.js';
import { createBuiltinRegistry } from '../src/tools/builtins.js';
import { ToolExecutor } from '../src/tools/executor.js';
import type { MemoryEntry } from '../src/core/memory-schema.js';
import { createSandbox, removeSandbox } from '../tests/support/sandbox.js';

const box = await createSandbox();
try {
  const store = new MemoryStore(box.cwd, box.userDirectory);
  const registry = createBuiltinRegistry();
  store.register(registry);
  const executor = await ToolExecutor.create(registry, {
    root: box.cwd,
    approve: async () => true,
  });
  const saved = await executor.execute(
    {
      callId: randomUUID(),
      name: 'MemoryUpdate',
      input: {
        scope: 'project',
        revision: null,
        kind: 'convention',
        text: '验证使用npm test',
        source: { type: 'manual' },
      },
    },
    new AbortController().signal,
  );
  assert(saved.ok);
  const header = '# MewCode memory\n\n```json\n';
  const footer = '\n```\n';
  const document = JSON.parse(
    (await readFile(store.paths.project, 'utf8')).slice(header.length, -footer.length),
  );
  const template = document.entries[0] as MemoryEntry;
  document.entries = [
    template,
    ...Array.from({ length: 99 }, (_, i) => ({
      ...template,
      id: randomUUID(),
      kind: 'fact',
      text: `模块${i} ${i % 2 ? '数据库连接SQLite' : '认证缓存Redis'}；已验证边界包含失败与取消 ${'fixture '.repeat(8)}`,
    })),
  ];
  await writeFile(store.paths.project, header + JSON.stringify(document, null, 2) + footer);
  const readMs: number[] = [],
    selectMs: number[] = [];
  let selected: ReturnType<typeof selectMemories> | undefined;
  let snapshot: MemorySnapshot | undefined;
  for (let i = 0; i < 7; i++) {
    let start = performance.now();
    snapshot = await store.read('project');
    readMs.push(performance.now() - start);
    start = performance.now();
    selected = selectMemories([snapshot], '修复认证缓存Redis的失败重试', 8192);
    selectMs.push(performance.now() - start);
    assert(selected.bytes <= 8192);
    assert(selected.entries[0]?.kind === 'convention');
    assert(selected.entries.slice(1).every((e) => e.text.includes('认证缓存Redis')));
    assert(
      selected.entries.every((e) =>
        snapshot!.entries.some((original) => original.id === e.id && original.text === e.text),
      ),
    );
  }
  const median = (values: number[]) => Number(values.sort((a, b) => a - b)[3]!.toFixed(3));
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        samples: 7,
        memoryEntries: 100,
        fileBytes: (await readFile(store.paths.project)).length,
        allEntriesJsonBytes: Buffer.byteLength(JSON.stringify(snapshot!.entries)),
        selected: selected!.entries.length,
        omitted: selected!.omitted,
        injectionBytes: selected!.bytes,
        conservativeEstimatedTokens: selected!.estimatedTokens,
        readMedianMs: median(readMs),
        selectMedianMs: median(selectMs),
        extraModelCalls: 0,
        extraModelTokens: 0,
        conditions:
          'fixed local 100-entry fixture; seven reads with validation/hash/filter and separate lexical selection; 8192-byte whole-entry JSON budget; no model/network/human wait; not a semantic recall evaluation',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await removeSandbox(box.root);
}
