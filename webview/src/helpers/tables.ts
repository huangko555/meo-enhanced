import { EditorState, RangeSet, RangeValue, StateEffect, StateField, type Range, type SelectionRange as CodeMirrorSelectionRange, type Transaction } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common';
import { isolateHistory } from '@codemirror/commands';
import { disposeImagePresentations, ImageWidget } from './images';
import {
  getImagePresentationFactory,
  type ImagePresentationFactory
} from '../editor/imagePresentation';
import { emojiData } from './emoji';
import { parseKbdTagAt } from './kbd';
import { createLatexMathElement, parseLatexMathAt } from './math';
import { isPrimaryModifierPointerClick } from './linkNavigation';
import { wikiLinkScheme } from './wikiLinks';
import { normalizeSourceHref } from './rawUrls';
import type { EditorDiagnostic } from './diagnostics';
import { continuedListMarker, listMarkerData, nextOrderedSequenceNumber } from './listMarkers';
import { getViewportController } from './viewportController';
import { changedDocumentRange, runEditorHistoryCommand } from './historyCommands';
import { createOpenLinkButton } from './linkOpenButton';
import { collectColorRangesFromText, createColorSwatchElement } from './colorSwatches';
import {
  createMissingLocalLinkIndicator,
  isMissingLocalLinkTarget
} from './localLinks';
import {
  appendInlineMappedText,
  resolveInlineCaretAtPoint,
  setInlineSourceRange,
  type InlineCaretResolution,
  type InlineDomCaret
} from './inlinePresentation';
import { updateGitDiffMarkerElement } from './gitDiffMarkerDom';
import {
  getTableTransactionProvenance,
  getTableTransactionProvenanceSnapshot
} from '../adapters/tableTransactionProvenance';
import {
  tableStickyHeaderAdapterFactoryFacet,
  type TableStickyHeaderAdapter,
  type TableStickyHeaderAdapterFactory,
  type TableStickyHeaderElements,
  type TableWidgetLayoutScheduler
} from '../editor/tableStickyHeaderAdapter';
import {
  tableCommandEnvironmentFacet,
  type TableCommandEditorTarget,
  type TableCommandEnvironment,
  type TableCommandTargetRegistration,
  type TableCommandTransactionPlan
} from '../editor/tableCommandAdapter';
import type { TableCommand, TableCommandTarget } from '../application/tableCommand';

interface TableData {
  rows: string[][];
  alignments: TableAlignment[];
  colCount: number;
  startLine?: number;
  endLine?: number;
  indent?: string;
  signature?: string;
  from?: number;
  to?: number;
  headerCells?: string[];
  diagnostics?: TableCellDiagnostics[][][];
  sourceRanges?: TableCellRange[][];
  diffFlagsByLine?: Record<number, TableDiffFlags>;
}

interface TableDiffFlags {
  added?: boolean;
  modified?: boolean;
  baselineLineNumber?: number;
  modifiedRanges?: Array<[number, number]>;
  deleted?: boolean;
  deletionAtEnd?: boolean;
  deletionBoundary?: number;
  baselineFromLine?: number;
  baselineToLine?: number;
  deletionRanges?: Array<[number, number]>;
}

interface RowEntry {
  row: HTMLTableRowElement;
  inputs: HTMLTextAreaElement[];
}

interface DomRefs {
  headerInputs: HTMLTextAreaElement[];
  rowInputs: HTMLTextAreaElement[][];
  allRowInputs: HTMLTextAreaElement[][];
  table: HTMLTableElement;
  tbody: HTMLTableSectionElement;
  container: HTMLElement;
  shell: HTMLElement;
  wrap: HTMLElement;
  lineNumberLayer: HTMLElement;
  diffMarkerLayer: HTMLElement;
  cellGrid: HTMLTableCellElement[][];
  rowEntries: RowEntry[];
  sourceBodyRowInputs: HTMLTextAreaElement[][];
  stickyChrome: HTMLDivElement;
  stickyHeaderViewport: HTMLDivElement;
  stickyTable: HTMLTableElement;
  stickyHeaderRow: HTMLTableRowElement;
  toolbarButtons: {
    insertRowAbove: HTMLButtonElement;
    insertRowBelow: HTMLButtonElement;
    deleteRow: HTMLButtonElement;
    insertColumnLeft: HTMLButtonElement;
    insertColumnRight: HTMLButtonElement;
    deleteColumn: HTMLButtonElement;
    alignColumnLeft: HTMLButtonElement;
    alignColumnCenter: HTMLButtonElement;
    alignColumnRight: HTMLButtonElement;
  };
}

interface CellCoords {
  row: number;
  col: number;
}

interface SelectionRange {
  fromRow: number;
  toRow: number;
  fromCol: number;
  toCol: number;
}

interface CellMatrix {
  headerCells: string[];
  rows: string[][];
  alignments?: TableAlignment[];
}

interface WidgetTableData extends TableData {
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  indent: string;
  signature: string;
  headerCells: string[];
}

interface TableRange {
  from: number;
  to: number;
}

interface TableToolbarIcon {
  className: string;
  paths: string[];
}

interface TableActionTarget {
  row: number;
  col: number;
}

interface PendingCellFocus {
  row: number;
  col: number;
  caret?: number;
}

interface PendingCellEdit {
  row: number;
  col: number;
  value: string;
  sequence: number;
}

interface PendingTableTransactionBuilder {
  sequence: number;
  build: (state: EditorState) => Transaction | null;
}

interface PendingTableCommitDetail {
  committed: boolean;
  transactionBuilders: PendingTableTransactionBuilder[];
}

function isPendingTableCommitDetail(value: unknown): value is PendingTableCommitDetail {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'committed' in value &&
    typeof value.committed === 'boolean' &&
    'transactionBuilders' in value &&
    Array.isArray(value.transactionBuilders)
  );
}

interface TableCellDiagnostics {
  from: number;
  to: number;
  severity: 0 | 1 | 2 | 3;
  message: string;
  source?: string;
  code?: string;
}

interface TableCellRange {
  from: number;
  to: number;
}

interface TableSearchState {
  text: string;
  wholeWord: boolean;
  caseSensitive: boolean;
  selectionFrom: number;
  selectionTo: number;
}

interface TableSearchMatchRange {
  start: number;
  end: number;
}

const sourceTableHeaderLineDeco = Decoration.line({ class: 'meo-md-source-table-header-line' });
const sourceTableHeaderCellDeco = Decoration.mark({ class: 'meo-md-source-table-header-cell' });
const tableDelimiterRegex = /^\s*\|?\s*[:]?\-+[:]?\s*(\|\s*[:]?\-+[:]?\s*)*\|?$/;
const tableCellSelector = 'th[data-table-row][data-table-col], td[data-table-row][data-table-col]';
const tableControlSelector = '.meo-md-html-table-toolbar, .meo-md-html-table-toolbar-btn, .meo-md-link-open-btn, .meo-md-html-table-column-resize-handle';
const tableToolbarHeight = 24;
let nextTableCellEditSequence = 0;

export function commitPendingTableEdits(view: EditorView): boolean {
  const detail: PendingTableCommitDetail = {
    committed: false,
    transactionBuilders: []
  };
  document.dispatchEvent(new CustomEvent('meo-commit-table-edits', { detail }));

  let state = view.state;
  const transactions: Transaction[] = [];
  for (const pending of detail.transactionBuilders.sort((left, right) => left.sequence - right.sequence)) {
    const transaction = pending.build(state);
    if (!transaction) continue;
    transactions.push(transaction);
    state = transaction.state;
  }
  if (transactions.length) view.dispatch(transactions);
  return detail.committed;
}

function isTableSearchState(value: unknown): value is TableSearchState {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'text' in value && typeof value.text === 'string' &&
    'wholeWord' in value && typeof value.wholeWord === 'boolean' &&
    'caseSensitive' in value && typeof value.caseSensitive === 'boolean' &&
    'selectionFrom' in value && typeof value.selectionFrom === 'number' &&
    'selectionTo' in value && typeof value.selectionTo === 'number'
  );
}

interface TablePointerCaret {
  domCaret: InlineDomCaret | null;
  editorOffset: number | null;
}

type TableAlignment = '' | 'left' | 'center' | 'right' | null;

interface ParsedTableCellSegment {
  from: number;
  to: number;
  cellIndex: number;
  empty: boolean;
}

interface ParsedTableRowCells {
  cells: string[];
  pipes: number[];
  segments: ParsedTableCellSegment[];
}

interface ParsedTableLine extends ParsedTableRowCells {
  lineNo: number;
  from: number;
  to: number;
  text: string;
}

interface BuiltTableData {
  from: number;
  to: number;
  lines: ParsedTableLine[];
  delimiterIdx: number;
  headerLine: ParsedTableLine | null;
  dataLines: ParsedTableLine[];
  alignments: TableAlignment[];
  colCount: number;
  startLine: number;
  endLine: number;
}

function stabilizeHistoryScrollTop(view: EditorView, targetTop: number) {
  const viewportController = getViewportController(view);
  if (viewportController) {
    viewportController.lockScrollTop(targetTop);
  }
}

export function focusTableHistoryChange(
  view: EditorView,
  changed: { from: number; to: number },
  previousScrollTop: number,
  targetPosition?: number,
  isCurrent: () => boolean = () => true
): boolean {
  if (!isCurrent()) return false;

  const changedLine = view.state.doc.lineAt(Math.min(changed.from, view.state.doc.length)).number;
  const findInput = () => {
    let closest: { input: HTMLTextAreaElement; distance: number } | null = null;
    for (const input of view.dom.querySelectorAll<HTMLTextAreaElement>(
      '.meo-md-html-table-wrap textarea[data-table-cell-from][data-table-cell-to]'
    )) {
      const sourceLine = Number.parseInt(input.closest('tr')?.dataset.sourceLineNumber ?? '', 10);
      if (sourceLine !== changedLine) continue;
      const from = Number.parseInt(input.dataset.tableCellFrom ?? '', 10);
      const to = Number.parseInt(input.dataset.tableCellTo ?? '', 10);
      if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
      const distance = changed.to < from
        ? from - changed.to
        : changed.from > to
          ? changed.from - to
          : 0;
      if (!closest || distance < closest.distance) closest = { input, distance };
    }
    return closest?.input ?? null;
  };

  if (!view.state.doc.line(changedLine).text.includes('|')) return false;
  let viewportPreservationScheduled = false;
  const focusInput = () => {
    if (!isCurrent()) return false;
    const input = findInput();
    if (!input) return false;
    const cellFrom = Number.parseInt(input.dataset.tableCellFrom ?? '', 10);
    const cellTo = Number.parseInt(input.dataset.tableCellTo ?? '', 10);
    const sourceCaret = Math.min(Math.max((targetPosition ?? changed.to) - cellFrom, 0), cellTo - cellFrom);
    const caret = tableCellSourceOffsetToEditorOffset(input.value, sourceCaret);
    input.focus({ preventScroll: true });
    input.setSelectionRange(caret, caret);

    const cell = input.closest<HTMLElement>(tableCellSelector);
    if (!cell) return true;
    const cellRect = cell.getBoundingClientRect();
    const scrollerRect = view.scrollDOM.getBoundingClientRect();
    const cellTop = cellRect.top - scrollerRect.top + view.scrollDOM.scrollTop;
    const cellBottom = cellTop + cellRect.height;
    const wasVisible = (
      cellBottom > previousScrollTop &&
      cellTop < previousScrollTop + view.scrollDOM.clientHeight
    );
    if (wasVisible) {
      if (!viewportPreservationScheduled) {
        viewportPreservationScheduled = true;
        stabilizeHistoryScrollTop(view, previousScrollTop);
      }
      return true;
    }
    const isFullyVisible = (
      cellRect.top >= scrollerRect.top &&
      cellRect.bottom <= scrollerRect.bottom &&
      cellRect.left >= scrollerRect.left &&
      cellRect.right <= scrollerRect.right
    );
    if (!isFullyVisible) {
      const viewportController = getViewportController(view);
      viewportController?.revealElement(cell);
    }
    return true;
  };
  if (focusInput()) return true;
  return false;
}

export function focusHistoryChange(
  view: EditorView,
  changed: { from: number; to: number } | null,
  previousScrollTop: number,
  revealSelection?: (anchor: number, head: number) => void,
  previousSelection?: {
    lineNumber: number;
    visibleFromLineNumber: number;
    visibleToLineNumber: number;
    wasVisible: boolean;
  },
  targetPosition?: number,
  isCurrent: () => boolean = () => true
) {
  const target = targetPosition ?? changed?.to;
  if (typeof target === 'number' && view.state.selection.main.head !== target) {
    view.dispatch({ selection: { anchor: target } });
  }
  // EditorView.focus() suppresses the DOM selection observer while restoring
  // the state selection. Focusing contentDOM directly can replay the stale DOM
  // caret from the previously focused embedded editor and overwrite `target`.
  view.focus();
  let viewportPreservationScheduled = false;
  let tableFocused = false;
  const revealOffscreenSelection = (block: ReturnType<EditorView['lineBlockAt']>) => {
    if (!isCurrent() || tableFocused) return;
    const selection = view.state.selection.main;
    if (revealSelection) {
      revealSelection(selection.anchor, selection.head);
    } else {
      view.dispatch({ effects: EditorView.scrollIntoView(selection.head, { y: 'nearest' }) });
    }
  };
  const revealSelectionIfNeeded = () => {
    if (!isCurrent() || tableFocused) return;
    const head = view.state.selection.main.head;
    const block = view.lineBlockAt(head);
    const currentScrollTop = view.scrollDOM.scrollTop;
    const coords = view.coordsAtPos(head);
    const scrollerRect = view.scrollDOM.getBoundingClientRect();
    const isVisibleNow = coords
      ? coords.top >= scrollerRect.top && coords.bottom <= scrollerRect.bottom
      : block.bottom > currentScrollTop && block.top < currentScrollTop + view.scrollDOM.clientHeight;
    const targetLine = view.state.doc.lineAt(head).number;
    const wasVisibleBeforeReplay = Boolean(
      previousSelection?.wasVisible &&
      targetLine >= previousSelection.visibleFromLineNumber &&
      targetLine <= previousSelection.visibleToLineNumber
    ) || (
      block.top >= previousScrollTop &&
      block.bottom <= previousScrollTop + view.scrollDOM.clientHeight
    );
    if (wasVisibleBeforeReplay) {
      if (!viewportPreservationScheduled) {
        viewportPreservationScheduled = true;
        stabilizeHistoryScrollTop(view, previousScrollTop);
      }
      return;
    }
    // CodeMirror may already have revealed an offscreen history target while
    // applying the transaction. In that case any second scroll only creates a
    // visible bounce, so keep the current nearest position.
    if (isVisibleNow) return;
    if (!coords) {
      revealOffscreenSelection(block);
      return;
    }
    if (coords.top < scrollerRect.top || coords.bottom > scrollerRect.bottom) {
      revealOffscreenSelection(block);
    }
  };
  // Start offscreen history navigation before the next paint. Unmeasured
  // CodeMirror regions otherwise need one frame to request layout and another
  // to scroll, which briefly paints the old viewport on first use.
  revealSelectionIfNeeded();
  requestAnimationFrame(() => {
    revealSelectionIfNeeded();
    requestAnimationFrame(revealSelectionIfNeeded);
  });

}

function tableHasReachedStickyThreshold(tableRect: DOMRect, scrollerRect: DOMRect) {
  const stickyBottom = scrollerRect.top + tableToolbarHeight;
  return tableRect.top <= stickyBottom && tableRect.bottom > stickyBottom;
}

class TableHeaderAlignmentOverrideValue extends RangeValue {
  constructor(readonly columns: ReadonlySet<number>) {
    super();
  }

  eq(other: RangeValue): boolean {
    if (!(other instanceof TableHeaderAlignmentOverrideValue) || other.columns.size !== this.columns.size) return false;
    return [...this.columns].every((column) => other.columns.has(column));
  }
}

const setTableHeaderAlignmentOverrideEffect = StateEffect.define<{
  from: number;
  to: number;
  column: number;
}>();

export const tableHeaderAlignmentOverrideField = StateField.define<RangeSet<TableHeaderAlignmentOverrideValue>>({
  create() {
    return RangeSet.empty;
  },
  update(value, transaction) {
    const mapped = value.map(transaction.changes);
    const overrideEffects = transaction.effects.filter((effect) => effect.is(setTableHeaderAlignmentOverrideEffect));
    if (!overrideEffects.length) return mapped;

    const entries: Array<{ from: number; to: number; value: TableHeaderAlignmentOverrideValue }> = [];
    mapped.between(0, transaction.state.doc.length, (from, to, rangeValue) => {
      entries.push({ from, to, value: rangeValue });
    });
    for (const effect of overrideEffects) {
      const existing = entries.find((entry) => entry.from === effect.value.from && entry.to === effect.value.to);
      const columns = new Set(existing?.value.columns ?? []);
      columns.add(effect.value.column);
      const nextValue = new TableHeaderAlignmentOverrideValue(columns);
      if (existing) existing.value = nextValue;
      else entries.push({ from: effect.value.from, to: effect.value.to, value: nextValue });
    }
    entries.sort((left, right) => left.from - right.from || left.to - right.to);
    return RangeSet.of(entries.map((entry) => entry.value.range(entry.from, entry.to)), true);
  }
});

// Icons are inline SVG path data from Tabler Icons (MIT), vendored to avoid a
// broad icon dependency for this table-only toolbar.
const tableToolbarIcons: Record<string, TableToolbarIcon> = {
  rowInsertTop: {
    className: 'icon-tabler-row-insert-top',
    paths: [
      'M4 18v-4a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1',
      'M12 9v-4',
      'M10 7l4 0'
    ]
  },
  rowInsertBottom: {
    className: 'icon-tabler-row-insert-bottom',
    paths: [
      'M20 6v4a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1',
      'M12 15l0 4',
      'M14 17l-4 0'
    ]
  },
  columnInsertLeft: {
    className: 'icon-tabler-column-insert-left',
    paths: [
      'M14 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1',
      'M5 12l4 0',
      'M7 10l0 4'
    ]
  },
  columnInsertRight: {
    className: 'icon-tabler-column-insert-right',
    paths: [
      'M6 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1',
      'M15 12l4 0',
      'M17 10l0 4'
    ]
  },
  rowRemove: {
    className: 'icon-tabler-row-remove',
    paths: [
      'M20 6v4a1 1 0 0 1 -1 1h-14a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h14a1 1 0 0 1 1 1',
      'M10 16l4 4',
      'M10 20l4 -4'
    ]
  },
  columnRemove: {
    className: 'icon-tabler-column-remove',
    paths: [
      'M6 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-14a1 1 0 0 1 1 -1',
      'M16 10l4 4',
      'M16 14l4 -4'
    ]
  },
  alignLeft: {
    className: 'icon-tabler-align-left',
    paths: [
      'M4 6l16 0',
      'M4 12l10 0',
      'M4 18l14 0'
    ]
  },
  alignRight: {
    className: 'icon-tabler-align-right',
    paths: [
      'M4 6l16 0',
      'M10 12l10 0',
      'M6 18l14 0'
    ]
  },
  alignCenter: {
    className: 'icon-tabler-align-center',
    paths: [
      'M4 6l16 0',
      'M6 12l12 0',
      'M5 18l14 0'
    ]
  }
};

function isTableControlTarget(target: EventTarget | null): boolean {
  return Boolean(target instanceof Element && target.closest(tableControlSelector));
}

function isSelectionMenuTarget(target: EventTarget | null): boolean {
  return Boolean(target instanceof Element && target.closest('.selection-inline-menu'));
}

function targetElementFrom(target: EventTarget | null): Element | null {
  return target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
}

function isPrimaryModifier(event: Pick<KeyboardEvent, 'altKey' | 'metaKey' | 'ctrlKey'>): boolean {
  if (event.altKey) return false;
  return event.metaKey || event.ctrlKey;
}

function isModifierLinkActivationEvent(event: PointerEvent): boolean {
  return Boolean(getModifierLinkActivationHref(event));
}

function getModifierLinkActivationHref(event: PointerEvent): string {
  if (!isPrimaryModifierPointerClick(event)) return '';
  const target = targetElementFrom(event.target);
  if (!target) return '';
  const link = target.closest('[data-meo-link-href]');
  if (!(link instanceof Element)) return '';
  const href = link.getAttribute('data-meo-link-href');
  return href || '';
}

function isUndoShortcut(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'z' && !event.shiftKey;
}

function isRedoShortcut(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase();
  return (key === 'z' && event.shiftKey) || key === 'y';
}

// Table widget inline preview + pipe-aware row parsing are table-specific and
// live here to keep all HTML-table behavior in one helper module.
const tableInlineSchemeRe = /^[a-z][a-z0-9+.-]*:/i;
const tableInlineRawUrlRe = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|file:|www\.)[^\s<]+/i;
const tableInlineEmojiShortcodeRe = /^:([a-zA-Z0-9_+-]+):/;
const tableInlineTagRe = /^#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/u;
const tableInlineTagPrefixRe = /[\p{L}\p{N}_/-]/u;
const tableCellBreakAtRe = /^<br\s*\/?>/i;
const tableCellListItemRe = /^([ \t]*)(?:(?<bullet>[-+*])|(?<number>\d+)\.)\s+(?<content>.*)$/;
const tableInlineEscapableChars = new Set(['\\', '*', '_', '~', '`', '[', ']', '(', ')', '!', '|', '<', '>']);
const tableSearchStateEventName = 'meo-search-state-change';
const tableDiagnosticSeverityClasses = [
  'meo-diagnostic-error',
  'meo-diagnostic-warning',
  'meo-diagnostic-info',
  'meo-diagnostic-hint'
];

function isTableInlineWhitespaceOnly(text: string): boolean {
  return /^\s+$/.test(text);
}

function isTableInlineEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return (slashCount % 2) === 1;
}

function isTableInlineAsciiAlnum(char: string): boolean {
  return Boolean(char) && /[A-Za-z0-9]/.test(char);
}

function canOpenTableInlineDelimiter(text: string, index: number, marker: string): boolean {
  if (isTableInlineEscaped(text, index)) return false;
  const markerLen = marker.length;
  const next = text[index + markerLen] ?? '';
  if (!next || /\s/.test(next)) return false;
  if (marker.includes('_') && isTableInlineAsciiAlnum(text[index - 1] ?? '')) return false;
  return true;
}

function canCloseTableInlineDelimiter(text: string, index: number, marker: string): boolean {
  if (isTableInlineEscaped(text, index)) return false;
  const previous = text[index - 1] ?? '';
  if (!previous || /\s/.test(previous)) return false;
  if (marker.includes('_') && isTableInlineAsciiAlnum(text[index + marker.length] ?? '')) return false;
  return true;
}

function isTableInlineUrlLike(text: string): boolean {
  return tableInlineRawUrlRe.test(text) || tableInlineSchemeRe.test(text);
}

function tableInlineHrefFromRawUrl(text: string): string {
  return normalizeSourceHref(text);
}

function tableInlineHrefFromWikiTarget(target: string | null | undefined): string {
  const trimmed = (target ?? '').trim();
  if (!trimmed) return '';
  if (tableInlineSchemeRe.test(trimmed)) return trimmed;
  return `${wikiLinkScheme}${encodeURIComponent(trimmed)}`;
}

function tableDiagnosticTitle(diagnostic: TableCellDiagnostics): string {
  const parts = [];
  if (diagnostic.source) parts.push(diagnostic.source);
  if (diagnostic.code) parts.push(diagnostic.code);
  const prefix = parts.length ? `${parts.join(' ')}: ` : '';
  return `${prefix}${diagnostic.message}`;
}

function isTableSearchWordCharacter(value: string): boolean {
  return /[0-9A-Za-z_]/.test(value);
}

function isWholeWordTableSearchRange(text: string, start: number, end: number): boolean {
  const previous = start > 0 ? text.slice(start - 1, start) : '';
  const next = end < text.length ? text.slice(end, end + 1) : '';
  return !isTableSearchWordCharacter(previous) && !isTableSearchWordCharacter(next);
}

function findTableSearchMatchRanges(text: string, searchState: TableSearchState | null): TableSearchMatchRange[] {
  const query = searchState?.text ?? '';
  if (!query) {
    return [];
  }

  const haystack = searchState?.caseSensitive ? text : text.toLocaleLowerCase();
  const needle = searchState?.caseSensitive ? query : query.toLocaleLowerCase();
  const matches: TableSearchMatchRange[] = [];
  let offset = 0;
  while (offset <= text.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) {
      break;
    }

    const end = index + query.length;
    if (!searchState?.wholeWord || isWholeWordTableSearchRange(text, index, end)) {
      matches.push({ start: index, end });
    }
    offset = end;
  }
  return matches;
}

interface TableCellLogicalLine {
  text: string;
  from: number;
  breakText: string;
}

function splitTableCellLogicalLines(text: string): TableCellLogicalLine[] {
  const lines: TableCellLogicalLine[] = [];
  let lineStart = 0;
  for (let index = 0; index < text.length;) {
    const breakMatch = !isTableInlineEscaped(text, index) ? tableCellBreakAtRe.exec(text.slice(index)) : null;
    if (breakMatch) {
      lines.push({ text: text.slice(lineStart, index), from: lineStart, breakText: breakMatch[0] });
      index += breakMatch[0].length;
      lineStart = index;
      continue;
    }

    const protectedNext = consumeTableInlineProtectedSpan(text, index, text.length);
    if (protectedNext && protectedNext > index) {
      index = protectedNext;
      continue;
    }
    index += 1;
  }
  lines.push({ text: text.slice(lineStart), from: lineStart, breakText: '' });
  return lines;
}

export function tableCellEditorValueToSource(value: string): string {
  let source = '';
  for (let index = 0; index < value.length;) {
    const breakMatch = !isTableInlineEscaped(value, index) ? tableCellBreakAtRe.exec(value.slice(index)) : null;
    if (breakMatch) {
      source += breakMatch[0];
      index += breakMatch[0].length;
      if (value[index] === '\r') index += 1;
      if (value[index] === '\n') index += 1;
      continue;
    }

    const protectedNext = consumeTableInlineProtectedSpan(value, index, value.length);
    if (protectedNext && protectedNext > index) {
      source += value.slice(index, protectedNext);
      index = protectedNext;
      continue;
    }
    if (value[index] === '\r') {
      if (value[index + 1] === '\n') index += 1;
      source += '<br>';
    } else if (value[index] === '\n') {
      source += '<br>';
    } else {
      source += value[index];
    }
    index += 1;
  }
  return source;
}

export function tableCellSourceToEditorValue(value: string): string {
  return splitTableCellLogicalLines(value)
    .map((line) => line.text + (line.breakText ? `${line.breakText}\n` : ''))
    .join('');
}

export function tableCellEditorOffsetToSourceOffset(value: string, offset: number): number {
  return tableCellEditorValueToSource(value.slice(0, Math.max(0, offset))).length;
}

export function tableCellSourceOffsetToEditorOffset(value: string, offset: number): number {
  const source = tableCellEditorValueToSource(value);
  return tableCellSourceToEditorValue(source.slice(0, Math.max(0, offset))).length;
}

function normalizeTableCellEditorInput(input: HTMLTextAreaElement) {
  const value = input.value;
  const selectionStart = tableCellEditorOffsetToSourceOffset(value, input.selectionStart ?? 0);
  const selectionEnd = tableCellEditorOffsetToSourceOffset(value, input.selectionEnd ?? input.selectionStart ?? 0);
  const normalized = tableCellSourceToEditorValue(tableCellEditorValueToSource(value));
  if (normalized === value) return;
  input.value = normalized;
  input.setSelectionRange(
    tableCellSourceOffsetToEditorOffset(normalized, selectionStart),
    tableCellSourceOffsetToEditorOffset(normalized, selectionEnd)
  );
}

function replaceTableCellEditorSelection(input: HTMLTextAreaElement, insert: string) {
  const start = input.selectionStart ?? 0;
  const end = input.selectionEnd ?? start;
  input.setRangeText(insert, start, end, 'end');
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function continueTableCellList(input: HTMLTextAreaElement) {
  const position = input.selectionStart ?? 0;
  if (position !== (input.selectionEnd ?? position)) return false;
  const lineStart = input.value.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const nextBreak = input.value.indexOf('\n', position);
  const lineEnd = nextBreak < 0 ? input.value.length : nextBreak;
  if (position !== lineEnd) return false;

  const lineText = input.value.slice(lineStart, lineEnd);
  const marker = continuedListMarker(lineText);
  if (marker) {
    replaceTableCellEditorSelection(input, `<br>\n${marker}`);
    return true;
  }

  const currentMarker = listMarkerData(lineText);
  if (!currentMarker || lineText.slice(currentMarker.toOffset).trim()) return false;
  input.setSelectionRange(lineStart, lineStart + currentMarker.toOffset);
  replaceTableCellEditorSelection(input, '');
  return true;
}

interface TableCellEditorChange {
  from: number;
  to: number;
  insert: string;
}

function applyTableCellEditorChanges(input: HTMLTextAreaElement, changes: TableCellEditorChange[]) {
  const selectionStart = input.selectionStart ?? 0;
  const selectionEnd = input.selectionEnd ?? selectionStart;
  const mapPosition = (position: number) => {
    let mapped = position;
    for (const change of changes) {
      const delta = change.insert.length - (change.to - change.from);
      if (position >= change.to) mapped += delta;
      else if (position > change.from) mapped = change.from + change.insert.length;
    }
    return mapped;
  };
  let nextValue = input.value;
  for (const change of [...changes].reverse()) {
    nextValue = nextValue.slice(0, change.from) + change.insert + nextValue.slice(change.to);
  }
  input.value = nextValue;
  input.setSelectionRange(mapPosition(selectionStart), mapPosition(selectionEnd));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function renumberTableCellOrderedLists(input: HTMLTextAreaElement) {
  const orderedCountsByLevel: Array<number | null> = [];
  const changes: TableCellEditorChange[] = [];
  for (let lineStart = 0; lineStart <= input.value.length;) {
    const lineEnd = input.value.indexOf('\n', lineStart);
    const safeLineEnd = lineEnd < 0 ? input.value.length : lineEnd;
    const lineText = input.value.slice(lineStart, safeLineEnd);
    const marker = listMarkerData(lineText);
    if (!marker) {
      orderedCountsByLevel.length = 0;
    } else {
      const { expected, isAnchor } = nextOrderedSequenceNumber(
        orderedCountsByLevel,
        marker.indentLevel,
        marker.orderedNumber
      );
      if (
        expected !== null
        && !isAnchor
        && marker.orderedNumber !== undefined
        && marker.orderedNumber !== String(expected)
      ) {
        const from = lineStart + marker.leadingWhitespace.length;
        changes.push({ from, to: from + marker.orderedNumber.length, insert: String(expected) });
      }
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  if (changes.length) applyTableCellEditorChanges(input, changes);
}

function adjustTableCellListIndent(input: HTMLTextAreaElement, direction: 'indent' | 'outdent') {
  const value = input.value;
  const selectionStart = input.selectionStart ?? 0;
  const selectionEnd = input.selectionEnd ?? selectionStart;
  const firstLineStart = value.lastIndexOf('\n', Math.max(0, selectionStart - 1)) + 1;
  const endProbe = selectionEnd > selectionStart ? selectionEnd - 1 : selectionEnd;
  const lastLineEnd = value.indexOf('\n', endProbe);
  const rangeEnd = lastLineEnd < 0 ? value.length : lastLineEnd;
  const changes: TableCellEditorChange[] = [];

  for (let lineStart = firstLineStart; lineStart <= rangeEnd;) {
    const lineEnd = value.indexOf('\n', lineStart);
    const safeLineEnd = lineEnd < 0 ? value.length : lineEnd;
    const line = value.slice(lineStart, safeLineEnd);
    if (/^ *(?:[-+*]|\d+\.)\s+/.test(line)) {
      if (direction === 'indent') {
        changes.push({ from: lineStart, to: lineStart, insert: '  ' });
      } else {
        const indentLength = Math.min(2, /^ */.exec(line)?.[0].length ?? 0);
        if (indentLength) changes.push({ from: lineStart, to: lineStart + indentLength, insert: '' });
      }
    }
    if (lineEnd < 0 || lineEnd >= rangeEnd) break;
    lineStart = lineEnd + 1;
  }

  if (!changes.length) return false;
  applyTableCellEditorChanges(input, changes);
  renumberTableCellOrderedLists(input);
  return true;
}

function shouldExpandTableCellForSearch(text: string, searchState: TableSearchState | null): boolean {
  return findTableSearchMatchRanges(text, searchState).length > 0;
}

function hasSameTableSearchQuery(left: TableSearchState | null, right: TableSearchState | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (
    left.text === right.text &&
    left.wholeWord === right.wholeWord &&
    left.caseSensitive === right.caseSensitive
  );
}

function tableSearchSelectionRange(searchState: TableSearchState | null): TableCellRange | null {
  if (!searchState || searchState.selectionTo <= searchState.selectionFrom) {
    return null;
  }
  return {
    from: searchState.selectionFrom,
    to: searchState.selectionTo
  };
}

function tableSearchRangeOverlapsCell(range: TableCellRange, cellRange: TableCellRange | null): boolean {
  return Boolean(cellRange && range.from < cellRange.to && range.to > cellRange.from);
}

function appendSearchHighlightedText(
  parent: HTMLElement,
  text: string,
  offset: number,
  searchState: TableSearchState | null,
  sourceRange: TableCellRange | null
) {
  const matches = findTableSearchMatchRanges(text, searchState);
  if (matches.length === 0) {
    appendInlineMappedText(parent, text, { from: offset, to: offset + text.length });
    return;
  }

  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      appendInlineMappedText(
        parent,
        text.slice(cursor, match.start),
        { from: offset + cursor, to: offset + match.start }
      );
    }

    const span = document.createElement('span');
    const absoluteFrom = (sourceRange?.from ?? 0) + offset + match.start;
    const absoluteTo = (sourceRange?.from ?? 0) + offset + match.end;
    const isActive = Boolean(searchState && absoluteFrom === searchState.selectionFrom && absoluteTo === searchState.selectionTo);
    span.className = isActive ? 'meo-search-match meo-search-match-active' : 'meo-search-match';
    const foreground = isActive
      ? 'var(--meo-semantic-searchMatchActiveForeground)'
      : 'var(--meo-semantic-searchMatchForeground)';
    span.style.setProperty('color', foreground, 'important');
    span.style.setProperty('-webkit-text-fill-color', foreground, 'important');
    span.textContent = text.slice(match.start, match.end);
    setInlineSourceRange(span, { from: offset + match.start, to: offset + match.end });
    parent.appendChild(span);
    cursor = match.end;
  }

  if (cursor < text.length) {
    appendInlineMappedText(parent, text.slice(cursor), { from: offset + cursor, to: offset + text.length });
  }
}

function appendTablePlainText(
  parent: HTMLElement,
  text: string,
  offset: number,
  diagnostics: TableCellDiagnostics[],
  searchState: TableSearchState | null,
  sourceRange: TableCellRange | null
) {
  if (!text) return;
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    appendSearchHighlightedText(parent, text, offset, searchState, sourceRange);
    return;
  }

  appendDiagnosticText(parent, text, offset, diagnostics, searchState, sourceRange);
}

function appendDiagnosticText(
  parent: HTMLElement,
  text: string,
  offset: number,
  diagnostics: TableCellDiagnostics[],
  searchState: TableSearchState | null,
  sourceRange: TableCellRange | null
) {
  if (!text) return;
  if (!Array.isArray(diagnostics) || diagnostics.length === 0) {
    appendSearchHighlightedText(parent, text, offset, searchState, sourceRange);
    return;
  }

  const from = offset;
  const to = offset + text.length;
  const relevant = diagnostics
    .filter((diagnostic) => diagnostic.from < to && diagnostic.to > from)
    .sort((left, right) => left.from === right.from ? left.to - right.to : left.from - right.from);
  if (relevant.length === 0) {
    appendSearchHighlightedText(parent, text, offset, searchState, sourceRange);
    return;
  }

  let cursor = from;
  for (const diagnostic of relevant) {
    const diagnosticFrom = Math.max(from, diagnostic.from);
    const diagnosticTo = Math.min(to, diagnostic.to);
    if (diagnosticTo <= diagnosticFrom || diagnosticFrom < cursor) {
      continue;
    }
    if (diagnosticFrom > cursor) {
      appendSearchHighlightedText(
        parent,
        text.slice(cursor - from, diagnosticFrom - from),
        cursor,
        searchState,
        sourceRange
      );
    }
    const span = document.createElement('span');
    const severityClass = tableDiagnosticSeverityClasses[diagnostic.severity] ?? tableDiagnosticSeverityClasses[0];
    span.className = `meo-diagnostic ${severityClass}`;
    span.title = tableDiagnosticTitle(diagnostic);
    appendSearchHighlightedText(
      span,
      text.slice(diagnosticFrom - from, diagnosticTo - from),
      diagnosticFrom,
      searchState,
      sourceRange
    );
    parent.appendChild(span);
    cursor = diagnosticTo;
  }
  if (cursor < to) {
    appendSearchHighlightedText(parent, text.slice(cursor - from), cursor, searchState, sourceRange);
  }
}

function decodeTableInlineEscapes(text: string): string {
  let result = '';
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\\' && i + 1 < text.length && tableInlineEscapableChars.has(text[i + 1])) {
      result += text[i + 1];
      i += 1;
      continue;
    }
    result += text[i];
  }
  return result;
}

function findTableInlineMatchingBackticks(text: string, index: number, tickCount: number): number {
  const marker = '`'.repeat(tickCount);
  for (let i = index; i <= text.length - tickCount; i += 1) {
    if (text.startsWith(marker, i)) return i;
  }
  return -1;
}

function parseTableInlineCodeSpan(text: string, index: number) {
  if (text[index] !== '`') return null;
  let tickCount = 1;
  while (text[index + tickCount] === '`') tickCount += 1;
  const close = findTableInlineMatchingBackticks(text, index + tickCount, tickCount);
  if (close < 0) return null;
  return {
    content: text.slice(index + tickCount, close),
    contentFrom: tickCount,
    nextIndex: close + tickCount
  };
}

function consumeTableInlineAngleSection(text: string, index: number) {
  if (text[index] !== '<' || isTableInlineEscaped(text, index)) return null;
  const close = text.indexOf('>', index + 1);
  if (close < 0) return null;
  return {
    content: text.slice(index + 1, close),
    nextIndex: close + 1
  };
}

function consumeTableInlineBracketContent(text: string, index: number) {
  if (text[index] !== '[' || isTableInlineEscaped(text, index)) return null;
  let depth = 1;
  for (let i = index + 1; i < text.length;) {
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    const code = parseTableInlineCodeSpan(text, i);
    if (code) {
      i = code.nextIndex;
      continue;
    }
    if (text[i] === '[' && !isTableInlineEscaped(text, i)) {
      depth += 1;
      i += 1;
      continue;
    }
    if (text[i] === ']' && !isTableInlineEscaped(text, i)) {
      depth -= 1;
      if (depth === 0) {
        return {
          content: text.slice(index + 1, i),
          nextIndex: i + 1
        };
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

function consumeTableInlineParenContent(text: string, index: number) {
  if (text[index] !== '(' || isTableInlineEscaped(text, index)) return null;
  let depth = 1;
  for (let i = index + 1; i < text.length;) {
    if (text[i] === '\\' && i + 1 < text.length) {
      i += 2;
      continue;
    }
    const code = parseTableInlineCodeSpan(text, i);
    if (code) {
      i = code.nextIndex;
      continue;
    }
    const angle = consumeTableInlineAngleSection(text, i);
    if (angle) {
      i = angle.nextIndex;
      continue;
    }
    if (text[i] === '(' && !isTableInlineEscaped(text, i)) {
      depth += 1;
      i += 1;
      continue;
    }
    if (text[i] === ')' && !isTableInlineEscaped(text, i)) {
      depth -= 1;
      if (depth === 0) {
        return {
          content: text.slice(index + 1, i),
          nextIndex: i + 1
        };
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return null;
}

function parseTableInlineMarkdownLink(text: string, index: number, { image = false }: { image?: boolean } = {}) {
  const start = image ? index + 1 : index;
  if (image) {
    if (!(text[index] === '!' && text[index + 1] === '[') || isTableInlineEscaped(text, index)) return null;
  } else if (text[index] !== '[' || isTableInlineEscaped(text, index)) {
    return null;
  }
  if (!image && text.startsWith('[[', index)) return null;

  const label = consumeTableInlineBracketContent(text, start);
  if (!label || text[label.nextIndex] !== '(') return null;
  const destination = consumeTableInlineParenContent(text, label.nextIndex);
  if (!destination) return null;

  let url = normalizeSourceHref(destination.content.trim());
  if (url.startsWith('<') && url.endsWith('>') && url.length >= 2) {
    url = url.slice(1, -1).trim();
  }

  return {
    label: label.content,
    labelFrom: start + 1,
    url,
    nextIndex: destination.nextIndex
  };
}

function parseTableInlineWikiLink(text: string, index: number) {
  if (!text.startsWith('[[', index) || isTableInlineEscaped(text, index)) return null;
  for (let i = index + 2; i < text.length - 1; i += 1) {
    if (text[i] === '\\') {
      i += 1;
      continue;
    }
    if (text[i] === ']' && text[i + 1] === ']' && !isTableInlineEscaped(text, i)) {
      const content = text.slice(index + 2, i);
      const pipeIndex = content.indexOf('|');
      const rawTarget = pipeIndex >= 0 ? content.slice(0, pipeIndex).trim() : content.trim();
      const rawAlias = pipeIndex >= 0 ? content.slice(pipeIndex + 1).trim() : '';
      const visibleRaw = pipeIndex >= 0 ? content.slice(pipeIndex + 1) : content;
      const visibleText = rawAlias || rawTarget;
      const visibleTextFrom = index + 2 + (pipeIndex >= 0 ? pipeIndex + 1 : 0) + (visibleRaw.search(/\S|$/));
      return {
        target: rawTarget,
        visibleText,
        visibleTextFrom,
        nextIndex: i + 2
      };
    }
  }
  return null;
}

function findTableInlineClosingMarker(text: string, startIndex: number, marker: string, { singleTilde = false }: { singleTilde?: boolean } = {}) {
  const markerLen = marker.length;
  for (let i = startIndex; i <= text.length - markerLen; i += 1) {
    if (!text.startsWith(marker, i)) continue;
    const delimiter = marker[0];
    let runEnd = i + markerLen;
    while (text[runEnd] === delimiter && !isTableInlineEscaped(text, runEnd)) {
      runEnd += 1;
    }
    const runLength = runEnd - i;
    // An even run belongs to nested strong markup, not to a surrounding
    // single-character emphasis span. For odd runs, the outer delimiter is
    // the final character (or pair) in the run.
    if (markerLen === 1 && runLength > 1 && runLength % 2 === 0) {
      i = runEnd - 1;
      continue;
    }
    const close = runEnd - markerLen;
    if (!canCloseTableInlineDelimiter(text, close, marker)) {
      i = runEnd - 1;
      continue;
    }
    if (singleTilde && (text[close - 1] === '~' || text[close + 1] === '~')) {
      i = runEnd - 1;
      continue;
    }
    return close;
  }
  return -1;
}

function parseTableInlineDelimitedSpan(text: string, index: number) {
  if (
    text.startsWith('==', index) &&
    text[index - 1] !== '=' &&
    text[index + 2] !== '=' &&
    canOpenTableInlineDelimiter(text, index, '==')
  ) {
    const start = index + 2;
    const close = findTableInlineClosingMarker(text, start, '==');
    if (close > start && text[close - 1] !== '=' && text[close + 2] !== '=') {
      const content = text.slice(start, close);
      if (!isTableInlineWhitespaceOnly(content)) {
        return { kind: 'highlight', content, nextIndex: close + 2 };
      }
    }
  }

  const strongMarker = text.startsWith('**', index)
    ? '**'
    : (text.startsWith('__', index) ? '__' : null);
  if (strongMarker && canOpenTableInlineDelimiter(text, index, strongMarker)) {
    const start = index + 2;
    const close = findTableInlineClosingMarker(text, start, strongMarker);
    if (close > start) {
      const content = text.slice(start, close);
      if (!isTableInlineWhitespaceOnly(content)) {
        return { kind: 'strong', content, nextIndex: close + 2 };
      }
    }
  }

  if (text.startsWith('~~', index)) {
    const start = index + 2;
    const close = findTableInlineClosingMarker(text, start, '~~');
    if (close > start) {
      const content = text.slice(start, close);
      if (!isTableInlineWhitespaceOnly(content)) {
        return { kind: 'strike', content, nextIndex: close + 2 };
      }
    }
  }

  const emMarker = (text[index] === '*' || text[index] === '_') ? text[index] : null;
  if (emMarker && text[index + 1] !== emMarker && canOpenTableInlineDelimiter(text, index, emMarker)) {
    const start = index + 1;
    const close = findTableInlineClosingMarker(text, start, emMarker);
    if (close > start) {
      const content = text.slice(start, close);
      if (!isTableInlineWhitespaceOnly(content)) {
        return { kind: 'em', content, nextIndex: close + 1 };
      }
    }
  }

  if (text[index] === '~' && text[index + 1] !== '~' && text[index - 1] !== '~') {
    const start = index + 1;
    const close = findTableInlineClosingMarker(text, start, '~', { singleTilde: true });
    if (close > start) {
      const content = text.slice(start, close);
      if (!isTableInlineWhitespaceOnly(content)) {
        return { kind: 'strike', content, nextIndex: close + 1 };
      }
    }
  }

  return null;
}

function trimTableInlineRawUrl(raw: string, precedingChar: string): string {
  let end = raw.length;
  while (end > 0 && /[.,!?;:]/.test(raw[end - 1])) end -= 1;
  while (end > 0 && raw[end - 1] === ')') {
    const body = raw.slice(0, end);
    const opens = (body.match(/\(/g) ?? []).length;
    const closes = (body.match(/\)/g) ?? []).length;
    if (closes <= opens) break;
    end -= 1;
  }
  let trimmed = raw.slice(0, end);
  while (trimmed.length > 0) {
    const last = trimmed[trimmed.length - 1];
    if (last !== '"' && last !== "'" && last !== '`') {
      break;
    }
    const withoutTrailing = trimmed.slice(0, -1);
    if (normalizeSourceHref(withoutTrailing) === normalizeSourceHref(trimmed)) {
      trimmed = withoutTrailing;
      continue;
    }
    break;
  }
  if (precedingChar === '"' || precedingChar === "'" || precedingChar === '`') {
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === precedingChar) {
      trimmed = trimmed.slice(0, -1);
    }
  }
  return trimmed;
}

function parseTableInlineAutolink(text: string, index: number) {
  const angle = consumeTableInlineAngleSection(text, index);
  if (!angle) return null;
  const inner = angle.content.trim();
  if (!inner || /\s/.test(inner)) return null;
  const looksLikeEmail = /.+@.+\..+/.test(inner);
  if (!isTableInlineUrlLike(inner) && !looksLikeEmail) return null;
  const href = looksLikeEmail && !tableInlineSchemeRe.test(inner)
    ? `mailto:${inner}`
    : tableInlineHrefFromRawUrl(inner);
  return { label: inner, href, nextIndex: angle.nextIndex };
}

function parseTableInlineRawUrl(text: string, index: number) {
  if (isTableInlineEscaped(text, index)) return null;
  if (index > 0 && /[A-Za-z0-9]/.test(text[index - 1])) return null;
  const match = tableInlineRawUrlRe.exec(text.slice(index));
  if (!match) return null;
  const trimmed = trimTableInlineRawUrl(match[0], text[index - 1]);
  if (!trimmed) return null;
  return {
    label: trimmed,
    href: tableInlineHrefFromRawUrl(trimmed),
    nextIndex: index + trimmed.length
  };
}

function parseTableInlineEmojiShortcode(text: string, index: number) {
  if (text[index] !== ':' || isTableInlineEscaped(text, index)) return null;
  const match = tableInlineEmojiShortcodeRe.exec(text.slice(index));
  if (!match) return null;
  const emoji = emojiData[match[1]];
  if (!emoji) return null;
  return {
    emoji,
    nextIndex: index + match[0].length
  };
}

function appendTableInlinePreviewLink(parent: HTMLElement, label: string, href: string, options: {
  baseOffset?: number;
  diagnostics?: TableCellDiagnostics[];
  searchState?: TableSearchState | null;
  sourceRange?: TableCellRange | null;
  presentationFactory: ImagePresentationFactory;
}) {
  const el = document.createElement('span');
  el.className = 'meo-md-link';
  if (href) el.setAttribute('data-meo-link-href', href);
  appendTableInlinePreviewNodes(el, label, { ...options, disableLinkParsers: true });
  if (isMissingLocalLinkTarget(href)) parent.appendChild(createMissingLocalLinkIndicator());
  parent.appendChild(el);
  if (href) parent.appendChild(createOpenLinkButton(href));
}

export function refreshTableLocalLinkIndicators(root: ParentNode): void {
  const links = root.querySelectorAll<HTMLElement>(
    '.meo-md-html-table-cell-preview .meo-md-link[data-meo-link-href]'
  );
  for (const link of links) {
    const indicator = link.previousElementSibling?.classList.contains('meo-md-local-link-missing-icon')
      ? link.previousElementSibling
      : null;
    const href = link.getAttribute('data-meo-link-href') ?? '';
    if (isMissingLocalLinkTarget(href)) {
      if (!indicator) link.before(createMissingLocalLinkIndicator());
    } else {
      indicator?.remove();
    }
  }
}

function appendTableInlinePreviewImage(
  parent: HTMLElement,
  altText: string,
  url: string,
  sourceRange: TableCellRange,
  presentationFactory: ImagePresentationFactory
) {
  if (!url) {
    appendInlineMappedText(parent, `![${altText}]()`, sourceRange);
    return;
  }
  // Table cells own pointer selection so image clicks enter the cell editor on
  // pointerup instead of being consumed by the standalone image interaction.
  const dom = new ImageWidget(url, decodeTableInlineEscapes(altText), '', null, presentationFactory, {
    pointerInteractionOwner: 'parent'
  }).toDOM();
  if (dom instanceof HTMLElement) {
    dom.setAttribute('data-meo-link-href', url);
    setInlineSourceRange(dom, sourceRange, { atomic: true });
  }
  parent.appendChild(dom);
}

function appendTableInlinePreviewNodes(parent: HTMLElement, text: string, options: {
  baseOffset?: number;
  diagnostics?: TableCellDiagnostics[];
  disableLinkParsers?: boolean;
  searchState?: TableSearchState | null;
  sourceRange?: TableCellRange | null;
  presentationFactory: ImagePresentationFactory;
}) {
  const { baseOffset = 0, diagnostics = [], disableLinkParsers = false, searchState = null, sourceRange = null } = options;
  const colorRangesByStart = new Map(collectColorRangesFromText(text).map((range) => [range.from, range]));
  let buffer = '';
  let bufferStart = 0;
  const flushBuffer = () => {
    if (!buffer) return;
    appendTablePlainText(parent, buffer, baseOffset + bufferStart, diagnostics, searchState, sourceRange);
    buffer = '';
  };
  const appendToBuffer = (value: string, index: number) => {
    if (!buffer) {
      bufferStart = index;
    }
    buffer += value;
  };

  for (let i = 0; i < text.length;) {
    if (text[i] === '\\' && i + 1 < text.length && tableInlineEscapableChars.has(text[i + 1])) {
      flushBuffer();
      const mapped = appendInlineMappedText(parent, text[i + 1], {
        from: baseOffset + i,
        to: baseOffset + i + 2
      });
      if (diagnostics.length) {
        const diagnostic = diagnostics.find((candidate) => candidate.from < baseOffset + i + 2 && candidate.to > baseOffset + i);
        if (diagnostic) {
          const severityClass = tableDiagnosticSeverityClasses[diagnostic.severity] ?? tableDiagnosticSeverityClasses[0];
          mapped.classList.add('meo-diagnostic', severityClass);
          mapped.title = tableDiagnosticTitle(diagnostic);
        }
      }
      i += 2;
      continue;
    }

    const code = parseTableInlineCodeSpan(text, i);
    if (code) {
      flushBuffer();
      const el = document.createElement('code');
      el.className = 'meo-md-inline-code';
      setInlineSourceRange(el, { from: baseOffset + i, to: baseOffset + code.nextIndex });
      appendTablePlainText(
        el,
        decodeTableInlineEscapes(code.content),
        baseOffset + i + code.contentFrom,
        diagnostics,
        searchState,
        sourceRange
      );
      parent.appendChild(el);
      i = code.nextIndex;
      continue;
    }

    const kbd = text[i] === '<' && !isTableInlineEscaped(text, i) ? parseKbdTagAt(text, i) : null;
    if (kbd) {
      const keyText = decodeTableInlineEscapes(kbd.content).trim();
      if (!keyText) {
        appendToBuffer(text.slice(i, kbd.nextIndex), i);
      } else {
        flushBuffer();
        const el = document.createElement('kbd');
        el.className = 'meo-md-kbd';
        setInlineSourceRange(el, { from: baseOffset + i, to: baseOffset + kbd.nextIndex });
        appendTablePlainText(
          el,
          keyText,
          baseOffset + i + kbd.contentFrom,
          diagnostics,
          searchState,
          sourceRange
        );
        parent.appendChild(el);
      }
      i = kbd.nextIndex;
      continue;
    }

    const math = parseLatexMathAt(text, i);
    if (math) {
      const mathElement = createLatexMathElement(math.content, math.mode);
      if (mathElement) {
        flushBuffer();
        setInlineSourceRange(
          mathElement,
          { from: baseOffset + math.from, to: baseOffset + math.to },
          { atomic: true }
        );
        parent.appendChild(mathElement);
      } else {
        appendToBuffer(text.slice(math.from, math.to), math.from);
      }
      i = math.to;
      continue;
    }

    const image = parseTableInlineMarkdownLink(text, i, { image: true });
    if (image) {
      flushBuffer();
      appendTableInlinePreviewImage(
        parent,
        image.label,
        decodeTableInlineEscapes(image.url),
        { from: baseOffset + i, to: baseOffset + image.nextIndex },
        options.presentationFactory
      );
      i = image.nextIndex;
      continue;
    }

    if (!disableLinkParsers) {
      const wiki = parseTableInlineWikiLink(text, i);
      if (wiki) {
        flushBuffer();
        appendTableInlinePreviewLink(parent, wiki.visibleText, tableInlineHrefFromWikiTarget(wiki.target), {
          ...options,
          baseOffset: baseOffset + i + wiki.visibleTextFrom
        });
        i = wiki.nextIndex;
        continue;
      }

      const link = parseTableInlineMarkdownLink(text, i);
      if (link) {
        flushBuffer();
        if (link.url) {
          appendTableInlinePreviewLink(parent, link.label, decodeTableInlineEscapes(link.url), {
            ...options,
            baseOffset: baseOffset + i + link.labelFrom
          });
        } else {
          appendTableInlinePreviewNodes(parent, link.label, {
            ...options,
            baseOffset: baseOffset + i + 1
          });
        }
        i = link.nextIndex;
        continue;
      }

      const autolink = parseTableInlineAutolink(text, i);
      if (autolink) {
        flushBuffer();
        appendTableInlinePreviewLink(parent, autolink.label, autolink.href, {
          ...options,
          baseOffset: baseOffset + i + 1
        });
        i = autolink.nextIndex;
        continue;
      }
    }

    const span = parseTableInlineDelimitedSpan(text, i);
    if (span) {
      flushBuffer();
      if (span.kind === 'em') {
        const el = document.createElement('em');
        el.className = 'meo-md-em';
        appendTableInlinePreviewNodes(el, span.content, {
          ...options,
          baseOffset: baseOffset + i + 1
        });
        parent.appendChild(el);
      } else if (span.kind === 'strong') {
        const el = document.createElement('strong');
        el.className = 'meo-md-strong';
        appendTableInlinePreviewNodes(el, span.content, {
          ...options,
          baseOffset: baseOffset + i + 2
        });
        parent.appendChild(el);
      } else if (span.kind === 'strike') {
        const el = document.createElement('span');
        el.className = 'meo-md-strike';
        appendTableInlinePreviewNodes(el, span.content, {
          ...options,
          baseOffset: baseOffset + i + (text.startsWith('~~', i) ? 2 : 1)
        });
        parent.appendChild(el);
      } else if (span.kind === 'highlight') {
        const el = document.createElement('mark');
        el.className = 'meo-md-highlight';
        appendTableInlinePreviewNodes(el, span.content, {
          ...options,
          baseOffset: baseOffset + i + 2
        });
        parent.appendChild(el);
      }
      i = span.nextIndex;
      continue;
    }

    const tagMatch = disableLinkParsers ? null : tableInlineTagRe.exec(text.slice(i));
    const tag = tagMatch && (i === 0 || !tableInlineTagPrefixRe.test(text[i - 1])) ? tagMatch : null;
    const color = colorRangesByStart.get(i);
    if (color && (!tag || tag[0].length === color.value.length)) {
      flushBuffer();
      parent.appendChild(createColorSwatchElement(color.value));
      appendTablePlainText(parent, color.value, baseOffset + i, diagnostics, searchState, sourceRange);
      i = color.to;
      continue;
    }

    if (!disableLinkParsers) {
      if (tag) {
        flushBuffer();
        const el = document.createElement('span');
        el.className = 'meo-md-tag';
        appendTablePlainText(el, tag[0], baseOffset + i, diagnostics, searchState, sourceRange);
        parent.appendChild(el);
        i += tag[0].length;
        continue;
      }

      const rawUrl = parseTableInlineRawUrl(text, i);
      if (rawUrl) {
        flushBuffer();
        appendTableInlinePreviewLink(parent, rawUrl.label, rawUrl.href, {
          ...options,
          baseOffset: baseOffset + i
        });
        i = rawUrl.nextIndex;
        continue;
      }
    }

    const emoji = parseTableInlineEmojiShortcode(text, i);
    if (emoji) {
      flushBuffer();
      const el = document.createElement('span');
      el.className = 'meo-md-emoji';
      el.textContent = emoji.emoji;
      setInlineSourceRange(
        el,
        { from: baseOffset + i, to: baseOffset + emoji.nextIndex },
        { atomic: true }
      );
      parent.appendChild(el);
      i = emoji.nextIndex;
      continue;
    }

    appendToBuffer(text[i], i);
    i += 1;
  }

  flushBuffer();
}

function tableCellIndentColumns(text: string): number {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? '';
  return [...indent].reduce((columns, char) => columns + (char === '\t' ? 2 : 1), 0);
}

function parseTableCellListItem(line: TableCellLogicalLine) {
  const match = tableCellListItemRe.exec(line.text);
  if (!match?.groups) return null;
  const indentColumns = tableCellIndentColumns(match[1]);
  const content = match.groups.content ?? '';
  return {
    indentColumns,
    type: match.groups.bullet ? 'ul' : 'ol',
    start: match.groups.number ? Number.parseInt(match.groups.number, 10) : 1,
    content,
    contentFrom: line.from + line.text.length - content.length
  } as const;
}

function appendTableCellSourcePreview(
  previewEl: HTMLElement,
  text: string,
  diagnostics: TableCellDiagnostics[],
  searchState: TableSearchState | null,
  sourceRange: TableCellRange | null
) {
  for (const line of splitTableCellLogicalLines(text)) {
    const sourceLine = line.text + line.breakText;
    appendTablePlainText(previewEl, sourceLine, line.from, diagnostics, searchState, sourceRange);
    if (line.breakText) previewEl.appendChild(document.createElement('br'));
  }
}

function appendTableCellRenderedPreview(
  previewEl: HTMLElement,
  text: string,
  diagnostics: TableCellDiagnostics[],
  searchState: TableSearchState | null,
  sourceRange: TableCellRange | null,
  presentationFactory: ImagePresentationFactory
) {
  const listStack: Array<{ indentColumns: number; type: 'ul' | 'ol'; list: HTMLUListElement | HTMLOListElement; lastItem: HTMLLIElement | null }> = [];
  const appendInline = (parent: HTMLElement, content: string, baseOffset: number) => {
    appendTableInlinePreviewNodes(parent, content, {
      baseOffset,
      diagnostics,
      searchState,
      sourceRange,
      presentationFactory
    });
  };

  for (const line of splitTableCellLogicalLines(text)) {
    const item = parseTableCellListItem(line);
    if (!item) {
      const indentColumns = tableCellIndentColumns(line.text);
      let parent: HTMLElement = previewEl;
      if (line.text.trim() && indentColumns > 0) {
        for (let index = listStack.length - 1; index >= 0; index -= 1) {
          const entry = listStack[index];
          if (entry.lastItem && indentColumns > entry.indentColumns) {
            listStack.length = index + 1;
            parent = entry.lastItem;
            break;
          }
        }
      }
      if (parent === previewEl) listStack.length = 0;
      const lineEl = document.createElement('div');
      lineEl.className = 'meo-md-html-table-cell-line';
      appendInline(lineEl, line.text, line.from);
      if (!line.text) lineEl.appendChild(document.createElement('br'));
      parent.appendChild(lineEl);
      continue;
    }

    while (listStack.length > 0 && listStack[listStack.length - 1].indentColumns > item.indentColumns) {
      listStack.pop();
    }
    let level = listStack.findIndex((entry) => entry.indentColumns === item.indentColumns);
    if (level >= 0) {
      listStack.length = level + 1;
    } else {
      while (listStack.length > 0 && listStack[listStack.length - 1].indentColumns >= item.indentColumns) {
        listStack.pop();
      }
      level = listStack.length;
    }

    let entry = listStack[level];
    if (!entry || entry.indentColumns !== item.indentColumns || entry.type !== item.type) {
      listStack.length = level;
      const parent = level > 0 ? listStack[level - 1]?.lastItem : previewEl;
      if (!(parent instanceof HTMLElement)) {
        level = 0;
        listStack.length = 0;
      }
      const list = item.type === 'ol' ? document.createElement('ol') : document.createElement('ul');
      list.className = 'meo-md-html-table-cell-list';
      if (list instanceof HTMLOListElement && item.start !== 1) list.start = item.start;
      if (level === 0 && item.indentColumns > 0) {
        list.style.marginInlineStart = `${item.indentColumns}ch`;
      } else if (level > 0) {
        const parentIndent = listStack[level - 1].indentColumns;
        list.style.paddingInlineStart = `${Math.max(2, item.indentColumns - parentIndent)}ch`;
      }
      (level > 0 ? listStack[level - 1].lastItem! : previewEl).appendChild(list);
      entry = { indentColumns: item.indentColumns, type: item.type, list, lastItem: null };
      listStack[level] = entry;
    }

    const listItem = document.createElement('li');
    appendInline(listItem, item.content, item.contentFrom);
    entry.list.appendChild(listItem);
    entry.lastItem = listItem;
    listStack.length = level + 1;
  }
}

function renderTableCellInlinePreview(
  previewEl: HTMLElement,
  value: string,
  diagnostics: TableCellDiagnostics[] = [],
  searchState: TableSearchState | null = null,
  sourceRange: TableCellRange | null,
  presentationFactory: ImagePresentationFactory
) {
  if (!(previewEl instanceof HTMLElement)) return;
  disposeImagePresentations(previewEl);
  previewEl.replaceChildren();
  const text = value ?? '';
  const isSearchExpanded = shouldExpandTableCellForSearch(text, searchState);
  previewEl.classList.toggle('is-search-expanded', isSearchExpanded);
  previewEl.parentElement?.classList.toggle('has-search-match', isSearchExpanded);
  if (isSearchExpanded) {
    appendTableCellSourcePreview(previewEl, text, diagnostics, searchState, sourceRange);
    return;
  }
  appendTableCellRenderedPreview(
    previewEl,
    text,
    diagnostics,
    searchState,
    sourceRange,
    presentationFactory
  );
}

function consumeTableInlineProtectedSpan(text: string, index: number, endIndex: number): number | null {
  const code = parseTableInlineCodeSpan(text, index);
  if (code && code.nextIndex <= endIndex) return code.nextIndex;

  const kbd = text[index] === '<' && !isTableInlineEscaped(text, index) ? parseKbdTagAt(text, index) : null;
  if (kbd && kbd.nextIndex <= endIndex) return kbd.nextIndex;

  const wiki = parseTableInlineWikiLink(text, index);
  if (wiki && wiki.nextIndex <= endIndex) return wiki.nextIndex;

  const image = parseTableInlineMarkdownLink(text, index, { image: true });
  if (image && image.nextIndex <= endIndex) return image.nextIndex;

  const link = parseTableInlineMarkdownLink(text, index);
  if (link && link.nextIndex <= endIndex) return link.nextIndex;

  const angle = consumeTableInlineAngleSection(text, index);
  if (angle && angle.nextIndex <= endIndex) return angle.nextIndex;

  if (text[index] === '\\' && index + 1 < endIndex) return index + 2;
  return null;
}

function findTableRowSeparatorPipes(text: string, startIndex: number, endIndex: number): number[] {
  const pipes: number[] = [];
  for (let i = startIndex; i < endIndex;) {
    const protectedNext = consumeTableInlineProtectedSpan(text, i, endIndex);
    if (protectedNext && protectedNext > i) {
      i = protectedNext;
      continue;
    }
    if (text[i] === '|' && !isTableInlineEscaped(text, i)) {
      pipes.push(i);
    }
    i += 1;
  }
  return pipes;
}

function parseTableRowCells(lineText: string, lineFrom = 0): ParsedTableRowCells {
  const leadingWhitespaceLen = /^(\s*)/.exec(lineText)?.[1].length ?? 0;
  let contentStart = leadingWhitespaceLen;
  let contentEnd = lineText.length;
  while (contentStart < contentEnd && /\s/.test(lineText[contentStart])) contentStart += 1;
  while (contentEnd > contentStart && /\s/.test(lineText[contentEnd - 1])) contentEnd -= 1;

  let innerStart = contentStart;
  let innerEnd = contentEnd;
  if (innerStart < innerEnd && lineText[innerStart] === '|') innerStart += 1;
  if (innerEnd > innerStart && lineText[innerEnd - 1] === '|') innerEnd -= 1;

  const allSeparatorPipes = findTableRowSeparatorPipes(lineText, 0, lineText.length);
  const innerPipes = allSeparatorPipes.filter((index) => index >= innerStart && index < innerEnd);

  const cells: string[] = [];
  if (innerStart < innerEnd || innerPipes.length > 0) {
    let cursor = innerStart;
    for (const pipeIndex of innerPipes) {
      cells.push(lineText.slice(cursor, pipeIndex).trim());
      cursor = pipeIndex + 1;
    }
    cells.push(lineText.slice(cursor, innerEnd).trim());
  }

  const segments: ParsedTableCellSegment[] = [];
  let segmentStart = innerStart;
  for (let i = 0; i <= innerPipes.length; i += 1) {
    const rawFrom = segmentStart;
    const rawTo = i < innerPipes.length ? innerPipes[i] : innerEnd;
    let from = rawFrom;
    let to = rawTo;
    while (from < to && /\s/.test(lineText[from])) from += 1;
    while (to > from && /\s/.test(lineText[to - 1])) to -= 1;
    if (to <= from) {
      segments.push({ from: lineFrom + rawFrom, to: lineFrom + rawTo, cellIndex: i, empty: true });
    } else {
      segments.push({ from: lineFrom + from, to: lineFrom + to, cellIndex: i, empty: false });
    }
    segmentStart = rawTo + 1;
  }

  const hasExplicitSingleCell = cells.length === 1 && cells[0] === '' && allSeparatorPipes.length >= 2;

  return {
    cells: cells.length === 1 && cells[0] === '' && !hasExplicitSingleCell ? [] : cells,
    pipes: allSeparatorPipes,
    segments
  };
}

function normalizeRow<T>(cells: readonly T[], colCount: number, fill: T): T[] {
  const result = cells.slice(0, colCount);
  while (result.length < colCount) result.push(fill);
  return result;
}

function isValidTableRange(from: number | undefined, to: number | undefined, docLength: number): boolean {
  return (
    typeof from === 'number' &&
    typeof to === 'number' &&
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 0 &&
    from < to &&
    to <= docLength
  );
}

function parseDelimiterAlignments(lineText: string): TableAlignment[] {
  const alignments: TableAlignment[] = [];
  const parts = lineText.split('|').filter((part) => part.trim());
  for (const part of parts) {
    const value = part.trim();
    const left = value.startsWith(':');
    const right = value.endsWith(':');
    alignments.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return alignments;
}

function delimiterCellForAlignment(alignment: string | null | undefined): string {
  if (alignment === 'left') return ':---';
  if (alignment === 'right') return '---:';
  if (alignment === 'center') return ':---:';
  return '---';
}

function serializeTableMarkdown(indent: string, headerCells: string[], alignments: TableAlignment[], rows: string[][]): string {
  const colCount = headerCells.length;
  const normalizedAlignments = normalizeRow(alignments, colCount, '').map((value) => value ?? null);
  const normalizedRows = rows.map((row) => normalizeRow(row, colCount, ''));
  const header = `| ${headerCells.join(' | ')} |`;
  const delimiter = `| ${normalizedAlignments.map(delimiterCellForAlignment).join(' | ')} |`;
  const dataRows = normalizedRows.map((row) => `| ${row.join(' | ')} |`);
  return [header, delimiter, ...dataRows].map((line) => `${indent}${line}`).join('\n');
}

function parseTableLine(lineNo: number, from: number, to: number, text: string): ParsedTableLine {
  const { cells, pipes, segments } = parseTableRowCells(text, from);
  return { lineNo, from, to, text, cells, pipes, segments };
}

function isTableContentLine(lineText: string): boolean {
  return lineText.includes('|');
}

function buildTableData(state: EditorState, tableNode: Pick<SyntaxNodeRef, 'from' | 'to'>): BuiltTableData {
  const startLine = state.doc.lineAt(tableNode.from);
  const endLine = state.doc.lineAt(Math.max(tableNode.to - 1, tableNode.from));
  return buildTableDataForLineRange(state, startLine.number, endLine.number);
}

function buildTableDataForLineRange(state: EditorState, startLineNo: number, endLineNo: number): BuiltTableData {
  const startLine = state.doc.line(startLineNo);
  const endLine = state.doc.line(endLineNo);
  const lines: ParsedTableLine[] = [];
  let delimiterIdx = -1;

  for (let lineNo = startLine.number; lineNo <= endLine.number; lineNo++) {
    const line = state.doc.line(lineNo);
    const text = state.doc.sliceString(line.from, line.to);
    if (delimiterIdx === -1 && isTableDelimiterLine(text)) {
      delimiterIdx = lines.length;
    }
    lines.push(parseTableLine(lineNo, line.from, line.to, text));
  }

  const headerLine = delimiterIdx > 0 ? lines[delimiterIdx - 1] : null;
  let lastTableLineIdx = delimiterIdx;
  if (delimiterIdx >= 0) {
    for (let idx = delimiterIdx + 1; idx < lines.length; idx += 1) {
      if (!isTableContentLine(lines[idx].text)) {
        break;
      }
      lastTableLineIdx = idx;
    }
  }

  const dataLines = delimiterIdx >= 0 ? lines.slice(delimiterIdx + 1, lastTableLineIdx + 1) : [];
  const alignments = delimiterIdx >= 0 ? parseDelimiterAlignments(lines[delimiterIdx].text) : [];
  const colCount = Math.max(
    headerLine?.cells.length ?? 0,
    alignments.length,
    ...dataLines.map((line) => line.cells.length)
  );
  const tableFrom = headerLine ? headerLine.from : startLine.from;
  const tableTo = delimiterIdx >= 0 && lines[lastTableLineIdx] ? lines[lastTableLineIdx].to : endLine.to;
  const effectiveStartLine = headerLine ? headerLine.lineNo : startLine.number;
  const effectiveEndLine = delimiterIdx >= 0 && lines[lastTableLineIdx] ? lines[lastTableLineIdx].lineNo : endLine.number;

  return {
    from: tableFrom,
    to: tableTo,
    lines,
    delimiterIdx,
    headerLine,
    dataLines,
    alignments,
    colCount,
    startLine: effectiveStartLine,
    endLine: effectiveEndLine
  };
}

class HtmlTableWidget extends WidgetType {
  tableData: WidgetTableData;
  view: EditorView | null;
  layoutFrame: number;
  pendingResizeRows: boolean;
  domRefs: DomRefs | null;
  cleanupFns: (() => void)[];
  selectionAnchor: CellCoords | null;
  selectionRange: SelectionRange | null;
  selectionPointerId: number | null;
  isDraggingSelection: boolean;
  hasPendingCellEdits: boolean;
  pendingCellEdits: PendingCellEdit[];
  pendingCellSwitchCommit: boolean;
  activeTarget: TableActionTarget;
  searchState: TableSearchState | null;
  stickyHeaderAdapterFactory: TableStickyHeaderAdapterFactory;
  stickyHeaderAdapter: TableStickyHeaderAdapter;
  layoutTasks: Set<() => void>;
  layoutScheduler: TableWidgetLayoutScheduler;
  tableCommandEnvironment: TableCommandEnvironment;
  tableCommandTargetId: string;
  tableCommandTargetRegistration: TableCommandTargetRegistration | null;

  constructor(
    tableData: WidgetTableData,
    stickyHeaderAdapterFactory: TableStickyHeaderAdapterFactory,
    tableCommandEnvironment: TableCommandEnvironment
  ) {
    super();
    this.tableData = tableData;
    this.view = null;
    this.layoutFrame = 0;
    this.pendingResizeRows = false;
    this.domRefs = null;
    this.cleanupFns = [];
    this.selectionAnchor = null;
    this.selectionRange = null;
    this.selectionPointerId = null;
    this.isDraggingSelection = false;
    this.hasPendingCellEdits = false;
    this.pendingCellEdits = [];
    this.pendingCellSwitchCommit = false;
    this.activeTarget = { row: this.tableData.rows.length > 0 ? 1 : 0, col: 0 };
    this.searchState = null;
    this.tableCommandEnvironment = tableCommandEnvironment;
    this.tableCommandTargetId = '';
    this.tableCommandTargetRegistration = null;
    this.stickyHeaderAdapterFactory = stickyHeaderAdapterFactory;
    this.layoutTasks = new Set();
    this.layoutScheduler = {
      register: (task) => {
        let active = true;
        this.layoutTasks.add(task);
        return {
          request: () => {
            if (active) this.scheduleLayout();
          },
          dispose: () => {
            if (!active) return;
            active = false;
            this.layoutTasks.delete(task);
          }
        };
      }
    };
    this.stickyHeaderAdapter = stickyHeaderAdapterFactory.create({
      scheduler: this.layoutScheduler,
      resolveElements: () => this.resolveStickyHeaderElements(),
      controlsHeight: () => this.stickyControlsHeight(),
      renderHeaderCell: (column) => this.renderStickyHeaderCell(column)
    });
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof HtmlTableWidget &&
      other.tableData.signature === this.tableData.signature &&
      other.tableData.indent === this.tableData.indent &&
      other.tableData.from === this.tableData.from &&
      other.tableData.to === this.tableData.to &&
      other.tableData.startLine === this.tableData.startLine &&
      other.tableData.endLine === this.tableData.endLine
      && other.stickyHeaderAdapterFactory === this.stickyHeaderAdapterFactory
    );
  }

  resolveStickyHeaderElements(): TableStickyHeaderElements | null {
    if (!this.domRefs || !this.view) return null;
    const {
      table,
      stickyChrome,
      stickyHeaderViewport,
      stickyTable,
      stickyHeaderRow
    } = this.domRefs;
    return {
      scroller: this.view.scrollDOM,
      table,
      stickyChrome,
      stickyHeaderViewport,
      stickyTable,
      stickyHeaderRow
    };
  }

  stickyControlsHeight(): number {
    const shell = this.domRefs?.shell;
    if (!shell || !shell.classList.contains('is-controls-sticky')) return 0;
    const visible = shell.matches(':focus-within') || shell.classList.contains('is-interacting');
    return visible ? tableToolbarHeight : 0;
  }

  renderStickyHeaderCell(column: number): HTMLTableCellElement {
    const cell = document.createElement('th');
    const sourceCell = this.domRefs?.table.tHead?.rows[0]?.cells[column];
    const headerInput = this.domRefs?.headerInputs[column];
    cell.style.textAlign = sourceCell?.style.textAlign ?? '';
    const preview = document.createElement('div');
    preview.className = 'meo-md-html-table-cell-preview';
    renderTableCellInlinePreview(
      preview,
      tableCellEditorValueToSource(headerInput?.value ?? ''),
      this.cellDiagnostics(0, column),
      this.searchState,
      this.cellSourceRange(0, column),
      getImagePresentationFactory(this.view!.state)
    );
    cell.append(preview, this.createColumnResizeHandle(column));
    return cell;
  }

  getEditorView(dom?: HTMLElement): EditorView | null {
    if (this.view) return this.view;
    if (!dom) return null;
    return EditorView.findFromDOM(dom);
  }

  resolveCurrentTableRange(view: EditorView, dom: HTMLElement): TableRange | null {
    let pos = 0;
    try {
      pos = view.posAtDOM(dom, 0);
    } catch {
      pos = -1;
    }

    if (pos >= 0) {
      let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
      while (node) {
        if (node.name === 'Table') {
          if (this.tableData) {
            this.tableData.from = node.from;
            this.tableData.to = node.to;
          }
          return { from: node.from, to: node.to };
        }
        node = node.parent;
      }
    }

    const tableFrom = this.tableData?.from;
    const tableTo = this.tableData?.to;
    if (isValidTableRange(tableFrom, tableTo, view.state.doc.length)) {
      return { from: tableFrom, to: tableTo };
    }

    return null;
  }

  readCellMatrix(): CellMatrix {
    if (!this.domRefs) return { headerCells: [], rows: [], alignments: [] };
    const { headerInputs, rowInputs } = this.domRefs;
    const headerCells = normalizeRow(
      headerInputs.map((input) => tableCellEditorValueToSource(input.value).trim()),
      this.tableData.colCount,
      ''
    );

    const rows = rowInputs.map((inputs) => normalizeRow(
      inputs.map((input) => tableCellEditorValueToSource(input.value).trim()),
      this.tableData.colCount,
      ''
    ));

    return { headerCells, rows, alignments: this.tableData.alignments };
  }

  updateBodyRowDatasets(rowInputs: HTMLTextAreaElement[][], cellGrid: HTMLTableCellElement[][]) {
    for (let row = 0; row < rowInputs.length; row += 1) {
      const tableRow = row + 1;
      for (let col = 0; col < rowInputs[row].length; col += 1) {
        rowInputs[row][col].dataset.tableRow = String(tableRow);
        rowInputs[row][col].dataset.tableCol = String(col);
      }
      for (let col = 0; col < cellGrid[row].length; col += 1) {
        cellGrid[row][col].dataset.tableRow = String(tableRow);
        cellGrid[row][col].dataset.tableCol = String(col);
      }
    }
  }

  activeBodyRowIndex(): number | null {
    return this.bodyRowIndexFor(this.activeTarget.row);
  }

  bodyRowIndexFor(row: number | null) {
    if (this.tableData.rows.length === 0) return null;
    if (row === null || row <= 0) return null;
    const bodyIndex = row - 1;
    return bodyIndex >= 0 && bodyIndex < this.tableData.rows.length ? bodyIndex : null;
  }

  activeColumnIndex(): number | null {
    return this.columnIndexFor(this.activeTarget.col);
  }

  columnIndexFor(column: number | null) {
    const colCount = this.tableData.colCount;
    if (colCount <= 0 || column === null) return null;
    return Math.min(Math.max(column, 0), colCount - 1);
  }

  updateToolbarState() {
    if (!this.domRefs) return;
    const { toolbarButtons } = this.domRefs;
    const activeBodyRow = this.activeBodyRowIndex();
    const activeColumn = this.activeColumnIndex();
    const hasRowTarget = activeBodyRow !== null;
    const hasColumnTarget = activeColumn !== null;

    toolbarButtons.insertRowAbove.disabled = this.tableData.colCount === 0;
    toolbarButtons.insertRowBelow.disabled = this.tableData.colCount === 0;
    toolbarButtons.deleteRow.disabled = !hasRowTarget || this.tableData.rows.length <= 1;
    toolbarButtons.insertColumnLeft.disabled = !hasColumnTarget;
    toolbarButtons.insertColumnRight.disabled = !hasColumnTarget;
    toolbarButtons.deleteColumn.disabled = !hasColumnTarget || this.tableData.colCount <= 1;
    toolbarButtons.alignColumnLeft.disabled = !hasColumnTarget;
    toolbarButtons.alignColumnCenter.disabled = !hasColumnTarget;
    toolbarButtons.alignColumnRight.disabled = !hasColumnTarget;
  }

  updateActionTargetStyles() {
    this.updateToolbarState();
  }

  setActionTarget(target: TableActionTarget) {
    const row = Math.min(Math.max(target.row ?? 0, 0), this.tableData.rows.length);
    const col = Math.min(Math.max(target.col ?? 0, 0), Math.max(0, this.tableData.colCount - 1));
    this.activeTarget = { row, col };
    this.updateActionTargetStyles();
    this.syncTableLineNumbers();
  }

  requestTableCommand(command: TableCommand, enabled = true) {
    void this.tableCommandEnvironment.dispatch({
      type: 'request',
      command,
      target: {
        tableId: this.tableCommandTargetId,
        row: this.activeTarget.row,
        column: this.activeTarget.col,
        selection: this.selectionRange ? {
          fromRow: this.selectionRange.fromRow,
          toRow: this.selectionRange.toRow,
          fromColumn: this.selectionRange.fromCol,
          toColumn: this.selectionRange.toCol
        } : null
      },
      enabled
    });
  }

  requestInsertRowAbove(container: HTMLElement) {
    void container;
    this.requestTableCommand('insert-row-above', this.tableData.colCount > 0);
  }

  requestInsertRowBelow(container: HTMLElement) {
    void container;
    this.requestTableCommand('insert-row-below', this.tableData.colCount > 0);
  }

  requestDeleteRow(container: HTMLElement) {
    void container;
    this.requestTableCommand('delete-row', this.activeBodyRowIndex() !== null && this.tableData.rows.length > 1);
  }

  requestInsertColumnLeft(container: HTMLElement) {
    void container;
    this.requestTableCommand('insert-column-left', this.activeColumnIndex() !== null);
  }

  requestInsertColumnRight(container: HTMLElement) {
    void container;
    this.requestTableCommand('insert-column-right', this.activeColumnIndex() !== null);
  }

  requestDeleteColumn(container: HTMLElement) {
    void container;
    this.requestTableCommand('delete-column', this.activeColumnIndex() !== null && this.tableData.colCount > 1);
  }

  requestColumnAlignment(container: HTMLElement, alignment: Exclude<TableAlignment, null>) {
    void container;
    const command = alignment === 'center' ? 'align-center' : alignment === 'right' ? 'align-right' : 'align-left';
    this.requestTableCommand(command, this.activeColumnIndex() !== null);
  }

  headerAlignmentOverrideColumns(view: EditorView): ReadonlySet<number> | null {
    const from = this.tableData.from;
    const to = this.tableData.to;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    const overrides = view.state.field(tableHeaderAlignmentOverrideField, false);
    const matches: ReadonlySet<number>[] = [];
    overrides?.between(from, to, (rangeFrom, rangeTo, value) => {
      if (rangeFrom === from && rangeTo === to) matches.push(value.columns);
    });
    return matches[0] ?? null;
  }

  parseCellCoords(rowText: string | undefined, colText: string | undefined): CellCoords | null {
    const row = Number.parseInt(rowText ?? '', 10);
    const col = Number.parseInt(colText ?? '', 10);
    if (Number.isNaN(row) || Number.isNaN(col)) return null;
    return { row, col };
  }

  findCellElement(node: EventTarget | null): HTMLTableCellElement | null {
    if (!this.domRefs || !(node instanceof Element)) return null;
    const cell = node.closest(tableCellSelector);
    if (!cell || !this.domRefs.table.contains(cell)) return null;
    return cell instanceof HTMLTableCellElement ? cell : null;
  }

  coordsFromCell(cell: HTMLTableCellElement): CellCoords | null {
    return this.parseCellCoords(cell.dataset.tableRow, cell.dataset.tableCol);
  }

  focusTableInput(input: HTMLTextAreaElement, caret: number | null = null, { scrollCellIntoView = true }: { scrollCellIntoView?: boolean } = {}) {
    if (!(input instanceof HTMLTextAreaElement)) return false;
    this.setCellEditingState(input, true);
    input.focus({ preventScroll: true });
    const nextCaret = Math.min(Math.max(caret ?? input.value.length, 0), input.value.length);
    input.setSelectionRange(nextCaret, nextCaret);
    if (scrollCellIntoView) {
      input.closest(tableCellSelector)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
    const container = input.closest('.meo-md-html-table-wrap');
    if (container instanceof HTMLElement) {
      this.emitTableSelectionChange(container);
    }
    return true;
  }

  focusCellInput(cell: HTMLTableCellElement, { updateSelection = false, caret = null }: { updateSelection?: boolean; caret?: number | null } = {}) {
    const input = cell.querySelector<HTMLTextAreaElement>('textarea');
    if (!input) return false;
    if (!this.focusTableInput(input, caret)) return false;
    if (!updateSelection) return true;
    const coords = this.coordsFromCell(cell);
    if (coords) {
      this.setSingleCellSelection(coords);
    }
    return true;
  }

  pointerCaretForCell(cell: HTMLTableCellElement, clientX: number, clientY: number, { nearestFallback = true }: { nearestFallback?: boolean } = {}): TablePointerCaret {
    const input = cell.querySelector('textarea');
    const preview = cell.querySelector('.meo-md-html-table-cell-preview');
    if (!(input instanceof HTMLTextAreaElement) || !(preview instanceof HTMLElement)) {
      return { domCaret: null, editorOffset: null };
    }

    const previousInputPointerEvents = input.style.pointerEvents;
    const previousPreviewVisibility = preview.style.visibility;
    let resolution: InlineCaretResolution = { domCaret: null, sourceOffset: null };
    try {
      input.style.pointerEvents = 'none';
      preview.style.visibility = 'visible';
      resolution = resolveInlineCaretAtPoint(preview, clientX, clientY, { nearestFallback });
    } finally {
      input.style.pointerEvents = previousInputPointerEvents;
      preview.style.visibility = previousPreviewVisibility;
    }
    return {
      domCaret: resolution.domCaret,
      editorOffset: resolution.sourceOffset === null
        ? null
        : tableCellSourceOffsetToEditorOffset(input.value, resolution.sourceOffset)
    };
  }

  focusCellInputAt(row: number, col: number, caret: number | null = null) {
    const input = this.domRefs?.allRowInputs?.[row]?.[col];
    return input ? this.focusTableInput(input, caret) : false;
  }

  moveVerticalOutOfTable(container: HTMLElement, direction: 'up' | 'down', preferredColumn = 0) {
    const view = this.getEditorView(container);
    if (!view) return false;

    const range = this.resolveCurrentTableRange(view, container);
    if (!range) return false;

    const firstLine = view.state.doc.lineAt(range.from);
    const lastLine = view.state.doc.lineAt(Math.max(range.to - 1, range.from));
    const lineStep = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    if (!lineStep) return false;
    const anchorLineNo = lineStep < 0 ? firstLine.number : lastLine.number;
    const targetLineNo = anchorLineNo + lineStep;
    if (targetLineNo < 1 || targetLineNo > view.state.doc.lines) return false;

    const targetLine = view.state.doc.line(targetLineNo);
    const targetPos = Math.min(targetLine.from + Math.max(preferredColumn, 0), targetLine.to);

    commitPendingTableEdits(view);
    this.exitTableInteraction(container);
    view.dispatch({
      selection: { anchor: targetPos },
      effects: EditorView.scrollIntoView(targetPos, { y: 'nearest' })
    });
    view.focus();
    return true;
  }

  normalizeSelectionRange(a: CellCoords, b: CellCoords): SelectionRange {
    return {
      fromRow: Math.min(a.row, b.row),
      toRow: Math.max(a.row, b.row),
      fromCol: Math.min(a.col, b.col),
      toCol: Math.max(a.col, b.col)
    };
  }

  isCellSelected(row: number, col: number, range: SelectionRange | null): boolean {
    if (!range) return false;
    return row >= range.fromRow && row <= range.toRow && col >= range.fromCol && col <= range.toCol;
  }

  applySelection(range: SelectionRange | null) {
    if (!this.domRefs) return;
    this.selectionRange = range;
    const showSelectionStyle = Boolean(
      range && (range.fromRow !== range.toRow || range.fromCol !== range.toCol)
    );
    const { cellGrid } = this.domRefs;
    for (let row = 0; row < cellGrid.length; row++) {
      const cells = cellGrid[row];
      for (let col = 0; col < cells.length; col++) {
        const cell = cells[col];
        const selected = this.isCellSelected(row, col, range);
        const styledSelected = selected && showSelectionStyle;
        const isTopEdge = styledSelected && range !== null && row === range.fromRow;
        const isRightEdge = styledSelected && range !== null && col === range.toCol;
        const isBottomEdge = styledSelected && range !== null && row === range.toRow;
        const isLeftEdge = styledSelected && range !== null && col === range.fromCol;
        cell.classList.toggle('meo-md-html-table-cell-selected', styledSelected);
        cell.classList.toggle('meo-md-html-table-cell-selected-top', isTopEdge);
        cell.classList.toggle('meo-md-html-table-cell-selected-right', isRightEdge);
        cell.classList.toggle('meo-md-html-table-cell-selected-bottom', isBottomEdge);
        cell.classList.toggle('meo-md-html-table-cell-selected-left', isLeftEdge);
      }
    }
  }

  setSingleCellSelection(coords: CellCoords) {
    this.selectionAnchor = coords;
    this.setActionTarget(coords);
    this.applySelection(this.normalizeSelectionRange(coords, coords));
  }

  clearSelection() {
    this.selectionAnchor = null;
    this.applySelection(null);
    this.syncTableLineNumbers();
  }

  exitTableInteraction(container: HTMLElement) {
    this.setTableInteractionActive(container, false);
    this.clearSelection();
  }

  transferTableInteraction(container: HTMLElement) {
    const shell = container?.closest?.('.meo-md-html-table-shell');
    if (shell instanceof HTMLElement) {
      shell.classList.remove('is-interacting');
    }
    this.updateStickyControls();
    this.stickyHeaderAdapter.invalidate();
    this.clearSelection();
  }

  setTableInteractionActive(container: HTMLElement, active: boolean) {
    const shell = container?.closest?.('.meo-md-html-table-shell');
    if (shell instanceof HTMLElement) {
      shell.classList.toggle('is-interacting', active);
    }
    this.updateStickyControls();
    this.stickyHeaderAdapter.invalidate();
    const view = this.getEditorView(container);
    if (!view) return;
    view.dom.dispatchEvent(new CustomEvent('meo-table-interaction', { detail: { active, owner: shell } }));
  }

  emitTableSelectionChange(container: HTMLElement) {
    const view = this.getEditorView(container);
    if (!view) return;
    view.dom.dispatchEvent(new CustomEvent('meo-table-selection-change'));
  }

  hasFocusedTableInput(container: HTMLElement): boolean {
    const view = this.getEditorView(container);
    if (!view) return false;
    const active = document.activeElement;
    if (!(active instanceof Element)) return false;
    if (!view.dom.contains(active)) return false;
    return active.closest('.meo-md-html-table-wrap') !== null;
  }

  selectedCellCount() {
    if (!this.selectionRange) return 0;
    const rowCount = this.selectionRange.toRow - this.selectionRange.fromRow + 1;
    const colCount = this.selectionRange.toCol - this.selectionRange.fromCol + 1;
    return rowCount * colCount;
  }

  selectedTextAsTsv() {
    if (!this.selectionRange || !this.domRefs) return '';
    const lines = [];
    for (let row = this.selectionRange.fromRow; row <= this.selectionRange.toRow; row++) {
      const values = [];
      for (let col = this.selectionRange.fromCol; col <= this.selectionRange.toCol; col++) {
        values.push(tableCellEditorValueToSource(this.domRefs.allRowInputs[row][col].value).trim());
      }
      lines.push(values.join('\t'));
    }
    return lines.join('\n');
  }

  handleHistoryShortcut(event: KeyboardEvent, table: HTMLTableElement) {
    if (!isPrimaryModifier(event) || (!isUndoShortcut(event) && !isRedoShortcut(event))) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    const wrap = this.domRefs?.wrap ?? table;
    const view = this.getEditorView(wrap);
    if (!view) return true;
    runEditorHistoryCommand(view, isUndoShortcut(event) ? 'undo' : 'redo');
    return true;
  }

  wireTableSelection(table: HTMLTableElement) {
    const getWrap = () => this.domRefs?.wrap ?? table;
    const getContainer = () => this.domRefs?.container ?? getWrap();
    let pendingOutsidePointerId: number | null = null;
    let pendingTableSwitchPointerId: number | null = null;
    let outsidePointerExitTimer: number | null = null;
    let textSelectionInput: HTMLTextAreaElement | null = null;
    let textSelectionAnchorCaret: number | null = null;
    let textSelectionCurrentCaret: number | null = null;
    let textSelectionCell: CellCoords | null = null;
    let textSelectionCrossedCell = false;
    let textSelectionDomAnchor: { node: Node; offset: number } | null = null;

    const markTextSelectionCrossedCell = () => {
      if (!textSelectionCell) return;
      textSelectionCrossedCell = true;
      textSelectionDomAnchor = null;
      document.getSelection()?.removeAllRanges();
    };

    const hasActiveTableInteraction = () => {
      const active = document.activeElement;
      const shell = getContainer().closest('.meo-md-html-table-shell');
      return (
        (active instanceof HTMLElement && table.contains(active)) ||
        this.selectedCellCount() > 0 ||
        Boolean(shell?.classList.contains('is-interacting'))
      );
    };

    const exitAfterOutsidePointer = () => {
      const wrap = getWrap();
      if (this.selectedCellCount() > 1) {
        this.exitTableInteraction(wrap);
        return;
      }

      const active = document.activeElement;
      if (active instanceof HTMLElement && table.contains(active)) {
        active.blur();
        return;
      }
      this.exitTableInteraction(wrap);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const modifierHref = getModifierLinkActivationHref(event);
      if (modifierHref) {
        event.preventDefault();
        event.stopPropagation();
        table.dispatchEvent(new CustomEvent('meo-open-link', {
          bubbles: true,
          detail: { href: modifierHref }
        }));
        return;
      }
      if (isTableControlTarget(event.target)) return;
      const cell = this.findCellElement(event.target);
      if (!cell) return;
      const current = this.coordsFromCell(cell);
      if (!current) return;
      if (event.target instanceof HTMLTextAreaElement) {
        this.selectionAnchor = current;
        this.setActionTarget(current);
        this.applySelection(this.normalizeSelectionRange(current, current));
        return;
      }
      // Preview text selection is owned by this pointer pipeline. Preventing the
      // browser's default pointer action keeps the active textarea alive until
      // pointerup and prevents native text/image drag sessions from competing
      // with the DOM Selection that pointermove updates below.
      event.preventDefault();
      document.getSelection()?.removeAllRanges();
      const anchor = current;
      this.selectionAnchor = anchor;
      this.setActionTarget(anchor);
      this.applySelection(this.normalizeSelectionRange(anchor, current));
      this.selectionPointerId = event.pointerId;
      this.isDraggingSelection = true;

      const input = cell.querySelector('textarea');
      const pointerCaret = this.pointerCaretForCell(cell, event.clientX, event.clientY);
      const caret = pointerCaret.editorOffset;
      if (input instanceof HTMLTextAreaElement) {
        textSelectionInput = input;
        textSelectionAnchorCaret = caret ?? input.value.length;
        textSelectionCurrentCaret = textSelectionAnchorCaret;
        textSelectionCell = current;
        textSelectionCrossedCell = false;
        textSelectionDomAnchor = pointerCaret.domCaret;
      }
      try {
        table.setPointerCapture?.(event.pointerId);
      } catch {
        // Synthetic pointer events and already-released pointers cannot be
        // captured. Selection still works through the table listeners.
      }
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!this.isDraggingSelection || this.selectionPointerId !== event.pointerId) return;
      const el = document.elementFromPoint(event.clientX, event.clientY);
      const cell = this.findCellElement(el);
      if (!cell || !this.selectionAnchor) {
        if (!cell) markTextSelectionCrossedCell();
        return;
      }
      const current = this.coordsFromCell(cell);
      if (!current) return;
      if (
        textSelectionInput &&
        textSelectionAnchorCaret !== null &&
        textSelectionCell &&
        !textSelectionCrossedCell &&
        current.row === textSelectionCell.row &&
        current.col === textSelectionCell.col
      ) {
        const pointerCaret = this.pointerCaretForCell(cell, event.clientX, event.clientY, { nearestFallback: false });
        const caret = pointerCaret.editorOffset;
        if (caret !== null) {
          textSelectionCurrentCaret = caret;
        }
        const domCaret = pointerCaret.domCaret;
        if (textSelectionDomAnchor && domCaret) {
          const selection = document.getSelection();
          try {
            selection?.setBaseAndExtent(
              textSelectionDomAnchor.node,
              textSelectionDomAnchor.offset,
              domCaret.node,
              domCaret.offset
            );
          } catch {
            selection?.removeAllRanges();
          }
        }
        return;
      }
      markTextSelectionCrossedCell();
      this.setTableInteractionActive(getWrap(), true);
      this.applySelection(this.normalizeSelectionRange(this.selectionAnchor, current));
      table.focus({ preventScroll: true });
    };

    const endPointerSelection = (event: PointerEvent) => {
      if (this.selectionPointerId !== event.pointerId) return;
      const pendingInput = textSelectionInput;
      const anchorCaret = textSelectionAnchorCaret;
      let currentCaret = textSelectionCurrentCaret;
      if (
        event.type === 'pointerup' &&
        !textSelectionCrossedCell &&
        pendingInput instanceof HTMLTextAreaElement &&
        textSelectionCell
      ) {
        const releaseCell = this.findCellElement(document.elementFromPoint(event.clientX, event.clientY));
        const releaseCoords = releaseCell ? this.coordsFromCell(releaseCell) : null;
        if (
          releaseCell &&
          releaseCoords?.row === textSelectionCell.row &&
          releaseCoords?.col === textSelectionCell.col
        ) {
          const releaseCaret = this.pointerCaretForCell(
            releaseCell,
            event.clientX,
            event.clientY
          ).editorOffset;
          if (releaseCaret !== null) currentCaret = releaseCaret;
        } else {
          markTextSelectionCrossedCell();
        }
      }
      const shouldEnterTextEditing = (
        event.type === 'pointerup' &&
        !textSelectionCrossedCell &&
        pendingInput instanceof HTMLTextAreaElement &&
        anchorCaret !== null &&
        currentCaret !== null
      );
      this.isDraggingSelection = false;
      this.selectionPointerId = null;
      textSelectionInput = null;
      textSelectionAnchorCaret = null;
      textSelectionCurrentCaret = null;
      textSelectionCell = null;
      textSelectionCrossedCell = false;
      textSelectionDomAnchor = null;
      if (table.hasPointerCapture?.(event.pointerId)) {
        table.releasePointerCapture?.(event.pointerId);
      }
      if (event.type !== 'pointerup') {
        document.getSelection()?.removeAllRanges();
      }
      if (shouldEnterTextEditing && pendingInput && anchorCaret !== null && currentCaret !== null) {
        event.preventDefault();
        document.getSelection()?.removeAllRanges();
        this.focusTableInput(pendingInput, anchorCaret, { scrollCellIntoView: false });
        pendingInput.setSelectionRange(
          Math.min(anchorCaret, currentCaret),
          Math.max(anchorCaret, currentCaret),
          currentCaret < anchorCaret ? 'backward' : 'forward'
        );
        this.emitTableSelectionChange(getWrap());
      }
    };

    const onCopy = (event: ClipboardEvent) => {
      if (this.selectedCellCount() <= 1) return;
      const text = this.selectedTextAsTsv();
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      event.clipboardData?.setData('text/plain', text);
    };

    const onDragStart = (event: DragEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.meo-md-html-table-cell-preview')) return;
      event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (this.handleHistoryShortcut(event, table)) {
        return;
      }

      if (this.selectedCellCount() <= 1) return;
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (!this.selectionRange || !this.domRefs) return;
      event.preventDefault();
      for (let row = this.selectionRange.fromRow; row <= this.selectionRange.toRow; row++) {
        for (let col = this.selectionRange.fromCol; col <= this.selectionRange.toCol; col++) {
          const input = this.domRefs.allRowInputs[row][col];
          if (input.value !== '') {
            input.value = '';
            this.refreshCellPreviewFromInput(input);
            this.recordPendingCellEdit(row, col, input.value);
          }
        }
      }
      this.scheduleLayout({ resizeRows: true });
    };

    const onFocusOut = (event: FocusEvent) => {
      const nextTarget = event.relatedTarget;
      const wrap = this.domRefs?.wrap ?? table;
      const container = this.domRefs?.container ?? wrap;
      if (nextTarget instanceof Node && container.contains(nextTarget)) return;
      const nextTableShell = nextTarget instanceof Element
        ? nextTarget.closest('.meo-md-html-table-shell')
        : null;
      if (nextTableShell) {
        this.transferTableInteraction(wrap);
        return;
      }
      if (pendingTableSwitchPointerId !== null) {
        this.transferTableInteraction(wrap);
        return;
      }
      const view = this.getEditorView(wrap);
      if (view) commitPendingTableEdits(view);
      this.exitTableInteraction(wrap);
    };

    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      const wrap = getWrap();
      const container = getContainer();
      if (isSelectionMenuTarget(event.target)) {
        return;
      }
      const isOutsideTable = !container.contains(event.target);
      const targetTableShell = event.target instanceof Element
        ? event.target.closest('.meo-md-html-table-shell')
        : null;
      if (isOutsideTable && targetTableShell) {
        pendingTableSwitchPointerId = event.pointerId;
        this.transferTableInteraction(wrap);
        return;
      }
      if (!isOutsideTable && isModifierLinkActivationEvent(event)) return;
      if (!isOutsideTable && isTableControlTarget(event.target)) {
        return;
      }
      const active = document.activeElement;
      if (isOutsideTable) {
        if (!hasActiveTableInteraction()) return;
        pendingOutsidePointerId = event.pointerId;
        return;
      }
      if (!(active instanceof HTMLElement) || !table.contains(active)) return;
      if (active === event.target || active.contains(event.target)) return;

      const targetCell = this.findCellElement(event.target);
      if (targetCell) {
        // The table's pointer handler owns caret placement. Focusing here in the
        // document capture phase used to discard the pointer coordinates and
        // forced every newly-entered cell to the end.
        return;
      }
    };

    const onDocumentPointerMove = (event: PointerEvent) => {
      if (this.selectionPointerId !== event.pointerId) return;
      if (table.hasPointerCapture?.(event.pointerId)) return;
      if (event.target instanceof Node && table.contains(event.target)) return;
      markTextSelectionCrossedCell();
    };

    const onDocumentPointerEnd = (event: PointerEvent) => {
      if (event.pointerId === pendingTableSwitchPointerId) {
        const pointerId = event.pointerId;
        window.setTimeout(() => {
          if (pendingTableSwitchPointerId === pointerId) pendingTableSwitchPointerId = null;
        }, 0);
      }
      if (this.selectionPointerId === event.pointerId) {
        const targetInsideTable = event.target instanceof Node && table.contains(event.target);
        if (!targetInsideTable) markTextSelectionCrossedCell();
        if (!table.hasPointerCapture?.(event.pointerId) || !targetInsideTable) {
          endPointerSelection(event);
        }
      }
      if (event.pointerId !== pendingOutsidePointerId) return;
      pendingOutsidePointerId = null;
      // The browser dispatches click after pointerup. Delay the table commit until
      // that click reaches its original target so re-rendering cannot invalidate it.
      if (outsidePointerExitTimer !== null) window.clearTimeout(outsidePointerExitTimer);
      outsidePointerExitTimer = window.setTimeout(() => {
        outsidePointerExitTimer = null;
        exitAfterOutsidePointer();
      }, 0);
    };

    table.addEventListener('pointerdown', onPointerDown);
    table.addEventListener('pointermove', onPointerMove);
    table.addEventListener('pointerup', endPointerSelection);
    table.addEventListener('pointercancel', endPointerSelection);
    table.addEventListener('lostpointercapture', endPointerSelection);
    document.addEventListener('copy', onCopy, true);
    table.addEventListener('dragstart', onDragStart);
    table.addEventListener('keydown', onKeyDown, true);
    table.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('pointermove', onDocumentPointerMove, true);
    document.addEventListener('pointerup', onDocumentPointerEnd, true);
    document.addEventListener('pointercancel', onDocumentPointerEnd, true);
    const onCommitTableEdits = (event: Event) => {
      const hadPendingEdits = this.hasPendingCellEdits;
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      if (isPendingTableCommitDetail(detail)) {
        const pending = this.takePendingTransactionBuilders(getWrap());
        if (pending) {
          detail.transactionBuilders.push(...pending.builders);
        }
        detail.committed = Boolean(detail.committed || hadPendingEdits);
      }
    };
    document.addEventListener('meo-commit-table-edits', onCommitTableEdits);
    this.cleanupFns.push(() => {
      table.removeEventListener('pointerdown', onPointerDown);
      table.removeEventListener('pointermove', onPointerMove);
      table.removeEventListener('pointerup', endPointerSelection);
      table.removeEventListener('pointercancel', endPointerSelection);
      table.removeEventListener('lostpointercapture', endPointerSelection);
      document.removeEventListener('copy', onCopy, true);
      table.removeEventListener('dragstart', onDragStart);
      table.removeEventListener('keydown', onKeyDown, true);
      table.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('pointermove', onDocumentPointerMove, true);
      document.removeEventListener('pointerup', onDocumentPointerEnd, true);
      document.removeEventListener('pointercancel', onDocumentPointerEnd, true);
      document.removeEventListener('meo-commit-table-edits', onCommitTableEdits);
      pendingOutsidePointerId = null;
      pendingTableSwitchPointerId = null;
      if (outsidePointerExitTimer !== null) {
        window.clearTimeout(outsidePointerExitTimer);
        outsidePointerExitTimer = null;
      }
    });
  }

  takePendingTransactionBuilders(dom: HTMLElement | undefined): {
    view: EditorView;
    builders: PendingTableTransactionBuilder[];
  } | null {
    if (!this.hasPendingCellEdits) return null;
    const view = this.getEditorView(dom);
    if (!view) return null;
    const pendingCellEdits = this.pendingCellEdits;
    this.pendingCellEdits = [];
    this.hasPendingCellEdits = false;
    if (pendingCellEdits.length) {
      const tableStartLine = view.state.doc.lineAt(
        Math.max(0, Math.min(this.tableData.from ?? 0, view.state.doc.length))
      ).number;
      return {
        view,
        builders: pendingCellEdits.map((edit) => ({
          sequence: edit.sequence,
          build: (state) => {
            const change = this.pendingCellSourceChange(state, edit, tableStartLine);
            return change
              ? state.update({ changes: change, annotations: isolateHistory.of('full') })
              : null;
          }
        }))
      };
    }
    const changes = this.collectPendingCellSourceChanges(view);
    return {
      view,
      builders: changes.length ? [{
        sequence: ++nextTableCellEditSequence,
        build: (state) => state.update({ changes, annotations: isolateHistory.of('full') })
      }] : []
    };
  }

  preserveTableCommandViewport(run: () => void) {
    const controller = this.view ? getViewportController(this.view) : null;
    if (controller) controller.preserveScrollPosition(run);
    else run();
  }

  buildAlignmentTransaction(
    alignment: 'left' | 'center' | 'right',
    target: TableCommandTarget
  ): TableCommandTransactionPlan {
    const dom = this.domRefs?.wrap;
    const view = this.view;
    const column = this.columnIndexFor(target.column);
    if (!dom || !view || column === null) return { transaction: null, outcome: 'no-op' };
    if (!this.resolveCurrentTableRange(view, dom)) return { transaction: null, outcome: 'no-op' };
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return { transaction: null, outcome: 'no-op' };
    const alignments = normalizeRow(this.tableData.alignments, matrix.headerCells.length, '').map((value) => value ?? null);
    alignments[column] = alignment;
    matrix.alignments = alignments;
    return this.buildMatrixTransaction(matrix, dom, { row: target.row ?? 0, col: column }, {
      alignmentOverrideColumn: column
    });
  }

  buildTableCommandTransaction(
    command: TableCommand,
    target: TableCommandTarget
  ): TableCommandTransactionPlan {
    const dom = this.domRefs?.wrap;
    if (!dom) return { transaction: null, outcome: 'no-op' };
    const bodyRow = this.bodyRowIndexFor(target.row);
    const column = this.columnIndexFor(target.column);
    const selection = target.selection;
    const selectionCount = selection
      ? (selection.toRow - selection.fromRow + 1) * (selection.toColumn - selection.fromColumn + 1)
      : 0;

    switch (command) {
      case 'insert-row-above': {
        return bodyRow === null
          ? this.buildAddRowAfter(dom, -1, column ?? 0)
          : this.buildAddRowBefore(dom, bodyRow, column ?? 0);
      }
      case 'insert-row-below':
        return this.buildAddRowAfter(dom, bodyRow ?? -1, column ?? 0);
      case 'delete-row': {
        if (!selection || selectionCount <= 1) {
          return bodyRow === null
            ? { transaction: null, outcome: 'no-op' }
            : this.buildRemoveRowsAt(dom, [bodyRow], column ?? 0);
        }
        const bodyRowIndexes: number[] = [];
        for (let row = Math.max(1, selection.fromRow); row <= selection.toRow; row += 1) {
          const bodyIndex = row - 1;
          if (bodyIndex >= 0 && bodyIndex < this.tableData.rows.length) bodyRowIndexes.push(bodyIndex);
        }
        return this.buildRemoveRowsAt(dom, bodyRowIndexes, column ?? 0);
      }
      case 'insert-column-left': {
        return column === null
          ? { transaction: null, outcome: 'no-op' }
          : this.buildAddColumnBefore(dom, column, target.row ?? 0);
      }
      case 'insert-column-right': {
        return column === null
          ? { transaction: null, outcome: 'no-op' }
          : this.buildAddColumnAfter(dom, column, target.row ?? 0);
      }
      case 'delete-column': {
        if (!selection || selectionCount <= 1) {
          return column === null
            ? { transaction: null, outcome: 'no-op' }
            : this.buildRemoveColumnsAt(dom, [column], target.row ?? 0);
        }
        const columns: number[] = [];
        for (let selectedColumn = selection.fromColumn; selectedColumn <= selection.toColumn; selectedColumn += 1) {
          if (selectedColumn >= 0 && selectedColumn < this.tableData.colCount) columns.push(selectedColumn);
        }
        return this.buildRemoveColumnsAt(dom, columns, target.row ?? 0);
      }
      case 'align-left':
        return this.buildAlignmentTransaction('left', target);
      case 'align-center':
        return this.buildAlignmentTransaction('center', target);
      case 'align-right':
        return this.buildAlignmentTransaction('right', target);
    }
  }

  recordPendingCellEdit(row: number, col: number, value: string) {
    const last = this.pendingCellEdits[this.pendingCellEdits.length - 1];
    if (last?.row === row && last.col === col) last.value = value;
    else this.pendingCellEdits.push({ row, col, value, sequence: ++nextTableCellEditSequence });
    this.hasPendingCellEdits = true;
  }

  pendingCellSourceChange(state: EditorState, edit: PendingCellEdit, tableStartLine: number) {
    const lineNumber = tableStartLine + (edit.row === 0 ? 0 : edit.row + 1);
    if (lineNumber > state.doc.lines) return null;
    const line = state.doc.line(lineNumber);
    const parsed = parseTableRowCells(line.text, line.from);
    const insert = tableCellEditorValueToSource(edit.value).trim();
    const segment = parsed.segments[edit.col];
    if (segment) {
      const current = state.doc.sliceString(segment.from, segment.to);
      if (current.trim() === insert) return null;
      let paddedInsert = insert;
      if (current.trim() === '' && insert !== '') {
        const leadingPadding = current.slice(0, Math.min(1, current.length));
        const trailingPadding = current.length > 1 ? current.slice(-1) : '';
        const innerWidth = Math.max(0, current.length - leadingPadding.length - trailingPadding.length);
        paddedInsert = `${leadingPadding}${insert}${' '.repeat(Math.max(0, innerWidth - insert.length))}${trailingPadding}`;
      }
      return { from: segment.from, to: segment.to, insert: paddedInsert };
    }

    if (edit.col >= parsed.cells.length) {
      const missingValues = Array.from(
        { length: edit.col - parsed.cells.length + 1 },
        (_, index) => index === edit.col - parsed.cells.length ? insert : ''
      );
      const trimmedEnd = line.text.trimEnd().length;
      const hasTrailingPipe = trimmedEnd > 0 && line.text[trimmedEnd - 1] === '|';
      const at = hasTrailingPipe ? line.from + trimmedEnd - 1 : line.to;
      return {
        from: at,
        to: at,
        insert: hasTrailingPipe
          ? `| ${missingValues.join(' | ')} `
          : ` | ${missingValues.join(' | ')}`
      };
    }

    const cells = parsed.cells.map((cell) => cell.trim());
    cells[edit.col] = insert;
    const indent = /^\s*/.exec(line.text)?.[0] ?? '';
    return { from: line.from, to: line.to, insert: `${indent}| ${cells.join(' | ')} |` };
  }

  collectPendingCellSourceChanges(view: EditorView, excludedBodyRows = new Set<number>()) {
    if (!this.domRefs) return [];
    const changes: Array<{ from: number; to: number; insert: string }> = [];
    const tableStartLine = view.state.doc.lineAt(
      Math.max(0, Math.min(this.tableData.from ?? 0, view.state.doc.length))
    ).number;
    const collectRow = (inputs: HTMLTextAreaElement[], originalCells: string[], lineNumber: number) => {
      const line = view.state.doc.line(lineNumber);
      const parsed = parseTableRowCells(line.text, line.from);
      const rowChanges: Array<{ from: number; to: number; insert: string }> = [];
      let requiresRowReplacement = false;
      const missingCellChanges: Array<{ index: number; insert: string }> = [];
      let missingCellInsertion: { from: number; to: number; insert: string } | null = null;
      for (let index = 0; index < inputs.length; index += 1) {
        const input = inputs[index];
        const insert = tableCellEditorValueToSource(input.value).trim();
        if ((originalCells[index] ?? '') === insert) continue;
        const from = Number.parseInt(input.dataset.tableCellFrom ?? '', 10);
        const to = Number.parseInt(input.dataset.tableCellTo ?? '', 10);
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > view.state.doc.length) {
          requiresRowReplacement = true;
          continue;
        }
        if (from === to) {
          const segment = parsed.segments[index];
          if (segment && segment.from === from && segment.to === to) {
            rowChanges.push({ from, to, insert });
          } else {
            missingCellChanges.push({ index, insert });
          }
          continue;
        }
        const current = view.state.doc.sliceString(from, to);
        let paddedInsert = insert;
        if (current.trim() === '' && insert !== '') {
          const leadingPadding = current.slice(0, Math.min(1, current.length));
          const trailingPadding = current.length > 1 ? current.slice(-1) : '';
          const innerWidth = Math.max(0, current.length - leadingPadding.length - trailingPadding.length);
          paddedInsert = `${leadingPadding}${insert}${' '.repeat(Math.max(0, innerWidth - insert.length))}${trailingPadding}`;
        }
        rowChanges.push({ from, to, insert: paddedInsert });
      }
      if (!rowChanges.length && !missingCellChanges.length && !requiresRowReplacement) return;
      rowChanges.sort((left, right) => left.from - right.from || left.to - right.to);
      for (let index = 1; index < rowChanges.length; index += 1) {
        if (rowChanges[index].from < rowChanges[index - 1].to) requiresRowReplacement = true;
      }
      if (missingCellChanges.length) {
        const firstMissingIndex = parsed.cells.length;
        const lastMissingIndex = Math.max(...missingCellChanges.map(({ index }) => index));
        if (missingCellChanges.some(({ index }) => index < firstMissingIndex)) {
          requiresRowReplacement = true;
        } else {
          const missingValues = inputs
            .slice(firstMissingIndex, lastMissingIndex + 1)
            .map((input) => tableCellEditorValueToSource(input.value).trim());
          const trimmedEnd = line.text.trimEnd().length;
          const hasTrailingPipe = trimmedEnd > 0 && line.text[trimmedEnd - 1] === '|';
          missingCellInsertion = {
            from: hasTrailingPipe ? line.from + trimmedEnd - 1 : line.to,
            to: hasTrailingPipe ? line.from + trimmedEnd - 1 : line.to,
            insert: hasTrailingPipe
              ? `| ${missingValues.join(' | ')} `
              : ` | ${missingValues.join(' | ')}`
          };
        }
      }
      if (!requiresRowReplacement) {
        changes.push(...rowChanges);
        if (missingCellInsertion) changes.push(missingCellInsertion);
        return;
      }

      const cells = inputs.map((input) => tableCellEditorValueToSource(input.value).trim());
      changes.push({
        from: line.from,
        to: line.to,
        insert: `${this.tableData.indent}| ${cells.join(' | ')} |`
      });
    };

    collectRow(this.domRefs.headerInputs, this.tableData.headerCells ?? [], tableStartLine);
    for (let rowIndex = 0; rowIndex < this.domRefs.sourceBodyRowInputs.length; rowIndex += 1) {
      if (excludedBodyRows.has(rowIndex)) continue;
      collectRow(
        this.domRefs.sourceBodyRowInputs[rowIndex],
        this.tableData.rows[rowIndex] ?? [],
        tableStartLine + rowIndex + 2
      );
    }
    changes.sort((left, right) => left.from - right.from || left.to - right.to);
    return changes;
  }

  scheduleFocusCellAfterCommit(view: EditorView, tableStartLine: number, focusTarget: PendingCellFocus) {
    const focusCell = () => {
      const input = view.dom.querySelector(
        `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${tableStartLine}"] textarea[data-table-row="${focusTarget.row}"][data-table-col="${focusTarget.col}"]`
      );
      if (!(input instanceof HTMLTextAreaElement)) return false;
      input.focus({ preventScroll: true });
      const caret = Math.min(Math.max(focusTarget.caret ?? 0, 0), input.value.length);
      input.setSelectionRange(caret, caret);
      input.closest(tableCellSelector)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      return true;
    };

    if (focusCell()) return;
    requestAnimationFrame(() => {
      if (!focusCell()) {
        setTimeout(focusCell, 0);
      }
    });
  }

  buildMatrixTransaction(
    matrix: CellMatrix,
    dom: HTMLElement,
    focusTarget: PendingCellFocus | null = null,
    {
      preserveScrollPosition = false,
      sourceRowOrder = null,
      extraEffects = [],
      alignmentOverrideColumn = null
    }: {
      preserveScrollPosition?: boolean;
      sourceRowOrder?: number[] | null;
      extraEffects?: readonly StateEffect<unknown>[];
      alignmentOverrideColumn?: number | null;
    } = {}
  ): TableCommandTransactionPlan {
    const view = this.getEditorView(dom);
    if (!view) return { transaction: null, outcome: 'no-op' };

    const { headerCells, rows, alignments = this.tableData.alignments } = matrix;
    if (!headerCells.length) return { transaction: null, outcome: 'no-op' };
    const range = this.resolveCurrentTableRange(view, dom);
    if (!range) return { transaction: null, outcome: 'no-op' };
    const tableStartLine = view.state.doc.lineAt(range.from).number;
    const markdown = serializeTableMarkdown(this.tableData.indent, headerCells, alignments, rows);
    const current = view.state.doc.sliceString(range.from, range.to);
    const commandEffects = alignmentOverrideColumn === null
      ? [...extraEffects]
      : [
          ...extraEffects,
          setTableHeaderAlignmentOverrideEffect.of({
            from: range.from,
            to: range.from + markdown.length,
            column: alignmentOverrideColumn
          })
        ];
    if (current === markdown) {
      this.hasPendingCellEdits = false;
      if (commandEffects.length) {
        return {
          transaction: { effects: commandEffects },
          outcome: 'changed',
          restoreInteraction: focusTarget
            ? () => this.scheduleFocusCellAfterCommit(view, tableStartLine, focusTarget)
            : undefined
        };
      }
      if (focusTarget) this.focusCellInputAt(focusTarget.row, focusTarget.col, 0);
      return {
        transaction: null,
        outcome: 'no-op'
      };
    }

    const effectiveSourceRowOrder = sourceRowOrder ?? (
      rows.length === this.tableData.rows.length
        ? rows.map((_row, index) => index)
        : []
    );
    const markdownLineOffsets: number[] = [];
    let markdownOffset = 0;
    for (const line of markdown.split('\n')) {
      markdownLineOffsets.push(markdownOffset);
      markdownOffset += line.length + 1;
    }
    const trackedRowMappings = getTableTransactionProvenanceSnapshot(view.state).insertedRows
      .filter((row) => row.from >= range.from && row.to <= range.to)
      .map((trackedRow) => {
        const sourceRowIndex = view.state.doc.lineAt(trackedRow.from).number - tableStartLine - 2;
        const nextRowIndex = effectiveSourceRowOrder.indexOf(sourceRowIndex);
        if (nextRowIndex < 0) return null;
        return {
          id: trackedRow.id,
          oldOffset: trackedRow.from - range.from,
          newOffset: markdownLineOffsets[nextRowIndex + 2]
        };
      })
      .filter((mapping): mapping is { id: string; oldOffset: number; newOffset: number } => mapping !== null);
    const provenanceEffect = getTableTransactionProvenance(view.state).effect({
      type: 'remapInsertedRows',
      tableFrom: range.from,
      rows: trackedRowMappings
    });
    this.hasPendingCellEdits = false;
    return {
      transaction: {
        changes: { from: range.from, to: range.to, insert: markdown },
        effects: [provenanceEffect, ...commandEffects]
      },
      outcome: 'changed',
      preserveViewport: preserveScrollPosition,
      restoreInteraction: focusTarget
        ? () => this.scheduleFocusCellAfterCommit(view, tableStartLine, focusTarget)
        : undefined
    };
  }

  buildAddRowAfter(dom: HTMLElement, rowIndex: number, focusColumn: number): TableCommandTransactionPlan {
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return { transaction: null, outcome: 'no-op' };
    const insertAt = Math.min(Math.max(rowIndex + 1, 0), matrix.rows.length);
    const sourcePlan = this.buildInsertSourceRowTransaction(dom, insertAt, matrix.headerCells.length);
    if (sourcePlan) return sourcePlan;
    matrix.rows.splice(insertAt, 0, new Array(matrix.headerCells.length).fill(''));
    const sourceRowOrder = matrix.rows.map((_row, index) => (
      index < insertAt ? index : index === insertAt ? -1 : index - 1
    ));
    return this.buildMatrixTransaction(
      matrix,
      dom,
      { row: insertAt + 1, col: focusColumn },
      { sourceRowOrder }
    );
  }

  buildAddRowBefore(dom: HTMLElement, rowIndex: number, focusColumn: number): TableCommandTransactionPlan {
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return { transaction: null, outcome: 'no-op' };
    const insertAt = Math.min(Math.max(rowIndex, 0), matrix.rows.length);
    const sourcePlan = this.buildInsertSourceRowTransaction(dom, insertAt, matrix.headerCells.length);
    if (sourcePlan) return sourcePlan;
    matrix.rows.splice(insertAt, 0, new Array(matrix.headerCells.length).fill(''));
    const sourceRowOrder = matrix.rows.map((_row, index) => (
      index < insertAt ? index : index === insertAt ? -1 : index - 1
    ));
    return this.buildMatrixTransaction(
      matrix,
      dom,
      { row: insertAt + 1, col: focusColumn },
      { sourceRowOrder }
    );
  }

  buildInsertSourceRowTransaction(
    dom: HTMLElement,
    insertAt: number,
    colCount: number
  ): TableCommandTransactionPlan | null {
    const view = this.getEditorView(dom);
    if (!view || colCount <= 0) return null;
    const range = this.resolveCurrentTableRange(view, dom);
    if (!range) return null;

    const tableStartLine = view.state.doc.lineAt(range.from).number;
    const blankRow = `${this.tableData.indent}| ${new Array(colCount).fill('').join(' | ')} |`;
    const changes = this.collectPendingCellSourceChanges(view);
    const provenance = getTableTransactionProvenance(view.state);
    let insertedRowEffect: StateEffect<unknown>;
    if (insertAt < this.tableData.rows.length) {
      const line = view.state.doc.line(tableStartLine + 2 + insertAt);
      changes.push({ from: line.from, to: line.from, insert: `${blankRow}\n` });
      insertedRowEffect = provenance.effect({ type: 'insertedRow', at: line.from, assoc: -1 });
    } else {
      const previousLine = view.state.doc.line(tableStartLine + 1 + this.tableData.rows.length);
      changes.push({ from: previousLine.to, to: previousLine.to, insert: `\n${blankRow}` });
      insertedRowEffect = provenance.effect({
        type: 'insertedRow', at: previousLine.to, assoc: -1, offset: 1
      });
    }
    changes.sort((left, right) => left.from - right.from || left.to - right.to);
    this.hasPendingCellEdits = false;
    const focusTarget = { row: insertAt + 1, col: this.activeColumnIndex() ?? 0 };
    return {
      transaction: { changes, effects: insertedRowEffect },
      outcome: 'changed',
      restoreInteraction: () => this.scheduleFocusCellAfterCommit(view, tableStartLine, focusTarget)
    };
  }

  buildRemoveRowsAt(dom: HTMLElement, rowIndexes: number[], focusColumn: number): TableCommandTransactionPlan {
    const uniqueIndexes = [...new Set(rowIndexes)].sort((left, right) => right - left);
    if (!uniqueIndexes.length) return { transaction: null, outcome: 'no-op' };
    const matrix = this.readCellMatrix();
    const validIndexes = uniqueIndexes.filter((index) => index >= 0 && index < matrix.rows.length);
    if (!validIndexes.length) return { transaction: null, outcome: 'no-op' };
    const firstRemoved = Math.min(...validIndexes);
    if (validIndexes.length < matrix.rows.length) {
      const focusRow = Math.min(firstRemoved, matrix.rows.length - validIndexes.length - 1) + 1;
      const sourcePlan = this.buildRemoveSourceRowsTransaction(
        dom,
        validIndexes,
        { row: focusRow, col: focusColumn }
      );
      if (sourcePlan) return sourcePlan;
    }
    for (const index of validIndexes) matrix.rows.splice(index, 1);
    if (matrix.rows.length === 0) {
      matrix.rows.push(new Array(matrix.headerCells.length).fill(''));
    }
    const focusRow = Math.min(firstRemoved, matrix.rows.length - 1) + 1;
    const sourceRowOrder = this.tableData.rows
      .map((_row, index) => index)
      .filter((index) => !validIndexes.includes(index));
    return this.buildMatrixTransaction(
      matrix,
      dom,
      { row: focusRow, col: focusColumn },
      { sourceRowOrder }
    );
  }

  buildRemoveSourceRowsTransaction(
    dom: HTMLElement,
    rowIndexes: number[],
    focusTarget: PendingCellFocus
  ): TableCommandTransactionPlan | null {
    const view = this.getEditorView(dom);
    if (!view) return null;
    const range = this.resolveCurrentTableRange(view, dom);
    if (!range) return null;

    const tableStartLine = view.state.doc.lineAt(range.from).number;
    const sortedIndexes = [...rowIndexes].sort((left, right) => left - right);
    const removedIndexes = new Set(sortedIndexes);
    const groups: Array<{ from: number; to: number }> = [];
    for (const index of sortedIndexes) {
      const previous = groups[groups.length - 1];
      if (previous && index === previous.to + 1) previous.to = index;
      else groups.push({ from: index, to: index });
    }

    const deletionEffects = groups.flatMap((group) => {
      const baselineLines = sortedIndexes
        .filter((index) => index >= group.from && index <= group.to)
        .map((index) => this.tableData.diffFlagsByLine?.[tableStartLine + 2 + index]?.baselineLineNumber)
        .filter((lineNumber): lineNumber is number => typeof lineNumber === 'number' && lineNumber > 0)
        .sort((left, right) => left - right);
      const baselineRanges: Array<[number, number]> = [];
      for (const lineNumber of baselineLines) {
        const previous = baselineRanges[baselineRanges.length - 1];
        if (previous && lineNumber <= previous[1] + 1) previous[1] = Math.max(previous[1], lineNumber);
        else baselineRanges.push([lineNumber, lineNumber]);
      }
      if (!baselineRanges.length) return [];

      const fromLine = tableStartLine + 2 + group.from;
      const deletionAtEnd = group.to === this.tableData.rows.length - 1;
      const anchor = deletionAtEnd
        ? Math.max(0, view.state.doc.line(fromLine).from - 1)
        : view.state.doc.line(fromLine).from;
      return [getTableTransactionProvenance(view.state).effect({
        type: 'deletedRows',
        at: anchor,
        assoc: deletionAtEnd ? -1 : 1,
        baselineRanges,
        deletionAtEnd
      })];
    });
    const changes: Array<{ from: number; to: number; insert?: string }> = groups.map((group) => {
      const fromLine = tableStartLine + 2 + group.from;
      const toLine = tableStartLine + 2 + group.to;
      const deletionEndsDocument = toLine === view.state.doc.lines;
      const from = deletionEndsDocument
        ? view.state.doc.line(fromLine).from - 1
        : view.state.doc.line(fromLine).from;
      const to = deletionEndsDocument
        ? view.state.doc.line(toLine).to
        : view.state.doc.line(toLine + 1).from;
      return { from, to };
    });
    changes.push(...this.collectPendingCellSourceChanges(view, removedIndexes));
    changes.sort((left, right) => left.from - right.from || left.to - right.to);
    this.hasPendingCellEdits = false;
    return {
      transaction: { changes, effects: deletionEffects },
      outcome: 'changed',
      restoreInteraction: () => this.scheduleFocusCellAfterCommit(view, tableStartLine, focusTarget)
    };
  }

  buildAddColumnAfter(dom: HTMLElement, colIndex: number, focusRow: number): TableCommandTransactionPlan {
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return { transaction: null, outcome: 'no-op' };
    const insertAt = Math.min(Math.max(colIndex + 1, 0), matrix.headerCells.length);
    matrix.headerCells.splice(insertAt, 0, '');
    matrix.rows = matrix.rows.map((row) => {
      const next = row.slice();
      next.splice(insertAt, 0, '');
      return next;
    });
    const alignments = normalizeRow(this.tableData.alignments, matrix.headerCells.length - 1, '').map((value) => value ?? null);
    alignments.splice(insertAt, 0, null);
    matrix.alignments = alignments;
    return this.buildMatrixTransaction(matrix, dom, { row: focusRow, col: insertAt });
  }

  buildAddColumnBefore(dom: HTMLElement, colIndex: number, focusRow: number): TableCommandTransactionPlan {
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return { transaction: null, outcome: 'no-op' };
    const insertAt = Math.min(Math.max(colIndex, 0), matrix.headerCells.length);
    matrix.headerCells.splice(insertAt, 0, '');
    matrix.rows = matrix.rows.map((row) => {
      const next = row.slice();
      next.splice(insertAt, 0, '');
      return next;
    });
    const alignments = normalizeRow(this.tableData.alignments, matrix.headerCells.length - 1, '').map((value) => value ?? null);
    alignments.splice(insertAt, 0, null);
    matrix.alignments = alignments;
    return this.buildMatrixTransaction(matrix, dom, { row: focusRow, col: insertAt });
  }

  buildRemoveColumnsAt(dom: HTMLElement, columnIndexes: number[], focusRow: number): TableCommandTransactionPlan {
    const uniqueIndexes = [...new Set(columnIndexes)].sort((left, right) => right - left);
    if (!uniqueIndexes.length) return { transaction: null, outcome: 'no-op' };
    const matrix = this.readCellMatrix();
    const validIndexes = uniqueIndexes.filter((index) => index >= 0 && index < matrix.headerCells.length);
    if (!validIndexes.length) return { transaction: null, outcome: 'no-op' };
    const firstRemoved = Math.min(...validIndexes);
    for (const index of validIndexes) matrix.headerCells.splice(index, 1);
    matrix.rows = matrix.rows.map((row) => {
      const next = row.slice();
      for (const index of validIndexes) next.splice(index, 1);
      return next;
    });
    const alignments = normalizeRow(this.tableData.alignments, matrix.headerCells.length + validIndexes.length, '').map((value) => value ?? null);
    for (const index of validIndexes) alignments.splice(index, 1);
    if (matrix.headerCells.length === 0) {
      matrix.headerCells.push('');
      matrix.rows = matrix.rows.map(() => ['']);
      alignments.push(null);
    }
    matrix.alignments = alignments;
    const focusCol = Math.min(firstRemoved, matrix.headerCells.length - 1);
    return this.buildMatrixTransaction(matrix, dom, { row: focusRow, col: focusCol });
  }

  cellDiagnostics(rowIndex: number, colIndex: number): TableCellDiagnostics[] {
    return this.tableData.diagnostics?.[rowIndex]?.[colIndex] ?? [];
  }

  wireInput(input: HTMLTextAreaElement, rowEl: HTMLTableRowElement, rowInputs: HTMLTextAreaElement[], container: HTMLElement, rowIndex: number, colIndex: number, preview: HTMLElement) {
    let compositionActive = false;
    let compositionEndedAt = Number.NEGATIVE_INFINITY;
    const refreshPreview = () => {
      this.renderCellPreview(
        preview,
        tableCellEditorValueToSource(input.value),
        this.cellDiagnostics(rowIndex, colIndex),
        this.cellSourceRange(rowIndex, colIndex)
      );
    };
    const notifySelectionChange = () => {
      this.emitTableSelectionChange(container);
    };
    const getCollapsedCaretLineInfo = () => {
      const start = input.selectionStart ?? 0;
      const end = input.selectionEnd ?? start;
      if (start !== end) return null;
      const value = input.value ?? '';
      const prevNl = value.lastIndexOf('\n', Math.max(0, start - 1));
      const nextNl = value.indexOf('\n', start);
      const lineStart = prevNl + 1;
      return {
        column: start - lineStart,
        isFirstLine: lineStart === 0,
        isLastLine: nextNl < 0
      };
    };
    const onArrowVertical = (event: KeyboardEvent, direction: 'up' | 'down') => {
      if (event.defaultPrevented) return false;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
      if (direction !== 'up' && direction !== 'down') return false;

      const caretInfo = getCollapsedCaretLineInfo();
      if (!caretInfo) return false;

      const atBoundary = direction === 'up' ? caretInfo.isFirstLine : caretInfo.isLastLine;
      if (!atBoundary) return false;

      const nextRow = direction === 'up' ? rowIndex - 1 : rowIndex + 1;
      event.preventDefault();
      event.stopPropagation();

      const nextInput = this.domRefs?.allRowInputs?.[nextRow]?.[colIndex];
      if (nextInput instanceof HTMLTextAreaElement) {
        const nextCaret = Math.min(caretInfo.column, nextInput.value.length);
        return this.focusTableInput(nextInput, nextCaret);
      }

      return this.moveVerticalOutOfTable(container, direction, caretInfo.column);
    };

    input.addEventListener('input', () => {
      normalizeTableCellEditorInput(input);
      this.recordPendingCellEdit(rowIndex, colIndex, input.value);
      const hadSearchMatch = input.parentElement?.classList.contains('has-search-match') ?? false;
      const sourceValue = tableCellEditorValueToSource(input.value);
      if (this.searchState && (hadSearchMatch || shouldExpandTableCellForSearch(sourceValue, this.searchState))) {
        refreshPreview();
      }
      // Grow the focused row in the input event's task. Deferring this mutation to
      // CodeMirror's next measure lets the textarea scroll its caret for one paint,
      // then snap back after the row catches up.
      const resizeAndSchedule = () => {
        // Non-search previews stay untouched while editing so inline image DOM is not recreated.
        this.resizeRow(rowEl, rowInputs);
        if (rowIndex === 0) this.stickyHeaderAdapter.update();
        this.scheduleLayout();
      };
      resizeAndSchedule();
      const viewport = this.view ? getViewportController(this.view) : null;
      if (viewport && document.activeElement === input) viewport.revealElement(rowEl);
      notifySelectionChange();
    });
    input.addEventListener('select', notifySelectionChange);
    input.addEventListener('keyup', notifySelectionChange);
    input.addEventListener('pointerup', notifySelectionChange);
    input.addEventListener('compositionstart', () => {
      compositionActive = true;
    });
    input.addEventListener('compositionend', () => {
      compositionActive = false;
      compositionEndedAt = performance.now();
    });
    input.addEventListener('keydown', (event) => {
      const followsCompositionEnd = performance.now() - compositionEndedAt < 100;
      if (compositionActive || event.isComposing || event.keyCode === 229 || (
        followsCompositionEnd && (event.key === 'Enter' || event.key === ' ')
      )) return;
      if (event.key === 'Enter') {
        if ((event.shiftKey || event.ctrlKey) && !event.altKey && !event.metaKey) {
          event.preventDefault();
          event.stopPropagation();
          if (!continueTableCellList(input)) replaceTableCellEditorSelection(input, '<br>\n');
          return;
        }
        if (!event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          if (rowIndex < this.tableData.rows.length) {
            this.focusCellInputAt(rowIndex + 1, colIndex, 0);
          } else {
            this.setActionTarget({ row: rowIndex, col: colIndex });
            this.requestTableCommand('insert-row-below', true);
          }
        }
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === ']' || event.key === '[')) {
        if (adjustTableCellListIndent(input, event.key === ']' ? 'indent' : 'outdent')) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (event.key === 'Backspace' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? start;
        const breakMatch = start === end ? /<br\s*\/?>\n$/i.exec(input.value.slice(0, start)) : null;
        if (breakMatch) {
          event.preventDefault();
          event.stopPropagation();
          input.setSelectionRange(start - breakMatch[0].length, start);
          replaceTableCellEditorSelection(input, '');
          return;
        }
      }
      const direction = event.key === 'ArrowUp' ? 'up' : event.key === 'ArrowDown' ? 'down' : null;
      if (direction) onArrowVertical(event, direction);
    });
    input.addEventListener('focus', () => {
      const lastPendingEdit = this.pendingCellEdits[this.pendingCellEdits.length - 1];
      if (
        lastPendingEdit &&
        (lastPendingEdit.row !== rowIndex || lastPendingEdit.col !== colIndex) &&
        !this.pendingCellSwitchCommit
      ) {
        this.pendingCellSwitchCommit = true;
        queueMicrotask(() => {
          this.pendingCellSwitchCommit = false;
          const view = this.view;
          const wrap = this.domRefs?.wrap;
          const activeInput = document.activeElement;
          if (!view || !wrap || !(activeInput instanceof HTMLTextAreaElement) || !wrap.contains(activeInput)) return;
          const activeCell = activeInput.closest<HTMLTableCellElement>(tableCellSelector);
          const focusTarget = activeCell ? this.coordsFromCell(activeCell) : null;
          if (!focusTarget || !this.hasPendingCellEdits) return;
          const tableStartLine = view.state.doc.lineAt(
            Math.max(0, Math.min(this.tableData.from, view.state.doc.length))
          ).number;
          const caret = activeInput.selectionStart ?? 0;
          if (commitPendingTableEdits(view)) {
            this.scheduleFocusCellAfterCommit(view, tableStartLine, { ...focusTarget, caret });
          }
        });
      }
      this.setCellEditingState(input, true);
      this.setTableInteractionActive(container, true);
      this.setSingleCellSelection({ row: rowIndex, col: colIndex });
      notifySelectionChange();
    });
    input.addEventListener('blur', (event) => {
      refreshPreview();
      this.setCellEditingState(input, false);
      notifySelectionChange();
      const nextTarget = event.relatedTarget;
      const nextTableShell = nextTarget instanceof Element
        ? nextTarget.closest('.meo-md-html-table-shell')
        : null;
      if (nextTableShell) {
        if (nextTarget instanceof Node && !container.contains(nextTarget)) {
          this.transferTableInteraction(container);
        }
        return;
      }
      this.setTableInteractionActive(container, false);
    });
  }

  createColumnResizeHandle(column: number): HTMLSpanElement {
    const handle = document.createElement('span');
    handle.className = 'meo-md-html-table-column-resize-handle';
    handle.dataset.tableResizeColumn = String(column);
    handle.setAttribute('aria-hidden', 'true');
    return handle;
  }

  resizeRow(row: HTMLTableRowElement, rowInputs: HTMLTextAreaElement[] | null = null) {
    if (!row) return;
    const textareas = rowInputs ?? Array.from(row.querySelectorAll('textarea'));
    const contents = Array.from(row.querySelectorAll('.meo-md-html-table-cell-content')) as HTMLElement[];
    if (textareas.length === 0 || contents.length === 0) return;

    let maxHeight = 0;
    for (let index = 0; index < textareas.length; index += 1) {
      const textarea = textareas[index];
      const content = contents[index];
      const preview = content?.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
      const probe = textarea.cloneNode(false) as HTMLTextAreaElement;
      probe.value = textarea.value;
      probe.tabIndex = -1;
      probe.setAttribute('aria-hidden', 'true');
      probe.style.inset = 'auto';
      probe.style.top = '0';
      probe.style.left = '0';
      probe.style.width = `${textarea.getBoundingClientRect().width}px`;
      probe.style.height = '0px';
      probe.style.visibility = 'hidden';
      probe.style.pointerEvents = 'none';
      content.appendChild(probe);
      maxHeight = Math.max(maxHeight, probe.scrollHeight, preview?.scrollHeight ?? 0);
      probe.remove();
    }

    for (const content of contents) {
      content.style.minHeight = `${maxHeight}px`;
    }
  }

  resizeAllRows() {
    if (!this.domRefs) return;
    for (const entry of this.domRefs.rowEntries) {
      this.resizeRow(entry.row, entry.inputs);
    }
  }

  syncTableLineNumbers() {
    if (!this.domRefs) return;
    const { table, lineNumberLayer } = this.domRefs;
    const gutter = this.view?.dom.querySelector('.cm-lineNumbers');
    if (!(gutter instanceof HTMLElement)) return;
    if (lineNumberLayer.parentElement !== gutter) {
      gutter.appendChild(lineNumberLayer);
    }

    const gutterRect = gutter.getBoundingClientRect();
    lineNumberLayer.style.left = '0';
    lineNumberLayer.style.width = `${gutterRect.width}px`;

    const activeRow = this.selectionAnchor?.row;
    let itemIndex = 0;
    for (const [rowIndex, row] of (Array.from(table.querySelectorAll('thead tr, tbody tr')) as HTMLTableRowElement[]).entries()) {
      const lineNumber = row.dataset.sourceLineNumber;
      if (!lineNumber) continue;
      const existingItem = lineNumberLayer.children.item(itemIndex);
      let item: HTMLElement;
      if (existingItem instanceof HTMLElement) {
        item = existingItem;
      } else {
        item = document.createElement('div');
        item.className = 'meo-md-html-table-line-number';
        lineNumberLayer.appendChild(item);
      }
      item.classList.toggle('is-active', rowIndex === activeRow);
      item.textContent = lineNumber;
      item.style.top = `${row.getBoundingClientRect().top - gutterRect.top}px`;
      itemIndex += 1;
    }
    while (lineNumberLayer.children.length > itemIndex) {
      lineNumberLayer.lastElementChild?.remove();
    }
  }

  updateStickyControls() {
    if (!this.domRefs || !this.view) return;
    const { shell, table } = this.domRefs;
    const scroller = this.view.scrollDOM;
    const controlsVisible = shell.classList.contains('is-interacting');
    if (!controlsVisible) {
      shell.classList.remove('is-controls-sticky');
      shell.style.removeProperty('--meo-html-table-sticky-top');
      shell.style.removeProperty('--meo-html-table-sticky-left');
      return;
    }

    const scrollerRect = scroller.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    const shouldStick = tableHasReachedStickyThreshold(tableRect, scrollerRect);
    shell.classList.toggle('is-controls-sticky', shouldStick);
    if (shouldStick) {
      shell.style.setProperty('--meo-html-table-sticky-top', `${Math.round(scrollerRect.top)}px`);
      shell.style.setProperty('--meo-html-table-sticky-left', `${Math.round(shellRect.left)}px`);
    } else {
      shell.style.removeProperty('--meo-html-table-sticky-top');
      shell.style.removeProperty('--meo-html-table-sticky-left');
    }
  }

  recalcLayout() {
    if (this.pendingResizeRows) {
      this.resizeAllRows();
    }
    this.syncTableLineNumbers();
    this.syncTableDiffMarkers();
    this.updateStickyControls();
    for (const task of Array.from(this.layoutTasks)) task();
  }

  syncTableDiffMarkers() {
    if (!this.domRefs) return;
    const { table, diffMarkerLayer } = this.domRefs;
    const gutter = this.view?.dom.querySelector('.meo-git-gutter');
    if (!(gutter instanceof HTMLElement)) return;
    if (diffMarkerLayer.parentElement !== gutter) gutter.appendChild(diffMarkerLayer);

    const gutterRect = gutter.getBoundingClientRect();
    diffMarkerLayer.style.left = '0';
    diffMarkerLayer.style.width = `${gutterRect.width}px`;
    let itemIndex = 0;
    for (const row of Array.from(table.querySelectorAll<HTMLTableRowElement>('thead tr, tbody tr'))) {
      const lineNumber = Number.parseInt(row.dataset.sourceLineNumber ?? '', 10);
      const flags = this.tableData.diffFlagsByLine?.[lineNumber];
      if (!flags || (!flags.added && !flags.modified && !flags.deleted)) continue;

      const existingItem = diffMarkerLayer.children.item(itemIndex);
      let item: HTMLElement;
      if (existingItem instanceof HTMLElement) {
        item = existingItem;
      } else {
        item = document.createElement('span');
        diffMarkerLayer.appendChild(item);
      }
      updateGitDiffMarkerElement(item, {
        ...flags,
        liveBlockStartLine: lineNumber,
        liveBlockEndLine: lineNumber
      }, 'meo-md-html-table-diff-marker');
      const rowRect = row.getBoundingClientRect();
      item.style.top = `${rowRect.top - gutterRect.top}px`;
      item.style.height = `${rowRect.height}px`;
      itemIndex += 1;
    }
    while (diffMarkerLayer.children.length > itemIndex) diffMarkerLayer.lastElementChild?.remove();
  }

  scheduleLayout({ resizeRows = false } = {}) {
    if (resizeRows) this.pendingResizeRows = true;
    if (this.layoutFrame) return;
    this.layoutFrame = requestAnimationFrame(() => {
      this.layoutFrame = 0;
      this.recalcLayout();
      this.pendingResizeRows = false;
    });
  }

  renderCellPreview(
    preview: HTMLElement,
    value: string,
    diagnostics: TableCellDiagnostics[] = [],
    sourceRange: TableCellRange | null = null
  ) {
    if (!(preview instanceof HTMLElement)) return;
    renderTableCellInlinePreview(
      preview,
      value ?? '',
      diagnostics,
      this.searchState,
      sourceRange,
      getImagePresentationFactory(this.view!.state)
    );
  }

  refreshCellPreviewFromInput(input: HTMLTextAreaElement) {
    if (!(input instanceof HTMLTextAreaElement)) return;
    const preview = input.parentElement?.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
    if (!preview) return;
    const coords = this.parseCellCoords(input.dataset.tableRow, input.dataset.tableCol);
    this.renderCellPreview(
      preview,
      tableCellEditorValueToSource(input.value),
      coords ? this.cellDiagnostics(coords.row, coords.col) : [],
      coords ? this.cellSourceRange(coords.row, coords.col) : null
    );
  }

  setCellEditingState(input: HTMLTextAreaElement, isEditing: boolean) {
    const content = input?.parentElement;
    if (!(content instanceof HTMLElement)) return;
    content.classList.toggle('is-editing', isEditing);
  }

  refreshAllCellPreviews() {
    if (!this.domRefs) return;
    for (let row = 0; row < this.domRefs.allRowInputs.length; row += 1) {
      const inputs = this.domRefs.allRowInputs[row];
      for (let col = 0; col < inputs.length; col += 1) {
        this.refreshCellPreviewFromInput(inputs[col]);
      }
    }
    this.stickyHeaderAdapter.update();
    this.scheduleLayout({ resizeRows: true });
  }

  refreshSearchSelectionCellPreviews(...searchStates: Array<TableSearchState | null>) {
    if (!this.domRefs) return;
    const selectionRanges = searchStates
      .map(tableSearchSelectionRange)
      .filter((range): range is TableCellRange => range !== null);
    if (selectionRanges.length === 0) return;

    let refreshedHeader = false;
    for (const inputs of this.domRefs.allRowInputs) {
      for (const input of inputs) {
        const coords = this.parseCellCoords(input.dataset.tableRow, input.dataset.tableCol);
        if (!coords) continue;
        const cellRange = this.cellSourceRange(coords.row, coords.col);
        if (selectionRanges.some((range) => tableSearchRangeOverlapsCell(range, cellRange))) {
          this.refreshCellPreviewFromInput(input);
          if (coords.row === 0) refreshedHeader = true;
        }
      }
    }
    if (refreshedHeader) {
      this.stickyHeaderAdapter.update();
      this.scheduleLayout();
    }
  }

  setSearchState(searchState: TableSearchState | null) {
    const previousSearchState = this.searchState;
    this.searchState = searchState?.text ? searchState : null;
    if (hasSameTableSearchQuery(previousSearchState, this.searchState)) {
      this.refreshSearchSelectionCellPreviews(previousSearchState, this.searchState);
      return;
    }
    this.refreshAllCellPreviews();
  }

  createCellPreview(
    value: string,
    diagnostics: TableCellDiagnostics[] = [],
    sourceRange: TableCellRange | null = null
  ) {
    const preview = document.createElement('div');
    preview.className = 'meo-md-html-table-cell-preview';
    preview.setAttribute('aria-hidden', 'true');
    this.renderCellPreview(preview, value, diagnostics, sourceRange);
    return preview;
  }

  cellSourceRange(rowIndex: number, colIndex: number): TableCellRange | null {
    return this.tableData.sourceRanges?.[rowIndex]?.[colIndex] ?? null;
  }

  createCellInput(value: string, rowIndex: number, colIndex: number) {
    const input = document.createElement('textarea');
    input.rows = 1;
    input.spellcheck = true;
    input.value = tableCellSourceToEditorValue(value);
    input.dataset.tableRow = String(rowIndex);
    input.dataset.tableCol = String(colIndex);
    const sourceRange = this.cellSourceRange(rowIndex, colIndex);
    if (sourceRange) {
      input.dataset.tableCellFrom = String(sourceRange.from);
      input.dataset.tableCellTo = String(sourceRange.to);
    }
    return input;
  }

  createCellEditor(value: string, rowEl: HTMLTableRowElement, rowInputs: HTMLTextAreaElement[], container: HTMLElement, rowIndex: number, colIndex: number, alignment: Exclude<TableAlignment, null> = 'left') {
    const content = document.createElement('div');
    content.className = 'meo-md-html-table-cell-content';
    const preview = this.createCellPreview(value, this.cellDiagnostics(rowIndex, colIndex), this.cellSourceRange(rowIndex, colIndex));
    const input = this.createCellInput(value, rowIndex, colIndex);
    content.style.textAlign = alignment;
    preview.style.textAlign = alignment;
    input.style.textAlign = alignment;
    this.wireInput(input, rowEl, rowInputs, container, rowIndex, colIndex, preview);
    content.append(preview, input);
    return { content, input };
  }

  createToolbarIcon(icon: TableToolbarIcon) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '18');
    svg.setAttribute('height', '18');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('class', `meo-md-html-table-toolbar-icon ${icon.className}`);

    for (const d of icon.paths) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', d);
      svg.appendChild(path);
    }

    return svg;
  }

  createToolbarButton(label: string, icon: TableToolbarIcon, onClick: () => void) {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = 'meo-visual-control-btn meo-md-html-table-toolbar-btn';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.appendChild(this.createToolbarIcon(icon));
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    return button;
  }

  createToolbarSeparator() {
    const separator = document.createElement('span');
    separator.className = 'meo-md-html-table-toolbar-separator';
    separator.setAttribute('aria-hidden', 'true');
    return separator;
  }

  createTableToolbar(container: HTMLElement) {
    const toolbar = document.createElement('div');
    toolbar.className = 'meo-visual-surface meo-md-html-table-toolbar';
    toolbar.setAttribute('aria-label', 'Table actions');

    const insertRowAbove = this.createToolbarButton('Insert row above', tableToolbarIcons.rowInsertTop, () => {
      this.requestInsertRowAbove(container);
    });
    const insertRowBelow = this.createToolbarButton('Insert row below', tableToolbarIcons.rowInsertBottom, () => {
      this.requestInsertRowBelow(container);
    });
    const deleteRow = this.createToolbarButton('Delete row', tableToolbarIcons.rowRemove, () => {
      this.requestDeleteRow(container);
    });
    const insertColumnLeft = this.createToolbarButton('Insert column left', tableToolbarIcons.columnInsertLeft, () => {
      this.requestInsertColumnLeft(container);
    });
    const insertColumnRight = this.createToolbarButton('Insert column right', tableToolbarIcons.columnInsertRight, () => {
      this.requestInsertColumnRight(container);
    });
    const deleteColumn = this.createToolbarButton('Delete column', tableToolbarIcons.columnRemove, () => {
      this.requestDeleteColumn(container);
    });
    const alignColumnLeft = this.createToolbarButton('Align selected column left', tableToolbarIcons.alignLeft, () => {
      this.requestColumnAlignment(container, 'left');
    });
    const alignColumnCenter = this.createToolbarButton('Align selected column center', tableToolbarIcons.alignCenter, () => {
      this.requestColumnAlignment(container, 'center');
    });
    const alignColumnRight = this.createToolbarButton('Align selected column right', tableToolbarIcons.alignRight, () => {
      this.requestColumnAlignment(container, 'right');
    });
    const rowSeparator = this.createToolbarSeparator();
    const columnSeparator = this.createToolbarSeparator();
    deleteRow.classList.add('meo-md-html-table-toolbar-delete-btn');
    deleteColumn.classList.add('meo-md-html-table-toolbar-delete-btn');

    toolbar.append(
      insertRowAbove,
      insertRowBelow,
      deleteRow,
      rowSeparator,
      insertColumnLeft,
      insertColumnRight,
      deleteColumn,
      columnSeparator,
      alignColumnLeft,
      alignColumnCenter,
      alignColumnRight
    );

    return {
      toolbar,
      buttons: {
        insertRowAbove,
        insertRowBelow,
        deleteRow,
        insertColumnLeft,
        insertColumnRight,
        deleteColumn,
        alignColumnLeft,
        alignColumnCenter,
        alignColumnRight
      }
    };
  }

  toDOM(view: EditorView) {
    this.view = view;
    const existingSearchState = (view.dom as any).__meoSearchState;
    if (existingSearchState && typeof existingSearchState === 'object') {
      this.searchState = existingSearchState.text ? existingSearchState : null;
    }
    const shell = document.createElement('div');
    shell.className = 'meo-md-html-table-shell';
    shell.style.setProperty('--meo-html-table-toolbar-height', `${tableToolbarHeight}px`);
    shell.style.setProperty('--meo-html-table-indent', `${tableCellIndentColumns(this.tableData.indent ?? '')}ch`);
    const wrap = document.createElement('div');
    wrap.className = 'meo-md-html-table-wrap';
    if (Number.isFinite(this.tableData.startLine)) {
      shell.dataset.meoRenderedBlockStartLine = String(this.tableData.startLine);
    }
    if (Number.isFinite(this.tableData.endLine)) {
      shell.dataset.meoRenderedBlockEndLine = String(this.tableData.endLine);
    }
    shell.dataset.meoRenderedBlockKind = 'table';
    const { toolbar, buttons: toolbarButtons } = this.createTableToolbar(wrap);

    const table = document.createElement('table');
    table.className = 'meo-md-html-table';
    table.tabIndex = -1;
    table.dataset.tableColumnWidth = 'true';
    if (Number.isFinite(this.tableData.from) && Number.isFinite(this.tableData.to)) {
      table.dataset.tableFrom = String(this.tableData.from);
      table.dataset.tableTo = String(this.tableData.to);
    }
    const colgroupElement = document.createElement('colgroup');
    const colgroup = Array.from({ length: this.tableData.colCount }, () => document.createElement('col'));
    colgroupElement.append(...colgroup);
    table.appendChild(colgroupElement);
    const rowEntries: RowEntry[] = [];
    const headerInputs: HTMLTextAreaElement[] = [];
    const cellGrid: HTMLTableCellElement[][] = [];
    const allRowInputs: HTMLTextAreaElement[][] = [];

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.dataset.sourceLineNumber = String(this.tableData.startLine ?? '');
    rowEntries.push({ row: headerRow, inputs: headerInputs });
    const headerCells: HTMLTableCellElement[] = [];
    const headerAlignmentOverrides = this.headerAlignmentOverrideColumns(view);
    for (let col = 0; col < this.tableData.colCount; col++) {
      const th = document.createElement('th');
      const headerAlignment = headerAlignmentOverrides?.has(col)
        ? this.tableData.alignments[col] ?? 'left'
        : 'center';
      th.dataset.tableRow = '0';
      th.dataset.tableCol = String(col);
      th.style.textAlign = headerAlignment;
      const { content, input } = this.createCellEditor(
        this.tableData.headerCells[col] ?? '',
        headerRow,
        headerInputs,
        wrap,
        0,
        col,
        headerAlignment
      );
      headerInputs.push(input);
      headerCells.push(th);
      th.appendChild(content);
      th.appendChild(this.createColumnResizeHandle(col));

      headerRow.appendChild(th);
    }
    cellGrid.push(headerCells);
    allRowInputs.push(headerInputs);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const bodyRowInputs: HTMLTextAreaElement[][] = [];
    for (let rowIdx = 0; rowIdx < this.tableData.rows.length; rowIdx++) {
      const tr = document.createElement('tr');
      tr.dataset.sourceLineNumber = String((this.tableData.startLine ?? 0) + rowIdx + 2);
      const inputs: HTMLTextAreaElement[] = [];
      rowEntries.push({ row: tr, inputs });
      const bodyCells: HTMLTableCellElement[] = [];
      const tableRowIndex = rowIdx + 1;
      for (let col = 0; col < this.tableData.colCount; col++) {
        const td = document.createElement('td');
        const columnAlignment = this.tableData.alignments[col] ?? 'left';
        td.dataset.tableRow = String(tableRowIndex);
        td.dataset.tableCol = String(col);
        td.style.textAlign = columnAlignment;
        const { content, input } = this.createCellEditor(
          this.tableData.rows[rowIdx][col] ?? '',
          tr,
          inputs,
          wrap,
          tableRowIndex,
          col,
          columnAlignment
        );
        inputs.push(input);
        bodyCells.push(td);
        td.appendChild(content);

        tr.appendChild(td);
      }
      cellGrid.push(bodyCells);
      allRowInputs.push(inputs);
      bodyRowInputs.push(inputs);
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const stickyChrome = document.createElement('div');
    stickyChrome.className = 'meo-md-html-table-sticky-chrome';
    stickyChrome.setAttribute('aria-hidden', 'true');
    const stickyToolbarBand = document.createElement('div');
    stickyToolbarBand.className = 'meo-md-html-table-sticky-toolbar-band';
    const stickyHeaderViewport = document.createElement('div');
    stickyHeaderViewport.className = 'meo-md-html-table-sticky-header';
    const stickyTable = document.createElement('table');
    stickyTable.className = 'meo-md-html-table meo-md-html-table-sticky-table';
    const stickyColgroupElement = document.createElement('colgroup');
    const stickyColgroup = Array.from({ length: this.tableData.colCount }, () => document.createElement('col'));
    stickyColgroupElement.append(...stickyColgroup);
    const stickyThead = document.createElement('thead');
    const stickyHeaderRow = document.createElement('tr');
    stickyThead.appendChild(stickyHeaderRow);
    stickyTable.append(stickyColgroupElement, stickyThead);
    stickyHeaderViewport.appendChild(stickyTable);
    stickyChrome.append(stickyToolbarBand, stickyHeaderViewport);

    const lineNumberLayer = document.createElement('div');
    lineNumberLayer.className = 'meo-md-html-table-line-numbers';
    const lineNumberGutter = view.dom.querySelector('.cm-lineNumbers');
    if (lineNumberGutter instanceof HTMLElement) {
      lineNumberGutter.appendChild(lineNumberLayer);
    }
    this.cleanupFns.push(() => lineNumberLayer.remove());
    const diffMarkerLayer = document.createElement('div');
    diffMarkerLayer.className = 'meo-md-html-table-diff-markers';
    const diffGutter = view.dom.querySelector('.meo-git-gutter');
    if (diffGutter instanceof HTMLElement) diffGutter.appendChild(diffMarkerLayer);
    this.cleanupFns.push(() => diffMarkerLayer.remove());
    wrap.append(table);
    shell.append(toolbar, wrap, stickyChrome);
    this.domRefs = {
      shell,
      wrap,
      table,
      tbody,
      container: shell,
      lineNumberLayer,
      diffMarkerLayer,
      rowEntries,
      headerInputs,
      rowInputs: bodyRowInputs,
      allRowInputs,
      cellGrid,
      sourceBodyRowInputs: bodyRowInputs,
      stickyChrome,
      stickyHeaderViewport,
      stickyTable,
      stickyHeaderRow,
      toolbarButtons
    };
    const tableCommandTarget: TableCommandEditorTarget = {
      view,
      identityKey: JSON.stringify({ indent: this.tableData.indent, header: this.tableData.headerCells }),
      from: this.tableData.from ?? 0,
      isConnected: () => Boolean(this.domRefs?.shell.isConnected),
      buildAtomicCommandTransaction: ({ command, target }) => this.buildTableCommandTransaction(command, target),
      preserveViewport: (run) => this.preserveTableCommandViewport(run)
    };
    this.tableCommandTargetRegistration = this.tableCommandEnvironment.registerTarget(tableCommandTarget);
    this.tableCommandTargetId = this.tableCommandTargetRegistration.id;
    this.stickyHeaderAdapter.mount();
    const onColumnWidthProjected = (event: Event) => {
      const resizeRows = !(
        event instanceof CustomEvent &&
        event.detail?.resizeRows === false
      );
      this.stickyHeaderAdapter.invalidate();
      this.scheduleLayout({ resizeRows });
    };
    table.addEventListener('meo-table-column-width-projected', onColumnWidthProjected);
    this.cleanupFns.push(() => {
      table.removeEventListener('meo-table-column-width-projected', onColumnWidthProjected);
    });
    this.updateActionTargetStyles();
    this.wireTableSelection(table);
    this.pendingResizeRows = true;
    this.scheduleLayout({ resizeRows: true });

    const onEditorScroll = () => this.stickyHeaderAdapter.invalidate();
    const onSearchStateChange = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      this.setSearchState(isTableSearchState(detail) ? detail : null);
    };
    view.scrollDOM.addEventListener('scroll', onEditorScroll);
    view.dom.addEventListener(tableSearchStateEventName, onSearchStateChange);
    this.cleanupFns.push(() => {
      view.scrollDOM.removeEventListener('scroll', onEditorScroll);
      view.dom.removeEventListener(tableSearchStateEventName, onSearchStateChange);
    });
    return shell;
  }

  ignoreEvent() {
    return true;
  }

  destroy(dom: HTMLElement) {
    this.setTableInteractionActive(dom, false);
    disposeImagePresentations(dom);
    this.tableCommandTargetRegistration?.dispose();
    this.tableCommandTargetRegistration = null;
    this.stickyHeaderAdapter.unmount();
    this.stickyHeaderAdapter.dispose();
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns = [];
    if (this.layoutFrame) {
      cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = 0;
    }
    this.layoutTasks.clear();
    this.domRefs = null;
    this.view = null;
    this.selectionAnchor = null;
    this.selectionRange = null;
    this.selectionPointerId = null;
    this.isDraggingSelection = false;
    this.hasPendingCellEdits = false;
    this.pendingCellEdits = [];
    this.pendingCellSwitchCommit = false;
  }
}

export function isTableDelimiterLine(lineText: string): boolean {
  return tableDelimiterRegex.test(lineText);
}

export function parseTableInfo(state: EditorState, tableNode: Pick<SyntaxNodeRef, 'from' | 'to'>) {
  const data = buildTableData(state, tableNode);
  const { from, to, lines, delimiterIdx, headerLine, dataLines, alignments, colCount, startLine, endLine } = data;

  const parseRow = (line: ParsedTableLine) => ({
    from: line.from,
    to: line.to,
    lineNo: line.lineNo,
    lineFrom: line.from,
    lineTo: line.to,
    cells: line.cells.map((content: string, index: number) => ({
      from: line.segments[index]?.from ?? line.from,
      to: line.segments[index]?.to ?? line.from,
      content
    }))
  });

  return {
    from,
    to,
    startLine,
    endLine,
    headerRow: headerLine ? parseRow(headerLine) : null,
    delimiterRow: delimiterIdx >= 0
      ? {
        from: lines[delimiterIdx].from,
        to: lines[delimiterIdx].to,
        lineNo: lines[delimiterIdx].lineNo,
        lineFrom: lines[delimiterIdx].from,
        lineTo: lines[delimiterIdx].to,
        alignments
      }
      : null,
    rows: dataLines.map(parseRow),
    columnCount: colCount
  };
}

export function addTableDecorations(
  builder: Range<Decoration>[],
  state: EditorState,
  tableNode: Pick<SyntaxNodeRef, 'from' | 'to'>,
  diagnostics: EditorDiagnostic[] = [],
  diffLineFlags: readonly (TableDiffFlags | undefined)[] | null | undefined = null
) {
  const data = buildTableData(state, tableNode);
  addTableWidgetDecoration(
    builder,
    data,
    state.facet(tableStickyHeaderAdapterFactoryFacet),
    state.facet(tableCommandEnvironmentFacet),
    diagnostics,
    diffLineFlags
  );
}

export function addTableDecorationsForLineRange(
  builder: Range<Decoration>[],
  state: EditorState,
  startLineNo: number,
  endLineNo: number,
  diagnostics: EditorDiagnostic[] = [],
  diffLineFlags: readonly (TableDiffFlags | undefined)[] | null | undefined = null
) {
  const data = buildTableDataForLineRange(state, startLineNo, endLineNo);
  addTableWidgetDecoration(
    builder,
    data,
    state.facet(tableStickyHeaderAdapterFactoryFacet),
    state.facet(tableCommandEnvironmentFacet),
    diagnostics,
    diffLineFlags
  );
}

function collectCellDiagnostics(
  diagnostics: EditorDiagnostic[],
  segment: { from: number; to: number } | undefined
): TableCellDiagnostics[] {
  if (!segment || !Array.isArray(diagnostics) || diagnostics.length === 0) {
    return [];
  }
  return diagnostics
    .filter((diagnostic) => diagnostic.from < segment.to && diagnostic.to > segment.from)
    .map((diagnostic) => ({
      from: Math.max(0, diagnostic.from - segment.from),
      to: Math.max(0, Math.min(diagnostic.to, segment.to) - segment.from),
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: diagnostic.source,
      code: diagnostic.code
    }))
    .filter((diagnostic) => diagnostic.to > diagnostic.from);
}

function collectTableDiagnostics(data: BuiltTableData, diagnostics: EditorDiagnostic[]): TableCellDiagnostics[][][] {
  const rows: TableCellDiagnostics[][][] = [];
  const { headerLine, dataLines, colCount } = data;
  if (!headerLine || colCount <= 0) {
    return rows;
  }

  const collectRow = (line: ParsedTableLine) => Array.from({ length: colCount }, (_value, index) => (
    collectCellDiagnostics(diagnostics, line.segments[index])
  ));

  rows.push(collectRow(headerLine));
  for (const line of dataLines) {
    rows.push(collectRow(line));
  }
  return rows;
}

function collectTableSourceRanges(data: BuiltTableData): TableCellRange[][] {
  const rows: TableCellRange[][] = [];
  const { headerLine, dataLines, colCount } = data;
  if (!headerLine || colCount <= 0) {
    return rows;
  }

  const collectRow = (line: ParsedTableLine) => Array.from({ length: colCount }, (_value, index) => {
    const segment = line.segments[index];
    return segment ? { from: segment.from, to: segment.to } : { from: line.from, to: line.from };
  });

  rows.push(collectRow(headerLine));
  for (const line of dataLines) {
    rows.push(collectRow(line));
  }
  return rows;
}

function mergeTableDiffRanges(
  left: Array<[number, number]> | undefined,
  right: Array<[number, number]> | undefined
): Array<[number, number]> | undefined {
  const ranges = [...(left ?? []), ...(right ?? [])];
  if (!ranges.length) return undefined;
  const seen = new Set<string>();
  return ranges.filter(([from, to]) => {
    const key = `${from}:${to}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectTableDiffFlags(
  data: BuiltTableData,
  diffLineFlags: readonly (TableDiffFlags | undefined)[] | null | undefined
): Record<number, TableDiffFlags> {
  if (!Array.isArray(diffLineFlags)) return {};
  const result: Record<number, TableDiffFlags> = {};
  const visibleLines = [data.headerLine, ...data.dataLines].filter((line): line is ParsedTableLine => line !== null);
  for (const line of visibleLines) {
    const flags = diffLineFlags[line.lineNo - 1];
    if (flags) result[line.lineNo] = { ...flags };
  }
  const delimiterLine = data.delimiterIdx >= 0 ? data.lines[data.delimiterIdx] : null;
  const delimiterFlags = delimiterLine ? diffLineFlags[delimiterLine.lineNo - 1] : null;
  if (delimiterFlags && data.headerLine) {
    const current = result[data.headerLine.lineNo] ?? {};
    result[data.headerLine.lineNo] = {
      ...current,
      ...delimiterFlags,
      added: current.added || delimiterFlags.added,
      modified: current.modified || delimiterFlags.modified,
      deleted: current.deleted || delimiterFlags.deleted,
      modifiedRanges: mergeTableDiffRanges(current.modifiedRanges, delimiterFlags.modifiedRanges),
      deletionRanges: mergeTableDiffRanges(current.deletionRanges, delimiterFlags.deletionRanges)
    };
  }

  return result;
}

function addTableWidgetDecoration(
  builder: Range<Decoration>[],
  data: BuiltTableData,
  stickyHeaderAdapterFactory: TableStickyHeaderAdapterFactory | null,
  tableCommandEnvironment: TableCommandEnvironment | null,
  diagnostics: EditorDiagnostic[] = [],
  diffLineFlags: readonly (TableDiffFlags | undefined)[] | null | undefined = null
) {
  const { from, to, headerLine, dataLines, alignments, colCount, startLine, endLine } = data;
  if (colCount === 0 || !headerLine) return;
  if (!stickyHeaderAdapterFactory) {
    throw new Error('Table Sticky Header Adapter factory is not configured');
  }
  if (!tableCommandEnvironment) {
    throw new Error('Table Command environment is not configured');
  }

  const indent = /^(\s*)/.exec(headerLine.text)?.[1] ?? '';
  const normalizedAlignments = normalizeRow(alignments, colCount, '').map((value) => value ?? null);
  const headerCells = normalizeRow(headerLine.cells, colCount, '');
  const rows = dataLines.map((line) => normalizeRow(line.cells, colCount, ''));
  const diffFlagsByLine = collectTableDiffFlags(data, diffLineFlags);
  const signature = JSON.stringify({
    colCount,
    headerCells,
    rows,
    normalizedAlignments,
    diagnostics: collectTableDiagnostics(data, diagnostics),
    diffFlagsByLine
  });

  builder.push(
    Decoration.replace({
      block: true,
      widget: new HtmlTableWidget(
        {
          from,
          to,
          indent,
          colCount,
          alignments: normalizedAlignments,
          headerCells,
          rows,
          signature,
          startLine,
          endLine,
          diagnostics: collectTableDiagnostics(data, diagnostics),
          sourceRanges: collectTableSourceRanges(data),
          diffFlagsByLine
        },
        stickyHeaderAdapterFactory,
        tableCommandEnvironment
      )
    }).range(from, to)
  );
}

function buildSourceTableHeaderDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree = syntaxTree(state);
  const parsedTableRanges: TableRange[] = [];
  const decoratedHeaderLines = new Set<number>();

  tree.iterate({
    enter(node: SyntaxNodeRef) {
      if (node.name !== 'Table') return;

      const data = buildTableData(state, node);
      if (!data.headerLine) return;
      parsedTableRanges.push({ from: data.from, to: data.to });

      addSourceHeaderLineDecorations(ranges, data.headerLine);
      decoratedHeaderLines.add(data.headerLine.lineNo);
    }
  });

  for (let lineNo = 2; lineNo <= state.doc.lines; lineNo += 1) {
    const delimiterLine = state.doc.line(lineNo);
    const delimiterText = state.doc.sliceString(delimiterLine.from, delimiterLine.to);
    if (!isTableDelimiterLine(delimiterText)) continue;

    const headerLineNo = lineNo - 1;
    if (decoratedHeaderLines.has(headerLineNo)) continue;
    const headerLine = state.doc.line(headerLineNo);
    const headerText = state.doc.sliceString(headerLine.from, headerLine.to);
    if (!isTableContentLine(headerText)) continue;
    if (overlapsParsedTableRange(headerLine.from, delimiterLine.to, parsedTableRanges)) continue;
    if (isPositionInsideCodeBlock(tree, headerLine.from)) continue;

    const parsedHeaderLine = parseTableLine(headerLineNo, headerLine.from, headerLine.to, headerText);
    addSourceHeaderLineDecorations(ranges, parsedHeaderLine);
    decoratedHeaderLines.add(headerLineNo);
  }

  return Decoration.set(ranges, true);
}

function addSourceHeaderLineDecorations(ranges: Range<Decoration>[], line: ParsedTableLine) {
  ranges.push(sourceTableHeaderLineDeco.range(line.from));
  for (const seg of line.segments) {
    ranges.push(sourceTableHeaderCellDeco.range(seg.from, seg.to));
  }
}

function overlapsParsedTableRange(from: number, to: number, ranges: readonly TableRange[]): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

function isPositionInsideCodeBlock(tree: Tree, pos: number): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
    node = node.parent;
  }
  return false;
}

export const sourceTableHeaderLineField = StateField.define<DecorationSet>({
  create(state) {
    try {
      return buildSourceTableHeaderDecorations(state);
    } catch {
      return Decoration.none;
    }
  },
  update(decorations, transaction) {
    if (!transaction.docChanged) {
      return decorations;
    }
    try {
      return buildSourceTableHeaderDecorations(transaction.state);
    } catch {
      return decorations;
    }
  },
  provide: (field) => EditorView.decorations.from(field)
});

export function insertTable(view: EditorView, selection: CodeMirrorSelectionRange, cols = 3, rows = 2) {
  const line = view.state.doc.lineAt(selection.from);
  const lineText = view.state.doc.sliceString(line.from, line.to);
  const leadingWhitespace = /^(\s*)/.exec(lineText)?.[1] ?? '';

  const headerCells = Array.from({ length: cols }, () => '  ').join('|');
  const separatorCells = Array.from({ length: cols }, () => ' --- ').join('|');
  const bodyRows = Array.from({ length: rows }, () => {
    const cells = Array.from({ length: cols }, () => '  ').join('|');
    return `${leadingWhitespace}|${cells}|`;
  }).join('\n');

  const table = `${leadingWhitespace}|${headerCells}|\n${leadingWhitespace}|${separatorCells}|\n${bodyRows}`;

  view.dispatch({
    changes: { from: line.from, to: line.to, insert: table },
    selection: { anchor: line.from + leadingWhitespace.length + 2 }
  });
}
