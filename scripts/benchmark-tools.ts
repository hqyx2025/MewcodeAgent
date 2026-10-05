import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createBuiltinRegistry } from '../src/tools/builtins.js';
import { ToolExecutor } from '../src/tools/executor.js';

const temporary = await mkdtemp(join(tmpdir(), 'mewcode-tools-benchmark-'));
try {
  const root = join(temporary, '万文件 中文项目');
  await mkdir(root);
  for (const base of ['src', 'noise']) {
    for (let bucket = 0; bucket < 25; bucket += 1) {
      const directory = join(root, base, `bucket-${bucket}`);
      await mkdir(directory, { recursive: true });
      for (let batch = 0; batch < 10; batch += 1) {
        await Promise.all(
          Array.from({ length: 20 }, (_, offset) => {
            const file = batch * 20 + offset;
            const target = base === 'src' && bucket % 5 === 0 && file === 0;
            return writeFile(
              join(directory, `${target ? 'target' : 'file'}-${file}.ts`),
              target
                ? 'export const marker = "mewcode_benchmark_needle";\n'
                : 'export const value = 1;\n',
            );
          }),
        );
      }
    }
  }
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await writeFile(join(root, 'node_modules', 'ignore.ts'), 'mewcode_benchmark_needle');
  const executor = await ToolExecutor.create(createBuiltinRegistry(), { root });
  const scenarios = [
    { name: 'Glob', label: '全树稀疏匹配', input: { pattern: '**/target-*.ts' } },
    { name: 'Glob', label: '限定src稀疏匹配', input: { pattern: 'src/**/target-*.ts' } },
    { name: 'Glob', label: '广泛匹配截断', input: { pattern: '**/*.ts', maxResults: 200 } },
    {
      name: 'Grep',
      label: '全树稀疏匹配',
      input: { pattern: 'mewcode_benchmark_needle', literal: true },
    },
    {
      name: 'Grep',
      label: '限定src稀疏匹配',
      input: { pattern: 'mewcode_benchmark_needle', literal: true, path: 'src' },
    },
  ];
  const measurements = [];
  for (const scenario of scenarios) {
    const times: number[] = [];
    let bytes = 0;
    let truncated = false;
    for (let sample = 0; sample < 3; sample += 1) {
      const started = performance.now();
      const result = await executor.execute({
        callId: randomUUID(),
        name: scenario.name,
        input: scenario.input,
      });
      times.push(performance.now() - started);
      assert(result.ok, `${scenario.name} failed: ${result.error?.code}`);
      bytes = Buffer.byteLength(JSON.stringify(result));
      truncated = result.truncated ?? false;
      if (scenario.label !== '广泛匹配截断') {
        const data = result.data as { paths?: unknown[]; matches?: unknown[] };
        assert.equal((data.paths ?? data.matches)?.length, 5);
      } else assert(truncated);
    }
    times.sort((a, b) => a - b);
    measurements.push({
      tool: scenario.name,
      scenario: scenario.label,
      medianMs: Number(times[1]!.toFixed(2)),
      bytes,
      truncated,
    });
  }
  process.stdout.write(
    `${JSON.stringify({ platform: process.platform, node: process.version, files: 10000, samples: 3, measurements }, null, 2)}\n`,
  );
} finally {
  assert(
    dirname(resolve(temporary)) === resolve(tmpdir()) &&
      temporary.includes('mewcode-tools-benchmark-'),
  );
  await rm(temporary, { recursive: true, force: true });
}
