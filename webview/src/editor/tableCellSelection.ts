import { serializeMeoTableClipboard } from './tableClipboard';

export interface TableCellCoordinates {
  readonly row: number;
  readonly col: number;
}

export interface TableCellRange {
  readonly fromRow: number;
  readonly toRow: number;
  readonly fromCol: number;
  readonly toCol: number;
}

export type TableCellSelectionPhase = 'idle' | 'text-candidate' | 'dragging' | 'persisted' | 'disposed';

export type TableCellSelectionClearReason =
  | 'pointercancel'
  | 'lostcapture'
  | 'outside'
  | 'escape'
  | 'cross-table'
  | 'external'
  | 'replacement'
  | 'caret-failed'
  | 'dispose';

export type TableCellSelectionEffect =
  | {
      readonly kind: 'caret-request';
      readonly requestId: number;
      readonly phase: 'begin' | 'move' | 'end';
      readonly pointerId: number;
      readonly cell: TableCellCoordinates;
      readonly fallbackOffset: number;
      readonly nearestFallback: boolean;
    }
  | { readonly kind: 'prevent-default'; readonly pointerId: number | null }
  | { readonly kind: 'set-action-target'; readonly pointerId: number | null; readonly cell: TableCellCoordinates }
  | {
      readonly kind: 'text';
      readonly phase: 'begin' | 'preview' | 'commit';
      readonly pointerId: number;
      readonly cell: TableCellCoordinates;
      readonly anchorCaret: number;
      readonly headCaret: number;
    }
  | {
      readonly kind: 'cells';
      readonly pointerId: number | null;
      readonly range: TableCellRange;
      readonly focus: 'retain' | 'table';
    }
  | { readonly kind: 'clear-text'; readonly pointerId: number }
  | { readonly kind: 'capture-pointer'; readonly pointerId: number }
  | { readonly kind: 'release-pointer'; readonly pointerId: number }
  | {
      readonly kind: 'clear';
      readonly pointerId: number | null;
      readonly reason: TableCellSelectionClearReason;
    };

export type TableCellSelectionEvent =
  | {
      readonly type: 'begin';
      readonly pointerId: number;
      readonly cell: TableCellCoordinates;
      readonly fallbackOffset: number;
    }
  | {
      readonly type: 'activate';
      readonly pointerId: number;
      readonly cell: TableCellCoordinates;
      readonly origin: 'textarea';
    }
  | { readonly type: 'move'; readonly pointerId: number; readonly cell: TableCellCoordinates | null }
  | {
      readonly type: 'end';
      readonly pointerId: number;
      readonly cell: TableCellCoordinates | null;
      readonly insideTable: boolean;
    }
  | { readonly type: 'caret-resolved'; readonly requestId: number; readonly numericOffset: number }
  | { readonly type: 'caret-failed'; readonly requestId: number }
  | { readonly type: 'abort'; readonly pointerId: number; readonly reason: 'pointercancel' | 'lostcapture' }
  | {
      readonly type: 'select';
      readonly anchor: TableCellCoordinates;
      readonly head: TableCellCoordinates;
      readonly origin: 'focus' | 'command';
    }
  | { readonly type: 'clear'; readonly reason: 'outside' | 'escape' | 'cross-table' | 'external' | 'replacement' }
  | { readonly type: 'dispose' };

export interface TableCellSelectionTransition {
  readonly accepted: boolean;
  readonly effects: readonly TableCellSelectionEffect[];
}

export interface SerializedTableCellSelection {
  readonly plain: string;
  readonly html: string;
  readonly meo: string;
}

export type TableCellCopyInline = string | {
  readonly kind: 'strong';
  readonly children: readonly TableCellCopyInline[];
};

export interface TableCellCopyValue {
  readonly plain: string;
  readonly inline: readonly TableCellCopyInline[];
}

function normalizeRange(a: TableCellCoordinates, b: TableCellCoordinates): TableCellRange {
  return {
    fromRow: Math.min(a.row, b.row),
    toRow: Math.max(a.row, b.row),
    fromCol: Math.min(a.col, b.col),
    toCol: Math.max(a.col, b.col)
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderCopyInline(inline: readonly TableCellCopyInline[]): string {
  return inline.map((node) => (
    typeof node === 'string'
      ? escapeHtml(node)
      : `<strong>${renderCopyInline(node.children)}</strong>`
  )).join('');
}

export class TableCellSelection {
  private phase: TableCellSelectionPhase = 'idle';
  private anchor: TableCellCoordinates | null = null;
  private range: TableCellRange | null = null;
  private pointerId: number | null = null;
  private anchorCaret = 0;
  private headCaret = 0;
  private captured = false;
  private nextCaretRequestId = 1;
  private pendingCaret: {
    readonly requestId: number;
    readonly phase: 'begin' | 'move' | 'end';
    readonly pointerId: number;
    readonly cell: TableCellCoordinates;
    readonly fallbackOffset: number;
    readonly nearestFallback: boolean;
  } | null = null;

  accept(event: TableCellSelectionEvent): TableCellSelectionTransition {
    const accepted = (...effects: readonly TableCellSelectionEffect[]): TableCellSelectionTransition => ({
      accepted: true,
      effects
    });
    const rejected = (): TableCellSelectionTransition => ({ accepted: false, effects: [] });
    if (event.type === 'dispose') {
      if (this.phase === 'disposed') return rejected();
      const pointerId = this.pointerId;
      const captured = this.captured;
      this.reset();
      this.phase = 'disposed';
      return accepted(
        ...(pointerId === null || !captured ? [] : [{ kind: 'release-pointer', pointerId } as const]),
        { kind: 'clear', pointerId, reason: 'dispose' }
      );
    }
    if (this.phase === 'disposed') return rejected();
    if (event.type === 'clear') {
      if (this.phase === 'idle') return rejected();
      const pointerId = this.pointerId;
      const captured = this.captured;
      this.reset();
      return accepted(
        ...(event.reason === 'escape' ? [{ kind: 'prevent-default', pointerId: null } as const] : []),
        ...(pointerId === null || !captured ? [] : [{ kind: 'release-pointer', pointerId } as const]),
        { kind: 'clear', pointerId, reason: event.reason }
      );
    }
    if (event.type === 'activate') {
      if (this.pointerId !== null) return rejected();
      this.anchor = event.cell;
      this.range = normalizeRange(event.cell, event.cell);
      this.phase = 'persisted';
      return accepted(
        { kind: 'set-action-target', pointerId: event.pointerId, cell: event.cell },
        { kind: 'cells', pointerId: event.pointerId, range: this.range, focus: 'retain' }
      );
    }
    if (event.type === 'select') {
      if (event.origin === 'focus' && this.pointerId !== null) return rejected();
      const pointerId = this.pointerId;
      const captured = this.captured;
      this.anchor = event.anchor;
      this.range = normalizeRange(event.anchor, event.head);
      this.pointerId = null;
      this.captured = false;
      this.pendingCaret = null;
      this.phase = 'persisted';
      return accepted(
        ...(pointerId === null || !captured ? [] : [{ kind: 'release-pointer', pointerId } as const]),
        { kind: 'set-action-target', pointerId: null, cell: event.anchor },
        { kind: 'cells', pointerId: null, range: this.range, focus: 'retain' }
      );
    }
    if (event.type === 'caret-failed') {
      const request = this.pendingCaret;
      if (!request || request.requestId !== event.requestId || this.pointerId !== request.pointerId) return rejected();
      const pointerId = request.pointerId;
      const captured = this.captured;
      this.reset();
      return accepted(
        ...(captured ? [{ kind: 'release-pointer', pointerId } as const] : []),
        { kind: 'clear', pointerId, reason: 'caret-failed' }
      );
    }
    if (event.type === 'caret-resolved') {
      const request = this.pendingCaret;
      if (!request || request.requestId !== event.requestId || this.pointerId !== request.pointerId) return rejected();
      this.pendingCaret = null;
      if (request.phase === 'begin') {
        this.anchorCaret = event.numericOffset;
        this.headCaret = event.numericOffset;
        this.captured = true;
        return accepted(
          { kind: 'prevent-default', pointerId: request.pointerId },
          { kind: 'set-action-target', pointerId: request.pointerId, cell: request.cell },
          {
            kind: 'text', phase: 'begin', pointerId: request.pointerId, cell: request.cell,
            anchorCaret: event.numericOffset, headCaret: event.numericOffset
          },
          { kind: 'capture-pointer', pointerId: request.pointerId }
        );
      }
      if (request.phase === 'move') {
        this.headCaret = event.numericOffset;
        return accepted({
          kind: 'text', phase: 'preview', pointerId: request.pointerId, cell: request.cell,
          anchorCaret: this.anchorCaret, headCaret: this.headCaret
        });
      }
      this.headCaret = event.numericOffset;
      const effect: TableCellSelectionEffect = {
        kind: 'text', phase: 'commit', pointerId: request.pointerId, cell: request.cell,
        anchorCaret: this.anchorCaret, headCaret: this.headCaret
      };
      this.reset();
      return accepted(
        { kind: 'release-pointer', pointerId: request.pointerId },
        { kind: 'prevent-default', pointerId: request.pointerId },
        effect
      );
    }
    if (event.type === 'begin') {
      if (this.pointerId !== null) return rejected();
      this.phase = 'text-candidate';
      this.pointerId = event.pointerId;
      this.anchor = event.cell;
      this.range = normalizeRange(event.cell, event.cell);
      const request = {
        kind: 'caret-request', requestId: this.nextCaretRequestId++, phase: 'begin',
        pointerId: event.pointerId, cell: event.cell, fallbackOffset: event.fallbackOffset,
        nearestFallback: true
      } as const;
      this.pendingCaret = request;
      return accepted(request);
    }
    if (this.pointerId !== event.pointerId || !this.anchor) {
      return rejected();
    }
    if (event.type === 'abort') {
      const captured = this.captured;
      this.reset();
      return accepted(
        ...(captured ? [{ kind: 'release-pointer', pointerId: event.pointerId } as const] : []),
        { kind: 'clear', pointerId: event.pointerId, reason: event.reason }
      );
    }
    if (this.pendingCaret) return rejected();
    if (event.type === 'move') {
      if (event.cell === null) {
        if (this.phase === 'text-candidate') {
          this.phase = 'dragging';
          return accepted({ kind: 'clear-text', pointerId: event.pointerId });
        }
        return accepted();
      }
      if (this.phase === 'text-candidate' && event.cell.row === this.anchor.row && event.cell.col === this.anchor.col) {
        const request = {
          kind: 'caret-request', requestId: this.nextCaretRequestId++, phase: 'move',
          pointerId: event.pointerId, cell: this.anchor, fallbackOffset: this.headCaret,
          nearestFallback: false
        } as const;
        this.pendingCaret = request;
        return accepted(request);
      }
      this.phase = 'dragging';
      this.range = normalizeRange(this.anchor, event.cell);
      return accepted({ kind: 'cells', pointerId: event.pointerId, range: this.range, focus: 'table' });
    }
    if (event.type === 'end') {
      if (!event.insideTable) {
        this.reset();
        return accepted(
          { kind: 'release-pointer', pointerId: event.pointerId },
          { kind: 'clear', pointerId: event.pointerId, reason: 'outside' }
        );
      }
      if (this.phase === 'text-candidate' && (!event.cell || (
        event.cell.row === this.anchor.row && event.cell.col === this.anchor.col
      ))) {
        if (event.cell) {
          const request = {
            kind: 'caret-request', requestId: this.nextCaretRequestId++, phase: 'end',
            pointerId: event.pointerId, cell: this.anchor, fallbackOffset: this.headCaret,
            nearestFallback: true
          } as const;
          this.pendingCaret = request;
          return accepted(request);
        }
        const effect: TableCellSelectionEffect = {
          kind: 'text',
          phase: 'commit',
          pointerId: event.pointerId,
          cell: this.anchor,
          anchorCaret: this.anchorCaret,
          headCaret: this.headCaret
        };
        this.reset();
        return accepted(
          { kind: 'release-pointer', pointerId: event.pointerId },
          { kind: 'prevent-default', pointerId: event.pointerId },
          effect
        );
      }
      if (event.cell) this.range = normalizeRange(this.anchor, event.cell);
      if (!this.range) {
        this.reset();
        return accepted(
          { kind: 'release-pointer', pointerId: event.pointerId },
          { kind: 'clear', pointerId: event.pointerId, reason: 'outside' }
        );
      }
      this.pointerId = null;
      this.captured = false;
      this.phase = 'persisted';
      return accepted(
        { kind: 'release-pointer', pointerId: event.pointerId },
        { kind: 'cells', pointerId: event.pointerId, range: this.range, focus: 'table' }
      );
    }
    return rejected();
  }

  snapshot(): {
    readonly phase: TableCellSelectionPhase;
    readonly anchor: TableCellCoordinates | null;
    readonly range: TableCellRange | null;
  } {
    return { phase: this.phase, anchor: this.anchor, range: this.range };
  }

  copy(cells: readonly (readonly TableCellCopyValue[])[]): SerializedTableCellSelection | null {
    if (!this.range || this.phase === 'disposed') return null;
    const cellCount = (this.range.toRow - this.range.fromRow + 1) * (this.range.toCol - this.range.fromCol + 1);
    if (cellCount <= 1) return null;
    const rows: TableCellCopyValue[][] = [];
    for (let row = this.range.fromRow; row <= this.range.toRow; row += 1) {
      const values: TableCellCopyValue[] = [];
      for (let col = this.range.fromCol; col <= this.range.toCol; col += 1) {
        values.push(cells[row]?.[col] ?? { plain: '', inline: [] });
      }
      rows.push(values);
    }
    return {
      plain: rows.map((row) => row.map((value) => value.plain).join('\t')).join('\n'),
      html: `<table>${rows.map((row) => `<tr>${row.map((value) => `<td>${
        renderCopyInline(value.inline)
      }</td>`).join('')}</tr>`).join('')}</table>`,
      meo: serializeMeoTableClipboard(rows.map((row) => row.map((value) => value.plain)))
    };
  }

  private reset(): void {
    this.phase = 'idle';
    this.anchor = null;
    this.range = null;
    this.pointerId = null;
    this.anchorCaret = 0;
    this.headCaret = 0;
    this.captured = false;
    this.pendingCaret = null;
  }
}
