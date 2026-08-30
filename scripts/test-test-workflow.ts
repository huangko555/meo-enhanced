import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createTestWorkflowPlan,
  parseTestWorkflowRequest,
  validateTestWorkflowAuthorization
} from './test-workflow-policy';

const quick = createTestWorkflowPlan(parseTestWorkflowRequest(['quick']));
assert.equal(quick.tier, 'quick');
assert.equal(quick.longRunning, false);
assert.ok(quick.commands.some((command) => command.args.join(' ') === 'run typecheck'));
assert.ok(!quick.commands.some((command) => command.args.join(' ') === 'run test'));
assert.doesNotThrow(() => validateTestWorkflowAuthorization(quick, false, false));
assert.ok(quick.commands.some((command) => (
  command.args.includes('scripts/test-virtual-block-scroll-stability.ts')
)));

const history = createTestWorkflowPlan(
  parseTestWorkflowRequest(['targeted', 'history'])
);
assert.equal(history.tier, 'targeted');
assert.equal(history.area, 'history');
assert.equal(history.longRunning, false);
assert.ok(
  history.commands.some((command) =>
    command.args.includes('scripts/test-history-matrix.ts')
  )
);

for (const area of ['table', 'rendered', 'viewport'] as const) {
  const targeted = createTestWorkflowPlan(parseTestWorkflowRequest(['targeted', area]));
  assert.ok(targeted.commands.some((command) => (
    command.args.includes('scripts/test-virtual-block-scroll-stability.ts')
  )), `${area} targeted workflow must cover virtual block scroll stability`);
}
assert.ok(
  history.commands.some((command) =>
    command.args.includes('scripts/test-rendered-content-history-roundtrip.ts')
  )
);

const uat = createTestWorkflowPlan(
  parseTestWorkflowRequest(['targeted', 'uat', 'fixtures/uat.md'])
);
assert.equal(uat.area, 'uat');
assert.equal(uat.longRunning, false);
assert.equal(uat.commands.length, 2);
assert.equal(uat.commands[0]?.env?.MEO_UAT_ENDURANCE_LIMIT, '8');
assert.equal(uat.commands[0]?.env?.MEO_UAT_STRICT_FINDING, '*');
assert.deepEqual(uat.commands[1]?.args, [
  'scripts/test-production-live-scroll-integrity.ts',
  '--document=fixtures/uat.md'
]);

const release = createTestWorkflowPlan(parseTestWorkflowRequest(['release']));
assert.equal(release.longRunning, true);
assert.throws(
  () => validateTestWorkflowAuthorization(release, false, false),
  /--confirm-long-run/
);
assert.doesNotThrow(() => validateTestWorkflowAuthorization(release, true, false));
assert.doesNotThrow(() => validateTestWorkflowAuthorization(release, false, true));

const endurance = createTestWorkflowPlan(
  parseTestWorkflowRequest(['endurance', 'fixtures/uat.md'])
);
assert.equal(endurance.longRunning, true);
assert.equal(endurance.commands[0]?.env?.MEO_UAT_STRICT_FINDING, '*');
assert.throws(
  () => validateTestWorkflowAuthorization(endurance, false, false),
  /--confirm-long-run/
);

assert.throws(
  () => parseTestWorkflowRequest(['targeted', 'unknown']),
  /Unknown targeted area/
);
assert.throws(
  () => parseTestWorkflowRequest(['targeted', 'uat']),
  /document path/
);
assert.throws(
  () => parseTestWorkflowRequest(['endurance']),
  /document path/
);

const repoRoot = resolve(import.meta.dir, '..');
const packageJson = JSON.parse(
  readFileSync(resolve(repoRoot, 'package.json'), 'utf8')
) as { scripts?: Record<string, string> };
const packageScripts = packageJson.scripts ?? {};
assert.equal(packageScripts['test:quick'], 'bun scripts/test-workflow.ts quick');
assert.equal(packageScripts['test:targeted'], 'bun scripts/test-workflow.ts targeted');
assert.equal(packageScripts['test:release'], 'bun scripts/test-workflow.ts release');
assert.equal(packageScripts['test:endurance'], 'bun scripts/test-workflow.ts endurance');
assert.match(packageScripts.test ?? '', /bun run test:browser/);

const workflowGuide = readFileSync(
  resolve(repoRoot, 'docs/testing-workflow.md'),
  'utf8'
);
for (const command of [
  'bun run test:quick',
  'bun run test:targeted',
  'bun run test:release',
  'bun run test:endurance'
]) {
  assert.ok(workflowGuide.includes(command), `Workflow guide must document ${command}`);
}
assert.match(workflowGuide, /explicit user authorization/i);

const agentGuide = readFileSync(resolve(repoRoot, 'AGENTS.md'), 'utf8');
assert.ok(agentGuide.includes('docs/testing-workflow.md'));
assert.match(agentGuide, /当前任务中的明确授权/);

console.log('Test workflow policy contract passed');
