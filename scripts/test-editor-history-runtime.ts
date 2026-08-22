import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEditorHistoryApplication } from '../webview/src/application/editorHistory';
import {
  createEditorHistoryEffectAdapter,
  type EditorHistoryEffectCapabilities,
  type EditorHistoryRestoreRequest
} from '../webview/src/adapters/editorHistoryEffectAdapter';
import { createEditorHistoryRuntime } from '../webview/src/adapters/editorHistoryRuntime';

const events: string[] = [];
const errors: string[] = [];
let restoreResult: 'not-rendered' | 'restored' | 'retry' = 'not-rendered';
let scheduledRetry: (() => void) | null = null;
let retryCancels = 0;
let nativeResult: { applied: boolean; changedRange: { from: number; to: number } | null } = {
  applied: true,
  changedRange: { from: 16, to: 16 }
};
let releaseNative: (() => void) | null = null;
let latestRestoreIsCurrent: (() => boolean) | null = null;

const capabilities: EditorHistoryEffectCapabilities = {
  captureContext: () => ({
    viewport: {
      scrollTop: 120,
      selection: { lineNumber: 12, visibleFromLineNumber: 10, visibleToLineNumber: 30, wasVisible: true }
    }
  }),
  commitTransientEdits: () => events.push('commit'),
  async runNativeHistory(direction) {
    events.push(`native:${direction}`);
    if (releaseNative !== null) {
      await new Promise<void>((resolve) => { releaseNative = resolve; });
    }
    return nativeResult;
  },
  attemptBoundaryRestore(request, isCurrent) {
    latestRestoreIsCurrent = isCurrent;
    events.push(`boundary:${request.replayId}`);
    return restoreResult;
  },
  restoreEditorInteraction(request) {
    events.push(`editor:${request.replayId}:${request.targetPosition ?? 'none'}:${request.previousViewport.scrollTop}`);
  },
  scheduleFocusRetry(run) {
    scheduledRetry = run;
    events.push('schedule-retry');
    return () => {
      retryCancels += 1;
      events.push('cancel-retry');
    };
  },
  reportError: (operation) => errors.push(operation),
  dispose: () => events.push('dispose')
};

const application = createEditorHistoryApplication();
const adapter = createEditorHistoryEffectAdapter(capabilities);
const runtime = createEditorHistoryRuntime(application, adapter, (error) => errors.push(String(error)));

assert.equal(await runtime.dispatch({ type: 'requestReplay', direction: 'undo' }), true);
await runtime.whenIdle();
assert.deepEqual(events, ['commit', 'native:undo', 'boundary:1', 'editor:1:16:120']);
assert.equal(runtime.getState().pendingReplay, null);
assert.equal(latestRestoreIsCurrent?.(), true);
await runtime.dispatch({ type: 'cancelRestore' });
assert.equal(
  latestRestoreIsCurrent?.(),
  false,
  'new user interaction must invalidate delayed restore work after the Application has returned to idle'
);

events.length = 0;
nativeResult = { applied: false, changedRange: null };
assert.equal(await runtime.dispatch({ type: 'requestReplay', direction: 'undo' }), false);
assert.deepEqual(events, ['commit', 'native:undo'], 'history boundary must not attempt interaction restore');
assert.equal(runtime.getState().pendingReplay, null);

events.length = 0;
nativeResult = { applied: true, changedRange: { from: 16, to: 24 } };
restoreResult = 'restored';
await runtime.dispatch({ type: 'requestReplay', direction: 'redo' });
await runtime.whenIdle();
assert.deepEqual(events, ['commit', 'native:redo', 'boundary:3']);
assert.equal(runtime.getState().pendingReplay, null);

events.length = 0;
restoreResult = 'retry';
await runtime.dispatch({ type: 'requestReplay', direction: 'undo' });
assert.deepEqual(events, ['commit', 'native:undo', 'boundary:4', 'schedule-retry']);
assert.equal(runtime.getState().pendingReplay?.phase, 'restoring');
restoreResult = 'restored';
const retry = scheduledRetry;
assert.ok(retry);
retry();
await new Promise((resolve) => setTimeout(resolve, 0));
await runtime.whenIdle();
assert.equal(runtime.getState().pendingReplay, null);
assert.equal(events.filter((event) => event === 'cancel-retry').length, 1);

events.length = 0;
restoreResult = 'retry';
await runtime.dispatch({ type: 'requestReplay', direction: 'undo' });
const staleRetry = scheduledRetry;
assert.ok(staleRetry);
await runtime.dispatch({ type: 'externalDocumentPresented' });
assert.equal(runtime.getState().pendingReplay, null);
restoreResult = 'restored';
staleRetry();
await new Promise((resolve) => setTimeout(resolve, 0));
await runtime.whenIdle();
assert.equal(
  events.filter((event) => event.startsWith('boundary:')).length,
  1,
  'cancelled focus retry must not restore after an external Document presentation'
);

events.length = 0;
restoreResult = 'not-rendered';
releaseNative = () => undefined;
const rapidUndo = runtime.dispatch({ type: 'requestReplay', direction: 'undo' });
const rapidRedo = runtime.dispatch({ type: 'requestReplay', direction: 'redo' });
await new Promise((resolve) => setTimeout(resolve, 0));
assert.deepEqual(events, ['commit', 'native:undo'], 'native history operations must serialize');
const release = releaseNative;
assert.ok(release);
releaseNative = null;
restoreResult = 'restored';
release();
await Promise.all([rapidUndo, rapidRedo]);
await runtime.whenIdle();
assert.deepEqual(events, [
  'commit', 'native:undo', 'boundary:6',
  'commit', 'native:redo', 'boundary:7'
]);

events.length = 0;
restoreResult = 'retry';
await runtime.dispatch({ type: 'requestReplay', direction: 'undo' });
const disposedRetry = scheduledRetry;
assert.ok(disposedRetry);
runtime.dispose();
disposedRetry();
await new Promise((resolve) => setTimeout(resolve, 0));
await runtime.whenIdle();
assert.equal(runtime.getState().lifecycle, 'disposed');
assert.equal(events.filter((event) => event === 'dispose').length, 1);
assert.equal(await runtime.dispatch({ type: 'requestReplay', direction: 'redo' }), null);
assert.equal(errors.length, 0);
assert.ok(retryCancels >= 3, 'retry handles must be cancelled after completion, invalidation, and dispose');

const restoreRequest: EditorHistoryRestoreRequest = {
  replayId: 99,
  direction: 'undo',
  targetPosition: 7,
  changedRange: { from: 7, to: 7 },
  previousViewport: {
    scrollTop: 30,
    selection: { lineNumber: 3, visibleFromLineNumber: 1, visibleToLineNumber: 12, wasVisible: true }
  }
};
assert.equal(restoreRequest.changedRange?.from, 7);

const adapterSource = readFileSync(new URL('../webview/src/adapters/editorHistoryEffectAdapter.ts', import.meta.url), 'utf8');
assert.equal(/@codemirror|EditorView|Transaction|DocumentSession|Revision|Draft|historyDepth|historyEntries/.test(adapterSource), false);
const runtimeSource = readFileSync(new URL('../webview/src/adapters/editorHistoryRuntime.ts', import.meta.url), 'utf8');
assert.equal(/@codemirror|EditorView|Transaction|DocumentSession|Revision|Draft|historyDepth|historyEntries/.test(runtimeSource), false);
const productionIndex = readFileSync(new URL('../webview/src/index.ts', import.meta.url), 'utf8');
const productionEditor = readFileSync(new URL('../webview/src/editor.ts', import.meta.url), 'utf8');
assert.equal(productionIndex.includes('createEditorHistoryRuntime'), false, 'candidate Runtime must not enter Bootstrap');
assert.equal(productionEditor.includes('createEditorHistoryRuntime'), true, 'production Editor must wire History Runtime');

console.log('Editor history runtime and effect adapter checks passed');
