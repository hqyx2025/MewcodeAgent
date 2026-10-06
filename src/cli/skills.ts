import { isAbsolute, relative, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { LoadedConfiguration } from '../config/load.js';
import { SkillCatalog, skillManifest } from '../core/skills.js';
import type { SkillManifest } from '../core/skills.js';
import { AppError } from '../shared/errors.js';
import { terminalText } from '../shared/terminal-text.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ToolExecutor } from '../tools/executor.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { memorySecrets, memoryProtection } from './memory-runtime.js';

export function skillRuntime(
  loaded: LoadedConfiguration,
  registry: ToolRegistry,
): { catalog: SkillCatalog; bind(executor: ToolExecutor): void } {
  let executor: ToolExecutor | undefined;
  const catalog = new SkillCatalog({
    userDirectory: loaded.paths.userDirectory,
    projectDirectory: loaded.paths.projectDirectory,
    secrets: memorySecrets(loaded),
    allows: (path) => {
      if (!executor) return false;
      const local = relative(executor.paths.root, path);
      const inside = !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`);
      return !inside || executor.allowsInstruction(path);
    },
  });
  catalog.register(registry);
  return {
    catalog,
    bind: (value) => {
      executor = value;
    },
  };
}

export function printSkills(manifest: SkillManifest, shown: Set<string>): void {
  for (const source of manifest.sources) {
    const key = `${source.path}:${source.digest}`;
    if (!shown.has(key)) {
      shown.add(key);
      process.stderr.write(
        terminalText(
          `技能来源：${source.name} [${source.reason}] ${source.path}；${source.bytes} bytes。\n`,
        ),
      );
    }
  }
  for (const warning of manifest.warnings) {
    const key = `skill:${warning.source}:${warning.name ?? ''}:${warning.code}`;
    if (!shown.has(key)) {
      shown.add(key);
      process.stderr.write(
        terminalText(
          `技能警告 ${warning.code}：${warning.source}${warning.name ? `/${warning.name}` : ''}；相应来源未加载。\n`,
        ),
      );
    }
  }
}

export async function manageSkills(
  loaded: LoadedConfiguration,
  action: string,
  name?: string,
  resource?: string,
  options: { content?: boolean; query?: string } = {},
): Promise<void> {
  if (
    !['list', 'show', 'match', 'resource'].includes(action) ||
    ((action === 'show' || action === 'resource') && !name) ||
    (action === 'resource' && !resource) ||
    (action === 'list' && (name || resource)) ||
    (action === 'match' && (name || resource || !options.query)) ||
    (action !== 'resource' && resource)
  )
    throw new AppError('SKILL_INVALID', '请使用 skills list/show/match/resource 的完整参数。');
  const registry = createBuiltinRegistry();
  const runtime = skillRuntime(loaded, registry);
  const executor = await ToolExecutor.create(registry, {
    root: loaded.cwd,
    mode: loaded.settings.mode,
    rules: [...loaded.permissionRules, ...(await memoryProtection(loaded))],
  });
  runtime.bind(executor);
  const signal = AbortSignal.timeout(loaded.settings.limits.timeoutMs);
  if (action === 'list') {
    process.stdout.write(
      `${terminalText(JSON.stringify(await runtime.catalog.list(false, signal), null, 2))}\n`,
    );
    return;
  }
  if (action === 'match') {
    const selection = await runtime.catalog.select(options.query!, [], signal);
    process.stdout.write(`${terminalText(JSON.stringify(skillManifest(selection), null, 2))}\n`);
    return;
  }
  const selection = await runtime.catalog.select('', [name!], signal);
  if (action === 'show') {
    process.stdout.write(
      `${terminalText(JSON.stringify(options.content ? selection : skillManifest(selection), null, 2))}\n`,
    );
    return;
  }
  const result = await executor.execute(
    { callId: randomUUID(), name: 'SkillRead', input: { name, resource } },
    signal,
  );
  process.stdout.write(`${terminalText(JSON.stringify(result, null, 2))}\n`);
  if (!result.ok) process.exitCode = 1;
}
