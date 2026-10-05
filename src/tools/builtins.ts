import { readFileTool, writeFileTool, editFileTool } from './files.js';
import { globTool, grepTool } from './search.js';
import { bashTool } from './shell.js';
import { ToolRegistry } from './registry.js';

export function createBuiltinRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of [readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool])
    registry.register(tool);
  return registry;
}
