import assert from 'node:assert/strict';
import { createReadingPositionMemory } from '../src/application/readingPositionMemory';

let stored: unknown = {
  'file:///current.md': { line: 800, lineOffset: 3.456, updatedAt: 4 },
  'file:///recent.md': { line: 5, lineOffset: 0, updatedAt: 3 },
  'file:///old.md': { line: 2, lineOffset: 0, updatedAt: 1 },
  'file:///broken.md': { line: 0, lineOffset: -1, updatedAt: 9 }
};
let writes = 0;
let enabled = true;
const memory = createReadingPositionMemory({
  documentKey: 'file:///current.md',
  getDocumentLineCount: () => 100,
  isEnabled: () => enabled,
  capacity: 3,
  now: () => 10,
  storage: {
    read: () => stored,
    update: async (transform) => {
      writes += 1;
      stored = transform(stored);
    }
  }
});

assert.deepEqual(memory.readInitial(), { line: 100, lineOffset: 3.46 });
await memory.remember({ line: 60, lineOffset: 7.777 });
assert.equal(writes, 1);
assert.deepEqual(stored, {
  'file:///current.md': { line: 60, lineOffset: 7.78, updatedAt: 10 },
  'file:///recent.md': { line: 5, lineOffset: 0, updatedAt: 3 },
  'file:///old.md': { line: 2, lineOffset: 0, updatedAt: 1 }
});
await memory.remember({ line: 60, lineOffset: 7.777 });
assert.equal(writes, 1, 'equal positions must be deduplicated within one panel session');

enabled = false;
assert.equal(memory.readInitial(), null);
await memory.remember({ line: 70, lineOffset: 0 });
assert.equal(writes, 1, 'disabled persistence must not write');

let unstableWrites = 0;
const unstable = createReadingPositionMemory({
  documentKey: null,
  getDocumentLineCount: () => 10,
  isEnabled: () => true,
  storage: {
    read: () => ({ 'file:///other.md': { line: 4, lineOffset: 0, updatedAt: 1 } }),
    update: async () => { unstableWrites += 1; }
  }
});
assert.equal(unstable.readInitial(), null);
await unstable.remember({ line: 4, lineOffset: 0 });
assert.equal(unstableWrites, 0, 'unstable resources must not participate in persistence');

console.log('Reading position memory checks passed');
