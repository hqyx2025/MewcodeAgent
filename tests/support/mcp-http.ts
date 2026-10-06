import { createServer } from 'node:http';
import { once } from 'node:events';

export async function createMCPHTTP(
  scenario: 'json' | 'sse' | 'redirect' | 'unauthorized' | 'large' | 'hang' = 'json',
) {
  const requests: { method: string; authorization: string | undefined }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (scenario === 'redirect') {
      response.writeHead(302, { Location: '/steal' });
      response.end();
      return;
    }
    if (scenario === 'unauthorized') {
      response.writeHead(401);
      response.end('mock-private-response');
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(405);
      response.end();
      return;
    }
    const message = JSON.parse(Buffer.concat(chunks).toString()) as {
      id?: number;
      method: string;
      params?: { arguments?: { text?: string } };
    };
    requests.push({ method: message.method, authorization: request.headers.authorization });
    if (message.id === undefined) {
      response.writeHead(202);
      response.end();
      return;
    }
    let result: unknown;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'http-fixture', version: '1' },
      };
    else if (message.method === 'tools/list')
      result = {
        tools: [
          {
            name: 'echo',
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
          },
        ],
      };
    else {
      if (scenario === 'hang') return;
      result = {
        content: [
          {
            type: 'text',
            text: scenario === 'large' ? 'x'.repeat(300 * 1024) : message.params?.arguments?.text,
          },
        ],
      };
    }
    const data = JSON.stringify({ jsonrpc: '2.0', id: message.id, result });
    if (scenario === 'sse') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`event: message\ndata: ${data}\n\n`);
    } else {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(data);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('mock server address');
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    requests,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
