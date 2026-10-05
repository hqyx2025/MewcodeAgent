import { z } from 'zod';
import { ToolError } from './errors.js';
import type { ToolDefinition } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): this {
    if (this.tools.has(tool.name)) throw new ToolError('TOOL_DUPLICATE', '工具名称重复。');
    this.tools.set(tool.name, Object.freeze({ ...tool }));
    return this;
  }

  get(name: string): ToolDefinition {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolError('TOOL_NOT_FOUND', '工具不存在。');
    return tool;
  }

  definitions() {
    return [...this.tools.values()].map((tool) => ({
      name: tool.name,
      description: tool.description,
      effect: tool.effect,
      parameters: z.toJSONSchema(tool.schema, { target: 'draft-7', io: 'input' }),
    }));
  }
}
