import { mkdir, mkdtemp, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
const ownedSandboxes = new Set<string>();

export async function createSandbox() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mewcode-m01-')));
  ownedSandboxes.add(root);
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
  if (!ownedSandboxes.has(root) || dirname(resolve(root)) !== (await realpath(tmpdir()))) {
    throw new Error('Refusing to remove a path outside the test sandbox');
  }
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(root)) !== root)
    throw new Error('Sandbox ownership changed');
  // Windows may release cwd handles just after a terminated process exits.
  // Retry only this owned sandbox; persistent locks still fail the test.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  ownedSandboxes.delete(root);
}
