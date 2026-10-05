import { setTimeout as delay } from 'node:timers/promises';
import OpenAI from 'openai';
import { AppError } from '../shared/errors.js';
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
  readonly capabilities = { streaming: true, toolCalling: false };
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
      let finish: 'stop' | 'length' | undefined;
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
            messages: request.messages.map((message) => ({ ...message })),
            stream: true,
            [this.options.maxTokensParameter ?? 'max_tokens']: request.maxOutputTokens,
            ...(this.options.includeUsage === false
              ? {}
              : { stream_options: { include_usage: true } }),
          },
          { signal },
        );
        try {
          for await (const chunk of stream) {
            started = true;
            if (signal.aborted) throw new AppError('CANCELLED', '请求已取消。');
            const choice = chunk.choices?.[0];
            if (choice?.delta?.tool_calls?.length || choice?.delta?.function_call) {
              throw new AppError(
                'MODEL_UNSUPPORTED',
                '当前模块不执行模型工具调用，请使用对话模型。',
              );
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
              if (choice.finish_reason === 'content_filter') {
                throw new AppError('MODEL_REJECTED', '模型服务拒绝了本次请求。');
              }
              if (!['stop', 'length'].includes(choice.finish_reason)) {
                throw new AppError('MODEL_UNSUPPORTED', '模型返回了当前模块不支持的结束类型。');
              }
              finish = choice.finish_reason as 'stop' | 'length';
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
        input: request.messages.map((message) => ({ ...message })),
        max_output_tokens: request.maxOutputTokens,
        stream: true,
        store: false,
      },
      { signal },
    );
    let finish: 'stop' | 'length' | undefined;
    try {
      for await (const event of stream) {
        markStarted();
        if (signal.aborted) throw new AppError('CANCELLED', '请求已取消。');
        if (
          event.type === 'response.output_text.delta' ||
          event.type === 'response.refusal.delta'
        ) {
          if (typeof event.delta !== 'string')
            throw new AppError('MODEL_PROTOCOL', '模型文本分片格式无效。');
          if (event.delta) yield { type: 'text_delta', text: event.delta };
        }
        if (
          event.type === 'response.output_item.added' &&
          !['message', 'reasoning'].includes(event.item.type)
        ) {
          throw new AppError('MODEL_UNSUPPORTED', '当前对话模块不执行模型工具调用。');
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
          finish = event.type === 'response.completed' ? 'stop' : 'length';
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
