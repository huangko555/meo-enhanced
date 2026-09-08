import assert from 'node:assert/strict';
import { tableStickyHeaderPolicy } from '../webview/src/editor/tableStickyHeaderPolicy';
import { createToggleableTableStickyHeaderAdapterFactory } from '../webview/src/editor/tableStickyHeaderAdapter';

const common = {
  scroller: { top: 10, left: 20, right: 420, height: 300 },
  table: { left: -30, right: 530, bottom: 600, height: 640, width: 560 },
  header: { top: 0, height: 32 },
  controlsHeight: 0
} as const;

const shortTable = tableStickyHeaderPolicy.layout({
  ...common,
  table: { ...common.table, height: 149 }
});
assert.equal(shortTable.visible, true, 'short tables should become sticky after crossing the threshold');

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
  controlsHeight: 31
}), {
  visible: true,
  top: 10,
  left: 20,
  width: 400,
  height: 66,
  headerHeight: 32,
  tableWidth: 560,
  translateX: -50,
  controlsHeight: 31
});

const fractionalLayout = tableStickyHeaderPolicy.layout({
  ...common,
  scroller: { ...common.scroller, left: 20.4, right: 419.4 },
  table: { ...common.table, left: 20.4, right: 419.4, width: 399 }
});
assert.equal(fractionalLayout.visible, true);
if (fractionalLayout.visible) {
  assert.equal(fractionalLayout.left, 20, 'fractional left edge should round outward');
  assert.equal(fractionalLayout.width, 400, 'fractional right edge should round outward');
  assert.ok(Math.abs(fractionalLayout.translateX - 0.4) < 0.001);
}

const lifecycle: string[] = [];
const toggleableFactory = createToggleableTableStickyHeaderAdapterFactory({
  create: () => ({
    mount: () => lifecycle.push('mount'),
    update: () => lifecycle.push('update'),
    invalidate: () => lifecycle.push('invalidate'),
    unmount: () => lifecycle.push('unmount'),
    dispose: () => lifecycle.push('dispose')
  })
}, false);
const adapter = toggleableFactory.create({
  scheduler: { register: () => ({ request() {}, dispose() {} }) },
  resolveElements: () => null,
  controlsHeight: () => 0
});
adapter.mount();
adapter.update();
adapter.invalidate();
assert.deepEqual(lifecycle, [], 'disabled sticky headers must not install observers or request layout');
toggleableFactory.setEnabled(true);
adapter.update();
adapter.invalidate();
assert.deepEqual(lifecycle, ['mount', 'update', 'invalidate']);
toggleableFactory.setEnabled(false);
adapter.update();
adapter.invalidate();
assert.deepEqual(lifecycle, ['mount', 'update', 'invalidate', 'unmount']);
adapter.dispose();
assert.deepEqual(lifecycle, ['mount', 'update', 'invalidate', 'unmount', 'dispose']);

console.log('table sticky header policy contracts passed');
