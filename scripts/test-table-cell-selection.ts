import assert from 'node:assert/strict';
import { TableCellSelection } from '../webview/src/editor/tableCellSelection';

const cell = (row: number, col: number) => ({ row, col });

{
  const selection = new TableCellSelection();
  assert.deepEqual(selection.snapshot(), { phase: 'idle', anchor: null, range: null });

  selection.begin(7, cell(2, 3), 4);
  assert.deepEqual(selection.snapshot(), {
    phase: 'text-candidate',
    anchor: cell(2, 3),
    range: { fromRow: 2, toRow: 2, fromCol: 3, toCol: 3 }
  });
  assert.deepEqual(selection.move(7, cell(2, 3), 1), { kind: 'text', anchorCaret: 4, headCaret: 1 });
  assert.deepEqual(selection.end(7, cell(2, 3), 1), { kind: 'text', anchorCaret: 4, headCaret: 1 });
  assert.deepEqual(selection.snapshot(), { phase: 'idle', anchor: null, range: null });
}

for (const [from, to, expected] of [
  [cell(1, 0), cell(3, 2), { fromRow: 1, toRow: 3, fromCol: 0, toCol: 2 }],
  [cell(3, 2), cell(1, 0), { fromRow: 1, toRow: 3, fromCol: 0, toCol: 2 }]
] as const) {
  const selection = new TableCellSelection();
  selection.begin(8, from, 0);
  assert.deepEqual(selection.move(8, to, 0), { kind: 'cells', range: expected });
  assert.equal(selection.snapshot().phase, 'dragging');
  assert.deepEqual(selection.end(8, to, 0), { kind: 'cells', range: expected });
  assert.deepEqual(selection.snapshot(), { phase: 'persisted', anchor: from, range: expected });
}

{
  const selection = new TableCellSelection();
  selection.begin(81, cell(0, 0), 0);
  selection.move(81, cell(1, 1), 0);
  assert.deepEqual(selection.end(81), {
    kind: 'cells',
    range: { fromRow: 0, toRow: 1, fromCol: 0, toCol: 1 }
  }, 'dragging can finish from its last normalized range');
  assert.equal(selection.snapshot().phase, 'persisted');
}

for (const abort of ['pointercancel', 'lostcapture'] as const) {
  const selection = new TableCellSelection();
  selection.begin(9, cell(0, 0), 0);
  selection.move(9, cell(1, 1), 0);
  assert.equal(selection.abort(9, abort), true);
  assert.deepEqual(selection.snapshot(), { phase: 'idle', anchor: null, range: null });
  assert.equal(selection.end(9, cell(1, 1), 0), null, `${abort} ignores late pointerup`);
}

{
  const selection = new TableCellSelection();
  selection.begin(10, cell(0, 0), 0);
  selection.move(10, cell(1, 1), 0);
  selection.end(10, cell(1, 1), 0);
  assert.equal(selection.clear(), true);
  assert.equal(selection.clear(), false, 'outside/Escape clear is idempotent');
  selection.begin(11, cell(0, 1), 0);
  selection.move(11, cell(1, 1), 0);
  selection.end(11, cell(1, 1), 0);
  assert.equal(selection.clear(), true, 'cross-table transfer clears the previous owner');
  selection.dispose();
  assert.deepEqual(selection.snapshot(), { phase: 'disposed', anchor: null, range: null });
  assert.equal(selection.begin(12, cell(0, 0), 0), null);
  assert.equal(selection.move(12, cell(1, 1), 0), null);
  assert.equal(selection.end(12, cell(1, 1), 0), null);
}

{
  const selection = new TableCellSelection();
  assert.equal(selection.copy([['one']]), null, 'zero cells pass through copy');
  selection.select(cell(0, 0), cell(0, 0));
  assert.equal(selection.copy([['one']]), null, 'one cell passes through copy');
  selection.select(cell(0, 0), cell(1, 1));
  assert.deepEqual(selection.copy([
    ['A&B', '<tag>'],
    ['"quoted"', "apostrophe's"]
  ]), {
    plain: 'A&B\t<tag>\n"quoted"\tapostrophe\'s',
    html: '<table><tr><td>A&amp;B</td><td>&lt;tag&gt;</td></tr><tr><td>&quot;quoted&quot;</td><td>apostrophe&#39;s</td></tr></table>'
  });
}

console.log('table cell selection module checks passed');
