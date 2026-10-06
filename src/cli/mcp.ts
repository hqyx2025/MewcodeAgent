import type { LoadedConfiguration } from '../config/load.js';
import { MCPManager } from '../mcp/manager.js';
import { ToolExecutor } from '../tools/executor.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../shared/errors.js';
import { terminalText } from '../shared/terminal-text.js';
import { permissionRuntime } from './permissions.js';
import { approveTool } from './run.js';

export function listMCP(loaded: LoadedConfiguration): void {
  process.stdout.write(
    terminalText(
      `${JSON.stringify(
        Object.fromEntries(
          Object.entries(loaded.settings.mcp.servers).map(([id, config]) => [
            id,
            {
              transport: config.transport,
              ...(config.transport === 'stdio'
                ? {
                    command: config.command,
                    args: config.args,
                    cwd: config.cwd,
                    env: Object.keys(config.env),
                  }
                : { url: config.url, headersEnv: Object.keys(config.headersEnv) }),
            },
          ]),
        ),
        null,
        2,
      )}\n`,
    ),
  );
}

export async function runMCP(
  loaded: LoadedConfiguration,
  id: string,
  action: 'discover' | 'call',
  tool: string | undefined,
  options: { approveStart?: boolean; approve?: boolean; input?: string; auditFile?: string },
): Promise<void> {
  const registry = createBuiltinRegistry();
  const selected = loaded.settings.mcp.servers[id];
  if (!selected) throw new AppError('CONFIG_INVALID', '选择的 MCP 服务不存在。');
  const providerKey = process.env[loaded.settings.provider.apiKeyEnv ?? 'OPENAI_API_KEY'];
  const manager = new MCPManager(
    registry,
    { [id]: selected },
    process.env,
    providerKey ? [providerKey] : [],
  );
  const runtime = await permissionRuntime(loaded, options.auditFile, false);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  const signal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(loaded.settings.limits.timeoutMs),
  ]);
  try {
    let input: unknown = {};
    try {
      input = JSON.parse(options.input ?? '{}');
    } catch {
      throw new AppError('CONFIG_INVALID', 'MCP input 必须是有效 JSON。');
    }
    const executor = await ToolExecutor.create(registry, {
      root: loaded.cwd,
      mode: loaded.settings.mode,
      rules: runtime.rules,
      audit: runtime.audit,
      approve: (request, approvalSignal) =>
        request.name.startsWith('MCPConnect_')
          ? options.approveStart
            ? Promise.resolve(true)
            : approveTool(request, approvalSignal)
          : options.approve
            ? Promise.resolve(true)
            : approveTool(request, approvalSignal),
    });
    const connected = await manager.connect(id, executor, signal);
    if (!connected.ok) {
      process.stdout.write(`${JSON.stringify(connected)}\n`);
      process.exitCode = 1;
      return;
    }
    if (action === 'discover')
      process.stdout.write(`${JSON.stringify(manager.catalog(id), null, 2)}\n`);
    else {
      const entry = manager
        .catalog(id)
        .find((entry) => entry.name === tool || entry.remoteName === tool);
      if (!entry) throw new AppError('CONFIG_INVALID', '选择的 MCP 工具不存在。');
      const result = await executor.execute(
        { callId: randomUUID(), name: entry.name, input },
        signal,
      );
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    }
  } finally {
    await manager.close();
    process.removeListener('SIGINT', cancel);
    await runtime.close();
  }
}
