import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tableColumnWidthPolicy } from '../webview/src/editor/tableColumnWidthPolicy';

const unconstrained = tableColumnWidthPolicy.resize({
  widths: [100, 100, 100],
  minimumWidths: [20, 20, 20],
  column: 0,
  requestedDelta: 50,
  maximumTotalWidth: 400
});
assert.deepEqual(unconstrained.widths, [150, 100, 100]);
assert.equal(unconstrained.totalWidth, 350);

const compressed = tableColumnWidthPolicy.resize({
  widths: [100, 100, 100],
  minimumWidths: [20, 20, 20],
  column: 0,
  requestedDelta: 150,
  maximumTotalWidth: 400
});
assert.deepEqual(compressed.widths.map(Math.round), [250, 75, 75]);
assert.equal(Math.round(compressed.totalWidth), 400);

const clamped = tableColumnWidthPolicy.resize({
  widths: [100, 100, 100],
  minimumWidths: [24, 20, 20],
  column: 0,
  requestedDelta: -200,
  maximumTotalWidth: 400
});
assert.deepEqual(clamped.widths, [24, 100, 100]);

const blockedByRightMinimums = tableColumnWidthPolicy.resize({
  widths: [180, 60, 60],
  minimumWidths: [20, 55, 55],
  column: 0,
  requestedDelta: 100,
  maximumTotalWidth: 300
});
assert.deepEqual(blockedByRightMinimums.widths.map(Math.round), [190, 55, 55]);

const projectedNarrow = tableColumnWidthPolicy.project({
  widths: [240, 120],
  initialTotalWidth: 480,
  elastic: true,
  defaultWidthWasCapped: true,
  availableWidth: 300
});
assert.deepEqual(projectedNarrow.widths.map(Math.round), [200, 100]);
assert.equal(Math.round(projectedNarrow.totalWidth), 300);
assert.equal(projectedNarrow.reachedAvailableWidth, true);

const projectedWide = tableColumnWidthPolicy.project({
  widths: [240, 120],
  initialTotalWidth: 480,
  elastic: true,
  defaultWidthWasCapped: false,
  availableWidth: 420
});
assert.deepEqual(projectedWide.widths.map(Math.round), [280, 140]);
assert.equal(Math.round(projectedWide.totalWidth), 420);

const fixed = tableColumnWidthPolicy.project({
  widths: [120, 80],
  initialTotalWidth: 300,
  elastic: false,
  defaultWidthWasCapped: false,
  availableWidth: 500
});
assert.deepEqual(fixed.widths, [120, 80]);
assert.equal(fixed.totalWidth, 200);
assert.equal(fixed.reachedAvailableWidth, false);

const policySource = readFileSync(
  new URL('../webview/src/editor/tableColumnWidthPolicy.ts', import.meta.url),
  'utf8'
);
assert.equal(
  /@codemirror|\b(?:DOMRect|HTMLElement|PointerEvent|ResizeObserver|Transaction|StateField|DocumentSession|Revision|Draft|Change)\b/.test(policySource),
  false,
  'the pure width policy must not own editor, DOM, document, or history state'
);
for (const requiredRule of [
  'minimumWidths',
  'availableRightCompression',
  'defaultWidthWasCapped',
  'initialTotalWidth'
]) {
  assert.equal(
    policySource.includes(requiredRule),
    true,
    `deleting the policy would leak a width constraint back into callers: ${requiredRule}`
  );
}
const editorSource = readFileSync(new URL('../webview/src/editor.ts', import.meta.url), 'utf8');
const tablesSource = readFileSync(new URL('../webview/src/helpers/tables.ts', import.meta.url), 'utf8');
assert.equal(
  (editorSource.match(/policy: tableColumnWidthPolicy/g) ?? []).length,
  1,
  'production must inject exactly one table column width policy'
);
assert.equal(
  tablesSource.includes('tableColumnWidthPolicy'),
  false,
  'the table widget must not own or call the width policy directly'
);

console.log('table column width policy contracts passed');
