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
  resolve: (input: ImagePresentationInput | null) => void;
};

const deferred: Deferred[] = [];
const executed: ImagePresentationEffect[] = [];
let executorDisposed = 0;
const executor: ImagePresentationEffectExecutor = {
  execute(effect): ImagePresentationEffectExecution {
    executed.push(effect);
    if (effect.type === 'resolveSource' || effect.type === 'loadImage') {
      let resolve!: Deferred['resolve'];
      const completion = new Promise<ImagePresentationInput | null>((settle) => {
        resolve = settle;
      });
      deferred.push({ effect, resolve });
      return { completion };
    }
    return {};
  },
  dispose() {
    executorDisposed += 1;
  }
};

const application = createImagePresentationApplication();
const runtime = createImagePresentationRuntime({ application, executor });
runtime.dispatch({ type: 'present', sourceKey: 'a', rawSrc: './a.png' });
const firstId = application.getState().presentationId;
assert.ok(firstId);
assert.deepEqual(executed.map((effect) => effect.type), ['showFallback', 'resolveSource']);

let firstIdle = false;
void runtime.whenCurrentPresentationSettles().then(() => { firstIdle = true; });
await Promise.resolve();
assert.equal(firstIdle, false, 'resolving presentation must not be idle');

runtime.dispatch({ type: 'present', sourceKey: 'b', rawSrc: './b.png' });
const secondId = application.getState().presentationId;
assert.ok(secondId && secondId !== firstId);
assert.deepEqual(executed.slice(-2).map((effect) => effect.type), [
  'showFallback', 'resolveSource'
]);

deferred.find((item) => item.effect.presentationId === firstId)?.resolve({
  type: 'sourceResolved', presentationId: firstId, resolvedSrc: 'resolved:a'
});
await Promise.resolve();
await Promise.resolve();
assert.equal(application.getState().presentationId, secondId);
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
assert.equal(application.getState().phase, 'ready');
assert.equal(firstIdle, true, 'old idle waiter should resolve when the replacement becomes idle');

runtime.dispatch({ type: 'present', sourceKey: 'external', rawSrc: './external.png' });
const externalId = application.getState().presentationId;
assert.ok(externalId);
runtime.dispatch({ type: 'externalDocumentPresented' });
const externalReplayId = application.getState().presentationId;
assert.ok(externalReplayId && externalReplayId !== externalId);
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
assert.equal(application.getState().phase, 'ready');

runtime.dispatch({ type: 'present', sourceKey: 'dispose', rawSrc: './dispose.png' });
const disposeId = application.getState().presentationId;
assert.ok(disposeId);
runtime.dispose();
assert.equal(executorDisposed, 1);
assert.equal(application.getState().phase, 'disposed');
deferred.find((item) => item.effect.presentationId === disposeId)?.resolve({
  type: 'sourceFailed', presentationId: disposeId
});
await runtime.whenCurrentPresentationSettles();
assert.equal(application.getState().phase, 'disposed');

console.log('image presentation runtime contracts passed');
