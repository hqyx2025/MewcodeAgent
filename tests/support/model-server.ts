import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LLMMessage } from '../../src/providers/types.js';

export interface CapturedRequest {
  url: string | undefined;
  authorization: string | undefined;
  body: {
    model: string;
    messages: LLMMessage[];
    input?: LLMMessage[];
    store?: boolean;
    max_output_tokens?: number;
    stream: boolean;
    stream_options?: { include_usage: boolean };
    max_tokens?: number;
    max_completion_tokens?: number;
  };
  closed: boolean;
}

export async function modelServer(
  handler: (
    response: ServerResponse,
    record: CapturedRequest,
    count: number,
  ) => void | Promise<void>,
) {
  const requests: CapturedRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      let data = '';
      for await (const chunk of request) data += String(chunk);
      const record: CapturedRequest = {
        url: request.url,
        authorization: request.headers.authorization,
        body: JSON.parse(data) as CapturedRequest['body'],
        closed: false,
      };
      requests.push(record);
      response.on('close', () => {
        record.closed = true;
      });
      await handler(response, record, requests.length);
    })().catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Model server did not bind');
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

export function chunk(text: string, reason: string | null = null) {
  return {
    id: 'test-response',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { content: text }, finish_reason: reason }],
  };
}

export function sse(response: ServerResponse, chunks: unknown[]): void {
  response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
  for (const data of chunks) response.write(`data: ${JSON.stringify(data)}\n\n`);
  response.end('data: [DONE]\n\n');
}
