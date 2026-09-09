import {
  createTableCellCommitConfirmation,
  createTableCellInteraction,
  executeTableCellCommitBoundary,
  type TableCellInteractionInput
} from '../webview/src/editor/tableCellInteraction';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

type TableCellInput = Extract<TableCellInteractionInput, { readonly type: 'input' }>;
type CallerOwnsSequence = TableCellInput extends { readonly sequence: number } ? true : false;
const callerOwnsSequence: CallerOwnsSequence = true;
assert(callerOwnsSequence, 'Table cell edit sequence must be a required caller-owned value');

const interaction = createTableCellInteraction();
const snapshot = interaction.snapshot();

const firstInstance = createTableCellInteraction();
const secondInstance = createTableCellInteraction();
firstInstance.accept({ type: 'input', target: { row: 1, col: 0 }, value: 'first table', sequence: 41 });
secondInstance.accept({ type: 'input', target: { row: 1, col: 0 }, value: 'second table', sequence: 42 });
assert(
  firstInstance.snapshot().pending[0]?.sequence === 41 && secondInstance.snapshot().pending[0]?.sequence === 42,
  'Independent table interactions did not preserve the caller-owned global edit sequence'
);
let missingSequenceRejected = false;
try {
  firstInstance.accept({ type: 'input', target: { row: 1, col: 1 }, value: 'unordered' } as TableCellInteractionInput);
} catch {
  missingSequenceRejected = true;
}
assert(missingSequenceRejected, 'Table interaction invented a local fallback for a missing caller-owned sequence');

assert(snapshot.phase === 'idle' && snapshot.pending.length === 0, `New interaction was not idle: ${JSON.stringify(snapshot)}`);

interaction.accept({ type: 'focus', target: { row: 1, col: 0 } });
const firstInput = interaction.accept({ type: 'input', target: { row: 1, col: 0 }, value: 'first', sequence: 1 });
const firstTimer = firstInput.scheduleAutoCommit?.generation;
assert(firstInput.snapshot.phase === 'pending' && typeof firstTimer === 'number', 'Input did not become pending');
const mergedInput = interaction.accept({ type: 'input', target: { row: 1, col: 0 }, value: 'merged', sequence: 2 });
assert(mergedInput.snapshot.pending.length === 1 && mergedInput.snapshot.pending[0]?.value === 'merged', 'Same-cell input did not merge');
assert(interaction.accept({ type: 'timer', generation: firstTimer! }).snapshot.phase === 'pending', 'Stale timer committed current input');
assert(!interaction.accept({ type: 'timer', generation: firstTimer! }).timerCurrent, 'Stale timer remained current');
assert(interaction.accept({ type: 'timer', generation: mergedInput.scheduleAutoCommit!.generation }).timerCurrent, 'Current timer was rejected');
const commit = interaction.accept({ type: 'commit', reason: 'history' });
assert(commit.commit?.edits.length === 1 && commit.snapshot.phase === 'committing', 'Current timer path did not start one commit');
const restored = interaction.accept({ type: 'commit-result', generation: commit.commit!.generation, outcome: 'failed' });
assert(restored.snapshot.phase === 'pending' && restored.snapshot.pending[0]?.value === 'merged', 'Failed commit did not restore pending intent');
const retry = interaction.accept({ type: 'commit', reason: 'history' });
assert(retry.commit?.edits[0]?.value === 'merged', 'Retry did not retain pending value');
assert(interaction.accept({ type: 'commit-result', generation: retry.commit!.generation, outcome: 'applied' }).snapshot.phase === 'idle', 'Successful commit did not return idle');

const retryAfterFailure = createTableCellInteraction();
retryAfterFailure.accept({ type: 'input', target: { row: 1, col: 0 }, value: 'first cell', sequence: 3 });
const failedCommit = retryAfterFailure.accept({ type: 'commit', reason: 'history' }).commit!;
retryAfterFailure.accept({ type: 'input', target: { row: 1, col: 1 }, value: 'second cell', sequence: 4 });
const builderConfirmation = createTableCellCommitConfirmation(retryAfterFailure, failedCommit.generation);
let builderThrew = false;
try {
  executeTableCellCommitBoundary([builderConfirmation], () => {
    throw new Error('builder failed');
  });
} catch {
  builderThrew = true;
}
assert(builderThrew, 'Builder exception did not escape the commit boundary');
const failedWithNewInput = retryAfterFailure.snapshot();
assert(
  failedWithNewInput.pending.map((edit) => edit.value).join(',') === 'first cell,second cell',
  `Failed builder lost input received while commit was in progress: ${JSON.stringify(failedWithNewInput)}`
);
const dispatchRetry = retryAfterFailure.accept({ type: 'commit', reason: 'history' });
assert(dispatchRetry.commit?.edits.length === 2, 'Retry did not include both retained intents');
const dispatchConfirmation = createTableCellCommitConfirmation(retryAfterFailure, dispatchRetry.commit!.generation);
dispatchConfirmation.applied = true;
let dispatchThrew = false;
try {
  executeTableCellCommitBoundary([dispatchConfirmation], () => {
    throw new Error('dispatch failed');
  });
} catch {
  dispatchThrew = true;
}
assert(dispatchThrew && retryAfterFailure.snapshot().pending.length === 2, 'Dispatch exception did not retain retryable intents');
const combinedRetry = retryAfterFailure.accept({ type: 'commit', reason: 'history' });
const appliedConfirmation = createTableCellCommitConfirmation(retryAfterFailure, combinedRetry.commit!.generation);
appliedConfirmation.applied = true;
executeTableCellCommitBoundary([appliedConfirmation], () => undefined);
retryAfterFailure.accept({ type: 'input', target: { row: 1, col: 0 }, value: 'after success', sequence: 5 });
appliedConfirmation.settle('applied');
assert(
  retryAfterFailure.snapshot().pending[0]?.value === 'after success',
  'A duplicate success confirmation cleared a later intent'
);

const key = (value: Partial<Parameters<typeof interaction.accept>[0]> & { type: 'keyboard'; input: Record<string, unknown> }) => (
  interaction.accept(value as Parameters<typeof interaction.accept>[0]).keyboard
);
const keyboardInput = {
  row: 1, col: 0, rowCount: 3, colCount: 2, selectionStart: 2, selectionEnd: 2, value: 'ab'
};
const tabTarget = key({ type: 'keyboard', input: { ...keyboardInput, key: 'Tab' } });
assert(
  tabTarget?.type === 'focus-cell' && tabTarget.caretColumn === 0,
  `Tab did not move to the start of the next cell: ${JSON.stringify(tabTarget)}`
);
assert(key({ type: 'keyboard', input: { ...keyboardInput, row: 2, col: 1, key: 'Tab' } })?.type === 'consume', 'Last Tab was not blocked in the final cell');
assert(key({ type: 'keyboard', input: { ...keyboardInput, row: 0, col: 0, key: 'Tab', shiftKey: true } })?.type === 'pass-through', 'First Shift+Tab moved outside explicitly');
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'Enter', shiftKey: true } })?.type === 'insert-line-break', 'Shift+Enter did not insert a line break');
const enterNextRow = key({ type: 'keyboard', input: { ...keyboardInput, key: 'Enter' } });
assert(
  enterNextRow?.type === 'focus-cell' && enterNextRow.target.row === 2 && enterNextRow.target.col === 0,
  `Ordinary Enter did not explicitly choose the next row: ${JSON.stringify(enterNextRow)}`
);
assert(
  key({ type: 'keyboard', input: { ...keyboardInput, row: 2, key: 'Enter' } })?.type === 'move-out-of-table',
  'Last-row Enter did not explicitly leave the table'
);
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'Escape' } })?.type === 'commit-and-exit', 'Escape did not request one commit and exit');
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'ArrowLeft' } })?.type === 'pass-through', 'Ordinary horizontal navigation was stolen');
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'ArrowDown', value: 'a\nb', selectionStart: 0, selectionEnd: 0, visualLine: { atFirst: true, atLast: false, caretColumn: 0 } } })?.type === 'pass-through', 'In-cell vertical navigation was stolen');
assert(key({
  type: 'keyboard',
  input: {
    ...keyboardInput,
    key: 'ArrowUp',
    value: 'abcdefghijklmnopqrstuvwxyz',
    selectionStart: 14,
    selectionEnd: 14,
    visualLine: { atFirst: false, atLast: false, caretColumn: 4 }
  }
})?.type === 'pass-through', 'ArrowUp escaped from a soft-wrapped visual line');
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'ArrowDown', visualLine: { atFirst: true, atLast: true, caretColumn: 2 } } })?.type === 'focus-cell', 'Boundary ArrowDown did not move cell focus');

const staleTimer = interaction.accept({ type: 'input', target: { row: 1, col: 1 }, value: 'late', sequence: 6 }).scheduleAutoCommit!.generation;
for (const reason of ['replacement', 'external', 'mode'] as const) {
  interaction.accept({ type: 'invalidate', reason });
  assert(interaction.accept({ type: 'timer', generation: staleTimer }).snapshot.pending.length === 0, `${reason} accepted a stale timer`);
}
interaction.accept({ type: 'dispose' });
assert(interaction.snapshot().phase === 'disposed', 'Dispose did not become terminal');
assert(interaction.accept({ type: 'input', target: { row: 1, col: 0 }, value: 'ignored', sequence: 7 }).snapshot.phase === 'disposed', 'Disposed interaction accepted input');

console.log('table cell interaction checks passed');
