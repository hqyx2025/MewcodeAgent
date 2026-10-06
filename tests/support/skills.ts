import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function writeSkill(
  directory: string,
  name: string,
  description: string,
  body = 'fixture skill guidance',
): Promise<string> {
  const root = join(directory, 'skills', name);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${JSON.stringify(description)}\n---\n${body}`,
  );
  return root;
}
