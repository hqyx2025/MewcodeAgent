import type { LoadedConfiguration } from '../config/load.js';
import { HookRuntime } from '../tools/hooks.js';
import type { HookAudit } from '../tools/hook-types.js';
import type { ToolRegistry } from '../tools/registry.js';

export function hookRuntime(
  loaded: LoadedConfiguration,
  registry: ToolRegistry,
  audit: (record: Readonly<HookAudit>) => Promise<void>,
  secrets: readonly string[] = [],
) {
  const keyEnv =
    loaded.settings.provider.apiKeyEnv ??
    (loaded.settings.provider.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  const value = process.env[keyEnv];
  return new HookRuntime(registry, loaded.settings.hooks, {
    audit,
    env: process.env,
    sensitiveValues: [...secrets, ...(value ? [value] : [])],
  });
}

export function inspectHooks(loaded: LoadedConfiguration): void {
  process.stdout.write(
    JSON.stringify(
      {
        hooks: loaded.settings.hooks,
        execution: 'Node ESM script snapshot; explicit shell approval; project-root paths',
        plan: 'scripts forbidden; security events fail closed',
        activation: 'run and tool only; chat/prompt/config/list do not execute hooks',
      },
      null,
      2,
    ) + '\n',
  );
}
