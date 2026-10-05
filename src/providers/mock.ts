import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../shared/errors.js';
import type { LLMEvent, LLMProvider, LLMRequest } from './types.js';

export interface MockOptions {
  delayMs?: number;
  chunkSize?: number;
  response?: string;
}

export class MockProvider implements LLMProvider {
  readonly id = 'mock';
  readonly capabilities = { streaming: true, toolCalling: false };
  private readonly delayMs: number;
  private readonly chunkSize: number;
  private readonly response: string | undefined;

  constructor(options: MockOptions = {}) {
    this.delayMs = options.delayMs ?? 20;
    this.chunkSize = options.chunkSize ?? 12;
    this.response = options.response;
    if (!Number.isInteger(this.delayMs) || this.delayMs < 0) {
      throw new RangeError('delayMs must be a non-negative integer');
    }
    if (!Number.isInteger(this.chunkSize) || this.chunkSize < 1) {
      throw new RangeError('chunkSize must be a positive integer');
    }
  }

  async *stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    const prompt = request.messages.findLast((message) => message.role === 'user')?.content ?? '';
    const response =
      this.response ??
      `已收到任务：“${prompt}”。MewCode Agent M02 流式对话已就绪。当前使用离线模拟，不会访问真实模型或修改文件。`;
    const characters = Array.from(response);

    for (let offset = 0; offset < characters.length; offset += this.chunkSize) {
      this.checkCancelled(signal);
      if (this.delayMs > 0) {
        try {
          await delay(this.delayMs, undefined, { signal });
        } catch (error) {
          if (signal.aborted) {
            throw new AppError('CANCELLED', '演示已取消。', { cause: error });
          }
          throw error;
        }
      }
      this.checkCancelled(signal);
      yield {
        type: 'text_delta',
        text: characters.slice(offset, offset + this.chunkSize).join(''),
      };
    }

    this.checkCancelled(signal);
    yield {
      type: 'usage',
      inputTokens: Math.ceil(
        request.messages.reduce((size, message) => size + Array.from(message.content).length, 0) /
          4,
      ),
      outputTokens: Math.ceil(characters.length / 4),
      estimated: true,
    };
    yield { type: 'finish', reason: 'stop' };
  }

  private checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new AppError('CANCELLED', '演示已取消。');
    }
  }
}
