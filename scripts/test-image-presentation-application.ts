import assert from 'node:assert/strict';
import {
  createImagePresentationApplication,
  type ImagePresentationEffect
} from '../webview/src/application/imagePresentation';

const types = (effects: readonly ImagePresentationEffect[]) => effects.map((effect) => effect.type);

const successful = createImagePresentationApplication();
const requested = successful.dispatch({ type: 'present', sourceKey: 'image-a', rawSrc: './a.png' });
assert.deepEqual(types(requested), ['resolveSource']);
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
assert.deepEqual(types(replacementEffects), ['cancelPresentation', 'resolveSource']);
assert.deepEqual(replaced.dispatch({ type: 'sourceResolved', presentationId: oldId, resolvedSrc: 'resolved:old' }), []);
replaced.dispatch({ type: 'sourceResolved', presentationId: newId, resolvedSrc: 'resolved:new' });
assert.deepEqual(replaced.dispatch({ type: 'imageLoaded', presentationId: oldId }), []);
assert.equal(replaced.getState().phase, 'loading');

const invalidated = createImagePresentationApplication();
invalidated.dispatch({ type: 'present', sourceKey: 'external', rawSrc: './external.png' });
const invalidatedId = invalidated.getState().presentationId;
assert.ok(invalidatedId);
assert.deepEqual(types(invalidated.dispatch({ type: 'externalDocumentPresented' })), ['cancelPresentation']);
assert.deepEqual(invalidated.getState(), { phase: 'idle', presentationId: null, sourceKey: null });
assert.deepEqual(invalidated.dispatch({
  type: 'sourceResolved', presentationId: invalidatedId, resolvedSrc: 'resolved:external'
}), []);

const disposed = createImagePresentationApplication();
disposed.dispatch({ type: 'present', sourceKey: 'disposed', rawSrc: './disposed.png' });
const disposedId = disposed.getState().presentationId;
assert.ok(disposedId);
assert.deepEqual(types(disposed.dispatch({ type: 'dispose' })), ['cancelPresentation']);
assert.deepEqual(disposed.getState(), { phase: 'disposed', presentationId: null, sourceKey: null });
assert.deepEqual(disposed.dispatch({ type: 'imageLoaded', presentationId: disposedId }), []);
assert.deepEqual(disposed.dispatch({ type: 'present', sourceKey: 'late', rawSrc: './late.png' }), []);

console.log('image presentation application contracts passed');
