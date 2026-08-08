import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createTableTransactionProvenance } from '../webview/src/application/tableTransactionProvenance';

const provenance = createTableTransactionProvenance();
const initial = provenance.snapshot();
assert.deepEqual(initial, { lifecycle: 'active', scope: 0, insertedRows: [], deletedRows: [] });

assert.deepEqual(provenance.accept({
  type: 'transaction',
  scope: initial.scope,
  changes: [],
  mutations: [
    { type: 'markInsertedRow', id: 'insert-1', from: 12, to: 20 },
    {
      type: 'markDeletedRows',
      id: 'delete-1',
      at: 30,
      baselineRanges: [[4, 5]],
      deletionAtEnd: false
    }
  ]
}), {
  lifecycle: 'active',
  scope: 0,
  insertedRows: [{ id: 'insert-1', from: 12, to: 20 }],
  deletedRows: [{ id: 'delete-1', at: 30, baselineRanges: [[4, 5]], deletionAtEnd: false }]
});

const ambiguous = createTableTransactionProvenance();
ambiguous.accept({
  type: 'transaction', scope: 0, changes: [], mutations: [
    { type: 'markInsertedRow', id: 'table-a-empty-1', from: 10, to: 20 },
    { type: 'markInsertedRow', id: 'table-a-empty-2', from: 21, to: 31 },
    { type: 'markInsertedRow', id: 'table-b-row', from: 100, to: 110 },
    { type: 'markDeletedRows', id: 'delete-a', at: 32, baselineRanges: [[4, 4]], deletionAtEnd: false },
    { type: 'markDeletedRows', id: 'delete-b', at: 32, baselineRanges: [[5, 6]], deletionAtEnd: false }
  ]
});

// A whole-table serialization can be one-to-many, many-to-one or many-to-many.
// The Adapter supplies surviving row identities; row text equality is deliberately irrelevant.
assert.deepEqual(ambiguous.accept({
  type: 'transaction',
  scope: 0,
  changes: [{ from: 5, to: 40, insertedLength: 50 }],
  mutations: [{
    type: 'remapInsertedRows',
    rows: [
      { id: 'table-a-empty-1', from: 12, to: 22 },
      { id: 'table-a-empty-2', from: 30, to: 40 }
    ]
  }]
}), {
  lifecycle: 'active', scope: 0,
  insertedRows: [
    { id: 'table-a-empty-1', from: 12, to: 22 },
    { id: 'table-a-empty-2', from: 30, to: 40 },
    { id: 'table-b-row', from: 115, to: 125 }
  ],
  deletedRows: [
    { id: 'delete-a', at: 55, baselineRanges: [[4, 4]], deletionAtEnd: false },
    { id: 'delete-b', at: 55, baselineRanges: [[5, 6]], deletionAtEnd: false }
  ]
});

assert.deepEqual(ambiguous.accept({ type: 'externalDocumentPresented' }), {
  lifecycle: 'active', scope: 1, insertedRows: [], deletedRows: []
});
ambiguous.accept({
  type: 'transaction', scope: 1, changes: [],
  mutations: [{ type: 'markInsertedRow', id: 'new-document', from: 8, to: 12 }]
});
assert.deepEqual(ambiguous.accept({
  type: 'transaction',
  scope: 0,
  changes: [{ from: 0, to: 0, insertedLength: 3 }],
  mutations: [{ type: 'markInsertedRow', id: 'stale-history', from: 1, to: 2 }]
}), {
  lifecycle: 'active', scope: 1,
  insertedRows: [{ id: 'new-document', from: 11, to: 15 }],
  deletedRows: []
});

const deletionBoundary = createTableTransactionProvenance();
deletionBoundary.accept({
  type: 'transaction', scope: 0, changes: [], mutations: [
    { type: 'markDeletedRows', id: 'middle', at: 20, baselineRanges: [[7, 7]], deletionAtEnd: false },
    { type: 'markDeletedRows', id: 'end', at: 20, baselineRanges: [[8, 9]], deletionAtEnd: true }
  ]
});
assert.deepEqual(deletionBoundary.accept({
  type: 'transaction', scope: 0,
  changes: [{ from: 20, to: 20, insertedLength: 4 }],
  mutations: []
}).deletedRows, [
  { id: 'end', at: 20, baselineRanges: [[8, 9]], deletionAtEnd: true },
  { id: 'middle', at: 24, baselineRanges: [[7, 7]], deletionAtEnd: false }
]);
assert.deepEqual(deletionBoundary.accept({
  type: 'transaction', scope: 0, changes: [],
  mutations: [{ type: 'removeDeletedRows', id: 'middle' }]
}).deletedRows, [
  { id: 'end', at: 20, baselineRanges: [[8, 9]], deletionAtEnd: true }
]);
assert.deepEqual(deletionBoundary.accept({
  type: 'transaction', scope: 0, changes: [],
  mutations: [{
    type: 'markDeletedRows', id: 'middle', at: 24, baselineRanges: [[7, 7]], deletionAtEnd: false
  }]
}).deletedRows, [
  { id: 'end', at: 20, baselineRanges: [[8, 9]], deletionAtEnd: true },
  { id: 'middle', at: 24, baselineRanges: [[7, 7]], deletionAtEnd: false }
]);

assert.deepEqual(provenance.accept({
  type: 'transaction',
  scope: 0,
  changes: [{ from: 0, to: 0, insertedLength: 5 }],
  mutations: []
}), {
  lifecycle: 'active', scope: 0,
  insertedRows: [{ id: 'insert-1', from: 17, to: 25 }],
  deletedRows: [{ id: 'delete-1', at: 35, baselineRanges: [[4, 5]], deletionAtEnd: false }]
});

assert.deepEqual(provenance.accept({
  type: 'transaction',
  scope: 0,
  changes: [{ from: 17, to: 25, insertedLength: 3 }],
  mutations: []
}), {
  lifecycle: 'active', scope: 0, insertedRows: [],
  deletedRows: [{ id: 'delete-1', at: 30, baselineRanges: [[4, 5]], deletionAtEnd: false }]
});

// Native undo/redo owns history. Its Adapter replays inverse provenance mutations
// under the same scope; the Module owns only the current hints.
assert.deepEqual(provenance.accept({
  type: 'transaction',
  scope: 0,
  changes: [{ from: 17, to: 20, insertedLength: 8 }],
  mutations: [{ type: 'markInsertedRow', id: 'insert-1', from: 17, to: 25 }]
}), {
  lifecycle: 'active', scope: 0,
  insertedRows: [{ id: 'insert-1', from: 17, to: 25 }],
  deletedRows: [{ id: 'delete-1', at: 35, baselineRanges: [[4, 5]], deletionAtEnd: false }]
});

assert.deepEqual(provenance.accept({
  type: 'transaction',
  scope: 0,
  changes: [{ from: 17, to: 25, insertedLength: 3 }],
  mutations: [{ type: 'removeInsertedRow', id: 'insert-1' }]
}), {
  lifecycle: 'active', scope: 0, insertedRows: [],
  deletedRows: [{ id: 'delete-1', at: 30, baselineRanges: [[4, 5]], deletionAtEnd: false }]
});

assert.deepEqual(provenance.accept({ type: 'baselineRefreshed' }), {
  lifecycle: 'active', scope: 1, insertedRows: [], deletedRows: []
});
assert.deepEqual(provenance.accept({ type: 'dispose' }), {
  lifecycle: 'disposed', scope: 2, insertedRows: [], deletedRows: []
});
assert.deepEqual(provenance.accept({
  type: 'transaction',
  scope: 2,
  changes: [],
  mutations: [{ type: 'markInsertedRow', id: 'late', from: 0, to: 1 }]
}), {
  lifecycle: 'disposed', scope: 2, insertedRows: [], deletedRows: []
});

const applicationSource = readFileSync(
  new URL('../webview/src/application/tableTransactionProvenance.ts', import.meta.url),
  'utf8'
);
const adapterSource = readFileSync(
  new URL('../webview/src/adapters/codeMirrorTableTransactionProvenanceAdapter.ts', import.meta.url),
  'utf8'
);
const adapterInterfaceSource = readFileSync(
  new URL('../webview/src/adapters/tableTransactionProvenance.ts', import.meta.url),
  'utf8'
);
const gitDiffSource = readFileSync(
  new URL('../webview/src/helpers/gitDiffGutter.ts', import.meta.url),
  'utf8'
);
assert.equal(
  /from ['"]@codemirror|\b(?:StateField|StateEffect|Decoration|EditorView|HTMLElement|DocumentSession|GitBaseline)\s*[<|=]/.test(applicationSource),
  false,
  'the provenance Interface must not expose editor, DOM, Document Session, history, or baseline owners'
);
assert.equal(adapterSource.includes('tableRowDiffProvenance'), false, 'candidate Adapter must not depend on Legacy');
assert.equal(
  existsSync(new URL('../webview/src/helpers/tableRowDiffProvenance.ts', import.meta.url)),
  false,
  'the replaced Legacy StateField must not remain in the repository'
);
assert.equal(/(?:historyEntries|historyDepth|documentText|diffBaseline)\s*[=:]/.test(adapterSource), false);
for (const requiredBoundary of ['invertedEffects', 'iterChanges', 'mapPos', 'lineAt', 'dispose']) {
  assert.equal(
    adapterSource.includes(requiredBoundary), true,
    `Adapter deletion would leak a required CodeMirror/lifecycle rule: ${requiredBoundary}`
  );
}
assert.equal(adapterSource.includes('StateField.define<TableTransactionProvenance>'), true);
assert.equal(adapterSource.includes('update(update)'), false, 'provenance must advance before gutter StateFields');
assert.equal(adapterSource.includes('let disposed ='), false, 'the pure Module must own provenance lifecycle');
assert.equal(adapterInterfaceSource.includes('values.length > 1'), true, 'duplicate production Adapters must fail');
const editorSource = readFileSync(new URL('../webview/src/editor.ts', import.meta.url), 'utf8');
assert.equal(
  (editorSource.match(/createCodeMirrorTableTransactionProvenanceAdapter\(/g) ?? []).length,
  1,
  'production Editor must create exactly one table provenance Adapter'
);
assert.equal(editorSource.includes('tableTransactionProvenanceAdapter.dispose()'), true);
assert.equal(
  editorSource.includes("tableTransactionProvenanceAdapter.effect({ type: 'baselineRefreshed' })"),
  true,
  'the Editor boundary must coordinate baseline reset with provenance invalidation'
);
assert.equal(
  gitDiffSource.includes('getTableTransactionProvenance('),
  false,
  'the git diff gutter may only read provenance snapshots'
);
assert.equal(
  (editorSource.match(/tableTransactionProvenanceAdapter\.effect\(\{ type: 'externalDocumentPresented' \}\)/g) ?? []).length,
  2,
  'equal and changed external presentations must both invalidate provenance'
);
for (const relativePath of [
  '../webview/src/editor.ts',
  '../webview/src/helpers/tables.ts',
  '../webview/src/helpers/gitDiffGutter.ts'
]) {
  const productionSource = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  assert.equal(
    productionSource.includes('tableRowDiffProvenance'),
    false,
    `Legacy table provenance must be unreachable from production: ${relativePath}`
  );
}
for (const relativePath of [
  '../webview/src/helpers/tables.ts',
  '../webview/src/helpers/gitDiffGutter.ts'
]) {
  const productionSource = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
  assert.equal(
    productionSource.includes('../adapters/codeMirrorTableTransactionProvenanceAdapter'),
    false,
    `only the Editor Bootstrap may import the concrete Adapter: ${relativePath}`
  );
}

console.log('table transaction provenance contracts passed');
