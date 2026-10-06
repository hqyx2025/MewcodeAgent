import { randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { loadConfiguration } from '../../src/config/load.js';
import { AgentLoop } from '../../src/core/agent-loop.js';
import { MockProvider } from '../../src/providers/mock.js';
import { evaluatePermission } from '../../src/security/policy.js';
import { permissionRuleSchema } from '../../src/security/rules.js';
import type { ScopedPermissionRule } from '../../src/security/rules.js';
import { AuditFile } from '../../src/security/audit.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { defineTool } from '../../src/tools/types.js';
import type { ApprovalRequest } from '../../src/tools/types.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';

describe('M06 layered permissions and approvals', () => {
  let sandbox: Awaited<ReturnType<typeof createSandbox>>;
  beforeEach(async () => {
    sandbox = await createSandbox();
    await mkdir(join(sandbox.cwd, 'private'));
    await mkdir(join(sandbox.cwd, 'public'));
    await writeFile(join(sandbox.cwd, 'private', 'a.txt'), 'private-marker');
    await writeFile(join(sandbox.cwd, 'public', 'a.txt'), 'public-marker');
  });
  afterEach(async () => {
    await removeSandbox(sandbox.root);
  });
  const call = (executor: ToolExecutor, name: string, input: unknown, signal?: AbortSignal) =>
    executor.execute({ callId: randomUUID(), name, input }, signal);
  const rules: ScopedPermissionRule[] = [{ source: 'user', decision: 'deny', path: 'private' }];

  it('accumulates persistent restrictions and does not elevate the user mode from project config', async () => {
    await writeFile(
      join(sandbox.userDirectory, 'config.yaml'),
      'mode: plan\npermissions:\n  rules:\n    - decision: deny\n      path: private\n',
    );
    await writeFile(
      join(sandbox.projectDirectory, 'config.yaml'),
      'mode: accept-edits\npermissions:\n  rules:\n    - decision: allow\n      path: private\n',
    );
    const options = { cwd: sandbox.cwd, userHome: sandbox.home, env: {} };
    const loaded = await loadConfiguration(options);
    expect(loaded.settings.mode).toBe('plan');
    expect(loaded.permissionRules.map((r) => r.source)).toEqual(['user', 'project']);
    const override = await loadConfiguration({
      ...options,
      overrides: { mode: 'accept-edits', permissions: { rules: [] } },
    });
    const exec = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      mode: override.settings.mode,
      rules: override.permissionRules,
      approve: async () => true,
    });
    expect((await call(exec, 'ReadFile', { path: 'private/a.txt' })).error?.code).toBe(
      'TOOL_PERMISSION',
    );
    expect(override.settings.permissions.rules).toHaveLength(2);
    expect((await loadConfiguration(options)).permissionRules).toEqual(loaded.permissionRules);
  });

  it.each([
    '../private',
    '/private',
    'C:/private',
    'a\\b',
    'a/../b',
    'a/',
    'a/**',
    'trailing.',
    'a:stream',
    'a\nsecret',
  ])('rejects ambiguous rule path %j', (path) => {
    expect(permissionRuleSchema.safeParse({ decision: 'deny', path }).success).toBe(false);
  });

  it('deny precedes ask and trusted allow, asks precede allow, and project cannot grant writes', () => {
    const policy: ScopedPermissionRule[] = [
      { source: 'cli', decision: 'allow' },
      { source: 'user', decision: 'ask', path: 'public' },
      ...rules,
    ];
    expect(
      evaluatePermission('accept-edits', 'WriteFile', 'write', [], policy, 'private/a').decision,
    ).toBe('deny');
    expect(
      evaluatePermission('accept-edits', 'WriteFile', 'write', [], policy, 'public/a').decision,
    ).toBe('ask');
    expect(
      evaluatePermission(
        'default',
        'WriteFile',
        'write',
        [],
        [{ source: 'project', decision: 'allow' }],
        'a',
      ).decision,
    ).toBe('ask');
    expect(
      evaluatePermission(
        'default',
        'WriteFile',
        'write',
        [],
        [{ source: 'user', decision: 'allow' }],
        'a',
      ).decision,
    ).toBe('allow');
    expect(evaluatePermission('plan', 'WriteFile', 'write', [], policy, 'a').decision).toBe('deny');
    expect(
      evaluatePermission(
        'default',
        'Bash',
        'shell',
        [],
        [{ source: 'user', decision: 'allow' }],
        '.',
      ).decision,
    ).toBe('ask');
  });

  it('canonicalizes scope aliases, keeps directory boundaries, and guards recursive searches before reads', async () => {
    const exec = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      rules,
      approve: async () => true,
      rgExecutable: 'never-spawn-this',
    });
    for (const path of ['public/../private/a.txt', join(exec.paths.root, 'private', 'a.txt')])
      expect((await call(exec, 'ReadFile', { path })).error?.code).toBe('TOOL_PERMISSION');
    for (const [name, input] of [
      ['Glob', { pattern: '**/*' }],
      ['Grep', { pattern: 'private-marker', path: '.' }],
    ] as const)
      expect((await call(exec, name, input)).error?.code).toBe('TOOL_PERMISSION');
    expect((await call(exec, 'ReadFile', { path: 'public/a.txt' })).ok).toBe(true);
    expect((await call(exec, 'Glob', { pattern: 'public/*' })).ok).toBe(true);
    expect(
      evaluatePermission('default', 'ReadFile', 'read', [], rules, 'private-other/a').decision,
    ).toBe('allow');
    expect(evaluatePermission('default', 'ReadFile', 'read', [], rules, 'PRIVATE/a').decision).toBe(
      process.platform === 'win32' ? 'deny' : 'allow',
    );
  });

  it('ReadFile path deny also blocks recursive read tools and instruction access', async () => {
    const exec = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      rules: [{ source: 'user', tool: 'ReadFile', path: 'private', decision: 'deny' }],
    });
    expect((await call(exec, 'Grep', { pattern: 'a' })).error?.code).toBe('TOOL_PERMISSION');
    await expect(exec.paths.resolve('private/AGENTS.md', true)).rejects.toMatchObject({
      code: 'TOOL_PERMISSION',
    });
  });

  it('read ask covers intersecting search ranges and noninteractive callers cannot bypass it', async () => {
    const exec = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      rules: [{ source: 'user', effect: 'read', path: 'private', decision: 'ask' }],
    });
    expect((await call(exec, 'Glob', { pattern: '**/*' })).error?.code).toBe('TOOL_PERMISSION');
    expect(exec.auditLog.at(-1)?.authorization).toBe('unavailable');
    expect((await call(exec, 'Glob', { pattern: 'public/*' })).ok).toBe(true);
  });

  it('automatic instruction loading does not bypass a read ask rule', async () => {
    await writeFile(join(sandbox.cwd, 'AGENTS.md'), 'private-instruction-marker');
    const executor = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      mode: 'plan',
      rules: [{ source: 'user', effect: 'read', path: 'AGENTS.md', decision: 'ask' }],
    });
    const agent = new AgentLoop(new MockProvider(), executor, {
      model: 'mock-v1',
      mode: 'plan',
      maxTurns: 3,
      timeoutMs: 1000,
      maxOutputTokens: 512,
    });
    const manifest = await agent.inspectPrompt();
    expect(manifest.sources).toHaveLength(0);
    expect(manifest.warnings[0]?.code).toBe('PERMISSION');
    expect(JSON.stringify(manifest)).not.toContain('private-instruction-marker');
  });

  const shellRegistry = (run: () => void, preview: () => string = () => 'opaque shell command') =>
    new ToolRegistry().register(
      defineTool({
        name: 'Bash',
        description: 'test',
        effect: 'shell',
        schema: z.strictObject({ command: z.string(), cwd: z.string().default('.') }),
        async prepare(input, context) {
          return {
            target: await context.paths.resolve(input.cwd),
            preview: preview(),
            async run() {
              run();
              return { content: 'done' };
            },
          };
        },
      }),
    );

  it('session consent reuses only exact normalized parameters, target, preview and shell', async () => {
    let executed = 0,
      preview = 'initial';
    const approve = vi.fn(async () => ({ allow: true, scope: 'session' as const }));
    const shell = { kind: 'bash' as const, executable: '/bin/bash' };
    const exec = await ToolExecutor.create(
      shellRegistry(
        () => executed++,
        () => preview,
      ),
      { root: sandbox.cwd, approve, shell },
    );
    shell.executable = '/mutated-after-construction';
    expect(exec.shell.executable).toBe('/bin/bash');
    for (let i = 0; i < 2; i++)
      expect((await call(exec, 'Bash', { command: 'echo a' })).ok).toBe(true);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(exec.auditLog.map((r) => r.cached)).toEqual([false, true]);
    await call(exec, 'Bash', { command: 'echo a; echo b' });
    await call(exec, 'Bash', { command: 'echo a', cwd: 'public' });
    preview = 'changed';
    await call(exec, 'Bash', { command: 'echo a' });
    expect(approve).toHaveBeenCalledTimes(4);
    expect(executed).toBe(5);
    expect(exec.auditLog.map((r) => r.authorization)).toEqual([
      'session',
      'session',
      'session',
      'session',
      'session',
    ]);
  });

  it('once consent never caches and refusal never executes or adds a grant', async () => {
    let executed = 0;
    const approve = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    const exec = await ToolExecutor.create(
      shellRegistry(() => executed++),
      { root: sandbox.cwd, approve },
    );
    for (let i = 0; i < 3; i++) await call(exec, 'Bash', { command: 'echo a' });
    expect(approve).toHaveBeenCalledTimes(3);
    expect(executed).toBe(2);
    expect(exec.auditLog.map((r) => r.authorization)).toEqual(['refused', 'once', 'once']);
  });

  it('caller changes during approval cannot relabel or replace the prepared operation', async () => {
    let executed = 0;
    const request = { callId: 'original-id', name: 'Bash', input: { command: 'original-command' } };
    const exec = await ToolExecutor.create(
      shellRegistry(() => executed++),
      {
        root: sandbox.cwd,
        approve: async () => {
          request.callId = 'replacement-id';
          request.name = 'ReadFile';
          request.input.command = 'changed-command';
          return true;
        },
      },
    );
    const result = await exec.execute(request);
    expect(result).toMatchObject({ ok: true, callId: 'original-id', name: 'Bash' });
    expect(executed).toBe(1);
    expect(exec.auditLog[0]?.name).toBe('Bash');
  });

  it('freezes approval data, exposes final cwd and refuses mode switches while pending', async () => {
    let request: ApprovalRequest | undefined;
    let finish: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const approve = vi.fn(async (r: ApprovalRequest) => {
      request = r;
      await gate;
      return true;
    });
    const exec = await ToolExecutor.create(
      shellRegistry(() => {}),
      { root: sandbox.cwd, approve },
    );
    const pending = call(exec, 'Bash', { command: 'echo a', cwd: 'public' });
    await vi.waitFor(() => expect(request).toBeDefined());
    expect(Object.isFrozen(request?.input)).toBe(true);
    expect(Object.isFrozen(request?.shell)).toBe(true);
    expect(request).toMatchObject({
      cwd: join(exec.paths.root, 'public'),
      scope: 'exact-input',
      mode: 'default',
    });
    expect(() => exec.setMode('plan')).toThrow('不能切换');
    finish();
    expect((await pending).ok).toBe(true);
  });

  it('clears session grants on mode changes and applies Plan even after session approval', async () => {
    const approve = vi.fn(async () => ({ allow: true, scope: 'session' as const }));
    const exec = await ToolExecutor.create(
      shellRegistry(() => {}),
      { root: sandbox.cwd, approve },
    );
    await call(exec, 'Bash', { command: 'echo a' });
    exec.setMode('plan');
    expect((await call(exec, 'Bash', { command: 'echo a' })).error?.code).toBe('TOOL_PERMISSION');
    exec.setMode('default');
    await call(exec, 'Bash', { command: 'echo a' });
    expect(approve).toHaveBeenCalledTimes(2);
  });

  it('child executors inherit deny, cannot raise mode, and obey later parent tightening', async () => {
    const parent = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      mode: 'accept-edits',
      rules,
    });
    const child = await parent.fork({
      mode: 'default',
      approve: async () => true,
      rules: [{ source: 'cli', decision: 'allow' }],
    });
    expect((await call(child, 'ReadFile', { path: 'private/a.txt' })).error?.code).toBe(
      'TOOL_PERMISSION',
    );
    parent.setMode('plan');
    await expect(parent.fork({ mode: 'default' })).rejects.toMatchObject({
      code: 'TOOL_PERMISSION',
    });
    expect(() => child.setMode('accept-edits')).toThrow('不能提升');
    expect((await call(child, 'WriteFile', { path: 'new', content: 'a' })).error?.code).toBe(
      'TOOL_PERMISSION',
    );
  });

  it('parent mode change during child approval cancels authorization before execution', async () => {
    let executed = 0;
    const parent = await ToolExecutor.create(
      shellRegistry(() => executed++),
      { root: sandbox.cwd },
    );
    const child = await parent.fork({
      approve: async () => {
        parent.setMode('plan');
        return { allow: true, scope: 'session' };
      },
    });
    expect((await call(child, 'Bash', { command: 'echo a' })).error?.code).toBe('TOOL_PERMISSION');
    expect(executed).toBe(0);
  });

  it('approval timeout and cancellation never execute or retain consent', async () => {
    let executed = 0;
    const approve = vi.fn(async () => new Promise<true>(() => {}));
    const exec = await ToolExecutor.create(
      shellRegistry(() => executed++),
      { root: sandbox.cwd, timeoutMs: 40, approve },
    );
    expect((await call(exec, 'Bash', { command: 'echo a' })).error?.code).toBe('TOOL_TIMEOUT');
    const cancel = new AbortController();
    const cancellable = await ToolExecutor.create(
      shellRegistry(() => executed++),
      { root: sandbox.cwd, timeoutMs: 1000, approve },
    );
    const pending = call(cancellable, 'Bash', { command: 'echo a' }, cancel.signal);
    await vi.waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
    cancel.abort();
    expect((await pending).error?.code).toBe('CANCELLED');
    expect(executed).toBe(0);
  });

  it('audit sink failure prevents side effects and audit metadata omits sensitive inputs', async () => {
    const audit = vi.fn(async () => {
      throw new Error('secret-from-sink');
    });
    const exec = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      approve: async () => true,
      audit,
    });
    const result = await call(exec, 'WriteFile', { path: 'new', content: 'private-key-content' });
    expect(result.error?.code).toBe('AUDIT_FAILED');
    expect(result.content).not.toContain('secret-from-sink');
    await expect(readFile(join(sandbox.cwd, 'new'))).rejects.toMatchObject({ code: 'ENOENT' });
    const records = JSON.stringify(exec.auditLog);
    expect(records).not.toContain('private-key-content');
    expect(records).not.toContain(sandbox.cwd);
    expect(exec.auditLog[0]?.callIdHash).toMatch(/^[a-f0-9]{64}$/);
    const snapshot = exec.auditLog as unknown as { reason: string }[];
    snapshot[0]!.reason = 'mutated';
    expect(exec.auditLog[0]?.reason).not.toBe('mutated');
  });

  it('writes ordered JSONL to a new file and refuses existing files or junction parents', async () => {
    const path = join(sandbox.root, 'audit.jsonl');
    const file = await AuditFile.create(path);
    const exec = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      audit: (r) => file.write(r),
    });
    await Promise.all([
      call(exec, 'ReadFile', { path: 'public/a.txt' }),
      call(exec, 'Glob', { pattern: 'public/*' }),
    ]);
    await file.close();
    const lines = (await readFile(path, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { sequence: number });
    expect(lines.map((l) => l.sequence)).toEqual([1, 2]);
    await expect(AuditFile.create(path)).rejects.toMatchObject({ code: 'AUDIT_FAILED' });
    const link = join(sandbox.root, 'audit-link');
    await symlink(sandbox.home, link, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(AuditFile.create(join(link, 'log'))).rejects.toMatchObject({
      code: 'AUDIT_FAILED',
    });
  });

  it('a stalled audit sink is bounded by the execution timeout', async () => {
    let executed = 0;
    const exec = await ToolExecutor.create(
      shellRegistry(() => executed++),
      {
        root: sandbox.cwd,
        timeoutMs: 30,
        approve: async () => true,
        audit: async () => new Promise<void>(() => {}),
      },
    );
    expect((await call(exec, 'Bash', { command: 'echo a' })).error?.code).toBe('TOOL_TIMEOUT');
    expect(executed).toBe(0);
  });

  it('child cannot replace parent programs or omit a mandatory parent audit sink', async () => {
    const parent = await ToolExecutor.create(
      shellRegistry(() => {}),
      {
        root: sandbox.cwd,
        shell: { kind: 'bash', executable: '/bin/bash' },
        audit: async () => {
          throw new Error('do-not-display');
        },
      },
    );
    await expect(
      parent.fork({ shell: { kind: 'bash', executable: '/other' } }),
    ).rejects.toMatchObject({ code: 'TOOL_PERMISSION' });
    const child = await parent.fork({ approve: async () => true, audit: async () => {} });
    expect(child.shell).toEqual(parent.shell);
    expect((await call(child, 'Bash', { command: 'echo a' })).error?.code).toBe('AUDIT_FAILED');
  });

  it('allows trusted file rules, honors ask in accept-edits, and renders edits as scoped diffs', async () => {
    const exec = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      rules: [{ source: 'user', decision: 'allow', tool: 'WriteFile', path: 'public' }],
    });
    expect((await call(exec, 'WriteFile', { path: 'public/new', content: 'one\ntwo' })).ok).toBe(
      true,
    );
    let preview = '';
    const approving = await ToolExecutor.create(createBuiltinRegistry(), {
      root: sandbox.cwd,
      mode: 'accept-edits',
      rules: [{ source: 'user', decision: 'ask', effect: 'write', path: 'public' }],
      approve: async (r) => {
        preview = r.preview;
        return true;
      },
    });
    const read = await call(approving, 'ReadFile', { path: 'public/new' });
    const revision = (read.data as { revision: string }).revision;
    expect(
      (
        await call(approving, 'EditFile', {
          path: 'public/new',
          oldText: 'two',
          newText: 'three',
          expectedRevision: revision,
        })
      ).ok,
    ).toBe(true);
    expect(preview).toContain('@@');
    expect(preview).toContain('-two');
    expect(preview).toContain('+three');
    expect(preview).toContain(' one');
  });
});
