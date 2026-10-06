import { z } from 'zod';

export const subagentTools = ['ReadFile', 'Glob', 'Grep'] as const;
export const subagentSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  concurrency: z.number().int().min(1).max(4),
  maxTasks: z.number().int().min(1).max(32),
  timeoutMs: z.number().int().min(1).max(120_000),
  maxTurns: z.number().int().min(1).max(12),
  maxTotalTokens: z.number().int().min(1024).max(200_000),
  maxOutputTokens: z.number().int().min(128).max(8192),
  resultBytes: z.number().int().min(512).max(8192),
});
export type SubagentSettings = z.infer<typeof subagentSettingsSchema>;
export const defaultSubagents: SubagentSettings = {
  enabled: false,
  concurrency: 2,
  maxTasks: 8,
  timeoutMs: 30_000,
  maxTurns: 6,
  maxTotalTokens: 60_000,
  maxOutputTokens: 2048,
  resultBytes: 4096,
};
export const subtaskSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
  goal: z.string().trim().min(1).max(2048),
  context: z.string().max(4096).default(''),
  tools: z
    .array(z.enum(subagentTools))
    .min(1)
    .max(3)
    .default([...subagentTools])
    .refine((tools) => new Set(tools).size === tools.length),
  retryOf: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,23}$/)
    .optional(),
});
export const delegationSchema = z.strictObject({ tasks: z.array(subtaskSchema).min(1).max(4) });
export type Subtask = z.infer<typeof subtaskSchema>;
export const childAnswerSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4096),
  evidence: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4096),
        line: z.number().int().min(1).optional(),
        note: z.string().max(512).default(''),
      }),
    )
    .max(16),
});
