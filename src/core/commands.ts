import { AppError } from '../shared/errors.js';
import type { ToolMode } from '../tools/types.js';
import { redactInstruction } from '../shared/redact.js';

export interface CommandInfo {
  name: string;
  description: string;
  arguments: string;
  kind: 'local' | 'task';
  source: 'builtin' | 'user' | 'project';
}
export type CommandResult =
  | { kind: 'local'; text: string; clear?: true }
  | { kind: 'task'; prompt: string; skills?: readonly string[] }
  | { kind: 'agent'; prompt: string; mode: ToolMode; resume?: string };
export interface CommandHost {
  model(): string;
  setModel(model: string): void;
  mode(): ToolMode;
  setMode(mode: ToolMode): void;
  permissions(): string;
  clear?(): void;
  compact?(): string | Promise<string>;
  skills?(refresh: boolean): Promise<string>;
}
export interface CommandTemplates {
  list(refresh?: boolean): Promise<CommandInfo[]>;
  expand(name: string, args: readonly string[], raw: string): Promise<string>;
}

export const builtinCommands: readonly CommandInfo[] = [
  {
    name: 'skills',
    description: '查看技能元数据；refresh 重建技能索引',
    arguments: '[refresh]',
    kind: 'local',
    source: 'builtin',
  },
  {
    name: 'skill',
    description: '为本轮任务明确指定一个技能',
    arguments: '<name> <task>',
    kind: 'task',
    source: 'builtin',
  },
  {
    name: 'help',
    description: '查看帮助；--refresh 重建模板索引',
    arguments: '[name | --refresh]',
    kind: 'local',
    source: 'builtin',
  },
  {
    name: 'clear',
    description: '清空 chat 上下文与当前展示',
    arguments: '',
    kind: 'local',
    source: 'builtin',
  },
  {
    name: 'model',
    description: '查看/切换当前服务的模型',
    arguments: '[model]',
    kind: 'local',
    source: 'builtin',
  },
  {
    name: 'permissions',
    description: '查看规则或切换权限模式',
    arguments: '[plan | default | accept-edits]',
    kind: 'local',
    source: 'builtin',
  },
  {
    name: 'compact',
    description: '本地压缩 chat 历史，不调用模型',
    arguments: '',
    kind: 'local',
    source: 'builtin',
  },
  {
    name: 'resume',
    description: '交给 Agent 恢复持久会话',
    arguments: '<session-id> [task]',
    kind: 'task',
    source: 'builtin',
  },
  {
    name: 'plan',
    description: '开关只读模式，或启动只读 Agent 任务',
    arguments: '[on | off | task]',
    kind: 'local',
    source: 'builtin',
  },
];

function invalid(): never {
  throw new AppError('COMMAND_INVALID', '命令或参数无效，请使用 /help 查看用法。');
}

/** Shell syntax has no meaning here. Quotes group text; backslashes are literal. */
export function parseCommand(
  input: string,
): { name: string; args: string[]; raw: string } | undefined {
  if (Buffer.byteLength(input) > 262_144) invalid();
  const text = input.trim();
  if (!text.startsWith('/')) return undefined;
  const match = /^\/([a-z][a-z0-9-]{0,47})(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) invalid();
  const raw = match[2] ?? '';
  const args: string[] = [];
  let word = '',
    quote = '',
    started = false;
  for (const character of raw) {
    if (quote) {
      if (character === quote) quote = '';
      else word += character;
      started = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/u.test(character)) {
      if (started) {
        args.push(word);
        word = '';
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
    if (args.length > 64) invalid();
  }
  if (quote) invalid();
  if (started) args.push(word);
  if (args.length > 64) invalid();
  return { name: match[1]!, args, raw };
}

export class CommandRegistry {
  private active = false;
  private indexed: CommandInfo[] = [...builtinCommands];
  constructor(
    private readonly host: CommandHost,
    private readonly templates?: CommandTemplates,
  ) {}

  async list(refresh = false): Promise<CommandInfo[]> {
    const custom = (await this.templates?.list(refresh)) ?? [];
    this.indexed = [
      ...builtinCommands,
      ...custom.filter((entry) => !builtinCommands.some((item) => item.name === entry.name)),
    ];
    return structuredClone(this.indexed);
  }

  complete(input: string): string[] {
    if (!/^\/[a-z0-9-]*$/.test(input)) return [];
    return this.indexed
      .map((item) => `/${item.name}`)
      .filter((name) => name.startsWith(input))
      .sort();
  }

  async execute(input: string, busy = false): Promise<CommandResult> {
    if (busy || this.active)
      throw new AppError('BUSY', '生成、工具执行、审批或压缩期间不能提交命令。');
    this.active = true;
    try {
      const command = parseCommand(input);
      if (!command) return { kind: 'task', prompt: input };
      const { name, args, raw } = command;
      const local = (text: string): CommandResult => ({ kind: 'local', text });
      switch (name) {
        case 'skills':
          if (!this.host.skills || args.length > 1 || (args.length && args[0] !== 'refresh'))
            invalid();
          return local(await this.host.skills(args[0] === 'refresh'));
        case 'skill':
          if (
            args.length < 2 ||
            !/^[a-z][a-z0-9-]{0,47}$/.test(args[0]!) ||
            !args.slice(1).join(' ').trim()
          )
            invalid();
          return { kind: 'task', prompt: args.slice(1).join(' '), skills: [args[0]!] };
        case 'help': {
          if (args.length > 1) invalid();
          const entries = await this.list(args[0] === '--refresh');
          const selected =
            args[0] && args[0] !== '--refresh'
              ? entries.filter((item) => item.name === args[0]!.replace(/^\//, ''))
              : entries;
          if (!selected.length) invalid();
          return local(
            selected
              .map(
                (item) =>
                  `/${item.name} ${item.arguments} — ${item.description} [${item.source}; ${item.kind}]`,
              )
              .join('\n'),
          );
        }
        case 'clear':
          if (args.length || !this.host.clear) invalid();
          this.host.clear();
          return { kind: 'local', text: 'chat 上下文已清空；持久 Agent 会话保留。', clear: true };
        case 'compact':
          if (args.length || !this.host.compact) invalid();
          return local(await this.host.compact());
        case 'model':
          if (args.length > 1) invalid();
          if (args.length) {
            if (
              !/^[\p{L}\p{N}_.:/-]{1,128}$/u.test(args[0]!) ||
              redactInstruction(args[0]!) !== args[0]
            )
              invalid();
            this.host.setModel(args[0]!);
          }
          return local(`模型：${this.host.model()}（当前 provider）`);
        case 'permissions':
          if (args.length > 1) invalid();
          if (args.length) {
            if (!['plan', 'default', 'accept-edits'].includes(args[0]!)) invalid();
            this.host.setMode(args[0] as ToolMode);
          }
          return local(this.host.permissions());
        case 'plan':
          if (!args.length || (args.length === 1 && ['on', 'off'].includes(args[0]!))) {
            this.host.setMode(args[0] === 'off' ? 'default' : 'plan');
            return local(`模式：${this.host.mode()}；chat 仍为纯对话。`);
          }
          return { kind: 'agent', prompt: args.join(' '), mode: 'plan' };
        case 'resume':
          if (!args.length || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(args[0]!))
            invalid();
          return {
            kind: 'agent',
            prompt: args.slice(1).join(' '),
            mode: this.host.mode(),
            resume: args[0]!,
          };
        default: {
          const entries = await this.list();
          if (!this.templates || !entries.some((item) => item.name === name)) invalid();
          return { kind: 'task', prompt: await this.templates.expand(name, args, raw) };
        }
      }
    } finally {
      this.active = false;
    }
  }
}
