export type TableCellCoordinates = Readonly<{ row: number; col: number }>;

export type TableCellEditIntent = TableCellCoordinates & Readonly<{
  value: string;
  sequence: number;
}>;

export type TableCellInteractionPhase = 'idle' | 'editing' | 'pending' | 'committing' | 'disposed';

export type TableCellInteractionSnapshot = Readonly<{
  phase: TableCellInteractionPhase;
  generation: number;
  pending: readonly TableCellEditIntent[];
}>;

export type TableCellKeyboardInput = Readonly<{
  key: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  composing?: boolean;
  row: number;
  col: number;
  rowCount: number;
  colCount: number;
  selectionStart: number;
  selectionEnd: number;
  value: string;
  visualLine?: Readonly<{ atFirst: boolean; atLast: boolean; caretColumn: number }>;
}>;

export type TableCellKeyboardDecision =
  | { readonly type: 'pass-through' }
  | { readonly type: 'insert-line-break' }
  | { readonly type: 'insert-row-below' }
  | { readonly type: 'commit-and-exit' }
  | { readonly type: 'focus-cell'; readonly target: TableCellCoordinates; readonly caretColumn: number }
  | { readonly type: 'move-out-of-table'; readonly direction: 'up' | 'down'; readonly column: number };

export type TableCellInteractionResult = Readonly<{
  snapshot: TableCellInteractionSnapshot;
  scheduleAutoCommit?: Readonly<{ generation: number }>;
  timerCurrent?: boolean;
  commit?: Readonly<{ generation: number; edits: readonly TableCellEditIntent[] }>;
  keyboard?: TableCellKeyboardDecision;
}>;

export type TableCellInteraction = Readonly<{
  snapshot(): TableCellInteractionSnapshot;
  accept(input: TableCellInteractionInput): TableCellInteractionResult;
}>;

export type TableCellCommitConfirmation = {
  applied: boolean;
  settle(outcome: 'applied' | 'no-op' | 'failed'): void;
};

export type TableCellInteractionInput =
  | { readonly type: 'focus'; readonly target: TableCellCoordinates }
  | { readonly type: 'input'; readonly target: TableCellCoordinates; readonly value: string; readonly sequence: number }
  | { readonly type: 'timer'; readonly generation: number }
  | { readonly type: 'commit'; readonly reason: 'escape' | 'switch' | 'outside' | 'history' | 'command' }
  | { readonly type: 'commit-result'; readonly generation: number; readonly outcome: 'applied' | 'no-op' | 'failed' }
  | { readonly type: 'keyboard'; readonly input: TableCellKeyboardInput }
  | { readonly type: 'invalidate'; readonly reason: 'replacement' | 'external' | 'mode' }
  | { readonly type: 'dispose' };

function sameCell(left: TableCellCoordinates, right: TableCellCoordinates) {
  return left.row === right.row && left.col === right.col;
}

export function createTableCellCommitConfirmation(
  interaction: TableCellInteraction,
  generation: number
): TableCellCommitConfirmation {
  let settled = false;
  return {
    applied: false,
    settle(outcome) {
      if (settled) return;
      settled = true;
      interaction.accept({ type: 'commit-result', generation, outcome });
    }
  };
}

export function executeTableCellCommitBoundary<T>(
  confirmations: readonly TableCellCommitConfirmation[],
  buildAndDispatch: () => T
): T {
  try {
    const result = buildAndDispatch();
    for (const confirmation of confirmations) {
      confirmation.settle(confirmation.applied ? 'applied' : 'no-op');
    }
    return result;
  } catch (error) {
    for (const confirmation of confirmations) confirmation.settle('failed');
    throw error;
  }
}

function decideKeyboard(input: TableCellKeyboardInput): TableCellKeyboardDecision {
  if (input.composing || input.altKey || input.metaKey) return { type: 'pass-through' };
  const primaryModifier = Boolean(input.ctrlKey);
  if (input.key === 'Escape' && !input.shiftKey && !primaryModifier) return { type: 'commit-and-exit' };
  if (input.key === 'Enter') {
    if ((input.shiftKey || primaryModifier) && !input.altKey && !input.metaKey) return { type: 'insert-line-break' };
    if (input.row + 1 < input.rowCount) {
      return { type: 'focus-cell', target: { row: input.row + 1, col: input.col }, caretColumn: 0 };
    }
    return { type: 'insert-row-below' };
  }
  if (input.key === 'Tab' && !primaryModifier && !input.altKey && !input.metaKey) {
    const direction = input.shiftKey ? -1 : 1;
    const offset = input.row * input.colCount + input.col + direction;
    if (offset < 0 || offset >= input.rowCount * input.colCount) return { type: 'pass-through' };
    return {
      type: 'focus-cell',
      target: { row: Math.floor(offset / input.colCount), col: offset % input.colCount },
      caretColumn: 0
    };
  }
  if ((input.key === 'ArrowUp' || input.key === 'ArrowDown') && !input.shiftKey && !primaryModifier) {
    if (input.selectionStart !== input.selectionEnd) return { type: 'pass-through' };
    const visualLine = input.visualLine;
    if (!visualLine) return { type: 'pass-through' };
    const atBoundary = input.key === 'ArrowUp' ? visualLine.atFirst : visualLine.atLast;
    if (!atBoundary) return { type: 'pass-through' };
    const targetRow = input.row + (input.key === 'ArrowUp' ? -1 : 1);
    const column = visualLine.caretColumn;
    if (targetRow >= 0 && targetRow < input.rowCount) {
      return { type: 'focus-cell', target: { row: targetRow, col: input.col }, caretColumn: column };
    }
    return { type: 'move-out-of-table', direction: input.key === 'ArrowUp' ? 'up' : 'down', column };
  }
  return { type: 'pass-through' };
}

/**
 * Owns one rendered table widget's transient cell-edit intent and keyboard decisions.
 * Markdown, native history, viewport and DOM/CodeMirror lifecycle stay with their existing owners.
 */
export function createTableCellInteraction(): TableCellInteraction {
  let phase: TableCellInteractionPhase = 'idle';
  let generation = 0;
  let timerGeneration = 0;
  let pending: Array<{ row: number; col: number; value: string; sequence: number }> = [];
  let inFlight: Array<{ row: number; col: number; value: string; sequence: number }> = [];

  const snapshot = (): TableCellInteractionSnapshot => ({
    phase,
    generation,
    pending: pending.map((edit) => ({ ...edit }))
  });
  const result = (extra: Omit<TableCellInteractionResult, 'snapshot'> = {}): TableCellInteractionResult => ({
    snapshot: snapshot(),
    ...extra
  });
  const beginCommit = (): TableCellInteractionResult => {
    if (phase === 'disposed' || pending.length === 0) return result();
    generation += 1;
    timerGeneration += 1;
    inFlight = pending;
    pending = [];
    phase = 'committing';
    return result({ commit: { generation, edits: inFlight.map((edit) => ({ ...edit })) } });
  };

  return {
    snapshot,
    accept(input) {
      if (input.type === 'dispose') {
        generation += 1;
        timerGeneration += 1;
        pending = [];
        inFlight = [];
        phase = 'disposed';
        return result();
      }
      if (phase === 'disposed') return result();
      if (input.type === 'invalidate') {
        generation += 1;
        timerGeneration += 1;
        pending = [];
        inFlight = [];
        phase = 'idle';
        return result();
      }
      if (input.type === 'focus') {
        if (phase === 'idle') phase = 'editing';
        return result();
      }
      if (input.type === 'input') {
        if (!Number.isSafeInteger(input.sequence)) {
          throw new TypeError('Table cell edit sequence must be a caller-owned safe integer');
        }
        const existing = pending.find((edit) => sameCell(edit, input.target));
        if (existing) existing.value = input.value;
        else pending.push({ ...input.target, value: input.value, sequence: input.sequence });
        if (phase !== 'committing') phase = 'pending';
        timerGeneration += 1;
        return result({ scheduleAutoCommit: { generation: timerGeneration } });
      }
      if (input.type === 'timer') {
        return result({ timerCurrent: phase === 'pending' && input.generation === timerGeneration });
      }
      if (input.type === 'commit') return beginCommit();
      if (input.type === 'commit-result') {
        if (phase !== 'committing' || input.generation !== generation) return result();
        if (input.outcome === 'failed') {
          const newerPending = pending;
          pending = inFlight.filter((edit) => !newerPending.some((newer) => sameCell(edit, newer)));
          pending.push(...newerPending);
          inFlight = [];
          phase = 'pending';
          timerGeneration += 1;
          return result({ scheduleAutoCommit: { generation: timerGeneration } });
        }
        inFlight = [];
        phase = pending.length ? 'pending' : 'idle';
        return result();
      }
      const keyboard = decideKeyboard(input.input);
      return result({ keyboard });
    }
  };
}
