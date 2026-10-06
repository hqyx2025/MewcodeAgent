import { relative, sep } from 'node:path';
import type { LoadedConfiguration } from '../config/load.js';
import { MemoryStore, canonicalMemoryDirectory } from '../core/memory.js';
import { referencedValues } from '../mcp/config.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ScopedPermissionRule } from '../security/rules.js';
import { rulePathSchema } from '../security/rules.js';
import { AppError } from '../shared/errors.js';
import type { MemorySelection } from '../core/memory.js';
import { terminalText } from '../shared/terminal-text.js';

export function printMemoryWarnings(
  warnings: MemorySelection['warnings'],
  shown: Set<string>,
): void {
  for (const warning of warnings) {
    const key = `memory:${warning.scope}:${warning.code}`;
    if (shown.has(key)) continue;
    shown.add(key);
    process.stderr.write(
      terminalText(`记忆警告 ${warning.code}：${warning.scope}；相应来源或敏感条目未加载。\n`),
    );
  }
}

export function memorySecrets(loaded: LoadedConfiguration): string[] {
  const name =
    loaded.settings.provider.apiKeyEnv ??
    (loaded.settings.provider.kind === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY');
  return [
    process.env[name] ?? '',
    ...Object.values(loaded.settings.mcp.servers).flatMap((config) =>
      referencedValues(config, process.env),
    ),
  ].filter(Boolean);
}
export async function memoryRuntime(loaded: LoadedConfiguration, registry: ToolRegistry) {
  const userDirectory = await canonicalMemoryDirectory(loaded.paths.userDirectory);
  const store = new MemoryStore(loaded.cwd, userDirectory, memorySecrets(loaded));
  store.register(registry);
  return { store, rules: await memoryProtection(loaded) };
}
export async function memoryProtection(
  loaded: LoadedConfiguration,
): Promise<ScopedPermissionRule[]> {
  const rules: ScopedPermissionRule[] = [];
  // Default .mewcode paths are reserved by ProjectPaths. A custom user directory
  // within the project needs equivalent protection from the generic file tools.
  const userDirectory = await canonicalMemoryDirectory(loaded.paths.userDirectory);
  const local = relative(loaded.cwd, userDirectory).split(sep).join('/');
  if (
    local !== '..' &&
    !local.startsWith('../') &&
    !local.includes(':') &&
    local.toLowerCase() !== '.mewcode'
  ) {
    const scope = local || '.';
    if (!rulePathSchema.safeParse(scope).success)
      throw new AppError('MEMORY_INVALID', '项目内用户记忆目录不符合安全路径规则。');
    for (const tool of ['ReadFile', 'WriteFile', 'EditFile', 'Glob', 'Grep'])
      rules.push({ source: 'cli', tool, decision: 'deny', path: scope });
  }
  return rules;
}
