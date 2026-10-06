import { createHash } from 'node:crypto';
import { z } from 'zod';
import { subtaskSchema } from './subagent-schema.js';
import type { SubagentPoolOptions } from './subagents.js';
import type { WorktreeManager } from '../tools/worktrees.js';
import type { WorktreeBinding } from '../tools/worktree-schema.js';
import { worktreeIdSchema } from '../tools/worktree-schema.js';
import type { worktreeChecksSchema } from '../tools/worktree-schema.js';
import { ToolError } from '../tools/errors.js';
import type { ApprovalAnswer, ApprovalRequest } from '../tools/types.js';

export const worktreeTaskTools = [
  'ReadFile',
  'Glob',
  'Grep',
  'WriteFile',
  'EditFile',
  'Bash',
] as const;
export const worktreeTaskSchema = subtaskSchema.extend({
  worktree: worktreeIdSchema,
  tools: z
    .array(z.enum(worktreeTaskTools))
    .min(1)
    .max(6)
    .default(['ReadFile', 'Glob', 'Grep', 'WriteFile', 'EditFile'])
    .refine((tools) => new Set(tools).size === tools.length),
});
export const worktreeDelegationSchema = z.strictObject({
  tasks: z.array(worktreeTaskSchema).min(1).max(4),
});
export function worktreeExecution(
  manager: WorktreeManager,
  approve?: (request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalAnswer>,
  acquire?: (
    task: Parameters<NonNullable<SubagentPoolOptions['execution']>['begin']>[0],
    agentId: string,
    signal: AbortSignal,
  ) => Promise<WorktreeBinding>,
): NonNullable<SubagentPoolOptions['execution']> {
  return {
    schema: worktreeDelegationSchema,
    name: 'WorktreeTask',
    begin: async (task, parent, agentId, signal) => {
      if (parent.mode === 'plan' || !task.worktree)
        throw new ToolError('TOOL_PERMISSION', 'Plan或未绑定工作树不能启动写入子任务。');
      const binding = acquire
        ? await acquire(task, agentId, signal)
        : await manager.acquire(task.worktree, agentId, signal);
      try {
        const executor = await parent.forkForWorktree(
          binding,
          {
            mode: parent.mode,
            allowTools: [...task.tools, ...(task.tools.includes('Bash') ? ['HookScript'] : [])],
            ...(approve ? { approve } : {}),
          },
          signal,
        );
        const checks: z.infer<typeof worktreeChecksSchema> = [];
        let omitted = 0;
        return {
          executor,
          worktreeId: binding.id,
          prompt:
            'MEWCODE_WORKTREE_SUBAGENT_V1\n你是隔离工作树内的独立子任务。文件与进程cwd必须使用本工作树；修改仍需既有权限。不得操作主工作树、合并、创建其他工作树或再次委派。',
          observe: (result) => {
            if (result.name !== 'Bash' || !result.data || typeof result.data !== 'object') return;
            const data = result.data as Record<string, unknown>;
            if (data.exitCode !== null && !Number.isInteger(data.exitCode)) return;
            if (checks.length >= 16) {
              omitted++;
              return;
            }
            checks.push({
              callIdHash: createHash('sha256').update(result.callId).digest('hex'),
              ok: result.ok,
              exitCode: data.exitCode as number | null,
              truncated: result.truncated ?? false,
            });
          },
          finish: async (result) => {
            await manager.release(
              binding.id,
              agentId,
              result.status === 'completed'
                ? 'completed'
                : result.status === 'cancelled'
                  ? 'cancelled'
                  : 'failed',
              result.code,
              checks,
              omitted,
            );
          },
        };
      } catch (error) {
        await manager.release(binding.id, agentId, 'failed', 'WORKTREE_BIND_FAILED');
        throw error;
      }
    },
  };
}
