import assert from 'node:assert/strict';
import {
  createTableCommandApplication,
  type TableCommandEffect,
  type TableCommandEffectExecutor,
  type TableCommandInput
} from '../webview/src/application/tableCommand';
import { createTableCommandRuntime } from '../webview/src/adapters/tableCommandRuntime';

const target = { tableId: 'table-1', row: 1, column: 0 } as const;
const executionOrder: string[] = [];
let settleFirst: ((input: TableCommandInput) => void) | null = null;

const executor: TableCommandEffectExecutor = {
  execute(effect: TableCommandEffect) {
    executionOrder.push(`${effect.type}:${effect.commandId}`);
    if (effect.type === 'executeCommand' && effect.command === 'insert-row-below') {
      return {
        completion: new Promise<TableCommandInput>((resolve) => {
          settleFirst = resolve;
        })
      };
    }
    if (effect.type === 'flushPendingEdits') {
      return {
        completion: Promise.resolve({
          type: 'pendingEditsFlushed', commandId: effect.commandId
        })
      };
    }
    if (effect.type === 'executeCommand') {
      return {
        completion: Promise.resolve({
          type: 'commandCompleted', commandId: effect.commandId,
          outcome: effect.command === 'preview-sort' ? 'presented' : 'changed'
        })
      };
    }
    return {};
  },
  invalidate() {},
  dispose() {}
};

const errors: unknown[] = [];
const runtime = createTableCommandRuntime(createTableCommandApplication(), executor, (error) => errors.push(error));
const first = runtime.dispatch({
  type: 'request', command: 'insert-row-below', target, enabled: true
});
const second = runtime.dispatch({
  type: 'request', command: 'preview-sort', target, enabled: true
});
await Promise.resolve();
assert.deepEqual(executionOrder, ['executeCommand:1']);
assert.equal(runtime.getState().phase, 'executing');
assert.ok(settleFirst);
settleFirst({ type: 'commandCompleted', commandId: 1, outcome: 'changed' });
assert.equal(await first, 'changed');
assert.equal(await second, 'presented');
await runtime.whenIdle();
assert.deepEqual(executionOrder, [
  'executeCommand:1', 'restoreInteraction:1',
  'flushPendingEdits:2', 'executeCommand:2', 'restoreInteraction:2'
]);
assert.equal(runtime.getState().phase, 'idle');
assert.deepEqual(errors, []);

const staleExecutor: TableCommandEffectExecutor = {
  execute(effect) {
    if (effect.type !== 'executeCommand') return {};
    return {
      completion: Promise.resolve({
        type: 'commandCompleted', commandId: effect.commandId + 1, outcome: 'changed'
      })
    };
  },
  invalidate() {},
  dispose() {}
};
const staleRuntime = createTableCommandRuntime(createTableCommandApplication(), staleExecutor, () => {});
assert.equal(await staleRuntime.dispatch({
  type: 'request', command: 'delete-row', target, enabled: true
}), null);
assert.equal(staleRuntime.getState().phase, 'executing');
staleRuntime.dispose();
assert.equal(staleRuntime.getState().phase, 'disposed');

let lateDispatch: ((input: TableCommandInput) => void) | null = null;
let disposeEffects = 0;
let executorDisposals = 0;
const disposableExecutor: TableCommandEffectExecutor = {
  execute(effect) {
    if (effect.type === 'executeCommand') {
      return { completion: new Promise<TableCommandInput>((resolve) => { lateDispatch = resolve; }) };
    }
    if (effect.type === 'restoreInteraction') disposeEffects += 1;
    return {};
  },
  invalidate() {},
  dispose() { executorDisposals += 1; }
};
const disposableRuntime = createTableCommandRuntime(
  createTableCommandApplication(), disposableExecutor, () => {}
);
const pending = disposableRuntime.dispatch({
  type: 'request', command: 'apply-sort', target, enabled: true
});
await Promise.resolve();
disposableRuntime.dispose();
lateDispatch?.({ type: 'commandCompleted', commandId: 1, outcome: 'changed' });
assert.equal(await pending, null);
await disposableRuntime.whenIdle();
assert.equal(disposeEffects, 0, 'late completion must not restore disposed interaction');
assert.equal(executorDisposals, 1);

let settleInvalidated: ((input: TableCommandInput) => void) | null = null;
let invalidateCalls = 0;
let delayFirst = true;
const invalidationExecutor: TableCommandEffectExecutor = {
  execute(effect) {
    if (effect.type === 'executeCommand' && delayFirst) {
      delayFirst = false;
      return { completion: new Promise<TableCommandInput>((resolve) => { settleInvalidated = resolve; }) };
    }
    if (effect.type === 'executeCommand') {
      return {
        immediateCompletion: {
          type: 'commandCompleted', commandId: effect.commandId, outcome: 'changed'
        }
      };
    }
    return { immediateCompletion: null };
  },
  invalidate() { invalidateCalls += 1; },
  dispose() {}
};
const invalidationRuntime = createTableCommandRuntime(
  createTableCommandApplication(), invalidationExecutor, () => {}
);
const invalidatedFirst = invalidationRuntime.dispatch({
  type: 'request', command: 'insert-row-below', target, enabled: true
});
const invalidatedQueued = invalidationRuntime.dispatch({
  type: 'request', command: 'delete-column', target, enabled: true
});
invalidationRuntime.invalidate();
assert.equal(invalidateCalls, 1);
assert.deepEqual(invalidationRuntime.getState(), { phase: 'idle', activeCommandId: null });
assert.equal(await invalidationRuntime.dispatch({
  type: 'request', command: 'insert-column-left', target, enabled: true
}), 'changed', 'a new document scope must not wait for the invalidated queue');
settleInvalidated?.({ type: 'commandCompleted', commandId: 1, outcome: 'changed' });
assert.equal(await invalidatedFirst, null);
assert.equal(await invalidatedQueued, null);
await invalidationRuntime.whenIdle();

console.log('table command runtime contracts passed');
