import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPServerConfig } from './config.js';
import { MESSAGE_BYTES } from './schema.js';

export function httpTransport(
  config: Extract<MCPServerConfig, { transport: 'http' }>,
  env: NodeJS.ProcessEnv,
  lifetime: AbortSignal,
) {
  const headers: Record<string, string> = {};
  for (const [key, name] of Object.entries(config.headersEnv)) {
    const value = env[name];
    if (!value || /[\r\n]/.test(value)) throw new Error('MCP header reference unavailable');
    headers[key] = value;
  }
  let total = 0;
  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers },
    reconnectionOptions: {
      maxRetries: 0,
      initialReconnectionDelay: 1000,
      maxReconnectionDelay: 1000,
      reconnectionDelayGrowFactor: 1,
    },
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input;
      if (new URL(url).href !== new URL(config.url).href) throw new Error('MCP endpoint changed');
      const signals = [lifetime];
      if (init?.signal) signals.push(init.signal);
      const response = await fetch(input, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.any(signals),
      });
      if (!response.body) return response;
      const reader = response.body.getReader();
      let size = 0;
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = await reader.read();
            if (chunk.done) {
              controller.close();
              return;
            }
            size += chunk.value.length;
            total += chunk.value.length;
            if (size > MESSAGE_BYTES || total > 16 * 1024 * 1024)
              throw new Error('MCP HTTP response limit');
            controller.enqueue(chunk.value);
          } catch {
            await reader.cancel().catch(() => {});
            controller.error(new Error('MCP HTTP stream failed'));
          }
        },
        cancel: () => reader.cancel(),
      });
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    },
  });
}
