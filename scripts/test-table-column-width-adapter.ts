import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');
const adapterPath = path.join(repoRoot, 'webview', 'src', 'editor', 'tableColumnWidthAdapter.ts');
const editorPath = path.join(repoRoot, 'webview', 'src', 'editor.ts');
const tablesPath = path.join(repoRoot, 'webview', 'src', 'helpers', 'tables.ts');
const entryPath = path.join(repoRoot, 'scripts', 'test-table-column-width-adapter-entry.ts');

const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const editorSource = fs.readFileSync(editorPath, 'utf8');
const tablesSource = fs.readFileSync(tablesPath, 'utf8');
const entrySource = fs.readFileSync(entryPath, 'utf8');

assert.match(adapterSource, /type TableColumnWidthAdapter = \{\s*accept\(/s);
assert.match(adapterSource, /dispose\(\): void/);
assert.equal(editorSource.includes('tableColumnWidthAdapter'), false);
assert.equal(tablesSource.includes('tableColumnWidthAdapter'), false);
assert.equal(entrySource.includes('../webview/src/editor.ts'), false);
assert.equal(entrySource.includes('../webview/src/index.ts'), false);
assert.equal(entrySource.includes('../webview/src/helpers/tables'), false);

console.log('table column width adapter interface and production guard passed');
