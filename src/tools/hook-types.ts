import type { HookDecision, HookEventName } from './hook-schema.js';
import type { ToolCall, ToolMode, ToolResult } from './types.js';

export interface HookEvent {
  agentId?: string;
  version: 1;
  event: HookEventName;
  eventId: string;
  sessionId: string;
  mode: ToolMode;
  tool?: ToolCall;
  result?: { ok: boolean; errorCode?: string };
  reason?: string;
}

export interface HookHost {
  mode: ToolMode;
  root: string;
  allowsScript(path: string): boolean;
  executeScript(invocationId: string, signal: AbortSignal): Promise<ToolResult>;
}

export type HookHandler = (
  event: Readonly<HookEvent>,
  host: HookHost,
  signal: AbortSignal,
) => Promise<HookDecision>;

export interface HookAudit {
  agentId?: string;
  version: 1;
  sequence: number;
  timestamp: string;
  event: HookEventName;
  eventId: string;
  sessionId: string;
  hookId: string;
  mode: ToolMode;
  outcome: 'continue' | 'block' | 'error';
  durationMs: number;
  code?: string;
}
