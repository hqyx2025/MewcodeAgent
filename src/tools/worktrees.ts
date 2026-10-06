import { createHash, randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { hostname } from 'node:os';
import { runProcess, processEnvironment } from './process.js';
import { byteLimit, checkCancelled, ToolError } from './errors.js';
import { defineTool } from './types.js';
import type { ToolRegistry } from './registry.js';
import {
  worktreeCreateSchema,
  worktreeIdSchema,
  worktreeOwnerSchema,
  worktreeChecksSchema,
} from './worktree-schema.js';
import type { WorktreeOwner, WorktreeBinding } from './worktree-schema.js';
import {
  inside,
  readOwned,
  safeDirectory,
  samePath,
  withWorktreeLock,
  writeOwned,
} from './worktree-storage.js';
import { redactInstruction } from '../shared/redact.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const ownerFile = (directory: string, id: string) => join(directory, `${id}.json`);
function ownedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolError('WORKTREE_OWNER', '工作树归属JSON无效；源内容未回显。');
  }
}
interface Registration {
  path: string;
  head: string;
  branch?: string;
  locked: boolean;
  prunable: boolean;
}
export interface WorktreeReport {
  owner: WorktreeOwner;
  head: string;
  dirty: boolean;
  changes: string[];
  untracked: string[];
  ignored: string[];
  conflicts: string[];
  truncated: boolean;
}

export class WorktreeManager {
  private gitOptions: string[] = [];
  private constructor(
    readonly repository: string,
    readonly commonDir: string,
    readonly directory: string,
    private readonly sensitiveValues: readonly string[],
    readonly maxActive: number,
    private readonly resultBytes = 8192,
  ) {}
  static async open(
    root: string,
    storage: string,
    options: { sensitiveValues?: readonly string[]; maxActive?: number; resultBytes?: number } = {},
  ): Promise<WorktreeManager> {
    const repository = await safeDirectory(await realpath(root));
    const probe = new WorktreeManager(
      repository,
      '',
      '',
      options.sensitiveValues ?? [],
      options.maxActive ?? 4,
    );
    if (!Number.isSafeInteger(probe.maxActive) || probe.maxActive < 1 || probe.maxActive > 4)
      throw new ToolError('WORKTREE_LIMIT', '同时保留的工作树上限必须为1–4。');
    const signal = AbortSignal.timeout(30_000);
    const version = await probe.git(['--version'], repository, signal);
    const installed = /^git version (\d+)\.(\d+)/.exec(version.stdout);
    if (
      !installed ||
      Number(installed[1]) < 2 ||
      (Number(installed[1]) === 2 && Number(installed[2]) < 40)
    )
      throw new ToolError('WORKTREE_GIT', '工作树管理需要Git 2.40或更新版本。');
    const top = (
      await probe.git(['rev-parse', '--show-toplevel'], repository, signal)
    ).stdout.trim();
    if (!samePath(await realpath(top), repository))
      throw new ToolError('WORKTREE_GIT', '请从Git仓库根目录管理工作树。');
    const common = await safeDirectory(
      resolve(
        repository,
        (await probe.git(['rev-parse', '--git-common-dir'], repository, signal)).stdout.trim(),
      ),
    );
    const gitDir = await realpath(
      (await probe.git(['rev-parse', '--absolute-git-dir'], repository, signal)).stdout.trim(),
    );
    if (!samePath(gitDir, common))
      throw new ToolError(
        'WORKTREE_GIT',
        '工作树管理入口必须绑定主仓库，不能在子工作树中嵌套创建。',
      );
    if (!samePath(await safeDirectory(join(repository, '.git')), common))
      throw new ToolError('WORKTREE_OWNER', '主仓库Git目录必须为无链接目录。');
    const storageRoot = await safeDirectory(storage, true, true);
    const destination = resolve(storageRoot, 'worktrees', hash(common).slice(0, 24));
    if (inside(repository, destination) || inside(common, destination))
      throw new ToolError('WORKTREE_OWNER', '工作树存储必须位于主仓库之外。');
    const directory = await safeDirectory(destination, true);
    const marker = join(directory, 'owner.json');
    const identity = JSON.stringify({
      app: 'mewcode-worktrees',
      version: 1,
      repository,
      commonDir: common,
    });
    if (
      !(await lstat(marker).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      })) &&
      (await readdir(directory)).length
    )
      throw new ToolError('WORKTREE_OWNER', '现有非空存储目录没有归属标记，拒绝接管。');
    try {
      await writeOwned(marker, identity, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if ((await readOwned(marker)) !== identity)
        throw new ToolError('WORKTREE_OWNER', '存储目录不属于当前主仓库。');
    }
    const manager = new WorktreeManager(
      repository,
      common,
      directory,
      options.sensitiveValues ?? [],
      probe.maxActive,
      options.resultBytes ?? 8192,
    );
    // No Git hooks, fsmonitor, recursive submodules, external diff or checkout filters.
    const hooks = await safeDirectory(join(directory, 'empty-hooks'), true);
    manager.gitOptions = [
      '-c',
      `core.hooksPath=${hooks}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'submodule.recurse=false',
    ];
    await manager.disableFilters(signal);
    return manager;
  }
  private async disableFilters(signal: AbortSignal): Promise<void> {
    const filters = await this.git(
      ['config', '--name-only', '--get-regexp', '^filter\\.'],
      this.repository,
      signal,
      [0, 1],
    );
    const options: string[] = [];
    for (const name of new Set(
      filters.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((key) =>
          key.replace(/^filter\./, '').replace(/\.(?:process|smudge|clean|required)$/, ''),
        ),
    )) {
      if (!name || !/^[a-zA-Z0-9_-]{1,128}$/.test(name))
        throw new ToolError('WORKTREE_GIT', '不支持的Git filter配置，拒绝自动checkout。');
      options.push(
        '-c',
        `filter.${name}.process=`,
        '-c',
        `filter.${name}.smudge=`,
        '-c',
        `filter.${name}.clean=`,
        '-c',
        `filter.${name}.required=false`,
      );
    }
    this.gitOptions.splice(6, this.gitOptions.length - 6, ...options);
  }
  private async git(args: string[], cwd: string, signal: AbortSignal, allowed = [0]) {
    checkCancelled(signal);
    if (
      this.directory &&
      (args[0] === 'status' || args[0] === 'diff' || (args[0] === 'worktree' && args[1] === 'add'))
    ) {
      const hooks = await safeDirectory(join(this.directory, 'empty-hooks'));
      if ((await readdir(hooks)).length)
        throw new ToolError('WORKTREE_OWNER', '禁用Hook目录已变化，拒绝执行Git操作。');
      await this.disableFilters(signal);
    }
    const output = await runProcess({
      executable: 'git',
      args: ['--no-pager', ...this.gitOptions, ...args],
      cwd,
      signal,
      timeoutMs: 30_000,
      maxBytes: 256 * 1024,
      env: { ...processEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    });
    if (output.truncated)
      throw new ToolError('WORKTREE_LIMIT', 'Git输出超过256KiB，拒绝使用不完整结果。');
    if (!allowed.includes(output.exitCode ?? -1))
      throw new ToolError(
        'WORKTREE_GIT',
        'Git操作未成功；源输出未回显，请核对仓库、ref、分支与文件状态。',
      );
    return output;
  }
  private async storage(): Promise<void> {
    await safeDirectory(this.repository);
    await safeDirectory(this.directory);
    await safeDirectory(this.commonDir);
    if (!samePath(await safeDirectory(join(this.repository, '.git')), this.commonDir))
      throw new ToolError('WORKTREE_OWNER', '主仓库Git目录已变化。');
    const marker = ownedJson(await readOwned(join(this.directory, 'owner.json'))) as Record<
      string,
      unknown
    > | null;
    if (
      !marker ||
      marker.app !== 'mewcode-worktrees' ||
      marker.version !== 1 ||
      marker.repository !== this.repository ||
      marker.commonDir !== this.commonDir
    )
      throw new ToolError('WORKTREE_OWNER', '工作树存储归属已变化。');
  }
  private async load(id: string): Promise<WorktreeOwner> {
    worktreeIdSchema.parse(id);
    await this.storage();
    const parsed = worktreeOwnerSchema.safeParse(
      ownedJson(await readOwned(ownerFile(this.directory, id))),
    );
    if (!parsed.success) throw new ToolError('WORKTREE_OWNER', '工作树记录格式无效。');
    const owner = parsed.data;
    if (
      owner.id !== id ||
      owner.repository !== this.repository ||
      owner.commonDir !== this.commonDir ||
      owner.path !== join(this.directory, id)
    )
      throw new ToolError('WORKTREE_OWNER', '工作树路径或仓库归属无效。');
    return owner;
  }
  private async save(owner: WorktreeOwner, isNew = false): Promise<void> {
    worktreeOwnerSchema.parse(owner);
    await this.storage();
    await writeOwned(ownerFile(this.directory, owner.id), JSON.stringify(owner), isNew);
  }
  async list(): Promise<WorktreeOwner[]> {
    await this.storage();
    const result: WorktreeOwner[] = [];
    for (const file of await readdir(this.directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      if (result.length >= 128)
        throw new ToolError('WORKTREE_LIMIT', '工作树归属记录达到128条上限。');
      result.push(await this.load(file.slice(0, -5)));
    }
    return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async resolveBase(base: string, signal: AbortSignal): Promise<string> {
    worktreeCreateSchema.shape.base.parse(base);
    return (
      await this.git(
        ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`],
        this.repository,
        signal,
      )
    ).stdout.trim();
  }
  private async registrations(signal: AbortSignal): Promise<Registration[]> {
    const text = (
      await this.git(['worktree', 'list', '--porcelain', '-z'], this.repository, signal)
    ).stdout;
    const records: Registration[] = [];
    let current: Registration | undefined;
    for (const field of text.split('\0')) {
      if (field.startsWith('worktree ')) {
        current = { path: field.slice(9), head: '', locked: false, prunable: false };
        records.push(current);
      } else if (current && field.startsWith('HEAD ')) current.head = field.slice(5);
      else if (current && field.startsWith('branch ')) current.branch = field.slice(7);
      else if (current && field.startsWith('locked')) current.locked = true;
      else if (current && field.startsWith('prunable')) current.prunable = true;
    }
    return records;
  }
  private async verify(owner: WorktreeOwner, signal: AbortSignal): Promise<void> {
    if (owner.status === 'removed')
      throw new ToolError('WORKTREE_OWNER', '工作树已回收；保留的分支不自动删除。');
    await safeDirectory(owner.path);
    const dotgit = await lstat(join(owner.path, '.git'));
    if (!dotgit.isFile() || dotgit.isSymbolicLink() || dotgit.nlink !== 1)
      throw new ToolError('WORKTREE_OWNER', '工作树Git指针必须是普通文件。');
    const pointer = /^gitdir: (.+)\r?\n?$/.exec(await readOwned(join(owner.path, '.git')));
    if (!pointer) throw new ToolError('WORKTREE_OWNER', '工作树Git指针格式无效。');
    const admin = await safeDirectory(resolve(owner.path, pointer[1]!));
    if (
      !inside(join(this.commonDir, 'worktrees'), admin) ||
      !samePath(resolve((await readOwned(join(admin, 'gitdir'))).trim()), join(owner.path, '.git'))
    )
      throw new ToolError('WORKTREE_OWNER', '工作树Git指针或反向归属不匹配。');
    const records = await this.registrations(signal);
    const record = records.find((item) => samePath(resolve(item.path), owner.path));
    if (
      !record ||
      record.branch !== `refs/heads/${owner.branch}` ||
      record.locked ||
      record.prunable
    )
      throw new ToolError('WORKTREE_OWNER', 'Git登记、分支、锁定或归属状态不匹配。');
    const common = await realpath(
      resolve(
        owner.path,
        (await this.git(['rev-parse', '--git-common-dir'], owner.path, signal)).stdout.trim(),
      ),
    );
    if (!samePath(common, this.commonDir))
      throw new ToolError('WORKTREE_OWNER', '工作树已指向其他仓库。');
    const head = (await this.git(['rev-parse', 'HEAD'], owner.path, signal)).stdout.trim();
    if (
      (
        await this.git(
          ['merge-base', '--is-ancestor', owner.base, head],
          owner.path,
          signal,
          [0, 1],
        )
      ).exitCode !== 0
    )
      throw new ToolError('WORKTREE_BASE', '工作树历史已偏离记录的基准。');
  }
  async create(raw: unknown, signal = new AbortController().signal): Promise<WorktreeOwner> {
    const input = worktreeCreateSchema.parse(raw);
    return withWorktreeLock(this.directory, this.repository, async () => {
      const owners = await this.list();
      if (owners.length >= 128)
        throw new ToolError('WORKTREE_LIMIT', '归属记录达到128条上限；不自动删除恢复记录。');
      if (owners.filter((owner) => owner.status !== 'removed').length >= this.maxActive)
        throw new ToolError('WORKTREE_LIMIT', '活动工作树达到上限，先审阅并回收已完成任务。');
      const id = randomUUID();
      const base = await this.resolveBase(input.base, signal);
      const branch = input.branch ?? `codex/worktree-${input.task}-${id.slice(0, 8)}`;
      await this.git(['check-ref-format', '--branch', branch], this.repository, signal);
      if (
        (
          await this.git(
            ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
            this.repository,
            signal,
            [0, 1],
          )
        ).exitCode === 0
      )
        throw new ToolError('WORKTREE_BRANCH', '分支已存在，不覆盖或复用未归属分支。');
      const owner: WorktreeOwner = {
        app: 'mewcode-worktrees',
        version: 1,
        id,
        repository: this.repository,
        commonDir: this.commonDir,
        path: join(this.directory, id),
        task: input.task,
        branch,
        base,
        createdAt: new Date().toISOString(),
        status: 'creating',
        checks: [],
        checksOmitted: 0,
        host: hostname(),
        pid: process.pid,
      };
      await this.save(owner, true);
      try {
        await this.git(
          ['worktree', 'add', '-b', branch, '--', owner.path, base],
          this.repository,
          signal,
        );
        await this.verify(owner, signal);
        owner.status = 'ready';
        delete owner.host;
        delete owner.pid;
        await this.save(owner);
        return structuredClone(owner);
      } catch (error) {
        owner.status = 'failed';
        owner.outcome = signal.aborted ? 'CANCELLED' : 'WORKTREE_CREATE_FAILED';
        await this.save(owner);
        throw error;
      }
    });
  }
  async report(id: string, signal = new AbortController().signal): Promise<WorktreeReport> {
    const owner = await this.load(id);
    await this.verify(owner, signal);
    const head = (await this.git(['rev-parse', 'HEAD'], owner.path, signal)).stdout.trim();
    const status = (
      await this.git(
        ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'],
        owner.path,
        signal,
      )
    ).stdout
      .split('\0')
      .filter(Boolean);
    const changes: string[] = [],
      untracked: string[] = [],
      ignored: string[] = [],
      conflicts: string[] = [];
    for (let index = 0; index < status.length; index++) {
      const item = status[index]!;
      const flag = item.slice(0, 2);
      const path = item.slice(3);
      if (flag === '??') untracked.push(path);
      else if (flag === '!!') ignored.push(path);
      else {
        changes.push(path);
        if (['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(flag)) conflicts.push(path);
      }
      if (/[RC]/.test(flag)) {
        const old = status[++index];
        if (old) changes.push(old);
      }
    }
    const committed = (
      await this.git(
        ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '-z', owner.base, 'HEAD', '--'],
        owner.path,
        signal,
      )
    ).stdout
      .split('\0')
      .filter(Boolean);
    return {
      owner,
      head,
      dirty: Boolean(changes.length || untracked.length || ignored.length),
      changes: [...new Set([...committed, ...changes])],
      untracked,
      ignored,
      conflicts,
      truncated: false,
    };
  }
  async diff(
    id: string,
    signal = new AbortController().signal,
  ): Promise<{ report: WorktreeReport; content: string; truncated: boolean }> {
    const report = await this.report(id, signal);
    const text = (
      await this.git(
        ['diff', '--no-ext-diff', '--no-textconv', '--binary', report.owner.base, '--'],
        report.owner.path,
        signal,
      )
    ).stdout;
    let safe = redactInstruction(text, this.sensitiveValues);
    for (const value of this.sensitiveValues)
      if (value) safe = safe.replaceAll(value, '[REDACTED]');
    const content = byteLimit(safe, 32 * 1024);
    return { report, content, truncated: safe !== content };
  }
  async reuse(
    id: string,
    base: string,
    signal = new AbortController().signal,
  ): Promise<WorktreeOwner> {
    return withWorktreeLock(this.directory, this.repository, async () => {
      const report = await this.report(id, signal);
      if (report.owner.status === 'running' || report.owner.status === 'creating')
        throw new ToolError('WORKTREE_BUSY', '工作树仍有活动任务，不能复用。');
      if (
        report.dirty ||
        report.head !== report.owner.base ||
        (await this.resolveBase(base, signal)) !== report.owner.base
      )
        throw new ToolError(
          'WORKTREE_BASE',
          '仅复用归属与基准一致、无提交/修改/额外文件的工作树。',
        );
      const owner = { ...report.owner, status: 'ready' as const, checks: [], checksOmitted: 0 };
      delete owner.agentId;
      delete owner.outcome;
      delete owner.host;
      delete owner.pid;
      await this.save(owner);
      return owner;
    });
  }
  async acquire(id: string, agentId: string, signal: AbortSignal): Promise<WorktreeBinding> {
    return this.acquireMember(id, undefined, agentId, signal);
  }
  /** Trusted coordinator continuation; never exposed to model worktree tools. */
  async acquireMember(
    id: string,
    previousAgentId: string | undefined,
    agentId: string,
    signal: AbortSignal,
  ): Promise<WorktreeBinding> {
    return withWorktreeLock(this.directory, this.repository, async () => {
      const report = await this.report(id, signal);
      const fresh =
        report.owner.status === 'ready' &&
        !report.dirty &&
        report.head === report.owner.base &&
        !previousAgentId;
      const continued =
        previousAgentId &&
        report.owner.agentId === previousAgentId &&
        ['completed', 'failed', 'cancelled'].includes(report.owner.status);
      if (!fresh && !continued)
        throw new ToolError('WORKTREE_BUSY', '子任务只绑定ready且未修改的归属工作树。');
      const owner = {
        ...report.owner,
        status: 'running' as const,
        agentId,
        checks: [],
        checksOmitted: 0,
        pid: process.pid,
        host: hostname(),
      };
      await this.save(owner);
      return Object.freeze({
        id,
        root: owner.path,
        repository: this.repository,
        agentId,
        verify: async (inner: AbortSignal) => {
          const current = await this.load(id);
          if (current.status !== 'running' || current.agentId !== agentId)
            throw new ToolError('WORKTREE_OWNER', '任务工作树归属已变化。');
          await this.verify(current, inner);
        },
      });
    });
  }
  async release(
    id: string,
    agentId: string,
    status: 'completed' | 'failed' | 'cancelled',
    outcome: string,
    checks: z.infer<typeof worktreeChecksSchema> = [],
    checksOmitted = 0,
  ): Promise<void> {
    await withWorktreeLock(this.directory, this.repository, async () => {
      const owner = await this.load(id);
      if (owner.status !== 'running' || owner.agentId !== agentId)
        throw new ToolError('WORKTREE_OWNER', '不能结束不属于当前子任务的工作树。');
      owner.status = status;
      owner.outcome = outcome;
      owner.checks = worktreeChecksSchema.parse(checks);
      owner.checksOmitted = checksOmitted;
      await this.save(owner);
    });
  }
  private dead(host: string | undefined, pid: number | undefined): void {
    if (host !== hostname() || !pid)
      throw new ToolError('WORKTREE_LOCKED', '仅恢复同主机且拥有进程确定不存在的记录。');
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw new ToolError('WORKTREE_LOCKED', '无法确认原拥有进程已停止。');
    }
    throw new ToolError('WORKTREE_BUSY', '原拥有进程仍运行，不能抢占。');
  }
  async unlock(): Promise<void> {
    await this.storage();
    const path = join(this.directory, 'manager.lock');
    const parsed = z
      .strictObject({
        app: z.literal('mewcode-worktrees'),
        repository: z.string(),
        host: z.string(),
        pid: z.number().int().positive(),
        id: z.string().uuid(),
      })
      .safeParse(ownedJson(await readOwned(path)));
    if (!parsed.success) throw new ToolError('WORKTREE_OWNER', '工作树管理锁格式无效。');
    const lock = parsed.data;
    if (lock.repository !== this.repository)
      throw new ToolError('WORKTREE_OWNER', '锁不属于当前仓库。');
    this.dead(lock.host, lock.pid);
    const text = await readOwned(path);
    if (JSON.stringify(ownedJson(text)) !== JSON.stringify(lock))
      throw new ToolError('WORKTREE_LOCKED', '锁已变化。');
    await import('node:fs/promises').then(({ unlink }) => unlink(path));
  }
  async recover(id: string): Promise<WorktreeOwner> {
    return withWorktreeLock(this.directory, this.repository, async () => {
      const owner = await this.load(id);
      if (!['creating', 'running'].includes(owner.status))
        throw new ToolError('WORKTREE_BUSY', '只有不确定创建或运行记录需要恢复。');
      this.dead(owner.host, owner.pid);
      owner.status = 'failed';
      owner.outcome = 'WORKTREE_INTERRUPTED';
      await this.save(owner);
      return owner;
    });
  }
  async remove(id: string, signal = new AbortController().signal): Promise<WorktreeOwner> {
    return withWorktreeLock(this.directory, this.repository, async () => {
      const owner = await this.load(id);
      if (['running', 'creating', 'removed'].includes(owner.status))
        throw new ToolError('WORKTREE_BUSY', '不能回收运行中、不确定创建中或已回收的工作树。');
      const exists = await lstat(owner.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (exists) {
        const report = await this.report(id, signal);
        if (report.dirty || report.conflicts.length)
          throw new ToolError(
            'WORKTREE_DIRTY',
            '工作树含修改、未跟踪或忽略文件；已保留路径和分支，请先审阅。',
          );
        if (
          (await this.git(['ls-files', '--stage'], owner.path, signal)).stdout
            .split('\n')
            .some((line) => line.startsWith('160000 '))
        )
          throw new ToolError('WORKTREE_SUBMODULE', '包含子模块的工作树不自动回收。');
        await this.verify(owner, signal);
        await this.git(['worktree', 'remove', '--', owner.path], this.repository, signal);
      } else if (
        (await this.registrations(signal)).some((item) => samePath(resolve(item.path), owner.path))
      )
        throw new ToolError('WORKTREE_OWNER', '缺失路径仍有Git登记；不自动prune，请人工核对。');
      owner.status = 'removed';
      await this.save(owner);
      return owner;
    });
  }
  private payload(value: unknown): { content: string; truncated?: boolean } {
    const content = JSON.stringify(value);
    const framed = JSON.stringify({
      callId: 'x'.repeat(128),
      agentId: 'x'.repeat(36),
      name: 'WorktreeInspect',
      ok: true,
      truncated: true,
      content,
    });
    if (Buffer.byteLength(framed) > this.resultBytes)
      throw new ToolError(
        'WORKTREE_LIMIT',
        '工作树结构化报告超过当前结果预算；请用worktrees show/diff查看完整报告。',
      );
    return { content };
  }
  private inspected(value: WorktreeReport | Awaited<ReturnType<WorktreeManager['diff']>>): {
    content: string;
    truncated?: boolean;
  } {
    const copy = structuredClone(value);
    const report = 'report' in copy ? copy.report : copy;
    let omittedPaths = 0;
    while (true) {
      try {
        return {
          ...this.payload({ ...copy, ...(omittedPaths ? { omittedPaths } : {}) }),
          ...(report.truncated || ('content' in copy && copy.truncated) ? { truncated: true } : {}),
        };
      } catch (error) {
        if (!(error instanceof ToolError) || error.code !== 'WORKTREE_LIMIT') throw error;
        if ('content' in copy && copy.content) {
          copy.content = byteLimit(copy.content, Math.floor(Buffer.byteLength(copy.content) / 2));
          copy.truncated = true;
          continue;
        }
        const biggest = [report.changes, report.untracked, report.ignored, report.conflicts].sort(
          (a, b) => b.length - a.length,
        )[0]!;
        if (!biggest.length) throw error;
        biggest.pop();
        omittedPaths++;
        report.truncated = true;
      }
    }
  }
  register(registry: ToolRegistry): void {
    registry.register(
      defineTool({
        name: 'WorktreeList',
        effect: 'read',
        schema: z.strictObject({}),
        description: '列出当前主仓库已归属的工作树记录，不自动恢复、清理或合并。',
        prepare: async () => ({
          target: this.repository,
          preview: '列出当前仓库工作树归属',
          run: async () => this.payload(await this.list()),
        }),
      }),
    );
    registry.register(
      defineTool({
        name: 'WorktreeCreate',
        effect: 'shell',
        schema: worktreeCreateSchema,
        description: '创建归属当前仓库的隔离分支与工作树；需shell审批，不安装依赖或自动合并。',
        prepare: async (input, context) => {
          if (!samePath(context.paths.root, this.repository))
            throw new ToolError('WORKTREE_OWNER', '仅主仓库可管理工作树。');
          const base = await this.resolveBase(input.base, context.signal);
          return {
            target: this.repository,
            preview: `创建任务 ${input.task}；基准 ${base}；分支 ${input.branch ?? 'codex/worktree-<task>-<uuid>'}`,
            run: async () => this.payload(await this.create({ ...input, base }, context.signal)),
          };
        },
      }),
    );
    registry.register(
      defineTool({
        name: 'WorktreeRemove',
        effect: 'shell',
        schema: z.strictObject({ id: worktreeIdSchema }),
        description: '只回收已归属、无任务、无修改及额外文件的工作树；保留分支，无force/prune。',
        prepare: async (input, context) => {
          const owner = await this.load(input.id);
          return {
            target: this.repository,
            preview: `回收 ${owner.id} ${owner.path}；保留 ${owner.branch}`,
            run: async () => {
              if (JSON.stringify(await this.load(input.id)) !== JSON.stringify(owner))
                throw new ToolError(
                  'WORKTREE_OWNER',
                  '审批期间工作树归属已变化，请重新检查并批准。',
                );
              return this.payload(await this.remove(input.id, context.signal));
            },
          };
        },
      }),
    );
    registry.register(
      defineTool({
        name: 'WorktreeReuse',
        effect: 'shell',
        schema: z.strictObject({ id: worktreeIdSchema, base: worktreeCreateSchema.shape.base }),
        description: '核验归属与原始基准后复用干净工作树，不重置修改或已有提交。',
        prepare: async (input, context) => {
          const base = await this.resolveBase(input.base, context.signal);
          return {
            target: this.repository,
            preview: `复用 ${input.id}；基准 ${base}`,
            run: async () => this.payload(await this.reuse(input.id, base, context.signal)),
          };
        },
      }),
    );
    registry.register(
      defineTool({
        name: 'WorktreeRecover',
        effect: 'shell',
        schema: z.strictObject({ id: worktreeIdSchema }),
        description: '只恢复同主机且拥有进程已停止的不确定状态，保留全部工作树内容。',
        prepare: async (input) => ({
          target: this.repository,
          preview: `恢复工作树 ${input.id} 的中断状态，保留内容`,
          run: async () => this.payload(await this.recover(input.id)),
        }),
      }),
    );
    registry.register(
      defineTool({
        name: 'WorktreeUnlock',
        effect: 'shell',
        schema: z.strictObject({}),
        description: '仅移除同主机且拥有进程已停止的归属锁，不能抢占运行进程。',
        prepare: async () => ({
          target: this.repository,
          preview: '核验并移除当前主仓库的已停止管理进程锁',
          run: async () => {
            await this.unlock();
            return { content: '归属锁已核验并移除。' };
          },
        }),
      }),
    );
    registry.register(
      defineTool({
        name: 'WorktreeInspect',
        effect: 'read',
        schema: z.strictObject({ id: worktreeIdSchema, diff: z.boolean().default(false) }),
        description:
          '查看核验后的工作树归属、变更、冲突、实际测试状态与可选有界diff；缩减明确标记。',
        prepare: async (input, context) => ({
          target: this.repository,
          preview: `检查工作树 ${input.id}`,
          run: async () =>
            this.inspected(
              input.diff
                ? await this.diff(input.id, context.signal)
                : await this.report(input.id, context.signal),
            ),
        }),
      }),
    );
  }
}
