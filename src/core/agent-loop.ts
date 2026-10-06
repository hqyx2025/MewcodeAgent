import { AppError } from '../shared/errors.js';
import { ToolCallBuffer } from '../providers/tool-calls.js';
import type { LLMEvent, LLMMessage, LLMProvider, LLMToolCall } from '../providers/types.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolMode, ToolResult } from '../tools/types.js';
import { ProjectInstructions } from './instructions.js';
import { buildSystemPrompt } from './prompt.js';
import type { PromptContext, PromptManifest } from './prompt.js';

export interface AgentOptions {
  model: string;
  mode: ToolMode;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  maxTotalTokens?: number;
  maxContextCharacters?: number;
  maxFailures?: number;
  sensitiveValues?: readonly string[];
}

export type AgentEvent =
  | { type: 'prompt_info'; manifest: PromptManifest }
  | { type: 'turn_start'; turn: number }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_start'; callId: string; name: string }
  | { type: 'tool_result'; result: ToolResult }
  | { type: 'usage'; inputTokens: number; outputTokens: number; estimated: boolean }
  | {
      type: 'finish';
      reason: 'completed' | 'length' | 'max_turns' | 'token_budget' | 'repeated_failures';
      turns: number;
      toolCalls: number;
      totalTokens: number;
      estimated: boolean;
    };

export class AgentLoop {
  private messages: LLMMessage[] = [];
  private busy = false;

  constructor(
    private readonly provider: LLMProvider,
    private readonly executor: ToolExecutor,
    private readonly options: AgentOptions,
  ) {
    if (options.mode !== executor.mode)
      throw new AppError('CONFIG_INVALID', 'Agent 与工具执行器的权限模式必须一致。');
    for (const value of [
      options.maxTurns,
      options.timeoutMs,
      options.maxOutputTokens,
      options.maxTotalTokens ?? 200_000,
      options.maxContextCharacters ?? 200_000,
      options.maxFailures ?? 3,
    ])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new AppError('CONFIG_INVALID', 'Agent 预算必须为正整数。');
  }

  get history(): readonly LLMMessage[] {
    return structuredClone(this.messages);
  }

  async inspectPrompt(signal: AbortSignal = new AbortController().signal): Promise<PromptManifest> {
    const instructions = new ProjectInstructions(this.executor.paths, this.options.sensitiveValues);
    await instructions.discover('.', 'directory', signal);
    return this.compose(instructions).manifest;
  }

  private compose(
    instructions: ProjectInstructions,
    tools: PromptContext['tools'] = this.executor.registry
      .definitions()
      .filter((tool) => this.executor.mode !== 'plan' || tool.effect === 'read')
      .map(({ name, effect }) => ({ name, effect })),
  ) {
    return buildSystemPrompt(
      {
        cwd: this.executor.paths.root,
        model: this.options.model,
        mode: this.executor.mode,
        shell: this.executor.shell,
        tools,
        budgets: {
          maxTurns: this.options.maxTurns,
          timeoutMs: this.options.timeoutMs,
          maxOutputTokens: this.options.maxOutputTokens,
          maxTotalTokens: this.options.maxTotalTokens ?? 200_000,
          maxContextCharacters: this.options.maxContextCharacters ?? 200_000,
          maxFailures: this.options.maxFailures ?? 3,
        },
      },
      instructions.sources,
      instructions.warningHistory,
    );
  }

  private async discoverCalls(
    instructions: ProjectInstructions,
    calls: readonly LLMToolCall[],
    signal: AbortSignal,
  ): Promise<boolean> {
    let changed = false;
    for (const call of calls) {
      let input: unknown;
      try {
        input = this.executor.registry
          .get(call.name)
          .schema.parse(JSON.parse(call.arguments) as unknown);
      } catch {
        continue;
      }
      if (!input || typeof input !== 'object') continue;
      const fields = input as Record<string, unknown>;
      if (
        ['ReadFile', 'WriteFile', 'EditFile'].includes(call.name) &&
        typeof fields.path === 'string'
      )
        changed = (await instructions.discover(fields.path, 'file', signal)) || changed;
      else if (call.name === 'Grep' && typeof fields.path === 'string')
        changed = (await instructions.discover(fields.path, 'auto', signal)) || changed;
      else if (call.name === 'Bash' && typeof fields.cwd === 'string')
        changed = (await instructions.discover(fields.cwd, 'directory', signal)) || changed;
      else if (call.name === 'Glob' && typeof fields.pattern === 'string') {
        const parts = fields.pattern.split('/');
        const wildcard = parts.findIndex((part) => /[*?[\]{}()]/.test(part));
        const prefix = wildcard < 0 ? parts.slice(0, -1) : parts.slice(0, wildcard);
        changed =
          (await instructions.discover(prefix.join('/') || '.', 'directory', signal)) || changed;
      }
    }
    return changed;
  }

  async *run(
    prompt: string,
    signal: AbortSignal = new AbortController().signal,
  ): AsyncIterable<AgentEvent> {
    if (this.busy) throw new AppError('BUSY', 'Agent 任务尚未结束。');
    if (!prompt.trim()) throw new AppError('INVALID_PROMPT', '请输入非空任务。');
    if (!this.provider.capabilities.toolCalling)
      throw new AppError('MODEL_UNSUPPORTED', '当前 provider 不支持工具调用。');
    if (signal.aborted) throw new AppError('CANCELLED', '任务已取消。');
    this.busy = true;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    timer.unref();
    const combined = AbortSignal.any([signal, controller.signal]);
    this.messages = [
      {
        role: 'system',
        content: '',
      },
      { role: 'user', content: prompt },
    ];
    let totalTokens = 0;
    let estimated = false;
    let toolCalls = 0;
    let failures = 0;
    let turns = 0;
    const seenIds = new Set<string>();
    let pending: LLMToolCall[] = [];
    const instructions = new ProjectInstructions(this.executor.paths, this.options.sensitiveValues);
    const finish = (reason: Extract<AgentEvent, { type: 'finish' }>['reason']): AgentEvent => ({
      type: 'finish',
      reason,
      turns,
      toolCalls,
      totalTokens,
      estimated,
    });
    try {
      const visible = this.executor.registry
        .definitions()
        .filter((tool) => this.options.mode !== 'plan' || tool.effect === 'read');
      const definitions = visible.map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }));
      const promptTools = visible.map(({ name, effect }) => ({ name, effect }));
      await instructions.discover('.', 'directory', combined);
      instructions.takeWarnings();
      const initial = this.compose(instructions, promptTools);
      this.messages[0]!.content = initial.text;
      yield { type: 'prompt_info', manifest: initial.manifest };
      for (turns = 1; turns <= this.options.maxTurns; turns++) {
        this.checkCancelled(combined);
        const contextSize =
          JSON.stringify(this.messages).length + JSON.stringify(definitions).length;
        if (contextSize > (this.options.maxContextCharacters ?? 200_000))
          throw new AppError('CONTEXT_LIMIT', '任务上下文达到上限；已完成的工具操作保留。');
        if (totalTokens >= (this.options.maxTotalTokens ?? 200_000)) {
          turns--;
          yield finish('token_budget');
          return;
        }
        yield { type: 'turn_start', turn: turns };
        const buffer = new ToolCallBuffer();
        let text = '';
        let end: Extract<LLMEvent, { type: 'finish' }>['reason'] | undefined;
        let continuation: LLMMessage['continuation'];
        let usage: Extract<LLMEvent, { type: 'usage' }> | undefined;
        let events = 0;
        for await (const event of this.provider.stream(
          {
            model: this.options.model,
            messages: structuredClone(this.messages),
            maxOutputTokens: this.options.maxOutputTokens,
            tools: definitions,
          },
          combined,
        )) {
          this.checkCancelled(combined);
          if (end !== undefined || ++events > 10_000)
            throw new AppError('MODEL_PROTOCOL', '模型事件顺序无效或事件数量达到上限。');
          if (event.type === 'text_delta') {
            text += event.text;
            if (text.length > 200_000)
              throw new AppError('CONTEXT_LIMIT', '模型输出达到上限，本轮未执行工具。');
            yield event;
          } else if (event.type === 'tool_call_delta') buffer.add(event);
          else if (event.type === 'continuation') {
            if (continuation || JSON.stringify(event.items).length > 200_000)
              throw new AppError('MODEL_PROTOCOL', '模型上下文续传格式或大小无效。');
            continuation = { provider: event.provider, items: structuredClone(event.items) };
          } else if (event.type === 'usage') {
            if (
              usage ||
              !Number.isSafeInteger(event.inputTokens) ||
              event.inputTokens < 0 ||
              !Number.isSafeInteger(event.outputTokens) ||
              event.outputTokens < 0
            )
              throw new AppError('MODEL_PROTOCOL', '模型 token 用量无效。');
            usage = event;
          } else end = event.reason;
        }
        this.checkCancelled(combined);
        if (end === undefined)
          throw new AppError('MODEL_PROTOCOL', '模型流缺少结束标记，本轮未执行工具。');
        const consumed = usage ?? {
          type: 'usage',
          inputTokens: Math.ceil(contextSize / 3),
          outputTokens: Math.ceil(
            (text.length + buffer.byteLength + JSON.stringify(continuation ?? {}).length) / 3,
          ),
          estimated: true,
        };
        totalTokens += consumed.inputTokens + consumed.outputTokens;
        estimated ||= consumed.estimated;
        yield consumed;
        // A truncated call is never parsed or executed, even if its prefix looks valid.
        if (end === 'length') {
          yield finish('length');
          return;
        }
        const calls = buffer.complete();
        if ((end === 'tool_calls') !== calls.length > 0)
          throw new AppError('MODEL_PROTOCOL', '工具调用与模型结束类型不一致。');
        if (calls.some((call) => seenIds.has(call.callId)))
          throw new AppError('MODEL_PROTOCOL', '模型重复使用了已执行的调用编号，本轮未执行工具。');
        if (totalTokens > (this.options.maxTotalTokens ?? 200_000)) {
          yield finish('token_budget');
          return;
        }
        const guidanceChanged = await this.discoverCalls(instructions, calls, combined);
        const warnings = instructions.takeWarnings();
        const replan = guidanceChanged || warnings.length > 0;
        if (replan) {
          const updated = this.compose(instructions, promptTools);
          this.messages[0]!.content = updated.text;
          yield { type: 'prompt_info', manifest: updated.manifest };
        }
        this.messages.push({
          role: 'assistant',
          content: text,
          ...(calls.length ? { toolCalls: calls } : {}),
          ...(continuation ? { continuation } : {}),
        });
        if (!calls.length) {
          yield finish('completed');
          return;
        }
        pending = [...calls];
        for (const call of calls) {
          seenIds.add(call.callId);
          if (!replan) yield { type: 'tool_start', callId: call.callId, name: call.name };
          // Tools stay serial: later calls may depend on a read revision or an earlier edit.
          const result: ToolResult = replan
            ? {
                callId: call.callId,
                name: call.name,
                ok: false,
                content:
                  '项目指令或诊断已更新，本批工具均未执行。请阅读更新的系统提示后用新的callId重新计划。',
                error: {
                  code: 'INSTRUCTIONS_UPDATED',
                  message: '本批未执行：项目指令更新需要重新计划。',
                },
              }
            : await this.executor.execute(
                {
                  callId: call.callId,
                  name: call.name,
                  input: JSON.parse(call.arguments) as unknown,
                },
                combined,
              );
          if (!replan) {
            toolCalls++;
            failures = result.ok ? 0 : failures + 1;
          }
          this.messages.push({
            role: 'tool',
            callId: call.callId,
            content: JSON.stringify(result),
          });
          pending.shift();
          yield { type: 'tool_result', result };
          this.checkCancelled(combined);
          if (failures >= (this.options.maxFailures ?? 3)) {
            yield finish('repeated_failures');
            return;
          }
        }
      }
      turns = this.options.maxTurns;
      yield finish('max_turns');
    } catch (error) {
      if (timedOut && !signal.aborted)
        throw new AppError('MODEL_TIMEOUT', 'Agent 任务达到总时间限制；已完成的操作保留。');
      if (signal.aborted) throw new AppError('CANCELLED', 'Agent 任务已取消；已完成的操作保留。');
      if (error instanceof AppError) throw error;
      throw new AppError('MODEL_PROTOCOL', 'Agent 模型响应无效；已完成的操作保留。');
    } finally {
      // Preserve complete call/result pairs even if the consumer stops mid-batch.
      for (const call of pending)
        this.messages.push({
          role: 'tool',
          callId: call.callId,
          content: JSON.stringify({
            callId: call.callId,
            name: call.name,
            ok: false,
            content: '任务停止，此调用未执行。',
            error: { code: 'AGENT_STOPPED', message: '任务停止，此调用未执行。' },
          }),
        });
      clearTimeout(timer);
      controller.abort();
      this.busy = false;
    }
  }

  private checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new AppError('CANCELLED', 'Agent 任务已取消。');
  }
}
