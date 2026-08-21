import assert from 'node:assert/strict';
import {
  createImagePresentationApplication,
  type ImagePresentationApplication,
  type ImagePresentationEffect
} from '../webview/src/application/imagePresentation';

const types = (effects: readonly ImagePresentationEffect[]) => effects.map((effect) => effect.type);
const currentId = (application: ImagePresentationApplication): number => {
  const id = application.getState().current?.presentationId;
  assert.ok(id);
  return id;
};

const empty = createImagePresentationApplication();
assert.deepEqual(empty.getState(), {
  lifecycle: 'active',
  current: null,
  projected: { phase: 'none' }
});
assert.deepEqual(empty.dispatch({ type: 'externalDocumentPresented' }), []);
assert.deepEqual(empty.dispatch({ type: 'externalDocumentPresented' }), []);

const presentation = createImagePresentationApplication();
assert.deepEqual(
  types(presentation.dispatch({ type: 'present', sourceKey: 'image-a', rawSrc: './a.png' })),
  ['showFallback', 'resolveSource'],
  'a first presentation must synchronously avoid a blank projection'
);
const firstId = currentId(presentation);
assert.deepEqual(presentation.getState(), {
  lifecycle: 'active',
  current: {
    phase: 'resolving',
    presentationId: firstId,
    sourceKey: 'image-a',
    rawSrc: './a.png',
    resolvedSrc: null
  },
  projected: { phase: 'fallback', presentationId: firstId, sourceKey: 'image-a' }
});
assert.deepEqual(
  presentation.dispatch({
    type: 'sourceResolved',
    presentationId: firstId,
    resolvedSrc: 'resolved:a'
  }),
  [{ type: 'loadImage', presentationId: firstId, resolvedSrc: 'resolved:a' }]
);
assert.equal(presentation.getState().current?.phase, 'loading');
assert.equal(presentation.getState().projected.phase, 'fallback');
assert.deepEqual(
  presentation.dispatch({ type: 'imageLoaded', presentationId: firstId }),
  [{ type: 'showImage', presentationId: firstId, resolvedSrc: 'resolved:a' }]
);
const firstReadyProjection = presentation.getState().projected;
assert.deepEqual(firstReadyProjection, {
  phase: 'ready',
  presentationId: firstId,
  sourceKey: 'image-a',
  resolvedSrc: 'resolved:a'
});

const firstExternalEffects = presentation.dispatch({ type: 'externalDocumentPresented' });
const secondId = currentId(presentation);
assert.notEqual(secondId, firstId);
assert.deepEqual(types(firstExternalEffects), ['resolveSource']);
assert.deepEqual(
  presentation.getState().projected,
  firstReadyProjection,
  'ready visual identity must remain projected while replacement work is pending'
);

const secondExternalEffects = presentation.dispatch({ type: 'externalDocumentPresented' });
const thirdId = currentId(presentation);
assert.notEqual(thirdId, secondId);
assert.deepEqual(types(secondExternalEffects), ['resolveSource']);
assert.deepEqual(presentation.getState().projected, firstReadyProjection);
assert.deepEqual(presentation.dispatch({
  type: 'sourceResolved', presentationId: firstId, resolvedSrc: 'late:first'
}), []);
assert.deepEqual(presentation.dispatch({ type: 'sourceFailed', presentationId: secondId }), []);
assert.deepEqual(presentation.dispatch({
  type: 'sourceResolved', presentationId: thirdId, resolvedSrc: 'resolved:third'
}), [{ type: 'loadImage', presentationId: thirdId, resolvedSrc: 'resolved:third' }]);
assert.deepEqual(presentation.dispatch({ type: 'imageLoaded', presentationId: secondId }), []);
assert.deepEqual(presentation.getState().projected, firstReadyProjection);
assert.deepEqual(
  presentation.dispatch({ type: 'imageLoaded', presentationId: thirdId }),
  [{ type: 'showImage', presentationId: thirdId, resolvedSrc: 'resolved:third' }]
);
assert.deepEqual(presentation.getState().projected, {
  phase: 'ready',
  presentationId: thirdId,
  sourceKey: 'image-a',
  resolvedSrc: 'resolved:third'
});

const readyBeforeFailure = presentation.getState().projected;
assert.deepEqual(types(presentation.dispatch({ type: 'externalDocumentPresented' })), ['resolveSource']);
const failingId = currentId(presentation);
assert.deepEqual(presentation.getState().projected, readyBeforeFailure);
assert.deepEqual(
  presentation.dispatch({ type: 'sourceFailed', presentationId: failingId }),
  [{ type: 'showFallback', presentationId: failingId, sourceKey: 'image-a' }]
);
assert.deepEqual(presentation.getState().projected, {
  phase: 'error', presentationId: failingId, sourceKey: 'image-a'
});
assert.equal(presentation.getState().current?.phase, 'error');

assert.deepEqual(
  types(presentation.dispatch({ type: 'externalDocumentPresented' })),
  ['showFallback', 'resolveSource'],
  'retry from an error projection must keep a non-blank pending fallback'
);
const retryId = currentId(presentation);
assert.deepEqual(presentation.getState().projected, {
  phase: 'fallback', presentationId: retryId, sourceKey: 'image-a'
});
assert.deepEqual(
  types(presentation.dispatch({ type: 'externalDocumentPresented' })),
  ['showFallback', 'resolveSource']
);
const latestRetryId = currentId(presentation);
assert.notEqual(latestRetryId, retryId);
assert.deepEqual(presentation.dispatch({
  type: 'sourceResolved', presentationId: retryId, resolvedSrc: 'late:retry'
}), []);
presentation.dispatch({
  type: 'sourceResolved', presentationId: latestRetryId, resolvedSrc: 'resolved:retry'
});
assert.deepEqual(
  presentation.dispatch({ type: 'imageFailed', presentationId: latestRetryId }),
  [{ type: 'showFallback', presentationId: latestRetryId, sourceKey: 'image-a' }]
);
assert.deepEqual(presentation.getState().projected, {
  phase: 'error', presentationId: latestRetryId, sourceKey: 'image-a'
});

const pendingReplacement = createImagePresentationApplication();
pendingReplacement.dispatch({ type: 'present', sourceKey: 'old', rawSrc: './old.png' });
const pendingOldId = currentId(pendingReplacement);
assert.deepEqual(
  types(pendingReplacement.dispatch({ type: 'present', sourceKey: 'new', rawSrc: './new.png' })),
  ['showFallback', 'resolveSource']
);
const pendingNewId = currentId(pendingReplacement);
assert.notEqual(pendingNewId, pendingOldId);
assert.deepEqual(pendingReplacement.getState().projected, {
  phase: 'fallback', presentationId: pendingNewId, sourceKey: 'new'
});
assert.deepEqual(pendingReplacement.dispatch({
  type: 'sourceResolved', presentationId: pendingOldId, resolvedSrc: 'late:old'
}), []);
assert.deepEqual(
  types(pendingReplacement.dispatch({ type: 'externalDocumentPresented' })),
  ['showFallback', 'resolveSource']
);
const pendingExternalId = currentId(pendingReplacement);
assert.notEqual(pendingExternalId, pendingNewId);
assert.deepEqual(pendingReplacement.dispatch({ type: 'sourceFailed', presentationId: pendingNewId }), []);
assert.deepEqual(
  types(pendingReplacement.dispatch({ type: 'externalDocumentPresented' })),
  ['showFallback', 'resolveSource']
);
const latestPendingExternalId = currentId(pendingReplacement);
assert.notEqual(latestPendingExternalId, pendingExternalId);
assert.deepEqual(pendingReplacement.dispatch({
  type: 'sourceFailed', presentationId: pendingExternalId
}), []);

assert.deepEqual(pendingReplacement.dispatch({ type: 'dispose' }), []);
assert.deepEqual(pendingReplacement.getState(), {
  lifecycle: 'disposed',
  current: null,
  projected: { phase: 'none' }
});
assert.deepEqual(pendingReplacement.dispatch({
  type: 'sourceFailed', presentationId: latestPendingExternalId
}), []);
assert.deepEqual(pendingReplacement.dispatch({
  type: 'present', sourceKey: 'late', rawSrc: './late.png'
}), []);

console.log('image presentation application state matrix passed');
