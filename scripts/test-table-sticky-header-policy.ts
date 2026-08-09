import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tableStickyHeaderPolicy } from '../webview/src/editor/tableStickyHeaderPolicy';

const common = {
  scroller: { top: 10, left: 20, right: 420, height: 300 },
  table: { top: -40, left: -30, right: 530, bottom: 600, height: 640, width: 560 },
  header: { top: 0, height: 32 },
  controlsVisible: false
} as const;

assert.deepEqual(tableStickyHeaderPolicy.layout({
  ...common,
  table: { ...common.table, height: 149 }
}), { visible: false, reason: 'table-too-short' });

assert.deepEqual(tableStickyHeaderPolicy.layout({
  ...common,
  header: { ...common.header, top: 11 }
}), { visible: false, reason: 'before-threshold' });

assert.deepEqual(tableStickyHeaderPolicy.layout({
  ...common,
  table: { ...common.table, bottom: 44 }
}), { visible: false, reason: 'insufficient-content' });

assert.deepEqual(tableStickyHeaderPolicy.layout({
  ...common,
  table: { ...common.table, left: 430, right: 700 }
}), { visible: false, reason: 'outside-horizontal-viewport' });

assert.deepEqual(tableStickyHeaderPolicy.layout(common), {
  visible: true,
  top: 10,
  left: 20,
  width: 400,
  height: 35,
  headerHeight: 32,
  tableWidth: 560,
  translateX: -50,
  controlsHeight: 0
});

assert.deepEqual(tableStickyHeaderPolicy.layout({
  ...common,
  header: { ...common.header, top: 34 },
  controlsVisible: true
}), {
  visible: true,
  top: 10,
  left: 20,
  width: 400,
  height: 59,
  headerHeight: 32,
  tableWidth: 560,
  translateX: -50,
  controlsHeight: 24
});

const policySource = readFileSync(
  new URL('../webview/src/editor/tableStickyHeaderPolicy.ts', import.meta.url),
  'utf8'
);
assert.equal(
  /@codemirror|\b(?:DOMRect|HTMLElement|PointerEvent|ResizeObserver|MutationObserver|requestAnimationFrame|DocumentSession|Revision|Draft|Change)\b/.test(policySource),
  false,
  'the pure sticky header policy must not own editor, DOM, document, observer, or frame state'
);
for (const requiredRule of [
  'minimumTableViewportRatio',
  'separatorDepth',
  'controlsHeight',
  'visibleLeft',
  'enoughContentRemains'
]) {
  assert.equal(
    policySource.includes(requiredRule),
    true,
    `deleting the policy would leak a sticky layout rule back into callers: ${requiredRule}`
  );
}

const editorSource = readFileSync(new URL('../webview/src/editor.ts', import.meta.url), 'utf8');
const tablesSource = readFileSync(new URL('../webview/src/helpers/tables.ts', import.meta.url), 'utf8');
assert.equal(editorSource.includes('tableStickyHeaderPolicy'), false);
assert.equal(tablesSource.includes('tableStickyHeaderPolicy'), false);

console.log('table sticky header policy contracts passed');
