import { readFile, writeFile, mkdir, symlink, unlink, lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, it, expect } from 'vitest';
import { WorktreeManager } from '../../src/tools/worktrees.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { createGitSandbox } from '../support/git-repo.js';
import { removeSandbox } from '../support/sandbox.js';

describe('owned Git worktrees', () => {
  let box: Awaited<ReturnType<typeof createGitSandbox>>;
  let manager: WorktreeManager;
  beforeEach(async () => {
    box = await createGitSandbox();
    manager = await WorktreeManager.open(box.cwd, box.userDirectory);
  });
  afterEach(async () => {
    await removeSandbox(box.root);
  });
  it('creates independent branches at an exact commit while preserving dirty primary files', async () => {
    await writeFile(join(box.cwd, 'same.txt'), 'primary uncommitted');
    const [a, b] = await Promise.all([
      manager.create({ task: 'one' }),
      manager.create({ task: 'two' }),
    ]);
    expect(a.base).toBe(box.base);
    expect(b.base).toBe(box.base);
    expect(a.branch).not.toBe(b.branch);
    await writeFile(join(a.path, 'same.txt'), 'one');
    await writeFile(join(b.path, 'same.txt'), 'two');
    expect(await readFile(join(box.cwd, 'same.txt'), 'utf8')).toBe('primary uncommitted');
    expect(await readFile(join(a.path, 'same.txt'), 'utf8')).toBe('one');
    expect(await readFile(join(b.path, 'same.txt'), 'utf8')).toBe('two');
    const diff = await manager.diff(a.id);
    expect(diff.content).toContain('+one');
    expect(diff.report.changes).toEqual(['same.txt']);
    expect((await box.git(['branch', '--show-current'])).stdout.trim()).toBe('main');
  });
  it('refuses invalid refs, colliding branches, non-repos, nested entrypoints and unsafe storage', async () => {
    await expect(manager.create({ task: 'one', base: '--evil' })).rejects.toThrow();
    await expect(manager.create({ task: 'one', base: 'missing-ref' })).rejects.toMatchObject({
      code: 'WORKTREE_GIT',
    });
    const a = await manager.create({ task: 'one', branch: 'codex/fixture' });
    await expect(manager.create({ task: 'two', branch: 'codex/fixture' })).rejects.toMatchObject({
      code: 'WORKTREE_BRANCH',
    });
    await expect(WorktreeManager.open(box.home, join(box.root, 'outside'))).rejects.toMatchObject({
      code: 'WORKTREE_GIT',
    });
    await expect(WorktreeManager.open(a.path, box.userDirectory)).rejects.toMatchObject({
      code: 'WORKTREE_GIT',
    });
    await expect(WorktreeManager.open(box.cwd, join(box.cwd, 'storage'))).rejects.toMatchObject({
      code: 'WORKTREE_OWNER',
    });
  });
  it('caps active worktrees and reuses only verified clean original bases', async () => {
    const limited = await WorktreeManager.open(box.cwd, box.userDirectory, { maxActive: 1 });
    const a = await limited.create({ task: 'one' });
    await expect(limited.create({ task: 'two' })).rejects.toMatchObject({ code: 'WORKTREE_LIMIT' });
    expect((await limited.reuse(a.id, 'HEAD')).path).toBe(a.path);
    await writeFile(join(a.path, 'same.txt'), 'changed');
    await expect(limited.reuse(a.id, 'HEAD')).rejects.toMatchObject({ code: 'WORKTREE_BASE' });
    await box.git(['checkout', '--', 'same.txt'], a.path);
    await box.git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'child commit',
      ],
      a.path,
    );
    await expect(limited.reuse(a.id, 'HEAD')).rejects.toMatchObject({ code: 'WORKTREE_BASE' });
    await limited.remove(a.id);
    expect((await limited.list())[0]!.status).toBe('removed');
    expect((await box.git(['show-ref', '--verify', `refs/heads/${a.branch}`])).stdout).toContain(
      a.branch,
    );
    await expect(lstat(a.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await limited.create({ task: 'two' })).status).toBe('ready');
  });
  it.each(['tracked', 'untracked', 'ignored'])(
    'preserves %s files during cleanup',
    async (kind) => {
      const a = await manager.create({ task: 'one' });
      if (kind === 'ignored') {
        await mkdir(join(a.path, 'ignored'));
        await writeFile(join(a.path, 'ignored', 'dependency.txt'), 'preserve');
      } else
        await writeFile(join(a.path, kind === 'tracked' ? 'same.txt' : 'extra.txt'), 'preserve');
      await expect(manager.remove(a.id)).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
      expect((await lstat(a.path)).isDirectory()).toBe(true);
      expect((await manager.report(a.id)).dirty).toBe(true);
    },
  );
  it('detects unmerged index conflicts and never merges them into primary', async () => {
    const a = await manager.create({ task: 'one' });
    await box.git(['checkout', '-b', 'other-fixture'], a.path);
    await writeFile(join(a.path, 'same.txt'), 'other\n');
    await box.git(['add', 'same.txt'], a.path);
    await box.git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'other',
      ],
      a.path,
    );
    await box.git(['checkout', a.branch], a.path);
    await writeFile(join(a.path, 'same.txt'), 'own\n');
    await box.git(['add', 'same.txt'], a.path);
    await box.git(
      [
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'own',
      ],
      a.path,
    );
    await box
      .git(
        [
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'merge',
          'other-fixture',
        ],
        a.path,
      )
      .catch(() => {});
    const report = await manager.report(a.id);
    expect(report.conflicts).toEqual(['same.txt']);
    await expect(manager.remove(a.id)).rejects.toMatchObject({ code: 'WORKTREE_DIRTY' });
    expect(await readFile(join(box.cwd, 'same.txt'), 'utf8')).toBe('base\n');
  });
  it('rejects rewritten ownership/path/git pointer records before executing tools or cleanup', async () => {
    const a = await manager.create({ task: 'one' });
    const file = join(manager.directory, `${a.id}.json`);
    await writeFile(file, JSON.stringify({ ...a, path: box.cwd }));
    await expect(manager.remove(a.id)).rejects.toMatchObject({ code: 'WORKTREE_OWNER' });
    await writeFile(file, JSON.stringify(a));
    const pointer = await readFile(join(a.path, '.git'), 'utf8');
    const rewrite = async (text: string) => {
      const file = await open(join(a.path, '.git'), 'r+');
      try {
        await file.truncate(0);
        await file.writeFile(text);
      } finally {
        await file.close();
      }
    };
    await rewrite('gitdir: ' + join(box.cwd, '.git') + '\n');
    await expect(manager.report(a.id)).rejects.toMatchObject({ code: 'WORKTREE_OWNER' });
    await rewrite(pointer);
    expect((await manager.report(a.id)).dirty).toBe(false);
    expect(await readFile(join(box.cwd, 'same.txt'), 'utf8')).toBe('base\n');
  });
  it('does not checkout hooks, configured clean/smudge filters, or execute source diagnostics', async () => {
    await writeFile(join(box.cwd, '.gitattributes'), 'same.txt filter=fixture\n');
    await box.git(['add', '.gitattributes']);
    await box.git(['commit', '-m', 'attributes']);
    const marker = join(box.root, 'filter-ran');
    await box.git([
      'config',
      'filter.fixture.smudge',
      `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '/')}','ran')"`,
    ]);
    await box.git([
      'config',
      'filter.fixture.clean',
      `node -e "require('fs').writeFileSync('${marker.replaceAll('\\', '/')}','ran')"`,
    ]);
    await box.git(['config', 'filter.fixture.required', 'true']);
    manager = await WorktreeManager.open(box.cwd, box.userDirectory);
    const a = await manager.create({ task: 'one' });
    await manager.report(a.id);
    await manager.diff(a.id);
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(a.path, 'same.txt'), 'utf8')).toBe('base\n');
  });
  it('refuses cleanup of submodule entries and keeps committed delivery branches', async () => {
    await box.git(['update-index', '--add', '--cacheinfo', `160000,${box.base},submodule`]);
    await box.git(['commit', '-m', 'gitlink']);
    const a = await manager.create({ task: 'one' });
    await expect(manager.remove(a.id)).rejects.toMatchObject({ code: 'WORKTREE_SUBMODULE' });
    expect((await lstat(a.path)).isDirectory()).toBe(true);
  });
  it('recovers only dead same-host running records and rejects live locks', async () => {
    const a = await manager.create({ task: 'one' });
    await manager.acquire(a.id, 'worker', new AbortController().signal);
    await expect(manager.remove(a.id)).rejects.toMatchObject({ code: 'WORKTREE_BUSY' });
    await expect(manager.recover(a.id)).rejects.toMatchObject({ code: 'WORKTREE_BUSY' });
    const file = join(manager.directory, `${a.id}.json`);
    const owner = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...owner, pid: 2147483647, host: hostname() }));
    expect((await manager.recover(a.id)).status).toBe('failed');
    expect((await manager.reuse(a.id, 'HEAD')).status).toBe('ready');
    const lock = join(manager.directory, 'manager.lock');
    await writeFile(
      lock,
      JSON.stringify({
        app: 'mewcode-worktrees',
        repository: manager.repository,
        pid: process.pid,
        host: hostname(),
        id: randomUUID(),
      }),
    );
    await expect(manager.unlock()).rejects.toMatchObject({ code: 'WORKTREE_BUSY' });
    await expect(manager.create({ task: 'two' })).rejects.toMatchObject({
      code: 'WORKTREE_LOCKED',
    });
    await unlink(lock);
  });
  it('enforces Plan, shell approval, deny and reused executor policy through registered tools', async () => {
    const registry = createBuiltinRegistry();
    manager.register(registry);
    const plan = await ToolExecutor.create(registry, {
      root: box.cwd,
      mode: 'plan',
      approve: async () => true,
    });
    expect(
      await plan.execute({ callId: 'one', name: 'WorktreeCreate', input: { task: 'one' } }),
    ).toMatchObject({ ok: false, error: { code: 'TOOL_PERMISSION' } });
    const yes = await ToolExecutor.create(registry, { root: box.cwd, approve: async () => true });
    const created = await yes.execute({
      callId: 'two',
      name: 'WorktreeCreate',
      input: { task: 'two' },
    });
    expect(created.ok).toBe(true);
    const owner = JSON.parse(created.content);
    expect(
      await plan.execute({ callId: 'view', name: 'WorktreeInspect', input: { id: owner.id } }),
    ).toMatchObject({ ok: true });
    const deny = await ToolExecutor.create(registry, {
      root: box.cwd,
      rules: [{ source: 'user', decision: 'deny', tool: 'WorktreeRemove' }],
      approve: async () => true,
    });
    expect(
      await deny.execute({ callId: 'remove', name: 'WorktreeRemove', input: { id: owner.id } }),
    ).toMatchObject({ ok: false, error: { code: 'TOOL_PERMISSION' } });
  });
  it.skipIf(process.platform === 'win32')(
    'rejects symlinked managed paths and manifests without deleting their target',
    async () => {
      const a = await manager.create({ task: 'one' });
      const file = join(manager.directory, `${a.id}.json`);
      await unlink(file);
      await symlink(join(box.cwd, 'same.txt'), file);
      await expect(manager.report(a.id)).rejects.toMatchObject({ code: 'WORKTREE_OWNER' });
      expect(await readFile(join(box.cwd, 'same.txt'), 'utf8')).toBe('base\n');
    },
  );
  it('bounds large structured reports and redacts short known secrets in diffs', async () => {
    manager = await WorktreeManager.open(box.cwd, box.userDirectory, {
      resultBytes: 2048,
      sensitiveValues: ['short-secret'],
    });
    const a = await manager.create({ task: 'one' });
    await writeFile(join(a.path, 'same.txt'), 'short-secret\n' + 'large diff\n'.repeat(1200));
    expect((await manager.diff(a.id)).content).not.toContain('short-secret');
    for (let index = 0; index < 80; index++)
      await writeFile(join(a.path, `中文-${index}-extra.txt`), 'extra');
    const registry = createBuiltinRegistry();
    manager.register(registry);
    const executor = await ToolExecutor.create(registry, { root: box.cwd, mode: 'plan' });
    const result = await executor.execute({
      callId: 'bounded',
      name: 'WorktreeInspect',
      input: { id: a.id, diff: true },
    });
    expect(result).toMatchObject({ ok: true, truncated: true });
    expect(
      Buffer.byteLength(JSON.stringify({ ...result, callId: 'x'.repeat(128) })),
    ).toBeLessThanOrEqual(2048);
    const report = JSON.parse(result.content);
    expect(report.report.dirty).toBe(true);
    expect(report.omittedPaths).toBeGreaterThan(0);
    expect((await manager.report(a.id)).untracked).toHaveLength(80);
  });
  it('keeps failed creation metadata and rejects changed approvals or malformed ownership', async () => {
    await writeFile(join(manager.directory, 'empty-hooks', 'pre-checkout'), 'must-not-execute');
    await expect(manager.create({ task: 'failure' })).rejects.toMatchObject({
      code: 'WORKTREE_OWNER',
    });
    const failed = (await manager.list())[0]!;
    expect(failed.status).toBe('failed');
    expect((await manager.remove(failed.id)).status).toBe('removed');
    await unlink(join(manager.directory, 'empty-hooks', 'pre-checkout'));
    const a = await manager.create({ task: 'one' });
    const file = join(manager.directory, `${a.id}.json`);
    const registry = createBuiltinRegistry();
    manager.register(registry);
    const executor = await ToolExecutor.create(registry, {
      root: box.cwd,
      approve: async () => {
        await writeFile(file, JSON.stringify({ ...a, status: 'failed' }));
        return true;
      },
    });
    expect(
      await executor.execute({ callId: 'changed', name: 'WorktreeRemove', input: { id: a.id } }),
    ).toMatchObject({ ok: false, error: { code: 'WORKTREE_OWNER' } });
    expect((await lstat(a.path)).isDirectory()).toBe(true);
    await writeFile(file, '{"private-source-marker":');
    await expect(manager.report(a.id)).rejects.toMatchObject({
      code: 'WORKTREE_OWNER',
      message: expect.not.stringContaining('private-source-marker'),
    });
  });
});
