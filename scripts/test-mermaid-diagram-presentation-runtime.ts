import assert from 'node:assert/strict';
import {
  createMermaidDiagramPresentationApplication,
  type MermaidDiagramPresentationEffect,
  type MermaidDiagramPresentationEffectExecutor,
  type MermaidDiagramPresentationInput
} from '../webview/src/application/mermaidDiagramPresentation';
import { createMermaidDiagramPresentationRuntime } from '../webview/src/adapters/mermaidDiagramPresentationRuntime';

type Deferred = {
  readonly promise: Promise<MermaidDiagramPresentationInput | null>;
  resolve(value: MermaidDiagramPresentationInput | null): void;
};

const deferred = (): Deferred => {
  let resolve!: (value: MermaidDiagramPresentationInput | null) => void;
  return {
    promise: new Promise((settle) => { resolve = settle; }),
    resolve
  };
};

const effects: MermaidDiagramPresentationEffect[] = [];
const renders = new Map<number, Deferred>();
let disposed = false;
const executor: MermaidDiagramPresentationEffectExecutor = {
  execute(effect) {
    effects.push(effect);
    if (effect.type !== 'renderDiagram') return {};
    if (effect.source === 'cached') {
      return {
        immediate: {
          type: 'renderSucceeded',
          presentationId: effect.presentationId,
          svg: '<svg data-value="cached"></svg>'
        }
      };
    }
    const completion = deferred();
    renders.set(effect.presentationId, completion);
    return { completion: completion.promise };
  },
  dispose() { disposed = true; }
};

const application = createMermaidDiagramPresentationApplication();
const runtime = createMermaidDiagramPresentationRuntime({ application, executor });
runtime.dispatch({ type: 'present', source: 'slow-old', themeKey: 'light', configKey: 'default' });
const oldId = application.getState().presentationId;
assert.ok(oldId);
assert.deepEqual(effects.map((effect) => effect.type), ['showPending', 'renderDiagram']);

runtime.dispatch({ type: 'present', source: 'fast-new', themeKey: 'dark', configKey: 'strict' });
const newId = application.getState().presentationId;
assert.ok(newId && newId !== oldId, 'new presentation must advance synchronously');
assert.deepEqual(effects.map((effect) => effect.type), [
  'showPending', 'renderDiagram', 'showPending', 'renderDiagram'
]);

let currentSettled = false;
const currentIdle = runtime.whenCurrentPresentationSettles().then(() => { currentSettled = true; });
renders.get(oldId)?.resolve({
  type: 'renderSucceeded', presentationId: oldId, svg: '<svg data-value="old"></svg>'
});
await Promise.resolve();
assert.equal(currentSettled, false, 'old completion must not settle the current presentation');
renders.get(newId)?.resolve({
  type: 'renderSucceeded', presentationId: newId, svg: '<svg data-value="new"></svg>'
});
await currentIdle;
assert.equal(application.getState().phase, 'ready');
assert.equal(
  effects.some((effect) => effect.type === 'showDiagram' && effect.svg.includes('old')),
  false
);
assert.equal(
  effects.some((effect) => effect.type === 'showDiagram' && effect.svg.includes('new')),
  true
);

runtime.dispatch({ type: 'present', source: 'cached', themeKey: 'dark', configKey: 'strict' });
assert.equal(application.getState().phase, 'ready', 'cached completion must settle synchronously');
assert.equal(
  effects.some((effect) => effect.type === 'showDiagram' && effect.svg.includes('cached')),
  true
);

runtime.dispatch({ type: 'present', source: 'external', themeKey: 'light', configKey: 'default' });
const externalId = application.getState().presentationId;
assert.ok(externalId);
runtime.dispatch({ type: 'externalDocumentPresented' });
renders.get(externalId)?.resolve({
  type: 'renderFailed', presentationId: externalId, error: 'late external error'
});
await Promise.resolve();
assert.equal(application.getState().phase, 'idle');

runtime.dispose();
assert.equal(disposed, true);
assert.deepEqual(application.getState(), {
  phase: 'disposed', presentationId: null, source: null, themeKey: null, configKey: null
});
runtime.dispatch({ type: 'present', source: 'late', themeKey: 'dark', configKey: 'strict' });
assert.equal(application.getState().phase, 'disposed');

console.log('Mermaid diagram presentation Runtime contracts passed');
