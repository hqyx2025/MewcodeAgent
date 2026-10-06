import { z } from 'zod';

export const memorySettingsSchema = z.strictObject({
  enabled: z.boolean(),
  injectionBytes: z.number().int().min(512).max(16_384),
});
export type MemorySettings = z.infer<typeof memorySettingsSchema>;
export const defaultMemory: MemorySettings = { enabled: true, injectionBytes: 8192 };
export const memoryScopeSchema = z.enum(['user', 'project']);
export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export const memoryKindSchema = z.enum(['preference', 'convention', 'fact']);
export const memoryTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine((text) => !/[\p{Cc}\p{Cf}]/u.test(text), '记忆必须是无控制字符的单行文本');
export const memorySourceSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('manual') }),
  z.strictObject({
    type: z.literal('session'),
    sessionId: z.string().uuid(),
    checkpoint: z.number().int().min(1).max(10_000),
    message: z.number().int().min(0).max(4095),
    line: z.number().int().min(1).max(1_048_576),
  }),
]);
export const memoryEntrySchema = z.strictObject({
  id: z.string().uuid(),
  kind: memoryKindSchema,
  text: memoryTextSchema,
  source: memorySourceSchema,
  confirmed: z.literal(true),
  updatedAt: z.string().datetime(),
});
export type MemoryEntry = z.infer<typeof memoryEntrySchema>;
export const memoryDocumentSchema = z.strictObject({
  app: z.literal('mewcode-agent'),
  schemaVersion: z.literal(1),
  scope: memoryScopeSchema,
  owner: z.string().min(1).max(4096),
  entries: z.array(memoryEntrySchema).max(100),
});
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;
