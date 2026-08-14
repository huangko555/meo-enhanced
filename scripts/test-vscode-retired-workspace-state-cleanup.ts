import assert from 'node:assert/strict';
import { cleanupRetiredWorkspaceState } from '../src/host/vscodeRetiredWorkspaceStateCleanup';

const updates: Array<{ key: string; value: unknown }> = [];
const unrelatedState = new Map<string, unknown>([
  ['rememberedViewPositionsByDocument', { 'file:///private.md': { line: 42, lineOffset: 0.5 } }],
  ['unrelatedPreference', true]
]);

await cleanupRetiredWorkspaceState({
  update: async (key, value) => {
    updates.push({ key, value });
    if (value === undefined) unrelatedState.delete(key);
    else unrelatedState.set(key, value);
  }
});

assert.deepEqual(updates, [{ key: 'rememberedViewPositionsByDocument', value: undefined }]);
assert.equal(unrelatedState.has('rememberedViewPositionsByDocument'), false);
assert.equal(unrelatedState.get('unrelatedPreference'), true);

updates.length = 0;
await cleanupRetiredWorkspaceState({
  update: async (key, value) => { updates.push({ key, value }); }
});
assert.deepEqual(updates, [{ key: 'rememberedViewPositionsByDocument', value: undefined }], 'cleanup is idempotent');

await assert.doesNotReject(cleanupRetiredWorkspaceState({
  update: async () => { throw new Error('storage unavailable'); }
}));

console.log('Retired workspace state cleanup contract passed.');
