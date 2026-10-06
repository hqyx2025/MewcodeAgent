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
  readonly capabilities = { streaming: true, toolCalling: true };
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
    const writable = request.messages.some(
      (message) =>
        message.role === 'user' && message.content.startsWith('MEWCODE_WORKTREE_SUBAGENT_V1\n'),
    );
    if (writable && this.response === undefined) {
      this.checkCancelled(signal);
      const tool = request.messages.findLast((message) => message.role === 'tool');
      const result = tool
        ? (JSON.parse(tool.content) as {
            name: string;
            ok: boolean;
            error?: { code: string };
            data?: { path?: string };
          })
        : undefined;
      if (!result && request.tools?.some((item) => item.name === 'WriteFile')) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          callId: 'mock-worktree-write',
          name: 'WriteFile',
          arguments: JSON.stringify({
            path: 'mewcode-demo.txt',
            content: '离线工作树隔离演示；此文件只用于验证写入协议。\n',
          }),
        };
        yield { type: 'finish', reason: 'tool_calls' };
      } else if (
        result?.name === 'WriteFile' &&
        (result.ok || result.error?.code === 'FILE_CONFLICT') &&
        request.tools?.some((item) => item.name === 'ReadFile')
      ) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          callId: 'mock-worktree-read',
          name: 'ReadFile',
          arguments: '{"path":"mewcode-demo.txt"}',
        };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            summary:
              result?.ok &&
              request.messages.some(
                (message) =>
                  message.role === 'tool' &&
                  JSON.parse(message.content).error?.code === 'FILE_CONFLICT',
              )
                ? '离线模拟核验已有演示文件，保留既有内容；不解释任意任务。'
                : result?.ok
                  ? '离线模拟在隔离工作树写入演示文件；不解释任意任务。'
                  : '离线模拟未完成写入，请检查权限或工具白名单。',
            evidence:
              result?.name === 'ReadFile' && result.ok
                ? [{ path: 'mewcode-demo.txt', line: 1, note: '实际读取的演示文件' }]
                : [],
          }),
        };
        yield { type: 'finish', reason: 'stop' };
      }
      return;
    }
    const isChild = request.messages.some(
      (message) => message.role === 'user' && message.content.startsWith('MEWCODE_SUBAGENT_V1\n'),
    );
    if (isChild && this.response === undefined) {
      this.checkCancelled(signal);
      const tool = request.messages.findLast((message) => message.role === 'tool');
      if (!tool && request.tools?.some((item) => item.name === 'Glob')) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          callId: 'mock-glob-1',
          name: 'Glob',
          arguments: '{"pattern":"*","maxResults":20}',
        };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        const result = tool
          ? (JSON.parse(tool.content) as { ok: boolean; data?: { paths?: string[] } })
          : undefined;
        const paths = result?.ok ? (result.data?.paths ?? []) : [];
        yield {
          type: 'text_delta',
          text: JSON.stringify({
            summary: '离线模拟仅演示独立子任务与目录列表，不解释源码。',
            evidence: paths.slice(0, 8).map((path) => ({ path, note: 'Glob目录列表' })),
          }),
        };
        yield { type: 'finish', reason: 'stop' };
      }
      return;
    }
    if (request.tools?.length && this.response === undefined) {
      this.checkCancelled(signal);
      const result = request.messages.findLast((message) => message.role === 'tool');
      if (!result) {
        if (request.tools.some((tool) => tool.name === 'Task')) {
          yield {
            type: 'tool_call_delta',
            index: 0,
            callId: 'mock-task-1',
            name: 'Task',
            arguments: JSON.stringify({
              tasks: [{ id: 'mock-directory', goal: '列出项目目录', tools: ['Glob'] }],
            }),
          };
          yield { type: 'finish', reason: 'tool_calls' };
          return;
        }
        yield {
          type: 'tool_call_delta',
          index: 0,
          callId: 'mock-glob-1',
          name: 'Glob',
          arguments: '{"pattern":"*","maxResults":20}',
        };
        yield { type: 'finish', reason: 'tool_calls' };
      } else {
        yield {
          type: 'text_delta',
          text: `离线 Agent 已完成${JSON.parse(result.content).name === 'Task' ? '只读委派' : 'Glob目录查看'}，结果：${result.content}\n此模拟仅演示工具闭环，不解释或修改任意任务。`,
        };
        yield { type: 'finish', reason: 'stop' };
      }
      return;
    }
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
