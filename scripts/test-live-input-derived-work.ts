import assert from 'node:assert/strict';
import { EditorState, Transaction } from '@codemirror/state';
import {
  createLiveInputDerivedWorkScheduler,
  isLiveInputNestedProjection,
  liveInputDerivedWorkExtensions,
  markLiveInputDerivedWorkFollowUp,
  markLiveInputNestedProjection,
  shouldDeferLiveInputDerivedWork,
  supersedeLiveInputDerivedWork
} from '../webview/src/editor/liveInputDerivedWork';

const editorSource = await Bun.file(new URL('../webview/src/editor.ts', import.meta.url)).text();
assert.equal(
  editorSource.includes('pendingLiveSearchDecorationRefreshGeneration'),
  false,
  'Live search currentness must remain inside LiveInputDerivedWork'
);
const liveSearchScheduleStart = editorSource.indexOf('const scheduleLiveSearchDecorationRefresh');
const liveSearchScheduleEnd = editorSource.indexOf('const selectSearchMatch', liveSearchScheduleStart);
assert.ok(liveSearchScheduleStart >= 0 && liveSearchScheduleEnd > liveSearchScheduleStart);
const liveSearchScheduleSource = editorSource.slice(liveSearchScheduleStart, liveSearchScheduleEnd);
assert.equal(
  /generation/i.test(liveSearchScheduleSource),
  false,
  'Live search scheduling must not own a generation under another name'
);
assert.equal(
  liveSearchScheduleSource.match(/requestLiveInputDerivedWork/g)?.length ?? 0,
  1,
  'Live search RAF must submit exactly one actual leaf request to the Module'
);
assert.ok(
  liveSearchScheduleSource.indexOf('requestAnimationFrame')
    < liveSearchScheduleSource.indexOf('requestLiveInputDerivedWork'),
  'Live search must coalesce its invalidation before requesting the derived leaf'
);

const unrelatedState = EditorState.create({ doc: 'source-mode' });
assert.equal(
  shouldDeferLiveInputDerivedWork(unrelatedState.update({ changes: { from: 0, insert: '!' } })),
  false,
  'states without the Live phase extension must remain outside the deferred path'
);

const productionState = EditorState.create({
  doc: 'before',
  extensions: liveInputDerivedWorkExtensions()
});
const productionInput = productionState.update({
  changes: { from: productionState.doc.length, insert: '!' },
  annotations: Transaction.userEvent.of('input.type')
});
assert.equal(
  productionInput.effects.length,
  1,
  'a real input transaction must carry the production phase effect'
);
assert.equal(
  shouldDeferLiveInputDerivedWork(productionInput),
  true,
  'a real input transaction must enter the deferred production path'
);
const automaticFollowUp = productionInput.state.update({
  changes: { from: 0, to: 1, insert: 'B' },
  annotations: [
    Transaction.addToHistory.of(false),
    markLiveInputDerivedWorkFollowUp()
  ]
});
assert.equal(
  shouldDeferLiveInputDerivedWork(automaticFollowUp),
  true,
  'input-owned normalization must remain inside the pending input phase'
);
const externalPresentation = automaticFollowUp.state.update({
  changes: { from: 0, to: 1, insert: 'E' },
  effects: supersedeLiveInputDerivedWork(),
  annotations: Transaction.addToHistory.of(false)
});
assert.equal(
  shouldDeferLiveInputDerivedWork(externalPresentation),
  false,
  'external presentation must supersede pending input and rebuild current state'
);
const nestedInputProjection = externalPresentation.state.update({
  changes: { from: externalPresentation.state.doc.length, insert: ' nested' },
  annotations: [
    Transaction.userEvent.of('input.type'),
    markLiveInputNestedProjection()
  ]
});
assert.equal(isLiveInputNestedProjection(nestedInputProjection), true);
assert.equal(
  shouldDeferLiveInputDerivedWork(nestedInputProjection),
  true,
  'a nested rich-block Editor projection must enter the input phase without unloading its widget'
);
const nextInput = nestedInputProjection.state.update({
  changes: { from: nestedInputProjection.state.doc.length, insert: '?' },
  annotations: Transaction.userEvent.of('input.type')
});
const historyReplay = nextInput.state.update({
  changes: { from: nextInput.state.doc.length - 1, to: nextInput.state.doc.length },
  annotations: Transaction.userEvent.of('undo')
});
assert.equal(
  shouldDeferLiveInputDerivedWork(historyReplay),
  false,
  'History must supersede pending input and rebuild its current document'
);
const inputBeforeEqualReload = historyReplay.state.update({
  changes: { from: historyReplay.state.doc.length, insert: '#' },
  annotations: Transaction.userEvent.of('input.type')
});
const equalReload = inputBeforeEqualReload.state.update({
  effects: supersedeLiveInputDerivedWork(),
  annotations: Transaction.addToHistory.of(false)
});
assert.equal(
  shouldDeferLiveInputDerivedWork(equalReload),
  false,
  'an equal-text external reload must supersede pending derived work without a document change'
);

type FrameCallback = () => void;

function createFrameHarness() {
  let nextId = 1;
  const frames = new Map<number, FrameCallback>();
  return {
    requestFrame(callback: FrameCallback): number {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame(id: number): void {
      frames.delete(id);
    },
    flushFrame(): void {
      const pending = [...frames.entries()];
      frames.clear();
      for (const [, callback] of pending) callback();
    },
    get pendingCount(): number {
      return frames.size;
    }
  };
}

const frames = createFrameHarness();
let applies = 0;
const errors: unknown[] = [];
let failNextApply = false;
const scheduler = createLiveInputDerivedWorkScheduler({
  requestFrame: (callback) => frames.requestFrame(callback),
  cancelFrame: (id) => frames.cancelFrame(id),
  apply() {
    applies += 1;
    if (failNextApply) {
      failNextApply = false;
      throw new Error('controlled derived failure');
    }
  },
  reportError: (error) => errors.push(error)
});

assert.equal(frames.pendingCount, 0, 'zero input must schedule zero derived work');
scheduler.documentChanged();
assert.equal(frames.pendingCount, 1, 'one input must reserve one primary-frame observation');
frames.flushFrame();
assert.equal(applies, 0, 'the first observable frame must not run derived work');
assert.equal(frames.pendingCount, 1, 'current work may schedule after the primary frame');
frames.flushFrame();
assert.equal(applies, 1, 'current derived work must apply after the primary frame');

scheduler.documentChanged();
frames.flushFrame();
scheduler.cancelPending();
frames.flushFrame();
assert.equal(applies, 1, 'a newer non-input document must supersede pending input work');

scheduler.documentChanged();
scheduler.documentChanged();
scheduler.documentChanged();
assert.equal(frames.pendingCount, 1, 'held-key input must coalesce to one latest frame');
frames.flushFrame();
scheduler.documentChanged();
assert.equal(frames.pendingCount, 1, 'new input must invalidate an older post-frame completion');
frames.flushFrame();
assert.equal(applies, 1, 'stale derived work must not apply');
frames.flushFrame();
assert.equal(applies, 2, 'only the latest held-key generation may apply');

failNextApply = true;
scheduler.documentChanged();
frames.flushFrame();
frames.flushFrame();
assert.equal(applies, 3, 'a current derived attempt must run exactly once');
assert.equal(errors.length, 1, 'a derived failure must be reported exactly once');
scheduler.documentChanged();
frames.flushFrame();
frames.flushFrame();
assert.equal(applies, 4, 'a later input must recover after a derived failure');

scheduler.documentChanged();
scheduler.dispose();
assert.equal(frames.pendingCount, 0, 'dispose must cancel pending frames');
frames.flushFrame();
assert.equal(applies, 4, 'dispose must reject late completion');
scheduler.documentChanged();
assert.equal(frames.pendingCount, 0, 'disposed schedulers must ignore new input');

const firstFrames = createFrameHarness();
const secondFrames = createFrameHarness();
let firstApplies = 0;
let secondApplies = 0;
const first = createLiveInputDerivedWorkScheduler({
  requestFrame: (callback) => firstFrames.requestFrame(callback),
  cancelFrame: (id) => firstFrames.cancelFrame(id),
  apply: () => { firstApplies += 1; },
  reportError: (error) => { throw error; }
});
const second = createLiveInputDerivedWorkScheduler({
  requestFrame: (callback) => secondFrames.requestFrame(callback),
  cancelFrame: (id) => secondFrames.cancelFrame(id),
  apply: () => { secondApplies += 1; },
  reportError: (error) => { throw error; }
});
first.documentChanged();
second.documentChanged();
firstFrames.flushFrame();
first.dispose();
secondFrames.flushFrame();
secondFrames.flushFrame();
assert.deepEqual(
  { firstApplies, secondApplies },
  { firstApplies: 0, secondApplies: 1 },
  'multiple Editors must keep frame generations and disposal isolated'
);
second.dispose();

console.log('Live input derived-work scheduler tests passed');
