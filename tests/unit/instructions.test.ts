import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectInstructions } from '../../src/core/instructions.js';
import { buildSystemPrompt } from '../../src/core/prompt.js';
import { ProjectPaths } from '../../src/security/paths.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

describe('project instruction discovery and prompt composition', () => {
  let box: Awaited<ReturnType<typeof createSandbox>>;
  let paths: ProjectPaths;
  const signal = () => new AbortController().signal;
  beforeEach(async () => {
    box = await createSandbox();
    paths = await ProjectPaths.create(box.cwd);
  });
  afterEach(async () => {
    await removeSandbox(box.root);
  });

  it('chooses AGENTS over CLAUDE, including an explicitly empty AGENTS', async () => {
    await writeFile(join(box.cwd, 'AGENTS.md'), '');
    await writeFile(join(box.cwd, 'CLAUDE.md'), 'must-not-load');
    const instructions = new ProjectInstructions(paths);
    expect(await instructions.discover('.', 'directory', signal())).toBe(true);
    expect(instructions.sources).toMatchObject([{ path: 'AGENTS.md', text: '', scope: '.' }]);
    expect(JSON.stringify(instructions.sources)).not.toContain('must-not-load');
    expect(instructions.takeWarnings()).toEqual([]);
  });

  it('uses CLAUDE as a missing-AGENTS fallback and only visits the target ancestry', async () => {
    await mkdir(join(box.cwd, 'src', 'nested'), { recursive: true });
    await mkdir(join(box.cwd, 'unrelated'));
    await writeFile(join(box.cwd, 'CLAUDE.md'), 'root-preference');
    await writeFile(join(box.cwd, 'src', 'AGENTS.md'), 'src-preference');
    await writeFile(join(box.cwd, 'src', 'nested', 'CLAUDE.md'), 'nested-preference');
    await writeFile(join(box.cwd, 'unrelated', 'AGENTS.md'), 'unrelated-secret-preference');
    const instructions = new ProjectInstructions(paths);
    expect(await instructions.discover('src/nested/new.ts', 'file', signal())).toBe(true);
    expect(instructions.metadata.map((source) => [source.path, source.scope])).toEqual([
      ['CLAUDE.md', '.'],
      ['src/AGENTS.md', 'src'],
      ['src/nested/CLAUDE.md', 'src/nested'],
    ]);
    expect(instructions.checkedDirectories).toBe(3);
    expect(JSON.stringify(instructions.sources)).not.toContain('unrelated-secret-preference');
  });

  it('keeps one-run snapshots and re-reads changed instructions in a new catalog', async () => {
    await writeFile(join(box.cwd, 'AGENTS.md'), 'first');
    const instructions = new ProjectInstructions(paths);
    await instructions.discover('.', 'directory', signal());
    const before = instructions.metadata;
    await writeFile(join(box.cwd, 'AGENTS.md'), 'second');
    expect(await instructions.discover('.', 'directory', signal())).toBe(false);
    expect(instructions.metadata).toEqual(before);
    const again = new ProjectInstructions(paths);
    await again.discover('.', 'directory', signal());
    expect(again.sources[0]?.text).toBe('second');
    expect(again.metadata[0]?.digest).not.toBe(before[0]?.digest);
  });

  it('does not discover above the project root, through links, or outside the target path', async () => {
    await mkdir(join(box.root, 'outside'));
    await writeFile(join(box.root, 'AGENTS.md'), 'ancestor-must-not-load');
    await writeFile(join(box.root, 'outside', 'AGENTS.md'), 'outside-must-not-load');
    await symlink(
      join(box.root, 'outside'),
      join(box.cwd, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const instructions = new ProjectInstructions(paths);
    expect(await instructions.discover('../outside', 'directory', signal())).toBe(false);
    expect(await instructions.discover('linked', 'directory', signal())).toBe(false);
    await instructions.discover('.', 'directory', signal());
    expect(instructions.sources).toEqual([]);
    expect(instructions.checkedDirectories).toBe(1);
  });

  it.each(['invalid-utf8', 'binary', 'directory', 'link'])(
    'warns safely for %s AGENTS without falling back',
    async (kind) => {
      await writeFile(join(box.cwd, 'CLAUDE.md'), 'fallback-must-not-load');
      const file = join(box.cwd, 'AGENTS.md');
      if (kind === 'directory') await mkdir(file);
      else if (kind === 'link')
        await symlink(box.userDirectory, file, process.platform === 'win32' ? 'junction' : 'dir');
      else
        await writeFile(
          file,
          kind === 'invalid-utf8'
            ? Buffer.from([0xff, 0xfe])
            : Buffer.from('sensitive-source\0not-text'),
        );
      const instructions = new ProjectInstructions(paths);
      expect(await instructions.discover('.', 'directory', signal())).toBe(false);
      expect(instructions.sources).toEqual([]);
      expect(instructions.takeWarnings()).toMatchObject([{ path: 'AGENTS.md' }]);
      const diagnostics = JSON.stringify(instructions.warningHistory);
      expect(diagnostics).not.toContain('sensitive-source');
      expect(diagnostics).not.toContain('fallback-must-not-load');
    },
  );

  it('truncates on a UTF-8 boundary and limits combined instructions to 32KiB', async () => {
    await mkdir(join(box.cwd, 'src', 'nested'), { recursive: true });
    await writeFile(join(box.cwd, 'AGENTS.md'), 'a'.repeat(16 * 1024 - 1) + '🐈');
    await writeFile(join(box.cwd, 'src', 'AGENTS.md'), 'b'.repeat(16 * 1024));
    await writeFile(join(box.cwd, 'src', 'nested', 'AGENTS.md'), '深入规则');
    const instructions = new ProjectInstructions(paths);
    await instructions.discover('src/nested/new.txt', 'file', signal());
    expect(instructions.sources[0]?.text).toBe('a'.repeat(16 * 1024 - 1));
    expect(instructions.sources.every((source) => !source.text.includes('\ufffd'))).toBe(true);
    expect(
      instructions.sources.reduce((bytes, source) => bytes + source.bytes, 0),
    ).toBeLessThanOrEqual(32 * 1024);
    expect(instructions.metadata[0]?.truncated).toBe(true);
    expect(instructions.metadata[2]?.truncated).toBe(true);
    expect(instructions.warningHistory.filter((w) => w.code === 'TRUNCATED')).toHaveLength(2);
  });

  it('redacts known values, API key forms and private keys before injection or metadata hashing', async () => {
    const known = 'fixture-vendor-token-12345';
    const fake = 'sk-' + 'exampleOnly'.repeat(3);
    const text = `Known ${known}\nOther ${fake}\n-----BEGIN PRIVATE KEY-----\nprivate-fixture\n-----END PRIVATE KEY-----\nUse npm test.`;
    await writeFile(join(box.cwd, 'AGENTS.md'), text);
    const instructions = new ProjectInstructions(paths, [known]);
    await instructions.discover('.', 'directory', signal());
    expect(instructions.sources[0]?.text).toContain('Use npm test.');
    expect(instructions.sources[0]?.redacted).toBe(true);
    expect(JSON.stringify(instructions.sources)).not.toContain(known);
    expect(JSON.stringify(instructions.sources)).not.toContain(fake);
    expect(JSON.stringify(instructions.sources)).not.toContain('private-fixture');
    expect(JSON.stringify(instructions.metadata)).not.toContain('Use npm test.');
    expect(await readFile(join(box.cwd, 'AGENTS.md'), 'utf8')).toBe(text);
  });

  it('bounds depth and directory count and supports cancellation', async () => {
    const deep = Array.from({ length: 33 }, () => 'd').join('/');
    await mkdir(join(box.cwd, deep), { recursive: true });
    await expect(
      new ProjectInstructions(paths).discover(deep, 'directory', signal()),
    ).rejects.toMatchObject({ code: 'INSTRUCTIONS_LIMIT' });
    const catalog = new ProjectInstructions(paths);
    for (let index = 0; index < 128; index++) await mkdir(join(box.cwd, `dir-${index}`));
    for (let index = 0; index < 127; index++)
      await catalog.discover(`dir-${index}`, 'directory', signal());
    await expect(catalog.discover('dir-127', 'directory', signal())).rejects.toMatchObject({
      code: 'INSTRUCTIONS_LIMIT',
    });
    await expect(
      new ProjectInstructions(paths).discover('.', 'directory', AbortSignal.abort()),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('builds a source-aware prompt with actual environment and immutable metadata without source text', async () => {
    await writeFile(join(box.cwd, 'AGENTS.md'), 'unique-project-guidance');
    const instructions = new ProjectInstructions(paths);
    await instructions.discover('.', 'directory', signal());
    const result = buildSystemPrompt(
      {
        cwd: box.cwd,
        model: 'gpt-5.5',
        mode: 'plan',
        shell: { kind: 'powershell', executable: 'fixture-pwsh' },
        tools: [{ name: 'ReadFile', effect: 'read' }],
        budgets: {
          maxTurns: 2,
          timeoutMs: 500,
          maxOutputTokens: 64,
          maxTotalTokens: 1000,
          maxContextCharacters: 10_000,
          maxFailures: 3,
        },
      },
      instructions.sources,
    );
    expect(result.text).toContain('unique-project-guidance');
    expect(result.manifest.environment).toMatchObject({
      model: 'gpt-5.5',
      os: process.platform,
      node: process.version,
      shell: { kind: 'powershell' },
      budgets: { maxTurns: 2 },
    });
    expect(result.manifest.sections.map((s) => s.id)).toEqual([
      'identity',
      'task',
      'tools',
      'permissions',
      'environment',
      'project',
    ]);
    expect(JSON.stringify(result.manifest)).not.toContain('unique-project-guidance');
    expect(result.manifest.sources).toHaveLength(1);
    const copy = instructions.sources;
    copy[0]!.text = 'mutated';
    expect(instructions.sources[0]?.text).toBe('unique-project-guidance');
  });
});
