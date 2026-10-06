import { AppError } from '../shared/errors.js';
import type { LLMEvent, LLMMessage, LLMProvider } from '../providers/types.js';
import type { MemorySelection } from './memory.js';
import { memoryPrompt } from './prompt.js';

export interface ConversationOptions {
  model: string;
  maxOutputTokens: number;
  timeoutMs: number;
  maxHistoryMessages?: number;
  maxContextCharacters?: number;
  maxResponseCharacters?: number;
  memory?: (query: string, signal: AbortSignal) => Promise<MemorySelection>;
}

const SYSTEM_MESSAGE: LLMMessage = {
  role: 'system',
  content:
    "You are MewCode Agent, a programming conversation assistant. You currently have no file, shell or external tools. Do not claim to have inspected or changed files. Answer in the user's language.",
};

export class Conversation {
  private messages: LLMMessage[] = [];
  private busy = false;

  constructor(
    private readonly provider: LLMProvider,
    private readonly options: ConversationOptions,
  ) {}

  get history(): readonly LLMMessage[] {
    return this.messages.map((message) => ({ ...message }));
  }

  async *send(
    prompt: string,
    signal: AbortSignal = new AbortController().signal,
  ): AsyncIterable<LLMEvent> {
    if (this.busy) throw new AppError('BUSY', '当前回答尚未结束。');
    if (!prompt.trim()) throw new AppError('INVALID_PROMPT', '请输入非空问题。');
    if (signal.aborted) throw new AppError('CANCELLED', '请求已取消。');
    const user: LLMMessage = { role: 'user', content: prompt };
    const requestMessages = [SYSTEM_MESSAGE, ...this.messages, user];
    if (
      this.messages.length + 2 > (this.options.maxHistoryMessages ?? 40) ||
      requestMessages.reduce((size, message) => size + message.content.length, 0) >
        (this.options.maxContextCharacters ?? 100_000)
    ) {
      throw new AppError(
        'CONTEXT_LIMIT',
        '会话已达到当前上下文上限，请退出并开始新会话；自动压缩将在后续模块接入。',
      );
    }
    this.busy = true;
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, this.options.timeoutMs);
    timer.unref();
    const combined = AbortSignal.any([signal, deadline.signal]);
    let response = '';
    let finish: 'stop' | 'length' | undefined;
    try {
      if (this.options.memory) {
        const memory = await this.options.memory(prompt, combined);
        if (memory.entries.length)
          requestMessages[0] = {
            role: 'system',
            content: `${SYSTEM_MESSAGE.content}\n\n## memory\n${memoryPrompt(memory)}`,
          };
        if (
          requestMessages.reduce((size, message) => size + message.content.length, 0) >
          (this.options.maxContextCharacters ?? 100_000)
        )
          throw new AppError('CONTEXT_LIMIT', '记忆与会话超过上下文上限，本轮未发送模型请求。');
      }
      if (combined.aborted) throw new AppError('CANCELLED', '请求已取消，未调用模型。');
      for await (const event of this.provider.stream(
        {
          model: this.options.model,
          messages: requestMessages,
          maxOutputTokens: this.options.maxOutputTokens,
        },
        combined,
      )) {
        if (combined.aborted) throw new AppError('CANCELLED', '请求已取消。');
        if (finish !== undefined)
          throw new AppError('MODEL_PROTOCOL', '模型在结束后继续返回事件。');
        if (
          event.type === 'tool_call_delta' ||
          (event.type === 'finish' && event.reason === 'tool_calls')
        )
          throw new AppError('MODEL_UNSUPPORTED', 'chat 不执行工具，请使用 run 命令。');
        if (event.type === 'text_delta') {
          response += event.text;
          if (response.length > (this.options.maxResponseCharacters ?? 200_000)) {
            deadline.abort();
            throw new AppError('CONTEXT_LIMIT', '回答超过当前输出上限，本轮残缺内容未加入会话。');
          }
        }
        if (event.type === 'finish') {
          if (event.reason === 'tool_calls')
            throw new AppError('MODEL_UNSUPPORTED', 'chat 不执行工具，请使用 run 命令。');
          finish = event.reason;
        } else yield event;
      }
      if (combined.aborted) throw new AppError('CANCELLED', '请求已取消。');
      if (finish === undefined)
        throw new AppError('MODEL_PROTOCOL', '模型流未正常结束，本轮未加入会话。');
      this.messages.push(user, { role: 'assistant', content: response });
      yield { type: 'finish', reason: finish };
    } catch (error) {
      if (timedOut && !signal.aborted)
        throw new AppError('MODEL_TIMEOUT', '模型请求超过总时间限制，本轮残缺内容未加入会话。');
      if (signal.aborted) throw new AppError('CANCELLED', '请求已取消，本轮残缺内容未加入会话。');
      if (error instanceof AppError) throw error;
      throw new AppError('MODEL_PROTOCOL', '模型请求失败，本轮未加入会话。');
    } finally {
      clearTimeout(timer);
      deadline.abort();
      this.busy = false;
    }
  }
}
