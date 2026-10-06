import { isAbsolute } from 'node:path';
import { z } from 'zod';

const name = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);
const references = z.record(name, name).refine((value) => Object.keys(value).length <= 32);
const common = {
  connectTimeoutMs: z.number().int().min(1).max(60_000).default(15_000),
  callTimeoutMs: z.number().int().min(1).max(300_000).default(30_000),
};
export const mcpServerSchema = z.discriminatedUnion('transport', [
  z.strictObject({
    transport: z.literal('stdio'),
    command: z
      .string()
      .max(4096)
      .refine((value) => isAbsolute(value) && !value.includes('\0')),
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((value) => !value.includes('\0')),
      )
      .max(64)
      .default([]),
    cwd: z.string().min(1).max(4096).default('.'),
    env: references.default({}),
    ...common,
  }),
  z.strictObject({
    transport: z.literal('http'),
    url: z
      .string()
      .max(4096)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      }),
    headersEnv: z
      .record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/), name)
      .refine(
        (value) =>
          Object.keys(value).length <= 16 &&
          Object.keys(value).every(
            (key) =>
              ![
                'host',
                'content-type',
                'content-length',
                'accept',
                'connection',
                'transfer-encoding',
              ].includes(key.toLowerCase()) && !key.toLowerCase().startsWith('mcp-'),
          ),
      )
      .default({}),
    ...common,
  }),
]);
export const mcpSettingsSchema = z.strictObject({
  servers: z
    .record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), mcpServerSchema)
    .refine((value) => Object.keys(value).length <= 8),
});
export type MCPServerConfig = z.infer<typeof mcpServerSchema>;

export function referencedValues(config: MCPServerConfig, env: NodeJS.ProcessEnv): string[] {
  return Object.values(config.transport === 'stdio' ? config.env : config.headersEnv)
    .map((key) => env[key])
    .filter((value): value is string => Boolean(value));
}
