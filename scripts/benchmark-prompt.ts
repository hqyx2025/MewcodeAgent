import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { ProjectInstructions } from '../src/core/instructions.js';
import { buildSystemPrompt } from '../src/core/prompt.js';
import { ProjectPaths } from '../src/security/paths.js';

const temporary = await mkdtemp(join(tmpdir(), 'mewcode-prompt-bench-'));
try {
  await mkdir(join(temporary, 'src', 'target'), { recursive: true });
  await writeFile(join(temporary, 'AGENTS.md'), 'Use project checks.');
  await writeFile(join(temporary, 'src', 'target', 'AGENTS.md'), 'Scoped: prefer exact edits.');
  for (let index = 0; index < 100; index++) {
    const directory = join(temporary, `unrelated-${index}`);
    await mkdir(directory);
    await writeFile(join(directory, 'AGENTS.md'), 'unrelated fixture guidance '.repeat(10));
    for (let file = 0; file < 10; file++)
      await writeFile(join(directory, `file-${file}.txt`), 'fixture');
  }
  const paths = await ProjectPaths.create(temporary);
  const context = {
    cwd: paths.root,
    model: 'mock-v1',
    mode: 'plan' as const,
    shell: {
      kind: process.platform === 'win32' ? ('powershell' as const) : ('bash' as const),
      executable: 'fixture-shell',
    },
    tools: [{ name: 'ReadFile', description: 'read', effect: 'read' }],
    budgets: {
      maxTurns: 10,
      timeoutMs: 5000,
      maxOutputTokens: 512,
      maxTotalTokens: 200_000,
      maxContextCharacters: 200_000,
      maxFailures: 3,
    },
  };
  const cold: number[] = [];
  const cached: number[] = [];
  let metrics: Record<string, unknown> = {};
  for (let sample = 0; sample < 5; sample++) {
    const catalog = new ProjectInstructions(paths);
    let start = performance.now();
    await catalog.discover('src/target/example.txt', 'file', new AbortController().signal);
    const prompt = buildSystemPrompt(context, catalog.sources);
    cold.push(performance.now() - start);
    start = performance.now();
    assert.equal(
      await catalog.discover('src/target/example.txt', 'file', new AbortController().signal),
      false,
    );
    buildSystemPrompt(context, catalog.sources);
    cached.push(performance.now() - start);
    assert.equal(catalog.sources.length, 2);
    assert.equal(catalog.checkedDirectories, 3);
    metrics = {
      checkedDirectories: catalog.checkedDirectories,
      loadedSources: catalog.sources.length,
      injectedInstructionBytes: catalog.sources.reduce((size, source) => size + source.bytes, 0),
      promptCharacters: prompt.manifest.characters,
      estimatedPromptTokens: prompt.manifest.estimatedTokens,
    };
  }
  cold.sort((a, b) => a - b);
  cached.sort((a, b) => a - b);
  process.stdout.write(
    `${JSON.stringify({ platform: process.platform, node: process.version, fixtureFiles: 1102, instructionFiles: 102, samples: 5, timingScope: 'target ancestry discovery + prompt composition; excludes fixture creation, model and network; OS caches may be warm', freshCatalogMedianMs: Number(cold[2]!.toFixed(2)), cachedCatalogMedianMs: Number(cached[2]!.toFixed(2)), ...metrics }, null, 2)}\n`,
  );
} finally {
  assert(resolve(temporary).startsWith(resolve(join(tmpdir(), 'mewcode-prompt-bench-'))));
  await rm(temporary, { recursive: true, force: true });
}
