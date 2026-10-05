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
  return program;
}
