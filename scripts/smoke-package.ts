import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
  assert(archive.files.some((file) => file.path === 'THIRD_PARTY_NOTICES.md'));
  assert(!archive.files.some((file) => /(^|\/)(?:\.env(?:\..*)?|config\.ya?ml)$/.test(file.path)));
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
  assert(
    (
      await readFile(
        join(installation, 'node_modules', metadata.name, 'THIRD_PARTY_NOTICES.md'),
        'utf8',
      )
    ).includes('Third-party runtime dependency notices'),
  );
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
  const skillDirectory = join(installation, '.mewcode', 'skills', 'review');
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(
    join(skillDirectory, 'SKILL.md'),
    '---\nname: review\ndescription: Review fixes and regression\n---\ninstalled-private-skill-body',
  );
  await writeFile(join(skillDirectory, '中文.txt'), 'installed skill evidence 🐈');
  const skillList = (await run(['skills'])).stdout;
  assert(JSON.parse(skillList).entries.some((entry: { name: string }) => entry.name === 'review'));
  assert(!skillList.includes('installed-private-skill-body'));
  const skillPrompt = (await run(['prompt', '--json', '--skill', 'review'])).stdout;
  assert.equal(JSON.parse(skillPrompt).skills.sources[0].reason, 'explicit');
  assert(!skillPrompt.includes('installed-private-skill-body'));
  assert((await run(['chat', '/skill review 检查中文文件'])).stderr.includes('[explicit]'));
  assert.equal(
    JSON.parse((await run(['skills', 'resource', 'review', '中文.txt'])).stdout).content,
    'installed skill evidence 🐈',
  );
  const agentEvents = (await run(['--mode', 'plan', 'run', '查看目录', '--json'])).stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string; reason?: string });
  assert(agentEvents.some((event) => event.type === 'tool_result'));
  assert.equal(agentEvents.at(-1)?.reason, 'completed');
  await writeFile(
    join(installation, '子任务.json'),
    JSON.stringify({
      tasks: [
        { id: 'installed-one', goal: '列出目录' },
        { id: 'installed-two', goal: '再次列出目录' },
      ],
    }),
  );
  const childEvents = (await run(['delegate', '--tasks-file', '子任务.json', '--json'])).stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const children = JSON.parse(childEvents.at(-1).result.content).tasks;
  assert.equal(children.length, 2);
  assert(children.every((item: { status: string }) => item.status === 'completed'));
  assert.equal(new Set(children.map((item: { agentId: string }) => item.agentId)).size, 2);
  const delegated = (
    await run(['--subagents', '--mode', 'plan', 'run', '检查目录', '--json'])
  ).stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(delegated.some((item) => item.type === 'subagent' && item.state === 'completed'));
  assert.equal(delegated.at(-1).reason, 'completed');
  const worktreeProject = join(temporary, '隔离 Git 项目');
  await mkdir(worktreeProject);
  const git = (args: string[], cwd = worktreeProject) =>
    exec(
      'git',
      [
        '-c',
        'core.hooksPath=' + join(temporary, 'no-hooks'),
        '-c',
        'core.fsmonitor=false',
        '-c',
        'commit.gpgSign=false',
        ...args,
      ],
      {
        cwd,
        env: {
          ...env,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        },
        timeout: 10_000,
        windowsHide: true,
      },
    );
  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', 'Fixture']);
  await git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(join(worktreeProject, 'same.txt'), 'primary\n');
  await git(['add', 'same.txt']);
  await git(['commit', '-m', 'base']);
  const worktrees = [];
  for (const task of ['one', 'two']) {
    const created = JSON.parse(
      (await run(['--cwd', worktreeProject, 'worktrees', 'create', '--task', task, '--approve']))
        .stdout,
    );
    assert(created.result.ok);
    worktrees.push(
      JSON.parse(created.result.content) as { id: string; path: string; branch: string },
    );
  }
  await writeFile(
    join(worktreeProject, 'tasks.json'),
    JSON.stringify({
      tasks: worktrees.map((item, index) => ({
        id: `installed-${index}`,
        worktree: item.id,
        goal: '离线写入验证',
      })),
    }),
  );
  const written = (
    await run([
      '--cwd',
      worktreeProject,
      '--mode',
      'accept-edits',
      'worktrees',
      'delegate',
      '--tasks-file',
      'tasks.json',
      '--approve',
      '--json',
    ])
  ).stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert(
    JSON.parse(written.at(-1).result.content).tasks.every(
      (item: { status: string }) => item.status === 'completed',
    ),
  );
  assert.equal(written.at(-1).budget.reserved, 0);
  for (const item of worktrees) {
    assert(
      (await readFile(join(item.path, 'mewcode-demo.txt'), 'utf8')).includes('离线工作树隔离演示'),
    );
    const report = JSON.parse(
      JSON.parse((await run(['--cwd', worktreeProject, 'worktrees', 'show', item.id])).stdout)
        .result.content,
    );
    assert(report.dirty && report.owner.status === 'completed');
    const refused = (await run([
      '--cwd',
      worktreeProject,
      'worktrees',
      'remove',
      item.id,
      '--approve',
    ]).catch((error: unknown) => error)) as { code: number; stdout: string };
    assert.equal(refused.code, 1);
    assert(refused.stdout.includes('WORKTREE_DIRTY'));
    // Commit the reviewed fixture before normal cleanup; never force-remove a dirty tree.
    await git(['add', 'mewcode-demo.txt'], item.path);
    await git(['commit', '-m', 'offline fixture delivery'], item.path);
    await run(['--cwd', worktreeProject, 'worktrees', 'remove', item.id, '--approve']);
    assert(
      (await git(['show-ref', '--verify', `refs/heads/${item.branch}`])).stdout.includes(
        item.branch,
      ),
    );
  }
  assert.equal(await readFile(join(worktreeProject, 'same.txt'), 'utf8'), 'primary\n');
  const teamTrees = [];
  for (const task of ['alice', 'bob']) {
    const created = JSON.parse(
      (await run(['--cwd', worktreeProject, 'worktrees', 'create', '--task', task, '--approve']))
        .stdout,
    );
    assert(created.result.ok);
    teamTrees.push(
      JSON.parse(created.result.content) as { id: string; path: string; branch: string },
    );
  }
  const teamOutput = (stdout: string) =>
    JSON.parse(JSON.parse(stdout.trim().split('\n').at(-1)!).result.content);
  const teamRun = (args: string[]) =>
    run(['--cwd', worktreeProject, '--provider', 'mock', ...args]);
  await writeFile(
    join(worktreeProject, '团队.json'),
    JSON.stringify({
      name: 'installed-team',
      members: teamTrees.map((tree, index) => ({
        id: ['alice', 'bob'][index],
        role: 'offline fixture',
        worktree: tree.id,
      })),
      tasks: [
        { id: 'first', member: 'alice', goal: 'installed-team-private-goal' },
        { id: 'second', member: 'bob', goal: 'offline fixture', dependsOn: ['first'] },
      ],
    }),
  );
  const team = teamOutput(
    (await teamRun(['teams', 'create', '--file', '团队.json', '--approve'])).stdout,
  );
  const teamMetadata = (await teamRun(['teams', 'show', team.id])).stdout;
  assert(!teamMetadata.includes('installed-team-private-goal'));
  await writeFile(
    join(worktreeProject, '消息.json'),
    JSON.stringify({
      messageId: randomUUID(),
      to: 'alice',
      task: 'first',
      text: 'installed coordination data',
    }),
  );
  for (let i = 0; i < 2; i++)
    await teamRun(['teams', 'send', team.id, '--file', '消息.json', '--approve']);
  assert.equal(
    teamOutput((await teamRun(['teams', 'inbox', team.id, '--member', 'alice'])).stdout).length,
    1,
  );
  const delivery = teamOutput(
    (await teamRun(['--mode', 'accept-edits', 'teams', 'run', team.id, '--approve', '--json']))
      .stdout,
  );
  assert(delivery.team.tasks.every((task: { status: string }) => task.status === 'completed'));
  assert.equal(delivery.budget.reserved, 0);
  assert.equal(delivery.metrics.claims, 2);
  const replay = teamOutput(
    (await teamRun(['--mode', 'accept-edits', 'teams', 'run', team.id, '--approve'])).stdout,
  );
  assert.equal(replay.metrics.modelRequests, 0);
  assert.equal(replay.team.usedTokens, delivery.team.usedTokens);
  const teamReport = teamOutput((await teamRun(['teams', 'report', team.id])).stdout);
  assert.equal(teamReport.merge, 'manual-review-required');
  assert.deepEqual(teamReport.overlappingPaths, [
    { path: 'mewcode-demo.txt', members: ['alice', 'bob'] },
  ]);
  for (const tree of teamTrees) {
    assert(
      (await readFile(join(tree.path, 'mewcode-demo.txt'), 'utf8')).includes('离线工作树隔离演示'),
    );
    await git(['add', 'mewcode-demo.txt'], tree.path);
    await git(['commit', '-m', 'reviewed offline team fixture'], tree.path);
    await teamRun(['worktrees', 'remove', tree.id, '--approve']);
    assert(
      (await git(['show-ref', '--verify', `refs/heads/${tree.branch}`])).stdout.includes(
        tree.branch,
      ),
    );
  }
  assert.equal(await readFile(join(worktreeProject, 'same.txt'), 'utf8'), 'primary\n');
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

  const hookConfig = join(installation, 'hook-config.json');
  await writeFile(
    hookConfig,
    JSON.stringify({
      hooks: [{ id: 'installed', event: 'PreToolUse', script: '中文 Hook.mjs', tool: 'ReadFile' }],
    }),
  );
  await writeFile(
    join(installation, '中文 Hook.mjs'),
    'console.log(JSON.stringify({decision:"continue"}));',
  );
  assert.equal(
    JSON.parse((await run(['--config', hookConfig, 'hooks'])).stdout).hooks[0].id,
    'installed',
  );
  const hookedTool = JSON.parse(
    (
      await run([
        '--config',
        hookConfig,
        'tool',
        'ReadFile',
        '--approve',
        '--input',
        JSON.stringify({ path: '工具文件.txt' }),
      ])
    ).stdout,
  );
  assert(hookedTool.ok && hookedTool.content.includes('安装后的工具'));
  assert.equal(hookedTool.hooks.length, 1);
  assert(hookedTool.audit.some((record: { name: string }) => record.name === 'HookScript'));

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
        notices: 'passed (production dependency notices packaged; private config files absent)',
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
        skills:
          'passed (metadata without body, explicit selection, private prompt metadata, bounded Unicode resource)',
        helpWithoutConfigDependencies: 'passed',
        helpMedianMs: Number(timings[3]?.toFixed(2)),
        helpMinMs: Number(timings[0]?.toFixed(2)),
        helpMaxMs: Number(timings[6]?.toFixed(2)),
        packageBytes: archive.size,
        hooks: 'passed (inert inspection, approved Node snapshot, Unicode source path, hook audit)',
        subagents: 'passed (offline independent read-only children and parent delegation)',
        worktrees:
          'passed (installed Git fixture, two isolated writes, dirty cleanup refusal, reviewed commits, normal cleanup with retained branches)',
        teams:
          'passed (dependent persistent members, message deduplication, isolated writes, report overlap, zero-request replay, reviewed cleanup)',
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
