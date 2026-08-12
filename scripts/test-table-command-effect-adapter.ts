import assert from 'node:assert/strict';
import type { TransactionSpec } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import {
  createCodeMirrorTableCommandEffectAdapter
} from '../webview/src/editor/internal/codeMirrorTableCommandEffectAdapter';
import type { TableCommandEditorTarget } from '../webview/src/editor/tableCommandAdapter';

const dispatched: TransactionSpec[] = [];
const restored: string[] = [];
const errors: unknown[] = [];
let atomicBuilds = 0;
let disposed = 0;

const view = {
  state: { doc: { toString: () => '| A |' } },
  dispatch(spec: TransactionSpec) { dispatched.push(spec); }
} as unknown as EditorView;

const target: TableCommandEditorTarget = {
  view,
  identityKey: 'table-1',
  from: 0,
  isConnected: () => true,
  buildAtomicCommandTransaction(request) {
    atomicBuilds += 1;
    assert.equal(request.command, 'insert-row-below');
    assert.deepEqual(request.target, { tableId: 'table-1', row: 1, column: 0, selection: null });
    return {
      transaction: {
        changes: { from: 0, to: 5, insert: '| A |\n| --- |\n| edited |\n|  |' },
        effects: []
      },
      outcome: 'changed',
      restoreInteraction: () => restored.push('changed')
    };
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
  target: { tableId: 'table-1', row: 1, column: 0, selection: null }, pendingEdits: 'atomic'
}).completion;
assert.deepEqual(atomic, { type: 'commandCompleted', commandId: 1, outcome: 'changed' });
assert.equal(atomicBuilds, 1);
assert.equal(dispatched.length, 1, 'pending edits and structure must share one transaction dispatch');

assert.deepEqual(await adapter.execute({
  type: 'executeCommand', commandId: 3, command: 'delete-row',
  target: { tableId: 'missing', row: 1, column: 0, selection: null }, pendingEdits: 'atomic'
}).completion, { type: 'commandCompleted', commandId: 3, outcome: 'no-op' });

await adapter.execute({
  type: 'restoreInteraction', commandId: 1,
  target: { tableId: 'table-1', row: 1, column: 0, selection: null }, outcome: 'changed'
}).completion;
assert.deepEqual(restored, ['changed']);

await adapter.execute({
  type: 'executeCommand', commandId: 6, command: 'insert-row-below',
  target: { tableId: 'table-1', row: 1, column: 0, selection: null }, pendingEdits: 'atomic'
}).completion;
adapter.externalDocumentPresented();
await adapter.execute({
  type: 'restoreInteraction', commandId: 6,
  target: { tableId: 'table-1', row: 1, column: 0, selection: null }, outcome: 'changed'
}).completion;
assert.deepEqual(restored, ['changed'], 'document invalidation must clear stale interaction restore');

const failing = createCodeMirrorTableCommandEffectAdapter({
  resolveTarget() {
    return { ...target, buildAtomicCommandTransaction() { throw new Error('expected failure'); } };
  },
  reportError(error) { errors.push(error); },
  dispose() { disposed += 1; }
});
assert.deepEqual(await failing.execute({
  type: 'executeCommand', commandId: 4, command: 'delete-column',
  target: { tableId: 'table-1', row: 1, column: 0, selection: null }, pendingEdits: 'atomic'
}).completion, { type: 'commandFailed', commandId: 4 });
assert.equal(errors.length, 1);

adapter.dispose();
adapter.dispose();
assert.equal(disposed, 1);
assert.equal(await adapter.execute({
  type: 'executeCommand', commandId: 5, command: 'align-right',
  target: { tableId: 'table-1', row: 1, column: 0, selection: null }, pendingEdits: 'atomic'
}).completion, null);
assert.equal(dispatched.length, 2);

console.log('table command effect adapter contracts passed');
