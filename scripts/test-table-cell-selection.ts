import assert from 'node:assert/strict';
import {
  TableCellSelection,
  type TableCellCopyValue,
  type TableCellSelectionEffect,
  type TableCellSelectionEvent
} from '../webview/src/editor/tableCellSelection';
import { serializeMeoTableClipboard } from '../webview/src/editor/tableClipboard';

const cell = (row: number, col: number) => ({ row, col });
const range = (fromRow: number, toRow: number, fromCol: number, toCol: number) => ({
  fromRow, toRow, fromCol, toCol
});
const value = (plain: string): TableCellCopyValue => ({ plain, inline: [plain] });
const accepted = (...effects: readonly TableCellSelectionEffect[]) => ({ accepted: true, effects });
const rejected = { accepted: false, effects: [] } as const;
const resolveCaret = (selection: TableCellSelection, transition: ReturnType<TableCellSelection['accept']>, offset: number) => {
  const request = transition.effects[0];
  assert.equal(request?.kind, 'caret-request');
  return selection.accept({
    type: 'caret-resolved', requestId: request.kind === 'caret-request' ? request.requestId : -1, numericOffset: offset
  });
};
const begin = (selection: TableCellSelection, pointerId: number, target: ReturnType<typeof cell>, caret: number) => (
  resolveCaret(selection, selection.accept({
    type: 'begin', pointerId, cell: target, fallbackOffset: caret
  }), caret)
);
const failCaret = (selection: TableCellSelection, transition: ReturnType<TableCellSelection['accept']>) => {
  const request = transition.effects[0];
  assert.equal(request?.kind, 'caret-request');
  return selection.accept({
    type: 'caret-failed', requestId: request.kind === 'caret-request' ? request.requestId : -1
  });
};

{
  const selection = new TableCellSelection();
  const admission = selection.accept({
    type: 'begin', pointerId: 71, cell: cell(0, 0), fallbackOffset: 3
  });
  assert.equal(admission.accepted, true);
  assert.equal(admission.effects.length, 1);
  const request = admission.effects[0];
  assert.deepEqual(request, {
    kind: 'caret-request', requestId: 1, phase: 'begin', pointerId: 71,
    cell: cell(0, 0), fallbackOffset: 3, nearestFallback: true
  }, 'owner admission returns only an inert caret request');
  assert.deepEqual(selection.accept({ type: 'caret-resolved', requestId: 2, numericOffset: 4 }), rejected,
    'wrong caret token is rejected');
  assert.deepEqual(selection.accept({ type: 'caret-resolved', requestId: 1, numericOffset: 4 }), accepted(
    { kind: 'prevent-default', pointerId: 71 },
    { kind: 'set-action-target', pointerId: 71, cell: cell(0, 0) },
    { kind: 'text', phase: 'begin', pointerId: 71, cell: cell(0, 0), anchorCaret: 4, headCaret: 4 },
    { kind: 'capture-pointer', pointerId: 71 }
  ));
  assert.deepEqual(selection.accept({ type: 'caret-resolved', requestId: 1, numericOffset: 5 }), rejected,
    'duplicate caret resolution is rejected');

  const late = new TableCellSelection();
  const lateRequest = late.accept({ type: 'begin', pointerId: 72, cell: cell(0, 0), fallbackOffset: 0 }).effects[0];
  assert.equal(lateRequest.kind, 'caret-request');
  late.accept({ type: 'dispose' });
  assert.deepEqual(late.accept({
    type: 'caret-resolved', requestId: lateRequest.kind === 'caret-request' ? lateRequest.requestId : -1, numericOffset: 1
  }), rejected, 'dispose rejects a late caret resolution');
}

for (const phase of ['begin', 'move', 'end'] as const) {
  const selection = new TableCellSelection();
  let pending = selection.accept({
    type: 'begin', pointerId: 73, cell: cell(0, 0), fallbackOffset: 0
  });
  if (phase !== 'begin') {
    resolveCaret(selection, pending, 0);
    pending = selection.accept(phase === 'move'
      ? { type: 'move', pointerId: 73, cell: cell(0, 0) }
      : { type: 'end', pointerId: 73, cell: cell(0, 0), insideTable: true });
  }
  const request = pending.effects[0];
  assert.equal(request?.kind, 'caret-request');
  const requestId = request.kind === 'caret-request' ? request.requestId : -1;
  assert.deepEqual(selection.accept({ type: 'caret-failed', requestId: requestId + 1 }), rejected,
    `${phase} rejects a wrong caret failure without disturbing the current request`);
  assert.deepEqual(failCaret(selection, pending), accepted(
    ...(phase === 'begin' ? [] : [{ kind: 'release-pointer', pointerId: 73 } as const]),
    { kind: 'clear', pointerId: 73, reason: 'caret-failed' }
  ), `${phase} mapper failure terminates the admitted request`);
  assert.deepEqual(selection.snapshot(), { phase: 'idle', anchor: null, range: null });
  assert.deepEqual(selection.accept({ type: 'caret-failed', requestId }), rejected,
    `${phase} rejects a duplicate caret failure`);
  assert.equal(selection.accept({
    type: 'begin', pointerId: 73, cell: cell(1, 1), fallbackOffset: 0
  }).accepted, true, `${phase} mapper failure releases the same pointer for a new transaction`);
}

{
  const selection = new TableCellSelection();
  const first = selection.accept({ type: 'begin', pointerId: 74, cell: cell(0, 0), fallbackOffset: 0 });
  const firstRequest = first.effects[0];
  assert.equal(firstRequest?.kind, 'caret-request');
  const firstRequestId = firstRequest.kind === 'caret-request' ? firstRequest.requestId : -1;
  failCaret(selection, first);
  const current = selection.accept({ type: 'begin', pointerId: 75, cell: cell(1, 1), fallbackOffset: 0 });
  assert.deepEqual(selection.accept({ type: 'caret-failed', requestId: firstRequestId }), rejected,
    'a stale failure cannot release a newer pointer owner');
  assert.deepEqual(resolveCaret(selection, current, 1), accepted(
    { kind: 'prevent-default', pointerId: 75 },
    { kind: 'set-action-target', pointerId: 75, cell: cell(1, 1) },
    { kind: 'text', phase: 'begin', pointerId: 75, cell: cell(1, 1), anchorCaret: 1, headCaret: 1 },
    { kind: 'capture-pointer', pointerId: 75 }
  ));
}

for (const reason of ['pointercancel', 'lostcapture'] as const) {
  for (const phase of ['begin', 'move', 'end'] as const) {
    const selection = new TableCellSelection();
    let pending = selection.accept({
      type: 'begin', pointerId: 76, cell: cell(0, 0), fallbackOffset: 0
    });
    if (phase !== 'begin') {
      resolveCaret(selection, pending, 0);
      pending = selection.accept(phase === 'move'
        ? { type: 'move', pointerId: 76, cell: cell(0, 0) }
        : { type: 'end', pointerId: 76, cell: cell(0, 0), insideTable: true });
    }
    assert.equal(pending.effects[0]?.kind, 'caret-request');
    assert.deepEqual(selection.accept({ type: 'abort', pointerId: 76, reason }), accepted(
      ...(phase === 'begin' ? [] : [{ kind: 'release-pointer', pointerId: 76 } as const]),
      { kind: 'clear', pointerId: 76, reason }
    ), `${reason} terminates a pending ${phase} caret request`);
    assert.deepEqual(selection.snapshot(), { phase: 'idle', anchor: null, range: null });
  }
}

{
  const selection = new TableCellSelection();
  const pending = selection.accept({ type: 'begin', pointerId: 77, cell: cell(0, 0), fallbackOffset: 0 });
  const request = pending.effects[0];
  assert.equal(request?.kind, 'caret-request');
  selection.accept({ type: 'dispose' });
  assert.deepEqual(selection.accept({
    type: 'caret-failed', requestId: request.kind === 'caret-request' ? request.requestId : -1
  }), rejected, 'dispose rejects a late caret failure');
}

{
  const selection = new TableCellSelection();
  assert.deepEqual(selection.snapshot(), { phase: 'idle', anchor: null, range: null });
  assert.deepEqual(begin(selection, 1, cell(2, 3), 4), accepted(
    { kind: 'prevent-default', pointerId: 1 },
    { kind: 'set-action-target', pointerId: 1, cell: cell(2, 3) },
    { kind: 'text', phase: 'begin', pointerId: 1, cell: cell(2, 3), anchorCaret: 4, headCaret: 4 },
    { kind: 'capture-pointer', pointerId: 1 }
  ));
  assert.deepEqual(resolveCaret(selection, selection.accept({
    type: 'move', pointerId: 1, cell: cell(2, 3)
  }), 1), accepted(
    { kind: 'text', phase: 'preview', pointerId: 1, cell: cell(2, 3), anchorCaret: 4, headCaret: 1 }
  ));
  assert.deepEqual(resolveCaret(selection, selection.accept({
    type: 'end', pointerId: 1, cell: cell(2, 3), insideTable: true
  }), 1), accepted(
    { kind: 'release-pointer', pointerId: 1 },
    { kind: 'prevent-default', pointerId: 1 },
    { kind: 'text', phase: 'commit', pointerId: 1, cell: cell(2, 3), anchorCaret: 4, headCaret: 1 }
  ));
  assert.deepEqual(selection.snapshot(), { phase: 'idle', anchor: null, range: null });
}

for (const [from, to] of [[cell(1, 0), cell(3, 2)], [cell(3, 2), cell(1, 0)]] as const) {
  const selection = new TableCellSelection();
  begin(selection, 8, from, 0);
  assert.deepEqual(selection.accept({ type: 'move', pointerId: 8, cell: to }), accepted(
    { kind: 'cells', pointerId: 8, range: range(1, 3, 0, 2), focus: 'table' }
  ));
  assert.deepEqual(selection.accept({ type: 'end', pointerId: 8, cell: null, insideTable: true }), accepted(
    { kind: 'release-pointer', pointerId: 8 },
    { kind: 'cells', pointerId: 8, range: range(1, 3, 0, 2), focus: 'table' }
  ), 'pointerup persists the last normalized dragging range');
  assert.equal(selection.snapshot().phase, 'persisted');
}

{
  const selection = new TableCellSelection();
  begin(selection, 81, cell(0, 0), 0);
  selection.accept({ type: 'move', pointerId: 81, cell: cell(1, 1) });
  selection.accept({ type: 'end', pointerId: 81, cell: null, insideTable: true });
  const pending = selection.accept({ type: 'begin', pointerId: 82, cell: cell(0, 0), fallbackOffset: 0 });
  assert.equal(pending.effects[0]?.kind, 'caret-request');
  assert.deepEqual(selection.accept({ type: 'dispose' }), accepted(
    { kind: 'clear', pointerId: 82, reason: 'dispose' }
  ), 'a new admitted caret request does not inherit the prior released capture');
}

for (const reason of ['pointercancel', 'lostcapture'] as const) {
  const selection = new TableCellSelection();
  begin(selection, 3, cell(0, 0), 0);
  assert.deepEqual(selection.accept({ type: 'begin', pointerId: 4, cell: cell(2, 2), fallbackOffset: 9 }), rejected,
    'a second pointer cannot replace the active owner');
  selection.accept({ type: 'move', pointerId: 3, cell: cell(1, 1) });
  assert.deepEqual(selection.accept({ type: 'abort', pointerId: 4, reason }), rejected,
    'a non-owner boundary cannot produce Adapter effects');
  assert.deepEqual(selection.accept({ type: 'end', pointerId: 3, cell: cell(1, 1), insideTable: true }), accepted(
    { kind: 'release-pointer', pointerId: 3 },
    { kind: 'cells', pointerId: 3, range: range(0, 1, 0, 1), focus: 'table' }
  ), 'the owner remains live after a non-owner boundary');

  begin(selection, 5, cell(2, 2), 4);
  assert.deepEqual(selection.accept({ type: 'move', pointerId: 5, cell: null }), accepted(
    { kind: 'clear-text', pointerId: 5 }
  ));
  assert.deepEqual(selection.accept({ type: 'move', pointerId: 5, cell: cell(2, 2) }), accepted(
    { kind: 'cells', pointerId: 5, range: range(2, 2, 2, 2), focus: 'table' }
  ), 'same-cell text does not resume after a cross-cell/outside transition');
  assert.deepEqual(selection.accept({ type: 'abort', pointerId: 5, reason }), accepted(
    { kind: 'release-pointer', pointerId: 5 },
    { kind: 'clear', pointerId: 5, reason }
  ));
  assert.deepEqual(selection.snapshot(), { phase: 'idle', anchor: null, range: null });
}

{
  const selection = new TableCellSelection();
  begin(selection, 9, cell(0, 0), 0);
  selection.accept({ type: 'move', pointerId: 9, cell: cell(1, 1) });
  assert.deepEqual(selection.accept({ type: 'end', pointerId: 9, cell: null, insideTable: false }), accepted(
    { kind: 'release-pointer', pointerId: 9 },
    { kind: 'clear', pointerId: 9, reason: 'outside' }
  ), 'outside release aborts the pointer owner');
}

for (const reason of ['outside', 'escape', 'cross-table', 'external', 'replacement'] as const) {
  const selection = new TableCellSelection();
  begin(selection, 21, cell(0, 0), 0);
  assert.deepEqual(selection.accept({ type: 'clear', reason }), accepted(
    ...(reason === 'escape' ? [{ kind: 'prevent-default', pointerId: null } as const] : []),
    { kind: 'release-pointer', pointerId: 21 },
    { kind: 'clear', pointerId: 21, reason }
  ), `${reason} preserves the active capture identity`);
  assert.deepEqual(selection.accept({ type: 'clear', reason }), rejected, `${reason} cleanup is idempotent`);
}

{
  const selection = new TableCellSelection();
  assert.deepEqual(selection.accept({
    type: 'activate', pointerId: 30, cell: cell(1, 1), origin: 'textarea'
  }), accepted(
    { kind: 'set-action-target', pointerId: 30, cell: cell(1, 1) },
    { kind: 'cells', pointerId: 30, range: range(1, 1, 1, 1), focus: 'retain' }
  ), 'textarea activation is admitted through the pointer owner');
}

for (const head of [cell(0, 0), cell(1, 1)] as const) {
  const selection = new TableCellSelection();
  selection.accept({ type: 'select', anchor: cell(0, 0), head, origin: 'command' });
  assert.deepEqual(selection.accept({ type: 'clear', reason: 'escape' }), accepted(
    { kind: 'prevent-default', pointerId: null },
    { kind: 'clear', pointerId: null, reason: 'escape' }
  ), `Escape clears persisted ${head.row === 0 ? 'single-cell' : 'multi-cell'} selection`);
}

{
  const selection = new TableCellSelection();
  assert.deepEqual(selection.accept({ type: 'clear', reason: 'escape' }), rejected,
    'idle Escape remains native and produces no effects');
}

{
  const selection = new TableCellSelection();
  begin(selection, 31, cell(0, 0), 0);
  assert.deepEqual(selection.accept({
    type: 'activate', pointerId: 32, cell: cell(1, 1), origin: 'textarea'
  }), rejected, 'active owner rejects a foreign textarea activation');
  for (const event of [
    { type: 'begin', pointerId: 32, cell: cell(1, 1), fallbackOffset: 1 },
    { type: 'move', pointerId: 32, cell: cell(1, 1) },
    { type: 'end', pointerId: 32, cell: cell(1, 1), insideTable: true },
    { type: 'abort', pointerId: 32, reason: 'pointercancel' },
    { type: 'abort', pointerId: 32, reason: 'lostcapture' }
  ] as readonly TableCellSelectionEvent[]) {
    assert.deepEqual(selection.accept(event), rejected, `active owner rejects foreign ${event.type}`);
  }
  assert.deepEqual(resolveCaret(selection, selection.accept({
    type: 'end', pointerId: 31, cell: cell(0, 0), insideTable: true
  }), 2), accepted(
    { kind: 'release-pointer', pointerId: 31 },
    { kind: 'prevent-default', pointerId: 31 },
    { kind: 'text', phase: 'commit', pointerId: 31, cell: cell(0, 0), anchorCaret: 0, headCaret: 2 }
  ));
}

{
  const selection = new TableCellSelection();
  assert.equal(selection.copy([[value('one')]]), null, 'zero cells pass through native copy');
  assert.deepEqual(selection.accept({ type: 'select', anchor: cell(0, 0), head: cell(0, 0), origin: 'command' }), accepted(
    { kind: 'set-action-target', pointerId: null, cell: cell(0, 0) },
    { kind: 'cells', pointerId: null, range: range(0, 0, 0, 0), focus: 'retain' }
  ));
  assert.equal(selection.copy([[value('one')]]), null, 'one cell passes through native copy');
  selection.accept({ type: 'select', anchor: cell(0, 0), head: cell(1, 1), origin: 'command' });
  assert.deepEqual(selection.copy([
    [
      { plain: '**bold** <img src=x onerror=alert(1)> &', inline: [
        { kind: 'strong', children: ['bold'] }, ' <img src=x onerror=alert(1)> &'
      ] },
      value('<tag>')
    ],
    [value('"quoted"'), value("apostrophe's")]
  ]), {
    plain: '**bold** <img src=x onerror=alert(1)> &\t<tag>\n"quoted"\tapostrophe\'s',
    html: '<table><tr><td><strong>bold</strong> &lt;img src=x onerror=alert(1)&gt; &amp;</td><td>&lt;tag&gt;</td></tr><tr><td>&quot;quoted&quot;</td><td>apostrophe&#39;s</td></tr></table>',
    meo: serializeMeoTableClipboard([
      ['**bold** <img src=x onerror=alert(1)> &', '<tag>'],
      ['"quoted"', "apostrophe's"]
    ])
  });
}

for (const active of [false, true]) {
  const selection = new TableCellSelection();
  if (active) begin(selection, 41, cell(0, 0), 0);
  assert.deepEqual(selection.accept({ type: 'dispose' }), accepted(
    ...(active ? [{ kind: 'release-pointer', pointerId: 41 } as const] : []),
    { kind: 'clear', pointerId: active ? 41 : null, reason: 'dispose' }
  ));
  assert.deepEqual(selection.snapshot(), { phase: 'disposed', anchor: null, range: null });
  for (const event of [
    { type: 'begin', pointerId: 41, cell: cell(0, 0), fallbackOffset: 0 },
    { type: 'move', pointerId: 41, cell: cell(1, 1) },
    { type: 'end', pointerId: 41, cell: cell(1, 1), insideTable: true },
    { type: 'abort', pointerId: 41, reason: 'pointercancel' },
    { type: 'clear', reason: 'escape' },
    { type: 'select', anchor: cell(0, 0), head: cell(1, 1), origin: 'command' },
    { type: 'dispose' }
  ] as readonly TableCellSelectionEvent[]) {
    assert.deepEqual(selection.accept(event), rejected, `disposed rejects late ${event.type}`);
  }
  assert.equal(selection.copy([[value('a'), value('b')]]), null, 'disposed rejects late copy');
}

console.log('table cell selection module checks passed');
