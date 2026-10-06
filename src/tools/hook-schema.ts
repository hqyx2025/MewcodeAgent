import { z } from 'zod';

export const hookEvents = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SessionEnd',
] as const;
export const hookSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
    event: z.enum(hookEvents),
    script: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => !value.includes('\0')),
    tool: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/)
      .optional(),
    timeoutMs: z.number().int().min(1).max(60_000).default(5000),
    env: z
      .array(
        z
          .string()
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
          .refine((name) => !/^(NODE_|PATH$|PATHEXT$|SYSTEMROOT$|COMSPEC$)/i.test(name)),
      )
      .max(16)
      .default([]),
  })
  .superRefine((value, context) => {
    if (value.tool && !['PreToolUse', 'PostToolUse'].includes(value.event))
      context.addIssue({ code: 'custom', message: 'tool仅用于工具事件' });
  });
export const hookSettingsSchema = z
  .array(hookSchema)
  .max(32)
  .superRefine((hooks, context) => {
    if (new Set(hooks.map((hook) => hook.id)).size !== hooks.length)
      context.addIssue({ code: 'custom', message: 'Hook id必须唯一' });
  });
export const hookOutputSchema = z.strictObject({
  decision: z.enum(['continue', 'block']),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
});
export type HookConfiguration = z.infer<typeof hookSchema>;
export type HookDecision = z.infer<typeof hookOutputSchema>;
export type HookEventName = (typeof hookEvents)[number];
