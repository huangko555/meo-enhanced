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
  | { readonly kind: 'text'; readonly anchorCaret: number; readonly headCaret: number }
  | { readonly kind: 'cells'; readonly range: TableCellRange };

export interface SerializedTableCellSelection {
  readonly plain: string;
  readonly html: string;
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

export class TableCellSelection {
  private phase: TableCellSelectionPhase = 'idle';
  private anchor: TableCellCoordinates | null = null;
  private range: TableCellRange | null = null;
  private pointerId: number | null = null;
  private anchorCaret = 0;

  snapshot(): {
    readonly phase: TableCellSelectionPhase;
    readonly anchor: TableCellCoordinates | null;
    readonly range: TableCellRange | null;
  } {
    return { phase: this.phase, anchor: this.anchor, range: this.range };
  }

  begin(pointerId: number, anchor: TableCellCoordinates, anchorCaret: number): TableCellSelectionEffect | null {
    if (this.phase === 'disposed') return null;
    this.phase = 'text-candidate';
    this.pointerId = pointerId;
    this.anchor = anchor;
    this.anchorCaret = anchorCaret;
    this.range = normalizeRange(anchor, anchor);
    return { kind: 'text', anchorCaret, headCaret: anchorCaret };
  }

  move(pointerId: number, current: TableCellCoordinates, currentCaret: number): TableCellSelectionEffect | null {
    if (this.pointerId !== pointerId || !this.anchor || this.phase === 'disposed') return null;
    if (current.row === this.anchor.row && current.col === this.anchor.col && this.phase === 'text-candidate') {
      return { kind: 'text', anchorCaret: this.anchorCaret, headCaret: currentCaret };
    }
    this.phase = 'dragging';
    this.range = normalizeRange(this.anchor, current);
    return { kind: 'cells', range: this.range };
  }

  end(pointerId: number, current?: TableCellCoordinates, currentCaret = 0): TableCellSelectionEffect | null {
    const effect = current
      ? this.move(pointerId, current, currentCaret)
      : this.pointerId === pointerId && this.phase === 'dragging' && this.range
        ? { kind: 'cells' as const, range: this.range }
        : null;
    if (!effect) return null;
    this.pointerId = null;
    if (effect.kind === 'text') {
      this.phase = 'idle';
      this.anchor = null;
      this.range = null;
    } else {
      this.phase = 'persisted';
    }
    return effect;
  }

  abort(pointerId: number, _reason: 'pointercancel' | 'lostcapture'): boolean {
    if (this.pointerId !== pointerId || this.phase === 'disposed') return false;
    this.reset();
    return true;
  }

  select(anchor: TableCellCoordinates, head: TableCellCoordinates): void {
    if (this.phase === 'disposed') return;
    this.anchor = anchor;
    this.range = normalizeRange(anchor, head);
    this.pointerId = null;
    this.phase = 'persisted';
  }

  clear(): boolean {
    if (this.phase === 'idle' || this.phase === 'disposed') return false;
    this.reset();
    return true;
  }

  copy(cells: readonly (readonly string[])[]): SerializedTableCellSelection | null {
    if (!this.range || this.phase === 'disposed') return null;
    const cellCount = (this.range.toRow - this.range.fromRow + 1) * (this.range.toCol - this.range.fromCol + 1);
    if (cellCount <= 1) return null;
    const rows: string[][] = [];
    for (let row = this.range.fromRow; row <= this.range.toRow; row += 1) {
      const values: string[] = [];
      for (let col = this.range.fromCol; col <= this.range.toCol; col += 1) {
        values.push(cells[row]?.[col] ?? '');
      }
      rows.push(values);
    }
    return {
      plain: rows.map((row) => row.join('\t')).join('\n'),
      html: `<table>${rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</table>`
    };
  }

  dispose(): void {
    this.reset();
    this.phase = 'disposed';
  }

  private reset(): void {
    this.phase = 'idle';
    this.anchor = null;
    this.range = null;
    this.pointerId = null;
    this.anchorCaret = 0;
  }
}
