import { describe, it, expect } from 'vitest';
import { evaluateScenario, releaseScenarioNames } from '../support/release-evaluation.js';
describe('fixed offline release evaluations', () => {
  for (const name of releaseScenarioNames)
    it(
      name,
      async () => {
        expect(await evaluateScenario(name)).toMatchObject({ name, status: 'passed' });
      },
      60_000,
    );
});
