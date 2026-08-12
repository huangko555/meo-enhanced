import assert from 'node:assert/strict';
import {
  createTableCommandApplication,
  tableCommands,
  type TableCommandEffect,
  type TableCommandTarget
} from '../webview/src/application/tableCommand';

assert.deepEqual(tableCommands, [
  'insert-row-above',
  'insert-row-below',
  'delete-row',
  'insert-column-left',
  'insert-column-right',
  'delete-column',
  'align-left',
  'align-center',
  'align-right'
], 'the public Table Command boundary must expose only retained product commands');

const target: TableCommandTarget = { tableId: 'table-1', row: 1, column: 0, selection: null };
const types = (effects: readonly TableCommandEffect[]) => effects.map((effect) => effect.type);

const structural = createTableCommandApplication();
const structuralRequest = structural.dispatch({
  type: 'request',
  command: 'insert-row-below',
  target,
  enabled: true
});
assert.deepEqual(types(structuralRequest), ['executeCommand']);
assert.deepEqual(structuralRequest[0], {
  type: 'executeCommand',
  commandId: 1,
  command: 'insert-row-below',
  target
});
const structuralId = structural.getState().activeCommandId;
assert.ok(structuralId);
assert.deepEqual(
  types(structural.dispatch({ type: 'commandCompleted', commandId: structuralId, outcome: 'changed' })),
  ['restoreInteraction']
);
assert.equal(structural.getState().phase, 'idle');

const disabled = createTableCommandApplication();
assert.deepEqual(disabled.dispatch({
  type: 'request', command: 'delete-column', target, enabled: false
}), []);
assert.equal(disabled.getState().phase, 'idle');

const noOp = createTableCommandApplication();
noOp.dispatch({ type: 'request', command: 'align-left', target, enabled: true });
const noOpId = noOp.getState().activeCommandId;
assert.ok(noOpId);
assert.deepEqual(noOp.dispatch({ type: 'commandCompleted', commandId: noOpId, outcome: 'no-op' }), []);
assert.equal(noOp.getState().phase, 'idle');

const ordered = createTableCommandApplication();
ordered.dispatch({ type: 'request', command: 'insert-row-above', target, enabled: true });
const firstId = ordered.getState().activeCommandId;
assert.ok(firstId);
assert.deepEqual(
  ordered.dispatch({ type: 'request', command: 'delete-row', target, enabled: true }),
  [],
  'the coordinator must not start a second command while one is active'
);
assert.deepEqual(ordered.dispatch({ type: 'commandCompleted', commandId: firstId + 1, outcome: 'changed' }), []);
assert.equal(ordered.getState().activeCommandId, firstId, 'late or unrelated completion must not replace the active command');

const failed = createTableCommandApplication();
failed.dispatch({ type: 'request', command: 'delete-row', target, enabled: true });
const failedId = failed.getState().activeCommandId;
assert.ok(failedId);
assert.deepEqual(
  types(failed.dispatch({ type: 'commandFailed', commandId: failedId })),
  ['restoreInteraction']
);
assert.equal(failed.getState().phase, 'idle');

const disposed = createTableCommandApplication();
disposed.dispatch({ type: 'request', command: 'delete-column', target, enabled: true });
const disposedId = disposed.getState().activeCommandId;
assert.ok(disposedId);
assert.deepEqual(disposed.dispatch({ type: 'dispose' }), []);
assert.equal(disposed.getState().phase, 'disposed');
assert.deepEqual(disposed.dispatch({ type: 'commandCompleted', commandId: disposedId, outcome: 'changed' }), []);
assert.deepEqual(disposed.dispatch({ type: 'request', command: 'insert-column-left', target, enabled: true }), []);

const invalidated = createTableCommandApplication();
invalidated.dispatch({ type: 'request', command: 'delete-row', target, enabled: true });
assert.equal(invalidated.getState().phase, 'executing');
assert.deepEqual(invalidated.dispatch({ type: 'externalDocumentPresented' }), []);
assert.deepEqual(invalidated.getState(), { phase: 'idle', activeCommandId: null });
assert.equal(invalidated.dispatch({
  type: 'request', command: 'insert-column-right', target, enabled: true
})[0]?.type, 'executeCommand');

console.log('table command application contracts passed');
