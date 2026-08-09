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
  refreshContent() {},
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
for (const requiredDepth of [
  'ResizeObserver',
  'MutationObserver',
  'refreshContent',
  'applyLayout',
  'unmount',
  'generation'
]) {
  assert.equal(adapterSource.includes(requiredDepth), true, `adapter lost deep lifecycle rule: ${requiredDepth}`);
}

const editorSource = readFileSync(new URL('../webview/src/editor.ts', import.meta.url), 'utf8');
const tablesSource = readFileSync(new URL('../webview/src/helpers/tables.ts', import.meta.url), 'utf8');
for (const source of [editorSource, tablesSource]) {
  assert.equal(source.includes('codeMirrorDomTableStickyHeaderAdapter'), false);
  assert.equal(source.includes('TableStickyHeaderAdapter'), false);
}

console.log('table sticky header adapter contracts passed');
