import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const adapterPath = path.join(repoRoot, 'webview', 'src', 'editor', 'tableColumnWidthAdapter.ts');
const editorPath = path.join(repoRoot, 'webview', 'src', 'editor.ts');
const tablesPath = path.join(repoRoot, 'webview', 'src', 'helpers', 'tables.ts');
const entryPath = path.join(repoRoot, 'scripts', 'test-table-column-width-adapter-entry.ts');
const productionTracePath = path.join(repoRoot, 'scripts', 'test-source-lightweight-table-column-width.ts');

const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const editorSource = fs.readFileSync(editorPath, 'utf8');
const tablesSource = fs.readFileSync(tablesPath, 'utf8');
const entrySource = fs.readFileSync(entryPath, 'utf8');
const productionTraceSource = fs.readFileSync(productionTracePath, 'utf8');

assert.match(
  adapterSource,
  /type TableColumnWidthAdapter = \{\s*acquire\(\): void;\s*release\(\): void;\s*dispose\(\): void/s
);
assert.doesNotMatch(
  adapterSource,
  /type TableColumnWidthAdapter = \{[^}]*refresh\(\): void/s,
  'the public lifecycle interface must name heavyweight acquisition explicitly'
);
assert.equal(
  (editorSource.match(/createCodeMirrorDomTableColumnWidthAdapter\(\{/g) ?? []).length,
  1
);
assert.equal((editorSource.match(/policy: tableColumnWidthPolicy/g) ?? []).length, 1);
assert.equal((editorSource.match(/tableColumnWidthAdapter\.extension/g) ?? []).length, 1);
assert.equal((editorSource.match(/tableColumnWidthAdapter\.adapter\.dispose\(\)/g) ?? []).length, 1);
assert.equal(editorSource.includes('tableColumnWidthsField'), false);
assert.equal(tablesSource.includes('tableColumnWidthsField'), false);
assert.equal(tablesSource.includes('setTableColumnWidthsEffect'), false);
assert.equal(tablesSource.includes('storedColumnWidths'), false);
assert.equal(tablesSource.includes('startColumnResize'), false);
assert.equal(tablesSource.includes('columnResizeCleanup'), false);
assert.equal(tablesSource.includes('_meoTableResizeObserver'), false);
assert.equal(tablesSource.includes("table.dataset.tableColumnWidth = 'true'"), true);
assert.equal(tablesSource.includes('meo-table-column-width-projected'), true);
assert.equal(tablesSource.includes('tableColumnWidthAdapter'), false);
assert.equal(entrySource.includes('../webview/src/editor.ts'), false);
assert.equal(entrySource.includes('../webview/src/index.ts'), false);
assert.equal(entrySource.includes('../webview/src/helpers/tables'), false);
for (const privateAccess of ['editor.view', '.view.dom', '.view.state', 'getHistoryDepth', 'scrollDOM']) {
  assert.equal(
    productionTraceSource.includes(privateAccess),
    false,
    `production trace must use public editor behavior instead of ${privateAccess}`
  );
}

console.log('table column width adapter interface and production cutover guard passed');
