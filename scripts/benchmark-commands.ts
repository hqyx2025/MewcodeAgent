import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { MarkdownCommands } from '../src/core/command-templates.js';
import { parseCommand } from '../src/core/commands.js';
import { createSandbox, removeSandbox } from '../tests/support/sandbox.js';

const box = await createSandbox();
try {
  const directory = join(box.projectDirectory, 'commands');
  await mkdir(directory);
  const body =
    '---\ndescription: 固定本地模板\nargument-hint: "<path>"\n---\nReview $1; $ARGUMENTS\n' +
    'fixture '.repeat(7400);
  await Promise.all(
    Array.from({ length: 100 }, (_, i) => writeFile(join(directory, `task-${i}.md`), body)),
  );
  const templates = new MarkdownCommands({ ...box, allows: () => true });
  const indexMs: number[] = [],
    expandMs: number[] = [],
    parseMs: number[] = [];
  for (let sample = 0; sample < 7; sample++) {
    let start = performance.now();
    assert.equal((await templates.list(true)).length, 100);
    indexMs.push(performance.now() - start);
    start = performance.now();
    assert(
      (await templates.expand('task-1', ['中文 文件.ts'], '"中文 文件.ts"')).includes(
        'Review 中文 文件.ts',
      ),
    );
    expandMs.push(performance.now() - start);
    start = performance.now();
    for (let i = 0; i < 10000; i++)
      assert.equal(parseCommand('/task-1 "中文 文件.ts" $(whoami)')?.args[0], '中文 文件.ts');
    parseMs.push((performance.now() - start) / 10000);
  }
  const median = (values: number[]) => Number(values.sort((a, b) => a - b)[3]!.toFixed(4));
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        samples: 7,
        templates: 100,
        fileBytes: Buffer.byteLength(body),
        allTemplateBytes: Buffer.byteLength(body) * 100,
        indexPrefixBytes: 4096 * 100,
        bodyReadsPerInvocation: 1,
        indexMedianMs: median(indexMs),
        expandMedianMs: median(expandMs),
        parseMedianMs: median(parseMs),
        parseIterationsPerSample: 10000,
        extraModelCalls: 0,
        conditions:
          'fixed local 100-file fixture; seven index rebuilds, one 59KB body expansion per sample, 10000 Chinese/quoted parses per sample; warm OS filesystem cache possible; no network/model/approval wait',
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await removeSandbox(box.root);
}
