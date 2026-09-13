import assert from 'node:assert/strict';
import { planPreviewTableWidths } from '../webview/src/helpers/previewTableLayout';

const contentAware = planPreviewTableWidths([110, 760, 150], 720);
assert.equal(Math.round(contentAware.widths.reduce((sum, width) => sum + width, 0)), 720);
assert.ok(contentAware.widths.every((width) => width >= 90));
assert.ok(contentAware.widths[1] > contentAware.widths[0] * 2, JSON.stringify(contentAware));
assert.ok(contentAware.widths[1] > contentAware.widths[2] * 2, JSON.stringify(contentAware));
assert.equal(contentAware.overflows, false);

const locallyScrollable = planPreviewTableWidths([110, 760, 150], 220);
assert.deepEqual(locallyScrollable.widths.map(Math.round), [90, 90, 90]);
assert.equal(locallyScrollable.totalWidth, 270);
assert.equal(locallyScrollable.overflows, true);

const spareSpace = planPreviewTableWidths([100, 100], 500);
assert.equal(Math.round(spareSpace.widths.reduce((sum, width) => sum + width, 0)), 500);
assert.deepEqual(spareSpace.widths.map(Math.round), [250, 250]);

console.log('Preview table width planning checks passed');
