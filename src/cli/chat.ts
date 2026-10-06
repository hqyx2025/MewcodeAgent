import { AppError } from '../shared/errors.js';
import { terminalText } from '../shared/terminal-text.js';
import type { LoadedConfiguration } from '../config/load.js';
import { memoryRuntime, printMemoryWarnings } from './memory-runtime.js';
import { createBuiltinRegistry } from '../tools/builtins.js';
import { ToolExecutor } from '../tools/executor.js';
import { commandRuntime } from './commands.js';
import type { CommandResult } from '../core/commands.js';
import type { LLMProvider } from '../providers/types.js';

async function readPrompt(): Promise<string> {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    prompt += String(chunk);
    if (Buffer.byteLength(prompt, 'utf8') > 256 * 1024) {
      throw new AppError('INVALID_PROMPT', '标准输入超过 256 KiB。');
    }
  }
  return prompt.trim();
}

export async function runChat(loaded: LoadedConfiguration, prompt?: string): Promise<void> {
  const { createProvider } = await import('../providers/create.js');
  const { Conversation } = await import('../core/conversation.js');
  let implementation: LLMProvider | undefined;
  const provider: LLMProvider = {
    id: loaded.settings.provider.kind,
    capabilities: { streaming: true, toolCalling: false },
    stream: async function* (request, signal) {
      implementation ??= await createProvider(loaded.settings);
      yield* implementation.stream(request, signal);
    },
  };
  const registry = createBuiltinRegistry();
  const memory = await memoryRuntime(loaded, registry);
  const executor = await ToolExecutor.create(registry, {
    root: loaded.cwd,
    mode: loaded.settings.mode,
    rules: [...loaded.permissionRules, ...memory.rules],
  });
  const shownMemoryWarnings = new Set<string>();
  const conversation = new Conversation(provider, {
    model: loaded.settings.provider.model,
    maxOutputTokens: loaded.settings.limits.maxOutputTokens,
    timeoutMs: loaded.settings.limits.timeoutMs,
    memory: async (query, signal) => {
      const selection = await memory.store.select(executor, query, loaded.settings.memory, signal);
      printMemoryWarnings(selection.warnings, shownMemoryWarnings);
      return selection;
    },
  });
  const commands = commandRuntime(loaded, executor, {
    clear: () => conversation.clear(),
    compact: () => conversation.compact(),
    setModel: (model) => conversation.setModel(model),
  });
  const handoff = async (result: Extract<CommandResult, { kind: 'agent' }>) => {
    const { runAgentTask } = await import('./run.js');
    await runAgentTask(
      { ...loaded, settings: { ...loaded.settings, mode: result.mode } },
      result.prompt,
      result.resume ? { resume: result.resume } : {},
    );
  };
  if (prompt === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    const { startChat } = await import('../ui/start.js');
    await commands.list();
    let pending: Extract<CommandResult, { kind: 'agent' }> | undefined;
    await startChat({
      conversation,
      model: loaded.settings.provider.model,
      provider: provider.id,
      commands,
      onAgent: (result) => {
        pending = result;
      },
    });
    if (pending) await handoff(pending);
    return;
  }
  const text = prompt ?? (await readPrompt());
  const result = await commands.execute(text);
  if (result.kind === 'local') {
    process.stdout.write(`${terminalText(result.text)}\n`);
    return;
  }
  if (result.kind === 'agent') {
    await handoff(result);
    return;
  }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  let output = false;
  try {
    for await (const event of conversation.send(result.prompt, controller.signal)) {
      if (event.type === 'text_delta') {
        output = true;
        process.stdout.write(terminalText(event.text));
      }
      if (event.type === 'finish') {
        process.stdout.write('\n');
        if (event.reason === 'length') process.stderr.write('回答达到输出限制，已截断。\n');
      }
    }
  } catch (error) {
    if (output) process.stdout.write('\n');
    throw error;
  } finally {
    process.removeListener('SIGINT', cancel);
  }
}
