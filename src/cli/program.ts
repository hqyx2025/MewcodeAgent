import { Command } from 'commander';
import metadata from '../../package.json' with { type: 'json' };
import type { ConfigPatch } from '../config/schema.js';

interface CLIOptions {
  cwd?: string;
  config?: string;
  provider?: string;
  model?: string;
  mode?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  mcp?: string[];
  storageDir?: string;
  logFile?: string;
  json?: boolean;
}

async function loadOptions(options: CLIOptions) {
  const { loadConfiguration } = await import('../config/load.js');
  const { configPatchSchema } = await import('../config/schema.js');
  const { AppError } = await import('../shared/errors.js');
  const provider: Record<string, string> = {};
  const storage: Record<string, string> = {};
  for (const [option, field] of [
    ['provider', 'kind'],
    ['model', 'model'],
    ['baseUrl', 'baseUrl'],
    ['apiKeyEnv', 'apiKeyEnv'],
  ] as const) {
    if (options[option] !== undefined) provider[field] = options[option];
  }
  if (options.storageDir !== undefined) storage.directory = options.storageDir;
  if (options.logFile !== undefined) storage.logFile = options.logFile;
  const raw: Record<string, unknown> = {};
  if (Object.keys(provider).length > 0) raw.provider = provider;
  if (Object.keys(storage).length > 0) raw.storage = storage;
  if (options.mode !== undefined) raw.mode = options.mode;
  const result = configPatchSchema.safeParse(raw);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join('.')).join('、');
    throw new AppError('CONFIG_INVALID', `命令行配置无效，请检查：${fields}`);
  }
  const overrides: ConfigPatch = result.data;
  return loadConfiguration({
    overrides,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.config === undefined ? {} : { configFile: options.config }),
  });
}

export function createProgram(): Command {
  const program = new Command();
  program
    .name('mewcode')
    .description('MewCode Agent — TypeScript / Node.js CLI coding agent')
    .version(metadata.version)
    .option('--cwd <directory>', '指定项目工作目录')
    .option('--config <file>', '替代项目配置文件；相对路径基于工作目录')
    .option('--provider <kind>', 'mock / openai-compatible / anthropic')
    .option('--model <name>', '覆盖模型名称')
    .option('--mode <mode>', 'plan / default / accept-edits')
    .option('--base-url <url>', '覆盖模型服务地址（不含凭据）')
    .option('--api-key-env <name>', '指定密钥环境变量名称，不接受密钥值')
    .option('--storage-dir <directory>', '覆盖会话与缓存存储目录')
    .option('--log-file <file>', '覆盖日志文件路径')
    .exitOverride();

  program
    .command('config')
    .description('校验并查看有效配置（不解析或输出密钥值）')
    .option('--json', '输出机器可读 JSON')
    .action(async (_options: unknown, command: Command) => {
      const options = command.optsWithGlobals<CLIOptions>();
      const loaded = await loadOptions(options);
      const output = JSON.stringify(loaded, null, 2);
      process.stdout.write(
        options.json ? `${output}\n` : `有效配置（密钥只引用环境变量名称）：\n${output}\n`,
      );
    });

  program
    .command('demo')
    .description('无需 API 密钥的离线流式演示，不访问网络或修改项目文件')
    .argument('[prompt]', '演示输入', '检查 MewCode Agent 基础工程')
    .action(async (prompt: string, _options: unknown, command: Command) => {
      const loaded = await loadOptions(command.optsWithGlobals<CLIOptions>());
      const { MockProvider } = await import('../providers/mock.js');
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once('SIGINT', cancel);
      process.stdout.write('离线演示（MockProvider，无网络请求）\n');
      try {
        const provider = new MockProvider();
        for await (const event of provider.stream(
          {
            model: 'mock-v1',
            messages: [{ role: 'user', content: prompt }],
            maxOutputTokens: loaded.settings.limits.maxOutputTokens,
          },
          controller.signal,
        )) {
          if (event.type === 'text_delta') process.stdout.write(event.text);
          if (event.type === 'finish') process.stdout.write('\n');
        }
      } finally {
        process.removeListener('SIGINT', cancel);
      }
    });

  program
    .command('chat')
    .description('流式对话；TTY下无参数启动多轮界面，带参数或管道输入时输出纯文本')
    .argument('[prompt]', '单次问题；省略时启动交互或读取标准输入')
    .action(async (prompt: string | undefined, _options: unknown, command: Command) => {
      const loaded = await loadOptions(command.optsWithGlobals<CLIOptions>());
      const { runChat } = await import('./chat.js');
      await runChat(loaded, prompt);
    });

  program.action(() => program.outputHelp());
  program
    .command('permissions')
    .description('查看有效权限模式、规则来源和审批范围，不调用模型')
    .action(async (_options: unknown, command: Command) => {
      const loaded = await loadOptions(command.optsWithGlobals<CLIOptions>());
      const { inspectPermissions } = await import('./permissions.js');
      inspectPermissions(loaded);
    });
  program
    .command('prompt')
    .description('查看系统提示分段、环境与根指令来源元数据，不调用模型或输出正文')
    .option('--json', '输出JSON元数据')
    .action(async (_options: unknown, command: Command) => {
      const loaded = await loadOptions(command.optsWithGlobals<CLIOptions>());
      const { inspectPrompt } = await import('./run.js');
      await inspectPrompt(loaded, command.opts<{ json?: boolean }>().json ?? false);
    });
  program
    .command('run')
    .description('执行有界 Agent 任务；逐次审批文件修改与命令，Plan只读')
    .argument('[task]', '编程任务；--resume 时可省略')
    .option('--json', '输出JSONL事件（审批提示仍在stderr）')
    .option('--max-turns <count>', '模型轮数上限（1–1000）')
    .option('--max-total-tokens <count>', '累计输入+输出token上限（无usage时估算）')
    .option('--timeout-ms <milliseconds>', '整个任务时限（1–3600000）')
    .option('--mcp <id...>', '显式连接配置中的 MCP 服务（启动与调用均需审批）')
    .option('--save-session', '保存可恢复会话及长工具结果（凭据脱敏）')
    .option('--resume <id>', '恢复绑定当前项目的会话，不重放旧动作')
    .option('--audit-file <file>', '将脱敏权限决策写入新JSONL文件（父目录须存在）')
    .action(async (task: string | undefined, _options: unknown, command: Command) => {
      const loaded = await loadOptions(command.optsWithGlobals<CLIOptions>());
      const { runAgent } = await import('./run.js');
      await runAgent(loaded, task ?? '', command.opts());
    });
  program
    .command('sessions')
    .description('会话列表、元数据、检查点、压缩、结果、解锁与删除；不调用模型')
    .argument('[action]', 'list / show / compact / result / unlock / delete', 'list')
    .argument('[id]', '会话UUID')
    .argument('[file]', 'result的输出文件名')
    .option('--content', 'show显式输出脱敏历史正文')
    .option('--checkpoint <sequence>', '查看指定历史检查点（需要--content）')
    .action(
      async (
        action: string,
        id: string | undefined,
        file: string | undefined,
        _options: unknown,
        command: Command,
      ) => {
        const loaded = await loadOptions(command.optsWithGlobals<CLIOptions>());
        const { manageSessions } = await import('./sessions.js');
        await manageSessions(loaded, action, id, file, command.opts());
      },
    );
  program
    .command('tools')
    .description('列出六个内置工具与JSON Schema，不访问模型')
    .action(async () => {
      const { listTools } = await import('./tools.js');
      listTools();
    });
  program
    .command('mcp')
    .description('查看或发现显式配置的 MCP 服务')
    .argument('[action]', 'list 或 discover', 'list')
    .argument('[id]', '服务 ID')
    .argument('[tool]', '远端工具名称或本地命名空间名称')
    .option('--approve-start', '明确授权本次服务连接；不能覆盖 Plan 或 deny')
    .option('--approve', '明确授权本次外部工具调用')
    .option('--input <json>', '外部工具参数 JSON')
    .option('--audit-file <file>', '将脱敏权限决策写入新JSONL文件')
    .action(
      async (
        action: string,
        id: string | undefined,
        tool: string | undefined,
        _options: unknown,
        command: Command,
      ) => {
        const loaded = await loadOptions(command.optsWithGlobals<CLIOptions>());
        if (action === 'list') {
          const { listMCP } = await import('./mcp.js');
          listMCP(loaded);
          return;
        }
        if (!['discover', 'call'].includes(action) || !id || (action === 'call' && !tool)) {
          const { AppError } = await import('../shared/errors.js');
          throw new AppError('CONFIG_INVALID', 'mcp discover <id> 或 mcp call <id> <tool>');
        }
        const { runMCP } = await import('./mcp.js');
        await runMCP(loaded, id, action as 'discover' | 'call', tool, command.opts());
      },
    );
  program
    .command('tool')
    .description('明确调用一个工具，输出JSON；写入/命令默认需--approve本次授权')
    .argument('<name>', 'ReadFile / WriteFile / EditFile / Glob / Grep / Bash')
    .option('--input <json>', '工具JSON参数')
    .option('--input-file <file>', '读取工具参数JSON文件（相对项目工作目录）')
    .option('--approve', '用户明确授权本次写入或shell；不能覆盖Plan禁止规则')
    .option('--shell <kind>', 'powershell / bash；仅影响Bash工具')
    .option('--shell-executable <path>', '用户指定shell可执行程序绝对路径')
    .option('--audit-file <file>', '将脱敏权限决策写入新JSONL文件（不覆盖）')
    .action(async (name: string, _options: unknown, command: Command) => {
      const loaded = await loadOptions(command.optsWithGlobals<CLIOptions>());
      const { runTool } = await import('./tools.js');
      await runTool(loaded, name, command.opts());
    });
  return program;
}
