import Anthropic from '@anthropic-ai/sdk';
import { setTimeout as delay } from 'node:timers/promises';
import { AppError } from '../shared/errors.js';
import { ToolCallBuffer } from './tool-calls.js';
import type { LLMEvent, LLMProvider, LLMRequest } from './types.js';

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly capabilities = { streaming: true, toolCalling: true };
  private readonly client: Anthropic;

  constructor(options: { apiKey: string; timeoutMs: number; baseUrl?: string }) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: 0,
      ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
    });
  }

  async *stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    for (let attempt = 0; attempt < 2; attempt++) {
      let started = false;
      try {
        yield* this.events(request, signal, () => {
          started = true;
        });
        return;
      } catch (error) {
        const safe = this.normalize(error, signal);
        if (
          !attempt &&
          !started &&
          ['MODEL_NETWORK', 'MODEL_SERVER', 'MODEL_RATE_LIMIT'].includes(safe.code) &&
          !signal.aborted
        ) {
          await delay(200, undefined, { signal }).catch(() => {
            throw new AppError('CANCELLED', '请求已取消。');
          });
        } else throw safe;
      }
    }
  }

  private async *events(
    request: LLMRequest,
    signal: AbortSignal,
    markStarted: () => void,
  ): AsyncIterable<LLMEvent> {
    const messages: Anthropic.MessageParam[] = [];
    for (const message of request.messages) {
      if (message.role === 'system') continue;
      let content: Anthropic.ContentBlockParam[];
      if (message.role === 'tool') {
        if (!message.callId) throw new AppError('MODEL_PROTOCOL', '工具结果缺少调用编号。');
        content = [{ type: 'tool_result', tool_use_id: message.callId, content: message.content }];
      } else if (message.continuation?.provider === 'anthropic')
        content = structuredClone(message.continuation.items) as Anthropic.ContentBlockParam[];
      else {
        content = message.content ? [{ type: 'text', text: message.content }] : [];
        for (const call of message.toolCalls ?? [])
          content.push({
            type: 'tool_use',
            id: call.callId,
            name: call.name,
            input: JSON.parse(call.arguments) as unknown,
          });
      }
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const previous = messages.at(-1);
      if (previous?.role === role && Array.isArray(previous.content))
        previous.content.push(...content);
      else messages.push({ role, content });
    }
    const stream = await this.client.messages.create(
      {
        model: request.model,
        max_tokens: request.maxOutputTokens,
        system: request.messages
          .filter((m) => m.role === 'system')
          .map((m) => m.content)
          .join('\n\n'),
        messages,
        stream: true,
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
      },
      { signal },
    );
    const buffer = new ToolCallBuffer();
    const blocks = new Map<number, Anthropic.ContentBlock>();
    const closed = new Set<number>();
    const jsonBlocks = new Set<number>();
    let inputTokens = 0;
    let outputTokens = 0;
    let reason: Anthropic.StopReason | null = null;
    let stopped = false;
    let messageStarted = false;
    let eventCount = 0;
    try {
      for await (const event of stream) {
        markStarted();
        if (++eventCount > 10_000) throw new AppError('MODEL_PROTOCOL', '模型流事件达到上限。');
        if (signal.aborted) throw new AppError('CANCELLED', '请求已取消。');
        if (stopped) throw new AppError('MODEL_PROTOCOL', '模型在结束后继续输出。');
        if (event.type === 'message_start') {
          if (messageStarted) throw new AppError('MODEL_PROTOCOL', '重复的模型消息起始事件。');
          messageStarted = true;
          inputTokens =
            event.message.usage.input_tokens +
            (event.message.usage.cache_creation_input_tokens ?? 0) +
            (event.message.usage.cache_read_input_tokens ?? 0);
          outputTokens = event.message.usage.output_tokens;
        } else if (event.type === 'content_block_start') {
          if (!messageStarted || reason)
            throw new AppError('MODEL_PROTOCOL', '模型内容块顺序无效。');
          if (
            blocks.has(event.index) ||
            blocks.size >= 32 ||
            !Number.isInteger(event.index) ||
            event.index < 0 ||
            event.index > 127
          )
            throw new AppError('MODEL_PROTOCOL', '模型内容块索引无效。');
          const block = structuredClone(event.content_block);
          if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(block.type))
            throw new AppError('MODEL_UNSUPPORTED', '不支持服务端工具或外部内容块。');
          blocks.set(event.index, block);
          if (block.type === 'tool_use') {
            if (!request.tools?.length)
              throw new AppError('MODEL_UNSUPPORTED', '当前请求未启用模型工具调用。');
            const delta: Extract<LLMEvent, { type: 'tool_call_delta' }> = {
              type: 'tool_call_delta',
              index: event.index,
              callId: block.id,
              name: block.name,
            };
            buffer.add(delta);
            yield delta;
          } else if (block.type === 'text' && block.text)
            yield { type: 'text_delta', text: block.text };
        } else if (event.type === 'content_block_delta') {
          const block = blocks.get(event.index);
          if (!block || closed.has(event.index))
            throw new AppError('MODEL_PROTOCOL', '模型分片缺少有效内容块。');
          const delta = event.delta;
          if (delta.type === 'text_delta' && block.type === 'text') {
            block.text += delta.text;
            yield { type: 'text_delta', text: delta.text };
          } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
            jsonBlocks.add(event.index);
            const callDelta: Extract<LLMEvent, { type: 'tool_call_delta' }> = {
              type: 'tool_call_delta',
              index: event.index,
              arguments: delta.partial_json,
            };
            buffer.add(callDelta);
            yield callDelta;
          } else if (delta.type === 'thinking_delta' && block.type === 'thinking')
            block.thinking += delta.thinking;
          else if (delta.type === 'signature_delta' && block.type === 'thinking')
            block.signature += delta.signature;
          else throw new AppError('MODEL_PROTOCOL', '模型分片类型与内容块不一致。');
          if (JSON.stringify([...blocks.values()]).length > 200_000)
            throw new AppError('CONTEXT_LIMIT', '模型内容块超过上限。');
        } else if (event.type === 'content_block_stop') {
          if (!blocks.has(event.index) || closed.has(event.index))
            throw new AppError('MODEL_PROTOCOL', '模型内容块结束编号无效。');
          closed.add(event.index);
          const block = blocks.get(event.index)!;
          if (block.type === 'tool_use' && !jsonBlocks.has(event.index)) {
            const delta: Extract<LLMEvent, { type: 'tool_call_delta' }> = {
              type: 'tool_call_delta',
              index: event.index,
              arguments: JSON.stringify(block.input),
            };
            buffer.add(delta);
            yield delta;
          }
        } else if (event.type === 'message_delta') {
          reason = event.delta.stop_reason;
          outputTokens = event.usage.output_tokens;
        } else if (event.type === 'message_stop') stopped = true;
      }
    } finally {
      stream.controller.abort();
    }
    if (signal.aborted) throw new AppError('CANCELLED', '请求已取消。');
    if (!messageStarted || !stopped || !reason || blocks.size !== closed.size)
      throw new AppError('MODEL_PROTOCOL', '模型流缺少完整结束标记。');
    if (![inputTokens, outputTokens].every((n) => Number.isSafeInteger(n) && n >= 0))
      throw new AppError('MODEL_PROTOCOL', '模型 token 用量无效。');
    yield { type: 'usage', inputTokens, outputTokens, estimated: false };
    if (reason === 'max_tokens') {
      yield { type: 'finish', reason: 'length' };
      return;
    }
    if (!['end_turn', 'stop_sequence', 'tool_use'].includes(reason))
      throw new AppError('MODEL_REJECTED', '模型未能正常完成响应。');
    const calls = buffer.complete();
    if ((reason === 'tool_use') !== calls.length > 0)
      throw new AppError('MODEL_PROTOCOL', '工具调用与结束类型不一致。');
    for (const block of blocks.values())
      if (block.type === 'tool_use')
        block.input = JSON.parse(
          calls.find((call) => call.callId === block.id)!.arguments,
        ) as unknown;
    if (request.tools?.length)
      yield {
        type: 'continuation',
        provider: 'anthropic',
        items: [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block),
      };
    yield { type: 'finish', reason: calls.length ? 'tool_calls' : 'stop' };
  }

  private normalize(error: unknown, signal: AbortSignal): AppError {
    if (signal.aborted) return new AppError('CANCELLED', '请求已取消。');
    if (error instanceof AppError) return error;
    if (error instanceof Anthropic.APIConnectionTimeoutError)
      return new AppError('MODEL_TIMEOUT', '模型服务响应超时。');
    if (error instanceof Anthropic.APIConnectionError || error instanceof TypeError)
      return new AppError('MODEL_NETWORK', '模型连接失败或中断。');
    if (error instanceof Anthropic.APIError) {
      if (error.status === 401 || error.status === 403)
        return new AppError('MODEL_AUTH', '模型鉴权失败。');
      if (error.status === 429) return new AppError('MODEL_RATE_LIMIT', '模型服务限流或配额不足。');
      if (error.status !== undefined && error.status >= 500)
        return new AppError('MODEL_SERVER', '模型服务暂时不可用。');
    }
    return new AppError('MODEL_PROTOCOL', '模型请求或流式响应格式无效。');
  }
}
