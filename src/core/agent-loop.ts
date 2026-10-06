import { AppError } from '../shared/errors.js';
import { ToolCallBuffer } from '../providers/tool-calls.js';
import type { LLMEvent, LLMMessage, LLMProvider, LLMToolCall } from '../providers/types.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolMode, ToolResult } from '../tools/types.js';
import { ProjectInstructions, redactInstruction } from './instructions.js';
import { byteLimit, ToolError } from '../tools/errors.js';
import { buildSystemPrompt } from './prompt.js';
import type { PromptContext, PromptManifest } from './prompt.js';
import { compactHistory, defaultContext, measureContext, actionDigest } from './context.js';
import type { ContextSettings, ContextMeasure } from './context.js';
import { inlineResult, recoverState } from './session.js';
import type { SessionStore, SessionState } from './session.js';
import type { MemoryStore, MemorySelection } from './memory.js';
import type { MemorySettings } from './memory-schema.js';
import type { SkillCatalog, SkillSelection } from './skills.js';
import type { TokenBudget } from './token-budget.js';
import type { LLMRequest } from '../providers/types.js';

export interface AgentOptions {
  subagentRecoveryLimit?: number;
  subagentIds?: () => readonly string[];
  accounting?: TokenBudget;
  aggregateTokens?: boolean;
  onToolResult?: (result: Readonly<ToolResult>) => void;
  model: string;
  mode: ToolMode;
  maxTurns: number;
  timeoutMs: number;
  maxOutputTokens: number;
  maxTotalTokens?: number;
  maxContextCharacters?: number;
  maxFailures?: number;
  sensitiveValues?: readonly string[];
  context?: ContextSettings;
  session?: SessionStore;
  resume?: SessionState;
  memory?: { store: MemoryStore; settings: MemorySettings };
  skills?: { catalog: SkillCatalog; explicit?: readonly string[] };
  initializeTools?: (signal: AbortSignal) => Promise<void>;
}

export type AgentEvent = { agentId?: string } & (
  | { type: 'context'; measure: ContextMeasure }
  | {
      type: 'compacted';
      beforeBytes: number;
      afterBytes: number;
      archivedMessages: number;
      estimated: true;
    }
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
    }
);

export class AgentLoop {
  private messages: LLMMessage[] = [];
  private busy = false;
  private memory?: MemorySelection;
  private skills?: SkillSelection;

  constructor(
    private readonly provider: LLMProvider,
    private readonly executor: ToolExecutor,
    private readonly options: AgentOptions,
  ) {
    const modeRank = { plan: 0, default: 1, 'accept-edits': 2 };
    if (options.resume && modeRank[options.mode] > modeRank[options.resume.mode])
      throw new AppError('CONFIG_INVALID', '恢复执行器不能提升检查点中的权限模式。');
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

  async inspectPrompt(
    signal: AbortSignal = new AbortController().signal,
    query = '',
  ): Promise<PromptManifest> {
    const instructions = new ProjectInstructions(
      this.executor.paths,
      this.options.sensitiveValues,
      (path) => this.executor.allowsInstruction(path),
    );
    await instructions.discover('.', 'directory', signal);
    if (this.options.memory)
      this.memory = await this.options.memory.store.select(
        this.executor,
        '',
        this.options.memory.settings,
        signal,
      );
    if (this.options.skills)
      this.skills = await this.options.skills.catalog.select(
        query,
        this.options.skills.explicit,
        signal,
      );
    return this.compose(instructions).manifest;
  }

  private compose(
    instructions: ProjectInstructions,
    tools: PromptContext['tools'] = this.executor
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
        policySummary: byteLimit(
          redactInstruction(
            JSON.stringify(this.executor.policyMetadata),
            this.options.sensitiveValues,
          ),
          8192,
        ),
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
      this.memory,
      this.skills,
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
    for await (const event of this.runInternal(prompt, signal))
      yield { ...event, agentId: this.executor.agentId };
  }

  private async *runInternal(
    prompt: string,
    signal: AbortSignal = new AbortController().signal,
  ): AsyncIterable<AgentEvent> {
    if (this.busy) throw new AppError('BUSY', 'Agent 任务尚未结束。');
    if (!prompt.trim() && !this.options.resume)
      throw new AppError('INVALID_PROMPT', '请输入非空任务。');
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
    const restored = this.options.resume ? recoverState(this.options.resume) : undefined;
    this.messages = restored
      ? structuredClone(restored.messages)
      : [
          {
            role: 'system',
            content: '',
          },
          { role: 'user', content: prompt },
        ];
    if (restored && prompt.trim()) this.messages.push({ role: 'user', content: prompt });
    let totalTokens = restored?.totalTokens ?? 0;
    let estimated = restored?.estimated ?? false;
    let toolCalls = restored?.toolCalls ?? 0;
    let failures = restored?.failures ?? 0;
    let turns = restored?.turns ?? 0;
    const seenIds = new Set<string>(restored?.seenIds ?? []);
    const actions = new Set<string>(restored?.actions ?? []);
    const blockedActions = new Set<string>(restored?.actions ?? []);
    const context = this.options.context ?? defaultContext;
    let pending: LLMToolCall[] = [];
    let inFlight: string | undefined;
    let status: SessionState['status'] = 'running';
    let endReason: 'error' | undefined;
    let reservation: ReturnType<TokenBudget['reserve']> | undefined;
    const checkpoint = async (
      event: Parameters<SessionStore['commit']>[1] = 'checkpoint',
      messages = this.messages,
    ) => {
      if (this.options.accounting && this.options.aggregateTokens) {
        totalTokens = this.options.accounting.snapshot.used;
        estimated = this.options.accounting.snapshot.estimated;
      }
      if (this.options.session)
        await this.options.session.commit(
          {
            mode: this.executor.mode,
            ...(this.options.subagentRecoveryLimit && pending.some((call) => call.name === 'Task')
              ? {
                  pendingSubagentTokens: Math.min(
                    this.options.subagentRecoveryLimit,
                    this.options.accounting?.snapshot.available ??
                      this.options.subagentRecoveryLimit,
                  ),
                }
              : {}),
            ...(this.options.subagentIds || restored?.subagentIds
              ? { subagentIds: [...(this.options.subagentIds?.() ?? restored?.subagentIds ?? [])] }
              : {}),
            messages: structuredClone(messages),
            seenIds: [...seenIds],
            actions: [...actions],
            totalTokens,
            estimated,
            turns,
            toolCalls,
            failures,
            status,
          },
          event,
        );
    };
    const instructions = new ProjectInstructions(
      this.executor.paths,
      this.options.sensitiveValues,
      (path) => this.executor.allowsInstruction(path),
    );
    const finish = async (
      reason: Extract<AgentEvent, { type: 'finish' }>['reason'],
    ): Promise<AgentEvent> => {
      try {
        await this.executor.dispatchHook('Stop', { reason }, combined);
      } catch (error) {
        status = 'stopped';
        await checkpoint('finish');
        throw error;
      }
      await checkpoint('finish');
      return { type: 'finish', reason, turns, toolCalls, totalTokens, estimated };
    };
    try {
      if (this.options.mode !== this.executor.mode)
        throw new AppError('CONFIG_INVALID', '权限模式已变化；请以新模式创建Agent任务。');
      await this.executor.dispatchHook(
        'SessionStart',
        { reason: restored ? 'resume' : 'new' },
        combined,
      );
      await this.options.initializeTools?.(combined);
      const visible = this.executor
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
      const memoryQuery =
        prompt.trim() ||
        this.messages.findLast((message) => message.role === 'user' && !message.contextSummary)
          ?.content ||
        '';
      if (this.options.memory)
        this.memory = await this.options.memory.store.select(
          this.executor,
          memoryQuery,
          this.options.memory.settings,
          combined,
        );
      if (this.options.skills)
        this.skills = await this.options.skills.catalog.select(
          memoryQuery,
          this.options.skills.explicit,
          combined,
        );
      const initial = this.compose(instructions, promptTools);
      this.messages[0]!.content = initial.text;
      yield { type: 'prompt_info', manifest: initial.manifest };
      await checkpoint(restored ? 'recovery' : 'checkpoint');
      if (restored?.status === 'completed' && !prompt.trim()) {
        status = 'completed';
        yield await finish('completed');
        return;
      }
      for (turns = (restored?.turns ?? 0) + 1; turns <= this.options.maxTurns; turns++) {
        this.checkCancelled(combined);
        if ((this.options.memory || this.options.skills) && turns > (restored?.turns ?? 0) + 1) {
          if (this.options.memory)
            this.memory = await this.options.memory.store.select(
              this.executor,
              memoryQuery,
              this.options.memory.settings,
              combined,
            );
          if (this.options.skills)
            this.skills = await this.options.skills.catalog.select(
              memoryQuery,
              this.options.skills.explicit,
              combined,
            );
          const updated = this.compose(instructions, promptTools);
          if (updated.text !== this.messages[0]!.content) {
            this.messages[0]!.content = updated.text;
            yield { type: 'prompt_info', manifest: updated.manifest };
          }
        }
        let measure = measureContext(
          this.messages,
          definitions,
          context.windowTokens,
          this.options.maxOutputTokens,
        );
        const needsCompact =
          measure.estimatedInputTokens + measure.outputReserveTokens >=
            context.windowTokens * context.triggerRatio ||
          JSON.stringify(this.messages).length + JSON.stringify(definitions).length >
            (this.options.maxContextCharacters ?? 200_000);
        if (context.autoCompact && needsCompact) {
          const candidate = compactHistory(this.messages, context);
          if (candidate) {
            await checkpoint();
            await checkpoint('compact', candidate.messages);
            this.messages = candidate.messages;
            yield {
              type: 'compacted',
              beforeBytes: candidate.beforeBytes,
              afterBytes: candidate.afterBytes,
              archivedMessages: candidate.archivedMessages,
              estimated: true,
            };
            measure = measureContext(
              this.messages,
              definitions,
              context.windowTokens,
              this.options.maxOutputTokens,
            );
          }
        }
        yield { type: 'context', measure };
        const contextSize =
          JSON.stringify(this.messages).length + JSON.stringify(definitions).length;
        if (
          contextSize > (this.options.maxContextCharacters ?? 200_000) ||
          measure.estimatedInputTokens + measure.outputReserveTokens > context.windowTokens
        )
          throw new AppError('CONTEXT_LIMIT', '任务上下文达到上限；已完成的工具操作保留。');
        if (totalTokens >= (this.options.maxTotalTokens ?? 200_000)) {
          turns--;
          status = 'stopped';
          yield await finish('token_budget');
          return;
        }
        if (this.options.mode !== this.executor.mode)
          throw new AppError('CONFIG_INVALID', '任务期间权限模式已变化，停止当前任务。');
        if (this.options.accounting) {
          const needed = measure.estimatedInputTokens + this.options.maxOutputTokens;
          if (
            needed > this.options.accounting.snapshot.available ||
            needed + totalTokens > (this.options.maxTotalTokens ?? 200_000)
          ) {
            turns--;
            status = 'stopped';
            yield await finish('token_budget');
            return;
          }
          reservation = this.options.accounting.reserve(needed, this.executor.agentId);
        }
        yield { type: 'turn_start', turn: turns };
        const buffer = new ToolCallBuffer();
        let text = '';
        let end: Extract<LLMEvent, { type: 'finish' }>['reason'] | undefined;
        let continuation: LLMMessage['continuation'];
        let usage: Extract<LLMEvent, { type: 'usage' }> | undefined;
        let events = 0;
        const ticket = reservation;
        reservation = undefined;
        for await (const event of this.modelStream(
          {
            model: this.options.model,
            messages: structuredClone(this.messages),
            maxOutputTokens: this.options.maxOutputTokens,
            tools: definitions,
          },
          combined,
          ticket,
          measure.estimatedInputTokens,
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
        await checkpoint();
        yield consumed;
        // A truncated call is never parsed or executed, even if its prefix looks valid.
        if (end === 'length') {
          status = 'stopped';
          yield await finish('length');
          return;
        }
        const calls = buffer.complete();
        if ((end === 'tool_calls') !== calls.length > 0)
          throw new AppError('MODEL_PROTOCOL', '工具调用与模型结束类型不一致。');
        if (calls.some((call) => seenIds.has(call.callId)))
          throw new AppError('MODEL_PROTOCOL', '模型重复使用了已执行的调用编号，本轮未执行工具。');
        if (totalTokens > (this.options.maxTotalTokens ?? 200_000)) {
          status = 'stopped';
          yield await finish('token_budget');
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
          status = 'completed';
          yield await finish('completed');
          return;
        }
        pending = [...calls];
        for (const call of calls) seenIds.add(call.callId);
        await checkpoint();
        for (const call of calls) {
          let effect: string | undefined;
          try {
            effect = this.executor.registry.get(call.name).effect;
          } catch {
            /* Unknown calls are normalized by the executor. */
          }
          const action =
            effect && effect !== 'read' ? actionDigest(call.name, call.arguments) : undefined;
          if (action) actions.add(action);
          await checkpoint('intent');
          if (!replan) yield { type: 'tool_start', callId: call.callId, name: call.name };
          // Tools stay serial: later calls may depend on a read revision or an earlier edit.
          inFlight = call.callId;
          const result: ToolResult =
            action && blockedActions.has(action)
              ? {
                  callId: call.callId,
                  name: call.name,
                  ok: false,
                  content: '恢复历史中已有相同修改动作；未重放。请先核对外部状态。',
                  error: {
                    code: 'ACTION_REPLAY_BLOCKED',
                    message: '已记录的修改动作不能在恢复中重放。',
                  },
                }
              : replan
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
                : this.executor.registry.isHidden(call.name)
                  ? {
                      callId: call.callId,
                      name: call.name,
                      ok: false,
                      content: '工具不对模型开放。',
                      error: { code: 'TOOL_NOT_FOUND', message: '工具不对模型开放。' },
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
          result.agentId = this.executor.agentId;
          this.options.onToolResult?.(structuredClone(result));
          const compactResult = this.options.session
            ? await this.options.session.spill(result, context.toolResultBytes)
            : inlineResult(result, context.toolResultBytes);
          this.messages.push({
            role: 'tool',
            callId: call.callId,
            content: JSON.stringify(compactResult),
          });
          pending.shift();
          inFlight = undefined;
          await checkpoint('result');
          yield { type: 'tool_result', result: compactResult };
          this.checkCancelled(combined);
          if (failures >= (this.options.maxFailures ?? 3)) {
            status = 'stopped';
            yield await finish('repeated_failures');
            return;
          }
        }
      }
      turns = this.options.maxTurns;
      status = 'stopped';
      yield await finish('max_turns');
    } catch (error) {
      endReason = 'error';
      if (timedOut && !signal.aborted)
        throw new AppError('MODEL_TIMEOUT', 'Agent 任务达到总时间限制；已完成的操作保留。');
      if (signal.aborted) throw new AppError('CANCELLED', 'Agent 任务已取消；已完成的操作保留。');
      if (error instanceof ToolError)
        throw new AppError(
          'HOOK_FAILED',
          '生命周期Hook阻止任务；已完成的操作保留，请检查Hook审计。',
        );
      if (error instanceof AppError) throw error;
      throw new AppError('MODEL_PROTOCOL', 'Agent 模型响应无效；已完成的操作保留。');
    } finally {
      reservation?.cancel();
      await this.executor
        .dispatchHook(
          'SessionEnd',
          {
            reason: combined.aborted
              ? 'cancelled'
              : (endReason ?? (status === 'running' ? 'interrupted' : status)),
          },
          combined,
        )
        .catch(() => {});
      // Preserve complete call/result pairs even if the consumer stops mid-batch.
      for (const call of pending)
        this.messages.push({
          role: 'tool',
          callId: call.callId,
          content: JSON.stringify({
            callId: call.callId,
            name: call.name,
            ok: false,
            content:
              call.callId === inFlight
                ? '调用完成状态不确定，恢复时不会重放。'
                : '任务停止，此调用未执行。',
            error: {
              code: call.callId === inFlight ? 'ACTION_UNCERTAIN' : 'AGENT_STOPPED',
              message:
                call.callId === inFlight
                  ? '调用完成状态不确定，需核对外部状态。'
                  : '任务停止，此调用未执行。',
            },
          }),
        });
      clearTimeout(timer);
      controller.abort();
      this.busy = false;
      if (status === 'running') {
        status = inFlight ? 'uncertain' : 'stopped';
        await checkpoint('finish').catch(() => {});
      }
    }
  }

  private checkCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new AppError('CANCELLED', 'Agent 任务已取消。');
  }

  private async *modelStream(
    request: LLMRequest,
    signal: AbortSignal,
    ticket: ReturnType<TokenBudget['reserve']> | undefined,
    inputEstimate: number,
  ): AsyncIterable<LLMEvent> {
    if (!ticket) {
      yield* this.provider.stream(request, signal);
      return;
    }
    let usage: Extract<LLMEvent, { type: 'usage' }> | undefined;
    let outputBytes = 0;
    if (signal.aborted) {
      ticket.cancel();
      this.checkCancelled(signal);
    }
    try {
      for await (const event of this.provider.stream(request, signal)) {
        if (event.type === 'text_delta') outputBytes += Buffer.byteLength(event.text);
        if (event.type === 'tool_call_delta')
          outputBytes += Buffer.byteLength(event.arguments ?? '') + 32;
        if (event.type === 'continuation')
          outputBytes += Buffer.byteLength(JSON.stringify(event.items));
        if (
          event.type === 'usage' &&
          !usage &&
          Number.isSafeInteger(event.inputTokens) &&
          Number.isSafeInteger(event.outputTokens) &&
          event.inputTokens >= 0 &&
          event.outputTokens >= 0
        )
          usage = event;
        if (event.type === 'finish' && !usage) {
          usage = {
            type: 'usage',
            inputTokens: inputEstimate,
            outputTokens: outputBytes,
            estimated: true,
          };
          yield usage;
        }
        yield event;
      }
    } finally {
      ticket.settle(usage);
    }
  }
}
