import type { ToolEffect, ToolMode } from '../tools/types.js';

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
