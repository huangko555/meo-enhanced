import assert from 'node:assert/strict';
import {
  createMermaidDiagramPresentationApplication,
  type MermaidDiagramPresentationEffect
} from '../webview/src/application/mermaidDiagramPresentation';

const effectTypes = (effects: readonly MermaidDiagramPresentationEffect[]) => (
  effects.map((effect) => effect.type)
);

const successful = createMermaidDiagramPresentationApplication();
const requested = successful.dispatch({
  type: 'present',
  source: 'graph TD\nA-->B',
  themeKey: 'light',
  configKey: 'default'
});
assert.deepEqual(effectTypes(requested), ['showPending', 'renderDiagram']);
const presentationId = successful.getState().presentationId;
assert.ok(presentationId);
assert.deepEqual(successful.dispatch({
  type: 'renderSucceeded',
  presentationId,
  svg: '<svg data-diagram="a"></svg>'
}), [{
  type: 'showDiagram',
  presentationId,
  svg: '<svg data-diagram="a"></svg>'
}]);
assert.deepEqual(successful.getState(), {
  phase: 'ready',
  presentationId,
  source: 'graph TD\nA-->B',
  themeKey: 'light',
  configKey: 'default'
});

const failedThenRecovered = createMermaidDiagramPresentationApplication();
failedThenRecovered.dispatch({
  type: 'present', source: 'invalid', themeKey: 'light', configKey: 'default'
});
const failedId = failedThenRecovered.getState().presentationId;
assert.ok(failedId);
assert.deepEqual(failedThenRecovered.dispatch({
  type: 'renderFailed', presentationId: failedId, error: 'parse error'
}), [{
  type: 'showError',
  presentationId: failedId,
  source: 'invalid',
  error: 'parse error'
}]);
assert.equal(failedThenRecovered.getState().phase, 'error');
const recoveryEffects = failedThenRecovered.dispatch({
  type: 'present', source: 'graph TD\nA-->B', themeKey: 'light', configKey: 'default'
});
assert.deepEqual(effectTypes(recoveryEffects), ['showPending', 'renderDiagram']);

const replaced = createMermaidDiagramPresentationApplication();
replaced.dispatch({ type: 'present', source: 'old', themeKey: 'light', configKey: 'default' });
const oldId = replaced.getState().presentationId;
replaced.dispatch({ type: 'present', source: 'new', themeKey: 'dark', configKey: 'strict' });
const newId = replaced.getState().presentationId;
assert.ok(oldId && newId && oldId !== newId);
assert.deepEqual(replaced.dispatch({
  type: 'renderSucceeded', presentationId: oldId, svg: '<svg data-diagram="old"></svg>'
}), []);
assert.deepEqual(replaced.dispatch({
  type: 'renderFailed', presentationId: oldId, error: 'late old error'
}), []);
assert.equal(replaced.getState().phase, 'pending');

const invalidated = createMermaidDiagramPresentationApplication();
invalidated.dispatch({ type: 'present', source: 'external', themeKey: 'light', configKey: 'default' });
const invalidatedId = invalidated.getState().presentationId;
assert.ok(invalidatedId);
assert.deepEqual(effectTypes(invalidated.dispatch({ type: 'externalDocumentPresented' })), [
  'clearPresentation'
]);
assert.deepEqual(invalidated.getState(), {
  phase: 'idle', presentationId: null, source: null, themeKey: null, configKey: null
});
assert.deepEqual(invalidated.dispatch({
  type: 'renderSucceeded', presentationId: invalidatedId, svg: '<svg></svg>'
}), []);

const disposed = createMermaidDiagramPresentationApplication();
disposed.dispatch({ type: 'present', source: 'disposed', themeKey: 'light', configKey: 'default' });
const disposedId = disposed.getState().presentationId;
assert.ok(disposedId);
assert.deepEqual(disposed.dispatch({ type: 'dispose' }), []);
assert.deepEqual(disposed.getState(), {
  phase: 'disposed', presentationId: null, source: null, themeKey: null, configKey: null
});
assert.deepEqual(disposed.dispatch({
  type: 'renderSucceeded', presentationId: disposedId, svg: '<svg></svg>'
}), []);
assert.deepEqual(disposed.dispatch({
  type: 'present', source: 'late', themeKey: 'dark', configKey: 'default'
}), []);

console.log('Mermaid diagram presentation application contracts passed');
