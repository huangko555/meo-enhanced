import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createEditorHistoryApplication,
  type EditorHistoryContext,
  type EditorHistoryEffect
} from '../webview/src/application/editorHistory';

const effectTypes = (effects: readonly EditorHistoryEffect[]): string[] => effects.map((effect) => effect.type);

const sourceContext: EditorHistoryContext = {
  mode: 'source',
  viewport: {
    scrollTop: 120,
    selection: { lineNumber: 12, visibleFromLineNumber: 10, visibleToLineNumber: 30, wasVisible: true }
  }
};

const source = createEditorHistoryApplication();
const undoEffects = source.dispatch({ type: 'requestReplay', direction: 'undo', context: sourceContext });
assert.deepEqual(effectTypes(undoEffects), ['commitTransientEdits', 'runNativeHistory']);
const undoId = source.getState().pendingReplay?.id;
assert.ok(undoId);
assert.deepEqual(undoEffects[1], { type: 'runNativeHistory', replayId: undoId, direction: 'undo' });

const sourceRestore = source.dispatch({
  type: 'nativeHistoryCompleted',
  replayId: undoId,
  applied: true,
  changedRange: { from: 16, to: 16 }
});
assert.deepEqual(effectTypes(sourceRestore), ['restoreHistoryInteraction']);
assert.deepEqual(sourceRestore[0], {
  type: 'restoreHistoryInteraction',
  replayId: undoId,
  direction: 'undo',
  targetPosition: 16,
  changedRange: { from: 16, to: 16 },
  interactionTarget: null,
  preferredBlockMode: null,
  previousViewport: sourceContext.viewport
});
assert.equal(source.getState().pendingReplay?.phase, 'restoring');
source.dispatch({ type: 'interactionRestored', replayId: undoId });
assert.equal(source.getState().pendingReplay, null);

const liveContext: EditorHistoryContext = {
  mode: 'live',
  viewport: {
    scrollTop: 240,
    selection: { lineNumber: 20, visibleFromLineNumber: 18, visibleToLineNumber: 38, wasVisible: true }
  },
  interactionTarget: { kind: 'rendered-block', owner: 'generic', mode: 'split' }
};
const live = createEditorHistoryApplication();
live.dispatch({ type: 'requestReplay', direction: 'redo', context: liveContext });
const redoId = live.getState().pendingReplay?.id;
assert.ok(redoId);
assert.deepEqual(live.dispatch({
  type: 'nativeHistoryCompleted',
  replayId: redoId,
  applied: true,
  changedRange: { from: 16, to: 24 }
}), [{
  type: 'restoreHistoryInteraction',
  replayId: redoId,
  direction: 'redo',
  targetPosition: 24,
  changedRange: { from: 16, to: 24 },
  interactionTarget: liveContext.interactionTarget,
  preferredBlockMode: 'split',
  previousViewport: liveContext.viewport
}]);

const boundaries: NonNullable<EditorHistoryContext['interactionTarget']>[] = [
  { kind: 'table-boundary' },
  { kind: 'rendered-block', owner: 'mermaid-boundary', mode: 'preview' },
  { kind: 'rendered-block', owner: 'latex-boundary', mode: 'split' }
];
for (const interactionTarget of boundaries) {
  const application = createEditorHistoryApplication();
  application.dispatch({ type: 'requestReplay', direction: 'undo', context: { ...liveContext, interactionTarget } });
  const replayId = application.getState().pendingReplay?.id;
  assert.ok(replayId);
  const effects = application.dispatch({
    type: 'nativeHistoryCompleted', replayId, applied: true, changedRange: { from: 8, to: 10 }
  });
  assert.equal(effects[0]?.type, 'restoreHistoryInteraction');
  assert.equal(
    effects[0]?.type === 'restoreHistoryInteraction' ? effects[0].preferredBlockMode : null,
    interactionTarget.kind === 'rendered-block' ? interactionTarget.mode : null
  );
  assert.deepEqual(
    effects[0]?.type === 'restoreHistoryInteraction' ? effects[0].interactionTarget : null,
    interactionTarget
  );
}

const rapid = createEditorHistoryApplication();
rapid.dispatch({ type: 'requestReplay', direction: 'undo', context: sourceContext });
const staleId = rapid.getState().pendingReplay?.id;
const secondRequest = rapid.dispatch({ type: 'requestReplay', direction: 'undo', context: sourceContext });
const currentId = rapid.getState().pendingReplay?.id;
assert.ok(staleId && currentId && staleId !== currentId);
assert.deepEqual(effectTypes(secondRequest), ['cancelPendingRestore', 'commitTransientEdits', 'runNativeHistory']);
assert.deepEqual(rapid.dispatch({
  type: 'nativeHistoryCompleted', replayId: staleId, applied: true, changedRange: { from: 1, to: 2 }
}), []);
assert.deepEqual(effectTypes(rapid.dispatch({
  type: 'nativeHistoryCompleted', replayId: currentId, applied: false, changedRange: null
})), []);
assert.equal(rapid.getState().pendingReplay, null, 'history boundary must not leave a pending restore');

const modeContinuity = createEditorHistoryApplication();
modeContinuity.dispatch({ type: 'requestReplay', direction: 'undo', context: liveContext });
assert.deepEqual(effectTypes(modeContinuity.dispatch({ type: 'presentationChanged' })), ['cancelPendingRestore']);
assert.equal(modeContinuity.getState().pendingReplay, null);
const afterModeSwitch = modeContinuity.dispatch({
  type: 'requestReplay', direction: 'redo', context: { ...sourceContext, mode: 'source' }
});
assert.deepEqual(effectTypes(afterModeSwitch), ['commitTransientEdits', 'runNativeHistory']);

const externalPresentation = createEditorHistoryApplication();
externalPresentation.dispatch({ type: 'requestReplay', direction: 'undo', context: liveContext });
assert.deepEqual(
  effectTypes(externalPresentation.dispatch({ type: 'externalDocumentPresented' })),
  ['cancelPendingRestore']
);
assert.equal(externalPresentation.getState().pendingReplay, null);
assert.deepEqual(
  effectTypes(externalPresentation.dispatch({ type: 'requestReplay', direction: 'redo', context: sourceContext })),
  ['commitTransientEdits', 'runNativeHistory'],
  'external Document presentation must not become or clear the native UI history stack'
);

const localEdit = createEditorHistoryApplication();
localEdit.dispatch({ type: 'requestReplay', direction: 'undo', context: liveContext });
assert.deepEqual(effectTypes(localEdit.dispatch({ type: 'localDocumentEdited' })), ['cancelPendingRestore']);
assert.equal(localEdit.getState().pendingReplay, null);

const disposed = createEditorHistoryApplication();
disposed.dispatch({ type: 'requestReplay', direction: 'undo', context: sourceContext });
assert.deepEqual(effectTypes(disposed.dispatch({ type: 'dispose' })), ['cancelPendingRestore', 'disposeHistory']);
assert.equal(disposed.getState().lifecycle, 'disposed');
assert.deepEqual(disposed.dispatch({ type: 'requestReplay', direction: 'redo', context: sourceContext }), []);

const productionIndex = readFileSync(new URL('../webview/src/index.ts', import.meta.url), 'utf8');
const productionEditor = readFileSync(new URL('../webview/src/editor.ts', import.meta.url), 'utf8');
assert.equal(productionIndex.includes('createEditorHistoryApplication'), false, 'candidate slices must not wire Bootstrap');
assert.equal(productionEditor.includes('createEditorHistoryApplication'), true, 'production Editor must wire History Application');

console.log('Editor history application checks passed');
