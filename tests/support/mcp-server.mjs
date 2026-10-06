import readline from 'node:readline';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const scenario = process.argv[2] ?? 'normal';
if (scenario === 'children') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  writeFileSync(process.argv[3], JSON.stringify({ pid: process.pid, child: child.pid }));
}
const tools = [
  {
    name: 'echo',
    description: 'echo input',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1, maxLength: 100 } },
      required: ['text'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'readOnly',
    description: 'pretends read only',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
const send = (id, result, error) =>
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n',
  );
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize')
    send(message.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'fixture', version: '1' },
    });
  else if (message.method === 'notifications/initialized') return;
  else if (message.method === 'tools/list') {
    if (scenario === 'bad-schema')
      send(message.id, {
        tools: [
          {
            ...tools[0],
            inputSchema: {
              type: 'object',
              properties: { text: { type: 'string', pattern: '.*' } },
            },
          },
        ],
      });
    else if (message.params?.cursor)
      send(message.id, { tools: [scenario === 'duplicate' ? tools[0] : tools[1]] });
    else send(message.id, { tools: [tools[0]], nextCursor: 'page-2' });
  } else if (message.method === 'tools/call') {
    if (scenario === 'hang') return;
    if (scenario === 'disconnect') {
      process.exit(0);
    }
    if (scenario === 'stale') {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }) + '\n',
      );
      return;
    }
    if (scenario === 'bad-result') {
      send(message.id, {
        content: [{ type: 'text', text: 'x' }],
        structuredContent: { text: 123 },
      });
      return;
    }
    if (scenario === 'malformed') {
      send(message.id, { content: 'wrong' });
      return;
    }
    if (scenario === 'large') {
      send(message.id, { content: [{ type: 'text', text: 'x'.repeat(300 * 1024) }] });
      return;
    }
    if (scenario === 'env') {
      const text = JSON.stringify({
        explicit: process.env.MCP_EXPLICIT,
        inherited: process.env.MCP_NOT_ALLOWED,
        nodeOptions: process.env.NODE_OPTIONS,
      });
      process.stderr.write(process.env.MCP_EXPLICIT ?? '');
      send(message.id, { content: [{ type: 'text', text }], structuredContent: { text } });
      return;
    }
    if (scenario === 'children' && message.params.arguments.text === 'exit') {
      process.exit(0);
    }
    if (message.params.name === 'echo')
      send(message.id, {
        content: [{ type: 'text', text: message.params.arguments.text }],
        structuredContent: { text: message.params.arguments.text },
      });
    else if (message.params.name === 'readOnly')
      send(message.id, { isError: true, content: [{ type: 'text', text: 'fixture failure' }] });
    else send(message.id, {}, { code: -32602, message: 'unknown' });
  }
});
