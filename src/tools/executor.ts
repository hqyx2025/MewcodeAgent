import { z } from 'zod';
import { permissionDecision } from '../security/policy.js';
import { ProjectPaths } from '../security/paths.js';
import { checkCancelled, ToolError } from './errors.js';
import type { ToolRegistry } from './registry.js';
import type { ApprovalRequest, ToolCall, ToolContext, ToolMode, ToolResult } from './types.js';

export interface ExecutorOptions {
  root: string;
  mode?: ToolMode;
  timeoutMs?: number;
  denyTools?: readonly string[];
  approve?: (request: ApprovalRequest, signal: AbortSignal) => Promise<boolean>;
  shell?: ToolContext['shell'];
  rgExecutable?: string;
}

export class ToolExecutor {
  private readonly usedCalls = new Set<string>();
  private mutating = false;
  private active = 0;

  get mode(): ToolMode {
    return this.options.mode ?? 'default';
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
  ) {}

  static async create(registry: ToolRegistry, options: ExecutorOptions): Promise<ToolExecutor> {
    return new ToolExecutor(registry, await ProjectPaths.create(options.root), {
      ...options,
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
      const input = tool.schema.parse(structuredClone(call.input));
      const decision = permissionDecision(
        this.options.mode ?? 'default',
        tool.name,
        tool.effect,
        this.options.denyTools ?? [],
      );
      if (decision === 'deny') throw new ToolError('TOOL_PERMISSION', '当前策略禁止此工具。');
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
      if (decision === 'ask') {
        const request = Object.freeze({
          callId: call.callId,
          name: tool.name,
          effect: tool.effect,
          input: freezeDeep(structuredClone(input)),
          target: prepared.target,
          preview: prepared.preview,
        });
        if (!this.options.approve)
          throw new ToolError('TOOL_PERMISSION', '此操作需要用户授权；当前没有审批入口。');
        if (!(await abortable(this.options.approve(request, combined), combined)))
          throw new ToolError('TOOL_PERMISSION', '用户拒绝了此操作。');
      }
      checkCancelled(combined);
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

function freezeDeep(input: unknown): unknown {
  if (input && typeof input === 'object') {
    for (const value of Object.values(input)) freezeDeep(value);
    Object.freeze(input);
  }
  return input;
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
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
