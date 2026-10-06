import { AppError } from '../shared/errors.js';
import type { LLMEvent, LLMToolCall } from './types.js';

/** Bounded assembly; no arguments are executable before the stream finishes. */
export class ToolCallBuffer {
  private readonly calls = new Map<number, LLMToolCall>();
  private bytes = 0;

  get byteLength(): number {
    return this.bytes;
  }

  add(delta: Extract<LLMEvent, { type: 'tool_call_delta' }>): void {
    if (!Number.isInteger(delta.index) || delta.index < 0 || delta.index > 127) this.invalid();
    let call = this.calls.get(delta.index);
    if (!call) {
      if (this.calls.size >= 16) this.invalid();
      call = { callId: '', name: '', arguments: '' };
      this.calls.set(delta.index, call);
    }
    if (delta.callId !== undefined) {
      if (!/^[\w.-]{1,128}$/.test(delta.callId) || (call.callId && call.callId !== delta.callId))
        this.invalid();
      call.callId = delta.callId;
    }
    if (delta.name !== undefined) {
      if (typeof delta.name !== 'string') this.invalid();
      call.name += delta.name;
      if (!/^[A-Za-z_][\w.-]{0,127}$/.test(call.name)) this.invalid();
    }
    if (delta.arguments !== undefined) {
      if (typeof delta.arguments !== 'string') this.invalid();
      this.bytes += Buffer.byteLength(delta.arguments);
      if (this.bytes > 256 * 1024) this.invalid();
      call.arguments += delta.arguments;
    }
  }

  complete(): LLMToolCall[] {
    const calls = [...this.calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ ...call }));
    const ids = new Set<string>();
    for (const call of calls) {
      if (!call.callId || !call.name || ids.has(call.callId)) this.invalid();
      ids.add(call.callId);
      try {
        const input: unknown = JSON.parse(call.arguments);
        if (!input || typeof input !== 'object' || Array.isArray(input)) this.invalid();
      } catch {
        this.invalid();
      }
    }
    return calls;
  }

  private invalid(): never {
    throw new AppError('MODEL_PROTOCOL', '模型工具调用编号、名称或参数分片无效；本轮未执行工具。');
  }
}
