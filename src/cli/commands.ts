import { relative, sep, isAbsolute } from 'node:path';
import type { LoadedConfiguration } from '../config/load.js';
import { CommandRegistry } from '../core/commands.js';
import type { CommandHost } from '../core/commands.js';
import { MarkdownCommands } from '../core/command-templates.js';
import type { ToolExecutor } from '../tools/executor.js';
import type { ToolMode } from '../tools/types.js';
import { AppError } from '../shared/errors.js';
import { memorySecrets } from './memory-runtime.js';
import { redactInstruction } from '../shared/redact.js';
import type { SkillCatalog } from '../core/skills.js';

export function commandRuntime(
  loaded: LoadedConfiguration,
  executor: ToolExecutor,
  host?: Pick<CommandHost, 'clear' | 'compact' | 'setModel'>,
  skills?: SkillCatalog,
): CommandRegistry {
  const ceiling = loaded.settings.mode;
  const rank = { plan: 0, default: 1, 'accept-edits': 2 };
  const setMode = (mode: ToolMode) => {
    if (rank[mode] > rank[ceiling])
      throw new AppError('COMMAND_INVALID', '不能通过 Slash Command 放宽启动时的权限上限。');
    executor.setMode(mode);
    loaded.settings.mode = mode;
  };
  return new CommandRegistry(
    {
      ...host,
      ...(skills
        ? {
            skills: async (refresh: boolean) => JSON.stringify(await skills.list(refresh), null, 2),
          }
        : {}),
      model: () => loaded.settings.provider.model,
      setModel: (model) => {
        if (redactInstruction(model, memorySecrets(loaded)) !== model)
          throw new AppError('COMMAND_INVALID', '模型名称无效。');
        host?.setModel?.(model);
        loaded.settings.provider.model = model;
      },
      mode: () => executor.mode,
      setMode,
      permissions: () =>
        JSON.stringify({ mode: executor.mode, ceiling, ...executor.policyMetadata }, null, 2),
    },
    new MarkdownCommands({
      userDirectory: loaded.paths.userDirectory,
      projectDirectory: loaded.paths.projectDirectory,
      secrets: memorySecrets(loaded),
      allows: (path) => {
        const local = relative(loaded.cwd, path);
        const inside = !isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`);
        return !inside || executor.allowsInstruction(path);
      },
    }),
  );
}
