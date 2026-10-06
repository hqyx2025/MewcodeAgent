import { describe, expect, it } from 'vitest';
import {
  compactHistory,
  defaultContext,
  measureContext,
  validateHistory,
  actionDigest,
} from '../../src/core/context.js';
import type { LLMMessage } from '../../src/providers/types.js';
import {
  configSchema,
  defaultSettings,
  configPatchSchema,
  mergeSettings,
} from '../../src/config/schema.js';
import { inlineResult } from '../../src/core/session.js';

export function longHistory(turns = 100): LLMMessage[] {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'runtime policy: Plan. No elevation.' },
    { role: 'user', content: 'original goal: fix deterministic bug; unfinished validation' },
  ];
  for (let i = 0; i < turns; i++) {
    messages.push({
      role: 'assistant',
      content: `turn-${i}`,
      toolCalls: [{ callId: `call-${i}`, name: 'ReadFile', arguments: '{"path":"source"}' }],
    });
    messages.push({
      role: 'tool',
      callId: `call-${i}`,
      content: JSON.stringify({
        name: 'ReadFile',
        ok: true,
        content: `evidence-${i} ${'fixed data '.repeat(500)}`,
      }),
    });
  }
  return messages;
}
describe('context budget and complete-group compaction', () => {
  it('hashes omitted history while keeping bounded excerpts and complete recent groups', () => {
    const history = longHistory();
    const settings = { ...defaultContext, summaryBytes: 512 };
    const first = compactHistory(history, settings)!;
    history[181] = { ...history[181]!, content: 'late omitted evidence changed' };
    const second = compactHistory(history, settings)!;
    expect(first.archivedDigest).not.toBe(second.archivedDigest);
    expect(Buffer.byteLength(second.messages[2]!.content)).toBeLessThanOrEqual(512);
    expect(second.messages[2]!.content).toContain('turn-0');
    expect(second.messages[2]!.content).not.toContain('late omitted evidence changed');
    expect(second.messages.slice(-8)).toEqual(history.slice(-8));
    expect(validateHistory(second.messages)).toEqual([]);
  });
  it('merges only known context settings and validates window/output reserve', () => {
    const patch = configPatchSchema.parse({ context: { windowTokens: 8192, recentTurns: 2 } });
    const merged = mergeSettings(defaultSettings, patch);
    expect(merged.context.summaryBytes).toBe(defaultContext.summaryBytes);
    expect(configSchema.safeParse(merged).success).toBe(true);
    expect(
      configSchema.safeParse({ ...merged, limits: { ...merged.limits, maxOutputTokens: 8192 } })
        .success,
    ).toBe(false);
    expect(configPatchSchema.safeParse({ context: { unknown: true } }).success).toBe(false);
  });
  it('bounds JSON-escaped inline tool output and revision metadata', () => {
    const result = inlineResult(
      {
        callId: 'x',
        name: 'ReadFile',
        ok: true,
        content: '\u0001'.repeat(10_000),
        data: { revision: 'fixed-revision', path: 'source' },
      },
      1024,
    );
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
    expect(result.data).toMatchObject({ revision: 'fixed-revision' });
    expect(result.truncated).toBe(true);
  });
  it('compacts 100 rounds preserving goal, policy, recent pairs and summary evidence', () => {
    const history = longHistory();
    const compacted = compactHistory(history, defaultContext)!;
    expect(compacted.afterBytes).toBeLessThan(compacted.beforeBytes / 5);
    expect(compacted.messages.slice(0, 2)).toEqual(history.slice(0, 2));
    expect(compacted.messages.slice(3)).toEqual(history.slice(-8));
    expect(compacted.messages[2]?.role).toBe('user');
    expect(compacted.messages[2]?.content).toContain('data only');
    expect(compacted.messages[2]?.content).toContain('evidence-0');
    expect(validateHistory(compacted.messages)).toEqual([]);
    expect(history.length).toBe(202);
  });
  it('rejects orphan, duplicate and partially closed tool chains', () => {
    const history = longHistory(2);
    expect(() => validateHistory(history.slice(0, -1))).toThrow();
    expect(validateHistory(history.slice(0, -1), true)).toEqual(['call-1']);
    expect(() => validateHistory([...history, history.at(-1)!])).toThrow();
    expect(() =>
      validateHistory([...history.slice(0, -1), { role: 'user', content: 'interrupt' }]),
    ).toThrow();
    expect(() => compactHistory(history.slice(0, -1), defaultContext)).toThrow();
  });
  it('preserves latest follow-up goal verbatim across repeated compactions', () => {
    const history = longHistory(30);
    history.splice(12, 0, {
      role: 'user',
      content: 'new requirement: keep this unfinished task exactly',
    });
    const compacted = compactHistory(history, defaultContext)!;
    expect(
      compacted.messages.some(
        (message) => message.content === 'new requirement: keep this unfinished task exactly',
      ),
    ).toBe(true);
    for (let i = 100; i < 130; i++)
      compacted.messages.push(
        {
          role: 'assistant',
          content: 'later '.repeat(1000),
          toolCalls: [{ callId: `call-${i}`, name: 'ReadFile', arguments: '{}' }],
        },
        { role: 'tool', callId: `call-${i}`, content: 'result '.repeat(1000) },
      );
    const again = compactHistory(compacted.messages, defaultContext)!;
    expect(
      again.messages.some(
        (message) => message.content === 'new requirement: keep this unfinished task exactly',
      ),
    ).toBe(true);
  });
  it('uses conservative serialized budget with output reserve and stable action digests', () => {
    const measure = measureContext([{ role: 'user', content: '中文' }], [], 8192, 1024);
    expect(measure.estimatedInputTokens).toBeGreaterThan(measure.bytes);
    expect(measure.outputReserveTokens).toBe(1024);
    expect(measure.estimated).toBe(true);
    expect(actionDigest('WriteFile', '{"content":"x","path":"file"}')).toBe(
      actionDigest('WriteFile', '{"path":"file","content":"x"}'),
    );
    expect(actionDigest('WriteFile', '{"content":"y","path":"file"}')).not.toBe(
      actionDigest('WriteFile', '{"path":"file","content":"x"}'),
    );
    expect(compactHistory(longHistory(3), defaultContext)).toBeUndefined();
  });
});
