import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { readdir, unlink, lstat } from 'node:fs/promises';
import { z } from 'zod';
import {
  teamCreateSchema,
  teamAddSchema,
  teamSendSchema,
  teamStateSchema,
  validateGraph,
} from './team-schema.js';
import type { TeamState, TeamTask } from './team-schema.js';
import type { SubagentResult } from './subagents.js';
import type { WorktreeManager } from '../tools/worktrees.js';
import { worktreeChecksSchema } from '../tools/worktree-schema.js';
import {
  readOwned,
  writeOwned,
  safeDirectory,
  inside,
  withWorktreeLock,
} from '../tools/worktree-storage.js';
import { ToolError } from '../tools/errors.js';
import { redactInstruction } from '../shared/redact.js';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const bytes = 512 * 1024;
export class TeamStore {
  private constructor(
    readonly repository: string,
    readonly directory: string,
    private readonly secrets: readonly string[],
    private readonly identity: string,
  ) {}
  static async open(
    manager: WorktreeManager,
    storage: string,
    secrets: readonly string[] = [],
  ): Promise<TeamStore> {
    const root = await safeDirectory(storage, true, true);
    const path = join(root, 'teams', hash(manager.commonDir).slice(0, 24));
    if (inside(manager.repository, path))
      throw new ToolError('TEAM_OWNER', '团队存储必须位于主仓库外。');
    const directory = await safeDirectory(path, true);
    const marker = join(directory, 'owner.json');
    const identity = JSON.stringify({
      app: 'mewcode-teams',
      version: 1,
      repository: manager.repository,
      commonDir: manager.commonDir,
    });
    const store = new TeamStore(manager.repository, directory, secrets, identity);
    const exists = await lstat(marker).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (!exists && (await readdir(directory)).length)
      throw new ToolError('TEAM_OWNER', '没有归属标记的非空团队目录不能接管。');
    try {
      await writeOwned(marker, identity, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
        throw new ToolError('TEAM_OWNER', '团队存储归属无效。');
      if ((await readOwned(marker)) !== identity)
        throw new ToolError('TEAM_OWNER', '团队存储归属不匹配。');
    }
    return store;
  }
  private safe(text: string): string {
    let value = redactInstruction(text);
    for (const secret of this.secrets) if (secret) value = value.replaceAll(secret, '[REDACTED]');
    return value;
  }
  private checkInput(input: unknown): void {
    if (typeof input === 'string' && this.safe(input) !== input)
      throw new ToolError('TEAM_SENSITIVE', '团队输入包含敏感内容，未保存。');
    if (Array.isArray(input)) input.forEach((value) => this.checkInput(value));
    else if (input && typeof input === 'object')
      Object.values(input).forEach((value) => this.checkInput(value));
  }
  private async storage(): Promise<void> {
    await safeDirectory(this.directory);
    if ((await readOwned(join(this.directory, 'owner.json'))) !== this.identity)
      throw new ToolError('TEAM_OWNER', '团队存储归属已变化。');
  }
  private async load(id: string): Promise<TeamState> {
    try {
      z.string().uuid().parse(id);
      await this.storage();
      const state = teamStateSchema.parse(
        JSON.parse(await readOwned(join(this.directory, id + '.json'), bytes)),
      );
      if (state.id !== id || state.repository !== this.repository) throw new Error('Owner');
      this.validate(state);
      this.checkInput(state);
      return state;
    } catch {
      throw new ToolError('TEAM_OWNER', '团队归属、状态或JSON无效；源内容未回显。');
    }
  }
  private validate(state: TeamState): void {
    validateGraph(state);
    if (new Set(state.members.map((member) => member.identity)).size !== state.members.length)
      throw new Error('Identity');
    const known = (member: string) =>
      member === 'coordinator' || state.members.some((value) => value.id === member);
    if (
      new Set(state.messages.map((message) => message.messageId)).size !== state.messages.length ||
      state.messages.length > state.settings.maxMessages
    )
      throw new Error('Messages');
    for (const [index, message] of state.messages.entries()) {
      const { from, messageId, to, task, text } = message;
      const fingerprint = hash(
        JSON.stringify({ from, messageId, to, ...(task ? { task } : {}), text }),
      );
      if (
        !known(from) ||
        !known(to) ||
        message.sequence !== index + 1 ||
        message.fingerprint !== fingerprint ||
        (task && !state.tasks.some((value) => value.id === task && value.member === to))
      )
        throw new Error('Message owner');
    }
    const claims = new Set<string>(),
      agents = new Set<string>(),
      members = new Set<string>();
    for (const task of state.tasks) {
      if (
        (task.status === 'running') !== Boolean(task.claim) ||
        (task.claim && (task.claim.runId !== state.run?.id || task.attempt < 1)) ||
        (task.result &&
          (task.result.id !== task.id ||
            (task.result.worktreeId &&
              task.result.worktreeId !==
                state.members.find((value) => value.id === task.member)!.worktree)))
      )
        throw new Error('Claim');
      if (task.claim) {
        if (claims.has(task.claim.id) || agents.has(task.claim.agentId) || members.has(task.member))
          throw new Error('Duplicate claim');
        claims.add(task.claim.id);
        agents.add(task.claim.agentId);
        members.add(task.member);
        if (
          new Set(task.claim.messages).size !== task.claim.messages.length ||
          task.claim.messages.some(
            (messageId) =>
              !state.messages.some(
                (message) =>
                  message.messageId === messageId &&
                  message.to === task.member &&
                  message.deliveredTo === task.claim!.id,
              ),
          )
        )
          throw new Error('Claim message');
      }
    }
  }
  private async save(state: TeamState, isNew = false): Promise<void> {
    await this.storage();
    teamStateSchema.parse(state);
    this.validate(state);
    this.checkInput(state);
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > bytes)
      throw new ToolError('TEAM_LIMIT', '团队记录超过512KiB上限。');
    await writeOwned(join(this.directory, state.id + '.json'), text, isNew, bytes);
  }
  async inspect(id: string): Promise<TeamState> {
    return this.load(id);
  }
  async list(): Promise<
    Pick<TeamState, 'id' | 'name' | 'createdAt' | 'usedTokens' | 'revision'>[]
  > {
    await this.storage();
    const result = [];
    for (const file of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      if (result.length >= 64) throw new ToolError('TEAM_LIMIT', '团队记录达到64条上限。');
      const state = await this.load(file.slice(0, -5));
      result.push({
        id: state.id,
        name: state.name,
        createdAt: state.createdAt,
        usedTokens: state.usedTokens,
        revision: state.revision,
      });
    }
    return result;
  }
  private async mutate<T>(id: string, fn: (state: TeamState) => Promise<T> | T): Promise<T> {
    return withWorktreeLock(
      this.directory,
      this.repository,
      async () => {
        const state = await this.load(id);
        const value = await fn(state);
        state.revision++;
        await this.save(state);
        return structuredClone(value);
      },
      'mewcode-teams',
    );
  }
  async create(raw: unknown, manager: WorktreeManager): Promise<TeamState> {
    const input = teamCreateSchema.safeParse(raw);
    if (!input.success) throw new ToolError('TEAM_INPUT', '团队定义不符合Schema。');
    this.checkInput(input.data);
    return withWorktreeLock(
      this.directory,
      this.repository,
      async () => {
        if ((await this.list()).length >= 64)
          throw new ToolError('TEAM_LIMIT', '团队记录达到64条上限。');
        const members = [];
        for (const member of input.data.members) {
          const report = await manager.report(member.worktree);
          if (report.owner.status !== 'ready' || report.dirty || report.head !== report.owner.base)
            throw new ToolError('TEAM_WORKTREE', '团队只绑定ready、干净的原基准工作树。');
          members.push({
            ...member,
            identity: randomUUID(),
            base: report.owner.base,
            branch: report.owner.branch,
            path: report.owner.path,
          });
        }
        const state: TeamState = {
          ...input.data,
          app: 'mewcode-teams',
          version: 1,
          id: randomUUID(),
          repository: this.repository,
          createdAt: new Date().toISOString(),
          revision: 0,
          usedTokens: 0,
          estimated: false,
          cancelRequested: false,
          members,
          tasks: input.data.tasks.map((task) => ({ ...task, status: 'queued', attempt: 0 })),
          messages: [],
        };
        try {
          validateGraph(state);
        } catch {
          throw new ToolError('TEAM_INPUT', '成员、工作树或任务重复，依赖未知或有环。');
        }
        await this.save(state, true);
        return state;
      },
      'mewcode-teams',
    );
  }
  async add(id: string, raw: unknown): Promise<TeamState> {
    const parsed = teamAddSchema.safeParse(raw);
    if (!parsed.success) throw new ToolError('TEAM_INPUT', '新增任务不符合Schema。');
    this.checkInput(parsed.data);
    return this.mutate(id, (state) => {
      if (state.run) throw new ToolError('TEAM_BUSY', '运行期间不能修改任务图。');
      state.tasks.push(
        ...parsed.data.tasks.map((task) => ({ ...task, status: 'queued' as const, attempt: 0 })),
      );
      try {
        validateGraph(state);
      } catch {
        throw new ToolError('TEAM_INPUT', '新增任务依赖或身份无效。');
      }
      return state;
    });
  }
  async send(id: string, from: string, raw: unknown): Promise<TeamState['messages'][number]> {
    const parsed = teamSendSchema.safeParse(raw);
    if (!parsed.success) throw new ToolError('TEAM_INPUT', '消息不符合Schema。');
    this.checkInput(parsed.data);
    return this.mutate(id, (state) => {
      const input = parsed.data;
      const known = (member: string) =>
        member === 'coordinator' || state.members.some((value) => value.id === member);
      if (
        !known(from) ||
        !known(input.to) ||
        (input.task &&
          !state.tasks.some((task) => task.id === input.task && task.member === input.to))
      )
        throw new ToolError('TEAM_MESSAGE', '消息身份或任务归属无效。');
      const fingerprint = hash(JSON.stringify({ from, ...input }));
      const old = state.messages.find((message) => message.messageId === input.messageId);
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new ToolError('TEAM_DUPLICATE', 'messageId已经用于不同消息。');
        return old;
      }
      if (
        state.messages.length >= state.settings.maxMessages ||
        state.messages.filter((message) => message.from === from).length >= 16
      )
        throw new ToolError('TEAM_LIMIT', '团队消息或发送者次数达到上限。');
      const message = {
        ...input,
        from,
        fingerprint,
        sequence: state.messages.length + 1,
        createdAt: new Date().toISOString(),
      };
      state.messages.push(message);
      return message;
    });
  }
  async inbox(id: string, member: string): Promise<TeamState['messages']> {
    const state = await this.load(id);
    if (member !== 'coordinator' && !state.members.some((value) => value.id === member))
      throw new ToolError('TEAM_MESSAGE', '成员不存在。');
    return state.messages.filter((message) => message.to === member);
  }
  async start(id: string, limit: number): Promise<TeamState> {
    return this.mutate(id, (state) => {
      if (state.run) throw new ToolError('TEAM_BUSY', '团队已有运行记录；不能重复领取或自动抢占。');
      state.cancelRequested = false;
      state.run = {
        id: randomUUID(),
        host: hostname(),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        limit: Math.min(limit, state.settings.maxTotalTokens),
      };
      return state;
    });
  }
  private running(state: TeamState, runId: string): void {
    if (state.run?.id !== runId || state.run.pid !== process.pid || state.run.host !== hostname())
      throw new ToolError('TEAM_OWNER', '协调者运行归属已变化。');
  }
  async claim(
    id: string,
    runId: string,
    taskId: string,
    used: number,
    quota: number,
  ): Promise<TeamTask | undefined> {
    return this.mutate(id, (state) => {
      this.running(state, runId);
      if (state.cancelRequested) return undefined;
      const task = state.tasks.find((value) => value.id === taskId);
      if (!task || task.status !== 'queued' || task.attempt >= 3) return undefined;
      if (
        state.tasks.some((value) => value.member === task.member && value.status === 'running') ||
        task.dependsOn.some(
          (dep) => state.tasks.find((value) => value.id === dep)?.status !== 'completed',
        )
      )
        return undefined;
      state.usedTokens = Math.max(state.usedTokens, used);
      const held = state.tasks.reduce((sum, value) => sum + (value.claim?.reservedTokens ?? 0), 0);
      const available = state.run!.limit - state.usedTokens - held;
      if (!Number.isSafeInteger(quota) || quota < 1 || quota > available)
        throw new ToolError('TOKEN_BUDGET', '团队持久预留预算不足。');
      const claimId = randomUUID();
      const messages = [];
      let messageBytes = 0;
      for (const message of state.messages) {
        if (
          message.to !== task.member ||
          (message.task && message.task !== task.id) ||
          message.deliveredTo
        )
          continue;
        const cost = Buffer.byteLength(message.text);
        if (messages.length >= 8 || messageBytes + cost > 2048) continue;
        message.deliveredTo = claimId;
        messages.push(message.messageId);
        messageBytes += cost;
      }
      task.status = 'running';
      task.attempt++;
      task.claim = {
        id: claimId,
        runId,
        agentId: randomUUID(),
        reservedTokens: quota,
        startedAt: new Date().toISOString(),
        messages,
      };
      return task;
    });
  }
  async finish(
    id: string,
    runId: string,
    taskId: string,
    claimId: string,
    result: SubagentResult,
    used: number,
    estimated: boolean,
    checks: z.infer<typeof worktreeChecksSchema> = [],
    checksOmitted = 0,
  ): Promise<void> {
    await this.mutate(id, (state) => {
      this.running(state, runId);
      const task = state.tasks.find((value) => value.id === taskId);
      if (!task || task.claim?.id !== claimId || task.claim.agentId !== result.agentId)
        throw new ToolError('TEAM_OWNER', '任务领取归属已变化。');
      task.status =
        result.status === 'completed'
          ? 'completed'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
      task.result = result;
      task.checks = worktreeChecksSchema.parse(checks);
      task.checksOmitted = checksOmitted;
      const member = state.members.find((value) => value.id === task.member)!;
      if (result.worktreeId) member.lastAgentId = result.agentId;
      delete task.claim;
      state.usedTokens = Math.max(state.usedTokens, used);
      state.estimated ||= estimated;
    });
  }
  async settle(
    id: string,
    runId: string,
    used: number,
    estimated: boolean,
    cancelled: boolean,
  ): Promise<TeamState> {
    return this.mutate(id, (state) => {
      this.running(state, runId);
      if (state.tasks.some((task) => task.status === 'running'))
        throw new ToolError('TEAM_BUSY', '仍有活动任务，不能结束协调者。');
      state.usedTokens = Math.max(state.usedTokens, used);
      state.estimated ||= estimated;
      for (const task of state.tasks) {
        if (task.status === 'queued' && (cancelled || state.cancelRequested))
          task.status = 'cancelled';
      }
      // Exhausted batch limits leave pending dependencies queued for the next explicit run.
      // Iterate so failure propagates even when tasks are declared out of dependency order.
      for (let pass = 0; pass < state.tasks.length; pass++)
        for (const task of state.tasks)
          if (
            task.status === 'queued' &&
            task.dependsOn.some((dep) =>
              ['failed', 'cancelled', 'blocked', 'uncertain'].includes(
                state.tasks.find((value) => value.id === dep)!.status,
              ),
            )
          )
            task.status = 'blocked';
      delete state.run;
      return state;
    });
  }
  async cancel(id: string): Promise<void> {
    await this.mutate(id, (state) => {
      state.cancelRequested = true;
      if (!state.run)
        for (const task of state.tasks)
          if (task.status === 'queued' || task.status === 'blocked') task.status = 'cancelled';
    });
  }
  async retry(id: string, taskId: string): Promise<void> {
    await this.mutate(id, (state) => {
      if (state.run) throw new ToolError('TEAM_BUSY', '运行期间不能重派。');
      const task = state.tasks.find((value) => value.id === taskId);
      if (!task || !['failed', 'cancelled', 'uncertain'].includes(task.status) || task.attempt >= 3)
        throw new ToolError('TEAM_RETRY', '仅明确重派失败/取消/不确定任务，最多3次尝试。');
      task.status = 'queued';
      delete task.result;
      delete task.checks;
      delete task.checksOmitted;
      for (const blocked of state.tasks)
        if (blocked.status === 'blocked') blocked.status = 'queued';
    });
  }
  private dead(host: string, pid: number): void {
    if (host !== hostname()) throw new ToolError('TEAM_BUSY', '不能恢复其他主机的运行。');
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw new ToolError('TEAM_BUSY', '无法确认原进程已停止。');
    }
    throw new ToolError('TEAM_BUSY', '原协调者仍运行，拒绝抢占。');
  }
  async recover(id: string, manager: WorktreeManager): Promise<TeamState> {
    return this.mutate(id, async (state) => {
      if (!state.run) throw new ToolError('TEAM_BUSY', '团队没有待恢复运行。');
      this.dead(state.run.host, state.run.pid);
      const reports = [];
      for (const task of state.tasks.filter((value) => value.status === 'running')) {
        const member = state.members.find((value) => value.id === task.member)!;
        const report = await manager.report(member.worktree);
        if (
          report.owner.path !== member.path ||
          report.owner.base !== member.base ||
          report.owner.branch !== member.branch
        )
          throw new ToolError('TEAM_OWNER', '恢复工作树基准或路径已变化。');
        if (
          report.owner.agentId !== task.claim!.agentId &&
          report.owner.agentId !== member.lastAgentId &&
          report.owner.status !== 'ready'
        )
          throw new ToolError('TEAM_OWNER', '恢复工作树不属于该任务。');
        if (report.owner.status === 'running') {
          if (report.owner.host !== state.run.host || report.owner.pid !== state.run.pid)
            throw new ToolError('TEAM_OWNER', '工作树运行进程归属不匹配。');
          reports.push(report.owner);
        }
      }
      for (const owner of reports) await manager.recover(owner.id);
      for (const task of state.tasks)
        if (task.claim) {
          state.usedTokens += task.claim.reservedTokens;
          state.estimated = true;
          const member = state.members.find((value) => value.id === task.member)!;
          const report = await manager.report(member.worktree);
          if (report.owner.agentId === task.claim.agentId) member.lastAgentId = task.claim.agentId;
          task.status = 'uncertain';
          delete task.claim;
        }
      delete state.run;
      return state;
    });
  }
  async unlock(): Promise<void> {
    await this.storage();
    const path = join(this.directory, 'manager.lock');
    try {
      const text = await readOwned(path);
      const lock = z
        .strictObject({
          app: z.literal('mewcode-teams'),
          repository: z.literal(this.repository),
          host: z.string(),
          pid: z.number().int().positive(),
          id: z.string().uuid(),
        })
        .parse(JSON.parse(text));
      this.dead(lock.host, lock.pid);
      if ((await readOwned(path)) !== text) throw new Error('Changed');
      await unlink(path);
    } catch (error) {
      if (error instanceof ToolError && error.code === 'TEAM_BUSY') throw error;
      throw new ToolError('TEAM_OWNER', '团队归属锁无效或已变化。');
    }
  }
}
