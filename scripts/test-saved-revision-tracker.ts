import { SavedRevisionTracker } from '../src/diff/savedRevisionTracker';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

const tracker = new SavedRevisionTracker({ mergeWindowMs: 10_000 });
tracker.initialize('A');

assert(tracker.getCurrentEditBaseline()?.text === 'A', 'initial disk text should be the current-edit baseline');
assert(tracker.getDiffBaseline('current-edit')?.text === 'A', 'current-edit mode should use the opened disk revision');
assert(tracker.getRecentSaveBaseline() === null, 'opening a document should not invent recent-save history');
assert(tracker.getDiffBaseline('recent-save')?.text === 'A', 'recent-save mode should fall back to the opened disk revision');

assert(tracker.noteDiskRevision('B', 1_000) === true, 'first changed disk revision should be accepted');
assert(tracker.getCurrentEditBaseline()?.text === 'B', 'current-edit baseline should advance on every disk revision');
assert(tracker.getRecentSaveBaseline()?.text === 'A', 'first save should expose the version before the save');
assert(tracker.getDiffBaseline('recent-save')?.text === 'A', 'recent-save mode should prefer actual save history after the first save');

assert(tracker.noteDiskRevision('B', 1_100) === false, 'duplicate save and watcher events should be ignored');
assert(tracker.noteDiskRevision('C', 5_000) === true, 'changed content inside the merge window should be accepted');
assert(tracker.getRecentSaveBaseline()?.text === 'A', 'saves inside a batch should keep the original baseline');

assert(tracker.noteDiskRevision('D', 16_001) === true, 'a later save should start a new batch');
assert(tracker.getCurrentEditBaseline()?.text === 'D', 'latest disk revision should always advance');
assert(tracker.getRecentSaveBaseline()?.text === 'C', 'new batch should compare against the preceding disk revision');

const generation = tracker.getGeneration();
tracker.initialize('D');
assert(tracker.getGeneration() === generation, 'reinitializing identical content should not create a revision');

const explicitSaveTracker = new SavedRevisionTracker({ mergeWindowMs: 10_000 });
explicitSaveTracker.initialize('A');
let explicitPreSaveRevision = explicitSaveTracker.getCurrentEditBaseline();
assert(explicitSaveTracker.noteExplicitSave('B', explicitPreSaveRevision) === true, 'an explicit changed save should create a revision');
assert(explicitSaveTracker.getCurrentEditBaseline()?.text === 'B', 'an explicit changed save should advance the disk revision');
assert(explicitSaveTracker.getRecentSaveBaseline()?.text === 'A', 'the first explicit save should compare against its preceding revision');
explicitPreSaveRevision = explicitSaveTracker.getCurrentEditBaseline();
assert(explicitSaveTracker.noteExplicitSave('B', explicitPreSaveRevision) === true, 're-saving unchanged content should advance the explicit checkpoint');
assert(explicitSaveTracker.getRecentSaveBaseline()?.text === 'B', 'the second explicit save should clear recent-save changes');
explicitPreSaveRevision = explicitSaveTracker.getCurrentEditBaseline();
assert(explicitSaveTracker.noteExplicitSave('B', explicitPreSaveRevision) === false, 'an already-cleared explicit checkpoint should be stable');

const interleavedSaveTracker = new SavedRevisionTracker({ mergeWindowMs: 10_000 });
interleavedSaveTracker.initialize('A');
const capturedPreSaveRevision = interleavedSaveTracker.getCurrentEditBaseline();
interleavedSaveTracker.noteDiskRevision('B', 1_000);
interleavedSaveTracker.noteExplicitSave('B', capturedPreSaveRevision);
assert(interleavedSaveTracker.getRecentSaveBaseline()?.text === 'A', 'an automatic save event must not turn the first explicit save into a repeated save');

console.log('saved revision tracker checks passed');
