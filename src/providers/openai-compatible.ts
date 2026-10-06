import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
import { AppError } from '../shared/errors.js';
import { ToolCallBuffer } from './tool-calls.js';
import type { LLMEvent, LLMProvider, LLMRequest } from './types.js';

export interface OpenAIProviderOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  wireApi?: 'chat-completions' | 'responses';
  maxTokensParameter?: 'max_tokens' | 'max_completion_tokens';
  includeUsage?: boolean;
}

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = 'openai-compatible';
  readonly capabilities = { streaming: true, toolCalling: true };
  private readonly client: OpenAI;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: 0,
      ...(options.baseUrl === undefined ? {} : { baseURL: options.baseUrl }),
    });
  }

  async *stream(request: LLMRequest, signal: AbortSignal): AsyncIterable<LLMEvent> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let started = false;
      let finish: 'stop' | 'length' | 'tool_calls' | undefined;
      try {
        if (this.options.wireApi === 'responses') {
          yield* this.responses(request, signal, () => {
            started = true;
          });
          return;
        }
        const stream = await this.client.chat.completions.create(
          {
            model: request.model,
            messages: request.messages.map(
              (message): OpenAI.Chat.Completions.ChatCompletionMessageParam => {
                if (message.role === 'tool') {
                  if (!message.callId)
                    throw new AppError('MODEL_PROTOCOL', '工具结果缺少调用编号。');
                  return { role: 'tool', tool_call_id: message.callId, content: message.content };
                }
                if (message.role === 'assistant')
                  return {
                    role: 'assistant',
                    content: message.content || null,
                    ...(message.toolCalls?.length
                      ? {
                          tool_calls: message.toolCalls.map((call) => ({
                            id: call.callId,
                            type: 'function' as const,
                            function: { name: call.name, arguments: call.arguments },
                          })),
                        }
                      : {}),
                  };
                return { role: message.role, content: message.content };
              },
            ),
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((tool) => ({
                    type: 'function' as const,
                    function: { ...tool, strict: false },
                  })),
                }
              : {}),
            stream: true,
            [this.options.maxTokensParameter ?? 'max_tokens']: request.maxOutputTokens,
            ...(this.options.includeUsage === false
              ? {}
              : { stream_options: { include_usage: true } }),
          },
          { signal },
        );
        let eventCount = 0;
        try {
          for await (const chunk of stream) {
            started = true;
            if (++eventCount > 10_000) throw new AppError('MODEL_PROTOCOL', '模型流事件达到上限。');
            if (signal.aborted) throw new AppError('CANCELLED', '请求已取消。');
            const choice = chunk.choices?.[0];
            if (choice?.delta?.function_call)
              throw new AppError('MODEL_UNSUPPORTED', '不支持旧版 function_call 协议。');
            if (
              finish &&
              choice &&
              (choice.finish_reason || choice.delta?.content || choice.delta?.tool_calls?.length)
            )
              throw new AppError('MODEL_PROTOCOL', '模型在结束标记后继续输出。');
            for (const call of choice?.delta?.tool_calls ?? []) {
              if (!request.tools?.length)
                throw new AppError('MODEL_UNSUPPORTED', '当前请求未启用模型工具调用。');
              if (call.type && call.type !== 'function')
                throw new AppError('MODEL_UNSUPPORTED', '模型工具类型不受支持。');
              yield {
                type: 'tool_call_delta',
                index: call.index,
                ...(call.id !== undefined ? { callId: call.id } : {}),
                ...(call.function?.name !== undefined ? { name: call.function.name } : {}),
                ...(call.function?.arguments !== undefined
                  ? { arguments: call.function.arguments }
                  : {}),
              };
            }
            const text = choice?.delta?.content ?? choice?.delta?.refusal;
            if (text !== undefined && text !== null) {
              if (typeof text !== 'string')
                throw new AppError('MODEL_PROTOCOL', '模型文本分片格式无效。');
              if (text.length > 0) yield { type: 'text_delta', text };
            }
            if (chunk.usage) {
              const { prompt_tokens: inputTokens, completion_tokens: outputTokens } = chunk.usage;
              if (
                !Number.isSafeInteger(inputTokens) ||
                inputTokens < 0 ||
                !Number.isSafeInteger(outputTokens) ||
                outputTokens < 0
              ) {
                throw new AppError('MODEL_PROTOCOL', '模型返回了无效 token 用量。');
              }
              yield { type: 'usage', inputTokens, outputTokens, estimated: false };
            }
            if (choice?.finish_reason) {
              if (choice.finish_reason === 'tool_calls' && !request.tools?.length)
                throw new AppError('MODEL_UNSUPPORTED', '当前请求未启用模型工具调用。');
              if (choice.finish_reason === 'content_filter') {
                throw new AppError('MODEL_REJECTED', '模型服务拒绝了本次请求。');
              }
              if (!['stop', 'length', 'tool_calls'].includes(choice.finish_reason)) {
                throw new AppError('MODEL_UNSUPPORTED', '模型返回了当前模块不支持的结束类型。');
              }
              finish = choice.finish_reason as 'stop' | 'length' | 'tool_calls';
            }
          }
        } finally {
          stream.controller.abort();
        }
        if (signal.aborted) throw new AppError('CANCELLED', '请求已取消。');
        if (finish === undefined)
          throw new AppError('MODEL_PROTOCOL', '模型响应中断或缺少结束标记；残缺回答未加入会话。');
        yield { type: 'finish', reason: finish };
        return;
      } catch (error) {
        const normalized = this.normalize(error, signal);
        const retryable = ['MODEL_RATE_LIMIT', 'MODEL_NETWORK', 'MODEL_SERVER'].includes(
          normalized.code,
        );
        if (attempt === 0 && !started && retryable && !signal.aborted) {
          try {
            await delay(200, undefined, { signal });
          } catch {
            throw new AppError('CANCELLED', '请求已取消。');
          }
          continue;
        }
        throw normalized;
      }
    }
  }

  private async *responses(
    request: LLMRequest,
    signal: AbortSignal,
    markStarted: () => void,
  ): AsyncIterable<LLMEvent> {
    const stream = await this.client.responses.create(
      {
        model: request.model,
        input: request.messages.flatMap((message): OpenAI.Responses.ResponseInputItem[] => {
          if (message.role === 'tool') {
            if (!message.callId) throw new AppError('MODEL_PROTOCOL', '工具结果缺少调用编号。');
            return [
              { type: 'function_call_output', call_id: message.callId, output: message.content },
            ];
          }
          if (message.continuation?.provider === 'responses')
            return structuredClone(
              message.continuation.items,
            ) as OpenAI.Responses.ResponseInputItem[];
          const items: OpenAI.Responses.ResponseInputItem[] = message.content
            ? [{ role: message.role, content: message.content }]
            : [];
          for (const call of message.toolCalls ?? [])
            items.push({
              type: 'function_call',
              call_id: call.callId,
              name: call.name,
              arguments: call.arguments,
            });
          return items;
        }),
        ...(request.tools?.length
          ? {
              tools: request.tools.map((tool) => ({
                type: 'function' as const,
                ...tool,
                strict: false,
              })),
              include: ['reasoning.encrypted_content' as const],
            }
          : {}),
        max_output_tokens: request.maxOutputTokens,
        stream: true,
        store: false,
      },
      { signal },
    );
    let finish: 'stop' | 'length' | 'tool_calls' | undefined;
    const buffer = new ToolCallBuffer();
    const itemIds = new Map<number, string>();
    let eventCount = 0;
    try {
      for await (const event of stream) {
        markStarted();
        if (++eventCount > 10_000) throw new AppError('MODEL_PROTOCOL', '模型流事件达到上限。');
        if (signal.aborted) throw new AppError('CANCELLED', '请求已取消。');
        if (
          event.type === 'response.output_text.delta' ||
          event.type === 'response.refusal.delta'
        ) {
          if (typeof event.delta !== 'string')
            throw new AppError('MODEL_PROTOCOL', '模型文本分片格式无效。');
          if (event.delta) yield { type: 'text_delta', text: event.delta };
        }
        if (event.type === 'response.output_item.added') {
          if (event.item.type === 'function_call') {
            if (!request.tools?.length)
              throw new AppError('MODEL_UNSUPPORTED', '当前请求未启用模型工具调用。');
            if (itemIds.has(event.output_index))
              throw new AppError('MODEL_PROTOCOL', '重复的工具输出索引。');
            itemIds.set(event.output_index, event.item.id ?? '');
            const delta: Extract<LLMEvent, { type: 'tool_call_delta' }> = {
              type: 'tool_call_delta',
              index: event.output_index,
              callId: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments,
            };
            buffer.add(delta);
            yield delta;
          } else if (!['message', 'reasoning'].includes(event.item.type))
            throw new AppError('MODEL_UNSUPPORTED', '模型工具类型不受支持。');
        }
        if (event.type === 'response.function_call_arguments.delta') {
          if (!itemIds.has(event.output_index) || itemIds.get(event.output_index) !== event.item_id)
            throw new AppError('MODEL_PROTOCOL', '工具参数分片的输出编号不一致。');
          const delta: Extract<LLMEvent, { type: 'tool_call_delta' }> = {
            type: 'tool_call_delta',
            index: event.output_index,
            arguments: event.delta,
          };
          buffer.add(delta);
          yield delta;
        }
        if (event.type === 'response.failed')
          throw new AppError('MODEL_SERVER', '模型服务未能完成本次响应。');
        if (event.type === 'error')
          throw new AppError('MODEL_PROTOCOL', '模型服务返回了流式错误。');
        if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          if (
            event.type === 'response.incomplete' &&
            event.response.incomplete_details?.reason !== 'max_output_tokens'
          ) {
            throw new AppError('MODEL_REJECTED', '模型响应未能正常完成。');
          }
          const usage = event.response.usage;
          if (usage) {
            if (
              !Number.isSafeInteger(usage.input_tokens) ||
              usage.input_tokens < 0 ||
              !Number.isSafeInteger(usage.output_tokens) ||
              usage.output_tokens < 0
            ) {
              throw new AppError('MODEL_PROTOCOL', '模型返回了无效 token 用量。');
            }
            yield {
              type: 'usage',
              inputTokens: usage.input_tokens,
              outputTokens: usage.output_tokens,
              estimated: false,
            };
          }
          if (event.type === 'response.incomplete') finish = 'length';
          else {
            const calls = buffer.complete();
            const outputCalls = event.response.output
              .filter((item) => item.type === 'function_call')
              .map((item) => ({
                callId: item.call_id,
                name: item.name,
                arguments: item.arguments,
              }));
            if (JSON.stringify(calls) !== JSON.stringify(outputCalls))
              throw new AppError('MODEL_PROTOCOL', '工具调用完成内容与分片不一致。');
            if (request.tools?.length) {
              if (
                event.response.output.some(
                  (item) => !['message', 'reasoning', 'function_call'].includes(item.type),
                )
              )
                throw new AppError('MODEL_UNSUPPORTED', '模型输出类型不受支持。');
              yield { type: 'continuation', provider: 'responses', items: event.response.output };
            }
            finish = calls.length ? 'tool_calls' : 'stop';
          }
          break;
        }
      }
    } finally {
      stream.controller.abort();
    }
    if (signal.aborted) throw new AppError('CANCELLED', '请求已取消。');
    if (finish === undefined)
      throw new AppError('MODEL_PROTOCOL', 'Responses 流缺少完成事件；残缺回答未加入会话。');
    yield { type: 'finish', reason: finish };
  }

  private normalize(error: unknown, signal: AbortSignal): AppError {
    if (signal.aborted) return new AppError('CANCELLED', '请求已取消。');
    if (error instanceof AppError) return error;
    if (error instanceof OpenAI.APIConnectionTimeoutError)
      return new AppError('MODEL_TIMEOUT', '模型服务响应超时。');
    if (error instanceof OpenAI.APIConnectionError)
      return new AppError('MODEL_NETWORK', '无法连接模型服务，请检查网络和服务地址。');
    if (error instanceof TypeError)
      return new AppError('MODEL_NETWORK', '模型连接中断，请检查网络后重试。');
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401 || error.status === 403)
        return new AppError('MODEL_AUTH', '模型鉴权失败，请检查密钥环境变量与账户权限。');
      if (error.status === 429)
        return new AppError('MODEL_RATE_LIMIT', '模型服务限流或配额不足，请稍后重试。');
      if (error.status !== undefined && error.status >= 500)
        return new AppError('MODEL_SERVER', '模型服务暂时不可用，请稍后重试。');
      return new AppError('MODEL_PROTOCOL', '模型服务拒绝请求，请检查模型名称和兼容参数。');
    }
    return new AppError('MODEL_PROTOCOL', '模型返回了无法解析的响应。');
  }
}
