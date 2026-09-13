import assert from 'node:assert/strict';
import { planPreviewTableWidths } from '../webview/src/helpers/previewTableLayout';

const contentAware = planPreviewTableWidths([110, 760, 150], 720);
assert.equal(Math.round(contentAware.widths.reduce((sum, width) => sum + width, 0)), 720);
assert.ok(contentAware.widths.every((width) => width >= 90));
assert.ok(contentAware.widths[1] > contentAware.widths[0] * 2, JSON.stringify(contentAware));
assert.ok(contentAware.widths[1] > contentAware.widths[2] * 2, JSON.stringify(contentAware));
assert.equal(contentAware.overflows, false);

const tightlyFitted = planPreviewTableWidths([110, 760, 150], 220);
assert.equal(Math.round(tightlyFitted.widths.reduce((sum, width) => sum + width, 0)), 220);
assert.ok(tightlyFitted.widths.every((width) => width > 0));
assert.ok(tightlyFitted.widths[1] > tightlyFitted.widths[0], JSON.stringify(tightlyFitted));
assert.ok(tightlyFitted.widths[1] > tightlyFitted.widths[2], JSON.stringify(tightlyFitted));
assert.equal(tightlyFitted.totalWidth, 220);
assert.equal(tightlyFitted.overflows, false);

const spareSpace = planPreviewTableWidths([100, 100], 500);
assert.equal(Math.round(spareSpace.widths.reduce((sum, width) => sum + width, 0)), 500);
assert.deepEqual(spareSpace.widths.map(Math.round), [250, 250]);

console.log('Preview table width planning checks passed');
