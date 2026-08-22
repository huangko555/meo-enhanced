import assert from 'node:assert/strict';
import { createLiveInputDerivedWorkScheduler } from '../webview/src/editor/liveInputDerivedWork';

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
