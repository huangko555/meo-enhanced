import { EditorSelection, Transaction, type StateEffect, type SelectionRange } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { moveLineUp, moveLineDown, copyLineUp, copyLineDown, deleteLine, selectParentSyntax, toggleComment, toggleBlockComment, isolateHistory } from '@codemirror/commands';
import { selectNextOccurrence } from '@codemirror/search';
import { syntaxTree } from '@codemirror/language';
import { parseDelimitedTable, markdownTableFromCells } from '../application/delimitedTable';
import { inlineCodeMarkers, planInlineWrapper } from '../application/symbolInput';
import { isCodeInput } from './pasteAssistance';
import type { EditorCommandId } from '../../../src/foundation/editingPreferences';

import { markdownCodeRanges } from './blockInsertion';
import { planHtmlCommentToggle } from '../application/htmlCommentInput';
import { beginHtmlCommentTemplate } from './htmlCommentEditing';
import { addAutomaticSymbolPair } from './typingAssistance';

const selectionHistory = new WeakMap<EditorView, { after: EditorSelection; before: EditorSelection[] }>();
// Programmatic edits share the existing toolbar caret-continuity path in both modes.
const annotation = Transaction.userEvent.of('input.toolbar');
function selectedLines(view: EditorView) {
  const { state } = view;
  const numbers = new Set<number>();
  for (const selection of state.selection.ranges) {
    const first = state.doc.lineAt(selection.from).number;
    const last = state.doc.lineAt(selection.to > selection.from ? selection.to - 1 : selection.to).number;
    for (let number = first; number <= last; number++) numbers.add(number);
  }
  return [...numbers].sort((a, b) => a - b).map(number => state.doc.line(number));
}

function toggleLines(view: EditorView, command: EditorCommandId): boolean {
  if (isCodeInput(view)) return false;
  const lines = selectedLines(view);
  const heading = /^heading([1-6])$/.exec(command);
  const targetPrefix = command === 'bullet' ? '- ' : command === 'ordered' ? '1. ' : command === 'taskList' ? '- [ ] ' : command === 'quote' ? '> ' : heading ? '#'.repeat(Number(heading[1])) + ' ' : '';
  const ownMarker = command === 'bullet' ? /^\s*[-+*]\s+(?!\[[ xX]\])/ : command === 'ordered' ? /^\s*\d+[.)]\s+/ : command === 'taskList' ? /^\s*[-+*]\s+\[[ xX]\]\s+/ : command === 'quote' ? /^\s*>\s?/ : heading ? new RegExp('^\\s*#{' + heading[1] + '} ') : null;
  const remove = !!ownMarker && lines.every(line => ownMarker.test(line.text));
  let ordinal = 0;
  const changes = lines.map(line => {
    if (command === 'taskDone') {
      const match = /^(\s*[-+*]\s+\[)([ xX])(\])/.exec(line.text);
      return match ? { from: line.from + match[1].length, to: line.from + match[1].length + 1, insert: match[2] === ' ' ? 'x' : ' ' } : { from: line.from, insert: '' };
    }
    const indentation = /^\s*/.exec(line.text)![0];
    const existing = /^(?:#{1,6}\s+|[-+*]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/.exec(line.text.slice(indentation.length))?.[0] ?? '';
    let prefix = remove ? '' : command === 'ordered' ? `${++ordinal}. ` : targetPrefix;
    if (command === 'headingUp' || command === 'headingDown') {
      const level = /^(#{1,6})\s/.exec(line.text.slice(indentation.length))?.[1].length ?? 0;
      const next = Math.max(0, Math.min(6, level + (command === 'headingDown' ? 1 : -1)));
      prefix = next ? '#'.repeat(next) + ' ' : '';
    }
    return { from: line.from + indentation.length, to: line.from + indentation.length + existing.length, insert: prefix };
  });
  const transaction = view.state.update({ changes, annotations: annotation });
  view.dispatch(transaction);
  return true;
}

function wrapMath(view: EditorView, block: boolean): boolean {
  const open = block ? '$$\n' : '$', close = block ? '\n$$' : '$';
  view.dispatch({ ...view.state.changeByRange(range => {
    const text = view.state.sliceDoc(range.from, range.to);
    let from = range.from, to = range.to, insert = open + text + close, wrapped = true;
    if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) { insert = text.slice(open.length, -close.length); wrapped = false; }
    else if (view.state.sliceDoc(Math.max(0, from - open.length), from) === open && view.state.sliceDoc(to, to + close.length) === close) { from -= open.length; to += close.length; insert = text; wrapped = false; }
    const first = from + (wrapped ? open.length : 0), last = from + insert.length - (wrapped ? close.length : 0);
    return { changes: { from, to, insert }, range: range.anchor > range.head ? EditorSelection.range(last, first) : EditorSelection.range(first, last) };
  }), annotations: annotation });
  return true;
}

function structuralLineCommand(view: EditorView, run: (target: EditorView) => boolean): boolean {
  const current = view.state.selection.main;
  let node = syntaxTree(view.state).resolveInner(current.head, -1);
  while (node.parent) {
    if (['Table', 'FencedCode'].includes(node.name) && node.from <= current.from && node.to >= current.to) {
      view.dispatch({ selection: EditorSelection.range(node.from, node.to) });
      break;
    }
    node = node.parent;
  }
  return run(view);
}

export function toggleHtmlComment(view: EditorView, lines: boolean, blocked: () => void): boolean {
  if (view.state.readOnly || view.compositionStarted) return false;
  const { state } = view;
  const ranges = state.selection.ranges;
  if (ranges.every(range => isCodeInput(view, range.from) && isCodeInput(view, range.to)))
    return (lines ? toggleComment : toggleBlockComment)(view);
  if (ranges.some(range => isCodeInput(view, range.from) || isCodeInput(view, range.to))) { blocked(); return true; }
  const plan = planHtmlCommentToggle(state.doc.toString(), ranges, lines, markdownCodeRanges(syntaxTree(state)));
  if (plan.blocked) { blocked(); return true; }
  const changes = state.changes(plan.edits.map(({ from, to, insert }) => ({ from, to, insert })));
  const selections = plan.edits.flatMap(edit => edit.selections).sort((a, b) => a.index - b.index).map(selection => EditorSelection.range(selection.anchor, selection.head));
  const effects: StateEffect<unknown>[] = plan.edits.flatMap(edit => edit.template ? [
    beginHtmlCommentTemplate.of({ ...edit.template, end: edit.template.to + 3 }),
    addAutomaticSymbolPair.of({ from: edit.template.from - 4, to: edit.template.to + 3, open: '<!--', close: '-->' })
  ] : []);
  view.dispatch({ changes, selection: EditorSelection.create(selections, Math.min(state.selection.mainIndex, selections.length - 1)), effects,
    annotations: [annotation, isolateHistory.of('full')], scrollIntoView: true });
  view.focus(); return true;
}

export function runEditorCommand(view: EditorView, command: EditorCommandId): boolean {
  if (/^heading/.test(command) || ['bullet', 'ordered', 'taskList', 'taskDone', 'quote'].includes(command)) return toggleLines(view, command);
  if (command === 'inlineMath' || command === 'blockMath') return wrapMath(view, command === 'blockMath');
  const lineCommands = { moveUp: moveLineUp, moveDown: moveLineDown, copyUp: copyLineUp, copyDown: copyLineDown, deleteLine };
  if (command in lineCommands) return structuralLineCommand(view, lineCommands[command as keyof typeof lineCommands]);
  if (command === 'blankAbove' || command === 'blankBelow') {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const above = command === 'blankAbove';
    const from = above ? line.from : line.to;
    view.dispatch({ changes: { from, insert: '\n' }, selection: EditorSelection.cursor(above ? from : from + 1), annotations: annotation });
    return true;
  }
  if (command === 'convert') {
    if (isCodeInput(view)) return false;
    const selection = view.state.selection.main;
    const text = view.state.sliceDoc(selection.from, selection.to);
    const tsv = parseDelimitedTable(text, '\t');
    const cells = tsv && tsv[0].length > 1 ? tsv : parseDelimitedTable(text, ',');
    if (!cells || cells[0].length < 2) return false;
    const insert = markdownTableFromCells(cells);
    view.dispatch({ changes: { from: selection.from, to: selection.to, insert }, selection: EditorSelection.cursor(selection.from + insert.length), annotations: annotation });
    return true;
  }
  if (command === 'expandSelection') {
    const before = view.state.selection;
    const record = selectionHistory.get(view);
    const history = record?.after.eq(before) ? record.before : [];
    const changed = selectParentSyntax(view);
    if (changed) selectionHistory.set(view, { after: view.state.selection, before: [...history, before] });
    return changed;
  }
  if (command === 'shrinkSelection') {
    const record = selectionHistory.get(view);
    if (!record?.after.eq(view.state.selection) || !record.before.length) return false;
    const before = record.before.pop()!;
    view.dispatch({ selection: before });
    selectionHistory.set(view, { after: before, before: record.before });
    return true;
  }
  if (command === 'nextOccurrence') return selectNextOccurrence(view);
  if (command === 'skipOccurrence') {
    const before = view.state.selection;
    if (!selectNextOccurrence(view)) return false;
    const next = view.state.selection.main;
    const ranges = before.ranges.filter((_, index) => index !== before.mainIndex);
    view.dispatch({ selection: EditorSelection.create([...ranges, next]) });
    return true;
  }
  if (command === 'addCursor') {
    const ranges = view.state.selection.ranges.slice();
    const main = view.state.selection.main;
    const line = view.state.doc.lineAt(main.head);
    if (line.number === view.state.doc.lines) return false;
    const below = view.state.doc.line(line.number + 1);
    ranges.push(EditorSelection.cursor(below.from + Math.min(main.head - line.from, below.length)));
    view.dispatch({ selection: EditorSelection.create(ranges, ranges.length - 1) });
    return true;
  }
  if (command === 'splitCursors') {
    const ranges: SelectionRange[] = [];
    for (const range of view.state.selection.ranges) {
      const first = view.state.doc.lineAt(range.from), last = view.state.doc.lineAt(range.empty ? range.to : Math.max(range.from, range.to - 1));
      for (let number = first.number; number <= last.number; number++) {
        const line = view.state.doc.line(number);
        ranges.push(EditorSelection.cursor(Math.min(line.to, range.to)));
      }
    }
    view.dispatch({ selection: EditorSelection.create(ranges) });
    return true;
  }
  return false;
}

class SecondaryCursor extends WidgetType {
  toDOM() { const element = document.createElement('span'); element.className = 'meo-secondary-cursor'; return element; }
}
const secondaryCursor = new SecondaryCursor();
export const secondarySelections = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = this.build(view); }
  update(update: ViewUpdate) { if (update.selectionSet || update.docChanged) this.decorations = this.build(update.view); }
  build(view: EditorView) {
    const ranges = view.state.selection.ranges.flatMap((range, index) => index === view.state.selection.mainIndex ? [] : [
      ...(!range.empty ? [Decoration.mark({ class: 'meo-secondary-selection' }).range(range.from, range.to)] : []),
      Decoration.widget({ widget: secondaryCursor, side: 1 }).range(range.head)
    ]);
    return Decoration.set(ranges, true);
  }
}, { decorations: plugin => plugin.decorations });

/** All ranges share one transaction and history entry. */
export function formatMultipleSelections(view: EditorView, action: string): boolean {
  const markers: Record<string, [string, string]> = { bold: ['**', '**'], italic: ['*', '*'], strike: ['~~', '~~'], lineover: ['~~', '~~'], highlight: ['==', '=='], underline: ['<u>', '</u>'], kbd: ['<kbd>', '</kbd>'] };
  if (!markers[action] && action !== 'inlineCode' && !['link', 'wikiLink', 'image'].includes(action)) return false;
  const changes = view.state.changeByRange(range => {
    const text = view.state.sliceDoc(range.from, range.to);
    let open: string, close: string;
    if (action === 'inlineCode') ({ open, close } = inlineCodeMarkers(text));
    else if (['link', 'wikiLink', 'image'].includes(action)) { open = action === 'wikiLink' ? '[[' : action === 'image' ? '![' : '['; close = action === 'wikiLink' ? ']]' : '](url)'; }
    else [open, close] = markers[action];
    const plan = planInlineWrapper(text, view.state.sliceDoc(Math.max(0, range.from - open.length), range.from), view.state.sliceDoc(range.to, range.to + close.length), open, close);
    const from = range.from - plan.removeBefore;
    const anchor = from + plan.selectedFrom, head = from + plan.selectedTo;
    return { changes: { from, to: range.to + plan.removeAfter, insert: plan.insert }, range: range.anchor > range.head ? EditorSelection.range(head, anchor) : EditorSelection.range(anchor, head) };
  });
  view.dispatch({ ...changes, annotations: annotation }); return true;
}
