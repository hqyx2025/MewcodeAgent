import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { readBoundedText } from '../shared/bounded-files.js';
import { redactInstruction } from '../shared/redact.js';
import { checkCancelled, ToolError } from './errors.js';
import { hookOutputSchema, hookSettingsSchema } from './hook-schema.js';
import type { HookConfiguration, HookDecision } from './hook-schema.js';
import type { HookAudit, HookEvent, HookHandler, HookHost } from './hook-types.js';
import type { ToolRegistry } from './registry.js';
import { processEnvironment, runProcess } from './process.js';

interface Invocation {
  hook: HookConfiguration;
  event: HookEvent;
  host: HookHost;
  stdin: string;
  env: NodeJS.ProcessEnv;
}

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
// A small fixed bootstrap avoids Windows' command-line limit. The approved source
// arrives over the pipe; the hook itself sees only the event through process.stdin.
const bootstrap = `import { Readable } from 'node:stream';
let envelope = ''; for await (const chunk of process.stdin) envelope += chunk;
const { source, event } = JSON.parse(envelope);
Object.defineProperty(process, 'stdin', { value: Readable.from([event]) });
await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));`;

/** Local configuration only: no model-facing registration or script output injection. */
export class HookRuntime {
  private readonly pending = new Map<string, Invocation>();
  private readonly records: HookAudit[] = [];
  private readonly configurations: HookConfiguration[];

  constructor(
    registry: ToolRegistry,
    configurations: readonly HookConfiguration[],
    private readonly options: {
      env?: NodeJS.ProcessEnv;
      sensitiveValues?: readonly string[];
      audit?: (record: Readonly<HookAudit>) => Promise<void>;
    } = {},
  ) {
    this.configurations = hookSettingsSchema.parse(structuredClone(configurations));
    if (!this.configurations.length) return;
    registry.register({
      hidden: true,
      name: 'HookScript',
      description: '本地主机生命周期脚本；完整脚本摘要及事件需单独审批。',
      effect: 'shell',
      schema: z.strictObject({ invocationId: z.string().uuid() }),
      prepare: async (input, context) => {
        const { invocationId } = input as { invocationId: string };
        const invocation = this.pending.get(invocationId);
        if (!invocation) throw new ToolError('HOOK_INVALID', 'Hook调用不属于当前主机事件。');
        const { hook, event, host, stdin, env } = invocation;
        const path = await context.paths.resolve(hook.script);
        if (!host.allowsScript(path))
          throw new ToolError('TOOL_PERMISSION', 'Hook脚本读取被策略禁止或需要单独授权。');
        const source = await readBoundedText(path, 64 * 1024, undefined, context.signal);
        if (source.includes('\0')) throw new ToolError('HOOK_INVALID', 'Hook脚本不是有效文本。');
        const digest = hash(source);
        return {
          target: context.paths.root,
          preview: `Node Hook ${hook.id} / ${event.event}: ${context.paths.display(path)}\n执行文件：${process.execPath}\nSHA256: ${digest}\n显式环境变量：${hook.env.join(', ') || '无'}；stdin仅含本次事件；脚本可执行任意主机操作。`,
          authorizationKey: hash(
            JSON.stringify({ digest, stdin, env, executable: process.execPath }),
          ),
          run: async () => {
            checkCancelled(context.signal);
            if (host.mode === 'plan' || !host.allowsScript(path))
              throw new ToolError('TOOL_PERMISSION', '执行前Hook权限已变化。');
            await context.paths.resolve(path);
            if (hash(await readBoundedText(path, 64 * 1024, undefined, context.signal)) !== digest)
              throw new ToolError('HOOK_CHANGED', '审批后Hook脚本已变化，本次未执行。');
            // Execute the approved snapshot so replacing a file cannot change the approved code.
            const output = await runProcess({
              executable: process.execPath,
              args: ['--input-type=module', '--eval', bootstrap],
              cwd: context.paths.root,
              signal: context.signal,
              timeoutMs: hook.timeoutMs,
              maxBytes: 16 * 1024,
              stdin: JSON.stringify({ source, event: stdin }),
              env,
            });
            if (output.truncated) throw new ToolError('HOOK_OUTPUT_LIMIT', 'Hook输出超过16KiB。');
            if (output.exitCode !== 0) throw new ToolError('HOOK_FAILED', 'Hook脚本非零退出。');
            let decision: HookDecision;
            try {
              decision = hookOutputSchema.parse(JSON.parse(output.stdout) as unknown);
              if (
                decision.updatedInput !== undefined &&
                (event.event !== 'PreToolUse' || decision.decision !== 'continue')
              )
                throw new Error('Invalid event decision');
              if (
                decision.updatedInput &&
                JSON.stringify(this.scrub(decision.updatedInput, true)) !==
                  JSON.stringify(decision.updatedInput)
              )
                throw new Error('Credentials in updated input');
            } catch {
              throw new ToolError('HOOK_INVALID', 'Hook输出必须是本事件允许的结构化JSON。');
            }
            return { content: 'Hook脚本完成。', data: decision };
          },
        };
      },
    });
  }

  get auditLog(): readonly HookAudit[] {
    return structuredClone(this.records);
  }

  private scrub(value: unknown, scrubKeys = false): unknown {
    const secrets = [
      ...(this.options.sensitiveValues ?? []),
      ...this.configurations
        .flatMap((configured) => configured.env)
        .map((name) => (this.options.env ?? process.env)[name])
        .filter((item): item is string => !!item),
    ];
    const visit = (item: unknown): unknown => {
      if (typeof item === 'string') {
        let safe = redactInstruction(item);
        for (const secret of secrets)
          safe =
            secret.length >= 12
              ? safe.replaceAll(secret, '[REDACTED]')
              : safe === secret
                ? '[REDACTED]'
                : safe;
        return safe;
      }
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === 'object')
        return Object.fromEntries(
          Object.entries(item).map(([key, field]) => [scrubKeys ? visit(key) : key, visit(field)]),
        );
      return item;
    };
    return visit(value);
  }

  readonly handle: HookHandler = async (event, host, signal) => {
    const matches = this.configurations.filter(
      (hook) => hook.event === event.event && (!hook.tool || hook.tool === event.tool?.name),
    );
    let updatedInput: HookDecision['updatedInput'];
    for (const hook of matches) {
      const start = performance.now();
      let outcome: HookAudit['outcome'] = 'error';
      let code: string | undefined;
      let invocationId: string | undefined;
      try {
        checkCancelled(signal);
        if (host.mode === 'plan') throw new ToolError('TOOL_PERMISSION', 'Plan模式禁止Hook脚本。');
        if (this.records.length + this.pending.size >= 10_000)
          throw new ToolError('HOOK_LIMIT', 'Hook审计数量达到上限。');
        const env = processEnvironment();
        for (const name of hook.env) {
          const value = (this.options.env ?? process.env)[name];
          if (value === undefined) throw new ToolError('HOOK_ENV', 'Hook显式环境变量未配置。');
          env[name] = value;
        }
        const current: HookEvent = structuredClone(event);
        if (updatedInput && current.tool) current.tool.input = updatedInput;
        if (Buffer.byteLength(JSON.stringify(env)) > 32 * 1024)
          throw new ToolError('HOOK_ENV', 'Hook环境变量超过32KiB。');
        // Scrub string values before serialization, preserving JSON syntax and property names.
        const stdin = JSON.stringify(this.scrub(current));
        if (Buffer.byteLength(stdin) > 64 * 1024)
          throw new ToolError('HOOK_INPUT_LIMIT', 'Hook事件超过64KiB，未执行脚本。');
        invocationId = randomUUID();
        this.pending.set(invocationId, { hook, event: current, host, stdin: stdin + '\n', env });
        const result = await host.executeScript(invocationId, signal);
        if (!result.ok) throw new ToolError(result.error?.code ?? 'HOOK_FAILED', 'Hook执行失败。');
        const decision = hookOutputSchema.parse(result.data);
        outcome = decision.decision;
        if (decision.updatedInput) updatedInput = decision.updatedInput;
      } catch (error) {
        code = error instanceof ToolError ? error.code : 'HOOK_FAILED';
      } finally {
        if (invocationId) this.pending.delete(invocationId);
      }
      const record: HookAudit = {
        ...(event.agentId ? { agentId: event.agentId } : {}),
        version: 1,
        sequence: this.records.length + 1,
        timestamp: new Date().toISOString(),
        event: event.event,
        eventId: event.eventId,
        sessionId: event.sessionId,
        hookId: hook.id,
        mode: event.mode,
        outcome,
        durationMs: Number((performance.now() - start).toFixed(3)),
        ...(code ? { code } : {}),
      };
      if (this.records.length >= 10_000)
        throw new ToolError('HOOK_LIMIT', 'Hook审计数量达到上限。');
      this.records.push(record);
      try {
        const pendingAudit = this.options.audit?.(Object.freeze({ ...record }));
        if (pendingAudit)
          await cancellableAudit(pendingAudit, signal.aborted ? AbortSignal.timeout(1000) : signal);
      } catch {
        record.outcome = 'error';
        record.code = 'AUDIT_FAILED';
        throw new ToolError('AUDIT_FAILED', 'Hook审计失败，安全动作未获准执行。');
      }
      if (outcome !== 'continue') {
        if (['SessionStart', 'PreToolUse', 'Stop'].includes(event.event))
          throw new ToolError(
            code ?? 'HOOK_BLOCKED',
            'Hook阻止了本次动作；详情见无敏感内容的审计记录。',
          );
      }
    }
    return { decision: 'continue', ...(updatedInput ? { updatedInput } : {}) };
  };
}

async function cancellableAudit(promise: Promise<void>, signal: AbortSignal): Promise<void> {
  void promise.catch(() => {});
  checkCancelled(signal);
  let cancel!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new ToolError('CANCELLED', 'Hook审计等待已取消。'));
    signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    await Promise.race([promise, cancelled]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}
