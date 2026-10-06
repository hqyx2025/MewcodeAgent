import { z } from 'zod';

export const rulePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      path === '.' ||
      path
        .split('/')
        .every(
          (part) =>
            part.length > 0 &&
            part !== '.' &&
            part !== '..' &&
            !/[\\:*?[\]{}()]/.test(part) &&
            ![...part].some((char) => char.charCodeAt(0) < 32) &&
            !(process.platform === 'win32' && /~\d/.test(part)) &&
            !/[. ]$/.test(part),
        ),
    '权限path必须是项目相对字面路径，使用/且不含别名或glob',
  );

export const permissionRuleSchema = z.strictObject({
  decision: z.enum(['allow', 'ask', 'deny']),
  tool: z
    .string()
    .regex(/^[A-Za-z][\w.-]{0,127}$/)
    .optional(),
  effect: z.enum(['read', 'write', 'shell']).optional(),
  path: rulePathSchema.optional(),
});

export type PermissionRule = z.infer<typeof permissionRuleSchema>;
export type RuleSource = 'user' | 'project' | 'cli' | 'parent';
export interface ScopedPermissionRule extends PermissionRule {
  source: RuleSource;
}

export function within(path: string, scope: string): boolean {
  if (process.platform === 'win32') {
    path = path.toLowerCase();
    scope = scope.toLowerCase();
  }
  return scope === '.' || path === scope || path.startsWith(scope + '/');
}
