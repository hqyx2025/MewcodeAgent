export interface RunIdentity {
  sessionId: string;
  runId: string;
}

export type AgentEvent = RunIdentity &
  (
    | { type: 'text_delta'; text: string }
    | { type: 'usage_updated'; inputTokens: number; outputTokens: number; estimated: boolean }
    | { type: 'run_finished'; reason: 'stop' | 'length' | 'cancelled' | 'error' }
  );
