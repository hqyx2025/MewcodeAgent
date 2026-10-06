import { AppError } from '../shared/errors.js';

/** One ledger for parent and children; reservations are atomic before starting a request. */
export class TokenBudget {
  private spent: number;
  private held = 0;
  private uncertain: boolean;
  private requests = 0;
  private readonly actors = new Map<string, { used: number; estimated: boolean }>();
  constructor(
    readonly limit: number,
    used = 0,
    estimated = false,
    private readonly parent?: TokenBudget,
  ) {
    if (![limit, used].every(Number.isSafeInteger) || limit < 1 || used < 0)
      throw new AppError('CONFIG_INVALID', '共享token预算无效。');
    this.spent = used;
    this.uncertain = estimated;
  }
  get snapshot(): {
    limit: number;
    used: number;
    reserved: number;
    available: number;
    estimated: boolean;
    requests: number;
  } {
    return {
      limit: this.limit,
      used: this.spent,
      reserved: this.held,
      available: Math.min(
        Math.max(0, this.limit - this.spent - this.held),
        this.parent?.snapshot.available ?? Infinity,
      ),
      estimated: this.uncertain,
      requests: this.requests,
    };
  }
  usageFor(agentId: string) {
    return { ...(this.actors.get(agentId) ?? { used: 0, estimated: false }) };
  }
  reserve(tokens: number, agentId = 'parent') {
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > this.snapshot.available)
      throw new AppError('TOKEN_BUDGET', '父子共享token预算不足，未启动模型请求。');
    const outer = this.parent?.reserve(tokens, agentId);
    this.held += tokens;
    this.requests++;
    let closed = false;
    return {
      cancel: () => {
        if (!closed) {
          closed = true;
          this.held -= tokens;
          this.requests--;
          outer?.cancel();
        }
      },
      settle: (usage?: { inputTokens: number; outputTokens: number; estimated: boolean }) => {
        if (closed) return;
        if (
          usage &&
          (![usage.inputTokens, usage.outputTokens].every(Number.isSafeInteger) ||
            usage.inputTokens < 0 ||
            usage.outputTokens < 0)
        )
          throw new AppError('MODEL_PROTOCOL', '模型token用量无效。');
        closed = true;
        this.held -= tokens;
        outer?.settle(usage);
        this.spent += usage ? usage.inputTokens + usage.outputTokens : tokens;
        this.uncertain ||= !usage || usage.estimated;
        const actor = this.usageFor(agentId);
        actor.used += usage ? usage.inputTokens + usage.outputTokens : tokens;
        actor.estimated ||= !usage || usage.estimated;
        this.actors.set(agentId, actor);
      },
    };
  }
}
