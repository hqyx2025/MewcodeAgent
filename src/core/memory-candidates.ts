import { createHash } from 'node:crypto';
import type { LLMMessage } from '../providers/types.js';
import { memoryTextSchema } from './memory-schema.js';
import type { MemoryEntry, MemoryScope } from './memory-schema.js';
import { sensitiveMemory } from './memory.js';

export interface MemoryCandidate {
  id: string;
  scope: MemoryScope;
  kind: MemoryEntry['kind'];
  text: string;
  source: Extract<MemoryEntry['source'], { type: 'session' }>;
  requiresConfirmation: true;
}
/** Explicit user markers only: neither assistant/tool text nor lossy summaries are evidence. */
export function memoryCandidates(
  messages: readonly LLMMessage[],
  sessionId: string,
  checkpoint: number,
  scope: MemoryScope,
  secrets: readonly string[] = [],
): { candidates: MemoryCandidate[]; filtered: number; omitted: number } {
  const candidates: MemoryCandidate[] = [];
  const seen = new Set<string>();
  let filtered = 0;
  let omitted = 0;
  for (const [message, value] of messages.entries()) {
    if (value.role !== 'user' || value.contextSummary) continue;
    for (const [line, text] of value.content.split('\n').entries()) {
      const match = /^(用户偏好|项目约定|已验证事实)\s*[：:]\s*(.+)$/u.exec(text.trim());
      if (!match) continue;
      const kind: MemoryEntry['kind'] =
        match[1] === '用户偏好' ? 'preference' : match[1] === '项目约定' ? 'convention' : 'fact';
      if (scope === 'user' && kind !== 'preference') continue;
      const parsed = memoryTextSchema.safeParse(match[2]);
      if (!parsed.success || sensitiveMemory(parsed.data, secrets)) {
        filtered++;
        continue;
      }
      const key = `${kind}:${parsed.data.normalize('NFKC').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (candidates.length >= 100) {
        omitted++;
        continue;
      }
      const source = { type: 'session' as const, sessionId, checkpoint, message, line: line + 1 };
      const candidate = { scope, kind, text: parsed.data, source };
      const id = createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
      candidates.push({ id, ...candidate, requiresConfirmation: true });
    }
  }
  return { candidates, filtered, omitted };
}
