import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tableColumnWidthPolicy } from '../webview/src/editor/tableColumnWidthPolicy';

const unconstrained = tableColumnWidthPolicy.resize({
  widths: [100, 100, 100],
  minimumWidths: [20, 20, 20],
  elastic: false,
  column: 0,
  requestedDelta: 50,
  maximumTotalWidth: 400
});
assert.deepEqual(unconstrained.widths, [150, 100, 100]);
assert.equal(unconstrained.totalWidth, 350);

const compressed = tableColumnWidthPolicy.resize({
  widths: [100, 100, 100],
  minimumWidths: [20, 20, 20],
  elastic: true,
  column: 0,
  requestedDelta: 150,
  maximumTotalWidth: 400
});
assert.deepEqual(compressed.widths.map(Math.round), [250, 75, 75]);
assert.equal(Math.round(compressed.totalWidth), 400);

const clamped = tableColumnWidthPolicy.resize({
  widths: [100, 100, 100],
  minimumWidths: [24, 20, 20],
  elastic: true,
  column: 0,
  requestedDelta: -200,
  maximumTotalWidth: 400
});
assert.deepEqual(clamped.widths, [24, 100, 100]);

const blockedByRightMinimums = tableColumnWidthPolicy.resize({
  widths: [180, 60, 60],
  minimumWidths: [20, 55, 55],
  elastic: true,
  column: 0,
  requestedDelta: 100,
  maximumTotalWidth: 300
});
assert.deepEqual(blockedByRightMinimums.widths.map(Math.round), [190, 55, 55]);

const resizedInsideInfeasibleContainer = tableColumnWidthPolicy.resize({
  widths: [180, 100, 50],
  minimumWidths: [180, 100, 50],
  elastic: true,
  column: 2,
  requestedDelta: 24,
  maximumTotalWidth: 300
});
assert.deepEqual(
  resizedInsideInfeasibleContainer.widths,
  [180, 100, 74],
  'an accessible overflow table keeps every minimum and lets the active column grow'
);
assert.equal(
  resizedInsideInfeasibleContainer.elastic,
  true,
  'growing inside an infeasible container keeps the current elastic transaction'
);

const narrowedInsideInfeasibleContainer = tableColumnWidthPolicy.resize({
  widths: resizedInsideInfeasibleContainer.widths,
  minimumWidths: [180, 100, 50],
  elastic: resizedInsideInfeasibleContainer.elastic,
  column: 2,
  requestedDelta: -12,
  maximumTotalWidth: 300
});
assert.deepEqual(narrowedInsideInfeasibleContainer.widths, [180, 100, 62]);
assert.equal(
  narrowedInsideInfeasibleContainer.elastic,
  false,
  'an active column that finishes narrower than its drag-start width exits elastic behavior'
);

for (const [label, requestedDelta, expectedElastic] of [
  ['no change', 0, true],
  ['growth', 12, true],
  ['sub-pixel shrink within the existing tolerance', -0.5, true]
] as const) {
  const result = tableColumnWidthPolicy.resize({
    widths: [180, 100, 74],
    minimumWidths: [180, 100, 50],
    elastic: true,
    column: 2,
    requestedDelta,
    maximumTotalWidth: 300
  });
  assert.equal(result.elastic, expectedElastic, `${label} must not falsely exit elastic behavior`);
}

const fixedNoChange = tableColumnWidthPolicy.resize({
  widths: [180, 100, 70],
  minimumWidths: [180, 100, 50],
  elastic: false,
  column: 2,
  requestedDelta: 0,
  maximumTotalWidth: 300
});
assert.equal(fixedNoChange.elastic, false, 'no-change must not re-enter elastic behavior');
const fixedExplicitGrowth = tableColumnWidthPolicy.resize({
  widths: [180, 100, 70],
  minimumWidths: [180, 100, 50],
  elastic: false,
  column: 2,
  requestedDelta: 12,
  maximumTotalWidth: 300
});
assert.equal(fixedExplicitGrowth.elastic, true, 'a later explicit growth may re-enter elastic behavior');

const reenteredElastic = tableColumnWidthPolicy.resize({
  widths: [100, 100],
  minimumWidths: [20, 20],
  elastic: false,
  tracksAvailableWidth: false,
  column: 0,
  requestedDelta: 100,
  maximumTotalWidth: 300
});
assert.deepEqual(reenteredElastic.widths, [200, 100]);
assert.equal(reenteredElastic.elastic, true);
assert.equal(
  reenteredElastic.tracksAvailableWidth,
  true,
  'an explicit grow that re-enters elastic mode must record the container-width baseline'
);
const expandedAfterReentry = tableColumnWidthPolicy.project({
  widths: reenteredElastic.widths,
  minimumWidths: [20, 20],
  preserveWidthIntent: false,
  initialTotalWidth: 200,
  elastic: reenteredElastic.elastic,
  tracksAvailableWidth: reenteredElastic.tracksAvailableWidth,
  defaultWidthWasCapped: false,
  availableWidth: 500
});
assert.equal(
  Math.round(expandedAfterReentry.totalWidth),
  500,
  'container growth after explicit re-entry must not remain locked to the initial/requested total'
);
const noChangeAfterReentry = tableColumnWidthPolicy.resize({
  widths: reenteredElastic.widths,
  minimumWidths: [20, 20],
  elastic: reenteredElastic.elastic,
  tracksAvailableWidth: reenteredElastic.tracksAvailableWidth,
  column: 0,
  requestedDelta: 0,
  maximumTotalWidth: 300
});
assert.equal(noChangeAfterReentry.tracksAvailableWidth, true, 'no-change preserves active tracking');
const shrinkAfterReentry = tableColumnWidthPolicy.resize({
  widths: reenteredElastic.widths,
  minimumWidths: [20, 20],
  elastic: reenteredElastic.elastic,
  tracksAvailableWidth: reenteredElastic.tracksAvailableWidth,
  column: 0,
  requestedDelta: -20,
  maximumTotalWidth: 500
});
assert.equal(shrinkAfterReentry.elastic, false);
assert.equal(shrinkAfterReentry.tracksAvailableWidth, false, 'an active shrink exits container tracking');

const preservedCommittedPreview = tableColumnWidthPolicy.project({
  widths: [180, 100, 74],
  minimumWidths: [180, 110, 50],
  preserveWidthIntent: true,
  initialTotalWidth: 330,
  elastic: true,
  defaultWidthWasCapped: true,
  availableWidth: 300
});
assert.deepEqual(
  preservedCommittedPreview.widths,
  [180, 110, 74],
  'same-container transaction replay preserves the preview while honoring newer readable minimums'
);
assert.equal(preservedCommittedPreview.elastic, true);

const projectedNarrow = tableColumnWidthPolicy.project({
  widths: [240, 120],
  minimumWidths: [0, 0],
  preserveWidthIntent: false,
  initialTotalWidth: 480,
  elastic: true,
  defaultWidthWasCapped: true,
  availableWidth: 300
});
assert.deepEqual(projectedNarrow.widths.map(Math.round), [200, 100]);
assert.equal(Math.round(projectedNarrow.totalWidth), 300);
assert.equal(projectedNarrow.reachedAvailableWidth, true);

const projectedBelowReadableMinimums = tableColumnWidthPolicy.project({
  widths: [240, 120, 60],
  minimumWidths: [180, 100, 50],
  preserveWidthIntent: false,
  initialTotalWidth: 420,
  elastic: true,
  defaultWidthWasCapped: true,
  availableWidth: 300
});
assert.deepEqual(
  projectedBelowReadableMinimums.widths.map(Math.round),
  [180, 100, 50],
  'readable per-column minimums take priority over an infeasible container width'
);
assert.equal(Math.round(projectedBelowReadableMinimums.totalWidth), 330);
assert.equal(projectedBelowReadableMinimums.reachedAvailableWidth, true);

const projectedWithHeterogeneousMinimums = tableColumnWidthPolicy.project({
  widths: [200, 160, 100],
  minimumWidths: [120, 80, 60],
  preserveWidthIntent: false,
  initialTotalWidth: 460,
  elastic: true,
  defaultWidthWasCapped: true,
  availableWidth: 360
});
assert.deepEqual(
  projectedWithHeterogeneousMinimums.widths.map(Math.round),
  [160, 120, 80],
  'remaining width is distributed in proportion to each column\'s elasticity above its own minimum'
);
assert.equal(Math.round(projectedWithHeterogeneousMinimums.totalWidth), 360);

const projectedFromZeroElasticity = tableColumnWidthPolicy.project({
  widths: [100, 50],
  minimumWidths: [100, 50],
  preserveWidthIntent: false,
  initialTotalWidth: 300,
  elastic: true,
  defaultWidthWasCapped: true,
  availableWidth: 300
});
assert.deepEqual(
  projectedFromZeroElasticity.widths.map(Math.round),
  [200, 100],
  'an elastic table with no remaining headroom expands by its readable-width proportions'
);

for (const [label, minimumWidths, expectedError] of [
  ['length mismatch', [20], RangeError],
  ['NaN', [20, Number.NaN], TypeError],
  ['Infinity', [20, Number.POSITIVE_INFINITY], TypeError],
  ['negative', [20, -1], TypeError]
] as const) {
  assert.throws(() => tableColumnWidthPolicy.project({
    widths: [120, 80],
    minimumWidths,
    preserveWidthIntent: false,
    initialTotalWidth: 200,
    elastic: true,
    defaultWidthWasCapped: true,
    availableWidth: 160
  }), expectedError, `project rejects ${label} minimumWidths`);
}

const roundTripStart = [240, 160, 100];
const roundTripMinimums = [120, 60, 40];
const roundTripNarrow = tableColumnWidthPolicy.project({
  widths: roundTripStart,
  minimumWidths: roundTripMinimums,
  preserveWidthIntent: false,
  initialTotalWidth: 500,
  elastic: true,
  defaultWidthWasCapped: true,
  availableWidth: 360
});
const roundTripWide = tableColumnWidthPolicy.project({
  widths: roundTripNarrow.widths,
  minimumWidths: roundTripMinimums,
  preserveWidthIntent: false,
  initialTotalWidth: 500,
  elastic: true,
  defaultWidthWasCapped: true,
  availableWidth: 500
});
assert.deepEqual(roundTripWide.widths.map(Math.round), roundTripStart);

const projectedSingleColumn = tableColumnWidthPolicy.project({
  widths: [160],
  minimumWidths: [110],
  preserveWidthIntent: false,
  initialTotalWidth: 160,
  elastic: true,
  defaultWidthWasCapped: true,
  availableWidth: 90
});
assert.deepEqual(projectedSingleColumn.widths, [110]);
assert.equal(projectedSingleColumn.totalWidth, 110);

for (const [label, widths, minimumWidths, expected] of [
  ['first', [120, 160, 100], [120, 60, 40], [120, 123, 78]],
  ['middle', [200, 60, 100], [120, 60, 40], [177, 60, 83]],
  ['last', [200, 140, 40], [120, 60, 40], [170, 110, 40]]
] as const) {
  const result = tableColumnWidthPolicy.project({
    widths,
    minimumWidths,
    preserveWidthIntent: false,
    initialTotalWidth: widths.reduce((sum, width) => sum + width, 0),
    elastic: true,
    defaultWidthWasCapped: true,
    availableWidth: 320
  });
  assert.deepEqual(result.widths.map(Math.round), expected, `${label} column keeps its own readable minimum`);
}

const projectedWide = tableColumnWidthPolicy.project({
  widths: [240, 120],
  minimumWidths: [0, 0],
  preserveWidthIntent: false,
  initialTotalWidth: 480,
  elastic: true,
  defaultWidthWasCapped: false,
  availableWidth: 420
});
assert.deepEqual(projectedWide.widths.map(Math.round), [280, 140]);
assert.equal(Math.round(projectedWide.totalWidth), 420);

const fixed = tableColumnWidthPolicy.project({
  widths: [120, 80],
  minimumWidths: [20, 20],
  preserveWidthIntent: false,
  initialTotalWidth: 300,
  elastic: false,
  defaultWidthWasCapped: false,
  availableWidth: 500
});
assert.deepEqual(fixed.widths, [120, 80]);
assert.equal(fixed.totalWidth, 200);
assert.equal(fixed.reachedAvailableWidth, false);
assert.equal(fixed.elastic, false, 'container projection must preserve the Policy-owned elastic decision');

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
