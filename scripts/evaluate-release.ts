import { evaluateScenario, releaseScenarioNames } from '../tests/support/release-evaluation.js';
const results = [];
for (const name of releaseScenarioNames) results.push(await evaluateScenario(name));
process.stdout.write(
  JSON.stringify(
    {
      suite: 'm16-v1',
      platform: process.platform,
      node: process.version,
      provider: 'scripted offline fixture',
      conditions:
        'Owned temporary Chinese/space-path Git repositories; real tools, shells, checkpoints and MCP. Sequential scenarios, natural caches, no paid model or remote services. Duration excludes Git fixture creation and final sandbox deletion; heap sampled at scenario completion, not peak or leak proof.',
      results,
    },
    null,
    2,
  ) + '\n',
);
