import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { evaluatePermission } from '../security/policy.js';
import type { ScopedPermissionRule } from '../security/rules.js';
import type { PermissionDecision } from '../security/policy.js';
import { permissionRuleSchema } from '../security/rules.js';
import type { PermissionAudit } from '../security/audit.js';
import { ProjectPaths } from '../security/paths.js';
import type { WorktreeBinding } from './worktree-schema.js';
import { checkCancelled, ToolError } from './errors.js';
import type { HookHandler, HookEvent } from './hook-types.js';
import type { HookEventName } from './hook-schema.js';
import type { ToolRegistry } from './registry.js';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  ToolCall,
  ToolContext,
  ToolMode,
  ToolResult,
  ToolDefinition,
} from './types.js';

export interface ExecutorOptions {
  workspaceBinding?: WorktreeBinding;
  agentId?: string;
  allowTools?: readonly string[];
  hooks?: HookHandler;
  root: string;
  mode?: ToolMode;
  timeoutMs?: number;
  denyTools?: readonly string[];
  rules?: readonly ScopedPermissionRule[];
  approve?: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>;
  audit?: (record: Readonly<PermissionAudit>) => Promise<void>;
  shell?: ToolContext['shell'];
  rgExecutable?: string;
}

export class ToolExecutor {
  private readonly usedCalls = new Set<string>();
  private mutating = false;
  private active = 0;
  private currentMode: ToolMode;
  private readonly grants = new Set<string>();
  private readonly records: PermissionAudit[] = [];
  private parent?: ToolExecutor;
  private policyEpoch = 0;
  private readonly executorId = randomUUID();
  private hookQueue: Promise<void> = Promise.resolve();
  private queuedHooks = 0;

  private lineage(): string {
    return `${this.parent?.lineage() ?? ''}/${this.mode}:${this.policyEpoch}`;
  }

  get mode(): ToolMode {
    return this.currentMode;
  }

  get agentId(): string {
    return this.options.agentId ?? this.executorId;
  }

  private allowsTool(name: string): boolean {
    return (
      (!this.options.allowTools || this.options.allowTools.includes(name)) &&
      (!this.parent || this.parent.allowsTool(name))
    );
  }

  definitions() {
    return this.registry.definitions().filter((tool) => this.allowsTool(tool.name));
  }

  get auditLog(): readonly PermissionAudit[] {
    return structuredClone(this.records);
  }

  allowsInstruction(path: string): boolean {
    return this.decision('ReadFile', 'read', this.paths.display(path), false).decision === 'allow';
  }

  allowsRead(name: string, path: string): boolean {
    return this.decision(name, 'read', this.paths.display(path), false).decision === 'allow';
  }

  get policyMetadata() {
    return {
      rules: structuredClone(this.options.rules ?? []),
      denyTools: [...(this.options.denyTools ?? [])],
      ...(this.options.allowTools ? { allowTools: [...this.options.allowTools] } : {}),
      ...(this.parent ? { parentMode: this.parent.mode } : {}),
    };
  }

  setMode(mode: ToolMode): void {
    if (!['plan', 'default', 'accept-edits'].includes(mode))
      throw new ToolError('TOOL_INPUT', '权限模式无效。');
    if (this.active || this.queuedHooks)
      throw new ToolError('BUSY', '工具执行或审批期间不能切换模式。');
    if (this.parent && modeRank(mode) > modeRank(this.parent.mode))
      throw new ToolError('TOOL_PERMISSION', '子执行器不能提升父权限。');
    this.currentMode = mode;
    this.policyEpoch++;
    this.grants.clear();
  }

  async fork(options: Omit<ExecutorOptions, 'root'> = {}): Promise<ToolExecutor> {
    return this.forkAt(this.paths.root, options);
  }
  async forkWithTools(
    additions: readonly ToolDefinition[],
    options: Omit<ExecutorOptions, 'root'> = {},
  ): Promise<ToolExecutor> {
    return this.forkAt(
      this.paths.root,
      {
        ...options,
        ...(!options.approve && this.options.approve ? { approve: this.options.approve } : {}),
      },
      this.registry.withTools(additions),
    );
  }
  async forkForWorktree(
    binding: WorktreeBinding,
    options: Omit<ExecutorOptions, 'root' | 'workspaceBinding' | 'agentId'> = {},
    signal = new AbortController().signal,
  ): Promise<ToolExecutor> {
    if (binding.repository !== this.paths.root)
      throw new ToolError('WORKTREE_OWNER', '工作树不属于当前父执行器。');
    await binding.verify(signal);
    return this.forkAt(binding.root, {
      ...options,
      agentId: binding.agentId,
      workspaceBinding: binding,
    });
  }
  private async forkAt(
    root: string,
    options: Omit<ExecutorOptions, 'root'>,
    registry = this.registry,
  ): Promise<ToolExecutor> {
    const mode = options.mode ?? this.mode;
    if (modeRank(mode) > modeRank(this.mode))
      throw new ToolError('TOOL_PERMISSION', '子执行器不能提升父权限。');
    if (
      (options.shell &&
        (options.shell.kind !== this.shell.kind ||
          options.shell.executable !== this.shell.executable)) ||
      (options.rgExecutable && options.rgExecutable !== (this.options.rgExecutable ?? 'rg'))
    )
      throw new ToolError('TOOL_PERMISSION', '子执行器不能替换父执行程序。');
    const child = await ToolExecutor.create(registry, {
      ...options,
      ...(this.options.hooks ? { hooks: this.options.hooks } : {}),
      shell: this.shell,
      rgExecutable: this.options.rgExecutable ?? 'rg',
      audit: async (record) => {
        await this.options.audit?.(record);
        if (options.audit && options.audit !== this.options.audit) await options.audit(record);
      },
      root,
      ...(this.options.workspaceBinding ? { workspaceBinding: this.options.workspaceBinding } : {}),
      mode,
      timeoutMs: Math.min(
        options.timeoutMs ?? this.options.timeoutMs ?? 60_000,
        this.options.timeoutMs ?? 60_000,
      ),
      rules: [...(this.options.rules ?? []), ...(options.rules ?? [])],
      denyTools: [...(this.options.denyTools ?? []), ...(options.denyTools ?? [])],
    });
    child.parent = this;
    return child;
  }

  private decision(
    name: string,
    effect: ToolContextEffect,
    path: string,
    recursive: boolean,
  ): PermissionDecision {
    if (!this.allowsTool(name))
      return { decision: 'deny', reason: 'deny-tool', sources: ['whitelist'] };
    const result = evaluatePermission(
      this.mode,
      name,
      effect,
      this.options.denyTools ?? [],
      this.options.rules ?? [],
      path,
      recursive,
    );
    const parent = this.parent?.decision(name, effect, path, recursive);
    if (name === 'HookScript') {
      const shell = this.decision('Bash', 'shell', path, recursive);
      if (shell.decision === 'deny') return shell;
    }
    if (parent?.decision === 'deny' || (parent?.decision === 'ask' && result.decision === 'allow'))
      return { ...parent, sources: [...parent.sources, 'parent'] };
    return result;
  }

  private async record(
    call: ToolCall,
    effect: ToolContextEffect,
    fingerprint: string,
    result: ReturnType<typeof evaluatePermission>,
    authorization: PermissionAudit['authorization'],
    signal: AbortSignal,
    cached = false,
  ) {
    if (this.records.length >= 10_000)
      throw new ToolError('TOOL_LIMIT', '权限审计达到10000条上限。');
    const record: PermissionAudit = {
      agentId: this.agentId,
      version: 1,
      executorId: this.executorId,
      sequence: this.records.length + 1,
      timestamp: new Date().toISOString(),
      callIdHash: createHash('sha256').update(call.callId).digest('hex'),
      name: call.name,
      effect,
      mode: this.mode,
      ...result,
      fingerprint,
      authorization,
      cached,
    };
    this.records.push(structuredClone(record));
    try {
      if (this.options.audit)
        await abortable(
          this.options.audit(
            Object.freeze({ ...record, sources: Object.freeze([...record.sources]) }),
          ),
          signal,
        );
    } catch {
      throw new ToolError('AUDIT_FAILED', '权限审计记录失败，本次动作未执行。');
    }
  }

  get shell(): ToolContext['shell'] {
    return this.options.shell
      ? { ...this.options.shell }
      : {
          kind: process.platform === 'win32' ? 'powershell' : 'bash',
          executable: process.platform === 'win32' ? 'powershell.exe' : '/bin/bash',
        };
  }

  private constructor(
    readonly registry: ToolRegistry,
    readonly paths: ProjectPaths,
    private readonly options: ExecutorOptions,
  ) {
    this.currentMode = options.mode ?? 'default';
  }

  static async create(registry: ToolRegistry, options: ExecutorOptions): Promise<ToolExecutor> {
    if (
      (options.agentId && !/^[\w.-]{1,128}$/.test(options.agentId)) ||
      (options.allowTools &&
        (options.allowTools.length > 64 ||
          options.allowTools.some((name) => !/^[\w.-]{1,128}$/.test(name))))
    )
      throw new ToolError('TOOL_INPUT', '执行器身份或工具白名单无效。');
    if (
      !['plan', 'default', 'accept-edits'].includes(options.mode ?? 'default') ||
      !Number.isSafeInteger(options.timeoutMs ?? 60_000) ||
      (options.timeoutMs ?? 60_000) < 1 ||
      (options.timeoutMs ?? 60_000) > 3_600_000
    )
      throw new ToolError('TOOL_INPUT', '执行器模式或时限无效。');
    const rules = (options.rules ?? []).map((rule) => ({
      ...permissionRuleSchema.parse({
        decision: rule.decision,
        tool: rule.tool,
        effect: rule.effect,
        path: rule.path,
      }),
      source: rule.source,
    }));
    if (
      rules.length > 400 ||
      rules.some((rule) => !['user', 'project', 'cli', 'parent'].includes(rule.source))
    )
      throw new ToolError('TOOL_INPUT', '权限规则数量或来源无效。');
    const deniedScopes = rules
      .filter(
        (rule) =>
          rule.decision === 'deny' &&
          rule.path &&
          (!rule.effect || rule.effect === 'read') &&
          (!rule.tool || rule.tool === 'ReadFile'),
      )
      .map((rule) => rule.path!);
    return new ToolExecutor(registry, await ProjectPaths.create(options.root, deniedScopes), {
      ...options,
      rules,
      ...(options.shell ? { shell: { ...options.shell } } : {}),
      denyTools: [...(options.denyTools ?? [])],
      ...(options.allowTools ? { allowTools: [...options.allowTools] } : {}),
    });
  }

  async dispatchHook(
    event: HookEventName,
    fields: Pick<HookEvent, 'tool' | 'result' | 'reason'> = {},
    signal = new AbortController().signal,
  ) {
    if (!this.options.hooks) return { decision: 'continue' as const };
    if (event !== 'SessionEnd') await this.options.workspaceBinding?.verify(signal);
    const decision = await this.options.hooks(
      {
        version: 1,
        event,
        eventId: randomUUID(),
        sessionId: this.executorId,
        agentId: this.agentId,
        mode: this.mode,
        ...structuredClone(fields),
      },
      {
        mode: this.mode,
        root: this.paths.root,
        allowsScript: (path) => this.allowsInstruction(path),
        executeScript: (invocationId, innerSignal) =>
          this.executeChecked(
            { callId: randomUUID(), name: 'HookScript', input: { invocationId } },
            innerSignal,
          ),
      },
      signal,
    );
    if (decision.decision === 'block') throw new ToolError('HOOK_BLOCKED', 'Hook阻止本次动作。');
    return decision;
  }

  async execute(call: ToolCall, signal = new AbortController().signal): Promise<ToolResult> {
    if (call.name === 'HookScript')
      return this.failure(call, 'TOOL_NOT_FOUND', '内部Hook工具不接受直接调用。');
    if (!this.options.hooks) return this.executeChecked(call, signal);
    // Hook transactions stay FIFO, including post notifications; script execution cannot recurse.
    if (this.queuedHooks >= 8) return this.failure(call, 'BUSY', 'Hook工具队列达到8次上限。');
    this.queuedHooks++;
    const previous = this.hookQueue;
    let release!: () => void;
    this.hookQueue = new Promise<void>((done) => {
      release = done;
    });
    const combined = AbortSignal.any([
      signal,
      AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    ]);
    let acquired = false;
    try {
      call = { callId: call.callId, name: call.name, input: structuredClone(call.input) };
      await this.options.workspaceBinding?.verify(combined);
      await abortable(previous, combined);
      acquired = true;
      checkCancelled(combined);
      if (this.usedCalls.has(call.callId)) throw new ToolError('TOOL_DUPLICATE', 'callId已使用。');
      if (!/^[\w.-]{1,128}$/.test(call.callId))
        throw new ToolError('TOOL_INPUT', 'callId格式无效。');
      const tool = this.registry.get(call.name);
      const input = tool.schema.parse(structuredClone(call.input));
      // Validate the original request and deny policies before running any script.
      const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      const { local: scope, recursive } = this.requestScope(tool.name, tool.effect, fields);
      if (this.decision(tool.name, tool.effect, scope, recursive).decision === 'deny')
        return await this.executeChecked(call, combined);
      const policyVersion = this.lineage();
      const before = await this.dispatchHook('PreToolUse', { tool: { ...call, input } }, combined);
      if (this.lineage() !== policyVersion)
        throw new ToolError('TOOL_PERMISSION', 'Hook期间权限变化，拒绝执行。');
      call = { ...call, input: before.updatedInput ?? input };
      // executeChecked repeats Schema, path, preparation, fingerprint, approval and policy checks.
      const result = await this.executeChecked(call, combined);
      await this.dispatchHook(
        'PostToolUse',
        {
          tool: { callId: call.callId, name: call.name, input: undefined },
          result: { ok: result.ok, ...(result.error ? { errorCode: result.error.code } : {}) },
        },
        combined,
      ).catch(() => {});
      return result;
    } catch (error) {
      const code = signal.aborted
        ? 'CANCELLED'
        : combined.aborted
          ? 'TOOL_TIMEOUT'
          : error instanceof ToolError
            ? error.code
            : error instanceof z.ZodError
              ? 'TOOL_INPUT'
              : 'HOOK_FAILED';
      // Consume blocked ids as well, so a repeated id cannot rerun an approved script.
      if (/^[\w.-]{1,128}$/.test(call.callId) && this.usedCalls.size < 10_000)
        this.usedCalls.add(call.callId);
      return this.failure(call, code, 'Hook或工具校验未通过，本次工具未执行。');
    } finally {
      this.queuedHooks--;
      if (acquired) release();
      else void previous.then(release);
    }
  }

  private failure(call: ToolCall, code: string, message: string): ToolResult {
    return {
      agentId: this.agentId,
      callId: call.callId,
      name: call.name,
      ok: false,
      content: message,
      error: { code, message },
    };
  }

  private requestScope(name: string, effect: ToolContextEffect, fields: Record<string, unknown>) {
    const recursive = name === 'Glob' || name === 'Grep';
    const parts = typeof fields.pattern === 'string' ? fields.pattern.split('/') : [];
    const wildcard = parts.findIndex((part) => /[*?[\]{}()]/.test(part));
    const rawPath =
      name === 'Glob'
        ? (wildcard < 0 ? parts.slice(0, -1) : parts.slice(0, wildcard)).join('/') || '.'
        : effect === 'external'
          ? '.'
          : typeof fields.path === 'string'
            ? fields.path
            : typeof fields.cwd === 'string'
              ? fields.cwd
              : '.';
    return { recursive, local: this.paths.display(resolve(this.paths.root, rawPath)) };
  }

  private async executeChecked(
    call: ToolCall,
    signal = new AbortController().signal,
  ): Promise<ToolResult> {
    let locked = false;
    let entered = false;
    let timedOut = false;
    const controller = new AbortController();
    const combined = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs ?? 60_000);
    timer.unref();
    try {
      call = { callId: call.callId, name: call.name, input: call.input };
      checkCancelled(combined);
      if (!/^[\w.-]{1,128}$/.test(call.callId))
        throw new ToolError('TOOL_INPUT', 'callId格式无效。');
      if (this.usedCalls.has(call.callId)) throw new ToolError('TOOL_DUPLICATE', 'callId已使用。');
      if (this.usedCalls.size >= 10_000)
        throw new ToolError('TOOL_LIMIT', '工具会话调用数量已达上限。');
      this.usedCalls.add(call.callId);
      if (this.active >= 8) throw new ToolError('BUSY', '最多同时运行8个工具调用。');
      this.active += 1;
      entered = true;
      const tool = this.registry.get(call.name);
      const policyVersion = this.lineage();
      const input = freezeDeep(tool.schema.parse(structuredClone(call.input)));
      const fields = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
      // Resolve scope lexically first. Builtin prepare/run validate filesystem state again.
      const { local, recursive } = this.requestScope(tool.name, tool.effect, fields);
      let decision = this.decision(tool.name, tool.effect, local, recursive);
      if (decision.decision === 'deny') {
        const fingerprint = createHash('sha256')
          .update(stable({ name: tool.name, input, target: local, policyVersion }))
          .digest('hex');
        await this.record(call, tool.effect, fingerprint, decision, 'policy', combined);
        throw new ToolError('TOOL_PERMISSION', '当前策略禁止此工具或范围；请缩小目标范围。');
      }
      if (tool.effect !== 'read') {
        if (this.mutating) throw new ToolError('BUSY', '另一个修改或命令调用尚未结束。');
        this.mutating = true;
        locked = true;
      }
      const context: ToolContext = {
        agentId: this.agentId,
        paths: this.paths,
        signal: combined,
        shell: this.shell,
        rgExecutable: this.options.rgExecutable ?? 'rg',
      };
      await this.options.workspaceBinding?.verify(combined);
      const prepared = await tool.prepare(input, context);
      checkCancelled(combined);
      const actualScope = tool.name === 'Glob' ? local : this.paths.display(prepared.target);
      decision = this.decision(tool.name, tool.effect, actualScope, recursive);
      const fingerprint = createHash('sha256')
        .update(
          stable({
            name: tool.name,
            input,
            target: prepared.target,
            preview: prepared.preview,
            authorizationKey: prepared.authorizationKey,
            shell: this.shell,
            policyVersion,
          }),
        )
        .digest('hex');
      if (decision.decision === 'deny') {
        await this.record(call, tool.effect, fingerprint, decision, 'policy', combined);
        throw new ToolError('TOOL_PERMISSION', '当前策略禁止最终工具目标。');
      }
      let authorization: PermissionAudit['authorization'] = 'policy';
      const cached = decision.decision === 'ask' && this.grants.has(fingerprint);
      if (cached) authorization = 'session';
      else if (decision.decision === 'ask') {
        const request = Object.freeze({
          agentId: this.agentId,
          callId: call.callId,
          name: tool.name,
          effect: tool.effect,
          input: freezeDeep(structuredClone(input)),
          target: prepared.target,
          preview: prepared.preview,
          cwd: tool.effect === 'shell' ? prepared.target : dirname(prepared.target),
          shell: Object.freeze(this.shell),
          mode: this.mode,
          fingerprint,
          scope: 'exact-input' as const,
        });
        if (!this.options.approve) {
          await this.record(call, tool.effect, fingerprint, decision, 'unavailable', combined);
          throw new ToolError('TOOL_PERMISSION', '此操作需要用户授权；当前没有审批入口。');
        }
        let answer: ApprovalAnswer;
        try {
          answer = await abortable(this.options.approve(request, combined), combined);
        } catch (error) {
          await this.record(call, tool.effect, fingerprint, decision, 'refused', combined);
          throw error;
        }
        const allowed =
          answer === true ||
          (typeof answer === 'object' &&
            answer !== null &&
            answer.allow === true &&
            ['once', 'session'].includes(answer.scope));
        if (!allowed) {
          await this.record(call, tool.effect, fingerprint, decision, 'refused', combined);
          throw new ToolError('TOOL_PERMISSION', '用户拒绝了此操作。');
        }
        authorization =
          typeof answer === 'object' && answer.scope === 'session' ? 'session' : 'once';
      }
      checkCancelled(combined);
      await this.record(call, tool.effect, fingerprint, decision, authorization, combined, cached);
      checkCancelled(combined);
      // Parent may be tightened while approval was pending.
      if (
        this.lineage() !== policyVersion ||
        this.decision(tool.name, tool.effect, actualScope, recursive).decision === 'deny'
      ) {
        await this.record(
          call,
          tool.effect,
          fingerprint,
          { decision: 'deny', reason: 'mode', sources: ['parent'] },
          'policy',
          combined,
        );
        throw new ToolError('TOOL_PERMISSION', '执行前父权限已变化，拒绝操作。');
      }
      if (authorization === 'session') this.grants.add(fingerprint);
      await this.options.workspaceBinding?.verify(combined);
      const payload = await prepared.run();
      if (tool.effect !== 'write') checkCancelled(combined);
      return {
        callId: call.callId,
        name: tool.name,
        ok: payload.error === undefined,
        ...payload,
        agentId: this.agentId,
      };
    } catch (error) {
      const normalized = timedOut
        ? new ToolError('TOOL_TIMEOUT', '工具调用超过总时间限制。')
        : signal.aborted
          ? new ToolError('CANCELLED', '工具调用已取消。')
          : error instanceof ToolError
            ? error
            : error instanceof z.ZodError
              ? new ToolError('TOOL_INPUT', '工具参数不符合Schema。')
              : new ToolError('TOOL_FAILED', '工具操作失败，请检查目标权限与运行环境。');
      return {
        agentId: this.agentId,
        callId: call.callId,
        name: call.name,
        ok: false,
        content: normalized.message,
        error: { code: normalized.code, message: normalized.message },
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
      if (locked) this.mutating = false;
      if (entered) this.active -= 1;
    }
  }
}

type ToolContextEffect = 'read' | 'write' | 'shell' | 'external';
function modeRank(mode: ToolMode): number {
  return { plan: 0, default: 1, 'accept-edits': 2 }[mode];
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ':' + stable((value as Record<string, unknown>)[key]))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}

function freezeDeep(input: unknown): unknown {
  if (input && typeof input === 'object') {
    for (const value of Object.values(input)) freezeDeep(value);
    Object.freeze(input);
  }
  return input;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) void promise.catch(() => {});
  checkCancelled(signal);
  let cancel: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new ToolError('CANCELLED', '工具调用已取消。'));
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
