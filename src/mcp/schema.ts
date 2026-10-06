import { Ajv } from 'ajv';
import { ToolError } from '../tools/errors.js';

const ajv = new Ajv({ strict: false, validateFormats: false, ownProperties: true });
const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'description',
  'title',
  '$schema',
]);
export const MESSAGE_BYTES = 256 * 1024;

export function boundedJSON(value: unknown, maxBytes = MESSAGE_BYTES): string {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > maxBytes)
    throw new ToolError('MCP_LIMIT', 'MCP 数据超过大小限制。');
  // Bound recursion before downstream validation, cloning or fingerprinting.
  const queue: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  while (queue.length) {
    const entry = queue.pop()!;
    if (++nodes > 10_000 || entry.depth > 32)
      throw new ToolError('MCP_LIMIT', 'MCP 数据过深或节点过多。');
    if (entry.value && typeof entry.value === 'object')
      for (const child of Object.values(entry.value))
        queue.push({ value: child, depth: entry.depth + 1 });
  }
  return text;
}

export function compileSchema(raw: unknown, objectRoot = true) {
  boundedJSON(raw, 32 * 1024);
  let nodes = 0;
  const visit = (schema: unknown, depth: number): void => {
    if (
      ++nodes > 512 ||
      depth > 8 ||
      !schema ||
      typeof schema !== 'object' ||
      Array.isArray(schema)
    )
      throw new ToolError('MCP_SCHEMA', 'MCP Schema 结构超限或不受支持。');
    const value = schema as Record<string, unknown>;
    for (const key of Object.keys(value))
      if (!keywords.has(key)) throw new ToolError('MCP_SCHEMA', 'MCP Schema 包含不支持的关键字。');
    if (value.properties) {
      if (typeof value.properties !== 'object' || Array.isArray(value.properties))
        throw new ToolError('MCP_SCHEMA', 'MCP properties 无效。');
      for (const [key, child] of Object.entries(value.properties)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key))
          throw new ToolError('MCP_SCHEMA', 'MCP 属性名称不受支持。');
        visit(child, depth + 1);
      }
    }
    if (value.items !== undefined) visit(value.items, depth + 1);
    if (value.additionalProperties !== undefined && typeof value.additionalProperties !== 'boolean')
      visit(value.additionalProperties, depth + 1);
    if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length > 64))
      throw new ToolError('MCP_SCHEMA', 'MCP enum 超限。');
  };
  visit(raw, 0);
  const parameters = structuredClone(raw) as Record<string, unknown>;
  if (objectRoot && parameters.type !== 'object')
    throw new ToolError('MCP_SCHEMA', 'MCP 工具参数必须是 object Schema。');
  try {
    const validate = ajv.compile(parameters);
    return {
      parameters,
      valid: (value: unknown) => {
        boundedJSON(value);
        return Boolean(validate(value));
      },
    };
  } catch {
    throw new ToolError('MCP_SCHEMA', 'MCP Schema 无法安全编译。');
  }
}
