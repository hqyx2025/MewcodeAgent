import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));
const entry = join(root, 'src/cli/index.ts');

describe('M06 permissions CLI', () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>>;
  let env: NodeJS.ProcessEnv;
  beforeEach(async () => {
    sandbox = await createSandbox();
    env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith('MEWCODE_')),
    );
    env.MEWCODE_HOME = sandbox.userDirectory;
  });
  afterEach(async () => {
    await removeSandbox(sandbox.root);
  });
  const cli = (args: string[]) =>
    exec(process.execPath, ['--import', 'tsx', entry, '--cwd', sandbox.cwd, ...args], {
      cwd: root,
      env,
      timeout: 10_000,
    });

  it('inspects scoped rules without model credentials and keeps inherited deny with --approve', async () => {
    await writeFile(
      join(sandbox.userDirectory, 'config.yaml'),
      'permissions:\n  rules:\n    - decision: deny\n      tool: WriteFile\n',
    );
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'provider:\n  kind: openai-compatible\n  model: test\n  apiKeyEnv: NO_M06_KEY\npermissions:\n  rules:\n    - decision: allow\n      tool: WriteFile\n',
    );
    delete env.NO_M06_KEY;
    const metadata = JSON.parse((await cli(['permissions'])).stdout) as {
      rules: { source: string; decision: string }[];
    };
    expect(metadata.rules).toEqual([
      { source: 'user', decision: 'deny', tool: 'WriteFile' },
      { source: 'project', decision: 'allow', tool: 'WriteFile' },
    ]);
    const denied = (await cli([
      'tool',
      'WriteFile',
      '--approve',
      '--input',
      JSON.stringify({ path: 'no', content: 'private-marker' }),
    ]).catch((e: unknown) => e)) as { stdout: string; code: number };
    expect(denied.code).toBe(1);
    const result = JSON.parse(denied.stdout) as { error: { code: string }; audit: unknown[] };
    expect(result.error.code).toBe('TOOL_PERMISSION');
    expect(result.audit).toHaveLength(1);
    expect(denied.stdout).not.toContain('private-marker');
  });

  it('persists decision JSONL and prevents tools reading the active audit file', async () => {
    await writeFile(join(sandbox.cwd, 'source'), 'visible');
    const path = join(sandbox.cwd, 'decision.jsonl');
    const result = await cli([
      'tool',
      'ReadFile',
      '--audit-file',
      path,
      '--input',
      JSON.stringify({ path: 'source' }),
    ]);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    const records = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { decision: string });
    expect(records[0]?.decision).toBe('allow');
    expect(JSON.stringify(records)).not.toContain('visible');
    const blocked = (await cli([
      'tool',
      'ReadFile',
      '--audit-file',
      'second.jsonl',
      '--input',
      JSON.stringify({ path: 'second.jsonl' }),
    ]).catch((e: unknown) => e)) as { code: number; stdout: string };
    expect(blocked.code).toBe(1);
    expect(JSON.parse(blocked.stdout).error.code).toBe('TOOL_PERMISSION');
  });

  it('never overwrites an existing audit file and reports a safe actionable error', async () => {
    await writeFile(join(sandbox.cwd, 'existing-log'), 'keep');
    const failed = (await cli([
      'tool',
      'WriteFile',
      '--approve',
      '--audit-file',
      'existing-log',
      '--input',
      JSON.stringify({ path: 'new', content: 'never' }),
    ]).catch((e: unknown) => e)) as { code: number; stderr: string };
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('AUDIT_FAILED');
    expect(await readFile(join(sandbox.cwd, 'existing-log'), 'utf8')).toBe('keep');
    await expect(readFile(join(sandbox.cwd, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects unsupported project audit scopes before creating a file or executing tools', async () => {
    const failed = (await cli([
      'tool',
      'WriteFile',
      '--approve',
      '--audit-file',
      'log[1].jsonl',
      '--input',
      JSON.stringify({ path: 'new', content: 'never' }),
    ]).catch((e: unknown) => e)) as { code: number; stderr: string };
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('AUDIT_FAILED');
    await expect(readFile(join(sandbox.cwd, 'log[1].jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(join(sandbox.cwd, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('emits clean permission JSONL in Mock Plan and mirrors it to persistent audit', async () => {
    await mkdir(join(sandbox.projectDirectory, 'audit'));
    const run = await cli([
      '--mode',
      'plan',
      'run',
      '查看目录',
      '--json',
      '--audit-file',
      '.mewcode/audit/run-audit.jsonl',
    ]);
    const events = run.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; record?: unknown });
    const decisions = events.filter((event) => event.type === 'permission');
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.record).toMatchObject({ decision: 'allow', name: 'Glob', mode: 'plan' });
    const stored = JSON.parse(
      (await readFile(join(sandbox.projectDirectory, 'audit', 'run-audit.jsonl'), 'utf8')).trim(),
    );
    expect(stored).toEqual(decisions[0]?.record);
    expect(events.at(-1)).toMatchObject({ type: 'finish', reason: 'completed' });
  });

  it('project allow and accept-edits do not silently grant nonTTY writes', async () => {
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'mode: accept-edits\npermissions:\n  rules:\n    - decision: allow\n      tool: WriteFile\n',
    );
    const failed = (await cli([
      'tool',
      'WriteFile',
      '--input',
      JSON.stringify({ path: 'new', content: 'never' }),
    ]).catch((e: unknown) => e)) as { stdout: string; code: number };
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout).error.code).toBe('TOOL_PERMISSION');
  });
});
