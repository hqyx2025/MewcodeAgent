import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { MCPManager, mcpToolName } from '../../src/mcp/manager.js';
import { createBuiltinRegistry } from '../../src/tools/builtins.js';
import { ToolExecutor } from '../../src/tools/executor.js';
import { createSandbox, removeSandbox } from '../support/sandbox.js';
import { createMCPHTTP } from '../support/mcp-http.js';

const fixture = fileURLToPath(new URL('../support/mcp-server.mjs', import.meta.url));

async function withStdio(
  scenario: string,
  action: (manager: MCPManager, executor: ToolExecutor, cwd: string) => Promise<void>,
  options: {
    callTimeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    references?: Record<string, string>;
  } = {},
) {
  const sandbox = await createSandbox();
  const registry = createBuiltinRegistry();
  const manager = new MCPManager(
    registry,
    {
      fixture: {
        transport: 'stdio',
        command: process.execPath,
        args: [fixture, scenario, join(sandbox.cwd, 'pids.json')],
        cwd: '.',
        env: options.references ?? {},
        connectTimeoutMs: 15_000,
        callTimeoutMs: options.callTimeoutMs ?? 5000,
      },
    },
    options.env,
  );
  const executor = await ToolExecutor.create(registry, {
    root: sandbox.cwd,
    approve: async () => true,
  });
  try {
    await action(manager, executor, sandbox.cwd);
  } finally {
    await manager.close();
    await removeSandbox(sandbox.root);
  }
}

async function echo(
  executor: ToolExecutor,
  text = 'hello',
  signal: AbortSignal = AbortSignal.timeout(5000),
) {
  return executor.execute(
    { callId: crypto.randomUUID(), name: mcpToolName('fixture', 'echo'), input: { text } },
    signal,
  );
}

async function assertDead(pid: number) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux') {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
        if (!stat || stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z')) return;
      }
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`owned process still exists: ${pid}`);
}

describe('MCP stdio client', () => {
  it('discovers pages, validates calls and isolates permission', async () => {
    const sandbox = await createSandbox();
    const command = process.execPath;
    const registry = createBuiltinRegistry();
    const manager = new MCPManager(registry, {
      fixture: {
        transport: 'stdio',
        command,
        args: [fixture],
        cwd: '.',
        env: {},
        connectTimeoutMs: 5000,
        callTimeoutMs: 5000,
      },
    });
    const approvals: string[] = [];
    const executor = await ToolExecutor.create(registry, {
      root: sandbox.cwd,
      mode: 'default',
      approve: async (request) => {
        approvals.push(request.name);
        return true;
      },
    });
    try {
      const connected = await manager.connect('fixture', executor, AbortSignal.timeout(20000));
      assert.equal(connected.ok, true);
      assert.equal(manager.catalog('fixture').length, 2);
      const echo = await executor.execute(
        { callId: 'echo', name: mcpToolName('fixture', 'echo'), input: { text: 'hello' } },
        AbortSignal.timeout(5000),
      );
      assert.equal(echo.ok, true);
      assert.equal(echo.content, 'hello');
      assert(approvals.includes('MCPConnect_fixture'));
      const readonly = await executor.execute(
        { callId: 'error', name: mcpToolName('fixture', 'readOnly'), input: {} },
        AbortSignal.timeout(5000),
      );
      assert.equal(readonly.ok, false);
      const invalid = await executor.execute(
        { callId: 'invalid', name: mcpToolName('fixture', 'echo'), input: { text: '' } },
        AbortSignal.timeout(5000),
      );
      assert.equal(invalid.ok, false);
    } finally {
      await manager.close();
      await removeSandbox(sandbox.root);
    }
  }, 25000);
  it('plan mode denies startup regardless of readOnlyHint', async () => {
    const sandbox = await createSandbox();
    const registry = createBuiltinRegistry();
    const manager = new MCPManager(registry, {
      fixture: {
        transport: 'stdio',
        command: process.execPath,
        args: [fixture],
        cwd: '.',
        env: {},
        connectTimeoutMs: 5000,
        callTimeoutMs: 5000,
      },
    });
    const executor = await ToolExecutor.create(registry, {
      root: sandbox.cwd,
      mode: 'plan',
      approve: async () => true,
    });
    try {
      const result = await manager.connect('fixture', executor, AbortSignal.timeout(5000));
      assert.equal(result.ok, false);
      assert.equal(result.error?.code, 'TOOL_PERMISSION');
    } finally {
      await manager.close();
      await removeSandbox(sandbox.root);
    }
  });
});

describe('MCP failures, permission and cleanup', () => {
  it.each(['bad-schema', 'duplicate'])(
    'rejects the entire invalid catalog: %s',
    async (scenario) => {
      await withStdio(scenario, async (manager, executor) => {
        const connected = await manager.connect('fixture', executor, AbortSignal.timeout(15_000));
        assert.equal(connected.ok, false);
        assert.equal(manager.catalog('fixture').length, 0);
        assert.equal(executor.registry.definitions().length, 6);
      });
    },
    20_000,
  );
  it.each(['bad-result', 'malformed', 'large', 'disconnect', 'stale', 'hang'])(
    'fails without retry and invalidates snapshot: %s',
    async (scenario) => {
      await withStdio(
        scenario,
        async (manager, executor) => {
          assert.equal(
            (await manager.connect('fixture', executor, AbortSignal.timeout(15_000))).ok,
            true,
          );
          assert.equal((await echo(executor)).ok, false);
          const next = await echo(executor);
          assert.equal(next.error?.code, 'MCP_DISCONNECTED');
        },
        { callTimeoutMs: 200 },
      );
    },
    20_000,
  );
  it('passes only explicit environment values and redacts output and stderr', async () => {
    const secret = 'fixture-secret-with-quote-"-and-newline\n';
    await withStdio(
      'env',
      async (manager, executor) => {
        assert.equal(
          (await manager.connect('fixture', executor, AbortSignal.timeout(15_000))).ok,
          true,
        );
        const result = await echo(executor);
        assert.equal(result.ok, true);
        assert(!JSON.stringify(result).includes('fixture-secret'));
        assert(!result.content.includes('inherited'));
        assert(!result.content.includes('nodeOptions'));
        assert(result.content.includes('[REDACTED]'));
        assert(!JSON.stringify(executor.auditLog).includes('fixture-secret'));
      },
      {
        env: { ...process.env, MCP_TOKEN: secret, MCP_NOT_ALLOWED: 'should-not-inherit' },
        references: { MCP_EXPLICIT: 'MCP_TOKEN' },
      },
    );
  }, 20_000);
  it('external user allow and accept-edits still require explicit approval', async () => {
    await withStdio('normal', async (manager, executor) => {
      assert.equal(
        (await manager.connect('fixture', executor, AbortSignal.timeout(15_000))).ok,
        true,
      );
      const denied = await executor.fork({
        mode: 'default',
        rules: [{ source: 'user', effect: 'external', decision: 'allow' }],
        approve: async () => false,
      });
      assert.equal((await echo(denied)).error?.code, 'TOOL_PERMISSION');
      const plan = await executor.fork({ mode: 'plan', approve: async () => true });
      assert.equal((await echo(plan)).error?.code, 'TOOL_PERMISSION');
    });
  }, 20_000);
  it('cancelled calls close owned connection', async () => {
    await withStdio('hang', async (manager, executor) => {
      assert.equal(
        (await manager.connect('fixture', executor, AbortSignal.timeout(15_000))).ok,
        true,
      );
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 30);
      assert.equal((await echo(executor, 'hello', controller.signal)).error?.code, 'CANCELLED');
      assert.equal((await echo(executor)).error?.code, 'MCP_DISCONNECTED');
    });
  }, 20_000);
  it.each(['close', 'natural-exit'])(
    'cleans process descendants on %s',
    async (action) => {
      await withStdio('children', async (manager, executor, cwd) => {
        assert.equal(
          (await manager.connect('fixture', executor, AbortSignal.timeout(15_000))).ok,
          true,
        );
        const pids = JSON.parse(await readFile(join(cwd, 'pids.json'), 'utf8')) as {
          pid: number;
          child: number;
        };
        if (action === 'close') await manager.close();
        else assert.equal((await echo(executor, 'exit')).ok, false);
        await assertDead(pids.pid);
        await assertDead(pids.child);
      });
    },
    20_000,
  );
});

describe('Streamable HTTP MCP', () => {
  it.each(['json', 'sse'] as const)(
    'initializes and calls over %s with GET 405 and explicit auth',
    async (scenario) => {
      const server = await createMCPHTTP(scenario);
      const sandbox = await createSandbox();
      const registry = createBuiltinRegistry();
      const secret = 'Bearer fixture-header-secret';
      const manager = new MCPManager(
        registry,
        {
          fixture: {
            transport: 'http',
            url: server.url,
            headersEnv: { Authorization: 'MCP_AUTH' },
            connectTimeoutMs: 5000,
            callTimeoutMs: 5000,
          },
        },
        { MCP_AUTH: secret },
      );
      const executor = await ToolExecutor.create(registry, {
        root: sandbox.cwd,
        approve: async () => true,
      });
      try {
        const connection = await manager.connect('fixture', executor, AbortSignal.timeout(5000));
        assert.equal(connection.ok, true);
        const result = await echo(executor, 'http hello');
        assert.equal(result.ok, true);
        assert.equal(result.content, 'http hello');
        assert.equal(
          server.requests.filter((request) => request.method === 'tools/call').length,
          1,
        );
        assert(server.requests.every((request) => request.authorization === secret));
      } finally {
        await manager.close();
        await server.close();
        await removeSandbox(sandbox.root);
      }
    },
  );
  it.each(['redirect', 'unauthorized', 'large', 'hang'] as const)(
    'bounds HTTP failures without retries: %s',
    async (scenario) => {
      const server = await createMCPHTTP(scenario);
      const sandbox = await createSandbox();
      const registry = createBuiltinRegistry();
      const manager = new MCPManager(registry, {
        fixture: {
          transport: 'http',
          url: server.url,
          headersEnv: {},
          connectTimeoutMs: 500,
          callTimeoutMs: 100,
        },
      });
      const executor = await ToolExecutor.create(registry, {
        root: sandbox.cwd,
        approve: async () => true,
      });
      try {
        const connection = await manager.connect('fixture', executor, AbortSignal.timeout(5000));
        if (scenario === 'large' || scenario === 'hang') {
          assert.equal(connection.ok, true);
          assert.equal((await echo(executor)).ok, false);
          assert.equal(
            server.requests.filter((request) => request.method === 'tools/call').length,
            1,
          );
        } else {
          assert.equal(connection.ok, false);
          assert(!connection.content.includes('mock-private-response'));
        }
      } finally {
        await manager.close();
        await server.close();
        await removeSandbox(sandbox.root);
      }
    },
  );
});
