import { AppError } from '../shared/errors.js';
import { terminalText } from '../shared/terminal-text.js';
import type { LoadedConfiguration } from '../config/load.js';

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
  const provider = await createProvider(loaded.settings);
  const conversation = new Conversation(provider, {
    model: loaded.settings.provider.model,
    maxOutputTokens: loaded.settings.limits.maxOutputTokens,
    timeoutMs: loaded.settings.limits.timeoutMs,
  });
  if (prompt === undefined && process.stdin.isTTY && process.stdout.isTTY) {
    const { startChat } = await import('../ui/start.js');
    await startChat({ conversation, model: loaded.settings.provider.model, provider: provider.id });
    return;
  }
  const text = prompt ?? (await readPrompt());
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  let output = false;
  try {
    for await (const event of conversation.send(text, controller.signal)) {
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
