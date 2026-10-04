import { EditorSelection, Facet, RangeSet, RangeValue, StateEffect, StateField, Transaction, type Extension, type EditorState } from '@codemirror/state';
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { invertedEffects, isolateHistory } from '@codemirror/commands';
import { defaultInputAssistance, type InputAssistance } from '../../../src/foundation/editingPreferences';
import { markdownCodeRanges } from './blockInsertion';
import { beginHtmlCommentTemplate } from './htmlCommentEditing';
import { planHtmlCommentInput, deleteEmptyHtmlComment } from '../application/htmlCommentInput';
import { syntaxTree } from '@codemirror/language';
import { planSymbolInput, shouldDeleteSymbolPair } from '../application/symbolInput';
import { isExternalDocumentPresentation } from './externalDocumentPresentation';

export const inputAssistanceFacet = Facet.define<InputAssistance, InputAssistance>({
  combine: values => values.at(-1) ?? defaultInputAssistance
});

class AutomaticPair extends RangeValue {
  startSide = 1;
  endSide = -1;
  constructor(readonly open: string, readonly close: string) { super(); }
}

const replacePairs = StateEffect.define<RangeSet<AutomaticPair>>({ map: (pairs, mapping) => pairs.map(mapping) });
export const addAutomaticSymbolPair = StateEffect.define<{ from: number; to: number; open: string; close: string }>({
  map: (pair, mapping) => ({ ...pair, from: mapping.mapPos(pair.from, 1), to: mapping.mapPos(pair.to, -1) })
});
export interface AutomaticSymbolPair { readonly from: number; readonly to: number; readonly open: string; readonly close: string }
const replaceArea = StateEffect.define<{ from: number; to: number; pairs: readonly AutomaticSymbolPair[] }>({
  map: (area, changes) => ({ from: changes.mapPos(area.from, 1), to: changes.mapPos(area.to, -1), pairs: area.pairs.map(pair => ({ ...pair, from: changes.mapPos(pair.from, 1), to: changes.mapPos(pair.to, -1) })) })
});
export function automaticSymbolPairs(state: EditorState, from: number, to: number): AutomaticSymbolPair[] {
  const result: AutomaticSymbolPair[] = [];
  state.field(automaticPairs, false)?.between(from, to, (start, end, pair) => {
    if (start >= from && end <= to) result.push({ from: start, to: end, open: pair.open, close: pair.close });
  });
  return result;
}
/** Native cells attach origins to their existing commit, so the history owner remains authoritative. */
export const replaceAutomaticSymbolPairArea = (from: number, to: number, pairs: readonly AutomaticSymbolPair[]) => replaceArea.of({ from, to, pairs });
const automaticPairs = StateField.define<RangeSet<AutomaticPair>>({
  create: () => RangeSet.empty,
  update(pairs, transaction) {
    if (isExternalDocumentPresentation(transaction)) return RangeSet.empty;
    pairs = pairs.map(transaction.changes);
    transaction.changes.iterChangedRanges((_fromA, _toA, from, to) => {
      pairs = pairs.update({ filterFrom: Math.max(0, from - 3), filterTo: to + 3,
        filter: (start, end, pair) => end > start && transaction.newDoc.sliceString(start, start + pair.open.length) === pair.open
          && transaction.newDoc.sliceString(end - pair.close.length, end) === pair.close });
    });
    for (const effect of transaction.effects) {
      if (effect.is(replacePairs)) pairs = effect.value;
      if (effect.is(replaceArea)) pairs = pairs.update({ filter: (from, to) => !(from >= effect.value.from && to <= effect.value.to), add: effect.value.pairs.map(pair => new AutomaticPair(pair.open, pair.close).range(pair.from, pair.to)), sort: true });
      if (effect.is(addAutomaticSymbolPair)) pairs = pairs.update({ add: [new AutomaticPair(effect.value.open, effect.value.close).range(effect.value.from, effect.value.to)], sort: true });
    }
    return pairs;
  }
});

const originEpoch = StateField.define<number>({ create: () => 0, update: (epoch, transaction) => isExternalDocumentPresentation(transaction) || transaction.isUserEvent('undo') || transaction.isUserEvent('redo') ? epoch + 1 : epoch });
export const symbolOriginEpoch = (state: EditorState) => state.field(originEpoch);

function automaticRightAt(view: EditorView, position: number, closing?: string): boolean {
  let automatic = false;
  view.state.field(automaticPairs).between(Math.max(0, position - 4), position + 4, (from, to, pair) => {
    if ((!closing || closing === pair.close) && to - pair.close.length === position && view.state.doc.sliceString(from, from + pair.open.length) === pair.open
      && view.state.doc.sliceString(position, to) === pair.close) automatic = true;
  });
  return automatic;
}

function insideCode(view: EditorView): boolean {
  for (let node = syntaxTree(view.state).resolveInner(view.state.selection.main.head, -1); node; node = node.parent!)
    if (/^(?:FencedCode|CodeBlock|InlineCode|CodeText|CodeInfo)$/.test(node.name)) return true;
  return false;
}

function typeSymbols(view: EditorView, typed: string): boolean {
  if (view.state.readOnly || view.compositionStarted || typed.length !== 1) return false;
  const preferences = view.state.facet(inputAssistanceFacet);
  const ranges = view.state.selection.ranges;
  const at = ranges[0].head;
  const commentMarker = typed === '-' && view.state.sliceDoc(Math.max(0, at - 3), at) === '<!-'
    || typed === '>' && view.state.sliceDoc(Math.max(0, at - 2), at) === '--' && view.state.sliceDoc(at, Math.min(view.state.doc.length, at + 3)) === '-->';
  if (commentMarker && ranges.length === 1 && ranges[0].empty && !insideCode(view)) {
    const plan = planHtmlCommentInput(view.state.doc.toString(), at, typed, preferences, automaticRightAt(view, at, typed === '>' ? '-->' : undefined), markdownCodeRanges(syntaxTree(view.state)));
    if (plan) {
      view.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.insert }, selection: EditorSelection.cursor(plan.caret),
        effects: plan.pair ? [addAutomaticSymbolPair.of(plan.pair), beginHtmlCommentTemplate.of({ from: plan.caret, to: plan.caret, end: plan.pair.to })] : [],
        annotations: [Transaction.userEvent.of('input.type'), isolateHistory.of('full')], scrollIntoView: true });
      return true;
    }
  }
  const plans = ranges.map(range => planSymbolInput({ typed, selected: view.state.doc.sliceString(range.from, range.to),
    before: view.state.doc.sliceString(Math.max(0, range.from - 256), range.from),
    after: view.state.doc.sliceString(range.to, Math.min(view.state.doc.length, range.to + 4)),
    automaticRight: automaticRightAt(view, range.to), preferences }));
  // Match native surrounding: every range must qualify, otherwise ordinary input
  // replaces all selections. Mixing wrapped text and replaced whitespace is surprising.
  if (ranges.some(range => !range.empty) && (ranges.some(range => range.empty) || plans.some(plan => !plan || plan.type !== 'insert'))) return false;
  let changed = false, index = 0;
  const transaction = view.state.changeByRange(range => {
    const plan = plans[index++];
    if (!plan) return { changes: { from: range.from, to: range.to, insert: typed }, range: EditorSelection.cursor(range.from + typed.length) };
    changed = true;
    if (plan.type === 'skip') return { range: EditorSelection.cursor(range.head + plan.length) };
    return { changes: { from: range.from, to: range.to, insert: plan.text },
      range: range.anchor > range.head ? EditorSelection.range(range.from + plan.head, range.from + plan.anchor)
        : EditorSelection.range(range.from + plan.anchor, range.from + plan.head),
      effects: addAutomaticSymbolPair.of({ from: range.from, to: range.from + plan.text.length, open: plan.open, close: plan.close }) };
  });
  if (!changed) return false;
  // Pair insertion and pair deletion are separate user operations even when adjacent.
  view.dispatch({ ...transaction, annotations: [Transaction.userEvent.of('input.type'), isolateHistory.of('full')], scrollIntoView: true });
  return true;
}

function deleteEmptyPair(view: EditorView): boolean {
  if (view.state.readOnly || view.compositionStarted) return false;
  const ranges = view.state.selection.ranges;
  const preferences = view.state.facet(inputAssistanceFacet);
  if (ranges.every(range => range.empty && deleteEmptyHtmlComment(view.state.sliceDoc(Math.max(0, range.head - 4), Math.min(view.state.doc.length, range.head + 3)), Math.min(range.head, 4), preferences, automaticRightAt(view, range.head)))) {
    view.dispatch({ ...view.state.changeByRange(range => ({ changes: { from: range.head - 4, to: range.head + 3, insert: '' }, range: EditorSelection.cursor(range.head - 4) })),
      annotations: [Transaction.userEvent.of('delete.backward'), isolateHistory.of('full')], scrollIntoView: true });
    return true;
  }
  if (ranges.some(range => !range.empty || range.from < 1
    || !shouldDeleteSymbolPair(view.state.doc.sliceString(range.from - 1, range.from), view.state.doc.sliceString(range.from, range.from + 1), automaticRightAt(view, range.from), preferences))) return false;
  view.dispatch({ ...view.state.changeByRange(range => ({
    changes: { from: range.from - 1, to: range.from + 1, insert: '' }, range: EditorSelection.cursor(range.from - 1)
  })), annotations: [Transaction.userEvent.of('delete.backward'), isolateHistory.of('full')], scrollIntoView: true });
  return true;
}


const committedCompositionSymbols = ViewPlugin.fromClass(class {
  snapshot: { from: number; to: number; anchor: number; head: number; selected: string; before: string; after: string; length: number; automatic: boolean } | null = null;
  generation = 0;
  timer: ReturnType<typeof setTimeout> | null = null;
  constructor(readonly view: EditorView) {}
  update(update: ViewUpdate) { if (update.transactions.some(isExternalDocumentPresentation)) this.cancel(); }
  cancel() { this.generation++; this.snapshot = null; if (this.timer !== null) clearTimeout(this.timer); this.timer = null; }
  start() {
    this.cancel();
    const { state } = this.view, range = state.selection.main;
    if (state.selection.ranges.length !== 1) return;
    this.snapshot = { from: range.from, to: range.to, anchor: range.anchor, head: range.head,
      selected: state.sliceDoc(range.from, range.to), before: state.sliceDoc(Math.max(0, range.from - 256), range.from),
      after: state.sliceDoc(range.to, Math.min(state.doc.length, range.to + 4)), length: state.doc.length, automatic: automaticRightAt(this.view, range.to) };
  }
  finish(typed: string) {
    const snapshot = this.snapshot; if (!snapshot || typed.length !== 1) { this.cancel(); return; }
    const generation = this.generation;
    // Wait for CodeMirror's DOM reconciliation. Never mutate IME preedit.
    this.timer = setTimeout(() => {
      this.timer = null;
      const { state } = this.view;
      if (generation !== this.generation || this.view.compositionStarted || state.selection.main.head !== snapshot.from + 1
        || state.doc.length !== snapshot.length - (snapshot.to - snapshot.from) + 1
        || state.sliceDoc(Math.max(0, snapshot.from - 256), snapshot.from) !== snapshot.before
        || state.sliceDoc(snapshot.from, snapshot.from + 1) !== typed
        || state.sliceDoc(snapshot.from + 1, snapshot.from + 1 + snapshot.after.length) !== snapshot.after) return;
      const plan = planSymbolInput({ typed, selected: snapshot.selected, before: snapshot.before, after: snapshot.after,
        automaticRight: snapshot.automatic, preferences: state.facet(inputAssistanceFacet) });
      this.snapshot = null;
      if (!plan) return;
      if (plan.type === 'skip') this.view.dispatch({ changes: { from: snapshot.from, to: snapshot.from + 1, insert: '' }, selection: EditorSelection.cursor(snapshot.from + plan.length), annotations: Transaction.userEvent.of('input.type.compose') });
      else this.view.dispatch({ changes: { from: snapshot.from, to: snapshot.from + 1, insert: plan.text },
        selection: snapshot.anchor > snapshot.head ? EditorSelection.range(snapshot.from + plan.head, snapshot.from + plan.anchor) : EditorSelection.range(snapshot.from + plan.anchor, snapshot.from + plan.head),
        effects: addAutomaticSymbolPair.of({ from: snapshot.from, to: snapshot.from + plan.text.length, open: plan.open, close: plan.close }),
        annotations: Transaction.userEvent.of('input.type.compose') });
    }, 0);
  }
  destroy() { this.cancel(); }
}, { eventHandlers: {
  compositionstart() { this.start(); return false; },
  compositionend(event) { this.finish(event.data); return false; },
  blur() { this.cancel(); return false; }
} });

/** Pair identity follows changes/history; external document presentations discard identity. */
export const typingAssistance: Extension = [
  automaticPairs,
  originEpoch,
  committedCompositionSymbols,
  invertedEffects.of(transaction => transaction.docChanged || transaction.effects.some(effect => effect.is(addAutomaticSymbolPair) || effect.is(replacePairs) || effect.is(replaceArea))
    ? [replacePairs.of(transaction.startState.field(automaticPairs))] : []),
  EditorView.inputHandler.of((view, from, to, text) => from === view.state.selection.main.from && to === view.state.selection.main.to ? typeSymbols(view, text) : false),
  keymap.of([{ key: 'Backspace', run: deleteEmptyPair }])
];
