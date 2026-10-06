import { randomUUID } from 'node:crypto';
import { link, readFile, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookRuntime } from '../../src/tools/hooks.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import type { ExecutorOptions } from '../../src/tools/executor.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import type { HookConfiguration } from '../../src/tools/hook-schema.js';
import type { ApprovalRequest } from '../../src/tools/types.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
import { respond, writeHook } from '../support/hooks.js';

describe('authorized local hook transactions', () => {
  let box: Awaited<ReturnType<typeof createSandbox>>;
  beforeEach(async () => {
    box = await createSandbox();
    await writeFile(join(box.cwd, 'read.txt'), 'first');
    await writeFile(join(box.cwd, 'other.txt'), 'second');
  });
  afterEach(async () => {
    await removeSandbox(box.root);
  });
  async function runtime(
    configurations: HookConfiguration[],
    options: Partial<ExecutorOptions> = {},
    extra: ConstructorParameters<typeof HookRuntime>[2] = {},
  ) {
    const registry = createBuiltinRegistry();
    const hooks = new HookRuntime(registry, configurations, extra);
    const executor = await ToolExecutor.create(registry, {
      root: box.cwd,
      timeoutMs: 15_000,
      approve: async () => true,
      ...options,
      hooks: hooks.handle,
    });
    return { hooks, executor, registry };
  }
  const call = (path = 'read.txt') => ({ callId: randomUUID(), name: 'ReadFile', input: { path } });

  it('blocks a tool with no effect and consumes its id; internal scripts cannot recurse or be directly invoked', async () => {
    const hook = await writeHook(box.cwd, {}, respond({ decision: 'block' }));
    const { hooks, executor, registry } = await runtime([hook]);
    const request = call();
    expect((await executor.execute(request)).error?.code).toBe('HOOK_BLOCKED');
    expect((await executor.execute(request)).error?.code).toBe('TOOL_DUPLICATE');
    expect(executor.auditLog.map((item) => item.name)).toEqual(['HookScript']);
    expect(hooks.auditLog).toHaveLength(1);
    expect(registry.definitions().map((item) => item.name)).not.toContain('HookScript');
    expect((await executor.execute({ ...call(), name: 'HookScript' })).error?.code).toBe(
      'TOOL_NOT_FOUND',
    );
  });

  it('chains legal replacements and approves the final write rather than original parameters', async () => {
    const first = await writeHook(
      box.cwd,
      { id: 'first', script: 'first.mjs', tool: 'WriteFile' },
      respond({ decision: 'continue', updatedInput: { path: 'changed.txt', content: 'changed' } }),
    );
    const second = await writeHook(
      box.cwd,
      { id: 'second', script: 'second.mjs', tool: 'WriteFile' },
      `let text='';for await(const part of process.stdin)text+=part;const event=JSON.parse(text);
      if(event.tool.input.path!=='changed.txt')process.exit(3);
      console.log(JSON.stringify({decision:'continue',updatedInput:{...event.tool.input,content:'final'}}));`,
    );
    const requests: ApprovalRequest[] = [];
    const { executor, hooks } = await runtime([first, second], {
      approve: async (request) => {
        requests.push(request);
        return true;
      },
    });
    const result = await executor.execute({
      callId: randomUUID(),
      name: 'WriteFile',
      input: { path: 'original.txt', content: 'original' },
    });
    expect(result.ok).toBe(true);
    expect(await readFile(join(box.cwd, 'changed.txt'), 'utf8')).toBe('final');
    await expect(stat(join(box.cwd, 'original.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(requests.map((item) => item.name)).toEqual(['HookScript', 'HookScript', 'WriteFile']);
    expect(requests[2]?.input).toMatchObject({ path: 'changed.txt', content: 'final' });
    expect(hooks.auditLog.map((item) => item.hookId)).toEqual(['first', 'second']);
  });

  it.each([
    [{ path: '../outside.txt', content: 'never' }, 'PATH_DENIED'],
    [{ path: '.env.local', content: 'never' }, 'PATH_DENIED'],
    [{ path: 'blocked.txt', content: 'never' }, 'TOOL_PERMISSION'],
    [{ path: 'safe.txt', content: 'never', unexpected: true }, 'TOOL_INPUT'],
  ] as const)(
    'revalidates rewritten input %# without authorizing the forbidden target',
    async (updatedInput, code) => {
      const hook = await writeHook(
        box.cwd,
        { tool: 'WriteFile' },
        respond({ decision: 'continue', updatedInput }),
      );
      const approved: string[] = [];
      const { executor } = await runtime([hook], {
        rules: [{ source: 'project', decision: 'deny', tool: 'WriteFile', path: 'blocked.txt' }],
        approve: async (request) => {
          approved.push(request.name);
          return true;
        },
      });
      const result = await executor.execute({
        callId: randomUUID(),
        name: 'WriteFile',
        input: { path: 'safe.txt', content: 'original' },
      });
      expect(result.error?.code).toBe(code);
      expect(approved).toEqual(['HookScript']);
      await expect(stat(join(box.cwd, 'safe.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('does not execute scripts for initial invalid or denied tools; Plan/Bash/ReadFile denials cannot be bypassed', async () => {
    const hook = await writeHook(box.cwd);
    const plain = await runtime([hook], { denyTools: ['ReadFile'] });
    expect((await plain.executor.execute(call())).error?.code).toBe('TOOL_PERMISSION');
    expect(plain.hooks.auditLog).toHaveLength(0);
    const invalid = await runtime([hook]);
    expect(
      (await invalid.executor.execute({ ...call(), input: { wrong: true } })).error?.code,
    ).toBe('TOOL_INPUT');
    expect(invalid.hooks.auditLog).toHaveLength(0);
    for (const options of [
      { mode: 'plan' as const },
      { denyTools: ['Bash'] },
      { denyTools: ['HookScript'] },
      {
        rules: [
          {
            source: 'project' as const,
            decision: 'deny' as const,
            tool: 'ReadFile',
            path: 'guard.mjs',
          },
        ],
      },
      {
        rules: [
          {
            source: 'user' as const,
            decision: 'ask' as const,
            tool: 'ReadFile',
            path: 'guard.mjs',
          },
        ],
      },
    ]) {
      const current = await runtime([hook], options);
      expect((await current.executor.execute(call())).error?.code).toBe('TOOL_PERMISSION');
      expect(current.hooks.auditLog[0]?.outcome).toBe('error');
    }
  });

  it('accept-edits still asks for scripts; refused approval does not run source', async () => {
    const hook = await writeHook(
      box.cwd,
      {},
      `import{writeFileSync}from'node:fs';writeFileSync('never.txt','never');${respond({ decision: 'continue' })}`,
    );
    const { executor } = await runtime([hook], {
      mode: 'accept-edits',
      approve: async () => false,
    });
    expect((await executor.execute(call())).error?.code).toBe('TOOL_PERMISSION');
    await expect(stat(join(box.cwd, 'never.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects a script replaced during approval and never runs the old or new source', async () => {
    const hook = await writeHook(box.cwd);
    const { executor } = await runtime([hook], {
      approve: async () => {
        await writeFile(join(box.cwd, hook.script), 'throw new Error("private-source")');
        return true;
      },
    });
    expect((await executor.execute(call())).error?.code).toBe('HOOK_CHANGED');
  });

  it.each([
    ['console.log("not-json-private-output")', 'HOOK_INVALID'],
    ['console.log(JSON.stringify({decision:"continue",unknown:"private-output"}))', 'HOOK_INVALID'],
    ['console.error("private-stderr");process.exit(7)', 'HOOK_FAILED'],
    ['console.log("猫".repeat(20000))', 'HOOK_OUTPUT_LIMIT'],
    [respond({ decision: 'block', updatedInput: { path: 'other.txt' } }), 'HOOK_INVALID'],
  ])(
    'fails closed for invalid protocol/exit/output %# without leaking content',
    async (source, code) => {
      const hook = await writeHook(box.cwd, {}, source);
      const { executor, hooks } = await runtime([hook]);
      const result = await executor.execute(call());
      expect(result.error?.code).toBe(code);
      expect(JSON.stringify([result, hooks.auditLog, executor.auditLog])).not.toMatch(
        /private-output|private-source|private-stderr/,
      );
    },
  );

  it('times out and cancels scripts, cleaning up the spawned process tree', async () => {
    const children: number[] = [];
    try {
      for (const cancelled of [false, true]) {
        await unlink(join(box.cwd, 'pid.txt')).catch(() => {});
        const hook = await writeHook(
          box.cwd,
          { timeoutMs: cancelled ? 10_000 : 1500 },
          `import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';
          const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
          writeFileSync('pid.txt',String(child.pid));setInterval(()=>{},1000);`,
        );
        const { executor, hooks } = await runtime([hook]);
        const controller = new AbortController();
        const pending = executor.execute(call(), controller.signal);
        let pid = 0;
        await vi.waitFor(
          async () => {
            pid = Number(await readFile(join(box.cwd, 'pid.txt'), 'utf8'));
            expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
          },
          { timeout: 5000 },
        );
        children.push(pid);
        if (cancelled) controller.abort();
        expect((await pending).error?.code).toBe(cancelled ? 'CANCELLED' : 'TOOL_TIMEOUT');
        expect(hooks.auditLog[0]?.outcome).toBe('error');
        await vi.waitFor(
          () => {
            // Linux may briefly retain a killed descendant as a zombie; it is no longer executing.
            try {
              process.kill(pid, 0);
            } catch {
              return;
            }
            if (process.platform === 'linux')
              return readFile(`/proc/${pid}/stat`, 'utf8').then((value) =>
                expect(value.split(') ')[1]?.[0]).toBe('Z'),
              );
            throw new Error('Child still executing');
          },
          { timeout: 3000 },
        );
      }
    } finally {
      for (const pid of children) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* already stopped */
        }
      }
    }
  }, 15_000);

  it('queues concurrent tools in transaction order and isolates their identities and inputs', async () => {
    const before = await writeHook(box.cwd);
    const after = await writeHook(box.cwd, {
      id: 'post',
      script: 'post.mjs',
      event: 'PostToolUse',
    });
    const { executor, hooks } = await runtime([before, after]);
    const results = await Promise.all([
      executor.execute(call()),
      executor.execute(call('other.txt')),
    ]);
    expect(results.map((item) => item.content)).toEqual(['1: first', '1: second']);
    expect(hooks.auditLog.map((item) => item.event)).toEqual([
      'PreToolUse',
      'PostToolUse',
      'PreToolUse',
      'PostToolUse',
    ]);
    expect(new Set(hooks.auditLog.map((item) => item.eventId)).size).toBe(4);
    expect(new Set(hooks.auditLog.map((item) => item.sessionId)).size).toBe(1);
  });

  it('cancels a queued request promptly without letting later requests overtake the active transaction', async () => {
    const hook = await writeHook(box.cwd);
    let approvalStarted!: () => void;
    const started = new Promise<void>((done) => {
      approvalStarted = done;
    });
    let approve!: () => void;
    const wait = new Promise<void>((done) => {
      approve = done;
    });
    let count = 0;
    const { executor, hooks } = await runtime([hook], {
      approve: async () => {
        if (++count === 1) {
          approvalStarted();
          await wait;
        }
        return true;
      },
    });
    const first = executor.execute(call());
    await started;
    const controller = new AbortController();
    const second = executor.execute(call(), controller.signal);
    controller.abort();
    expect((await second).error?.code).toBe('CANCELLED');
    const third = executor.execute(call('other.txt'));
    expect(hooks.auditLog).toHaveLength(0);
    approve();
    expect((await first).ok).toBe(true);
    expect((await third).content).toBe('1: second');
    expect(hooks.auditLog).toHaveLength(2);
  });

  it('keeps successful writes and failed tool results when post notification fails or tries to rewrite', async () => {
    const hook = await writeHook(
      box.cwd,
      { event: 'PostToolUse' },
      respond({ decision: 'continue', updatedInput: { path: 'wrong.txt' } }),
    );
    const { executor, hooks } = await runtime([hook]);
    expect(
      (
        await executor.execute({
          callId: randomUUID(),
          name: 'WriteFile',
          input: { path: 'done.txt', content: 'done' },
        })
      ).ok,
    ).toBe(true);
    expect(await readFile(join(box.cwd, 'done.txt'), 'utf8')).toBe('done');
    expect((await executor.execute(call('missing.txt'))).error?.code).toBe('FILE_NOT_FOUND');
    expect(hooks.auditLog.map((item) => item.code)).toEqual(['HOOK_INVALID', 'HOOK_INVALID']);
  });

  it('passes explicit variables only and redacts stdin/audit/approval without corrupting JSON', async () => {
    const marker = 'fixture-private-token-value';
    const hook = await writeHook(
      box.cwd,
      { env: ['FIXTURE_TOKEN'] },
      `let text='';for await(const part of process.stdin)text+=part;const event=JSON.parse(text);
      if(process.env.FIXTURE_TOKEN!=='${marker}'||process.env.OPENAI_API_KEY||process.env.NODE_OPTIONS)process.exit(2);
      if(event.tool.input.content.includes('${marker}')||event.tool.input.content!=='[REDACTED]')process.exit(3);
      console.log(JSON.stringify({decision:'continue'}));`,
    );
    const requests: ApprovalRequest[] = [];
    const { executor, hooks } = await runtime(
      [hook],
      {
        approve: async (request) => {
          requests.push(request);
          return true;
        },
      },
      {
        env: { FIXTURE_TOKEN: marker, OPENAI_API_KEY: 'unrequested-key' },
        sensitiveValues: [marker],
      },
    );
    expect(
      (
        await executor.execute({
          callId: randomUUID(),
          name: 'WriteFile',
          input: { path: 'out.txt', content: marker },
        })
      ).ok,
    ).toBe(true);
    expect(
      JSON.stringify([
        hooks.auditLog,
        executor.auditLog,
        requests.filter((item) => item.name === 'HookScript'),
      ]),
    ).not.toContain(marker);
    expect(requests[0]?.preview).toContain('FIXTURE_TOKEN');
  });

  it('fails closed for missing explicit env and oversized stdin', async () => {
    const hook = await writeHook(box.cwd, { env: ['MISSING_VARIABLE'] });
    const current = await runtime([hook], {}, { env: {} });
    expect((await current.executor.execute(call())).error?.code).toBe('HOOK_ENV');
    const small = await runtime([await writeHook(box.cwd)]);
    expect(
      (
        await small.executor.execute({
          callId: randomUUID(),
          name: 'WriteFile',
          input: { path: 'large.txt', content: 'x'.repeat(70000) },
        })
      ).error?.code,
    ).toBe('HOOK_INPUT_LIMIT');
  });

  it('accepts long approved source on Windows without placing it on the command line', async () => {
    const hook = await writeHook(
      box.cwd,
      {},
      '/*' + '猫'.repeat(16000) + '*/\n' + respond({ decision: 'continue' }),
    );
    const { executor } = await runtime([hook]);
    expect((await executor.execute(call())).ok).toBe(true);
  });

  it('denies script hardlinks and symlinks', async () => {
    const hook = await writeHook(box.cwd);
    await link(join(box.cwd, hook.script), join(box.cwd, 'hard.mjs'));
    const hard = await runtime([{ ...hook, script: 'hard.mjs' }]);
    expect((await hard.executor.execute(call())).ok).toBe(false);
    // Junction/directory links are covered by ProjectPaths tests; creating a file link on Windows
    // may require developer privileges, so this actual file-link case is Linux-specific.
    if (process.platform !== 'win32') {
      await symlink(join(box.cwd, hook.script), join(box.cwd, 'linked.mjs'));
      const linked = await runtime([{ ...hook, script: 'linked.mjs' }]);
      expect((await linked.executor.execute(call())).error?.code).toBe('PATH_DENIED');
    }
  });

  it('fails closed when hook audit storage fails, without returning private storage errors', async () => {
    const hook = await writeHook(box.cwd);
    const { executor } = await runtime(
      [hook],
      {},
      {
        audit: async () => {
          throw new Error('private-storage-error');
        },
      },
    );
    const result = await executor.execute(call());
    expect(result.error?.code).toBe('AUDIT_FAILED');
    expect(JSON.stringify(result)).not.toContain('private-storage-error');
  });

  it('redacts referenced values for other hooks and forbids returning credentials in rewritten tool input', async () => {
    const token = 'fixture-referenced-private-value';
    const first = await writeHook(box.cwd, {
      id: 'first',
      script: 'first.mjs',
      env: ['CUSTOM_PRIVATE'],
    });
    const second = await writeHook(
      box.cwd,
      { id: 'second', script: 'second.mjs' },
      `let text='';for await(const part of process.stdin)text+=part;const event=JSON.parse(text);
      if(process.env.CUSTOM_PRIVATE || event.tool.input.content!=='[REDACTED]')process.exit(3);
      ${respond({ decision: 'continue' })}`,
    );
    const current = await runtime([first, second], {}, { env: { CUSTOM_PRIVATE: token } });
    expect(
      (
        await current.executor.execute({
          callId: randomUUID(),
          name: 'WriteFile',
          input: { path: 'redacted.txt', content: token },
        })
      ).ok,
    ).toBe(true);
    await writeFile(
      join(box.cwd, first.script),
      `console.log(JSON.stringify({decision:'continue',updatedInput:{path:'leak.txt',content:process.env.CUSTOM_PRIVATE}}));`,
    );
    const result = await current.executor.execute({
      callId: randomUUID(),
      name: 'WriteFile',
      input: { path: 'safe.txt', content: 'safe' },
    });
    expect(result.error?.code).toBe('HOOK_INVALID');
    expect(JSON.stringify([result, current.hooks.auditLog])).not.toContain(token);
    await expect(stat(join(box.cwd, 'leak.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(
      join(box.cwd, first.script),
      `console.log(JSON.stringify({decision:'continue',updatedInput:{path:'leak.txt',[process.env.CUSTOM_PRIVATE]:'hidden'}}));`,
    );
    expect(
      (
        await current.executor.execute({
          callId: randomUUID(),
          name: 'WriteFile',
          input: { path: 'safe.txt', content: 'safe' },
        })
      ).error?.code,
    ).toBe('HOOK_INVALID');
  });

  it('inherits parent hook and shell restrictions in forks without accepting a replacement handler', async () => {
    const hook = await writeHook(box.cwd);
    const parent = await runtime([hook], { denyTools: ['Bash'] });
    const child = await parent.executor.fork({ hooks: async () => ({ decision: 'continue' }) });
    expect((await child.execute(call())).error?.code).toBe('TOOL_PERMISSION');
    expect(parent.hooks.auditLog).toHaveLength(1);
    const allowed = await runtime([hook]);
    const plan = await allowed.executor.fork({ mode: 'plan' });
    expect((await plan.execute(call())).error?.code).toBe('TOOL_PERMISSION');
  });
});
