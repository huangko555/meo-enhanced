import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  createTestWorkflowPlan,
  flattenTestWorkflowCommands,
  parseTestWorkflowRequest,
  validateTestWorkflowAuthorization
} from './test-workflow-policy';

const quick = createTestWorkflowPlan(parseTestWorkflowRequest(['quick']));
const quickCommands = flattenTestWorkflowCommands(quick);
assert.equal(quick.tier, 'quick');
assert.equal(quick.longRunning, false);
assert.ok(quickCommands.some((command) => command.args.join(' ') === 'run typecheck'));
assert.ok(!quickCommands.some((command) => command.args.join(' ') === 'run test'));
assert.doesNotThrow(() => validateTestWorkflowAuthorization(quick, false, false));
assert.ok(quickCommands.some((command) => (
  command.args.includes('scripts/test-virtual-block-scroll-stability.ts')
)));

const history = createTestWorkflowPlan(
  parseTestWorkflowRequest(['targeted', 'history'])
);
assert.equal(history.tier, 'targeted');
assert.equal(history.area, 'history');
assert.equal(history.longRunning, false);
assert.ok(
  flattenTestWorkflowCommands(history).some((command) =>
    command.args.includes('scripts/test-history-matrix.ts')
  )
);

const search = createTestWorkflowPlan(
  parseTestWorkflowRequest(['targeted', 'search'])
);
assert.equal(search.area, 'search');
assert.ok(flattenTestWorkflowCommands(search).some((command) => (
  command.args.includes('scripts/test-search-replace-production.ts')
)));

const changes = createTestWorkflowPlan(
  parseTestWorkflowRequest(['targeted', 'changes'])
);
assert.equal(changes.area, 'changes');
assert.deepEqual(
  flattenTestWorkflowCommands(changes).map((command) => command.args[0]),
  [
    'scripts/test-changes-review.ts',
    'scripts/test-changes-review-consistency.ts',
    'scripts/test-git-diff-line-highlights-setting.ts',
    'scripts/test-saved-revision-tracker.ts',
    'scripts/test-diff-baseline-selection.ts',
    'scripts/test-document-diff-gutter.ts',
    'scripts/test-git-diff-overview-ruler.ts',
    'scripts/test-webview-viewport.ts',
    'scripts/test-table-diff-refresh.ts'
  ]
);

for (const area of ['table', 'rendered', 'viewport'] as const) {
  const targeted = createTestWorkflowPlan(parseTestWorkflowRequest(['targeted', area]));
  assert.ok(flattenTestWorkflowCommands(targeted).some((command) => (
    command.args.includes('scripts/test-virtual-block-scroll-stability.ts')
  )), `${area} targeted workflow must cover virtual block scroll stability`);
}

assert.ok(flattenTestWorkflowCommands(
  createTestWorkflowPlan(parseTestWorkflowRequest(['targeted', 'table']))
).some((command) => command.args.includes('scripts/test-table-body-interaction-sticky-production.ts')));
assert.ok(flattenTestWorkflowCommands(
  createTestWorkflowPlan(parseTestWorkflowRequest(['targeted', 'viewport']))
).some((command) => command.args.includes('scripts/test-document-reload-mermaid-viewport.ts')));
assert.ok(
  flattenTestWorkflowCommands(history).some((command) =>
    command.args.includes('scripts/test-rendered-content-history-roundtrip.ts')
  )
);

const uat = createTestWorkflowPlan(
  parseTestWorkflowRequest(['targeted', 'uat', 'fixtures/uat.md'])
);
assert.equal(uat.area, 'uat');
assert.equal(uat.longRunning, false);
const uatCommands = flattenTestWorkflowCommands(uat);
assert.equal(uatCommands.length, 2);
assert.equal(uatCommands[0]?.env?.MEO_UAT_ENDURANCE_LIMIT, '8');
assert.equal(uatCommands[0]?.env?.MEO_UAT_STRICT_FINDING, '*');
assert.deepEqual(uatCommands[1]?.args, [
  'scripts/test-production-live-scroll-integrity.ts',
  '--document=fixtures/uat.md'
]);

const release = createTestWorkflowPlan(parseTestWorkflowRequest(['release']));
assert.equal(release.longRunning, true);
assert.equal(release.stages[0]?.maxConcurrency, 3);
assert.deepEqual(release.stages[1]?.commands, [{ args: ['run', 'test:browser-high-risk'] }]);
assert.deepEqual(release.stages[2]?.commands, [{ args: ['run', 'test:browser'] }]);
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
assert.equal(endurance.stages.length, 3);
const enduranceCommands = flattenTestWorkflowCommands(endurance);
assert.deepEqual(
  enduranceCommands.slice(0, 8).map((command) => command.args[0]),
  [
    'scripts/test-document-reload-mermaid-viewport.ts',
    'scripts/test-search-replace-production.ts',
    'scripts/test-table-body-interaction-sticky-production.ts',
    'scripts/test-mermaid-editing.ts',
    'scripts/test-changes-review.ts',
    'scripts/test-document-diff-gutter.ts',
    'scripts/test-code-block-line-numbers.ts',
    'scripts/test-long-code-blocks.ts'
  ]
);
assert.equal(
  enduranceCommands[8]?.env?.MEO_UAT_STRICT_FINDING,
  '*'
);
assert.deepEqual(enduranceCommands[9]?.args, [
  'scripts/test-production-live-scroll-integrity.ts',
  '--document=fixtures/uat.md'
]);
assert.throws(
  () => validateTestWorkflowAuthorization(endurance, false, false),
  /--confirm-long-run/
);

const largeDocument = createTestWorkflowPlan(
  parseTestWorkflowRequest(['large-document', 'fixtures/large document.md'])
);
assert.equal(largeDocument.tier, 'large-document');
assert.equal(largeDocument.title, 'Simplified large-document stress test');
assert.equal(largeDocument.expectedDuration, 'about 1-3 minutes');
assert.equal(largeDocument.longRunning, true);
assert.equal(largeDocument.stages.length, 1);
assert.equal(largeDocument.stages[0]?.maxConcurrency, 1);
assert.deepEqual(flattenTestWorkflowCommands(largeDocument), [
  { args: ['run', 'benchmark:large-document'] },
  {
    args: [
      'scripts/test-uat-full-document-endurance.ts',
      'fixtures/large document.md'
    ],
    env: {
      MEO_UAT_ENDURANCE_LIMIT: '8',
      MEO_UAT_STRICT_FINDING: '*'
    }
  },
  {
    args: [
      'scripts/test-production-live-scroll-integrity.ts',
      '--document=fixtures/large document.md'
    ]
  }
]);
assert.throws(
  () => validateTestWorkflowAuthorization(largeDocument, false, false),
  /--confirm-long-run/
);
assert.doesNotThrow(() => (
  validateTestWorkflowAuthorization(largeDocument, true, false)
));
assert.doesNotThrow(() => (
  validateTestWorkflowAuthorization(largeDocument, false, true)
));

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
assert.throws(
  () => parseTestWorkflowRequest(['large-document']),
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
assert.equal(
  packageScripts['test:large-document'],
  'bun scripts/test-workflow.ts large-document'
);
assert.match(packageScripts.test ?? '', /bun run test:browser/);
assert.match(packageScripts.test ?? '', /bun run test:browser-high-risk/);

function collectTransitiveTestScripts(
  root: string,
  scripts: Record<string, string>
): Set<string> {
  const visited = new Set<string>();
  const directScripts = new Set<string>();
  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const body = scripts[name];
    assert.ok(body, `Missing package script referenced by full test workflow: ${name}`);
    for (const match of body.matchAll(
      /\bbun\s+(?:run\s+([\w:-]+)|(scripts\/[\w./-]+\.(?:ts|mjs)))/g
    )) {
      const nestedPackageScript = match[1];
      const directScript = match[2];
      if (nestedPackageScript) visit(nestedPackageScript);
      if (directScript) directScripts.add(directScript);
    }
  };
  visit(root);
  return directScripts;
}

const fullDirectScripts = collectTransitiveTestScripts('test', packageScripts);
for (const area of ['history', 'table', 'rendered', 'appearance', 'search', 'viewport', 'changes'] as const) {
  const targetedPlan = createTestWorkflowPlan(parseTestWorkflowRequest(['targeted', area]));
  for (const command of flattenTestWorkflowCommands(targetedPlan)) {
    const directScript = command.args[0];
    if (!directScript?.startsWith('scripts/')) continue;
    assert.ok(
      fullDirectScripts.has(directScript),
      `full test workflow must include targeted ${area} contract ${directScript}`
    );
  }
}

const fullSuiteScripts = [...(packageScripts.test ?? '').matchAll(/bun run (test:[\w-]+)/g)]
  .map((match) => match[1]!);
const releasePackageScripts = flattenTestWorkflowCommands(release)
  .filter((command) => command.args[0] === 'run')
  .map((command) => command.args[1]!);
for (const suite of fullSuiteScripts) {
  assert.equal(
    releasePackageScripts.filter((candidate) => candidate === suite).length,
    1,
    `release workflow must run full-suite command ${suite} exactly once`
  );
}
assert.ok(
  !releasePackageScripts.includes('test'),
  'release workflow should schedule the full suite groups without nesting the serial test script'
);

const workflowGuide = readFileSync(
  resolve(repoRoot, 'docs/testing-workflow.md'),
  'utf8'
);
for (const command of [
  'bun run test:quick',
  'bun run test:targeted',
  'bun run test:release',
  'bun run test:endurance',
  'bun run test:large-document -- <document> --confirm-long-run'
]) {
  assert.ok(workflowGuide.includes(command), `Workflow guide must document ${command}`);
}
assert.match(workflowGuide, /explicit user authorization/i);
assert.match(workflowGuide, /1[–-]3 minutes/);

const contributingGuide = readFileSync(resolve(repoRoot, 'CONTRIBUTING.md'), 'utf8');
assert.ok(contributingGuide.includes('docs/testing-workflow.md'));
assert.ok(contributingGuide.includes('bun run test:release -- --confirm-long-run'));

console.log('Test workflow policy contract passed');
