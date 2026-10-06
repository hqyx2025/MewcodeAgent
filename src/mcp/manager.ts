import { createHash, randomUUID } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ToolError, checkCancelled } from '../tools/errors.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolRegistry } from '../tools/registry.js';
import { redactInstruction } from '../shared/redact.js';
import { mcpServerSchema, referencedValues } from './config.js';
import type { MCPServerConfig } from './config.js';
import { boundedJSON, compileSchema } from './schema.js';
import { OwnedStdioTransport, stdioEnvironment } from './stdio.js';
import { httpTransport } from './http.js';

interface Connection {
  client: Client;
  transport: Transport;
  lifetime: AbortController;
  generation: string;
  ready: boolean;
  stale: boolean;
  catalog: { name: string; remoteName: string; description: string }[];
}

export function mcpToolName(server: string, remote: string): string {
  return `MCP_${server}_${createHash('sha256').update(remote).digest('hex').slice(0, 20)}`;
}

/** One manager owns one task's snapshot. Re-discovery requires a new task/manager. */
export class MCPManager {
  private readonly connections = new Map<string, Connection>();
  private readonly secrets: string[];
  private readonly configs: Record<string, MCPServerConfig>;
  private readonly env: NodeJS.ProcessEnv;
  private closed = false;
  constructor(
    private readonly registry: ToolRegistry,
    configs: Record<string, MCPServerConfig>,
    env: NodeJS.ProcessEnv = process.env,
    sensitiveValues: readonly string[] = [],
  ) {
    this.env = { ...env };
    this.configs = Object.fromEntries(
      Object.entries(configs).map(([id, config]) => {
        if (!/^[a-z][a-z0-9-]{0,31}$/.test(id))
          throw new ToolError('MCP_CONFIG', 'MCP 服务 ID 无效。');
        return [id, mcpServerSchema.parse(config)];
      }),
    );
    if (Object.keys(this.configs).length > 8) throw new ToolError('MCP_LIMIT', 'MCP 服务最多8个。');
    this.secrets = [
      ...sensitiveValues,
      ...Object.values(this.configs).flatMap((config) => referencedValues(config, this.env)),
    ];
    for (const [id, config] of Object.entries(this.configs)) {
      registry.register({
        name: `MCPConnect_${id}`,
        description: '显式连接 MCP 服务',
        effect: 'external',
        hidden: true,
        schema: z.strictObject({}),
        prepare: async (_input, context) => {
          if (this.closed || this.connections.has(id))
            throw new ToolError('MCP_STATE', 'MCP 服务已连接或管理器已关闭；重新发现需新任务。');
          const cwd =
            config.transport === 'stdio'
              ? await context.paths.resolve(config.cwd)
              : context.paths.root;
          if (!(await lstat(cwd)).isDirectory())
            throw new ToolError('MCP_CONFIG', 'MCP cwd 必须是项目内目录。');
          const details =
            config.transport === 'stdio'
              ? { command: config.command, args: config.args, cwd, envReferences: config.env }
              : { url: config.url, headerReferences: config.headersEnv };
          return {
            target: cwd,
            preview: this.safe(
              `连接外部 MCP 服务 ${id}（${config.transport}）；拥有主机执行/网络能力。\n${JSON.stringify(details)}`,
            ),
            authorizationKey: createHash('sha256')
              .update(boundedJSON({ config, credentials: referencedValues(config, this.env) }))
              .digest('hex'),
            run: async () => {
              if (config.transport === 'stdio') await context.paths.resolve(config.cwd);
              await this.open(id, config, cwd, context.signal);
              return {
                content: `MCP ${id} 已连接；发现 ${this.connections.get(id)?.catalog.length ?? 0} 个工具。`,
              };
            },
          };
        },
      });
    }
  }
  private safe(text: string): string {
    let safe = redactInstruction(text, this.secrets);
    for (const secret of this.secrets)
      if (secret) {
        safe = safe.replaceAll(secret, '[REDACTED]');
        safe = safe.replaceAll(JSON.stringify(secret).slice(1, -1), '[REDACTED]');
      }
    return safe;
  }
  private safeData(value: unknown): unknown {
    if (typeof value === 'string') return this.safe(value);
    if (Array.isArray(value)) return value.map((item) => this.safeData(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [this.safe(key), this.safeData(item)]),
      );
    return value;
  }
  catalog(id: string) {
    return structuredClone(this.connections.get(id)?.catalog ?? []);
  }
  async connect(id: string, executor: ToolExecutor, signal: AbortSignal) {
    if (!this.configs[id]) throw new ToolError('MCP_CONFIG', '选择的 MCP 服务不存在。');
    return executor.execute({ callId: randomUUID(), name: `MCPConnect_${id}`, input: {} }, signal);
  }
  private async open(
    id: string,
    config: MCPServerConfig,
    cwd: string,
    signal: AbortSignal,
  ): Promise<void> {
    checkCancelled(signal);
    const lifetime = new AbortController();
    const timeout = AbortSignal.timeout(config.connectTimeoutMs);
    const combined = AbortSignal.any([signal, timeout, lifetime.signal]);
    let transport: Transport;
    try {
      transport = (config.transport === 'stdio'
        ? new OwnedStdioTransport({
            command: config.command,
            args: config.args,
            cwd,
            env: stdioEnvironment(config.env, this.env),
          })
        : httpTransport(config, this.env, lifetime.signal)) as unknown as Transport;
    } catch {
      throw new ToolError('MCP_CONFIG', 'MCP 环境变量引用缺失或传输配置无效。');
    }
    const client = new Client({ name: 'mewcode-agent', version: '0.1.0' }, { capabilities: {} });
    const connection: Connection = {
      client,
      transport,
      lifetime,
      generation: randomUUID(),
      ready: false,
      stale: false,
      catalog: [],
    };
    this.connections.set(id, connection);
    const stop = () => {
      connection.ready = false;
      lifetime.abort();
      void transport.close().catch(() => {});
    };
    client.onclose = () => {
      connection.ready = false;
    };
    client.onerror = stop;
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      connection.stale = true;
      stop();
    });
    combined.addEventListener('abort', stop, { once: true });
    try {
      await client.connect(transport, { signal: combined, timeout: config.connectTimeoutMs });
      const discovered = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      let bytes = 0;
      const cursors = new Set<string>();
      for (let page = 0; page < 8; page++) {
        const result = await client.request(
          { method: 'tools/list', params: cursor ? { cursor } : {} },
          ListToolsResultSchema,
          { signal: combined, timeout: config.connectTimeoutMs },
        );
        bytes += Buffer.byteLength(boundedJSON(result));
        if (bytes > 512 * 1024) throw new ToolError('MCP_LIMIT', 'MCP 工具目录超限。');
        for (const tool of result.tools) {
          if (
            seen.has(tool.name) ||
            seen.size >= 64 ||
            tool.name.length > 256 ||
            tool.execution?.taskSupport === 'required'
          )
            throw new ToolError('MCP_SCHEMA', 'MCP 工具名称重复、超限或需要未支持的 task 协议。');
          seen.add(tool.name);
          if (this.safe(boundedJSON(tool.inputSchema)) !== boundedJSON(tool.inputSchema))
            throw new ToolError('MCP_SCHEMA', 'MCP Schema 含凭据，未注册。');
          const schema = compileSchema(tool.inputSchema);
          const output = tool.outputSchema ? compileSchema(tool.outputSchema, false) : undefined;
          const name = mcpToolName(id, tool.name);
          const description = this.safe(
            `外部 MCP 工具 ${id}：${tool.description ?? tool.name}`,
          ).slice(0, 2048);
          const digest = createHash('sha256')
            .update(boundedJSON({ input: schema.parameters, output: tool.outputSchema }))
            .digest('hex');
          discovered.push({ name, remoteName: tool.name, description, schema, output, digest });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (cursors.has(cursor) || page === 7)
          throw new ToolError('MCP_LIMIT', 'MCP 分页循环或超过8页。');
        cursors.add(cursor);
      }
      checkCancelled(combined);
      if (connection.stale || this.closed)
        throw new ToolError('MCP_STATE', 'MCP 工具目录已变化或连接已关闭。');
      for (const tool of discovered) {
        this.registry.register({
          name: tool.name,
          description: tool.description,
          effect: 'external',
          parameters: tool.schema.parameters,
          schema: z.unknown().superRefine((input, ctx) => {
            if (
              !tool.schema.valid(input) ||
              boundedJSON(this.safeData(input)) !== boundedJSON(input)
            )
              ctx.addIssue({ code: 'custom', message: 'MCP 参数无效或含凭据' });
          }),
          prepare: async (input, context) => {
            const check = () => {
              if (!connection.ready || connection.stale || this.closed)
                throw new ToolError(
                  'MCP_DISCONNECTED',
                  'MCP 已断连或工具目录已变化；请在新任务中重新连接。',
                );
            };
            check();
            return {
              target: context.paths.root,
              preview: `调用外部 MCP ${id}：${this.safe(tool.remoteName)}；服务端只读声明不改变权限。`,
              authorizationKey: `${connection.generation}:${tool.digest}`,
              run: async () => {
                check();
                const deadline = AbortSignal.timeout(config.callTimeoutMs);
                const callSignal = AbortSignal.any([context.signal, deadline, lifetime.signal]);
                callSignal.addEventListener('abort', stop, { once: true });
                try {
                  const result = await client.request(
                    {
                      method: 'tools/call',
                      params: {
                        name: tool.remoteName,
                        arguments: input as Record<string, unknown>,
                      },
                    },
                    CallToolResultSchema,
                    { signal: callSignal, timeout: config.callTimeoutMs },
                  );
                  boundedJSON(result);
                  if (
                    tool.output &&
                    !result.isError &&
                    (!result.structuredContent || !tool.output.valid(result.structuredContent))
                  )
                    throw new ToolError('MCP_RESULT', 'MCP structuredContent 不符合输出 Schema。');
                  const safeResult = this.safeData(result) as typeof result;
                  const text = safeResult.content
                    .filter((item) => item.type === 'text')
                    .map((item) => item.text)
                    .join('\n');
                  return {
                    content: text || 'MCP 返回非文本内容；未自动读取媒体或资源。',
                    ...(safeResult.structuredContent ? { data: safeResult.structuredContent } : {}),
                    ...(result.isError
                      ? { error: { code: 'MCP_TOOL_ERROR', message: 'MCP 服务报告工具执行失败。' } }
                      : {}),
                  };
                } catch (error) {
                  stop();
                  await transport.close().catch(() => {});
                  if (error instanceof ToolError) throw error;
                  throw new ToolError(
                    'MCP_CALL_FAILED',
                    'MCP 调用超时、断连或响应无效；未自动重试，操作可能已执行。',
                  );
                } finally {
                  callSignal.removeEventListener('abort', stop);
                }
              },
            };
          },
        });
      }
      connection.catalog = discovered.map(({ name, remoteName, description }) => ({
        name,
        remoteName: this.safe(remoteName),
        description,
      }));
      connection.ready = true;
    } catch (error) {
      stop();
      await transport.close().catch(() => {});
      if (error instanceof ToolError) throw error;
      throw new ToolError(
        'MCP_CONNECT_FAILED',
        'MCP 初始化或工具发现失败；检查服务配置，未输出服务日志或响应正文。',
      );
    } finally {
      combined.removeEventListener('abort', stop);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled(
      [...this.connections.values()].map(async (connection) => {
        connection.ready = false;
        connection.lifetime.abort();
        await connection.transport.close();
      }),
    );
  }
}
