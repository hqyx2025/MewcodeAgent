import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import metadata from '../package.json' with { type: 'json' };

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../', import.meta.url));
const npmCli = process.env.npm_execpath;
assert(npmCli, 'Run this script using npm run test:package');
await stat(join(repo, 'dist', 'index.js'));

const temporary = await mkdtemp(join(tmpdir(), 'mewcode-package-'));
const installation = join(temporary, '安装 空间');
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !name.startsWith('MEWCODE_')),
);
env.MEWCODE_HOME = join(temporary, '用户 配置');
await mkdir(installation);

try {
  const packed = await exec(
    process.execPath,
    [npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', temporary],
    { cwd: repo, env, timeout: 30_000 },
  );
  const [archive] = JSON.parse(packed.stdout) as {
    filename: string;
    size: number;
    unpackedSize: number;
    files: { path: string; size: number }[];
  }[];
  assert(archive);
  await exec(
    process.execPath,
    [
      npmCli,
      'install',
      '--prefix',
      installation,
      '--ignore-scripts',
      '--omit=dev',
      '--no-audit',
      '--no-fund',
      join(temporary, archive.filename),
    ],
    { cwd: temporary, env, timeout: 120_000 },
  );
  const entry = join(installation, 'node_modules', metadata.name, 'dist', 'index.js');
  const run = (args: string[]) =>
    exec(process.execPath, [entry, ...args], { cwd: installation, env, timeout: 10_000 });
  const version = (await run(['--version'])).stdout.trim();
  assert.equal(version, metadata.version);
  const helpHook = join(temporary, 'help-loader.mjs');
  await writeFile(
    helpHook,
    `import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (['js-yaml', 'zod', 'ink', 'react', 'openai', 'picomatch'].some((name) => specifier === name || specifier.startsWith(name + '/'))) {
      throw new Error('Heavy dependency loaded on help/version path');
    }
    return nextResolve(specifier, context);
  }
});\n`,
  );
  for (const flag of ['--help', '--version']) {
    await exec(process.execPath, ['--import', pathToFileURL(helpHook).href, entry, flag], {
      cwd: installation,
      env,
      timeout: 10_000,
    });
  }
  const config = JSON.parse((await run(['config', '--json'])).stdout) as {
    cwd: string;
    settings: { provider: { kind: string } };
  };
  assert.equal(
    config.cwd,
    await import('node:fs/promises').then(({ realpath }) => realpath(installation)),
  );
  assert.equal(config.settings.provider.kind, 'mock');
  const demoStarted = performance.now();
  const demo = await run(['demo', '独立安装验证 🐈']);
  const demoTotalMs = performance.now() - demoStarted;
  assert(demo.stdout.includes('独立安装验证 🐈'));
  assert((await run(['chat', '安装后的对话 🐈'])).stdout.includes('安装后的对话 🐈'));
  assert.equal((JSON.parse((await run(['tools'])).stdout) as unknown[]).length, 6);
  await writeFile(join(installation, '工具文件.txt'), '安装后的工具 🐈');
  const readTool = JSON.parse(
    (await run(['tool', 'ReadFile', '--input', JSON.stringify({ path: '工具文件.txt' })])).stdout,
  ) as { ok: boolean; content: string };
  assert(readTool.ok && readTool.content.includes('安装后的工具 🐈'));
  const writtenTool = JSON.parse(
    (
      await run([
        'tool',
        'WriteFile',
        '--approve',
        '--input',
        JSON.stringify({ path: '创建文件.txt', content: '原子创建' }),
      ])
    ).stdout,
  ) as { ok: boolean };
  assert(writtenTool.ok);

  const bin = join(
    installation,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'mewcode.cmd' : 'mewcode',
  );
  const binResult =
    process.platform === 'win32'
      ? await exec(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', '& $env:MEWCODE_SMOKE_BIN --version'],
          { cwd: installation, env: { ...env, MEWCODE_SMOKE_BIN: bin }, timeout: 15_000 },
        )
      : await exec(bin, ['--version'], { cwd: installation, env, timeout: 10_000 });
  assert.equal(binResult.stdout.trim(), metadata.version);

  const timings: number[] = [];
  for (let sample = 0; sample < 7; sample += 1) {
    const started = performance.now();
    assert((await run(['--help'])).stdout.includes('Usage: mewcode'));
    timings.push(performance.now() - started);
  }
  timings.sort((a, b) => a - b);
  process.stdout.write(
    `${JSON.stringify(
      {
        version,
        installation: 'passed (Unicode/space path, production dependencies only)',
        bin: 'passed',
        configuration: 'passed',
        demo: 'passed',
        tools: 'passed (schemas, read, approved write)',
        helpWithoutConfigDependencies: 'passed',
        helpMedianMs: Number(timings[3]?.toFixed(2)),
        helpMinMs: Number(timings[0]?.toFixed(2)),
        helpMaxMs: Number(timings[6]?.toFixed(2)),
        packageBytes: archive.size,
        unpackedBytes: archive.unpackedSize,
        demoTotalMs: Number(demoTotalMs.toFixed(2)),
        entryBytes: (await stat(entry)).size,
        compiledJsBytes: archive.files
          .filter((file) => file.path.startsWith('dist/') && file.path.endsWith('.js'))
          .reduce((size, file) => size + file.size, 0),
      },
      null,
      2,
    )}\n`,
  );
} finally {
  assert(resolve(temporary).startsWith(resolve(join(tmpdir(), 'mewcode-package-'))));
  await rm(temporary, { recursive: true, force: true });
}
