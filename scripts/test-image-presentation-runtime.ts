import assert from 'node:assert/strict';
import {
  createImagePresentationApplication,
  type ImagePresentationEffect,
  type ImagePresentationEffectExecution,
  type ImagePresentationEffectExecutor,
  type ImagePresentationInput
} from '../webview/src/application/imagePresentation';
import { createImagePresentationRuntime } from '../webview/src/adapters/imagePresentationRuntime';

type Deferred = {
  effect: ImagePresentationEffect;
  resolve: (input: ImagePresentationInput) => void;
};

const deferred: Deferred[] = [];
const executed: ImagePresentationEffect[] = [];
let executorDisposed = 0;
const executor: ImagePresentationEffectExecutor = {
  execute(effect): ImagePresentationEffectExecution {
    executed.push(effect);
    if (effect.type === 'resolveSource' || effect.type === 'loadImage') {
      let resolve!: Deferred['resolve'];
      const completion = new Promise<ImagePresentationInput>((settle) => {
        resolve = settle;
      });
      deferred.push({ effect, resolve });
      return { completion };
    }
    return {
      immediateCompletion: {
        type: 'projectionSucceeded',
        presentationId: effect.presentationId,
        commandId: effect.commandId
      }
    };
  },
  dispose() {
    executorDisposed += 1;
  }
};

const application = createImagePresentationApplication();
const runtime = createImagePresentationRuntime({ application, executor });
runtime.dispatch({ type: 'present', sourceKey: 'a', rawSrc: './a.png' });
const firstId = application.getState().current?.presentationId;
assert.ok(firstId);
assert.deepEqual(executed.map((effect) => effect.type), ['showFallback', 'resolveSource']);

let firstIdle = false;
void runtime.whenCurrentPresentationSettles().then(() => { firstIdle = true; });
await Promise.resolve();
assert.equal(firstIdle, false, 'resolving presentation must not be idle');

runtime.dispatch({ type: 'present', sourceKey: 'b', rawSrc: './b.png' });
const secondId = application.getState().current?.presentationId;
assert.ok(secondId && secondId !== firstId);
assert.deepEqual(executed.slice(-2).map((effect) => effect.type), [
  'showFallback', 'resolveSource'
]);

deferred.find((item) => item.effect.presentationId === firstId)?.resolve({
  type: 'sourceResolved', presentationId: firstId, resolvedSrc: 'resolved:a'
});
await Promise.resolve();
await Promise.resolve();
assert.equal(application.getState().current?.presentationId, secondId);
assert.equal(
  executed.some((effect) => effect.type === 'loadImage' && effect.presentationId === firstId),
  false,
  'replaced resolve completion must not start an old image load'
);

const secondResolve = deferred.find((item) => (
  item.effect.type === 'resolveSource' && item.effect.presentationId === secondId
));
secondResolve?.resolve({ type: 'sourceResolved', presentationId: secondId, resolvedSrc: 'resolved:b' });
await Promise.resolve();
await Promise.resolve();
const secondLoad = deferred.find((item) => (
  item.effect.type === 'loadImage' && item.effect.presentationId === secondId
));
assert.ok(secondLoad, 'current resolve completion did not start image load');
secondLoad.resolve({ type: 'imageLoaded', presentationId: secondId });
await runtime.whenCurrentPresentationSettles();
assert.equal(application.getState().current?.phase, 'ready');
assert.equal(application.getState().projected.phase, 'ready');
assert.equal(firstIdle, true, 'old idle waiter should resolve when the replacement becomes idle');

const fallbacksBeforeReadyReplacement = executed.filter((effect) => effect.type === 'showFallback').length;
runtime.dispatch({ type: 'present', sourceKey: 'external', rawSrc: './external.png' });
const externalId = application.getState().current?.presentationId;
assert.ok(externalId);
assert.equal(application.getState().projected.phase, 'ready');
runtime.dispatch({ type: 'externalDocumentPresented' });
const externalReplayId = application.getState().current?.presentationId;
assert.ok(externalReplayId && externalReplayId !== externalId);
assert.equal(
  executed.filter((effect) => effect.type === 'showFallback').length,
  fallbacksBeforeReadyReplacement,
  'ready replacement must never execute a fallback projection effect'
);
deferred.find((item) => item.effect.presentationId === externalId)?.resolve({
  type: 'sourceFailed', presentationId: externalId
});
const externalReplayResolve = deferred.find((item) => (
  item.effect.type === 'resolveSource' && item.effect.presentationId === externalReplayId
));
externalReplayResolve?.resolve({
  type: 'sourceResolved', presentationId: externalReplayId, resolvedSrc: 'resolved:external-current'
});
await Promise.resolve();
await Promise.resolve();
const externalReplayLoad = deferred.find((item) => (
  item.effect.type === 'loadImage' && item.effect.presentationId === externalReplayId
));
assert.ok(externalReplayLoad, 'external replay did not advance the current presentation to loading');
externalReplayLoad.resolve({ type: 'imageLoaded', presentationId: externalReplayId });
await runtime.whenCurrentPresentationSettles();
assert.equal(application.getState().current?.phase, 'ready');
assert.equal(application.getState().projected.phase, 'ready');
assert.equal(
  executed.filter((effect) => effect.type === 'showFallback').length,
  fallbacksBeforeReadyReplacement
);

runtime.dispatch({ type: 'present', sourceKey: 'dispose', rawSrc: './dispose.png' });
const disposeId = application.getState().current?.presentationId;
assert.ok(disposeId);
runtime.dispose();
assert.equal(executorDisposed, 1);
assert.equal(application.getState().lifecycle, 'disposed');
deferred.find((item) => item.effect.presentationId === disposeId)?.resolve({
  type: 'sourceFailed', presentationId: disposeId
});
await runtime.whenCurrentPresentationSettles();
assert.equal(application.getState().lifecycle, 'disposed');

const throwingApplication = createImagePresentationApplication();
const throwingRuntime = createImagePresentationRuntime({
  application: throwingApplication,
  executor: {
    execute(effect) {
      switch (effect.type) {
        case 'resolveSource':
          return {
            immediateCompletion: {
              type: 'sourceResolved',
              presentationId: effect.presentationId,
              resolvedSrc: 'resolved:throwing'
            }
          };
        case 'loadImage':
          return {
            immediateCompletion: {
              type: 'imageLoaded',
              presentationId: effect.presentationId
            }
          };
        case 'showImage':
          throw new Error('projection unavailable');
        case 'showFallback':
          return {
            immediateCompletion: {
              type: 'projectionSucceeded',
              presentationId: effect.presentationId,
              commandId: effect.commandId
            }
          };
      }
    },
    dispose() {}
  }
});
throwingRuntime.dispatch({ type: 'present', sourceKey: 'throwing', rawSrc: './throwing.png' });
assert.equal(
  throwingApplication.getState().projected.phase,
  'fallback',
  'a failed projection must not commit a phantom ready DOM identity'
);
throwingRuntime.dispose();

const acknowledgedApplication = createImagePresentationApplication();
const projectionCompletions: Deferred[] = [];
let deferFailureFallback = false;
const acknowledgedRuntime = createImagePresentationRuntime({
  application: acknowledgedApplication,
  executor: {
    execute(effect) {
      if (effect.type === 'resolveSource') {
        return {
          immediateCompletion: effect.rawSrc.includes('failure')
            ? { type: 'sourceFailed', presentationId: effect.presentationId }
            : {
                type: 'sourceResolved',
                presentationId: effect.presentationId,
                resolvedSrc: `resolved:${effect.rawSrc}`
              }
        };
      }
      if (effect.type === 'loadImage') {
        return {
          immediateCompletion: { type: 'imageLoaded', presentationId: effect.presentationId }
        };
      }
      if (effect.type === 'showFallback' && !deferFailureFallback) {
        return {
          immediateCompletion: {
            type: 'projectionSucceeded',
            presentationId: effect.presentationId,
            commandId: effect.commandId
          }
        };
      }
      let resolve!: Deferred['resolve'];
      const completion = new Promise<ImagePresentationInput>((settle) => { resolve = settle; });
      projectionCompletions.push({ effect, resolve });
      return { completion };
    },
    dispose() {}
  }
});

acknowledgedRuntime.dispatch({ type: 'present', sourceKey: 'ack', rawSrc: './ack.png' });
assert.equal(acknowledgedApplication.getState().current?.phase, 'ready');
assert.equal(acknowledgedApplication.getState().projected.phase, 'fallback');
assert.equal(acknowledgedApplication.getState().projection?.target.phase, 'ready');
let projectionSettled = false;
void acknowledgedRuntime.whenCurrentPresentationSettles().then(() => { projectionSettled = true; });
await Promise.resolve();
assert.equal(projectionSettled, false, 'ready resource work settled before its projection acknowledgement');
const readyProjection = projectionCompletions.at(-1);
assert.ok(readyProjection?.effect.type === 'showImage');
readyProjection.resolve({
  type: 'projectionSucceeded',
  presentationId: readyProjection.effect.presentationId,
  commandId: readyProjection.effect.commandId
});
await acknowledgedRuntime.whenCurrentPresentationSettles();
assert.equal(projectionSettled, true);
assert.equal(acknowledgedApplication.getState().projected.phase, 'ready');

deferFailureFallback = true;
acknowledgedRuntime.dispatch({
  type: 'present',
  sourceKey: 'failure',
  rawSrc: './failure.png'
});
const committedBeforeProjectionFailure = acknowledgedApplication.getState().projected;
assert.equal(acknowledgedApplication.getState().current?.phase, 'error');
assert.equal(acknowledgedApplication.getState().projection?.target.phase, 'error');
let failedProjectionSettled = false;
void acknowledgedRuntime.whenCurrentPresentationSettles().then(() => {
  failedProjectionSettled = true;
});
await Promise.resolve();
assert.equal(failedProjectionSettled, false);
const failedProjection = projectionCompletions.at(-1);
assert.ok(failedProjection?.effect.type === 'showFallback');
failedProjection.resolve({
  type: 'projectionFailed',
  presentationId: failedProjection.effect.presentationId,
  commandId: failedProjection.effect.commandId
});
await acknowledgedRuntime.whenCurrentPresentationSettles();
assert.equal(failedProjectionSettled, true);
assert.deepEqual(
  acknowledgedApplication.getState().projected,
  committedBeforeProjectionFailure,
  'failed fallback projection replaced the last confirmed ready fact'
);
assert.equal(acknowledgedApplication.getState().projection, null);
acknowledgedRuntime.dispose();

console.log('image presentation runtime contracts passed');
