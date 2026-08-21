import assert from 'node:assert/strict';
import {
  createImagePresentationApplication,
  type ImagePresentationEffect
} from '../webview/src/application/imagePresentation';

const types = (effects: readonly ImagePresentationEffect[]) => effects.map((effect) => effect.type);

const successful = createImagePresentationApplication();
const requested = successful.dispatch({ type: 'present', sourceKey: 'image-a', rawSrc: './a.png' });
assert.deepEqual(types(requested), ['showFallback', 'resolveSource']);
const firstId = successful.getState().presentationId;
assert.ok(firstId);
assert.deepEqual(
  successful.dispatch({ type: 'sourceResolved', presentationId: firstId, resolvedSrc: 'resolved:a' }),
  [{ type: 'loadImage', presentationId: firstId, resolvedSrc: 'resolved:a' }]
);
assert.deepEqual(
  successful.dispatch({ type: 'imageLoaded', presentationId: firstId }),
  [{ type: 'showImage', presentationId: firstId, resolvedSrc: 'resolved:a' }]
);
assert.deepEqual(successful.getState(), {
  phase: 'ready',
  presentationId: firstId,
  sourceKey: 'image-a'
});

const failed = createImagePresentationApplication();
failed.dispatch({ type: 'present', sourceKey: 'missing', rawSrc: './missing.png' });
const failedId = failed.getState().presentationId;
assert.ok(failedId);
assert.deepEqual(
  failed.dispatch({ type: 'sourceFailed', presentationId: failedId }),
  [{ type: 'showFallback', presentationId: failedId, sourceKey: 'missing' }]
);
assert.equal(failed.getState().phase, 'fallback');

const loadFailed = createImagePresentationApplication();
loadFailed.dispatch({ type: 'present', sourceKey: 'broken', rawSrc: './broken.png' });
const loadFailedId = loadFailed.getState().presentationId;
assert.ok(loadFailedId);
loadFailed.dispatch({ type: 'sourceResolved', presentationId: loadFailedId, resolvedSrc: 'resolved:broken' });
assert.deepEqual(
  loadFailed.dispatch({ type: 'imageFailed', presentationId: loadFailedId }),
  [{ type: 'showFallback', presentationId: loadFailedId, sourceKey: 'broken' }]
);

const replaced = createImagePresentationApplication();
replaced.dispatch({ type: 'present', sourceKey: 'old', rawSrc: './old.png' });
const oldId = replaced.getState().presentationId;
assert.ok(oldId);
const replacementEffects = replaced.dispatch({ type: 'present', sourceKey: 'new', rawSrc: './new.png' });
const newId = replaced.getState().presentationId;
assert.ok(newId && newId !== oldId);
assert.deepEqual(types(replacementEffects), ['showFallback', 'resolveSource']);
assert.deepEqual(replaced.dispatch({ type: 'sourceResolved', presentationId: oldId, resolvedSrc: 'resolved:old' }), []);
replaced.dispatch({ type: 'sourceResolved', presentationId: newId, resolvedSrc: 'resolved:new' });
assert.deepEqual(replaced.dispatch({ type: 'imageLoaded', presentationId: oldId }), []);
assert.equal(replaced.getState().phase, 'loading');

const invalidated = createImagePresentationApplication();
invalidated.dispatch({ type: 'present', sourceKey: 'external', rawSrc: './external.png' });
const invalidatedId = invalidated.getState().presentationId;
assert.ok(invalidatedId);
assert.deepEqual(
  types(invalidated.dispatch({ type: 'externalDocumentPresented' })),
  ['showFallback', 'resolveSource'],
  'external presentation must re-correlate the current handle through the Application owner'
);
const externalReplayId = invalidated.getState().presentationId;
assert.ok(externalReplayId && externalReplayId !== invalidatedId);
assert.deepEqual(invalidated.dispatch({
  type: 'sourceResolved', presentationId: invalidatedId, resolvedSrc: 'resolved:external'
}), []);
assert.deepEqual(invalidated.dispatch({
  type: 'sourceResolved', presentationId: externalReplayId, resolvedSrc: 'resolved:current'
}), [{ type: 'loadImage', presentationId: externalReplayId, resolvedSrc: 'resolved:current' }]);
assert.deepEqual(invalidated.dispatch({
  type: 'imageLoaded', presentationId: externalReplayId
}), [{ type: 'showImage', presentationId: externalReplayId, resolvedSrc: 'resolved:current' }]);

const retryAfterExternal = createImagePresentationApplication();
retryAfterExternal.dispatch({ type: 'present', sourceKey: 'retry', rawSrc: './retry.png' });
const failedBeforeExternal = retryAfterExternal.getState().presentationId;
assert.ok(failedBeforeExternal);
retryAfterExternal.dispatch({ type: 'sourceFailed', presentationId: failedBeforeExternal });
const retryEffects = retryAfterExternal.dispatch({ type: 'externalDocumentPresented' });
const retriedAfterExternal = retryAfterExternal.getState().presentationId;
assert.ok(retriedAfterExternal && retriedAfterExternal !== failedBeforeExternal);
assert.deepEqual(types(retryEffects), ['showFallback', 'resolveSource']);

const disposed = createImagePresentationApplication();
disposed.dispatch({ type: 'present', sourceKey: 'disposed', rawSrc: './disposed.png' });
const disposedId = disposed.getState().presentationId;
assert.ok(disposedId);
assert.deepEqual(types(disposed.dispatch({ type: 'dispose' })), []);
assert.deepEqual(disposed.getState(), { phase: 'disposed', presentationId: null, sourceKey: null });
assert.deepEqual(disposed.dispatch({ type: 'imageLoaded', presentationId: disposedId }), []);
assert.deepEqual(disposed.dispatch({ type: 'present', sourceKey: 'late', rawSrc: './late.png' }), []);

console.log('image presentation application contracts passed');
