import { z } from 'zod';

export const worktreeIdSchema = z.string().uuid();
export const worktreeCreateSchema = z.strictObject({
  task: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  base: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,199}$/)
    .default('HEAD'),
  branch: z
    .string()
    .regex(/^codex\/[a-z][a-z0-9/-]{0,95}$/)
    .optional(),
});
export const worktreeChecksSchema = z
  .array(
    z.strictObject({
      callIdHash: z.string().regex(/^[a-f0-9]{64}$/),
      ok: z.boolean(),
      exitCode: z.number().int().nullable(),
      truncated: z.boolean(),
    }),
  )
  .max(16);
export const worktreeOwnerSchema = z.strictObject({
  app: z.literal('mewcode-worktrees'),
  version: z.literal(1),
  id: worktreeIdSchema,
  repository: z.string(),
  commonDir: z.string(),
  path: z.string(),
  task: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  branch: z.string().regex(/^codex\/[a-z][a-z0-9/-]{0,95}$/),
  base: z.string().regex(/^[a-f0-9]{40,64}$/),
  createdAt: z.string().datetime(),
  status: z.enum(['creating', 'ready', 'running', 'completed', 'failed', 'cancelled', 'removed']),
  agentId: z
    .string()
    .regex(/^[\w.-]{1,128}$/)
    .optional(),
  pid: z.number().int().min(1).max(2147483647).optional(),
  host: z.string().min(1).max(255).optional(),
  outcome: z
    .string()
    .regex(/^[A-Z_]{1,64}$/)
    .optional(),
  checks: worktreeChecksSchema.default([]),
  checksOmitted: z.number().int().min(0).max(10_000).default(0),
});
export type WorktreeOwner = z.infer<typeof worktreeOwnerSchema>;
export interface WorktreeBinding {
  readonly id: string;
  readonly root: string;
  readonly repository: string;
  readonly agentId: string;
  verify(signal: AbortSignal): Promise<void>;
}
