import type { ToolEffect, ToolMode } from '../tools/types.js';
import { within } from './rules.js';
import type { ScopedPermissionRule } from './rules.js';

export interface PermissionDecision {
  decision: 'allow' | 'ask' | 'deny';
  reason: 'mode' | 'deny-tool' | 'rule-deny' | 'rule-ask' | 'rule-allow' | 'default';
  sources: string[];
}

export function evaluatePermission(
  mode: ToolMode,
  name: string,
  effect: ToolEffect,
  denyTools: readonly string[],
  rules: readonly ScopedPermissionRule[],
  path: string,
  recursive = false,
): PermissionDecision {
  const base = permissionDecision(mode, name, effect, denyTools);
  if (base === 'deny')
    return {
      decision: 'deny',
      reason: denyTools.includes(name) ? 'deny-tool' : 'mode',
      sources: [],
    };
  const matching = rules.filter(
    (rule) =>
      (!rule.tool ||
        rule.tool === name ||
        (recursive && effect === 'read' && rule.tool === 'ReadFile' && rule.decision === 'deny')) &&
      (!rule.effect || rule.effect === effect) &&
      (!rule.path ||
        within(path, rule.path) ||
        (recursive && rule.decision !== 'allow' && within(rule.path, path))),
  );
  for (const decision of ['deny', 'ask'] as const) {
    const hits = matching.filter((rule) => rule.decision === decision);
    if (hits.length)
      return {
        decision,
        reason: decision === 'deny' ? 'rule-deny' : 'rule-ask',
        sources: [...new Set(hits.map((rule) => rule.source))],
      };
  }
  const allowed = matching.filter(
    (rule) => rule.decision === 'allow' && ['user', 'cli'].includes(rule.source),
  );
  if (effect !== 'shell' && effect !== 'external' && allowed.length)
    return {
      decision: 'allow',
      reason: 'rule-allow',
      sources: [...new Set(allowed.map((rule) => rule.source))],
    };
  return { decision: base, reason: 'default', sources: [] };
}

export function permissionDecision(
  mode: ToolMode,
  name: string,
  effect: ToolEffect,
  denyTools: readonly string[],
): 'allow' | 'ask' | 'deny' {
  if (denyTools.includes(name)) return 'deny';
  if (effect === 'read') return 'allow';
  if (mode === 'plan') return 'deny';
  if (mode === 'accept-edits' && effect === 'write') return 'allow';
  return 'ask';
}
