import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type {
  TableWidgetLayoutScheduler,
  TableStickyHeaderAdapter
} from '../webview/src/editor/tableStickyHeaderAdapter';
import { createCodeMirrorDomTableStickyHeaderAdapter } from '../webview/src/editor/internal/codeMirrorDomTableStickyHeaderAdapter';

const schedulerShape: TableWidgetLayoutScheduler = {
  register() {
    return { request() {}, dispose() {} };
  }
};
void schedulerShape;

const adapterShape: TableStickyHeaderAdapter = {
  mount() {},
  update() {},
  invalidate() {},
  unmount() {},
  dispose() {}
};
void adapterShape;
assert.equal(typeof createCodeMirrorDomTableStickyHeaderAdapter, 'function');

const adapterSource = readFileSync(
  new URL('../webview/src/editor/internal/codeMirrorDomTableStickyHeaderAdapter.ts', import.meta.url),
  'utf8'
);
assert.equal(/requestAnimationFrame|cancelAnimationFrame/.test(adapterSource), false);
assert.equal(/@codemirror|DocumentSession|Revision|Draft|Change|TableTransactionProvenance/.test(adapterSource), false);
const editorSource = readFileSync(new URL('../webview/src/editor.ts', import.meta.url), 'utf8');
const tablesSource = readFileSync(new URL('../webview/src/helpers/tables.ts', import.meta.url), 'utf8');
assert.equal(editorSource.includes('codeMirrorDomTableStickyHeaderAdapter'), true);
assert.equal(editorSource.includes('tableStickyHeaderAdapterFactoryFacet.of'), true);
assert.equal(tablesSource.includes('codeMirrorDomTableStickyHeaderAdapter'), false);
assert.equal(tablesSource.includes('tableStickyHeaderPolicy'), false);
assert.equal(tablesSource.includes('TableStickyHeaderAdapterFactory'), true);
assert.equal(tablesSource.includes('this.stickyHeaderAdapter.mount()'), true);
assert.equal(tablesSource.includes('this.stickyHeaderAdapter.update()'), true);
assert.equal(tablesSource.includes('this.stickyHeaderAdapter.unmount()'), true);
assert.equal(tablesSource.includes('this.stickyHeaderAdapter.dispose()'), true);
assert.equal((tablesSource.match(/this\.layoutFrame = requestAnimationFrame/g) ?? []).length, 1);
assert.equal((tablesSource.match(/cancelAnimationFrame\(this\.layoutFrame\)/g) ?? []).length, 1);
assert.equal((editorSource.match(/createCodeMirrorDomTableStickyHeaderAdapter\(/g) ?? []).length, 1);
for (const removedLegacyRule of [
  'refreshStickyHeaderContent',
  'hideStickyHeader',
  'updateStickyHeader()'
]) {
  assert.equal(tablesSource.includes(removedLegacyRule), false, `Legacy Sticky rule returned: ${removedLegacyRule}`);
}

console.log('table sticky header adapter contracts passed');
