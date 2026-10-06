import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export async function createSandbox() {
  const root = await mkdtemp(join(tmpdir(), 'mewcode-m01-'));
  const cwd = join(root, '中文 项目');
  const home = join(root, '用户 home');
  const userDirectory = join(home, '.mewcode');
  const projectDirectory = join(cwd, '.mewcode');
  await Promise.all([
    mkdir(projectDirectory, { recursive: true }),
    mkdir(userDirectory, { recursive: true }),
  ]);
  return { root, cwd, home, userDirectory, projectDirectory };
}

export async function removeSandbox(root: string): Promise<void> {
  if (!resolve(root).startsWith(resolve(join(tmpdir(), 'mewcode-m01-')))) {
    throw new Error('Refusing to remove a path outside the test sandbox');
  }
  // Windows may release cwd handles just after a terminated process exits.
  // Retry only this owned sandbox; persistent locks still fail the test.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
