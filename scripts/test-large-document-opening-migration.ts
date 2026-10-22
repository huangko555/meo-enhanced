import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import fs from 'node:fs';

let globalValue: boolean | undefined, workspaceValue: boolean | undefined;
let failTarget: number | undefined;
const writes: number[] = [];
mock.module('vscode', () => ({
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  workspace: { getConfiguration: () => ({
    inspect: () => ({ globalValue, workspaceValue }),
    update: async (_key: string, value: boolean, target: number) => {
      if (target === failTarget) throw new Error('settings write failed');
      assert.equal(value, false); writes.push(target);
      if (target === 1) globalValue = value; else workspaceValue = value;
    }
  }) }
}));
const { migrateLargeDocumentOpening } = await import('../src/host/vscodeLargeDocumentOpening');
function store() {
  const values = new Map<string, unknown>();
  return { get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); }, values };
}
const state = () => ({ globalState: store(), workspaceState: store() });
const migrated = state();
globalValue = workspaceValue = true;
await migrateLargeDocumentOpening(migrated);
assert.deepEqual([globalValue, workspaceValue, writes], [false, false, [1, 2]], 'upgrade disables old overrides in both scopes');
globalValue = workspaceValue = true;
await migrateLargeDocumentOpening(migrated);
assert.deepEqual([globalValue, workspaceValue, writes], [true, true, [1, 2]], 'later opt-ins survive restart');
writes.length = 0;
await migrateLargeDocumentOpening({ globalState: migrated.globalState, workspaceState: store() });
assert.deepEqual([globalValue, workspaceValue, writes], [true, false, [2]], 'an old workspace opened later migrates without resetting the new profile choice');
for (const value of [false, undefined]) {
  globalValue = workspaceValue = value; writes.length = 0;
  await migrateLargeDocumentOpening(state());
  assert.deepEqual(writes, [], 'default-off and missing values do not need rewriting');
}
for (const target of [1, 2]) {
  const retry = state(); globalValue = workspaceValue = true; writes.length = 0; failTarget = target;
  await assert.rejects(migrateLargeDocumentOpening(retry), /settings write failed/);
  assert.equal((target === 1 ? retry.globalState : retry.workspaceState).values.size, 0);
  failTarget = undefined;
  await migrateLargeDocumentOpening(retry);
  assert.deepEqual([globalValue, workspaceValue, writes], [false, false, [1, 2]], 'failed writes retry without repeating completed scopes');
}
const schema = JSON.parse(fs.readFileSync('package.json', 'utf8')).contributes.configuration.properties['meoEnhanced.performance.largeDocumentOptimization'];
assert.equal(schema.default, false); assert.equal(schema.scope, 'window');
const extension = fs.readFileSync('src/extension.ts', 'utf8');
assert.ok(extension.indexOf('await migrateLargeDocumentOpening(context)') < extension.indexOf('const provider = new MarkdownWebviewProvider'), 'migration completes before the provider accepts panels');
console.log('Large-document opening: default off, one-time profile/workspace migration, later choices and retries passed');
