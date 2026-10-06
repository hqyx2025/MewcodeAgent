import { mkdir, writeFile, link, symlink, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { SkillCatalog } from '../../src/core/skills.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
import { writeSkill } from '../support/skills.js';

describe('skill discovery and selected resources', () => {
  it('indexes only prefixes, applies project priority, loads a whole body on demand and refreshes metadata', async () => {
    const box = await createSandbox();
    try {
      await writeSkill(box.userDirectory, 'review', 'Review user fixes', 'user body');
      const root = await writeSkill(
        box.projectDirectory,
        'review',
        'Review project fixes',
        'project body',
      );
      const lazy = await writeSkill(
        box.projectDirectory,
        'unused',
        'Unrelated topic',
        'x'.repeat(5000),
      );
      await writeFile(
        join(lazy, 'SKILL.md'),
        Buffer.concat([
          Buffer.from('---\nname: unused\ndescription: Unrelated topic\n---\n' + 'x'.repeat(5000)),
          Buffer.from([0xff]),
        ]),
      );
      const catalog = new SkillCatalog({ ...box, allows: () => true });
      expect((await catalog.list()).entries).toHaveLength(2);
      const selected = await catalog.select('Review project fixes');
      expect(selected.entries.map((entry) => entry.name)).toEqual(['review']);
      expect(selected.entries[0]?.text).toBe('project body');
      expect(selected.entries[0]?.source).toBe('project');
      expect(selected.bytes).toBeLessThan(32768);
      await expect(catalog.select('', ['unused'])).rejects.toMatchObject({ code: 'SKILL_INVALID' });
      await writeFile(
        join(root, 'SKILL.md'),
        '---\nname: review\ndescription: Review project fixes\n---\nupdated body',
      );
      expect((await catalog.select('', ['review'])).entries[0]?.text).toBe('updated body');
      await writeSkill(box.projectDirectory, 'new', 'Brand new feature');
      expect((await catalog.list()).entries.some((entry) => entry.name === 'new')).toBe(false);
      await catalog.list(true);
      expect((await catalog.select('', ['new'])).entries[0]?.reason).toBe('explicit');
      await writeSkill(box.projectDirectory, 'review', 'Changed metadata');
      await expect(catalog.select('', ['review'])).rejects.toMatchObject({ code: 'SKILL_INVALID' });
      await catalog.list(true);
      expect((await catalog.select('', ['review'])).entries[0]?.description).toBe(
        'Changed metadata',
      );
    } finally {
      await removeSandbox(box.root);
    }
  });

  it('reports invalid metadata without leaking text or falling back to a shadowed user skill', async () => {
    const box = await createSandbox();
    try {
      await writeSkill(box.userDirectory, 'review', 'Review user fixes');
      const root = await writeSkill(box.projectDirectory, 'review', 'Review fixes');
      const catalog = () =>
        new SkillCatalog({ ...box, allows: () => true, secrets: ['private-fixture-key'] });
      for (const text of [
        '---\nname: different\ndescription: private-source-marker\n---\nbody',
        '---\nname: review\ndescription: [invalid]\n---\nbody',
        '---\nname: review\ndescription: valid\nallowed-tools: Bash\n---\nbody',
        '---\nname: review\ndescription: private-fixture-key\n---\nbody',
        '---\nname: review\ndescription: ' + 'x'.repeat(5000),
        'x'.repeat(65537),
      ]) {
        await writeFile(join(root, 'SKILL.md'), text);
        const result = await catalog().list();
        expect(result.entries).toEqual([]);
        expect(result.warnings).toContainEqual({
          name: 'review',
          source: 'project',
          code: 'INVALID',
        });
        expect(JSON.stringify(result)).not.toContain('private-source-marker');
        expect(JSON.stringify(result)).not.toContain('private-fixture-key');
      }
      await writeSkill(box.projectDirectory, 'review', 'Review fixes', 'private-fixture-key');
      await expect(catalog().select('', ['review'])).rejects.toMatchObject({
        code: 'SKILL_INVALID',
        message: expect.not.stringContaining('private-fixture-key'),
      });
      expect((await catalog().select('Review fixes')).entries).toEqual([]);
      await writeSkill(box.projectDirectory, 'review', 'Review fixes', 'x'.repeat(40000));
      await expect(catalog().select('', ['review'])).rejects.toMatchObject({ code: 'SKILL_LIMIT' });
      expect((await catalog().select('Review fixes')).warnings).toContainEqual({
        name: 'review',
        source: 'project',
        code: 'LIMIT',
      });
    } finally {
      await removeSandbox(box.root);
    }
  });

  it('rechecks read permission, rejects cancellation, handles empty/nonmatching selection and limits directory scans', async () => {
    const box = await createSandbox();
    try {
      await writeSkill(box.projectDirectory, 'review', 'Review project fixes');
      let allow = true;
      const catalog = new SkillCatalog({ ...box, allows: () => allow });
      await catalog.list();
      allow = false;
      await expect(catalog.select('', ['review'])).rejects.toMatchObject({ code: 'SKILL_INVALID' });
      expect((await catalog.list(true)).entries).toEqual([]);
      allow = true;
      await catalog.list(true);
      expect((await catalog.select('unrelated words')).entries).toEqual([]);
      expect((await catalog.select('')).bytes).toBe(0);
      await expect(catalog.select('', ['../review'])).rejects.toMatchObject({
        code: 'SKILL_INVALID',
      });
      await expect(
        catalog.select('', ['review', 'review', 'review', 'review', 'review']),
      ).rejects.toMatchObject({ code: 'SKILL_INVALID' });
      const controller = new AbortController();
      controller.abort();
      await expect(catalog.select('Review', [], controller.signal)).rejects.toMatchObject({
        code: 'CANCELLED',
      });
      const root = join(box.projectDirectory, 'skills');
      await Promise.all(
        Array.from({ length: 128 }, (_, i) => writeFile(join(root, `ignored-${i}.txt`), '')),
      );
      await expect(catalog.list(true)).rejects.toMatchObject({ code: 'SKILL_LIMIT' });
    } finally {
      await removeSandbox(box.root);
    }
  });

  it('reads only selected resources, denies traversal/links/credentials, and applies budgets without executing scripts', async () => {
    const box = await createSandbox();
    try {
      const root = await writeSkill(box.projectDirectory, 'review', 'Review fixes');
      await mkdir(join(root, 'references'));
      await writeFile(join(root, 'references', '中文.txt'), '中文 evidence');
      await writeFile(join(root, 'secret.txt'), 'private-fixture-key');
      await writeFile(join(root, 'large.txt'), 'x'.repeat(16385));
      await writeFile(join(root, 'budget.txt'), 'x'.repeat(16384));
      await writeFile(join(root, 'hard.txt'), 'hard link');
      await link(join(root, 'hard.txt'), join(root, 'alias.txt'));
      await symlink(
        box.cwd,
        join(root, 'outside'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const script = process.platform === 'win32' ? 'script.ps1' : 'script.sh';
      const marker = join(box.cwd, 'ran.txt');
      await writeFile(
        join(root, script),
        process.platform === 'win32'
          ? "Set-Content -LiteralPath './ran.txt' -Value 'ran'"
          : "printf ran > './ran.txt'",
      );
      const registry = createBuiltinRegistry();
      const catalog = new SkillCatalog({
        ...box,
        allows: () => true,
        secrets: ['private-fixture-key'],
      });
      catalog.register(registry);
      const approvals = vi.fn(async () => false);
      const executor = await ToolExecutor.create(registry, {
        root: box.cwd,
        mode: 'plan',
        approve: approvals,
      });
      const read = (resource: string, name = 'review') =>
        executor.execute({ callId: randomUUID(), name: 'SkillRead', input: { name, resource } });
      expect((await read('references/中文.txt')).ok).toBe(false);
      await catalog.select('', ['review']);
      expect(await read('references/中文.txt')).toMatchObject({
        ok: true,
        content: '中文 evidence',
      });
      expect((await read(script)).ok).toBe(true);
      await expect(stat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      for (const resource of [
        '../ran.txt',
        '/tmp/x',
        'C:/file',
        'references\\中文.txt',
        'outside/AGENTS.md',
        'alias.txt',
        'secret.txt',
        'large.txt',
        'missing.txt',
        '.env',
        'SKILL.md',
        'nul.txt',
      ])
        expect((await read(resource)).ok).toBe(false);
      expect(approvals).not.toHaveBeenCalled();
      // Selection changes revoke previously loaded resource names, including after a failed selection.
      await expect(catalog.select('', ['missing'])).rejects.toThrow();
      expect((await read(script)).ok).toBe(false);
      const budgetRegistry = createBuiltinRegistry();
      const budgetCatalog = new SkillCatalog({ ...box, allows: () => true });
      budgetCatalog.register(budgetRegistry);
      await budgetCatalog.select('', ['review']);
      const budgetExecutor = await ToolExecutor.create(budgetRegistry, {
        root: box.cwd,
        mode: 'plan',
      });
      const readBudget = () =>
        budgetExecutor.execute({
          callId: randomUUID(),
          name: 'SkillRead',
          input: { name: 'review', resource: 'budget.txt' },
        });
      for (let i = 0; i < 4; i++) expect((await readBudget()).ok).toBe(true);
      expect(await readBudget()).toMatchObject({ ok: false, error: { code: 'SKILL_LIMIT' } });
      const command =
        process.platform === 'win32' ? `& '${join(root, script)}'` : `sh '${join(root, script)}'`;
      expect(
        (await executor.execute({ callId: randomUUID(), name: 'Bash', input: { command } })).ok,
      ).toBe(false);
      const denied = await ToolExecutor.create(registry, { root: box.cwd, approve: approvals });
      expect(
        (await denied.execute({ callId: randomUUID(), name: 'Bash', input: { command } })).ok,
      ).toBe(false);
      const approved = await ToolExecutor.create(registry, {
        root: box.cwd,
        approve: async () => true,
      });
      expect(
        (await approved.execute({ callId: randomUUID(), name: 'Bash', input: { command } })).ok,
      ).toBe(true);
      expect((await stat(marker)).isFile()).toBe(true);
    } finally {
      await removeSandbox(box.root);
    }
  });

  it('honors SkillRead ask/deny and refuses unsafe root directories or hard-linked SKILL.md', async () => {
    const box = await createSandbox();
    try {
      const root = await writeSkill(box.projectDirectory, 'review', 'Review fixes');
      await writeFile(join(root, 'resource.txt'), 'fixture');
      const registry = createBuiltinRegistry();
      const catalog = new SkillCatalog({ ...box, allows: () => true });
      catalog.register(registry);
      await catalog.select('', ['review']);
      const approve = vi.fn(async () => false);
      const executor = await ToolExecutor.create(registry, {
        root: box.cwd,
        approve,
        rules: [{ source: 'user', tool: 'SkillRead', decision: 'ask' }],
      });
      expect(
        (
          await executor.execute({
            callId: randomUUID(),
            name: 'SkillRead',
            input: { name: 'review', resource: 'resource.txt' },
          })
        ).ok,
      ).toBe(false);
      expect(approve).toHaveBeenCalledOnce();
      const denied = await ToolExecutor.create(registry, {
        root: box.cwd,
        approve,
        rules: [{ source: 'user', tool: 'SkillRead', decision: 'deny' }],
      });
      expect(
        (
          await denied.execute({
            callId: randomUUID(),
            name: 'SkillRead',
            input: { name: 'review', resource: 'resource.txt' },
          })
        ).ok,
      ).toBe(false);
      expect(approve).toHaveBeenCalledOnce();
      await link(join(root, 'SKILL.md'), join(box.cwd, 'alias.md'));
      expect((await catalog.list(true)).entries).toEqual([]);
      await symlink(
        box.cwd,
        join(box.userDirectory, 'skills'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(catalog.list(true)).rejects.toMatchObject({ code: 'SKILL_INVALID' });
    } finally {
      await removeSandbox(box.root);
    }
  });
});
