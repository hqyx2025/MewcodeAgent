import { createHash } from 'node:crypto';
import { opendir } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { JSON_SCHEMA, load } from 'js-yaml';
import { z } from 'zod';
import { AppError } from '../shared/errors.js';
import { safeDirectory, readBoundedText } from '../shared/bounded-files.js';
import { redactInstruction } from '../shared/redact.js';
import { defineTool } from '../tools/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { ToolError } from '../tools/errors.js';

export const skillName = /^[a-z][a-z0-9-]{0,47}$(?![\r\n])/;
export interface SkillMetadata {
  name: string;
  description: string;
  source: 'user' | 'project';
  path: string;
}
export interface SkillWarning {
  name?: string;
  source: 'user' | 'project';
  code: 'INVALID' | 'PERMISSION' | 'LIMIT';
}
interface IndexedSkill extends SkillMetadata {
  file: string;
}
export interface LoadedSkill extends SkillMetadata {
  text: string;
  digest: string;
  bytes: number;
  reason: 'explicit' | 'description';
}
export interface SkillSelection {
  entries: LoadedSkill[];
  available: number;
  bytes: number;
  estimatedTokens: number;
  warnings: SkillWarning[];
}
export type SkillManifest = Omit<SkillSelection, 'entries'> & {
  sources: Omit<LoadedSkill, 'text'>[];
};
export function skillManifest(selection: SkillSelection): SkillManifest {
  return {
    available: selection.available,
    bytes: selection.bytes,
    estimatedTokens: selection.estimatedTokens,
    warnings: structuredClone(selection.warnings),
    sources: selection.entries.map(({ text: _text, ...meta }) => ({ ...meta })),
  };
}
function fail(code: 'SKILL_INVALID' | 'SKILL_LIMIT' = 'SKILL_INVALID'): never {
  throw new AppError(code, '技能名称、元数据、资源、权限或预算无效；未执行附带脚本。');
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AppError('CANCELLED', '技能加载已取消。');
}

function document(
  text: string,
  expected: string,
): { name: string; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!match || Buffer.byteLength(match[0]) > 4096 || text.includes('\0')) fail();
  let raw: unknown;
  try {
    raw = load(match[1]!, { schema: JSON_SCHEMA });
  } catch {
    fail();
  }
  const result = z
    .strictObject({
      name: z.string().regex(skillName),
      description: z.string().trim().min(1).max(1024),
    })
    .safeParse(raw);
  if (!result.success || result.data.name !== expected) fail();
  if (
    [...result.data.description].some(
      (char) => (char.charCodeAt(0) < 32 && !'\r\n\t'.includes(char)) || char.charCodeAt(0) === 127,
    )
  )
    fail();
  return {
    ...result.data,
    description: result.data.description.replace(/\s+/g, ' '),
    body: text.slice(match[0].length),
  };
}

function terms(text: string): Set<string> {
  const words = new Set(text.toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) ?? []);
  const ignored = new Set(['项目', '使用', '进行', '代码', '技能', '任务']);
  for (const run of text.match(/[\p{Script=Han}]+/gu) ?? [])
    for (let i = 0; i < run.length - 1; i++) {
      const token = run.slice(i, i + 2);
      if (!ignored.has(token)) words.add(token);
    }
  return words;
}
/** Deterministic lexical ranking, never a model judgement or execution authority. */
export function matchSkills(entries: readonly SkillMetadata[], query: string): SkillMetadata[] {
  const tokens = terms(query.slice(0, 65536));
  return entries
    .map((entry) => {
      const keys = terms(`${entry.name} ${entry.description}`);
      const score = [...tokens].reduce(
        (sum, token) => sum + (keys.has(token) ? (/^[a-z]/.test(token) ? 2 : 1) : 0),
        0,
      );
      return { entry, score };
    })
    .filter(({ score }) => score >= 2)
    .sort((a, b) => b.score - a.score || a.entry.name.localeCompare(b.entry.name))
    .slice(0, 2)
    .map(({ entry }) => ({ ...entry }));
}

export class SkillCatalog {
  private entries?: Map<string, IndexedSkill>;
  private warnings: SkillWarning[] = [];
  private active = new Map<string, IndexedSkill>();
  private reads = 0;
  private resourceBytes = 0;
  constructor(
    private readonly options: {
      userDirectory: string;
      projectDirectory: string;
      allows(path: string): boolean;
      secrets?: readonly string[];
    },
  ) {}

  private sensitive(text: string): boolean {
    return (
      redactInstruction(text, this.options.secrets) !== text ||
      (this.options.secrets ?? []).some((value) => Boolean(value) && text.includes(value))
    );
  }

  async list(
    refresh = false,
    signal?: AbortSignal,
  ): Promise<{ entries: SkillMetadata[]; warnings: SkillWarning[] }> {
    if (refresh) this.active.clear();
    cancelled(signal);
    if (!this.entries || refresh) {
      const entries = new Map<string, IndexedSkill>();
      const warnings: SkillWarning[] = [];
      for (const source of ['user', 'project'] as const) {
        let root = join(this.options[`${source}Directory`], 'skills');
        if (!this.options.allows(root)) {
          warnings.push({ source, code: 'PERMISSION' });
          continue;
        }
        try {
          root = await safeDirectory(root);
          if (!this.options.allows(root)) {
            warnings.push({ source, code: 'PERMISSION' });
            continue;
          }
          const stream = await opendir(root);
          let count = 0;
          const names: string[] = [];
          for await (const item of stream) {
            cancelled(signal);
            if (++count > 128) fail('SKILL_LIMIT');
            if (skillName.test(item.name)) names.push(item.name);
          }
          for (const name of names.sort()) {
            cancelled(signal);
            // A present project directory shadows user metadata even if unreadable or invalid.
            entries.delete(name);
            if (this.sensitive(name)) {
              warnings.push({ source, code: 'INVALID' });
              continue;
            }
            const file = join(root, name, 'SKILL.md');
            if (!this.options.allows(file)) {
              warnings.push({ name, source, code: 'PERMISSION' });
              continue;
            }
            try {
              await safeDirectory(dirname(file));
              const header = await readBoundedText(file, 65536, 4096, signal);
              if (this.sensitive(header)) fail();
              const meta = document(header, name);
              entries.set(name, {
                name,
                description: meta.description,
                source,
                path: `${source}:skills/${name}/SKILL.md`,
                file,
              });
            } catch {
              cancelled(signal);
              warnings.push({ name, source, code: 'INVALID' });
            }
          }
        } catch (error) {
          cancelled(signal);
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          if (error instanceof AppError && error.code === 'SKILL_LIMIT') throw error;
          // Refuse unsafe root directories; individual bad skill documents are reported above.
          fail();
        }
      }
      this.entries = entries;
      this.warnings = warnings;
      this.active.clear();
    }
    return {
      entries: [...this.entries.values()].map(({ file: _file, ...entry }) => ({ ...entry })),
      warnings: structuredClone(this.warnings),
    };
  }

  async select(
    query: string,
    explicit: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<SkillSelection> {
    this.active.clear();
    cancelled(signal);
    if (explicit.length > 4 || explicit.some((name) => !skillName.test(name))) fail();
    const index = await this.list(false, signal);
    const names = explicit.length
      ? [...new Set(explicit)]
      : matchSkills(index.entries, query).map((entry) => entry.name);
    const loaded: LoadedSkill[] = [];
    const warnings = [...index.warnings];
    const active = new Map<string, IndexedSkill>();
    for (const name of names) {
      const entry = this.entries!.get(name);
      if (!entry) fail();
      try {
        await safeDirectory(dirname(entry.file));
        if (!this.options.allows(entry.file)) fail();
        const text = await readBoundedText(entry.file, 65536, 65536, signal);
        if (this.sensitive(text)) fail();
        const parsed = document(text, name);
        if (parsed.description !== entry.description || !parsed.body.trim()) fail();
        const candidate: LoadedSkill = {
          name,
          description: entry.description,
          source: entry.source,
          path: entry.path,
          text: parsed.body,
          digest: createHash('sha256').update(text).digest('hex'),
          bytes: Buffer.byteLength(parsed.body),
          reason: explicit.length ? 'explicit' : 'description',
        };
        if (Buffer.byteLength(JSON.stringify([...loaded, candidate])) > 32768) fail('SKILL_LIMIT');
        loaded.push(candidate);
        active.set(name, entry);
      } catch (error) {
        cancelled(signal);
        if (explicit.length) {
          if (error instanceof AppError) throw error;
          fail();
        }
        warnings.push({
          name,
          source: entry.source,
          code: error instanceof AppError && error.code === 'SKILL_LIMIT' ? 'LIMIT' : 'INVALID',
        });
      }
    }
    cancelled(signal);
    this.active = active;
    const bytes = loaded.length ? Buffer.byteLength(JSON.stringify(loaded)) : 0;
    return {
      entries: loaded,
      available: index.entries.length,
      bytes,
      estimatedTokens: bytes,
      warnings,
    };
  }

  private async resource(name: string, input: string, signal: AbortSignal): Promise<string> {
    cancelled(signal);
    const entry = this.active.get(name);
    if (!entry || input.length > 1024 || input.includes('\\') || isAbsolute(input)) fail();
    const parts = input.split('/');
    if (
      !parts.length ||
      parts.length > 16 ||
      parts.some(
        (part) =>
          !part ||
          ['.', '..'].includes(part) ||
          /[:*?<>|]/.test(part) ||
          [...part].some((char) => char.charCodeAt(0) < 32) ||
          /[. ]$/.test(part) ||
          /^\.env(?:\.|$)|^\.git$|^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      ) ||
      input.toLowerCase() === 'skill.md'
    )
      fail();
    const root = dirname(entry.file);
    const path = resolve(root, ...parts);
    if (this.sensitive(path)) fail();
    const local = relative(root, path);
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) fail();
    await safeDirectory(dirname(path));
    if (!this.options.allows(path)) fail();
    return path;
  }

  register(registry: ToolRegistry): void {
    registry.register(
      defineTool({
        name: 'SkillRead',
        effect: 'read',
        description:
          'Read a bounded UTF-8 resource relative to a skill selected for this task. Never executes scripts or changes permissions. Requires name and resource; SKILL.md is already in the prompt.',
        schema: z.strictObject({
          name: z.string().regex(skillName),
          resource: z.string().min(1).max(1024),
        }),
        prepare: async ({ name, resource }, context) => {
          let path: string;
          try {
            path = await this.resource(name, resource, context.signal);
          } catch {
            cancelled(context.signal);
            throw new ToolError('SKILL_INVALID', '技能资源缺失、未选择或路径/权限无效。');
          }
          return {
            target: path,
            preview: `读取已选择技能 ${name} 的资源 ${resource}；不执行脚本。`,
            run: async () => {
              if (++this.reads > 16) throw new ToolError('SKILL_LIMIT', '技能资源最多读取16次。');
              try {
                if ((await this.resource(name, resource, context.signal)) !== path) fail();
                const text = await readBoundedText(path, 16384, 16384, context.signal);
                if (text.includes('\0') || this.sensitive(text)) fail();
                const bytes = Buffer.byteLength(text);
                if (this.resourceBytes + bytes > 65536) fail('SKILL_LIMIT');
                this.resourceBytes += bytes;
                return {
                  content: text,
                  data: {
                    path,
                    name,
                    resource,
                    bytes,
                    digest: createHash('sha256').update(text).digest('hex'),
                  },
                };
              } catch (error) {
                cancelled(context.signal);
                throw new ToolError(
                  error instanceof AppError && error.code === 'SKILL_LIMIT'
                    ? 'SKILL_LIMIT'
                    : 'SKILL_INVALID',
                  '技能资源无法安全读取或超过预算，未执行脚本。',
                );
              }
            },
          };
        },
      }),
    );
  }
}
