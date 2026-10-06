import type { ToolResult } from '../tools/types.js';
import type { childAnswerSchema } from './subagent-schema.js';
import type { z } from 'zod';

export interface Evidence {
  path: string;
  line?: number | undefined;
  note: string;
  kind: 'read' | 'match' | 'listing';
  revision?: string;
}

/** Retains observation metadata, never source text; overflow fails closed. */
export class SubagentEvidence {
  private readonly paths = new Map<
    string,
    { kind: Evidence['kind']; revision?: string; lines: Map<number, Evidence['kind']> }
  >();
  private bytes = 0;
  overflow = false;

  observe(result: Readonly<ToolResult>): void {
    if (!result.ok || !result.data || typeof result.data !== 'object') return;
    const data = result.data as Record<string, unknown>;
    const add = (path: unknown, kind: Evidence['kind'], line?: number, revision?: string) => {
      if (typeof path !== 'string') return;
      let item = this.paths.get(path);
      const cost =
        (item ? 0 : Buffer.byteLength(path) + 128) + (line && !item?.lines.has(line) ? 16 : 0);
      if ((!item && this.paths.size >= 128) || this.bytes + cost > 64 * 1024) {
        this.overflow = true;
        return;
      }
      this.bytes += cost;
      if (!item) {
        item = { kind, lines: new Map() };
        this.paths.set(path, item);
      }
      if (kind === 'read' && revision) {
        if (item.revision && item.revision !== revision) item.lines.clear();
        item.kind = kind;
        item.revision = revision;
      }
      if (line) item.lines.set(line, kind);
    };
    if (result.name === 'ReadFile' && typeof data.revision === 'string') {
      add(data.path, 'read', undefined, data.revision);
      // endLine describes the selection, not necessarily the bytes actually returned.
      const lines = result.content.split('\n');
      if (result.truncated) lines.pop();
      for (const line of lines) {
        const match = /^(\d+): /.exec(line);
        if (match) add(data.path, 'read', Number(match[1]), data.revision);
      }
    } else if (result.name === 'Glob' && Array.isArray(data.paths)) {
      for (const path of data.paths) add(path, 'listing');
    } else if (result.name === 'Grep' && Array.isArray(data.matches)) {
      for (const value of data.matches) {
        const match = value as { path?: unknown; line?: number };
        if (Number.isSafeInteger(match.line) && match.line! > 0)
          add(match.path, 'match', match.line);
      }
    }
  }

  verify(items: z.infer<typeof childAnswerSchema>['evidence']): Evidence[] {
    return items.map((item) => {
      const found = this.paths.get(item.path);
      const kind = item.line ? found?.lines.get(item.line) : found?.kind;
      if (!found || !kind) throw new Error('Unobserved evidence');
      return {
        ...item,
        kind,
        ...(kind === 'read' && found.revision ? { revision: found.revision } : {}),
      };
    });
  }
}
