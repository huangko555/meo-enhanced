import assert from 'node:assert/strict';
import { mock } from 'bun:test';

let enabled = true;
mock.module('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => enabled ?? fallback })
  }
}));

const {
  createVscodeReadingPositionAdapter,
  READING_POSITION_WORKSPACE_STATE_KEY
} = await import('../src/host/vscodeReadingPositionAdapter');

type FakeUri = {
  readonly scheme: string;
  readonly fragment: string;
  readonly query: string;
  with(changes: { fragment?: string; query?: string }): FakeUri;
  toString(): string;
};
const createUri = (scheme: string, path: string, fragment = '', query = ''): FakeUri => ({
  scheme,
  fragment,
  query,
  with(changes) {
    return createUri(scheme, path, changes.fragment ?? fragment, changes.query ?? query);
  },
  toString() {
    return `${scheme}://${path}${query ? `?${query}` : ''}${fragment ? `#${fragment}` : ''}`;
  }
});

const state = new Map<string, unknown>([[
  READING_POSITION_WORKSPACE_STATE_KEY,
  { 'file://notes/readme.md': { line: 80, lineOffset: 4, updatedAt: 1 } }
]]);
let updates = 0;
const context = {
  workspaceState: {
    get: (key: string) => state.get(key),
    update: async (key: string, value: unknown) => {
      updates += 1;
      state.set(key, value);
    }
  }
};

const file = createVscodeReadingPositionAdapter(context as never, {
  isUntitled: false,
  lineCount: 50,
  uri: createUri('file', 'notes/readme.md', 'heading', 'view=1')
} as never, () => enabled);
assert.deepEqual(file.readInitial(), { line: 50, lineOffset: 4 });
await file.remember({ line: 20, lineOffset: 1.5 });
assert.equal(updates, 1);
const saved = (state.get(READING_POSITION_WORKSPACE_STATE_KEY) as Record<string, any>)['file://notes/readme.md'];
assert.deepEqual({ line: saved.line, lineOffset: saved.lineOffset }, { line: 20, lineOffset: 1.5 });
assert.equal(typeof saved.updatedAt, 'number');

for (const document of [
  { isUntitled: true, lineCount: 10, uri: createUri('file', 'notes/draft.md') },
  { isUntitled: false, lineCount: 10, uri: createUri('untitled', 'draft.md') }
]) {
  const adapter = createVscodeReadingPositionAdapter(context as never, document as never, () => enabled);
  assert.equal(adapter.readInitial(), null);
  await adapter.remember({ line: 5, lineOffset: 0 });
}
assert.equal(updates, 1, 'untitled and non-file resources must not write');

enabled = false;
assert.equal(file.readInitial(), null);
await file.remember({ line: 30, lineOffset: 0 });
assert.equal(updates, 1);

enabled = true;
const concurrentState = new Map<string, unknown>();
let releaseFirstWrite: (() => void) | null = null;
let firstWrite = true;
const concurrentContext = {
  workspaceState: {
    get: (key: string) => concurrentState.get(key),
    update: async (key: string, value: unknown) => {
      if (firstWrite) {
        firstWrite = false;
        await new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
      }
      concurrentState.set(key, value);
    }
  }
};
const firstDocument = createVscodeReadingPositionAdapter(concurrentContext as never, {
  isUntitled: false, lineCount: 20, uri: createUri('file', 'notes/first.md')
} as never, () => enabled);
const secondDocument = createVscodeReadingPositionAdapter(concurrentContext as never, {
  isUntitled: false, lineCount: 20, uri: createUri('file', 'notes/second.md')
} as never, () => enabled);
const firstPending = firstDocument.remember({ line: 8, lineOffset: 0 });
while (releaseFirstWrite === null) await Promise.resolve();
const secondPending = secondDocument.remember({ line: 9, lineOffset: 0 });
releaseFirstWrite();
await Promise.all([firstPending, secondPending]);
assert.deepEqual(
  Object.keys(concurrentState.get(READING_POSITION_WORKSPACE_STATE_KEY) as Record<string, unknown>).sort(),
  ['file://notes/first.md', 'file://notes/second.md'],
  'concurrent panels must merge through one workspaceState write queue'
);

console.log('VS Code reading position adapter checks passed');
