import { RangeSet, RangeValue, StateEffect, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { undo, redo } from '@codemirror/commands';
import { ImageWidget } from './images';
import { emojiData } from './emoji';
import { parseKbdTagAt } from './kbd';
import { createLatexMathElement, parseLatexMathAt } from './math';
import { isPrimaryModifierPointerClick } from './linkNavigation';
import { wikiLinkScheme } from './wikiLinks';
import { normalizeSourceHref } from './rawUrls';
import type { EditorDiagnostic } from './diagnostics';
import { continuedListMarker, listMarkerData, nextOrderedSequenceNumber } from './listMarkers';
import { getViewportController } from './viewportController';
import { createOpenLinkButton } from './linkOpenButton';
import { collectColorRangesFromText, createColorSwatchElement } from './colorSwatches';
import {
  createMissingLocalLinkIndicator,
  isMissingLocalLinkTarget
} from './localLinks';
import {
  appendInlineMappedText,
  resolveInlineCaretAtPoint,
  setInlineSourceRange
} from './inlinePresentation';
import { updateGitDiffMarkerElement } from './gitDiffMarkerDom';
import {
  createMarkDeletedTableRowsEffect,
  createMarkInsertedTableRowEffect,
  createRemapInsertedTableRowEffects,
  getInsertedTableRowsInRange
} from './tableRowDiffProvenance';

declare global {
  interface HTMLDivElement {
    _meoTableResizeObserver?: ResizeObserver;
  }
}

interface TableData {
  rows: string[][];
  alignments: string[];
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
  sourceBodyRows: HTMLTableRowElement[];
  sourceBodyRowInputs: HTMLTextAreaElement[][];
  sourceBodyCellGrid: HTMLTableCellElement[][];
  sortButton: HTMLButtonElement;
  applySortButton: HTMLButtonElement;
  stickyChrome: HTMLDivElement;
  stickyHeaderViewport: HTMLDivElement;
  stickyTable: HTMLTableElement;
  stickyColgroup: HTMLTableColElement[];
  stickyHeaderRow: HTMLTableRowElement;
  toolbarButtons: {
    insertRowAbove: HTMLButtonElement;
    insertRowBelow: HTMLButtonElement;
    deleteRow: HTMLButtonElement;
    insertColumnLeft: HTMLButtonElement;
    insertColumnRight: HTMLButtonElement;
    deleteColumn: HTMLButtonElement;
    sortColumn: HTMLButtonElement;
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
  alignments?: string[];
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
}

type TableSortDirection = 'asc' | 'desc';

interface TableSortState {
  column: number;
  direction: TableSortDirection;
  order: number[];
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
const tableDelimiterRegex = /^\|?\s*[:]?\-+[:]?\s*(\|\s*[:]?\-+[:]?\s*)*\|?$/;
const tableCellSelector = 'th[data-table-row][data-table-col], td[data-table-row][data-table-col]';
const tableControlSelector = '.meo-md-html-table-toolbar, .meo-md-html-table-toolbar-btn, .meo-md-html-apply-sort-btn, .meo-md-link-open-btn';
const tableToolbarHeight = 24;
const stickyHeaderSeparatorDepth = 3;
const minimumStickyTableViewportRatio = 0.5;
const tableSortCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

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
  sortNeutral: {
    className: 'icon-tabler-arrows-sort',
    paths: [
      'M7 7l5 -5l5 5',
      'M12 2v20',
      'M17 17l-5 5l-5 -5'
    ]
  },
  sortAsc: {
    className: 'icon-tabler-arrow-up',
    paths: [
      'M12 19v-14',
      'M5 12l7 -7l7 7'
    ]
  },
  sortDesc: {
    className: 'icon-tabler-arrow-down',
    paths: [
      'M12 5v14',
      'M19 12l-7 7l-7 -7'
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

function isTableControlTarget(target) {
  return target instanceof Element && target.closest(tableControlSelector);
}

function isSelectionMenuTarget(target) {
  return target instanceof Element && target.closest('.selection-inline-menu');
}

function targetElementFrom(target) {
  return target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
}

function isPrimaryModifier(event) {
  if (event.altKey) return false;
  return event.metaKey || event.ctrlKey;
}

function isModifierLinkActivationEvent(event) {
  return Boolean(getModifierLinkActivationHref(event));
}

function getModifierLinkActivationHref(event) {
  if (!isPrimaryModifierPointerClick(event)) return '';
  const target = targetElementFrom(event.target);
  if (!target) return '';
  const link = target.closest('[data-meo-link-href]');
  if (!(link instanceof Element)) return '';
  const href = link.getAttribute('data-meo-link-href');
  return href || '';
}

function isUndoShortcut(event) {
  return event.key.toLowerCase() === 'z' && !event.shiftKey;
}

function isRedoShortcut(event) {
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

function isTableInlineWhitespaceOnly(text) {
  return /^\s+$/.test(text);
}

function isTableInlineEscaped(text, index) {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return (slashCount % 2) === 1;
}

function isTableInlineAsciiAlnum(char) {
  return Boolean(char) && /[A-Za-z0-9]/.test(char);
}

function canOpenTableInlineDelimiter(text, index, marker) {
  if (isTableInlineEscaped(text, index)) return false;
  const markerLen = marker.length;
  const next = text[index + markerLen] ?? '';
  if (!next || /\s/.test(next)) return false;
  if (marker.includes('_') && isTableInlineAsciiAlnum(text[index - 1] ?? '')) return false;
  return true;
}

function canCloseTableInlineDelimiter(text, index, marker) {
  if (isTableInlineEscaped(text, index)) return false;
  const previous = text[index - 1] ?? '';
  if (!previous || /\s/.test(previous)) return false;
  if (marker.includes('_') && isTableInlineAsciiAlnum(text[index + marker.length] ?? '')) return false;
  return true;
}

function isTableInlineUrlLike(text) {
  return tableInlineRawUrlRe.test(text) || tableInlineSchemeRe.test(text);
}

function tableInlineHrefFromRawUrl(text) {
  return normalizeSourceHref(text);
}

function tableInlineHrefFromWikiTarget(target) {
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
      if (expected !== null && !isAnchor && marker.orderedNumber !== String(expected)) {
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

function decodeTableInlineEscapes(text) {
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

function findTableInlineMatchingBackticks(text, index, tickCount) {
  const marker = '`'.repeat(tickCount);
  for (let i = index; i <= text.length - tickCount; i += 1) {
    if (text.startsWith(marker, i)) return i;
  }
  return -1;
}

function parseTableInlineCodeSpan(text, index) {
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

function consumeTableInlineAngleSection(text, index) {
  if (text[index] !== '<' || isTableInlineEscaped(text, index)) return null;
  const close = text.indexOf('>', index + 1);
  if (close < 0) return null;
  return {
    content: text.slice(index + 1, close),
    nextIndex: close + 1
  };
}

function consumeTableInlineBracketContent(text, index) {
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

function consumeTableInlineParenContent(text, index) {
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

function parseTableInlineMarkdownLink(text, index, { image = false } = {}) {
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

function parseTableInlineWikiLink(text, index) {
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

function findTableInlineClosingMarker(text, startIndex, marker, { singleTilde = false } = {}) {
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

function parseTableInlineDelimitedSpan(text, index) {
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

function trimTableInlineRawUrl(raw, precedingChar) {
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

function parseTableInlineAutolink(text, index) {
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

function parseTableInlineRawUrl(text, index) {
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

function parseTableInlineEmojiShortcode(text, index) {
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

function appendTableInlinePreviewLink(parent, label, href, options: {
  baseOffset?: number;
  diagnostics?: TableCellDiagnostics[];
  searchState?: TableSearchState | null;
  sourceRange?: TableCellRange | null;
} = {}) {
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

function appendTableInlinePreviewImage(parent, altText, url, sourceRange: TableCellRange) {
  if (!url) {
    appendInlineMappedText(parent, `![${altText}]()`, sourceRange);
    return;
  }
  // Table cells own pointer selection so image clicks enter the cell editor on
  // pointerup instead of being consumed by the standalone image interaction.
  const dom = new ImageWidget(url, decodeTableInlineEscapes(altText), '', null, {
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
} = {}) {
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
        { from: baseOffset + i, to: baseOffset + image.nextIndex }
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
  sourceRange: TableCellRange | null
) {
  const listStack: Array<{ indentColumns: number; type: 'ul' | 'ol'; list: HTMLUListElement | HTMLOListElement; lastItem: HTMLLIElement | null }> = [];
  const appendInline = (parent: HTMLElement, content: string, baseOffset: number) => {
    appendTableInlinePreviewNodes(parent, content, { baseOffset, diagnostics, searchState, sourceRange });
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
  previewEl,
  value,
  diagnostics: TableCellDiagnostics[] = [],
  searchState: TableSearchState | null = null,
  sourceRange: TableCellRange | null = null
) {
  if (!(previewEl instanceof HTMLElement)) return;
  previewEl.replaceChildren();
  const text = value ?? '';
  const isSearchExpanded = shouldExpandTableCellForSearch(text, searchState);
  previewEl.classList.toggle('is-search-expanded', isSearchExpanded);
  previewEl.parentElement?.classList.toggle('has-search-match', isSearchExpanded);
  if (isSearchExpanded) {
    appendTableCellSourcePreview(previewEl, text, diagnostics, searchState, sourceRange);
    return;
  }
  appendTableCellRenderedPreview(previewEl, text, diagnostics, searchState, sourceRange);
}

function consumeTableInlineProtectedSpan(text, index, endIndex) {
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

function findTableRowSeparatorPipes(text, startIndex, endIndex) {
  const pipes = [];
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

function parseTableRowCells(lineText, lineFrom = 0) {
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

  const cells = [];
  if (innerStart < innerEnd || innerPipes.length > 0) {
    let cursor = innerStart;
    for (const pipeIndex of innerPipes) {
      cells.push(lineText.slice(cursor, pipeIndex).trim());
      cursor = pipeIndex + 1;
    }
    cells.push(lineText.slice(cursor, innerEnd).trim());
  }

  const segments = [];
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

function normalizeRow(cells, colCount) {
  const result = cells.slice(0, colCount);
  while (result.length < colCount) result.push('');
  return result;
}

function isValidTableRange(from, to, docLength) {
  return (
    Number.isInteger(from) &&
    Number.isInteger(to) &&
    from >= 0 &&
    from < to &&
    to <= docLength
  );
}

function parseDelimiterAlignments(lineText) {
  const alignments = [];
  const parts = lineText.split('|').filter((part) => part.trim());
  for (const part of parts) {
    const value = part.trim();
    const left = value.startsWith(':');
    const right = value.endsWith(':');
    alignments.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return alignments;
}

function delimiterCellForAlignment(alignment) {
  if (alignment === 'left') return ':---';
  if (alignment === 'right') return '---:';
  if (alignment === 'center') return ':---:';
  return '---';
}

function serializeTableMarkdown(indent, headerCells, alignments, rows) {
  const colCount = headerCells.length;
  const normalizedAlignments = normalizeRow(alignments, colCount).map((value) => value ?? null);
  const normalizedRows = rows.map((row) => normalizeRow(row, colCount));
  const header = `| ${headerCells.join(' | ')} |`;
  const delimiter = `| ${normalizedAlignments.map(delimiterCellForAlignment).join(' | ')} |`;
  const dataRows = normalizedRows.map((row) => `| ${row.join(' | ')} |`);
  return [header, delimiter, ...dataRows].map((line) => `${indent}${line}`).join('\n');
}

function parseTableSortNumber(value) {
  const normalized = value.replace(/,/g, '').replace(/%$/, '').trim();
  if (!/^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(normalized)) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseTableSortDate(value) {
  const normalized = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/.test(normalized)) {
    return null;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareTableSortValues(leftValue, rightValue, direction: TableSortDirection) {
  const left = `${leftValue ?? ''}`.trim();
  const right = `${rightValue ?? ''}`.trim();
  const leftEmpty = left.length === 0;
  const rightEmpty = right.length === 0;
  if (leftEmpty || rightEmpty) {
    if (leftEmpty && rightEmpty) return 0;
    return leftEmpty ? 1 : -1;
  }

  const leftNumber = parseTableSortNumber(left);
  const rightNumber = parseTableSortNumber(right);
  let comparison = 0;
  if (leftNumber !== null && rightNumber !== null) {
    comparison = leftNumber - rightNumber;
  } else {
    const leftDate = parseTableSortDate(left);
    const rightDate = parseTableSortDate(right);
    comparison = leftDate !== null && rightDate !== null
      ? leftDate - rightDate
      : tableSortCollator.compare(left, right);
  }

  if (comparison === 0) return 0;
  return direction === 'desc' ? -comparison : comparison;
}

function parseTableLine(lineNo, from, to, text) {
  const { cells, pipes, segments } = parseTableRowCells(text, from);
  return { lineNo, from, to, text, cells, pipes, segments };
}

function isTableContentLine(lineText) {
  return lineText.includes('|');
}

function buildTableData(state, tableNode) {
  const startLine = state.doc.lineAt(tableNode.from);
  const endLine = state.doc.lineAt(Math.max(tableNode.to - 1, tableNode.from));
  return buildTableDataForLineRange(state, startLine.number, endLine.number);
}

function buildTableDataForLineRange(state, startLineNo, endLineNo) {
  const startLine = state.doc.line(startLineNo);
  const endLine = state.doc.line(endLineNo);
  const lines = [];
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
  tableData: TableData;
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
  sortState: TableSortState | null;
  activeTarget: TableActionTarget;
  searchState: TableSearchState | null;

  constructor(tableData: TableData) {
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
    this.sortState = null;
    this.activeTarget = { row: this.tableData.rows.length > 0 ? 1 : 0, col: 0 };
    this.searchState = null;
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
    );
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
      let node = syntaxTree(view.state).resolveInner(pos, 1);
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
      this.tableData.colCount
    );

    const rows = rowInputs.map((inputs) => normalizeRow(
      inputs.map((input) => tableCellEditorValueToSource(input.value).trim()),
      this.tableData.colCount
    ));

    return { headerCells, rows, alignments: this.tableData.alignments };
  }

  sourceRowOrder() {
    return this.tableData.rows.map((_row, index) => index);
  }

  sortedRowOrder(column, direction: TableSortDirection) {
    return this.sourceRowOrder().sort((leftIndex, rightIndex) => {
      const leftRow = this.tableData.rows[leftIndex] ?? [];
      const rightRow = this.tableData.rows[rightIndex] ?? [];
      const comparison = compareTableSortValues(leftRow[column], rightRow[column], direction);
      return comparison || leftIndex - rightIndex;
    });
  }

  updateBodyRowDatasets(rowInputs, cellGrid) {
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

  setVisualRowOrder(order) {
    if (!this.domRefs) return;
    const {
      tbody,
      sourceBodyRows,
      sourceBodyRowInputs,
      sourceBodyCellGrid,
      headerInputs,
      cellGrid,
      rowEntries
    } = this.domRefs;
    const normalizedOrder = order.filter((index) => sourceBodyRows[index]);
    const nextRows = normalizedOrder.map((index) => sourceBodyRows[index]);
    const nextRowInputs = normalizedOrder.map((index) => sourceBodyRowInputs[index]);
    const nextCellGrid = normalizedOrder.map((index) => sourceBodyCellGrid[index]);

    for (const row of nextRows) {
      tbody.appendChild(row);
    }

    this.updateBodyRowDatasets(nextRowInputs, nextCellGrid);
    this.domRefs.rowInputs = nextRowInputs;
    this.domRefs.allRowInputs = [headerInputs, ...nextRowInputs];
    this.domRefs.cellGrid = [cellGrid[0], ...nextCellGrid];
    this.domRefs.rowEntries = [
      rowEntries[0],
      ...nextRows.map((row, index) => ({ row, inputs: nextRowInputs[index] }))
    ];
    this.clearSelection();
    this.updateActionTargetStyles();
    this.scheduleLayout({ resizeRows: true });
  }

  updateSortControls() {
    if (!this.domRefs) return;
    const { shell, sortButton, applySortButton } = this.domRefs;
    const activeColumn = this.activeColumnIndex();
    const active = activeColumn !== null && this.sortState?.column === activeColumn;
    sortButton.classList.toggle('is-active', active);
    sortButton.dataset.sortDirection = active ? this.sortState.direction : '';
    this.setSortButtonIcon(sortButton, active ? this.sortState.direction : null);
    sortButton.title = active
      ? `Sorted ${this.sortState.direction === 'desc' ? 'descending' : 'ascending'}; click to toggle`
      : 'Sort selected column descending';
    sortButton.setAttribute('aria-label', sortButton.title);
    sortButton.setAttribute('aria-pressed', active ? 'true' : 'false');
    applySortButton.hidden = !this.sortState;
    shell.classList.toggle('has-active-sort', Boolean(this.sortState));
  }

  setSortButtonIcon(button: HTMLButtonElement, direction: TableSortDirection | null) {
    const icon = direction === 'asc'
      ? tableToolbarIcons.sortAsc
      : direction === 'desc'
        ? tableToolbarIcons.sortDesc
        : tableToolbarIcons.sortNeutral;
    const svg = this.createToolbarIcon(icon);
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.classList.add('meo-md-html-sort-icon');
    button.replaceChildren(svg);
  }

  clearVisualSort() {
    if (!this.sortState) return;
    this.sortState = null;
    this.setVisualRowOrder(this.sourceRowOrder());
    this.updateSortControls();
  }

  activeBodyRowIndex() {
    if (this.tableData.rows.length === 0) return null;
    if (this.activeTarget.row <= 0) return null;
    const visualIndex = this.activeTarget.row - 1;
    if (this.sortState?.order) {
      const sourceIndex = this.sortState.order[visualIndex];
      return Number.isInteger(sourceIndex) ? sourceIndex : null;
    }
    return visualIndex >= 0 && visualIndex < this.tableData.rows.length ? visualIndex : null;
  }

  activeColumnIndex() {
    const colCount = this.tableData.colCount;
    if (colCount <= 0) return null;
    return Math.min(Math.max(this.activeTarget.col, 0), colCount - 1);
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
    toolbarButtons.sortColumn.disabled = !hasColumnTarget || this.tableData.rows.length <= 1;
    toolbarButtons.alignColumnLeft.disabled = !hasColumnTarget;
    toolbarButtons.alignColumnCenter.disabled = !hasColumnTarget;
    toolbarButtons.alignColumnRight.disabled = !hasColumnTarget;
  }

  updateActionTargetStyles() {
    this.updateToolbarState();
    this.updateSortControls();
  }

  setActionTarget(target) {
    const row = Math.min(Math.max(target.row ?? 0, 0), this.tableData.rows.length);
    const col = Math.min(Math.max(target.col ?? 0, 0), Math.max(0, this.tableData.colCount - 1));
    this.activeTarget = { row, col };
    this.updateActionTargetStyles();
    this.syncTableLineNumbers();
  }

  insertRowAboveTarget(container) {
    const rowIndex = this.activeBodyRowIndex();
    if (rowIndex === null) {
      this.addRowAfter(container, -1);
      return;
    }
    this.addRowBefore(container, rowIndex);
  }

  insertRowBelowTarget(container) {
    const rowIndex = this.activeBodyRowIndex();
    this.addRowAfter(container, rowIndex ?? -1);
  }

  deleteTargetRow(container) {
    const selectedRange = this.selectionRange;
    if (!selectedRange || this.selectedCellCount() <= 1) {
      const rowIndex = this.activeBodyRowIndex();
      if (rowIndex !== null) this.removeRowsAt(container, [rowIndex]);
      return;
    }

    const visualRows = [];
    for (let row = Math.max(1, selectedRange.fromRow); row <= selectedRange.toRow; row += 1) {
      const visualIndex = row - 1;
      const sourceIndex = this.sortState?.order?.[visualIndex] ?? visualIndex;
      if (sourceIndex >= 0 && sourceIndex < this.tableData.rows.length) visualRows.push(sourceIndex);
    }
    this.removeRowsAt(container, visualRows);
  }

  insertColumnLeftTarget(container) {
    const colIndex = this.activeColumnIndex();
    if (colIndex === null) return;
    this.addColumnBefore(container, colIndex);
  }

  insertColumnRightTarget(container) {
    const colIndex = this.activeColumnIndex();
    if (colIndex === null) return;
    this.addColumnAfter(container, colIndex);
  }

  deleteTargetColumn(container) {
    const selectedRange = this.selectionRange;
    if (!selectedRange || this.selectedCellCount() <= 1) {
      const colIndex = this.activeColumnIndex();
      if (colIndex !== null) this.removeColumnsAt(container, [colIndex]);
      return;
    }

    const columns = [];
    for (let col = selectedRange.fromCol; col <= selectedRange.toCol; col += 1) {
      if (col >= 0 && col < this.tableData.colCount) columns.push(col);
    }
    this.removeColumnsAt(container, columns);
  }

  sortByColumn(container, column) {
    if (!this.domRefs || this.tableData.rows.length <= 1) return;
    if (this.hasPendingCellEdits) {
      this.commit(container);
      if (!this.domRefs) return;
    }
    const direction: TableSortDirection = this.sortState?.column === column && this.sortState.direction === 'desc'
      ? 'asc'
      : 'desc';
    const order = this.sortedRowOrder(column, direction);
    this.sortState = { column, direction, order };
    this.setVisualRowOrder(order);
    this.updateSortControls();
    this.setTableInteractionActive(container, true);
  }

  setColumnAlignment(container, alignment) {
    const column = this.activeColumnIndex();
    if (column === null) return;
    this.markHeaderAlignmentOverride(container, column, alignment);
    this.clearVisualSort();
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return;
    const alignments = normalizeRow(this.tableData.alignments, matrix.headerCells.length).map((value) => value ?? null);
    alignments[column] = alignment;
    matrix.alignments = alignments;
    this.commitMatrix(matrix, container, { row: this.activeTarget.row, col: column });
  }

  headerAlignmentOverrideColumns(view: EditorView) {
    const from = this.tableData.from;
    const to = this.tableData.to;
    if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
    const overrides = view.state.field(tableHeaderAlignmentOverrideField, false);
    let columns: ReadonlySet<number> | null = null;
    overrides?.between(from as number, to as number, (rangeFrom, rangeTo, value) => {
      if (rangeFrom === from && rangeTo === to) columns = value.columns;
    });
    return columns;
  }

  markHeaderAlignmentOverride(container, column, alignment) {
    const view = this.getEditorView(container);
    if (!view) return;
    const range = this.resolveCurrentTableRange(view, container);
    if (!range) return;
    view.dispatch({ effects: setTableHeaderAlignmentOverrideEffect.of({ ...range, column }) });

    const headerCell = this.domRefs?.cellGrid[0]?.[column];
    if (!headerCell) return;
    headerCell.style.textAlign = alignment;
    for (const element of Array.from(headerCell.querySelectorAll('.meo-md-html-table-cell-content, .meo-md-html-table-cell-preview, textarea')) as HTMLElement[]) {
      element.style.textAlign = alignment;
    }
    this.refreshStickyHeaderContent();
    this.scheduleLayout();
  }

  applyCurrentSort(container) {
    if (!this.sortState) return;
    this.commitMatrix(this.readCellMatrix(), container, null, {
      preserveScrollPosition: true,
      sourceRowOrder: this.sortState.order
    });
    this.sortState = null;
    this.updateSortControls();
  }

  parseCellCoords(rowText, colText) {
    const row = Number.parseInt(rowText ?? '', 10);
    const col = Number.parseInt(colText ?? '', 10);
    if (Number.isNaN(row) || Number.isNaN(col)) return null;
    return { row, col };
  }

  findCellElement(node) {
    if (!this.domRefs || !(node instanceof Element)) return null;
    const cell = node.closest(tableCellSelector);
    if (!cell || !this.domRefs.table.contains(cell)) return null;
    return cell;
  }

  coordsFromCell(cell) {
    return this.parseCellCoords(cell.dataset.tableRow, cell.dataset.tableCol);
  }

  focusTableInput(input, caret = null, { scrollCellIntoView = true } = {}) {
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

  focusCellInput(cell, { updateSelection = false, caret = null } = {}) {
    const input = cell.querySelector('textarea');
    if (!this.focusTableInput(input, caret)) return false;
    if (!updateSelection) return true;
    const coords = this.coordsFromCell(cell);
    if (coords) {
      this.setSingleCellSelection(coords);
    }
    return true;
  }

  pointerCaretForCell(cell, clientX, clientY, { nearestFallback = true } = {}) {
    const input = cell.querySelector('textarea');
    const preview = cell.querySelector('.meo-md-html-table-cell-preview');
    if (!(input instanceof HTMLTextAreaElement) || !(preview instanceof HTMLElement)) {
      return { domCaret: null, editorOffset: null };
    }

    const previousInputPointerEvents = input.style.pointerEvents;
    const previousPreviewVisibility = preview.style.visibility;
    let resolution = { domCaret: null, sourceOffset: null };
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

  focusCellInputAt(row, col, caret = null) {
    const input = this.domRefs?.allRowInputs?.[row]?.[col];
    return this.focusTableInput(input, caret);
  }

  moveVerticalOutOfTable(container, direction, preferredColumn = 0) {
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

    this.commit(container);
    this.exitTableInteraction(container);
    view.dispatch({
      selection: { anchor: targetPos },
      effects: EditorView.scrollIntoView(targetPos, { y: 'nearest' })
    });
    view.focus();
    return true;
  }

  normalizeSelectionRange(a, b) {
    return {
      fromRow: Math.min(a.row, b.row),
      toRow: Math.max(a.row, b.row),
      fromCol: Math.min(a.col, b.col),
      toCol: Math.max(a.col, b.col)
    };
  }

  isCellSelected(row, col, range) {
    if (!range) return false;
    return row >= range.fromRow && row <= range.toRow && col >= range.fromCol && col <= range.toCol;
  }

  applySelection(range) {
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
        const isTopEdge = styledSelected && row === range.fromRow;
        const isRightEdge = styledSelected && col === range.toCol;
        const isBottomEdge = styledSelected && row === range.toRow;
        const isLeftEdge = styledSelected && col === range.fromCol;
        cell.classList.toggle('meo-md-html-table-cell-selected', styledSelected);
        cell.classList.toggle('meo-md-html-table-cell-selected-top', isTopEdge);
        cell.classList.toggle('meo-md-html-table-cell-selected-right', isRightEdge);
        cell.classList.toggle('meo-md-html-table-cell-selected-bottom', isBottomEdge);
        cell.classList.toggle('meo-md-html-table-cell-selected-left', isLeftEdge);
      }
    }
  }

  setSingleCellSelection(coords) {
    this.selectionAnchor = coords;
    this.setActionTarget(coords);
    this.applySelection(this.normalizeSelectionRange(coords, coords));
  }

  clearSelection() {
    this.selectionAnchor = null;
    this.applySelection(null);
    this.syncTableLineNumbers();
  }

  exitTableInteraction(container) {
    const shell = container?.closest?.('.meo-md-html-table-shell');
    if (shell instanceof HTMLElement) {
      shell.classList.remove('has-active-sort');
    }
    this.setTableInteractionActive(container, false);
    this.clearSelection();
  }

  setTableInteractionActive(container, active) {
    const shell = container?.closest?.('.meo-md-html-table-shell');
    if (shell instanceof HTMLElement) {
      shell.classList.toggle('is-interacting', active);
    }
    this.updateStickyControls();
    this.updateStickyHeader();
    const view = this.getEditorView(container);
    if (!view) return;
    view.dom.dispatchEvent(new CustomEvent('meo-table-interaction', { detail: { active, owner: shell } }));
  }

  emitTableSelectionChange(container) {
    const view = this.getEditorView(container);
    if (!view) return;
    view.dom.dispatchEvent(new CustomEvent('meo-table-selection-change'));
  }

  hasFocusedTableInput(container) {
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

  handleHistoryShortcut(event, table) {
    if (!isPrimaryModifier(event) || (!isUndoShortcut(event) && !isRedoShortcut(event))) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    const wrap = this.domRefs?.wrap ?? table;
    const view = this.getEditorView(wrap);
    if (!view) return true;
    const applyHistory = () => {
      this.commit(wrap);
      if (isUndoShortcut(event)) undo(view);
      else redo(view);
    };
    const controller = getViewportController(view);
    if (controller) controller.preserveScrollPosition(applyHistory);
    else applyHistory();
    return true;
  }

  wireTableSelection(table) {
    const getWrap = () => this.domRefs?.wrap ?? table;
    const getContainer = () => this.domRefs?.container ?? getWrap();
    let pendingOutsidePointerId: number | null = null;
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

    const onPointerDown = (event) => {
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

    const onPointerMove = (event) => {
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
    };

    const endPointerSelection = (event) => {
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
      if (shouldEnterTextEditing) {
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

    const onCopy = (event) => {
      if (this.selectedCellCount() <= 1) return;
      const text = this.selectedTextAsTsv();
      if (!text) return;
      event.preventDefault();
      event.clipboardData?.setData('text/plain', text);
    };

    const onDragStart = (event: DragEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.meo-md-html-table-cell-preview')) return;
      event.preventDefault();
    };

    const onKeyDown = (event) => {
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
            this.hasPendingCellEdits = true;
          }
        }
      }
      this.scheduleLayout({ resizeRows: true });
    };

    const onFocusOut = (event) => {
      const nextTarget = event.relatedTarget;
      const wrap = this.domRefs?.wrap ?? table;
      const container = this.domRefs?.container ?? wrap;
      if (nextTarget instanceof Node && container.contains(nextTarget)) return;
      this.commit(wrap);
      this.exitTableInteraction(wrap);
    };

    const onDocumentPointerDown = (event) => {
      if (!(event.target instanceof Node)) return;
      const wrap = getWrap();
      const container = getContainer();
      if (isSelectionMenuTarget(event.target)) {
        return;
      }
      const isOutsideTable = !container.contains(event.target);
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
    table.addEventListener('copy', onCopy);
    table.addEventListener('dragstart', onDragStart);
    table.addEventListener('keydown', onKeyDown, true);
    table.addEventListener('focusout', onFocusOut);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('pointermove', onDocumentPointerMove, true);
    document.addEventListener('pointerup', onDocumentPointerEnd, true);
    document.addEventListener('pointercancel', onDocumentPointerEnd, true);
    const onCommitTableEdits = (event) => {
      const hadPendingEdits = this.hasPendingCellEdits;
      this.commit(getWrap());
      if (event instanceof CustomEvent && event.detail && typeof event.detail === 'object') {
        event.detail.committed = Boolean(event.detail.committed || hadPendingEdits);
      }
    };
    document.addEventListener('meo-commit-table-edits', onCommitTableEdits);
    this.cleanupFns.push(() => {
      table.removeEventListener('pointerdown', onPointerDown);
      table.removeEventListener('pointermove', onPointerMove);
      table.removeEventListener('pointerup', endPointerSelection);
      table.removeEventListener('pointercancel', endPointerSelection);
      table.removeEventListener('lostpointercapture', endPointerSelection);
      table.removeEventListener('copy', onCopy);
      table.removeEventListener('dragstart', onDragStart);
      table.removeEventListener('keydown', onKeyDown, true);
      table.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('pointermove', onDocumentPointerMove, true);
      document.removeEventListener('pointerup', onDocumentPointerEnd, true);
      document.removeEventListener('pointercancel', onDocumentPointerEnd, true);
      document.removeEventListener('meo-commit-table-edits', onCommitTableEdits);
      pendingOutsidePointerId = null;
      if (outsidePointerExitTimer !== null) {
        window.clearTimeout(outsidePointerExitTimer);
        outsidePointerExitTimer = null;
      }
    });
  }

  commit(dom) {
    if (!this.hasPendingCellEdits) return;
    const view = this.getEditorView(dom);
    if (!view) return;
    const changes = this.collectPendingCellSourceChanges(view);
    if (changes.length) view.dispatch({ changes });
    this.hasPendingCellEdits = false;
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
      input.setSelectionRange(0, 0);
      input.closest(tableCellSelector)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      return true;
    };

    requestAnimationFrame(() => {
      if (!focusCell()) {
        setTimeout(focusCell, 0);
      }
    });
  }

  commitMatrix(
    matrix,
    dom,
    focusTarget: PendingCellFocus | null = null,
    {
      preserveScrollPosition = false,
      sourceRowOrder = null
    }: { preserveScrollPosition?: boolean; sourceRowOrder?: number[] | null } = {}
  ) {
    const view = this.getEditorView(dom);
    if (!view) return;

    const { headerCells, rows, alignments = this.tableData.alignments } = matrix;
    if (!headerCells.length) return;
    const range = this.resolveCurrentTableRange(view, dom);
    if (!range) return;
    const tableStartLine = view.state.doc.lineAt(range.from).number;
    const markdown = serializeTableMarkdown(this.tableData.indent, headerCells, alignments, rows);
    const current = view.state.doc.sliceString(range.from, range.to);
    if (current === markdown) {
      this.hasPendingCellEdits = false;
      if (focusTarget) {
        this.focusCellInputAt(focusTarget.row, focusTarget.col, 0);
      }
      return;
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
    const trackedRowMappings = getInsertedTableRowsInRange(view.state, range.from, range.to)
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
      .filter((mapping): mapping is { id: number; oldOffset: number; newOffset: number } => mapping !== null);
    const effects = createRemapInsertedTableRowEffects(view.state, range.from, trackedRowMappings);
    const applyCommit = () => view.dispatch({
      changes: { from: range.from, to: range.to, insert: markdown },
      effects
    });
    const controller = preserveScrollPosition ? getViewportController(view) : null;
    if (controller) controller.preserveScrollPosition(applyCommit);
    else applyCommit();
    this.hasPendingCellEdits = false;
    if (focusTarget) {
      this.scheduleFocusCellAfterCommit(view, tableStartLine, focusTarget);
    }
  }

  addRowAfter(dom, rowIndex) {
    this.clearVisualSort();
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return;
    const insertAt = Math.min(Math.max(rowIndex + 1, 0), matrix.rows.length);
    if (this.insertSourceRowAt(dom, insertAt, matrix.headerCells.length)) return;
    matrix.rows.splice(insertAt, 0, new Array(matrix.headerCells.length).fill(''));
    const sourceRowOrder = matrix.rows.map((_row, index) => (
      index < insertAt ? index : index === insertAt ? -1 : index - 1
    ));
    this.commitMatrix(
      matrix,
      dom,
      { row: insertAt + 1, col: this.activeColumnIndex() ?? 0 },
      { sourceRowOrder }
    );
  }

  addRowBefore(dom, rowIndex) {
    this.clearVisualSort();
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return;
    const insertAt = Math.min(Math.max(rowIndex, 0), matrix.rows.length);
    if (this.insertSourceRowAt(dom, insertAt, matrix.headerCells.length)) return;
    matrix.rows.splice(insertAt, 0, new Array(matrix.headerCells.length).fill(''));
    const sourceRowOrder = matrix.rows.map((_row, index) => (
      index < insertAt ? index : index === insertAt ? -1 : index - 1
    ));
    this.commitMatrix(
      matrix,
      dom,
      { row: insertAt + 1, col: this.activeColumnIndex() ?? 0 },
      { sourceRowOrder }
    );
  }

  insertSourceRowAt(dom, insertAt: number, colCount: number) {
    const view = this.getEditorView(dom);
    if (!view || colCount <= 0) return false;
    const range = this.resolveCurrentTableRange(view, dom);
    if (!range) return false;

    const tableStartLine = view.state.doc.lineAt(range.from).number;
    const blankRow = `${this.tableData.indent}| ${new Array(colCount).fill('').join(' | ')} |`;
    const changes = this.collectPendingCellSourceChanges(view);
    let insertedRowEffect: ReturnType<typeof createMarkInsertedTableRowEffect>;
    if (insertAt < this.tableData.rows.length) {
      const line = view.state.doc.line(tableStartLine + 2 + insertAt);
      changes.push({ from: line.from, to: line.from, insert: `${blankRow}\n` });
      insertedRowEffect = createMarkInsertedTableRowEffect(view.state, line.from, -1);
    } else {
      const previousLine = view.state.doc.line(tableStartLine + 1 + this.tableData.rows.length);
      changes.push({ from: previousLine.to, to: previousLine.to, insert: `\n${blankRow}` });
      insertedRowEffect = createMarkInsertedTableRowEffect(view.state, previousLine.to, -1, 1);
    }
    changes.sort((left, right) => left.from - right.from || left.to - right.to);
    view.dispatch({ changes, effects: insertedRowEffect });
    this.hasPendingCellEdits = false;
    this.scheduleFocusCellAfterCommit(
      view,
      tableStartLine,
      { row: insertAt + 1, col: this.activeColumnIndex() ?? 0 }
    );
    return true;
  }

  removeRowAt(dom, rowIndex) {
    this.removeRowsAt(dom, [rowIndex]);
  }

  removeRowsAt(dom, rowIndexes: number[]) {
    const uniqueIndexes = [...new Set(rowIndexes)].sort((left, right) => right - left);
    if (!uniqueIndexes.length) return;
    this.clearVisualSort();
    const matrix = this.readCellMatrix();
    const validIndexes = uniqueIndexes.filter((index) => index >= 0 && index < matrix.rows.length);
    if (!validIndexes.length) return;
    const firstRemoved = Math.min(...validIndexes);
    if (validIndexes.length < matrix.rows.length) {
      const focusRow = Math.min(firstRemoved, matrix.rows.length - validIndexes.length - 1) + 1;
      if (this.removeSourceRowsAt(
        dom,
        validIndexes,
        { row: focusRow, col: this.activeColumnIndex() ?? 0 }
      )) {
        return;
      }
    }
    for (const index of validIndexes) matrix.rows.splice(index, 1);
    if (matrix.rows.length === 0) {
      matrix.rows.push(new Array(matrix.headerCells.length).fill(''));
    }
    const focusRow = Math.min(firstRemoved, matrix.rows.length - 1) + 1;
    const sourceRowOrder = this.tableData.rows
      .map((_row, index) => index)
      .filter((index) => !validIndexes.includes(index));
    this.commitMatrix(
      matrix,
      dom,
      { row: focusRow, col: this.activeColumnIndex() ?? 0 },
      { sourceRowOrder }
    );
  }

  removeSourceRowsAt(
    dom,
    rowIndexes: number[],
    focusTarget: PendingCellFocus
  ) {
    const view = this.getEditorView(dom);
    if (!view) return false;
    const range = this.resolveCurrentTableRange(view, dom);
    if (!range) return false;

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
      return [createMarkDeletedTableRowsEffect(
        view.state,
        anchor,
        deletionAtEnd ? -1 : 1,
        baselineRanges,
        deletionAtEnd
      )];
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
    view.dispatch({ changes, effects: deletionEffects });
    this.hasPendingCellEdits = false;
    this.scheduleFocusCellAfterCommit(view, tableStartLine, focusTarget);
    return true;
  }

  addColumnAfter(dom, colIndex) {
    this.clearVisualSort();
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return;
    const insertAt = Math.min(Math.max(colIndex + 1, 0), matrix.headerCells.length);
    matrix.headerCells.splice(insertAt, 0, '');
    matrix.rows = matrix.rows.map((row) => {
      const next = row.slice();
      next.splice(insertAt, 0, '');
      return next;
    });
    const alignments = normalizeRow(this.tableData.alignments, matrix.headerCells.length - 1).map((value) => value ?? null);
    alignments.splice(insertAt, 0, null);
    matrix.alignments = alignments;
    this.commitMatrix(matrix, dom, { row: this.activeTarget.row, col: insertAt });
  }

  addColumnBefore(dom, colIndex) {
    this.clearVisualSort();
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return;
    const insertAt = Math.min(Math.max(colIndex, 0), matrix.headerCells.length);
    matrix.headerCells.splice(insertAt, 0, '');
    matrix.rows = matrix.rows.map((row) => {
      const next = row.slice();
      next.splice(insertAt, 0, '');
      return next;
    });
    const alignments = normalizeRow(this.tableData.alignments, matrix.headerCells.length - 1).map((value) => value ?? null);
    alignments.splice(insertAt, 0, null);
    matrix.alignments = alignments;
    this.commitMatrix(matrix, dom, { row: this.activeTarget.row, col: insertAt });
  }

  removeColumnAt(dom, colIndex) {
    this.removeColumnsAt(dom, [colIndex]);
  }

  removeColumnsAt(dom, columnIndexes: number[]) {
    const uniqueIndexes = [...new Set(columnIndexes)].sort((left, right) => right - left);
    if (!uniqueIndexes.length) return;
    this.clearVisualSort();
    const matrix = this.readCellMatrix();
    const validIndexes = uniqueIndexes.filter((index) => index >= 0 && index < matrix.headerCells.length);
    if (!validIndexes.length) return;
    const firstRemoved = Math.min(...validIndexes);
    for (const index of validIndexes) matrix.headerCells.splice(index, 1);
    matrix.rows = matrix.rows.map((row) => {
      const next = row.slice();
      for (const index of validIndexes) next.splice(index, 1);
      return next;
    });
    const alignments = normalizeRow(this.tableData.alignments, matrix.headerCells.length + validIndexes.length).map((value) => value ?? null);
    for (const index of validIndexes) alignments.splice(index, 1);
    if (matrix.headerCells.length === 0) {
      matrix.headerCells.push('');
      matrix.rows = matrix.rows.map(() => ['']);
      alignments.push(null);
    }
    matrix.alignments = alignments;
    const focusCol = Math.min(firstRemoved, matrix.headerCells.length - 1);
    this.commitMatrix(matrix, dom, { row: this.activeTarget.row, col: focusCol });
  }

  cellDiagnostics(rowIndex, colIndex): TableCellDiagnostics[] {
    return this.tableData.diagnostics?.[rowIndex]?.[colIndex] ?? [];
  }

  wireInput(input, rowEl, rowInputs, container, rowIndex, colIndex, preview) {
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
    const onArrowVertical = (event, direction) => {
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
      this.hasPendingCellEdits = true;
      const hadSearchMatch = input.parentElement?.classList.contains('has-search-match') ?? false;
      const sourceValue = tableCellEditorValueToSource(input.value);
      if (this.searchState && (hadSearchMatch || shouldExpandTableCellForSearch(sourceValue, this.searchState))) {
        refreshPreview();
      }
      // Non-search previews stay untouched while editing so inline image DOM is not recreated.
      this.resizeRow(rowEl, rowInputs);
      if (rowIndex === 0) this.refreshStickyHeaderContent();
      this.scheduleLayout();
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
            this.addRowAfter(container, rowIndex - 1);
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
      this.clearVisualSort();
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
      if (nextTarget instanceof Node && container.contains(nextTarget)) return;
      this.setTableInteractionActive(container, false);
      this.commit(container);
    });
  }

  resizeRow(row, rowInputs = null) {
    if (!row) return;
    const textareas = rowInputs ?? Array.from(row.querySelectorAll('textarea'));
    const contents = Array.from(row.querySelectorAll('.meo-md-html-table-cell-content')) as HTMLElement[];
    if (textareas.length === 0 || contents.length === 0) return;

    let maxHeight = 0;
    for (let index = 0; index < textareas.length; index += 1) {
      const textarea = textareas[index];
      const content = contents[index];
      const preview = content?.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
      textarea.style.height = 'auto';
      if (content) content.style.minHeight = '';
      maxHeight = Math.max(maxHeight, textarea.scrollHeight, preview?.scrollHeight ?? 0);
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

  refreshStickyHeaderContent() {
    if (!this.domRefs) return;
    const { table, headerInputs, stickyHeaderRow } = this.domRefs;
    const sourceCells = Array.from(table.tHead?.rows[0]?.cells ?? []);
    const nextCells = sourceCells.map((sourceCell, column) => {
      const cell = document.createElement('th');
      cell.style.textAlign = sourceCell.style.textAlign;
      const preview = document.createElement('div');
      preview.className = 'meo-md-html-table-cell-preview';
      renderTableCellInlinePreview(
        preview,
        tableCellEditorValueToSource(headerInputs[column]?.value ?? ''),
        this.cellDiagnostics(0, column),
        this.searchState,
        this.cellSourceRange(0, column)
      );
      for (const interactive of Array.from(preview.querySelectorAll('button, textarea, input, select'))) {
        interactive.remove();
      }
      for (const link of Array.from(preview.querySelectorAll('a[href]'))) {
        link.removeAttribute('href');
        link.removeAttribute('tabindex');
      }
      cell.appendChild(preview);
      return cell;
    });
    stickyHeaderRow.replaceChildren(...nextCells);
  }

  hideStickyHeader() {
    if (!this.domRefs) return;
    const { stickyChrome } = this.domRefs;
    stickyChrome.classList.remove('is-visible', 'has-sticky-controls');
    stickyChrome.style.removeProperty('top');
    stickyChrome.style.removeProperty('left');
    stickyChrome.style.removeProperty('width');
    stickyChrome.style.removeProperty('height');
  }

  updateStickyHeader() {
    if (!this.domRefs || !this.view) return;
    const {
      shell,
      table,
      tbody,
      stickyChrome,
      stickyHeaderViewport,
      stickyTable,
      stickyColgroup
    } = this.domRefs;
    const headerRow = table.tHead?.rows[0];
    const bodyRows = tbody.rows;
    if (!headerRow || bodyRows.length === 0) {
      this.hideStickyHeader();
      return;
    }

    const scrollerRect = this.view.scrollDOM.getBoundingClientRect();
    const tableRect = table.getBoundingClientRect();
    const headerRect = headerRow.getBoundingClientRect();
    const controlsSticky = shell.classList.contains('is-controls-sticky');
    const controlsVisible = controlsSticky && (
      shell.matches(':focus-within') ||
      shell.classList.contains('is-interacting') ||
      shell.classList.contains('has-active-sort')
    );
    const controlsHeight = controlsVisible ? tableToolbarHeight : 0;
    const stickyHeaderTop = scrollerRect.top + controlsHeight;
    const tableNeedsStickyHeader = tableRect.height >= scrollerRect.height * minimumStickyTableViewportRatio;
    const reachedStickyThreshold = tableHasReachedStickyThreshold(tableRect, scrollerRect);
    const enoughContentRemains = tableRect.bottom >= stickyHeaderTop + headerRect.height + stickyHeaderSeparatorDepth;
    const visibleLeft = Math.max(tableRect.left, scrollerRect.left);
    const visibleRight = Math.min(tableRect.right, scrollerRect.right);
    const visibleWidth = Math.max(0, visibleRight - visibleLeft);

    if (!tableNeedsStickyHeader || !reachedStickyThreshold || !enoughContentRemains || visibleWidth <= 0) {
      this.hideStickyHeader();
      return;
    }

    stickyChrome.classList.add('is-visible');
    stickyChrome.classList.toggle('has-sticky-controls', controlsVisible);
    stickyChrome.style.top = `${Math.round(scrollerRect.top)}px`;
    stickyChrome.style.left = `${Math.round(visibleLeft)}px`;
    stickyChrome.style.width = `${Math.round(visibleWidth)}px`;
    stickyChrome.style.height = `${Math.ceil(controlsHeight + headerRect.height + stickyHeaderSeparatorDepth)}px`;
    stickyHeaderViewport.style.height = `${Math.ceil(headerRect.height)}px`;
    stickyTable.style.width = `${tableRect.width}px`;
    stickyTable.style.transform = `translateX(${tableRect.left - visibleLeft}px)`;

    const sourceCells = Array.from(headerRow.cells);
    for (let index = 0; index < stickyColgroup.length; index += 1) {
      const width = sourceCells[index]?.getBoundingClientRect().width ?? 0;
      stickyColgroup[index].style.width = `${width}px`;
    }
  }

  updateStickyControls() {
    if (!this.domRefs || !this.view) return;
    const { shell, table } = this.domRefs;
    const scroller = this.view.scrollDOM;
    const controlsVisible = shell.classList.contains('is-interacting') || shell.classList.contains('has-active-sort');
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
    this.updateStickyHeader();
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
    preview,
    value,
    diagnostics: TableCellDiagnostics[] = [],
    sourceRange: TableCellRange | null = null
  ) {
    if (!(preview instanceof HTMLElement)) return;
    renderTableCellInlinePreview(preview, value ?? '', diagnostics, this.searchState, sourceRange);
  }

  refreshCellPreviewFromInput(input) {
    if (!(input instanceof HTMLTextAreaElement)) return;
    const preview = input.parentElement?.querySelector('.meo-md-html-table-cell-preview');
    const coords = this.parseCellCoords(input.dataset.tableRow, input.dataset.tableCol);
    this.renderCellPreview(
      preview,
      tableCellEditorValueToSource(input.value),
      coords ? this.cellDiagnostics(coords.row, coords.col) : [],
      coords ? this.cellSourceRange(coords.row, coords.col) : null
    );
  }

  setCellEditingState(input, isEditing) {
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
    this.refreshStickyHeaderContent();
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
      this.refreshStickyHeaderContent();
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
    value,
    diagnostics: TableCellDiagnostics[] = [],
    sourceRange: TableCellRange | null = null
  ) {
    const preview = document.createElement('div');
    preview.className = 'meo-md-html-table-cell-preview';
    preview.setAttribute('aria-hidden', 'true');
    this.renderCellPreview(preview, value, diagnostics, sourceRange);
    return preview;
  }

  cellSourceRange(rowIndex, colIndex): TableCellRange | null {
    return this.tableData.sourceRanges?.[rowIndex]?.[colIndex] ?? null;
  }

  createCellInput(value, rowIndex, colIndex) {
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

  createCellEditor(value, rowEl, rowInputs, container, rowIndex, colIndex, alignment = 'left') {
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

  createToolbarButton(label, icon: TableToolbarIcon, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = 'meo-md-html-table-toolbar-btn';
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

  createTableToolbar(container) {
    const toolbar = document.createElement('div');
    toolbar.className = 'meo-md-html-table-toolbar';
    toolbar.setAttribute('aria-label', 'Table actions');

    const insertRowAbove = this.createToolbarButton('Insert row above', tableToolbarIcons.rowInsertTop, () => {
      this.insertRowAboveTarget(container);
    });
    const insertRowBelow = this.createToolbarButton('Insert row below', tableToolbarIcons.rowInsertBottom, () => {
      this.insertRowBelowTarget(container);
    });
    const deleteRow = this.createToolbarButton('Delete row', tableToolbarIcons.rowRemove, () => {
      this.deleteTargetRow(container);
    });
    const insertColumnLeft = this.createToolbarButton('Insert column left', tableToolbarIcons.columnInsertLeft, () => {
      this.insertColumnLeftTarget(container);
    });
    const insertColumnRight = this.createToolbarButton('Insert column right', tableToolbarIcons.columnInsertRight, () => {
      this.insertColumnRightTarget(container);
    });
    const deleteColumn = this.createToolbarButton('Delete column', tableToolbarIcons.columnRemove, () => {
      this.deleteTargetColumn(container);
    });
    const sortColumn = this.createToolbarButton('Sort selected column', tableToolbarIcons.sortNeutral, () => {
      const column = this.activeColumnIndex();
      if (column !== null) this.sortByColumn(container, column);
    });
    const alignColumnLeft = this.createToolbarButton('Align selected column left', tableToolbarIcons.alignLeft, () => {
      this.setColumnAlignment(container, 'left');
    });
    const alignColumnCenter = this.createToolbarButton('Align selected column center', tableToolbarIcons.alignCenter, () => {
      this.setColumnAlignment(container, 'center');
    });
    const alignColumnRight = this.createToolbarButton('Align selected column right', tableToolbarIcons.alignRight, () => {
      this.setColumnAlignment(container, 'right');
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
      alignColumnRight,
      sortColumn
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
        sortColumn,
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

    const applySortButton = document.createElement('button');
    applySortButton.type = 'button';
    applySortButton.tabIndex = -1;
    applySortButton.className = 'meo-md-html-apply-sort-btn';
    applySortButton.textContent = 'Apply Sort';
    applySortButton.title = 'Apply current sort to markdown';
    applySortButton.hidden = true;
    applySortButton.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.applyCurrentSort(wrap);
    });
    applySortButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    const table = document.createElement('table');
    table.className = 'meo-md-html-table';
    const rowEntries = [];
    const headerInputs = [];
    const cellGrid = [];
    const allRowInputs = [];

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    headerRow.dataset.sourceLineNumber = String(this.tableData.startLine ?? '');
    rowEntries.push({ row: headerRow, inputs: headerInputs });
    const headerCells = [];
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

      headerRow.appendChild(th);
    }
    cellGrid.push(headerCells);
    allRowInputs.push(headerInputs);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const bodyRowInputs = [];
    const sourceBodyRows = [];
    const sourceBodyCellGrid = [];
    for (let rowIdx = 0; rowIdx < this.tableData.rows.length; rowIdx++) {
      const tr = document.createElement('tr');
      tr.dataset.sourceLineNumber = String((this.tableData.startLine ?? 0) + rowIdx + 2);
      const inputs = [];
      rowEntries.push({ row: tr, inputs });
      const bodyCells = [];
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
      sourceBodyRows.push(tr);
      sourceBodyCellGrid.push(bodyCells);
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
    shell.append(toolbar, wrap, applySortButton, stickyChrome);
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
      sourceBodyRows,
      sourceBodyRowInputs: bodyRowInputs,
      sourceBodyCellGrid,
      sortButton: toolbarButtons.sortColumn,
      applySortButton,
      stickyChrome,
      stickyHeaderViewport,
      stickyTable,
      stickyColgroup,
      stickyHeaderRow,
      toolbarButtons
    };
    this.refreshStickyHeaderContent();
    this.updateActionTargetStyles();
    this.wireTableSelection(table);
    this.pendingResizeRows = true;
    this.scheduleLayout({ resizeRows: true });

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => {
        this.scheduleLayout({ resizeRows: true });
      });
      observer.observe(wrap);
      wrap._meoTableResizeObserver = observer;
    }
    const onEditorScroll = () => this.scheduleLayout();
    const onSearchStateChange = (event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      this.setSearchState(detail && typeof detail === 'object' ? detail : null);
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

  destroy(dom) {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns = [];
    dom?._meoTableResizeObserver?.disconnect();
    if (this.layoutFrame) {
      cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = 0;
    }
    this.domRefs = null;
    this.view = null;
    this.selectionAnchor = null;
    this.selectionRange = null;
    this.selectionPointerId = null;
    this.isDraggingSelection = false;
    this.hasPendingCellEdits = false;
    this.sortState = null;
  }
}

export function isTableDelimiterLine(lineText) {
  return tableDelimiterRegex.test(lineText);
}

export function parseTableInfo(state, tableNode) {
  const data = buildTableData(state, tableNode);
  const { from, to, lines, delimiterIdx, headerLine, dataLines, alignments, colCount, startLine, endLine } = data;

  const parseRow = (line) => ({
    from: line.from,
    to: line.to,
    lineNo: line.lineNo,
    lineFrom: line.from,
    lineTo: line.to,
    cells: line.cells.map((content, index) => ({
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

export function addTableDecorations(builder, state, tableNode, diagnostics: EditorDiagnostic[] = [], diffLineFlags = null) {
  const data = buildTableData(state, tableNode);
  addTableWidgetDecoration(builder, data, diagnostics, diffLineFlags);
}

export function addTableDecorationsForLineRange(builder, state, startLineNo, endLineNo, diagnostics: EditorDiagnostic[] = [], diffLineFlags = null) {
  const data = buildTableDataForLineRange(state, startLineNo, endLineNo);
  addTableWidgetDecoration(builder, data, diagnostics, diffLineFlags);
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

function collectTableDiagnostics(data, diagnostics: EditorDiagnostic[]): TableCellDiagnostics[][][] {
  const rows = [];
  const { headerLine, dataLines, colCount } = data;
  if (!headerLine || colCount <= 0) {
    return rows;
  }

  const collectRow = (line) => Array.from({ length: colCount }, (_value, index) => (
    collectCellDiagnostics(diagnostics, line.segments[index])
  ));

  rows.push(collectRow(headerLine));
  for (const line of dataLines) {
    rows.push(collectRow(line));
  }
  return rows;
}

function collectTableSourceRanges(data): TableCellRange[][] {
  const rows = [];
  const { headerLine, dataLines, colCount } = data;
  if (!headerLine || colCount <= 0) {
    return rows;
  }

  const collectRow = (line) => Array.from({ length: colCount }, (_value, index) => {
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

function collectTableDiffFlags(data, diffLineFlags): Record<number, TableDiffFlags> {
  if (!Array.isArray(diffLineFlags)) return {};
  const result: Record<number, TableDiffFlags> = {};
  const visibleLines = [data.headerLine, ...data.dataLines].filter(Boolean);
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

function addTableWidgetDecoration(builder, data, diagnostics: EditorDiagnostic[] = [], diffLineFlags = null) {
  const { from, to, headerLine, dataLines, alignments, colCount, startLine, endLine } = data;
  if (colCount === 0 || !headerLine) return;

  const indent = /^(\s*)/.exec(headerLine.text)?.[1] ?? '';
  const normalizedAlignments = normalizeRow(alignments, colCount).map((value) => value ?? null);
  const headerCells = normalizeRow(headerLine.cells, colCount);
  const rows = dataLines.map((line) => normalizeRow(line.cells, colCount));
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
        }
      )
    }).range(from, to)
  );
}

function buildSourceTableHeaderDecorations(state) {
  const ranges = [];
  const tree = syntaxTree(state);
  const parsedTableRanges = [];
  const decoratedHeaderLines = new Set();

  tree.iterate({
    enter(node) {
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

function addSourceHeaderLineDecorations(ranges, line) {
  ranges.push(sourceTableHeaderLineDeco.range(line.from));
  for (const seg of line.segments) {
    ranges.push(sourceTableHeaderCellDeco.range(seg.from, seg.to));
  }
}

function overlapsParsedTableRange(from, to, ranges) {
  return ranges.some((range) => from < range.to && to > range.from);
}

function isPositionInsideCodeBlock(tree, pos) {
  let node = tree.resolveInner(pos, 1);
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
    node = node.parent;
  }
  return false;
}

export const sourceTableHeaderLineField = StateField.define({
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

export function insertTable(view, selection, cols = 3, rows = 2) {
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
