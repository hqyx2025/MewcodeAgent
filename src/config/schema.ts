import { z } from 'zod';
import { permissionRuleSchema } from '../security/rules.js';
import { mcpSettingsSchema } from '../mcp/config.js';
import { contextSchema, defaultContext } from '../core/context.js';
import { memorySettingsSchema, defaultMemory } from '../core/memory-schema.js';
import { hookSettingsSchema } from '../tools/hook-schema.js';

export const providerKinds = ['mock', 'openai-compatible', 'anthropic'] as const;
export const agentModes = ['plan', 'default', 'accept-edits'] as const;

const pathSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, '路径不能为空');
const providerSchema = z.strictObject({
  kind: z.enum(providerKinds),
  model: z.string().trim().min(1),
  wireApi: z.enum(['chat-completions', 'responses']).optional(),
  maxTokensParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  includeUsage: z.boolean().optional(),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
    .optional(),
  baseUrl: z
    .string()
    .url()
    .refine((value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    }, 'baseUrl 必须是无凭据、查询参数和片段的 HTTP(S) 地址')
    .optional(),
});
const limitsSchema = z.strictObject({
  maxTurns: z.number().int().min(1).max(1_000),
  timeoutMs: z.number().int().min(1).max(3_600_000),
  maxOutputTokens: z.number().int().min(1).max(262_144),
});
const storageSchema = z.strictObject({
  directory: pathSchema.optional(),
  logFile: pathSchema.optional(),
});
const permissionsSchema = z.strictObject({ rules: z.array(permissionRuleSchema).max(400) });

export const configPatchSchema = z.strictObject({
  hooks: hookSettingsSchema.optional(),
  memory: memorySettingsSchema.partial().optional(),
  context: contextSchema.partial().optional(),
  mcp: mcpSettingsSchema.optional(),
  provider: providerSchema.partial().optional(),
  mode: z.enum(agentModes).optional(),
  limits: limitsSchema.partial().optional(),
  storage: storageSchema.optional(),
  permissions: permissionsSchema.partial().optional(),
});

export const configSchema = z
  .strictObject({
    hooks: hookSettingsSchema.default([]),
    memory: memorySettingsSchema.default(defaultMemory),
    context: contextSchema.default(defaultContext),
    mcp: mcpSettingsSchema.default({ servers: {} }),
    provider: providerSchema,
    mode: z.enum(agentModes),
    limits: limitsSchema,
    storage: storageSchema,
    permissions: permissionsSchema,
  })
  .superRefine((value, context) => {
    if (value.limits.maxOutputTokens >= value.context.windowTokens)
      context.addIssue({
        code: 'custom',
        path: ['context', 'windowTokens'],
        message: '模型窗口必须大于输出预留token数',
      });
    if (value.provider.kind !== 'mock' && value.provider.model === 'mock-v1') {
      context.addIssue({
        code: 'custom',
        path: ['provider', 'model'],
        message: '真实模型必须显式指定 model，不能使用 mock-v1',
      });
    }
  });

export type Settings = z.infer<typeof configSchema>;
export type ConfigPatch = z.infer<typeof configPatchSchema>;

export const defaultSettings: Settings = {
  hooks: [],
  memory: defaultMemory,
  context: defaultContext,
  mcp: { servers: {} },
  provider: { kind: 'mock', model: 'mock-v1' },
  mode: 'default',
  limits: { maxTurns: 20, timeoutMs: 120_000, maxOutputTokens: 4_096 },
  storage: {},
  permissions: { rules: [] },
};

export function mergeSettings(current: Settings, patch: ConfigPatch): Settings {
  return {
    hooks: [...current.hooks, ...(patch.hooks ?? [])],
    memory: mergeDefined(current.memory, patch.memory),
    context: mergeDefined(current.context, patch.context),
    mcp: { servers: { ...current.mcp.servers, ...patch.mcp?.servers } },
    provider: mergeDefined(current.provider, patch.provider),
    mode: patch.mode ?? current.mode,
    limits: mergeDefined(current.limits, patch.limits),
    storage: mergeDefined(current.storage, patch.storage),
    permissions: { rules: [...current.permissions.rules, ...(patch.permissions?.rules ?? [])] },
  };
}

function mergeDefined<T extends object>(
  current: T,
  patch: { [K in keyof T]?: T[K] | undefined } | undefined,
): T {
  const merged = { ...current };
  if (patch !== undefined) {
    for (const key of Object.keys(patch) as (keyof T)[]) {
      const value = patch[key];
      if (value !== undefined) merged[key] = value;
    }
  }
  return merged;
}
