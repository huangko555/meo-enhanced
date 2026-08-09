import assert from 'node:assert/strict';
import type { TableCommandEditorTarget } from '../webview/src/editor/tableCommandAdapter';
import { createTableCommandTargetRegistry } from '../webview/src/editor/tableCommandTargetRegistry';

const cleanupQueue: Array<() => void> = [];
const registry = createTableCommandTargetRegistry((run) => cleanupQueue.push(run));
const target = (identityKey: string, from: number, connected = true) => ({
  identityKey,
  from,
  to: from + 10,
  isConnected: () => connected
}) as TableCommandEditorTarget;

const original = target('same-table', 10);
const first = registry.register(original);
assert.equal(registry.resolve(first.id), original);
first.dispose();
assert.equal(registry.resolve(first.id), null);

const replacement = target('same-table', 11);
const second = registry.register(replacement);
assert.equal(second.id, first.id, 'a synchronous Widget rebuild must retain its logical target id');
cleanupQueue.shift()?.();
assert.equal(registry.resolve(second.id), replacement, 'old cleanup must not clear a newer generation');

first.dispose();
assert.equal(registry.resolve(second.id), replacement, 'old registration disposal must be idempotent');
second.dispose();
cleanupQueue.shift()?.();
assert.equal(registry.resolve(second.id), null);

const afterCleanup = registry.register(target('same-table', 11));
assert.notEqual(afterCleanup.id, second.id, 'an unclaimed dormant record must be physically removed');
const concurrent = registry.register(target('same-table', 11));
assert.notEqual(concurrent.id, afterCleanup.id, 'connected tables with equal headers must remain isolated');

registry.dispose();
assert.equal(registry.resolve(afterCleanup.id), null);
assert.equal(registry.resolve(concurrent.id), null);
afterCleanup.dispose();
concurrent.dispose();
cleanupQueue.splice(0).forEach((run) => run());

const afterDispose = registry.register(target('late-table', 0));
assert.equal(afterDispose.id, '');
assert.equal(registry.resolve(afterDispose.id), null, 'dispose must reject late target registration');

console.log('table command target registry checks passed');
