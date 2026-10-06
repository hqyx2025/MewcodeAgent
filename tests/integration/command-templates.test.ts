import { mkdir, writeFile, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MarkdownCommands } from '../../src/core/command-templates.js';
import { CommandRegistry } from '../../src/core/commands.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

describe('bounded Markdown commands', () => {
  it('uses project > user, protects builtins, reads bodies lazily and refreshes names explicitly', async () => {
    const box = await createSandbox();
    try {
      const user = join(box.userDirectory, 'commands');
      const project = join(box.projectDirectory, 'commands');
      await mkdir(user);
      await mkdir(project);
      await writeFile(join(user, 'review.md'), 'user $1');
      await writeFile(
        join(project, 'review.md'),
        '---\ndescription: 检查代码\nargument-hint: "<path> [options]"\n---\nproject $1 $ARGUMENTS',
      );
      await writeFile(join(project, 'help.md'), 'never override help');
      const templates = new MarkdownCommands({ ...box, allows: () => true });
      const commands = new CommandRegistry(
        {
          model: () => 'mock',
          setModel: () => {},
          mode: () => 'plan',
          setMode: () => {},
          permissions: () => 'plan',
        },
        templates,
      );
      expect(await commands.list()).toContainEqual({
        name: 'review',
        description: '检查代码',
        arguments: '<path> [options]',
        kind: 'task',
        source: 'project',
      });
      expect(await commands.execute('/help help')).toMatchObject({
        text: expect.stringContaining('[builtin; local]'),
      });
      expect(await commands.execute('/review "中文 文件.ts" $(whoami)')).toEqual({
        kind: 'task',
        prompt: 'project 中文 文件.ts "中文 文件.ts" $(whoami)',
      });
      await expect(commands.execute('/review')).rejects.toMatchObject({ code: 'COMMAND_INVALID' });
      // Invalid UTF-8 beyond the index prefix proves indexing does not decode the entire body.
      await writeFile(
        join(project, 'review.md'),
        Buffer.concat([Buffer.from('x'.repeat(5000)), Buffer.from([0xff])]),
      );
      await expect(templates.list(true)).resolves.toHaveLength(2);
      await expect(templates.expand('review', ['x'], 'x')).rejects.toMatchObject({
        code: 'COMMAND_IO',
      });
      await writeFile(join(project, 'review.md'), '$1 $2 $ARGUMENTS');
      expect(
        await templates.expand(
          'review',
          ['$2', '/permissions accept-edits'],
          '$2 /permissions accept-edits',
        ),
      ).toBe('$2 /permissions accept-edits $2 /permissions accept-edits');
      await writeFile(join(project, 'new.md'), 'new');
      expect((await commands.list()).some((entry) => entry.name === 'new')).toBe(false);
      await commands.execute('/help --refresh');
      expect(commands.complete('/ne')).toEqual(['/new']);
    } finally {
      await removeSandbox(box.root);
    }
  });

  it('applies deny before indexing and again when expanding cached entries', async () => {
    const box = await createSandbox();
    try {
      await mkdir(join(box.projectDirectory, 'commands'));
      await writeFile(join(box.projectDirectory, 'commands', 'review.md'), 'task $1');
      let allowed = true;
      const templates = new MarkdownCommands({ ...box, allows: () => allowed });
      expect(await templates.list()).toHaveLength(1);
      allowed = false;
      await expect(templates.expand('review', ['x'], 'x')).rejects.toMatchObject({
        code: 'COMMAND_IO',
      });
      expect(await templates.list(true)).toEqual([]);
    } finally {
      await removeSandbox(box.root);
    }
  });

  it('rejects secrets, unknown metadata, oversize files/headers, empty bodies and links with generic errors', async () => {
    const box = await createSandbox();
    try {
      const directory = join(box.projectDirectory, 'commands');
      await mkdir(directory);
      const path = join(directory, 'bad.md');
      const templates = () =>
        new MarkdownCommands({ ...box, allows: () => true, secrets: ['fixture-private-value'] });
      for (const text of [
        '---\nname: malicious\n---\ntask',
        '---\ndescription: [bad]\n---\ntask',
        '---\ndescription: ' + 'x'.repeat(5000),
        'x'.repeat(65537),
        'fixture-private-value',
      ]) {
        await writeFile(path, text);
        await expect(templates().list()).rejects.toMatchObject({
          code: 'COMMAND_IO',
          message: expect.not.stringContaining('fixture-private-value'),
        });
      }
      await writeFile(path, '');
      const empty = templates();
      await empty.list();
      await expect(empty.expand('bad', [], '')).rejects.toMatchObject({ code: 'COMMAND_IO' });
      await writeFile(path, '$ARGUMENTS '.repeat(5000));
      await expect(empty.expand('bad', ['x'], 'x'.repeat(65536))).rejects.toMatchObject({
        code: 'COMMAND_IO',
      });
      await writeFile(path, 'valid');
      const hard = join(directory, 'hard.md');
      await link(path, hard);
      await expect(templates().list()).rejects.toMatchObject({ code: 'COMMAND_IO' });
    } finally {
      await removeSandbox(box.root);
    }
  });

  it('rejects junction/symlink command directories and bounded directory overflow', async () => {
    const box = await createSandbox();
    try {
      const external = join(box.root, 'external');
      await mkdir(external);
      await symlink(
        external,
        join(box.projectDirectory, 'commands'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      await expect(
        new MarkdownCommands({ ...box, allows: () => true }).list(),
      ).rejects.toMatchObject({ code: 'COMMAND_IO' });
      const user = join(box.userDirectory, 'commands');
      await mkdir(user);
      await Promise.all(
        Array.from({ length: 129 }, (_, i) => writeFile(join(user, `ignored-${i}.txt`), '')),
      );
      await expect(
        new MarkdownCommands({ ...box, projectDirectory: external, allows: () => true }).list(),
      ).rejects.toMatchObject({ code: 'COMMAND_IO' });
    } finally {
      await removeSandbox(box.root);
    }
  });
});
