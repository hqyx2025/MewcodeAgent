import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
import { writeSkill } from '../support/skills.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
describe('skills CLI', () => {
  it('lists private metadata, loads explicit/automatic sources and reads bounded resources without model calls', async () => {
    const box = await createSandbox();
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = box.userDirectory;
    delete env.OPENAI_API_KEY;
    const cli = (args: string[]) =>
      exec(
        process.execPath,
        ['--import', 'tsx', join(repo, 'src/cli/index.ts'), '--cwd', box.cwd, ...args],
        { cwd: repo, env, timeout: 10000 },
      );
    try {
      const root = await writeSkill(
        box.projectDirectory,
        'review',
        'Review fixes and regression tests',
        'private-skill-body-marker',
      );
      await writeFile(join(root, '中文.txt'), 'resource evidence 🐈');
      const remote = [
        '--provider',
        'openai-compatible',
        '--model',
        'fixture-model',
        '--base-url',
        'http://127.0.0.1:1/v1',
      ];
      const list = (await cli([...remote, 'skills'])).stdout;
      expect(JSON.parse(list).entries).toContainEqual({
        name: 'review',
        description: 'Review fixes and regression tests',
        source: 'project',
        path: 'project:skills/review/SKILL.md',
      });
      expect(list).not.toContain('private-skill-body-marker');
      expect((await cli([...remote, 'chat', '/skills refresh'])).stdout).toContain('review');
      const show = (await cli([...remote, 'skills', 'show', 'review'])).stdout;
      expect(show).not.toContain('private-skill-body-marker');
      expect((await cli([...remote, 'skills', 'show', 'review', '--content'])).stdout).toContain(
        'private-skill-body-marker',
      );
      const matched = JSON.parse(
        (await cli([...remote, 'skills', 'match', '--query', 'Review fixes'])).stdout,
      );
      expect(matched.sources[0].reason).toBe('description');
      expect(matched).not.toHaveProperty('entries');
      const prompt = (await cli([...remote, 'prompt', '--json', '--skill', 'review'])).stdout;
      expect(JSON.parse(prompt).skills.sources[0].reason).toBe('explicit');
      expect(prompt).not.toContain('private-skill-body-marker');
      expect(
        JSON.parse((await cli([...remote, 'prompt', '--json', '--task', 'unrelated query'])).stdout)
          .skills.sources,
      ).toEqual([]);
      expect(
        JSON.parse((await cli([...remote, 'skills', 'resource', 'review', '中文.txt'])).stdout),
      ).toMatchObject({ ok: true, content: 'resource evidence 🐈' });
      await expect(cli(['skills', 'resource', 'review', '../SKILL.md'])).rejects.toMatchObject({
        code: 1,
        stdout: expect.stringContaining('SKILL_INVALID'),
      });
      await expect(cli(['chat', '/skill missing 原文敏感标记'])).rejects.toMatchObject({
        code: 1,
        stderr: expect.not.stringContaining('原文敏感标记'),
      });
      const chat = await cli(['chat', '/skill review 检查中文文件']);
      expect(chat.stdout).toContain('检查中文文件');
      expect(chat.stderr).toContain('[explicit]');
      expect((await cli(['chat', 'Review fixes'])).stderr).toContain('[description]');
      const agent = (
        await cli(['--mode', 'plan', 'run', '/skill review 检查中文文件', '--json'])
      ).stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        agent.find((event) => event.type === 'prompt_info').manifest.skills.sources[0].reason,
      ).toBe('explicit');
      expect(agent.at(-1).reason).toBe('completed');
      expect(JSON.stringify(agent.filter((event) => event.type === 'prompt_info'))).not.toContain(
        'private-skill-body-marker',
      );
      await writeFile(
        join(box.projectDirectory, 'config.yaml'),
        'permissions:\n  rules:\n    - tool: ReadFile\n      path: .mewcode/skills/review\n      decision: deny\n',
      );
      const denied = JSON.parse((await cli(['skills'])).stdout);
      expect(denied.entries).toEqual([]);
      expect(denied.warnings).toContainEqual({
        source: 'project',
        name: 'review',
        code: 'PERMISSION',
      });
      await expect(cli(['prompt', '--json', '--skill', 'review'])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('SKILL_INVALID'),
      });
    } finally {
      await removeSandbox(box.root);
    }
  });
});
