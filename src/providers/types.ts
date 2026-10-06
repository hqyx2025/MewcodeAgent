export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCalls?: readonly LLMToolCall[];
  callId?: string;
  continuation?: { provider: 'responses' | 'anthropic'; items: readonly unknown[] };
}

export interface LLMToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export interface LLMTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface LLMRequest {
  model: string;
  messages: readonly LLMMessage[];
  maxOutputTokens: number;
  tools?: readonly LLMTool[];
}

export type LLMEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; estimated: boolean }
  | { type: 'tool_call_delta'; index: number; callId?: string; name?: string; arguments?: string }
  | { type: 'continuation'; provider: 'responses' | 'anthropic'; items: readonly unknown[] }
  | { type: 'finish'; reason: 'stop' | 'length' | 'tool_calls' };

export interface LLMProvider {
  readonly id: string;
  readonly capabilities: { streaming: boolean; toolCalling: boolean };
  stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent>;
}
