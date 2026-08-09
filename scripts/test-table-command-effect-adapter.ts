import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Transaction, TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  createCodeMirrorTableCommandEffectAdapter
} from '../webview/src/editor/internal/codeMirrorTableCommandEffectAdapter';
import type { TableCommandEditorTarget } from '../webview/src/editor/tableCommandAdapter';

const dispatched: TransactionSpec[] = [];
const restored: string[] = [];
const errors: unknown[] = [];
let pendingBuilds = 0;
let atomicBuilds = 0;
let visualCommands = 0;
let disposed = 0;

const view = {
  state: { doc: { toString: () => '| A |' } },
  dispatch(spec: TransactionSpec) { dispatched.push(spec); }
} as unknown as EditorView;

const target: TableCommandEditorTarget = {
  view,
  identityKey: 'table-1',
  from: 0,
  to: 5,
  isConnected: () => true,
  buildPendingEditTransactions() {
    pendingBuilds += 1;
    return [{ changes: { from: 0, to: 0, insert: 'pending ' } } as unknown as Transaction];
  },
  buildAtomicCommandTransaction(request) {
    atomicBuilds += 1;
    assert.equal(request.command, 'insert-row-below');
    assert.deepEqual(request.target, { tableId: 'table-1', row: 1, column: 0 });
    return {
      transaction: {
        changes: { from: 0, to: 5, insert: '| A |\n| --- |\n| edited |\n|  |' },
        effects: []
      },
      outcome: 'changed',
      restoreInteraction: () => restored.push('changed')
    };
  },
  presentCommand(request) {
    visualCommands += 1;
    assert.equal(request.command, 'preview-sort');
    return 'presented';
  },
  preserveViewport(run) { run(); }
};

const adapter = createCodeMirrorTableCommandEffectAdapter({
  resolveTarget(tableId) {
    return tableId === 'table-1' ? target : null;
  },
  reportError(error) { errors.push(error); },
  dispose() { disposed += 1; }
});

const atomic = await adapter.execute({
  type: 'executeCommand', commandId: 1, command: 'insert-row-below',
  target: { tableId: 'table-1', row: 1, column: 0 }, pendingEdits: 'atomic'
}).completion;
assert.deepEqual(atomic, { type: 'commandCompleted', commandId: 1, outcome: 'changed' });
assert.equal(atomicBuilds, 1);
assert.equal(pendingBuilds, 0, 'atomic path must not dispatch a pending-edit transaction first');
assert.equal(dispatched.length, 1, 'pending edits and structure must share one transaction dispatch');

const flushed = await adapter.execute({
  type: 'flushPendingEdits', commandId: 2, tableId: 'table-1'
}).completion;
assert.deepEqual(flushed, { type: 'pendingEditsFlushed', commandId: 2 });
assert.equal(pendingBuilds, 1);
assert.equal(dispatched.length, 2);
const presented = await adapter.execute({
  type: 'executeCommand', commandId: 2, command: 'preview-sort',
  target: { tableId: 'table-1', row: 1, column: 0 }, pendingEdits: 'flushed'
}).completion;
assert.deepEqual(presented, { type: 'commandCompleted', commandId: 2, outcome: 'presented' });
assert.equal(visualCommands, 1);
assert.equal(dispatched.length, 2, 'visual sort preview must not create document history');

assert.deepEqual(await adapter.execute({
  type: 'executeCommand', commandId: 3, command: 'delete-row',
  target: { tableId: 'missing', row: 1, column: 0 }, pendingEdits: 'atomic'
}).completion, { type: 'commandCompleted', commandId: 3, outcome: 'no-op' });

await adapter.execute({
  type: 'restoreInteraction', commandId: 1,
  target: { tableId: 'table-1', row: 1, column: 0 }, outcome: 'changed'
}).completion;
assert.deepEqual(restored, ['changed']);

const failing = createCodeMirrorTableCommandEffectAdapter({
  resolveTarget() {
    return { ...target, buildAtomicCommandTransaction() { throw new Error('expected failure'); } };
  },
  reportError(error) { errors.push(error); },
  dispose() { disposed += 1; }
});
assert.deepEqual(await failing.execute({
  type: 'executeCommand', commandId: 4, command: 'delete-column',
  target: { tableId: 'table-1', row: 1, column: 0 }, pendingEdits: 'atomic'
}).completion, { type: 'commandFailed', commandId: 4 });
assert.equal(errors.length, 1);

adapter.dispose();
adapter.dispose();
assert.equal(disposed, 1);
assert.equal(await adapter.execute({
  type: 'executeCommand', commandId: 5, command: 'apply-sort',
  target: { tableId: 'table-1', row: 1, column: 0 }, pendingEdits: 'atomic'
}).completion, null);
assert.equal(dispatched.length, 2);

const productionSource = readFileSync(new URL('../webview/src/editor.ts', import.meta.url), 'utf8');
assert.equal((productionSource.match(/createTableCommandApplication\(/g) ?? []).length, 1);
assert.equal((productionSource.match(/createTableCommandRuntime\(/g) ?? []).length, 1);
assert.equal((productionSource.match(/createCodeMirrorTableCommandEffectAdapter\(/g) ?? []).length, 1);
const tablesSource = readFileSync(new URL('../webview/src/helpers/tables.ts', import.meta.url), 'utf8');
assert.equal(tablesSource.includes('createTableCommandApplication'), false);
assert.equal(tablesSource.includes('createTableCommandRuntime'), false);
assert.equal(tablesSource.includes('createCodeMirrorTableCommandEffectAdapter'), false);

console.log('table command effect adapter contracts passed');
