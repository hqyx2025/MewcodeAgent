export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

export function checkCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new ToolError('CANCELLED', '工具调用已取消。');
}

export function byteLimit(text: string, limit: number): string {
  const buffer = Buffer.from(text);
  if (buffer.length <= limit) return text;
  let end = limit;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}
