import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createEditorModeApplication,
  type EditorModeEffect,
  type EditorModeViewport
} from '../webview/src/application/editorMode';

const effectTypes = (effects: readonly EditorModeEffect[]): string[] => effects.map((effect) => effect.type);
const viewport: EditorModeViewport = { owner: 'editor', topLine: 42, topLineOffset: 0.25 };

const hostInit = createEditorModeApplication();
assert.deepEqual(hostInit.getState(), {
  lifecycle: 'awaiting-init', mode: 'live', lastEditableMode: 'live', hasLocalPreference: false,
  editorMount: 'unmounted', mountRecoveryAttempted: false, pendingTransition: null
});
const hostInitEffects = hostInit.dispatch({ type: 'initialize', hostMode: 'source' });
assert.deepEqual(effectTypes(hostInitEffects), ['scheduleEditorMount', 'commitTransientEdits', 'presentMode']);
assert.deepEqual(hostInitEffects[0], { type: 'scheduleEditorMount', mode: 'source' });
assert.equal(hostInit.getState().mode, 'source');
assert.equal(hostInitEffects.some((effect) => effect.type === 'postMode'), false, 'Host Init must not echo mode');

const localInit = createEditorModeApplication();
localInit.dispatch({ type: 'restoreLocal', mode: 'preview', lastEditableMode: 'source' });
const localInitEffects = localInit.dispatch({ type: 'initialize', hostMode: 'live' });
assert.equal(localInit.getState().mode, 'preview');
assert.equal(localInit.getState().lastEditableMode, 'source');
assert.deepEqual(effectTypes(localInitEffects), [
  'scheduleEditorMount', 'commitTransientEdits', 'presentMode', 'persistMode', 'postMode'
]);
assert.deepEqual(localInitEffects[0], { type: 'scheduleEditorMount', mode: 'source' });

localInit.dispatch({ type: 'editorMountStarted' });
localInit.dispatch({ type: 'editorMountSucceeded' });
const leavePreview = localInit.dispatch({
  type: 'toggleMode', source: 'host-command',
  viewport: { owner: 'preview', topLine: 70, topLineOffset: 0 }, restoreEditorFocus: true
});
assert.equal(localInit.getState().mode, 'source', 'Preview toggle must restore lastEditableMode');
assert.deepEqual(effectTypes(leavePreview), ['commitTransientEdits', 'presentMode', 'applyEditorMode']);
const leavePresentation = leavePreview.find((effect) => effect.type === 'presentMode');
assert.deepEqual(leavePresentation?.type === 'presentMode' ? leavePresentation.presentation : null, {
  mode: 'source', previousMode: 'preview', closeFind: true, previewActive: false, editorVisible: true,
  searchOwner: 'editor', outlineOwner: 'editor', replaceEnabled: true, hideSelectionMenu: false,
  viewport: { owner: 'preview', topLine: 70, topLineOffset: 0 }, restoreEditorFocus: true
});
const leaveId = localInit.getState().pendingTransition?.id;
assert.ok(leaveId);
assert.deepEqual(effectTypes(localInit.dispatch({ type: 'editorModeApplied', transitionId: leaveId })), [
  'persistMode', 'postMode'
]);

const toLive = localInit.dispatch({ type: 'requestMode', mode: 'live', source: 'user', viewport });
const toLiveId = localInit.getState().pendingTransition?.id;
assert.ok(toLiveId);
assert.deepEqual(effectTypes(toLive), ['commitTransientEdits', 'presentMode', 'applyEditorMode']);
assert.deepEqual(effectTypes(localInit.dispatch({ type: 'editorModeApplied', transitionId: toLiveId })), [
  'persistMode', 'postMode'
]);
assert.equal(localInit.getState().lastEditableMode, 'live');

const previewEffects = localInit.dispatch({
  type: 'requestMode', mode: 'preview', source: 'user', viewport, restoreEditorFocus: true
});
assert.deepEqual(effectTypes(previewEffects), ['commitTransientEdits', 'presentMode', 'persistMode', 'postMode']);
const previewPresentation = previewEffects.find((effect) => effect.type === 'presentMode');
assert.equal(previewPresentation?.type === 'presentMode' && previewPresentation.presentation.searchOwner, 'preview');
assert.equal(previewPresentation?.type === 'presentMode' && previewPresentation.presentation.outlineOwner, 'preview');
assert.equal(previewPresentation?.type === 'presentMode' && previewPresentation.presentation.hideSelectionMenu, true);
assert.equal(previewPresentation?.type === 'presentMode' && previewPresentation.presentation.replaceEnabled, false);
assert.equal(localInit.getState().lastEditableMode, 'live', 'Preview must retain the latest editable mode');
const returnFromPreview = localInit.dispatch({
  type: 'requestMode', mode: 'source', source: 'user', viewport, restoreEditorFocus: false
});
const returnPresentation = returnFromPreview.find((effect) => effect.type === 'presentMode');
assert.equal(
  returnPresentation?.type === 'presentMode' && returnPresentation.presentation.restoreEditorFocus,
  true,
  'Preview exit must restore the focus intent captured before Preview blurred the editor'
);

const fallback = createEditorModeApplication();
fallback.dispatch({ type: 'initialize', hostMode: 'source' });
fallback.dispatch({ type: 'editorMountStarted' });
fallback.dispatch({ type: 'editorMountSucceeded' });
assert.deepEqual(effectTypes(fallback.dispatch({ type: 'requestMode', mode: 'live', source: 'user', viewport })), [
  'commitTransientEdits', 'presentMode', 'applyEditorMode'
]);
const liveId = fallback.getState().pendingTransition?.id;
assert.ok(liveId);
assert.deepEqual(effectTypes(fallback.dispatch({
  type: 'editorModeFailed', transitionId: liveId, failure: 'live-incompatible'
})), ['showNotice', 'applyEditorMode']);
assert.equal(fallback.getState().pendingTransition?.fallbackToSource, true);
assert.deepEqual(effectTypes(fallback.dispatch({ type: 'editorModeApplied', transitionId: liveId })), [
  'presentMode', 'postMode'
]);
assert.equal(fallback.getState().mode, 'source');
assert.equal(fallback.getState().lastEditableMode, 'live', 'Legacy fallback keeps attempted Live as last editable');

const rollback = createEditorModeApplication();
rollback.dispatch({ type: 'initialize', hostMode: 'source' });
rollback.dispatch({ type: 'editorMountStarted' });
rollback.dispatch({ type: 'editorMountSucceeded' });
rollback.dispatch({ type: 'requestMode', mode: 'live', source: 'user' });
const rollbackId = rollback.getState().pendingTransition?.id;
assert.ok(rollbackId);
assert.deepEqual(effectTypes(rollback.dispatch({
  type: 'editorModeFailed', transitionId: rollbackId, failure: 'transient-live'
})), ['showNotice', 'rollbackPresentation']);
assert.equal(rollback.getState().mode, 'source');
assert.equal(rollback.getState().lastEditableMode, 'live', 'rollback preserves Legacy update ordering');

const rapid = createEditorModeApplication();
rapid.dispatch({ type: 'initialize', hostMode: 'source' });
rapid.dispatch({ type: 'editorMountStarted' });
rapid.dispatch({ type: 'editorMountSucceeded' });
rapid.dispatch({ type: 'requestMode', mode: 'live', source: 'user' });
const staleId = rapid.getState().pendingTransition?.id;
rapid.dispatch({ type: 'requestMode', mode: 'source', source: 'user' });
const currentId = rapid.getState().pendingTransition?.id;
assert.ok(staleId && currentId && staleId !== currentId);
assert.deepEqual(rapid.dispatch({ type: 'editorModeApplied', transitionId: staleId }), []);
assert.deepEqual(effectTypes(rapid.dispatch({ type: 'editorModeApplied', transitionId: currentId })), [
  'persistMode', 'postMode'
]);

const mountRetry = createEditorModeApplication();
mountRetry.dispatch({ type: 'initialize', hostMode: 'live' });
mountRetry.dispatch({ type: 'editorMountStarted' });
assert.deepEqual(effectTypes(mountRetry.dispatch({
  type: 'editorMountFailed', failure: 'transient-live'
})), ['showNotice', 'scheduleEditorMount']);
mountRetry.dispatch({ type: 'editorMountStarted' });
const exhaustedMountEffects = mountRetry.dispatch({
  type: 'editorMountFailed', failure: 'transient-live'
});
assert.deepEqual(effectTypes(exhaustedMountEffects), ['showNotice']);
assert.deepEqual(exhaustedMountEffects[0], { type: 'showNotice', notice: 'mount-failure' });
assert.equal(mountRetry.getState().editorMount, 'unmounted', 'mount retry must be bounded');

const mountFallback = createEditorModeApplication();
mountFallback.dispatch({ type: 'initialize', hostMode: 'live' });
mountFallback.dispatch({ type: 'editorMountStarted' });
assert.deepEqual(effectTypes(mountFallback.dispatch({
  type: 'editorMountFailed', failure: 'live-incompatible'
})), ['showNotice', 'commitTransientEdits', 'presentMode', 'postMode', 'scheduleEditorMount']);
assert.equal(mountFallback.getState().mode, 'source');
assert.equal(mountFallback.getState().lastEditableMode, 'source');

const disposed = createEditorModeApplication();
disposed.dispatch({ type: 'initialize', hostMode: 'live' });
assert.deepEqual(effectTypes(disposed.dispatch({ type: 'dispose' })), ['disposeMode']);
assert.equal(disposed.getState().lifecycle, 'disposed');
assert.deepEqual(disposed.dispatch({ type: 'requestMode', mode: 'preview', source: 'user' }), []);
assert.deepEqual(disposed.dispatch({ type: 'editorMountStarted' }), []);

const productionBootstrap = readFileSync(new URL('../webview/src/index.ts', import.meta.url), 'utf8');
assert.equal(
  (productionBootstrap.match(/const editorModeApplication = createEditorModeApplication\(\)/g) ?? []).length,
  1,
  'production must create exactly one Editor Mode Application owner'
);

console.log('Editor Mode application checks passed');
