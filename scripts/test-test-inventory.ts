import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkTestInventory, inspectTestInventory, readInventorySnapshot, type TestInventory } from './check-test-inventory';

const empty = (): TestInventory => ({ separate: {}, repeats: [], resources: { process: ['scripts/test-a.ts'], exclusive: [] } });
const command = { args: ['run', 'test'] };
const fixture = (scripts: Record<string, string> = { test: 'bun scripts/test-a.ts' }) => new Map([
  ['package.json', JSON.stringify({ scripts })], ['scripts/test-a.ts', 'export const value = 1;']
]);
assert.deepEqual(inspectTestInventory(fixture(), [command], empty()), []);
const orphan = fixture({ test: 'bun scripts/test-a.ts', 'test:new': 'bun scripts/test-new.ts' });
orphan.set('scripts/test-new.ts', 'throw new Error("must never execute during inventory");');
assert.ok(inspectTestInventory(orphan, [command], empty()).some(error => error.includes('Unregistered test: scripts/test-new.ts')));
assert.ok(inspectTestInventory(orphan, [command], empty()).some(error => error.includes('Unregistered test alias test:new')));

const special: TestInventory = { separate: { 'scripts/test-new.ts': {
  kind: 'native', command: 'node scripts/test-new.ts', reason: 'Requires an installed extension host.'
} }, repeats: [], resources: { process: ['scripts/test-a.ts'], exclusive: ['scripts/test-new.ts'] } };
assert.deepEqual(inspectTestInventory(orphan, [command], special), []);
assert.ok(inspectTestInventory(orphan, [command], { ...special, separate: {
  'scripts/test-new.ts': { ...special.separate['scripts/test-new.ts']!, reason: '' }
} }).some(error => error.includes('Missing classification')));
assert.ok(inspectTestInventory(fixture(), [command], special).some(error => error.includes('Stale separate')));
const registered = fixture({ test: 'bun scripts/test-a.ts && bun scripts/test-new.ts' });
registered.set('scripts/test-new.ts', '');
assert.ok(inspectTestInventory(registered, [command], special).some(error => error.includes('now in release')));

const support = fixture();
support.set('scripts/test-a.ts', "import './test-helper'; const entry = 'scripts/test-browser-entry.ts';");
support.set('scripts/test-helper.ts', 'export const helper = true;');
support.set('scripts/test-browser-entry.ts', 'export const browserFixture = true;');
assert.deepEqual(inspectTestInventory(support, [command], empty()), []);
support.set('scripts/test-orphan-entry.ts', '');
assert.ok(inspectTestInventory(support, [command], empty()).some(error => error.includes('Unregistered test: scripts/test-orphan-entry.ts')));
support.set('scripts/test-a.ts', support.get('scripts/test-a.ts')! + '\n// "scripts/test-orphan-entry.ts"\n');
assert.ok(inspectTestInventory(support, [command], empty()).some(error => error.includes('Unregistered test: scripts/test-orphan-entry.ts')),
  'Comments do not register browser fixtures');
support.delete('scripts/test-orphan-entry.ts');
support.set('scripts/test-a.ts', 'export const disconnected = true;');
assert.equal(inspectTestInventory(support, [command], empty()).filter(error => error.includes('Unregistered test:')).length, 2);

const duplicate = fixture({ test: 'bun scripts/test-a.ts && bun run test:nested', 'test:nested': 'bun scripts/test-a.ts' });
assert.ok(inspectTestInventory(duplicate, [command], empty()).some(error => error.includes('Unexplained repeated')));
const repeated: TestInventory = { ...empty(), repeats: [{ args: ['scripts/test-a.ts'], count: 2, reason: 'Early preflight and final matrix.' }] };
assert.deepEqual(inspectTestInventory(duplicate, [command], repeated), []);
assert.ok(inspectTestInventory(fixture(), [command], repeated).some(error => error.includes('Stale repeat')));
assert.ok(inspectTestInventory(duplicate, [command, command], repeated).some(error => error.includes('Unexplained repeated test (4)')));
assert.deepEqual(inspectTestInventory(fixture(), [
  { args: ['scripts/test-a.ts', '--sampled'] }, { args: ['scripts/test-a.ts'] },
  { args: ['scripts/test-a.ts'], env: { MODE: 'dark' } }
], empty()), [], 'Distinct arguments and environments are not duplicate runs');
assert.ok(inspectTestInventory(fixture(), [
  { args: ['scripts/test-a.ts'], env: { A: '1', B: '2' } },
  { args: ['scripts/test-a.ts'], env: { B: '2', A: '1' } }
], empty()).some(error => error.includes('Unexplained repeated')), 'Environment key order must not hide duplication');
assert.deepEqual(inspectTestInventory(fixture({ test: 'bun scripts/test-a.ts && node scripts/test-a.ts' }), [command], empty()), [],
  'Node compatibility evidence differs from Bun execution');
assert.throws(() => inspectTestInventory(fixture({ test: 'bun run test:cycle', 'test:cycle': 'bun run test' }), [command], empty()), /Cyclic/);
assert.throws(() => inspectTestInventory(fixture({ test: 'bun scripts/test-a.ts || true' }), [command], empty()), /Unsupported/);
assert.throws(() => inspectTestInventory(fixture({ test: 'bun run test:missing' }), [command], empty()), /Missing package script/);
assert.ok(inspectTestInventory(fixture({ test: 'bun scripts/test-missing.ts' }), [command], empty()).some(error => error.includes('Missing test')));
const missingHelper = fixture();
missingHelper.set('scripts/test-a.ts', 'import "./test-missing-helper";');
assert.ok(inspectTestInventory(missingHelper, [command], empty()).some(error => error.includes('Missing test helper')));

assert.ok(inspectTestInventory(fixture(), [command], { ...empty(), resources: { process: [], exclusive: [] } })
  .some(error => error.includes('Unclassified test resources')));
assert.ok(inspectTestInventory(fixture(), [command], { ...empty(), resources: { process: ['scripts/test-a.ts'], exclusive: ['scripts/test-a.ts'] } })
  .some(error => error.includes('Duplicate test resource')));
const browser = fixture();
browser.set('scripts/test-a.ts', 'import { open } from "./test-helper"; open();');
browser.set('scripts/test-helper.ts', 'import puppeteer from "puppeteer"; export const open = () => puppeteer.launch();');
assert.ok(inspectTestInventory(browser, [command], empty()).some(error => error.includes('Process-only test reaches browser')),
  'A new shared browser dependency must invalidate a former process-only classification');
assert.deepEqual(inspectTestInventory(browser, [command], { ...empty(), resources: { process: [], exclusive: ['scripts/test-a.ts'] } }), []);

// Use an isolated index: a pre-commit environment may export GIT_INDEX_FILE.
mkdirSync(join(process.cwd(), '.local'), { recursive: true });
const root = mkdtempSync(join(process.cwd(), '.local', 'inventory-contract-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
const inheritedGit = Object.entries(process.env).filter(([key]) => key.startsWith('GIT_'));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
try {
  for (const [key] of inheritedGit) delete process.env[key];
  git('init', '--quiet');
  mkdirSync(join(root, 'scripts'));
  const save = (path: string, text: string) => writeFileSync(join(root, path), text);
  save('package.json', fixture().get('package.json')!);
  save('scripts/test-a.ts', 'import "./test-workflow-policy"; throw new Error("inventory must never run tests");');
  save('scripts/test-inventory.json', JSON.stringify(empty()));
  save('scripts/test-workflow-policy.ts', `
    export const parseTestWorkflowRequest = () => ({});
    export const createTestWorkflowPlan = () => ({});
    export const flattenTestWorkflowCommands = () => [{ args: ['run', 'test'] }];
  `);
  git('add', '.');
  await checkTestInventory(root, true);
  save('scripts/test-new.ts', '');
  assert.ok(readInventorySnapshot(root, false).has('scripts/test-new.ts'), 'Discover untracked, nonignored new tests');
  git('add', 'scripts/test-new.ts');
  save('package.json', JSON.stringify({ scripts: { test: 'bun scripts/test-a.ts && bun scripts/test-new.ts' } }));
  save('scripts/test-inventory.json', JSON.stringify({ ...empty(), resources: { process: ['scripts/test-a.ts', 'scripts/test-new.ts'], exclusive: [] } }));
  await checkTestInventory(root, false);
  await assert.rejects(checkTestInventory(root, true), /Unregistered test: scripts\/test-new.ts/,
    'An unstaged registration must not fix the staged snapshot');
  git('add', 'package.json', 'scripts/test-inventory.json');
  await checkTestInventory(root, true);
  save('scripts/test-workflow-policy.ts', `
    export const parseTestWorkflowRequest = () => ({});
    export const createTestWorkflowPlan = () => ({});
    export const flattenTestWorkflowCommands = () => [{ args: ['scripts/test-a.ts'] }];
  `);
  await checkTestInventory(root, true);
  await assert.rejects(checkTestInventory(root, false), /Unregistered test: scripts\/test-new.ts/,
    'The staged check must also use the staged workflow policy');
} finally {
  for (const [key, value] of inheritedGit) process.env[key] = value;
  rmSync(root, { recursive: true, force: true });
}
console.log('Test inventory contracts passed: orphan detection, classification, duplicate identity and staged snapshot isolation.');
