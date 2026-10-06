import type { z } from 'zod';
import type { ProjectPaths } from '../security/paths.js';

export type ToolEffect = 'read' | 'write' | 'shell';
export type ToolMode = 'plan' | 'default' | 'accept-edits';

export interface ToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface ToolPayload {
  content: string;
  data?: unknown;
  truncated?: boolean;
  error?: { code: string; message: string };
}

export interface ToolResult extends ToolPayload {
  callId: string;
  name: string;
  ok: boolean;
  error?: { code: string; message: string };
}

export interface ApprovalRequest {
  readonly callId: string;
  readonly name: string;
  readonly effect: ToolEffect;
  readonly input: unknown;
  readonly target: string;
  readonly preview: string;
  readonly cwd: string;
  readonly shell: Readonly<ToolContext['shell']>;
  readonly mode: ToolMode;
  readonly fingerprint: string;
  readonly scope: 'exact-input';
}

export type ApprovalAnswer = boolean | { allow: boolean; scope: 'once' | 'session' };

export interface ToolContext {
  paths: ProjectPaths;
  signal: AbortSignal;
  shell: { kind: 'powershell' | 'bash'; executable: string };
  rgExecutable: string;
}

export interface PreparedTool {
  target: string;
  preview: string;
  run(): Promise<ToolPayload>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  effect: ToolEffect;
  schema: z.ZodType;
  prepare(input: unknown, context: ToolContext): Promise<PreparedTool>;
}

export function defineTool<S extends z.ZodType>(definition: {
  name: string;
  description: string;
  effect: ToolEffect;
  schema: S;
  prepare(input: z.output<S>, context: ToolContext): Promise<PreparedTool>;
}): ToolDefinition {
  return {
    ...definition,
    prepare: (input, context) => definition.prepare(definition.schema.parse(input), context),
  };
}
