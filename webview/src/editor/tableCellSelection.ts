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

export type TableCellSelectionEffect =
  | {
      readonly kind: 'text';
      readonly phase: 'preview' | 'commit';
      readonly cell: TableCellCoordinates;
      readonly anchorCaret: number;
      readonly headCaret: number;
    }
  | { readonly kind: 'cells'; readonly range: TableCellRange }
  | { readonly kind: 'clear-text' }
  | { readonly kind: 'clear' };

export type TableCellSelectionEvent =
  | { readonly type: 'begin'; readonly pointerId: number; readonly cell: TableCellCoordinates; readonly caret: number }
  | { readonly type: 'move'; readonly pointerId: number; readonly cell: TableCellCoordinates | null; readonly caret: number | null }
  | {
      readonly type: 'end';
      readonly pointerId: number;
      readonly cell: TableCellCoordinates | null;
      readonly caret: number | null;
      readonly insideTable: boolean;
    }
  | { readonly type: 'abort'; readonly pointerId: number; readonly reason: 'pointercancel' | 'lostcapture' }
  | { readonly type: 'select'; readonly anchor: TableCellCoordinates; readonly head: TableCellCoordinates }
  | { readonly type: 'clear'; readonly reason: 'outside' | 'escape' | 'cross-table' | 'external' | 'replacement' }
  | { readonly type: 'dispose' };

export interface TableCellSelectionTransition {
  readonly handled: boolean;
  readonly effect: TableCellSelectionEffect | null;
}

export interface SerializedTableCellSelection {
  readonly plain: string;
  readonly html: string;
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

  accept(event: TableCellSelectionEvent): TableCellSelectionTransition {
    if (event.type === 'dispose') {
      if (this.phase === 'disposed') return { handled: false, effect: null };
      this.reset();
      this.phase = 'disposed';
      return { handled: true, effect: { kind: 'clear' } };
    }
    if (this.phase === 'disposed') return { handled: false, effect: null };
    if (event.type === 'clear') {
      if (this.phase === 'idle') return { handled: false, effect: null };
      this.reset();
      return { handled: true, effect: { kind: 'clear' } };
    }
    if (event.type === 'select') {
      this.anchor = event.anchor;
      this.range = normalizeRange(event.anchor, event.head);
      this.pointerId = null;
      this.phase = 'persisted';
      return { handled: true, effect: { kind: 'cells', range: this.range } };
    }
    if (event.type === 'begin') {
      if (this.pointerId !== null) return { handled: false, effect: null };
      this.phase = 'text-candidate';
      this.pointerId = event.pointerId;
      this.anchor = event.cell;
      this.anchorCaret = event.caret;
      this.headCaret = event.caret;
      this.range = normalizeRange(event.cell, event.cell);
      return {
        handled: true,
        effect: {
          kind: 'text',
          phase: 'preview',
          cell: event.cell,
          anchorCaret: event.caret,
          headCaret: event.caret
        }
      };
    }
    if (this.pointerId !== event.pointerId || !this.anchor) {
      return { handled: false, effect: null };
    }
    if (event.type === 'move') {
      if (event.cell === null) {
        if (this.phase === 'text-candidate') {
          this.phase = 'dragging';
          return { handled: true, effect: { kind: 'clear-text' } };
        }
        return { handled: true, effect: null };
      }
      if (this.phase === 'text-candidate' && event.cell.row === this.anchor.row && event.cell.col === this.anchor.col) {
        if (event.caret !== null) this.headCaret = event.caret;
        return {
          handled: true,
          effect: {
            kind: 'text',
            phase: 'preview',
            cell: this.anchor,
            anchorCaret: this.anchorCaret,
            headCaret: this.headCaret
          }
        };
      }
      this.phase = 'dragging';
      this.range = normalizeRange(this.anchor, event.cell);
      return { handled: true, effect: { kind: 'cells', range: this.range } };
    }
    if (event.type === 'end') {
      if (!event.insideTable) {
        this.reset();
        return { handled: true, effect: { kind: 'clear' } };
      }
      if (this.phase === 'text-candidate' && (!event.cell || (
        event.cell.row === this.anchor.row && event.cell.col === this.anchor.col
      ))) {
        if (event.caret !== null) this.headCaret = event.caret;
        const effect: TableCellSelectionEffect = {
          kind: 'text',
          phase: 'commit',
          cell: this.anchor,
          anchorCaret: this.anchorCaret,
          headCaret: this.headCaret
        };
        this.reset();
        return { handled: true, effect };
      }
      if (event.cell) this.range = normalizeRange(this.anchor, event.cell);
      if (!this.range) {
        this.reset();
        return { handled: true, effect: { kind: 'clear' } };
      }
      this.pointerId = null;
      this.phase = 'persisted';
      return { handled: true, effect: { kind: 'cells', range: this.range } };
    }
    this.reset();
    return { handled: true, effect: { kind: 'clear' } };
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
      }</td>`).join('')}</tr>`).join('')}</table>`
    };
  }

  private reset(): void {
    this.phase = 'idle';
    this.anchor = null;
    this.range = null;
    this.pointerId = null;
    this.anchorCaret = 0;
    this.headCaret = 0;
  }
}
