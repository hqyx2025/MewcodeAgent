export type ErrorCode =
  | 'CONFIG_INVALID'
  | 'CONFIG_READ'
  | 'INVALID_WORKDIR'
  | 'CANCELLED'
  | 'MODEL_MISSING_KEY'
  | 'MODEL_AUTH'
  | 'MODEL_RATE_LIMIT'
  | 'MODEL_TIMEOUT'
  | 'MODEL_NETWORK'
  | 'MODEL_SERVER'
  | 'MODEL_PROTOCOL'
  | 'MODEL_REJECTED'
  | 'MODEL_UNSUPPORTED'
  | 'INVALID_PROMPT'
  | 'CONTEXT_LIMIT'
  | 'INSTRUCTIONS_LIMIT'
  | 'AUDIT_FAILED'
  | 'SESSION_INVALID'
  | 'SESSION_IO'
  | 'SESSION_LOCKED'
  | 'MEMORY_INVALID'
  | 'MEMORY_CONFLICT'
  | 'MEMORY_LOCKED'
  | 'MEMORY_IO'
  | 'COMMAND_INVALID'
  | 'COMMAND_IO'
  | 'SKILL_INVALID'
  | 'SKILL_LIMIT'
  | 'BUSY';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AppError';
  }
}
