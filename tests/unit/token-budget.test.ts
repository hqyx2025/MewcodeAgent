import { describe, expect, it } from 'vitest';
import { TokenBudget } from '../../src/core/token-budget.js';

describe('shared token ledger', () => {
  it('reserves atomically, releases unused tickets and settles exactly once', () => {
    const budget = new TokenBudget(100);
    const first = budget.reserve(60, 'one');
    expect(() => budget.reserve(41, 'two')).toThrow();
    first.cancel();
    first.cancel();
    const second = budget.reserve(80, 'two');
    second.settle({ inputTokens: 20, outputTokens: 10, estimated: false });
    second.settle();
    second.cancel();
    expect(budget.snapshot).toMatchObject({
      used: 30,
      reserved: 0,
      available: 70,
      requests: 1,
      estimated: false,
    });
    expect(budget.usageFor('two')).toEqual({ used: 30, estimated: false });
  });
  it('records unknown/overreported usage conservatively and never hides overspend', () => {
    const budget = new TokenBudget(100);
    budget.reserve(50, 'unknown').settle();
    budget.reserve(50, 'over').settle({ inputTokens: 70, outputTokens: 5, estimated: false });
    expect(budget.snapshot).toMatchObject({
      used: 125,
      available: 0,
      reserved: 0,
      estimated: true,
    });
    expect(() => budget.reserve(1)).toThrow();
    expect(budget.usageFor('unknown')).toEqual({ used: 50, estimated: true });
  });
  it('respects the parent reservation and the aggregate child limit', () => {
    const parent = new TokenBudget(100);
    const children = new TokenBudget(80, 0, false, parent);
    const root = parent.reserve(40);
    const child = children.reserve(60, 'child');
    expect(() => children.reserve(1)).toThrow();
    root.cancel();
    child.settle({ inputTokens: 30, outputTokens: 20, estimated: false });
    expect(children.snapshot.available).toBe(30);
    expect(parent.snapshot.used).toBe(50);
    children.reserve(30, 'child2').settle();
    expect(children.snapshot.used).toBe(80);
    expect(parent.snapshot).toMatchObject({ used: 80, estimated: true });
  });
  it('rejects invalid limits and invalid provider usage without corrupting reservations', () => {
    expect(() => new TokenBudget(0)).toThrow();
    const budget = new TokenBudget(10);
    const ticket = budget.reserve(10);
    expect(() => ticket.settle({ inputTokens: -1, outputTokens: 0, estimated: false })).toThrow();
    expect(budget.snapshot.reserved).toBe(10);
    ticket.settle();
    expect(budget.snapshot.reserved).toBe(0);
  });
});
