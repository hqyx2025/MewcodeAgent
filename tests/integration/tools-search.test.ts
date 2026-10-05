import { randomUUID } from 'node:crypto';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

describe('bounded Glob/Grep', () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>>;
  let executor: ToolExecutor;
  beforeEach(async () => {
    sandbox = await createSandbox();
    executor = await ToolExecutor.create(createBuiltinRegistry(), { root: sandbox.cwd });
    await mkdir(join(sandbox.cwd, 'src'));
    await mkdir(join(sandbox.cwd, 'node_modules'));
    await writeFile(join(sandbox.cwd, 'src', '中文.ts'), 'one\nneedle 🐈\nneedle two');
    await writeFile(join(sandbox.cwd, 'src', 'other.ts'), 'other needle');
    await writeFile(join(sandbox.cwd, 'node_modules', 'hidden.ts'), 'needle dependency');
    await writeFile(join(sandbox.cwd, '.env.local'), 'needle credential');
    await writeFile(join(sandbox.cwd, '.hidden.ts'), 'needle hidden');
    await writeFile(join(sandbox.cwd, '.gitignore'), 'ignored.ts\n');
    await writeFile(join(sandbox.cwd, 'ignored.ts'), 'needle ignored');
    await mkdir(join(sandbox.projectDirectory, 'sessions'));
    await writeFile(join(sandbox.projectDirectory, 'sessions', 'private.ts'), 'needle session');
  });
  afterEach(async () => {
    await removeSandbox(sandbox.root);
  });
  const call = (name: string, input: unknown) =>
    executor.execute({ callId: randomUUID(), name, input });

  it('matches Unicode paths and excludes dependencies, hidden files and links', async () => {
    await symlink(
      sandbox.home,
      join(sandbox.cwd, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(join(sandbox.home, 'external.ts'), 'external');
    const result = await call('Glob', { pattern: '**/*.ts', ignore: ['ignored.ts'] });
    expect(result).toMatchObject({
      ok: true,
      truncated: false,
      data: { paths: ['src/other.ts', 'src/中文.ts'] },
    });
    const hidden = await call('Glob', {
      pattern: '**/*',
      includeHidden: true,
      ignore: ['ignored.ts'],
    });
    expect(hidden.content).toContain('.hidden.ts');
    expect(hidden.content).not.toContain('.env');
    expect(hidden.content).not.toContain('linked');
    expect(hidden.content).not.toContain('node_modules');
    expect(hidden.content).not.toContain('private.ts');
  });

  it('bounds result count and rejects out-of-root/expansion patterns', async () => {
    expect((await call('Glob', { pattern: '**/*.ts', maxResults: 1 })).truncated).toBe(true);
    expect((await call('Glob', { pattern: '**/*.none' })).content).toBe('无匹配文件。');
    for (const pattern of ['../**', '{a,b}', '/**', '!(x)', 'C:/**']) {
      expect((await call('Glob', { pattern })).error?.code).toBe('TOOL_INPUT');
    }
  });

  it('starts at a literal directory prefix and handles literals/missing roots/hidden directories', async () => {
    expect((await call('Glob', { pattern: 'src/**/*.ts' })).data).toMatchObject({
      paths: ['src/other.ts', 'src/中文.ts'],
    });
    expect((await call('Glob', { pattern: 'src/中文.ts' })).data).toMatchObject({
      paths: ['src/中文.ts'],
    });
    expect((await call('Glob', { pattern: 'missing/**/*.ts' })).content).toBe('无匹配文件。');
    await mkdir(join(sandbox.cwd, '.hidden-dir'));
    await writeFile(join(sandbox.cwd, '.hidden-dir', 'nested.ts'), 'hidden');
    expect((await call('Glob', { pattern: '.hidden-dir/**/*.ts' })).content).toBe('无匹配文件。');
    expect(
      (await call('Glob', { pattern: '.hidden-dir/**/*.ts', includeHidden: true })).data,
    ).toMatchObject({ paths: ['.hidden-dir/nested.ts'] });
  });

  it('returns matching lines, respects gitignore and never exposes excluded files', async () => {
    const result = await call('Grep', { pattern: 'needle', includeHidden: true, fileGlob: '**/*' });
    expect(result.ok).toBe(true);
    expect(result.content).toContain('src/中文.ts:2: needle 🐈');
    expect(result.content).toContain('.hidden.ts');
    expect(result.content).not.toContain('credential');
    expect(result.content).not.toContain('dependency');
    expect(result.content).not.toContain('ignored');
  });

  it('distinguishes literal/regex, empty matches, invalid regex, scope and unavailable rg', async () => {
    await writeFile(join(sandbox.cwd, 'literal.txt'), 'a+b\naaab');
    const literal = await call('Grep', { pattern: 'a+b', literal: true, path: 'literal.txt' });
    expect(literal.content).toContain(':1: a+b');
    expect(literal.content).not.toContain('aaab');
    expect((await call('Grep', { pattern: 'a+b', path: 'literal.txt' })).content).toContain(
      ':2: aaab',
    );
    expect((await call('Grep', { pattern: 'unmatched-unique' })).content).toBe('无匹配。');
    expect((await call('Grep', { pattern: '[' })).error?.code).toBe('GREP_FAILED');
    expect((await call('Grep', { pattern: 'needle', path: '../' })).error?.code).toBe(
      'PATH_DENIED',
    );
    const missing = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      rgExecutable: join(sandbox.cwd, 'missing-rg'),
    });
    expect(
      (await missing.execute({ callId: randomUUID(), name: 'Grep', input: { pattern: 'needle' } }))
        .error?.code,
    ).toBe('TOOL_UNAVAILABLE');
  });

  it('marks truncation and preserves a scoped glob/line result', async () => {
    const result = await call('Grep', { pattern: 'needle', fileGlob: '**/中文.ts', maxResults: 1 });
    expect(result).toMatchObject({
      ok: true,
      truncated: true,
      data: { matches: [{ path: 'src/中文.ts', line: 2, text: 'needle 🐈' }] },
    });
    expect((await call('Grep', { pattern: 'needle', fileGlob: 'src/**/*.ts' })).content).toContain(
      'src/中文.ts',
    );
  });

  it('honors cancellation before search starts', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      (
        await executor.execute(
          { callId: randomUUID(), name: 'Glob', input: { pattern: '**/*' } },
          controller.signal,
        )
      ).error?.code,
    ).toBe('CANCELLED');
  });
});
