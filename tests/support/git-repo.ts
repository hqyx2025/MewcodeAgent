import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSandbox } from './sandbox.js';
const exec = promisify(execFile);
export async function createGitSandbox() {
  const box = await createSandbox();
  const git = (args: string[], cwd = box.cwd) =>
    exec(
      'git',
      [
        '-c',
        'core.autocrlf=false',
        '-c',
        'commit.gpgSign=false',
        '-c',
        'core.fsmonitor=false',
        ...args,
      ],
      {
        cwd,
        timeout: 10_000,
        windowsHide: true,
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        },
      },
    );
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(box.cwd, 'same.txt'), 'base\n');
  await writeFile(join(box.cwd, '.gitignore'), 'ignored/\n.mewcode/\n');
  await git(['add', 'same.txt', '.gitignore']);
  await git(['commit', '-m', 'base']);
  const base = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  return { ...box, git, base };
}
