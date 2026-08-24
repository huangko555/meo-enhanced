import { createTableCellInteraction } from '../webview/src/editor/tableCellInteraction';

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(message);
}

const interaction = createTableCellInteraction();
const snapshot = interaction.snapshot();

assert(snapshot.phase === 'idle' && snapshot.pending.length === 0, `New interaction was not idle: ${JSON.stringify(snapshot)}`);

interaction.accept({ type: 'focus', target: { row: 1, col: 0 } });
const firstInput = interaction.accept({ type: 'input', target: { row: 1, col: 0 }, value: 'first' });
const firstTimer = firstInput.scheduleAutoCommit?.generation;
assert(firstInput.snapshot.phase === 'pending' && typeof firstTimer === 'number', 'Input did not become pending');
const mergedInput = interaction.accept({ type: 'input', target: { row: 1, col: 0 }, value: 'merged' });
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

const key = (value: Partial<Parameters<typeof interaction.accept>[0]> & { type: 'keyboard'; input: Record<string, unknown> }) => (
  interaction.accept(value as Parameters<typeof interaction.accept>[0]).keyboard
);
const keyboardInput = {
  row: 1, col: 0, rowCount: 3, colCount: 2, selectionStart: 2, selectionEnd: 2, value: 'ab'
};
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'Tab' } })?.type === 'focus-cell', 'Tab did not move within table');
assert(key({ type: 'keyboard', input: { ...keyboardInput, row: 2, col: 1, key: 'Tab' } })?.type === 'pass-through', 'Last Tab tried to add or wrap a row');
assert(key({ type: 'keyboard', input: { ...keyboardInput, row: 0, col: 0, key: 'Tab', shiftKey: true } })?.type === 'pass-through', 'First Shift+Tab moved outside explicitly');
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'Enter', shiftKey: true } })?.type === 'insert-line-break', 'Shift+Enter did not insert a line break');
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'Escape' } })?.type === 'commit-and-exit', 'Escape did not request one commit and exit');
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'ArrowLeft' } })?.type === 'pass-through', 'Ordinary horizontal navigation was stolen');
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'ArrowDown', value: 'a\nb', selectionStart: 0, selectionEnd: 0 } })?.type === 'pass-through', 'In-cell vertical navigation was stolen');
assert(key({ type: 'keyboard', input: { ...keyboardInput, key: 'ArrowDown' } })?.type === 'focus-cell', 'Boundary ArrowDown did not move cell focus');

const staleTimer = interaction.accept({ type: 'input', target: { row: 1, col: 1 }, value: 'late' }).scheduleAutoCommit!.generation;
for (const reason of ['replacement', 'external', 'mode'] as const) {
  interaction.accept({ type: 'invalidate', reason });
  assert(interaction.accept({ type: 'timer', generation: staleTimer }).snapshot.pending.length === 0, `${reason} accepted a stale timer`);
}
interaction.accept({ type: 'dispose' });
assert(interaction.snapshot().phase === 'disposed', 'Dispose did not become terminal');
assert(interaction.accept({ type: 'input', target: { row: 1, col: 0 }, value: 'ignored' }).snapshot.phase === 'disposed', 'Disposed interaction accepted input');

console.log('table cell interaction checks passed');
