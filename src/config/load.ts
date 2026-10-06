import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { JSON_SCHEMA, load, YAMLException } from 'js-yaml';
import type { ZodType } from 'zod';
import { AppError } from '../shared/errors.js';
import { configPatchSchema, configSchema, defaultSettings, mergeSettings } from './schema.js';
import type { ConfigPatch, Settings } from './schema.js';
import type { ScopedPermissionRule } from '../security/rules.js';

const MAX_CONFIG_BYTES = 256 * 1_024;

export interface LoadOptions {
  cwd?: string;
  userHome?: string;
  configFile?: string;
  env?: NodeJS.ProcessEnv;
  overrides?: ConfigPatch;
}

export interface ConfigSource {
  kind: 'defaults' | 'user' | 'project' | 'environment' | 'cli';
  path?: string;
}

export interface LoadedConfiguration {
  cwd: string;
  settings: Settings;
  paths: {
    userDirectory: string;
    projectDirectory: string;
    storageDirectory: string;
    logFile: string;
  };
  sources: ConfigSource[];
  permissionRules: ScopedPermissionRule[];
}

function validate<T>(schema: ZodType<T>, input: unknown, source: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '<root>'}（${issue.message}）`)
      .join('；');
    throw new AppError('CONFIG_INVALID', `${source}配置无效：${details}`);
  }
  return result.data;
}

async function readConfig(path: string, required: boolean): Promise<ConfigPatch | undefined> {
  let content: string;
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
      throw new AppError('CONFIG_READ', `配置路径不是文件：${path}`);
    }
    if (metadata.size > MAX_CONFIG_BYTES) {
      throw new AppError('CONFIG_READ', `配置文件超过 256 KiB：${path}`);
    }
    content = await readFile(path, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_CONFIG_BYTES) {
      throw new AppError('CONFIG_READ', `配置文件超过 256 KiB：${path}`);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (hasCode(error, 'ENOENT') && !required) return undefined;
    throw new AppError('CONFIG_READ', `无法读取配置文件：${path}`, { cause: error });
  }

  let raw: unknown;
  try {
    raw = load(content, { schema: JSON_SCHEMA });
  } catch (error) {
    // YAMLException.message contains the original line, potentially including credentials.
    const line = error instanceof YAMLException ? error.mark?.line : undefined;
    const location = line === undefined ? '' : `（第 ${line + 1} 行）`;
    throw new AppError('CONFIG_INVALID', `YAML 解析失败${location}：${path}`, { cause: error });
  }
  return validate(configPatchSchema, raw === undefined ? {} : raw, `${path}：`);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function environmentPatch(env: NodeJS.ProcessEnv): ConfigPatch {
  const provider: Record<string, unknown> = {};
  const limits: Record<string, unknown> = {};
  const storage: Record<string, unknown> = {};
  for (const [name, field] of [
    ['MEWCODE_PROVIDER', 'kind'],
    ['MEWCODE_MODEL', 'model'],
    ['MEWCODE_BASE_URL', 'baseUrl'],
    ['MEWCODE_API_KEY_ENV', 'apiKeyEnv'],
  ] as const) {
    if (env[name] !== undefined) provider[field] = env[name];
  }
  for (const [name, field] of [
    ['MEWCODE_MAX_TURNS', 'maxTurns'],
    ['MEWCODE_TIMEOUT_MS', 'timeoutMs'],
    ['MEWCODE_MAX_OUTPUT_TOKENS', 'maxOutputTokens'],
  ] as const) {
    if (env[name] !== undefined) {
      if (!/^[1-9]\d*$/.test(env[name])) {
        throw new AppError('CONFIG_INVALID', `环境变量 ${name} 必须为正整数。`);
      }
      limits[field] = Number(env[name]);
    }
  }
  for (const [name, field] of [
    ['MEWCODE_STORAGE_DIR', 'directory'],
    ['MEWCODE_LOG_FILE', 'logFile'],
  ] as const) {
    if (env[name] !== undefined) storage[field] = env[name];
  }
  const patch: Record<string, unknown> = {};
  if (Object.keys(provider).length > 0) patch.provider = provider;
  if (Object.keys(limits).length > 0) patch.limits = limits;
  if (Object.keys(storage).length > 0) patch.storage = storage;
  if (env.MEWCODE_MODE !== undefined) patch.mode = env.MEWCODE_MODE;
  return validate(configPatchSchema, patch, '环境变量：');
}

export async function loadConfiguration(options: LoadOptions = {}): Promise<LoadedConfiguration> {
  const env = options.env ?? process.env;
  if (options.cwd !== undefined && options.cwd.trim().length === 0) {
    throw new AppError('INVALID_WORKDIR', '工作目录不能为空。');
  }
  if (options.configFile !== undefined && options.configFile.trim().length === 0) {
    throw new AppError('CONFIG_INVALID', '显式配置文件路径不能为空。');
  }
  let cwd: string;
  try {
    cwd = await realpath(resolve(options.cwd ?? process.cwd()));
    if (!(await stat(cwd)).isDirectory()) {
      throw new Error('Not a directory');
    }
  } catch (error) {
    throw new AppError('INVALID_WORKDIR', '工作目录不存在、不可访问或不是目录。', { cause: error });
  }
  if (env.MEWCODE_HOME !== undefined && env.MEWCODE_HOME.trim().length === 0) {
    throw new AppError('CONFIG_INVALID', '环境变量 MEWCODE_HOME 不能为空。');
  }
  const userDirectory = resolve(
    cwd,
    env.MEWCODE_HOME ?? join(options.userHome ?? homedir(), '.mewcode'),
  );
  const projectDirectory = join(cwd, '.mewcode');
  const projectFile = options.configFile
    ? resolve(cwd, options.configFile)
    : join(projectDirectory, 'config.yaml');
  const sources: ConfigSource[] = [{ kind: 'defaults' }];
  const permissionRules: ScopedPermissionRule[] = [];
  let settings = defaultSettings;
  for (const [kind, path, required] of [
    ['user', join(userDirectory, 'config.yaml'), false],
    ['project', projectFile, options.configFile !== undefined],
  ] as const) {
    const patch = await readConfig(path, required);
    if (patch !== undefined) {
      permissionRules.push(
        ...(patch.permissions?.rules ?? []).map((rule) => ({ ...rule, source: kind })),
      );
      // Project config may restrict a trusted mode, never elevate it.
      const projectMode =
        kind === 'project' && patch.mode !== undefined
          ? stricterMode(settings.mode, patch.mode)
          : patch.mode;
      settings = mergeSettings(settings, { ...patch, mode: projectMode });
      sources.push({ kind, path });
    }
  }
  for (const [kind, patch] of [
    ['environment', environmentPatch(env)],
    ['cli', validate(configPatchSchema, options.overrides ?? {}, '命令行：')],
  ] as const) {
    if (Object.keys(patch).length > 0) {
      if (kind === 'cli')
        permissionRules.push(
          ...(patch.permissions?.rules ?? []).map((rule) => ({ ...rule, source: 'cli' as const })),
        );
      settings = mergeSettings(settings, patch);
      sources.push({ kind });
    }
  }
  settings = validate(configSchema, settings, '合并后的');
  const storageDirectory = resolve(cwd, settings.storage.directory ?? userDirectory);
  const logFile = settings.storage.logFile
    ? resolve(cwd, settings.storage.logFile)
    : join(storageDirectory, 'logs', 'mewcode.log');
  return {
    cwd,
    settings,
    paths: { userDirectory, projectDirectory, storageDirectory, logFile },
    sources,
    permissionRules,
  };
}

function stricterMode(current: Settings['mode'], project: Settings['mode']): Settings['mode'] {
  const rank = { plan: 0, default: 1, 'accept-edits': 2 };
  return rank[project] < rank[current] ? project : current;
}
