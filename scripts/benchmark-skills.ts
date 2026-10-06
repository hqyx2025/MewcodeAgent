import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SkillCatalog } from '../src/core/skills.js';
import { createSandbox, removeSandbox } from '../tests/support/sandbox.js';
import { writeSkill } from '../tests/support/skills.js';

const box = await createSandbox();
try {
  const body = 'Fixture guidance; ' + 'fixture '.repeat(1200);
  await Promise.all(
    Array.from({ length: 100 }, async (_, i) => {
      const root = await writeSkill(
        box.projectDirectory,
        `module-${i}`,
        `Module ${i} ${i < 2 ? 'Redis authentication cache performance' : 'SQL migration transactions'}`,
        body,
      );
      await writeFile(join(root, 'resource.txt'), 'resource '.repeat(1000));
    }),
  );
  const catalog = new SkillCatalog({ ...box, allows: () => true });
  const indexes: number[] = [],
    selections: number[] = [];
  let metadataBytes = 0,
    injectionBytes = 0,
    firstIndexHeapDelta = 0;
  for (let sample = 0; sample < 7; sample++) {
    const heapBefore = process.memoryUsage().heapUsed;
    let start = performance.now();
    const index = await catalog.list(true);
    indexes.push(performance.now() - start);
    if (sample === 0) firstIndexHeapDelta = process.memoryUsage().heapUsed - heapBefore;
    metadataBytes = Buffer.byteLength(JSON.stringify(index.entries));
    start = performance.now();
    const selection = await catalog.select('Redis authentication cache performance');
    selections.push(performance.now() - start);
    assert.deepEqual(
      selection.entries.map((entry) => entry.name),
      ['module-0', 'module-1'],
    );
    assert(selection.bytes <= 32768);
    injectionBytes = selection.bytes;
  }
  const median = (values: number[]) => Number(values.sort((a, b) => a - b)[3]!.toFixed(3));
  const allBodiesBytes = Buffer.byteLength(body) * 100;
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        samples: 7,
        skillFiles: 100,
        resourceFiles: 100,
        indexPrefixBytesUpperBound: 409600,
        indexMetadataJsonBytes: metadataBytes,
        firstIndexHeapDeltaBytes: firstIndexHeapDelta,
        selectedSkills: 2,
        bodyReadsPerSelection: 2,
        resourceReadsPerSelection: 0,
        allBodiesBytes,
        injectionBytes,
        conservativeEstimatedTokens: injectionBytes,
        avoidedBodyBytes: allBodiesBytes - Buffer.byteLength(body) * 2,
        injectionVsAllBodiesRatio: Number((injectionBytes / allBodiesBytes).toFixed(4)),
        indexMedianMs: median(indexes),
        selectionMedianMs: median(selections),
        extraModelCalls: 0,
        conditions:
          'fixed local 100-skill/100-resource fixture; seven bounded index rebuilds and lexical selections; whole selected bodies only; resource contents never read; warm filesystem caches possible; first-index heap delta is GC-uncontrolled transient allocation, JSON bytes are serialized metadata size; hypothetical all-body comparison exceeds normal budget; no network/model/approval wait',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await removeSandbox(box.root);
}
