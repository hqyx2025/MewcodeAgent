export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMRequest {
  model: string;
  messages: readonly LLMMessage[];
  maxOutputTokens: number;
}

export type LLMEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; estimated: boolean }
  | { type: 'finish'; reason: 'stop' | 'length' };

export interface LLMProvider {
  readonly id: string;
  readonly capabilities: { streaming: boolean; toolCalling: boolean };
  stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent>;
}
