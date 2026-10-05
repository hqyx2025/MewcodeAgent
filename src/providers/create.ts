import type { Settings } from '../config/schema.js';
import { AppError } from '../shared/errors.js';
import type { LLMProvider } from './types.js';

export async function createProvider(
  settings: Settings,
  env: NodeJS.ProcessEnv = process.env,
): Promise<LLMProvider> {
  if (settings.provider.kind === 'mock') {
    const { MockProvider } = await import('./mock.js');
    return new MockProvider();
  }
  if (settings.provider.kind === 'anthropic') {
    throw new AppError(
      'MODEL_UNSUPPORTED',
      'Anthropic 适配器计划在后续模块接入；当前请选择 mock 或 openai-compatible。',
    );
  }
  const keyName = settings.provider.apiKeyEnv ?? 'OPENAI_API_KEY';
  const apiKey = env[keyName]?.trim();
  if (!apiKey)
    throw new AppError(
      'MODEL_MISSING_KEY',
      `请在本地终端设置环境变量 ${keyName}；不要将密钥写入配置文件。`,
    );
  const { OpenAICompatibleProvider } = await import('./openai-compatible.js');
  return new OpenAICompatibleProvider({
    apiKey,
    timeoutMs: settings.limits.timeoutMs,
    ...(settings.provider.wireApi === undefined ? {} : { wireApi: settings.provider.wireApi }),
    ...(settings.provider.baseUrl === undefined ? {} : { baseUrl: settings.provider.baseUrl }),
    ...(settings.provider.maxTokensParameter === undefined
      ? {}
      : { maxTokensParameter: settings.provider.maxTokensParameter }),
    ...(settings.provider.includeUsage === undefined
      ? {}
      : { includeUsage: settings.provider.includeUsage }),
  });
}
