import { describe, expect, it } from 'vitest';
import { compileSchema, boundedJSON } from '../../src/mcp/schema.js';
import { mcpServerSchema } from '../../src/mcp/config.js';
import { configPatchSchema, defaultSettings, mergeSettings } from '../../src/config/schema.js';
import { mcpToolName } from '../../src/mcp/manager.js';

describe('MCP bounded configuration and schema', () => {
  it('validates object arguments and rejects unsupported schema keywords', () => {
    const schema = compileSchema({
      type: 'object',
      properties: { count: { type: 'integer', minimum: 1 } },
      required: ['count'],
      additionalProperties: false,
    });
    expect(schema.valid({ count: 1 })).toBe(true);
    expect(schema.valid({ count: 0 })).toBe(false);
    expect(schema.valid({ count: 1, extra: true })).toBe(false);
    for (const key of ['$ref', 'pattern', 'format', 'anyOf', 'oneOf'])
      expect(() => compileSchema({ type: 'object', [key]: 'invalid' })).toThrow();
    expect(() => compileSchema({ type: 'string' })).toThrow();
    expect(() =>
      compileSchema({ type: 'object', properties: JSON.parse('{"__proto__":{"type":"string"}}') }),
    ).toThrow();
  });
  it('bounds recursive data and enum values', () => {
    expect(() => boundedJSON({ x: 'x'.repeat(300 * 1024) })).toThrow();
    let deep: unknown = {};
    for (let i = 0; i < 40; i++) deep = { deep };
    expect(() => boundedJSON(deep)).toThrow();
    expect(() =>
      compileSchema({ type: 'object', enum: Array.from({ length: 65 }, (_, i) => i) }),
    ).toThrow();
  });
  it('replaces complete server definitions and keeps other server IDs', () => {
    const first = configPatchSchema.parse({
      mcp: {
        servers: {
          local: {
            transport: 'stdio',
            command: process.execPath,
            args: ['first'],
            env: { TOKEN: 'MCP_TOKEN' },
          },
          remote: { transport: 'http', url: 'https://example.test/mcp' },
        },
      },
    });
    const second = configPatchSchema.parse({
      mcp: { servers: { local: { transport: 'http', url: 'https://example.test/new' } } },
    });
    const merged = mergeSettings(mergeSettings(defaultSettings, first), second);
    expect(merged.mcp.servers.local?.transport).toBe('http');
    expect(merged.mcp.servers.local).not.toHaveProperty('env');
    expect(merged.mcp.servers.remote).toBeDefined();
    for (const url of [
      'https://user:secret@example.test/',
      'https://example.test/?token=x',
      'file:///tmp/a',
    ])
      expect(mcpServerSchema.safeParse({ transport: 'http', url }).success).toBe(false);
    expect(
      mcpServerSchema.safeParse({
        transport: 'http',
        url: 'https://example.test/',
        headersEnv: { Host: 'HOST_VALUE' },
      }).success,
    ).toBe(false);
    expect(mcpServerSchema.safeParse({ transport: 'stdio', command: 'node' }).success).toBe(false);
  });
  it('namespaces arbitrary remote names without collisions or oversized names', () => {
    expect(mcpToolName('a'.repeat(32), 'echo!'.repeat(100)).length).toBeLessThanOrEqual(64);
    expect(mcpToolName('first', 'same')).not.toBe(mcpToolName('second', 'same'));
    expect(mcpToolName('first', 'same!')).not.toBe(mcpToolName('first', 'same?'));
  });
});
