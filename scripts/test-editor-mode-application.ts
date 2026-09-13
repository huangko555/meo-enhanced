import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createEditorModeApplication,
  type EditorModeEffect,
  type EditorModeViewportToken
} from '../webview/src/application/editorMode';

const effectTypes = (effects: readonly EditorModeEffect[]): string[] => effects.map((effect) => effect.type);
const viewport = Object.freeze({}) as EditorModeViewportToken;
const previewViewport = Object.freeze({}) as EditorModeViewportToken;
type ModeApplication = ReturnType<typeof createEditorModeApplication>;
const pendingMountId = (application: ModeApplication): number => {
  const mountId = application.getState().pendingMount?.id;
  assert.ok(mountId);
  return mountId;
};
const mountEditor = (application: ModeApplication): readonly EditorModeEffect[] => {
  const mountId = pendingMountId(application);
  application.dispatch({ type: 'editorMountStarted', mountId });
  return application.dispatch({ type: 'editorMountSucceeded', mountId });
};

const hostInit = createEditorModeApplication();
assert.deepEqual(hostInit.getState(), {
  lifecycle: 'awaiting-init', mode: 'live', requestedMode: 'live',
  lastEditableMode: 'live', hasLocalPreference: false, intentId: 0, manualIntent: null,
  editorMount: 'unmounted', pendingMount: null, mountRecoveryAttempted: false, pendingTransition: null
});
const hostInitEffects = hostInit.dispatch({ type: 'initialize', hostMode: 'source' });
assert.deepEqual(effectTypes(hostInitEffects), ['scheduleEditorMount', 'commitTransientEdits', 'presentMode']);
assert.deepEqual(hostInitEffects[0], { type: 'scheduleEditorMount', mountId: 1, mode: 'source' });
assert.equal(hostInit.getState().mode, 'source');
assert.equal(hostInitEffects.some((effect) => effect.type === 'postMode'), false, 'Host Init must not echo mode');
assert.deepEqual(
  effectTypes(hostInit.dispatch({ type: 'requestMode', mode: 'source', source: 'user' })),
  [],
  'manual adoption of pending Host Init must reuse the pending mount transaction'
);
const adoptedHostInitManualId = hostInit.getState().manualIntent?.id;
assert.ok(adoptedHostInitManualId);
assert.deepEqual(
  effectTypes(mountEditor(hostInit)),
  ['persistMode', 'postMode'],
  'the adopted Host Init must settle manual policy only after mount success'
);
assert.deepEqual(
  hostInit.dispatch({ type: 'requestMode', mode: 'source', source: 'user' }),
  [],
  'stable same-mode manual requests must be idempotent'
);
assert.equal(hostInit.getState().manualIntent?.id, adoptedHostInitManualId);

const localInit = createEditorModeApplication();
localInit.dispatch({ type: 'restoreLocal', mode: 'preview', lastEditableMode: 'source' });
const localInitEffects = localInit.dispatch({ type: 'initialize', hostMode: 'live' });
assert.equal(localInit.getState().mode, 'preview');
assert.equal(localInit.getState().lastEditableMode, 'source');
assert.deepEqual(effectTypes(localInitEffects), [
  'scheduleEditorMount', 'commitTransientEdits', 'presentMode'
]);
assert.deepEqual(localInitEffects[0], { type: 'scheduleEditorMount', mountId: 1, mode: 'source' });
assert.deepEqual(
  localInit.dispatch({ type: 'requestMode', mode: 'preview', source: 'host-command' }),
  [],
  'manual adoption of pending local restore must not duplicate its existing persist/post effects'
);
assert.ok(localInit.getState().manualIntent?.id);

assert.deepEqual(
  effectTypes(mountEditor(localInit)),
  ['persistMode', 'postMode'],
  'pending local restore policy must settle exactly once after mount success'
);
const leavePreview = localInit.dispatch({
  type: 'toggleMode', source: 'host-command',
  viewport: previewViewport, restoreEditorFocus: true
});
assert.equal(localInit.getState().mode, 'source', 'Preview toggle must restore lastEditableMode');
assert.deepEqual(effectTypes(leavePreview), ['commitTransientEdits', 'presentMode', 'applyEditorMode']);
const leavePresentation = leavePreview.find((effect) => effect.type === 'presentMode');
assert.deepEqual(leavePresentation?.type === 'presentMode' ? leavePresentation.presentation : null, {
  mode: 'source', previousMode: 'preview', closeFind: true, previewActive: false, editorVisible: true,
  searchOwner: 'editor', outlineOwner: 'editor', replaceEnabled: true, hideSelectionMenu: false,
  viewport: previewViewport, restoreEditorFocus: true, atomicEditorReveal: true
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
assert.equal(
  previewPresentation?.type === 'presentMode' ? previewPresentation.presentation.atomicEditorReveal : null,
  false
);
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

const atomicReveal = createEditorModeApplication();
atomicReveal.dispatch({ type: 'initialize', hostMode: 'live' });
mountEditor(atomicReveal);
atomicReveal.dispatch({ type: 'requestMode', mode: 'preview', source: 'user', viewport });
const liveAfterPreview = atomicReveal.dispatch({
  type: 'requestMode', mode: 'live', source: 'user', viewport, restoreEditorFocus: true
});
const liveAfterPreviewPresentation = liveAfterPreview.find((effect) => effect.type === 'presentMode');
assert.equal(
  liveAfterPreviewPresentation?.type === 'presentMode'
    ? liveAfterPreviewPresentation.presentation.atomicEditorReveal
    : null,
  true,
  'Preview→Live must keep Preview as a bounded cover while visible Live images become ready'
);

const fallback = createEditorModeApplication();
fallback.dispatch({ type: 'initialize', hostMode: 'source' });
mountEditor(fallback);
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
mountEditor(rollback);
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
mountEditor(rapid);
rapid.dispatch({ type: 'requestMode', mode: 'live', source: 'user' });
const staleId = rapid.getState().pendingTransition?.id;
rapid.dispatch({ type: 'requestMode', mode: 'source', source: 'user' });
const currentId = rapid.getState().pendingTransition?.id;
assert.ok(staleId && currentId && staleId !== currentId);
assert.deepEqual(rapid.dispatch({ type: 'editorModeApplied', transitionId: staleId }), []);
assert.deepEqual(effectTypes(rapid.dispatch({ type: 'editorModeApplied', transitionId: currentId })), [
  'persistMode', 'postMode'
]);

const manualMountIntent = createEditorModeApplication();
const initialLiveMount = manualMountIntent.dispatch({ type: 'initialize', hostMode: 'live' });
const initialLiveMountEffect = initialLiveMount.find((effect) => effect.type === 'scheduleEditorMount');
assert.ok(initialLiveMountEffect?.type === 'scheduleEditorMount');
assert.equal(
  initialLiveMount.some((effect) => effect.type === 'scheduleEditorMount' && effect.mode === 'live'),
  true
);
manualMountIntent.dispatch({ type: 'editorMountStarted', mountId: initialLiveMountEffect.mountId });
const manualSourceWhileMounting = manualMountIntent.dispatch({
  type: 'requestMode', mode: 'source', source: 'user'
});
assert.equal(
  manualSourceWhileMounting.some(
    (effect) => effect.type === 'scheduleEditorMount' && effect.mode === 'source'
  ),
  true,
  'a manual Source intent must replace an older pending Live mount before createEditor runs'
);
manualMountIntent.dispatch({ type: 'editorMountSucceeded', mountId: initialLiveMountEffect.mountId });
assert.notEqual(
  manualMountIntent.getState().editorMount,
  'mounted',
  'the superseded Live mount completion must not claim the latest Source mount'
);

const manualBeatsAutomatic = createEditorModeApplication();
manualBeatsAutomatic.dispatch({ type: 'initialize', hostMode: 'source' });
mountEditor(manualBeatsAutomatic);
manualBeatsAutomatic.dispatch({ type: 'requestMode', mode: 'live', source: 'user' });
const manualLiveId = manualBeatsAutomatic.getState().pendingTransition?.id;
assert.ok(manualLiveId);
manualBeatsAutomatic.dispatch({ type: 'editorModeApplied', transitionId: manualLiveId });
const staleAutomatic = manualBeatsAutomatic.dispatch({
  type: 'requestMode',
  mode: 'source',
  source: 'render-failure',
  basisManualIntentId: 0
});
assert.deepEqual(
  staleAutomatic,
  [],
  'an automatic fallback based on an older intent must not override the latest manual Live choice'
);
assert.equal(manualBeatsAutomatic.getState().mode, 'live');

assert.deepEqual(
  manualBeatsAutomatic.dispatch({ type: 'requestMode', mode: 'live', source: 'user' }),
  [],
  'requesting the already active manual mode must be idempotent'
);
const currentManualIntentId = manualBeatsAutomatic.getState().manualIntent?.id;
assert.ok(currentManualIntentId);
assert.deepEqual(effectTypes(manualBeatsAutomatic.dispatch({
  type: 'requestMode',
  mode: 'source',
  source: 'render-failure',
  basisManualIntentId: currentManualIntentId
})), ['commitTransientEdits', 'presentMode', 'applyEditorMode']);
const automaticSourceId = manualBeatsAutomatic.getState().pendingTransition?.id;
assert.ok(automaticSourceId);
const automaticManualIntentId = manualBeatsAutomatic.getState().manualIntent?.id;
assert.ok(automaticManualIntentId);
assert.deepEqual(
  manualBeatsAutomatic.dispatch({ type: 'requestMode', mode: 'source', source: 'user' }),
  [],
  'manual adoption must reuse the pending same-target concrete transition'
);
assert.ok(
  (manualBeatsAutomatic.getState().manualIntent?.id ?? 0) > automaticManualIntentId,
  'manual adoption must establish a fresh manual correlation'
);
assert.deepEqual(
  effectTypes(manualBeatsAutomatic.dispatch({
    type: 'editorModeApplied', transitionId: automaticSourceId
  })),
  ['persistMode', 'postMode'],
  'the adopted automatic transition must settle with manual persistence policy'
);

const adoptedFailure = createEditorModeApplication();
adoptedFailure.dispatch({ type: 'initialize', hostMode: 'live' });
mountEditor(adoptedFailure);
adoptedFailure.dispatch({
  type: 'requestMode', mode: 'source', source: 'render-failure', basisManualIntentId: 0
});
const adoptedFailureId = adoptedFailure.getState().pendingTransition?.id;
assert.ok(adoptedFailureId);
adoptedFailure.dispatch({ type: 'requestMode', mode: 'source', source: 'user' });
assert.deepEqual(effectTypes(adoptedFailure.dispatch({
  type: 'editorModeFailed', transitionId: adoptedFailureId, failure: 'fatal'
})), ['showNotice', 'rollbackPresentation']);
assert.equal(adoptedFailure.getState().mode, 'live', 'adopted transition failure must still roll back');
const manualIdBeforeReadoption = adoptedFailure.getState().manualIntent?.id;
assert.ok(manualIdBeforeReadoption);
adoptedFailure.dispatch({
  type: 'requestMode',
  mode: 'source',
  source: 'render-failure',
  basisManualIntentId: manualIdBeforeReadoption
});
const readoptedFailureId = adoptedFailure.getState().pendingTransition?.id;
assert.ok(readoptedFailureId);
adoptedFailure.dispatch({ type: 'requestMode', mode: 'source', source: 'user' });
assert.ok(
  (adoptedFailure.getState().manualIntent?.id ?? 0) > manualIdBeforeReadoption,
  'a new automatic transaction must be readopted even when the prior manual mode has the same value'
);
assert.deepEqual(effectTypes(adoptedFailure.dispatch({
  type: 'editorModeApplied', transitionId: readoptedFailureId
})), ['persistMode', 'postMode']);

const adoptedThenReplaced = createEditorModeApplication();
adoptedThenReplaced.dispatch({ type: 'initialize', hostMode: 'live' });
mountEditor(adoptedThenReplaced);
adoptedThenReplaced.dispatch({
  type: 'requestMode', mode: 'source', source: 'render-failure', basisManualIntentId: 0
});
const adoptedThenStaleId = adoptedThenReplaced.getState().pendingTransition?.id;
assert.ok(adoptedThenStaleId);
adoptedThenReplaced.dispatch({ type: 'requestMode', mode: 'source', source: 'user' });
adoptedThenReplaced.dispatch({ type: 'requestMode', mode: 'live', source: 'user' });
const adoptedThenCurrentId = adoptedThenReplaced.getState().pendingTransition?.id;
assert.ok(adoptedThenCurrentId && adoptedThenCurrentId !== adoptedThenStaleId);
assert.deepEqual(
  adoptedThenReplaced.dispatch({ type: 'editorModeApplied', transitionId: adoptedThenStaleId }),
  [],
  'a rapid different manual mode must invalidate the adopted transition completion'
);
assert.deepEqual(effectTypes(adoptedThenReplaced.dispatch({
  type: 'editorModeApplied', transitionId: adoptedThenCurrentId
})), ['persistMode', 'postMode']);

const isolatedSource = createEditorModeApplication();
const isolatedLive = createEditorModeApplication();
isolatedSource.dispatch({ type: 'initialize', hostMode: 'source' });
isolatedLive.dispatch({ type: 'initialize', hostMode: 'live' });
isolatedSource.dispatch({ type: 'requestMode', mode: 'live', source: 'user' });
assert.equal(isolatedSource.getState().requestedMode, 'live');
assert.equal(isolatedLive.getState().requestedMode, 'live');
assert.equal(isolatedLive.getState().manualIntent, null, 'manual intent must remain isolated per Editor');

const mountRetry = createEditorModeApplication();
mountRetry.dispatch({ type: 'initialize', hostMode: 'live' });
let mountRetryId = pendingMountId(mountRetry);
mountRetry.dispatch({ type: 'editorMountStarted', mountId: mountRetryId });
assert.deepEqual(effectTypes(mountRetry.dispatch({
  type: 'editorMountFailed', mountId: mountRetryId, failure: 'transient-live'
})), ['showNotice', 'scheduleEditorMount']);
mountRetryId = pendingMountId(mountRetry);
mountRetry.dispatch({ type: 'editorMountStarted', mountId: mountRetryId });
const exhaustedMountEffects = mountRetry.dispatch({
  type: 'editorMountFailed', mountId: mountRetryId, failure: 'transient-live'
});
assert.deepEqual(effectTypes(exhaustedMountEffects), ['showNotice']);
assert.deepEqual(exhaustedMountEffects[0], { type: 'showNotice', notice: 'mount-failure' });
assert.equal(mountRetry.getState().editorMount, 'unmounted', 'mount retry must be bounded');

const mountFallback = createEditorModeApplication();
mountFallback.dispatch({ type: 'initialize', hostMode: 'live' });
const mountFallbackId = pendingMountId(mountFallback);
mountFallback.dispatch({ type: 'editorMountStarted', mountId: mountFallbackId });
assert.deepEqual(effectTypes(mountFallback.dispatch({
  type: 'editorMountFailed', mountId: mountFallbackId, failure: 'live-incompatible'
})), ['showNotice', 'scheduleEditorMount', 'commitTransientEdits', 'presentMode']);
assert.equal(mountFallback.getState().mode, 'source');
assert.equal(mountFallback.getState().lastEditableMode, 'source');
assert.deepEqual(
  mountFallback.dispatch({ type: 'requestMode', mode: 'source', source: 'user' }),
  [],
  'manual Source must adopt the pending automatic fallback mount without early settlement'
);
assert.deepEqual(
  effectTypes(mountEditor(mountFallback)),
  ['persistMode', 'postMode'],
  'adopted fallback mount must persist before posting at its success boundary'
);

const disposed = createEditorModeApplication();
disposed.dispatch({ type: 'initialize', hostMode: 'live' });
assert.deepEqual(effectTypes(disposed.dispatch({ type: 'dispose' })), ['disposeMode']);
assert.equal(disposed.getState().lifecycle, 'disposed');
assert.deepEqual(disposed.dispatch({ type: 'requestMode', mode: 'preview', source: 'user' }), []);
assert.deepEqual(disposed.dispatch({ type: 'editorMountStarted', mountId: 1 }), []);

const productionBootstrap = readFileSync(new URL('../webview/src/index.ts', import.meta.url), 'utf8');
assert.equal(
  (productionBootstrap.match(/const editorModeApplication = createEditorModeApplication\(\)/g) ?? []).length,
  1,
  'production must create exactly one Editor Mode Application owner'
);

console.log('Editor Mode application checks passed');
