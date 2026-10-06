import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
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
    if (['js-yaml', 'zod', 'ink', 'react', 'openai', '@anthropic-ai/sdk', '@modelcontextprotocol/sdk', 'ajv', 'picomatch'].some((name) => specifier === name || specifier.startsWith(name + '/'))) {
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
  assert((await run(['commands'])).stdout.includes('/resume'));
  assert(
    (
      await run(['--provider', 'openai-compatible', '--model', 'fixture-model', 'chat', '/help'])
    ).stdout.includes('/compact'),
  );
  await mkdir(join(installation, '.mewcode', 'commands'), { recursive: true });
  await writeFile(join(installation, '.mewcode', 'commands', 'review.md'), 'Review $1; $ARGUMENTS');
  assert((await run(['chat', '/review "中文 文件.ts"'])).stdout.includes('Review 中文 文件.ts'));
  const agentEvents = (await run(['--mode', 'plan', 'run', '查看目录', '--json'])).stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; reason?: string });
  assert(agentEvents.some((event) => event.type === 'tool_result'));
  assert.equal(agentEvents.at(-1)?.reason, 'completed');
  await writeFile(join(installation, 'AGENTS.md'), 'package-guidance-must-not-print');
  const promptMetadata = JSON.parse((await run(['--mode', 'plan', 'prompt', '--json'])).stdout) as {
    version: string;
    sources: { path: string }[];
  };
  assert.equal(promptMetadata.version, 'm05-v1');
  assert.equal(promptMetadata.sources[0]?.path, 'AGENTS.md');
  assert(!JSON.stringify(promptMetadata).includes('package-guidance-must-not-print'));
  const permissions = JSON.parse((await run(['--mode', 'plan', 'permissions'])).stdout) as {
    mode: string;
    rules: unknown[];
  };
  assert.equal(permissions.mode, 'plan');
  assert.deepEqual(permissions.rules, []);
  assert.equal((JSON.parse((await run(['tools'])).stdout) as unknown[]).length, 6);
  await writeFile(join(installation, '工具文件.txt'), '安装后的工具 🐈');
  const readTool = JSON.parse(
    (
      await run([
        'tool',
        'ReadFile',
        '--audit-file',
        '安装审计.jsonl',
        '--input',
        JSON.stringify({ path: '工具文件.txt' }),
      ])
    ).stdout,
  ) as { ok: boolean; content: string };
  assert(readTool.ok && readTool.content.includes('安装后的工具 🐈'));
  const auditContent = await readFile(join(installation, '安装审计.jsonl'), 'utf8');
  assert.equal((JSON.parse(auditContent.trim()) as { decision: string }).decision, 'allow');
  assert(!auditContent.includes('安装后的工具'));
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

  const mcpFixture = join(installation, 'mock-mcp.mjs');
  await writeFile(mcpFixture, await readFile(join(repo, 'tests', 'support', 'mcp-server.mjs')));
  const mcpConfig = join(installation, 'mcp-config.json');
  await writeFile(
    mcpConfig,
    JSON.stringify({
      mcp: {
        servers: {
          mock: {
            transport: 'stdio',
            command: process.execPath,
            args: [mcpFixture],
            cwd: '.',
            connectTimeoutMs: 15_000,
          },
        },
      },
    }),
  );
  assert.equal(
    JSON.parse((await run(['--config', mcpConfig, 'mcp', 'list'])).stdout).mock.transport,
    'stdio',
  );
  const mcpCatalog = JSON.parse(
    (await run(['--config', mcpConfig, 'mcp', 'discover', 'mock', '--approve-start'])).stdout,
  ) as unknown[];
  assert.equal(mcpCatalog.length, 2);
  const mcpCall = JSON.parse(
    (
      await run([
        '--config',
        mcpConfig,
        'mcp',
        'call',
        'mock',
        'echo',
        '--approve-start',
        '--approve',
        '--input',
        JSON.stringify({ text: 'installed MCP' }),
      ])
    ).stdout,
  ) as { ok: boolean; content: string };
  assert(mcpCall.ok && mcpCall.content === 'installed MCP');

  const savedEvents = (
    await run(['--mode', 'plan', 'run', 'installed persistent context', '--save-session', '--json'])
  ).stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; id?: string });
  const savedSession = savedEvents.find((event) => event.type === 'session')?.id;
  assert(savedSession);
  assert((await run(['sessions', 'list'])).stdout.includes(savedSession));
  const metadataOnly = (await run(['sessions', 'show', savedSession])).stdout;
  assert(!metadataOnly.includes('installed persistent context'));
  const resumedEvents = (
    await run(['--mode', 'accept-edits', 'run', '--resume', savedSession, '--json'])
  ).stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; mode?: string; reason?: string });
  assert.equal(resumedEvents.find((event) => event.type === 'session')?.mode, 'plan');
  assert(!resumedEvents.some((event) => event.type === 'tool_start'));
  assert.equal(resumedEvents.at(-1)?.reason, 'completed');
  await run(['sessions', 'delete', savedSession]);

  const memorySaved = JSON.parse(
    (
      await run([
        'memory',
        'add',
        '--scope',
        'user',
        '--text',
        'installed-memory-private-marker',
        '--approve',
      ])
    ).stdout,
  ) as { ok: boolean; data: { entry: { id: string } } };
  assert(memorySaved.ok);
  const memoryPrompt = (await run(['prompt', '--json'])).stdout;
  assert(!memoryPrompt.includes('installed-memory-private-marker'));
  assert.equal((JSON.parse(memoryPrompt) as { memory: { selected: number } }).memory.selected, 1);
  assert(
    (await run(['memory', 'show', memorySaved.data.entry.id, '--scope', 'user'])).stdout.includes(
      'installed-memory-private-marker',
    ),
  );
  const deniedMemory = (await run([
    '--mode',
    'plan',
    'memory',
    'delete',
    memorySaved.data.entry.id,
    '--scope',
    'user',
    '--approve',
  ]).catch((error: unknown) => error)) as { code: number; stdout: string };
  assert.equal(deniedMemory.code, 1);
  assert(deniedMemory.stdout.includes('TOOL_PERMISSION'));
  await run(['memory', 'delete', memorySaved.data.entry.id, '--scope', 'user', '--approve']);
  assert.equal(
    (JSON.parse((await run(['prompt', '--json'])).stdout) as { memory: { selected: number } })
      .memory.selected,
    0,
  );

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
        agent: 'passed (offline Plan tool loop, JSONL)',
        prompt: 'passed (instruction metadata without source text)',
        permissions: 'passed (mode inspection, persisted redacted decision)',
        mcp: 'passed (inert list, mock stdio discovery and approved call)',
        context: 'passed (save, metadata, resume without tool replay, retained Plan, owned delete)',
        memory:
          'passed (confirmed user preference, explicit show, private prompt metadata, Plan denial, delete and reload)',
        commands:
          'passed (builtin help without key, command listing, Chinese Markdown template expansion)',
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
