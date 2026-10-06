import { z } from 'zod';
import { subtaskSchema } from './subagent-schema.js';
import { worktreeTaskTools } from './worktree-tasks.js';
import { worktreeChecksSchema } from '../tools/worktree-schema.js';
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/);
export const teamTools = [...worktreeTaskTools, 'TeamSend', 'TeamInbox'] as const;
export const teamTaskSchema = subtaskSchema.omit({ retryOf: true, tools: true }).extend({
  member: slug,
  dependsOn: z.array(slug).max(8).default([]),
  tools: z
    .array(z.enum(teamTools))
    .min(1)
    .max(8)
    .default(['ReadFile', 'Glob', 'Grep', 'WriteFile', 'EditFile', 'TeamSend', 'TeamInbox'])
    .refine((value) => new Set(value).size === value.length),
});
export const teamSettingsSchema = z.strictObject({
  concurrency: z.number().int().min(1).max(4).default(2),
  maxTotalTokens: z.number().int().min(1024).max(200_000).default(60_000),
  taskTokens: z.number().int().min(1024).max(200_000).default(40_000),
  maxTurns: z.number().int().min(1).max(12).default(6),
  timeoutMs: z.number().int().min(1).max(120_000).default(30_000),
  maxOutputTokens: z.number().int().min(128).max(8192).default(2048),
  maxMessages: z.number().int().min(1).max(128).default(64),
});
const memberSchema = z.strictObject({
  id: slug,
  role: z.string().trim().min(1).max(256),
  worktree: z.string().uuid(),
});
export const teamCreateSchema = z.strictObject({
  name: slug,
  members: z.array(memberSchema).min(1).max(4),
  tasks: z.array(teamTaskSchema).min(1).max(32),
  settings: teamSettingsSchema.default(() => teamSettingsSchema.parse({})),
});
export const teamAddSchema = z.strictObject({ tasks: z.array(teamTaskSchema).min(1).max(4) });
export const teamSendSchema = z.strictObject({
  messageId: z.string().uuid(),
  to: z.union([slug, z.literal('coordinator')]),
  task: slug.optional(),
  text: z.string().trim().min(1).max(1024),
});
export const teamResultSchema = z.strictObject({
  worktreeId: z.string().uuid().optional(),
  id: slug,
  agentId: z.string().uuid(),
  status: z.enum([
    'queued',
    'running',
    'completed',
    'failed',
    'cancelled',
    'budget_exhausted',
    'rejected',
  ]),
  code: z.string().regex(/^[A-Z_]{1,64}$/),
  tokens: z.number().int().nonnegative(),
  estimated: z.boolean(),
  summary: z.string().max(4096),
  evidence: z
    .array(
      z.strictObject({
        path: z.string().max(4096),
        line: z.number().int().positive().optional(),
        note: z.string().max(512),
        kind: z.enum(['read', 'match', 'listing']),
        revision: z.string().optional(),
      }),
    )
    .max(16),
  omittedEvidence: z.number().int().nonnegative(),
  truncated: z.boolean(),
});
export const teamStateSchema = z.strictObject({
  app: z.literal('mewcode-teams'),
  version: z.literal(1),
  id: z.string().uuid(),
  repository: z.string(),
  name: slug,
  createdAt: z.string().datetime(),
  revision: z.number().int().nonnegative(),
  settings: teamSettingsSchema,
  usedTokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  estimated: z.boolean(),
  cancelRequested: z.boolean(),
  members: z
    .array(
      memberSchema.extend({
        identity: z.string().uuid(),
        base: z.string().regex(/^[a-f0-9]{40,64}$/),
        branch: z.string(),
        path: z.string(),
        lastAgentId: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(4),
  tasks: z
    .array(
      teamTaskSchema.extend({
        status: z.enum([
          'queued',
          'running',
          'completed',
          'failed',
          'cancelled',
          'blocked',
          'uncertain',
        ]),
        attempt: z.number().int().min(0).max(3),
        claim: z
          .strictObject({
            id: z.string().uuid(),
            runId: z.string().uuid(),
            agentId: z.string().uuid(),
            reservedTokens: z.number().int().positive().max(200_000),
            startedAt: z.string().datetime(),
            messages: z.array(z.string().uuid()).max(8),
          })
          .optional(),
        result: teamResultSchema.optional(),
        checks: worktreeChecksSchema.optional(),
        checksOmitted: z.number().int().nonnegative().max(10_000).optional(),
      }),
    )
    .min(1)
    .max(32),
  messages: z
    .array(
      teamSendSchema.extend({
        from: z.union([slug, z.literal('coordinator')]),
        fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        sequence: z.number().int().positive(),
        createdAt: z.string().datetime(),
        deliveredTo: z.string().uuid().optional(),
      }),
    )
    .max(128),
  run: z
    .strictObject({
      id: z.string().uuid(),
      host: z.string().min(1).max(255),
      pid: z.number().int().positive().max(2147483647),
      startedAt: z.string().datetime(),
      limit: z.number().int().positive().max(200_000),
    })
    .optional(),
});
export type TeamState = z.infer<typeof teamStateSchema>;
export type TeamTask = TeamState['tasks'][number];
export function validateGraph(state: Pick<TeamState, 'members' | 'tasks'>): void {
  const members = new Set(state.members.map((member) => member.id));
  const tasks = new Map(state.tasks.map((task) => [task.id, task]));
  if (
    members.size !== state.members.length ||
    new Set(state.members.map((member) => member.worktree)).size !== state.members.length ||
    members.has('coordinator') ||
    tasks.size !== state.tasks.length
  )
    throw new Error('Duplicate identity');
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('Cycle');
    if (visited.has(id)) return;
    const task = tasks.get(id);
    if (
      !task ||
      !members.has(task.member) ||
      new Set(task.dependsOn).size !== task.dependsOn.length
    )
      throw new Error('Unknown dependency');
    visiting.add(id);
    task.dependsOn.forEach(visit);
    visiting.delete(id);
    visited.add(id);
  };
  state.tasks.forEach((task) => visit(task.id));
}
