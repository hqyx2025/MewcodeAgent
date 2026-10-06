import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { WorktreeManager } from '../src/tools/worktrees.js';
import { createGitSandbox } from '../tests/support/git-repo.js';
import { removeSandbox } from '../tests/support/sandbox.js';

const box = await createGitSandbox();
try {
  const manager = await WorktreeManager.open(box.cwd, box.userDirectory);
  const samples: { createMs: number; reuseMs: number; removeMs: number }[] = [];
  for (let index = 0; index < 5; index++) {
    let start = performance.now();
    const owner = await manager.create({ task: `sample-${index}` });
    const createMs = performance.now() - start;
    start = performance.now();
    const reused = await manager.reuse(owner.id, 'HEAD');
    const reuseMs = performance.now() - start;
    assert.equal(reused.path, owner.path);
    start = performance.now();
    await manager.remove(owner.id);
    const removeMs = performance.now() - start;
    samples.push({ createMs, reuseMs, removeMs });
  }
  const median = (key: keyof (typeof samples)[number]) =>
    Number(
      samples
        .map((sample) => sample[key])
        .sort((a, b) => a - b)[2]!
        .toFixed(3),
    );
  process.stdout.write(
    JSON.stringify(
      {
        platform: process.platform,
        node: process.version,
        git: (await box.git(['--version'])).stdout.trim(),
        samples: 5,
        conditions:
          'Sequential fresh branches on a two-file Git fixture in an owned Unicode/space temporary path; normal OS filesystem caches, no forced cache eviction. Includes Git subprocesses, ownership checks and fsync metadata. Manager initialization excluded. No network, provider or dependency installation; worktrees contain Git-tracked content only.',
        maxActive: manager.maxActive,
        dependencyPreparationMs: null,
        dependencyPolicy:
          'No dependency reuse, copy or installation; approval-required Bash can prepare dependencies explicitly in its bound cwd. Installed or ignored files prevent automatic cleanup.',
        medianMs: {
          create: median('createMs'),
          reuse: median('reuseMs'),
          remove: median('removeMs'),
        },
        rawMs: samples,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await removeSandbox(box.root);
}
