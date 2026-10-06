import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { evaluatePermission } from '../security/policy.js';
import type { ScopedPermissionRule } from '../security/rules.js';
import type { PermissionDecision } from '../security/policy.js';
import { permissionRuleSchema } from '../security/rules.js';
import type { PermissionAudit } from '../security/audit.js';
import { ProjectPaths } from '../security/paths.js';
import { checkCancelled, ToolError } from './errors.js';
import type { ToolRegistry } from './registry.js';
import type {
  ApprovalAnswer,
  ApprovalRequest,
  ToolCall,
  ToolContext,
  ToolMode,
  ToolResult,
} from './types.js';

export interface ExecutorOptions {
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

  private lineage(): string {
    return `${this.parent?.lineage() ?? ''}/${this.mode}:${this.policyEpoch}`;
  }

  get mode(): ToolMode {
    return this.currentMode;
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
      ...(this.parent ? { parentMode: this.parent.mode } : {}),
    };
  }

  setMode(mode: ToolMode): void {
    if (!['plan', 'default', 'accept-edits'].includes(mode))
      throw new ToolError('TOOL_INPUT', '权限模式无效。');
    if (this.active) throw new ToolError('BUSY', '工具执行或审批期间不能切换模式。');
    if (this.parent && modeRank(mode) > modeRank(this.parent.mode))
      throw new ToolError('TOOL_PERMISSION', '子执行器不能提升父权限。');
    this.currentMode = mode;
    this.policyEpoch++;
    this.grants.clear();
  }

  async fork(options: Omit<ExecutorOptions, 'root'> = {}): Promise<ToolExecutor> {
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
    const child = await ToolExecutor.create(this.registry, {
      ...options,
      shell: this.shell,
      rgExecutable: this.options.rgExecutable ?? 'rg',
      audit: async (record) => {
        await this.options.audit?.(record);
        if (options.audit && options.audit !== this.options.audit) await options.audit(record);
      },
      root: this.paths.root,
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
    });
  }

  async execute(call: ToolCall, signal = new AbortController().signal): Promise<ToolResult> {
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
      const recursive = tool.name === 'Glob' || tool.name === 'Grep';
      const globParts = typeof fields.pattern === 'string' ? fields.pattern.split('/') : [];
      const wildcard = globParts.findIndex((part) => /[*?[\]{}()]/.test(part));
      const rawPath =
        tool.name === 'Glob'
          ? (wildcard < 0 ? globParts.slice(0, -1) : globParts.slice(0, wildcard)).join('/') || '.'
          : tool.effect === 'external'
            ? '.'
            : typeof fields.path === 'string'
              ? fields.path
              : typeof fields.cwd === 'string'
                ? fields.cwd
                : '.';
      // Resolve scope lexically first. Builtin prepare and run still validate filesystem state.
      const local = this.paths.display(resolve(this.paths.root, rawPath));
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
        paths: this.paths,
        signal: combined,
        shell: this.shell,
        rgExecutable: this.options.rgExecutable ?? 'rg',
      };
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
      const payload = await prepared.run();
      if (tool.effect !== 'write') checkCancelled(combined);
      return { callId: call.callId, name: tool.name, ok: payload.error === undefined, ...payload };
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
