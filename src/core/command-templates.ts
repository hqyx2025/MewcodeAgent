import { opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { AppError } from '../shared/errors.js';
import { redactInstruction } from '../shared/redact.js';
import type { CommandInfo, CommandTemplates } from './commands.js';
import { safeDirectory, readBoundedText } from '../shared/bounded-files.js';

const MAX_FILE = 65_536;
const MAX_HEADER = 4096;
interface Entry extends CommandInfo {
  path: string;
}
function fail(): never {
  throw new AppError('COMMAND_IO', '命令模板路径、元数据、编码或体积无效；未执行模板中的操作。');
}

function document(text: string): { description: string; arguments: string; body: string } {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n'))
    return { description: 'Markdown 文本任务', arguments: '[arguments]', body: text };
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match || Buffer.byteLength(match[0]) > MAX_HEADER) fail();
  let meta: unknown;
  try {
    meta = load(match[1]!, { schema: JSON_SCHEMA });
  } catch {
    fail();
  }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) fail();
  const values = meta as Record<string, unknown>;
  if (Object.keys(values).some((key) => !['description', 'argument-hint'].includes(key))) fail();
  for (const value of Object.values(values)) {
    if (
      typeof value !== 'string' ||
      value.length > 256 ||
      [...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      fail();
  }
  return {
    description: (values.description as string) ?? 'Markdown 文本任务',
    arguments: (values['argument-hint'] as string) ?? '[arguments]',
    body: text.slice(match[0].length),
  };
}

/** Index only bounded header prefixes; read and revalidate a body on each explicit invocation. */
export class MarkdownCommands implements CommandTemplates {
  private entries?: Map<string, Entry>;
  constructor(
    private readonly options: {
      userDirectory: string;
      projectDirectory: string;
      allows(path: string): boolean;
      secrets?: readonly string[];
    },
  ) {}

  async list(refresh = false): Promise<CommandInfo[]> {
    if (!this.entries || refresh) {
      const entries = new Map<string, Entry>();
      try {
        for (const source of ['user', 'project'] as const) {
          let directory = join(this.options[`${source}Directory`], 'commands');
          if (!this.options.allows(directory)) continue;
          try {
            directory = await safeDirectory(directory);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
            throw error;
          }
          if (!this.options.allows(directory)) continue;
          const stream = await opendir(directory);
          let count = 0;
          const names: string[] = [];
          for await (const item of stream) {
            if (++count > 128) fail();
            if (/^[a-z][a-z0-9-]{0,47}\.md$/.test(item.name)) names.push(item.name);
          }
          for (const file of names.sort()) {
            const path = join(directory, file);
            if (!this.options.allows(path)) continue;
            const header = await readBoundedText(path, MAX_FILE, MAX_HEADER);
            if (redactInstruction(header, this.options.secrets) !== header) fail();
            const meta = document(header);
            const name = file.slice(0, -3);
            entries.set(name, {
              name,
              description: meta.description,
              arguments: meta.arguments,
              kind: 'task',
              source,
              path,
            });
          }
        }
      } catch {
        fail();
      }
      this.entries = entries;
    }
    return Array.from(this.entries.values(), ({ path: _path, ...info }) => info);
  }

  async expand(name: string, args: readonly string[], raw: string): Promise<string> {
    await this.list();
    const entry = this.entries!.get(name);
    if (!entry) throw new AppError('COMMAND_INVALID', '未知命令，请使用 /help。');
    try {
      await safeDirectory(resolve(entry.path, '..'));
      if (!this.options.allows(entry.path)) fail();
      const text = await readBoundedText(entry.path, MAX_FILE);
      if (redactInstruction(text, this.options.secrets) !== text) fail();
      const body = document(text).body;
      // One replacement pass: inserted arguments cannot create more placeholders or commands.
      const parts: string[] = [];
      let bytes = 0,
        offset = 0;
      const append = (value: string) => {
        bytes += Buffer.byteLength(value);
        if (bytes > 262_144) fail();
        parts.push(value);
      };
      for (const match of body.matchAll(/\$ARGUMENTS\b|\$([1-9][0-9]?)(?![0-9])/g)) {
        append(body.slice(offset, match.index));
        const value = match[0] === '$ARGUMENTS' ? raw : args[Number(match[1]) - 1];
        if (value === undefined || (match[0] !== '$ARGUMENTS' && !value.trim()))
          throw new AppError('COMMAND_INVALID', '模板缺少必需的位置参数，请查看 /help 命令名。');
        append(value);
        offset = match.index + match[0].length;
      }
      append(body.slice(offset));
      const prompt = parts.join('');
      if (!prompt.trim()) fail();
      return prompt;
    } catch (error) {
      if (error instanceof AppError) throw error;
      fail();
    }
  }
}
