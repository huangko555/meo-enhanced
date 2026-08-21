import assert from 'node:assert/strict';
import {
  createImagePresentationApplication,
  type ImagePresentationApplication,
  type ImagePresentationEffect
} from '../webview/src/application/imagePresentation';

type ProjectionEffect = Extract<ImagePresentationEffect, { type: 'showImage' | 'showFallback' }>;

const types = (effects: readonly ImagePresentationEffect[]) => effects.map((effect) => effect.type);
const currentId = (application: ImagePresentationApplication): number => {
  const id = application.getState().current?.presentationId;
  assert.ok(id);
  return id;
};
const projectionEffect = (effects: readonly ImagePresentationEffect[]): ProjectionEffect => {
  const effect = effects.find(
    (candidate): candidate is ProjectionEffect => (
      candidate.type === 'showImage' || candidate.type === 'showFallback'
    )
  );
  assert.ok(effect, 'expected a projection command');
  return effect;
};
const acknowledge = (
  application: ImagePresentationApplication,
  effect: ProjectionEffect,
  outcome: 'projectionSucceeded' | 'projectionFailed'
): readonly ImagePresentationEffect[] => application.dispatch({
  type: outcome,
  presentationId: effect.presentationId,
  commandId: effect.commandId
});
const loadCurrent = (
  application: ImagePresentationApplication,
  resolvedSrc: string
): readonly ImagePresentationEffect[] => {
  const presentationId = currentId(application);
  assert.deepEqual(application.dispatch({
    type: 'sourceResolved',
    presentationId,
    resolvedSrc
  }), [{ type: 'loadImage', presentationId, resolvedSrc }]);
  return application.dispatch({ type: 'imageLoaded', presentationId });
};

const empty = createImagePresentationApplication();
assert.deepEqual(empty.getState(), {
  lifecycle: 'active',
  current: null,
  projected: { phase: 'none' },
  projection: null
});
assert.deepEqual(empty.dispatch({ type: 'externalDocumentPresented' }), []);

// Initial fallback and ready projection are two correlated commands. Resource
// work may finish first, but committed DOM identity changes only on each ack.
const initial = createImagePresentationApplication();
const initialEffects = initial.dispatch({ type: 'present', sourceKey: 'a', rawSrc: './a.png' });
assert.deepEqual(types(initialEffects), ['showFallback', 'resolveSource']);
const initialId = currentId(initial);
const initialFallback = projectionEffect(initialEffects);
assert.deepEqual(initial.getState().projected, { phase: 'none' });
assert.deepEqual(initial.getState().projection, {
  commandId: initialFallback.commandId,
  target: { phase: 'fallback', presentationId: initialId, sourceKey: 'a' }
});
assert.deepEqual(loadCurrent(initial, 'resolved:a'), []);
assert.equal(initial.getState().current?.phase, 'ready');
assert.deepEqual(initial.getState().projected, { phase: 'none' });
const imageEffects = acknowledge(initial, initialFallback, 'projectionSucceeded');
assert.deepEqual(types(imageEffects), ['showImage']);
assert.deepEqual(initial.getState().projected, {
  phase: 'fallback', presentationId: initialId, sourceKey: 'a'
});
const initialImage = projectionEffect(imageEffects);
assert.deepEqual(acknowledge(initial, initialImage, 'projectionSucceeded'), []);
const firstReady = initial.getState().projected;
assert.deepEqual(firstReady, {
  phase: 'ready', presentationId: initialId, sourceKey: 'a', resolvedSrc: 'resolved:a'
});
assert.equal(initial.getState().projection, null);
assert.deepEqual(acknowledge(initial, initialImage, 'projectionSucceeded'), []);

// A ready replacement keeps the old confirmed DOM. Continuous external work
// cannot create a second command; an old command ack cannot commit its target.
assert.deepEqual(types(initial.dispatch({ type: 'externalDocumentPresented' })), ['resolveSource']);
const replacementId = currentId(initial);
const replacementImage = projectionEffect(loadCurrent(initial, 'resolved:replacement'));
assert.deepEqual(initial.getState().projected, firstReady);
assert.deepEqual(types(initial.dispatch({ type: 'externalDocumentPresented' })), ['resolveSource']);
const latestId = currentId(initial);
assert.notEqual(latestId, replacementId);
assert.equal(initial.getState().projection?.commandId, replacementImage.commandId);
assert.deepEqual(loadCurrent(initial, 'resolved:latest'), []);
const latestImageEffects = acknowledge(initial, replacementImage, 'projectionSucceeded');
assert.deepEqual(initial.getState().projected, firstReady, 'stale command ack changed committed DOM identity');
assert.deepEqual(types(latestImageEffects), ['showImage']);
const latestImage = projectionEffect(latestImageEffects);
assert.equal(latestImage.presentationId, latestId);
assert.deepEqual(acknowledge(initial, latestImage, 'projectionSucceeded'), []);
assert.deepEqual(initial.getState().projected, {
  phase: 'ready', presentationId: latestId, sourceKey: 'a', resolvedSrc: 'resolved:latest'
});
assert.deepEqual(acknowledge(initial, replacementImage, 'projectionFailed'), []);

// Latest failure is a separately acknowledged fallback projection. A failed
// command keeps the old ready fact and does not automatically retry itself.
const readyBeforeFailure = initial.getState().projected;
initial.dispatch({ type: 'externalDocumentPresented' });
const failureId = currentId(initial);
const failureEffects = initial.dispatch({ type: 'sourceFailed', presentationId: failureId });
assert.deepEqual(types(failureEffects), ['showFallback']);
const failureFallback = projectionEffect(failureEffects);
assert.equal(initial.getState().current?.phase, 'error');
assert.deepEqual(initial.getState().projected, readyBeforeFailure);
assert.deepEqual(acknowledge(initial, failureFallback, 'projectionFailed'), []);
assert.deepEqual(initial.getState().projected, readyBeforeFailure);
assert.equal(initial.getState().projection, null);

// A new external generation is the bounded recovery trigger after projection
// failure; success commits error only after the fallback command succeeds.
assert.deepEqual(types(initial.dispatch({ type: 'externalDocumentPresented' })), ['resolveSource']);
const recoveryId = currentId(initial);
const recoveryFailureEffects = initial.dispatch({ type: 'sourceFailed', presentationId: recoveryId });
const recoveryFallback = projectionEffect(recoveryFailureEffects);
assert.deepEqual(acknowledge(initial, recoveryFallback, 'projectionSucceeded'), []);
assert.deepEqual(initial.getState().projected, {
  phase: 'error', presentationId: recoveryId, sourceKey: 'a'
});

// A fallback command already in flight is upgraded to the terminal error fact
// instead of emitting a duplicate command when async work fails.
const fallbackPending = createImagePresentationApplication();
const pendingEffects = fallbackPending.dispatch({
  type: 'present', sourceKey: 'pending', rawSrc: './pending.png'
});
const pendingId = currentId(fallbackPending);
const pendingFallback = projectionEffect(pendingEffects);
assert.deepEqual(
  fallbackPending.dispatch({ type: 'sourceFailed', presentationId: pendingId }),
  []
);
assert.deepEqual(fallbackPending.getState().projection, {
  commandId: pendingFallback.commandId,
  target: { phase: 'error', presentationId: pendingId, sourceKey: 'pending' }
});
assert.deepEqual(acknowledge(fallbackPending, pendingFallback, 'projectionSucceeded'), []);
assert.deepEqual(fallbackPending.getState().projected, {
  phase: 'error', presentationId: pendingId, sourceKey: 'pending'
});

const confirmedFallback = createImagePresentationApplication();
const confirmedFallbackEffects = confirmedFallback.dispatch({
  type: 'present', sourceKey: 'confirmed-fallback', rawSrc: './missing.png'
});
const confirmedFallbackId = currentId(confirmedFallback);
assert.deepEqual(
  acknowledge(
    confirmedFallback,
    projectionEffect(confirmedFallbackEffects),
    'projectionSucceeded'
  ),
  []
);
assert.deepEqual(
  confirmedFallback.dispatch({ type: 'sourceFailed', presentationId: confirmedFallbackId }),
  [],
  'an acknowledged fallback must not be projected a second time for terminal failure'
);
assert.deepEqual(confirmedFallback.getState().projected, {
  phase: 'error', presentationId: confirmedFallbackId, sourceKey: 'confirmed-fallback'
});

// Continuous non-ready generations retain one command. Its stale ack is
// discarded, then exactly one command is issued for the latest generation.
const oldPendingEffects = fallbackPending.dispatch({ type: 'externalDocumentPresented' });
const oldPendingId = currentId(fallbackPending);
const oldPendingCommand = projectionEffect(oldPendingEffects);
assert.deepEqual(types(fallbackPending.dispatch({ type: 'externalDocumentPresented' })), ['resolveSource']);
const latestPendingId = currentId(fallbackPending);
assert.notEqual(latestPendingId, oldPendingId);
const latestPendingEffects = acknowledge(fallbackPending, oldPendingCommand, 'projectionSucceeded');
assert.deepEqual(types(latestPendingEffects), ['showFallback']);
assert.equal(projectionEffect(latestPendingEffects).presentationId, latestPendingId);
assert.equal(fallbackPending.getState().projected.phase, 'error');

const disposeCommand = projectionEffect(latestPendingEffects);
assert.deepEqual(fallbackPending.dispatch({ type: 'dispose' }), []);
assert.deepEqual(fallbackPending.getState(), {
  lifecycle: 'disposed',
  current: null,
  projected: { phase: 'none' },
  projection: null
});
assert.deepEqual(acknowledge(fallbackPending, disposeCommand, 'projectionSucceeded'), []);
assert.deepEqual(fallbackPending.dispatch({
  type: 'present', sourceKey: 'late', rawSrc: './late.png'
}), []);

const acknowledgeAll = (application: ImagePresentationApplication): void => {
  for (let count = 0; count < 8; count += 1) {
    const intent = application.getState().projection;
    if (!intent) return;
    application.dispatch({
      type: 'projectionSucceeded',
      presentationId: intent.target.presentationId,
      commandId: intent.commandId
    });
  }
  assert.fail('projection command sequence did not converge');
};

const seeded = (phase: 'none' | 'fallback' | 'ready' | 'error'): ImagePresentationApplication => {
  const application = createImagePresentationApplication();
  application.dispatch({ type: 'present', sourceKey: `seed-${phase}`, rawSrc: `./seed-${phase}.png` });
  const initialIntent = application.getState().projection;
  assert.ok(initialIntent);
  application.dispatch({
    type: phase === 'none' ? 'projectionFailed' : 'projectionSucceeded',
    presentationId: initialIntent.target.presentationId,
    commandId: initialIntent.commandId
  });
  if (phase === 'ready') {
    loadCurrent(application, `resolved:seed-${phase}`);
    acknowledgeAll(application);
  } else if (phase === 'error') {
    application.dispatch({ type: 'sourceFailed', presentationId: currentId(application) });
    acknowledgeAll(application);
  }
  assert.equal(application.getState().projected.phase, phase);
  return application;
};

for (const projectedPhase of ['none', 'fallback', 'ready', 'error'] as const) {
  const success = seeded(projectedPhase);
  success.dispatch({ type: 'present', sourceKey: `success-${projectedPhase}`, rawSrc: './success.png' });
  success.dispatch({ type: 'externalDocumentPresented' });
  success.dispatch({ type: 'externalDocumentPresented' });
  acknowledgeAll(success);
  const successId = currentId(success);
  loadCurrent(success, `resolved:success-${projectedPhase}`);
  acknowledgeAll(success);
  assert.deepEqual(success.getState().projected, {
    phase: 'ready',
    presentationId: successId,
    sourceKey: `success-${projectedPhase}`,
    resolvedSrc: `resolved:success-${projectedPhase}`
  });

  const failure = seeded(projectedPhase);
  failure.dispatch({ type: 'externalDocumentPresented' });
  failure.dispatch({ type: 'externalDocumentPresented' });
  const failureId = currentId(failure);
  failure.dispatch({ type: 'sourceFailed', presentationId: failureId });
  acknowledgeAll(failure);
  assert.deepEqual(failure.getState().projected, {
    phase: 'error',
    presentationId: failureId,
    sourceKey: `seed-${projectedPhase}`
  });
  assert.equal(failure.getState().projection, null);
}

console.log('image presentation application command/ack state matrix passed');
