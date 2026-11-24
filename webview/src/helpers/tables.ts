import { editorScrollIntoView } from '../editor/scrollEffects';
import { webviewShortcutPlatform } from './shortcuts';
import { isMarkdownTableDelimiter } from '../../../src/shared/markdownContentRules';
import { markdownTaskContentPrefix } from '../../../src/foundation/markdownTaskList';
import { readMarkdownListPrefix } from '../../../src/foundation/markdownListPrefix';
import { tableHeaderFitsStickyViewport } from '../editor/tableStickyHeaderPolicy';
import { createTableColumnResizeHandle } from '../editor/tableColumnResizeHandle';
import { createTableRowWindow, type TableRowWindow } from '../editor/tableRowWindow';
import { mapLiveWidgetPositions } from '../editor/liveWidgetPositions';
import { markLiveInputNestedProjection, usesLargeDocumentDerivedWorkBudget } from '../editor/liveInputDerivedWork';
import { renderedBlockPreviewHeight, RenderedBlockPreviewHeight } from './renderedBlockPreview';
import { matchInlineScript } from '../../../src/foundation/inlineScript';
import { markdownTableSeparatorPipes } from '../../../src/foundation/markdownTableRow';
import { expandTableShortcutSnippet, type SourceCellSnippetEdit } from '../editor/shortcutSnippet';
import { matchInlineHtmlCode } from '../../../src/shared/htmlPolicy';
import { latexDelimitersFacet } from '../editor/mathSyntaxPreference';
import { parseTableInlineSyntax } from './inlineMarkdownParser';
import { wireNativeSymbolInput, nativeSymbolInput } from '../editor/nativeTypingAssistance';
import { automaticSymbolPairs, symbolOriginEpoch, replaceAutomaticSymbolPairArea, inputAssistanceFacet, type AutomaticSymbolPair } from '../editor/typingAssistance';
import { markdownTableFromCells, serializeDelimitedTable, parseMarkdownTable, externalTableCellToMarkdown } from '../application/delimitedTable';
import { defaultInputAssistance, type EditorCommandId } from '../../../src/foundation/editingPreferences';
import { countColumn, findClusterBreak, ChangeSet, EditorState, Facet, RangeSet, RangeValue, StateEffect, StateField, Transaction, Text as CodeMirrorText, type ChangeDesc, type ChangeSpec, type Range } from '@codemirror/state';
import { ensureSyntaxTree, indentUnit, syntaxTree } from '@codemirror/language';
import { deleteMarkupBackward, markdownLanguage } from '@codemirror/lang-markdown';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { formatSourceLineNumber, sourceLineNumberModeFacet } from '../editor/sourceLineNumbers';
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common';
import { isolateHistory } from '@codemirror/commands';
import { disposeImagePresentations, ImageWidget } from './images';
import {
  getImagePresentationFactory,
  type ImagePresentationFactory
} from '../editor/imagePresentation';
import { parseKbdTagAt } from './kbd';
import { AlertIconWidget } from './alerts';
import { readMarkdownAlertDirective } from '../../../src/foundation/markdownAlert';
import { parseFootnotes } from './footnotes';
import { createLatexMathElement, parseLatexMathAt } from './math';
import { hrefFromMarkdownReference, isPrimaryModifierPointerClick, markdownReferenceTargetSignature } from './linkNavigation';
import { wikiLinkScheme } from './wikiLinks';
import { isWikiImageTarget, parseWikiReference, wikiImageSrc } from '../../../src/foundation/wikiReference';
import { normalizeExplicitSourceHref, normalizeSourceHref } from './rawUrls';
import type { EditorDiagnostic } from './diagnostics';
import {
  handleBackspaceAtListContentStart,
  handleEnterInList,
  listMarkerData,
  listMarkerDataInContainerLine,
  selectionEditsListMarker,
  nextOrderedSequenceNumber,
  orderedListRenumberTransactionFilter
} from './listMarkers';
import { getViewportController, visualLineContextMargin } from './viewportController';
import { nativeInputViewportReference } from '../editor/nativeInputViewport';
import { commitObservedEditorSize, flushEditorLayout } from '../editor/layoutMeasurement';
import { editorViewportBounds } from '../editor/editorViewportBounds';
import { preserveTableColumnResizeLayout } from './tableColumnResizeViewport';
import { changedDocumentRange, runEditorHistoryCommand } from './historyCommands';
import { createOpenLinkButton } from './linkOpenButton';
import { MARKDOWN_TAG_PATTERN, collectHexColorRangesFromText, isHexColorLikeLiteral } from '../../../src/shared/hexColorSwatches';
import { createColorSwatchElement, createInteractiveColorSwatchElement } from './colorSwatches';
import {
  createMissingLocalLinkIndicator,
  isMissingLocalLinkTarget
} from './localLinks';
import {
  appendInlineMappedText,
  inlineSourceSelectionRanges,
  resolveInlineCaretAtPoint,
  inlineSourceRuns,
  readInlineSourceRange,
  setInlineSourceRange,
  type InlineCaretResolution,
  type InlineDomCaret
} from './inlinePresentation';
import { TableTextSelectionPaint } from './tableTextSelectionPaint';
import { inlineSourceContains, inlineSourceTarget, type InlineEditRange } from './inlineSourceEditing';
import { updateGitDiffMarkerElement } from './gitDiffMarkerDom';
import { gitDiffLineFlagsFacet } from './gitDiffPresentation';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import { createTextSearch } from '../application/searchCaseFolding';
import { getTableHistoryFocus, type TableHistoryFocusTarget } from '../adapters/tableHistoryFocus';
import {
  getTableTransactionProvenance,
  getTableTransactionProvenanceSnapshot,
  type CodeMirrorTableProvenanceIntent
} from '../adapters/tableTransactionProvenance';
import { currentSyntaxTree, syntaxTreeChanged } from './markdownSyntax';
import {
  applyLiveBlockIndent,
  getLiveBlockIndent,
  parseBlockLinePrefix,
  liveBlockIndentCssValue,
  liveBlockIndentKey,
  type LiveBlockIndentValue
} from './blockIndent';
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
import { tableShortcutCommands, type TableCommand, type TableCommandTarget } from '../application/tableCommand';
import {
  createTableCellCommitConfirmation,
  createTableCellInteraction,
  executeTableCellCommitBoundary,
  type TableCellCommitConfirmation,
  type TableCellEditIntent,
  type TableCellInteraction
} from '../editor/tableCellInteraction';
import {
  TableCellSelection,
  type TableCellCopyInline,
  type TableCellCopyValue,
  type TableCellSelectionTransition,
  type TableCellRange as TableSelectionRange
} from '../editor/tableCellSelection';
import {
  meoTableClipboardMime,
  parseHtmlTableClipboard,
  parseMeoTableClipboard,
  parseTsvTableClipboard,
  type TableClipboardMatrix
} from '../editor/tableClipboard';
import { estimateBlockWidgetHeight, estimateTableLayout } from '../editor/blockWidgetHeight';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowDownAZ,
  ArrowDownZA,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Columns2,
  EllipsisVertical,
  Pencil,
  Plus,
  Rows2,
  Trash2,
  X,
  createElement,
  type IconNode
} from 'lucide';

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
  diffMarkerLayer: HTMLElement;
  cellGrid: HTMLTableCellElement[][];
  rowEntries: RowEntry[];
  sourceBodyRowInputs: HTMLTextAreaElement[][];
  stickyChrome: HTMLDivElement;
  stickyShadow: HTMLDivElement;
  stickyHeaderViewport: HTMLDivElement;
  stickyTable: HTMLTableElement;
  stickyHeaderRow: HTMLTableRowElement;
  contextTrigger: HTMLButtonElement;
  contextMenu: HTMLDivElement;
  contextPages: Record<TableContextPage, HTMLDivElement>;
  contextButtons: {
    collapse: HTMLButtonElement;
    collapseArrangement: HTMLButtonElement;
    previousPage: HTMLButtonElement;
    nextPage: HTMLButtonElement;
    insertRowAbove: HTMLButtonElement;
    insertRowBelow: HTMLButtonElement;
    moveRowUp: HTMLButtonElement;
    moveRowDown: HTMLButtonElement;
    deleteRow: HTMLButtonElement;
    insertColumnLeft: HTMLButtonElement;
    insertColumnRight: HTMLButtonElement;
    moveColumnLeft: HTMLButtonElement;
    moveColumnRight: HTMLButtonElement;
    deleteColumn: HTMLButtonElement;
    deleteTable: HTMLButtonElement;
    alignColumnLeft: HTMLButtonElement;
    alignColumnCenter: HTMLButtonElement;
    alignColumnRight: HTMLButtonElement;
    sortAscending: HTMLButtonElement;
    sortDescending: HTMLButtonElement;
    editEntireCell: HTMLButtonElement;
  };
}

interface CellCoords {
  row: number;
  col: number;
}

interface CellMatrix {
  headerCells: string[];
  rows: string[][];
  alignments?: TableAlignment[];
}

interface WidgetTableData extends TableData {
  diffBaseline?: object;
  from: number;
  to: number;
  startLine: number;
  endLine: number;
  indent: string;
  visualIndent: LiveBlockIndentValue;
  signature: string;
  headerCells: string[];
}

interface TableRange {
  from: number;
  to: number;
}

type TableContextPage = 'structure' | 'arrangement';

interface TableActionTarget {
  row: number;
  col: number;
}

interface PendingCellFocus {
  row: number;
  col: number;
  caret?: number;
}

interface PendingTableTransactionBuilder {
  sequence: number;
  confirmation: TableCellCommitConfirmation;
  build: (state: EditorState) => Transaction | null;
}

interface PendingTableCommitDetail {
  committed: boolean;
  transactionBuilders: PendingTableTransactionBuilder[];
  confirmations: TableCellCommitConfirmation[];
}

function isPendingTableCommitDetail(value: unknown): value is PendingTableCommitDetail {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'committed' in value &&
    typeof value.committed === 'boolean' &&
    'transactionBuilders' in value &&
    Array.isArray(value.transactionBuilders) &&
    'confirmations' in value &&
    Array.isArray(value.confirmations)
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
const tableCellSelector = 'th[data-table-row][data-table-col], td[data-table-row][data-table-col]';
const tableCellEditMinHeight = '--meo-table-cell-edit-min-height';
const possibleTableReferenceLink = /\[[^\]\n]+\](?!\()/;
const tableCellCaretNavigationKeys = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
const tableCellTextSelectingClass = 'meo-md-html-table-cell-text-selecting';
const tableControlSelector = '.meo-md-html-table-context-trigger, .meo-md-html-table-context-menu, .meo-md-html-table-context-btn, .meo-md-link-open-btn, .meo-md-image-controls, .meo-md-color-swatch-interactive, .meo-md-html-table-column-resize-handle';
const tableCellAutoCommitDelayMs = 250;
// Chromium reports fractional caret bounds while scrollTop is effectively
// quantized. Treat sub-pixel differences as visible so reveal retries settle.
const tableCellCaretRevealEpsilon = 1;
let nextTableCellEditSequence = 0;
let nextTableContextMenuSequence = 0;

/** One hit policy for native inputs, rendered text, grid pixels and controls. */
export function tablePointerTarget(event: PointerEvent):
  { kind: 'cell'; cell: HTMLTableCellElement } | { kind: 'border' | 'resize' | 'control' } {
  const target = event.target;
  if (!(target instanceof Element)) return { kind: 'border' };
  if (target.closest('.meo-md-html-table-column-resize-handle')) return { kind: 'resize' };
  // The floating header owns navigation and must not start a cell selection gesture.
  if (isTableControlTarget(target) || target.closest('.meo-md-html-table-sticky-header')) {
    return { kind: 'control' };
  }
  const cell = target.closest<HTMLTableCellElement>(tableCellSelector);
  if (!cell) return { kind: 'border' };
  // An absolutely positioned textarea can receive the collapsed grid's pixel
  // outside its cell. Native event.target alone is not a valid text hit there.
  const rect = cell.getBoundingClientRect();
  const inset = Math.max(0.5, cell.clientLeft / 2);
  return event.clientX > rect.left + inset && event.clientX < rect.right - inset &&
    event.clientY > rect.top + inset && event.clientY < rect.bottom - inset
    ? { kind: 'cell', cell } : { kind: 'border' };
}

export function commitPendingTableEdits(view: EditorView): boolean {
  const detail: PendingTableCommitDetail = {
    committed: false,
    transactionBuilders: [],
    confirmations: []
  };
  document.dispatchEvent(new CustomEvent('meo-commit-table-edits', { detail }));

  executeTableCellCommitBoundary(detail.confirmations, () => {
    let state = view.state;
    const transactions: Transaction[] = [];
    for (const pending of detail.transactionBuilders.sort((left, right) => left.sequence - right.sequence)) {
      const transaction = pending.build(state);
      if (!transaction) continue;
      pending.confirmation.applied = true;
      transactions.push(transaction);
      state = transaction.state;
    }
    if (transactions.length) view.dispatch(transactions);
  });
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
  rawFrom: number;
  rawTo: number;
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

function stabilizeHistoryScrollTop(
  view: EditorView,
  targetTop: number,
  isCurrent: () => boolean
) {
  if (!isCurrent()) return;
  const viewportController = getViewportController(view);
  if (viewportController) {
    // Once a current history restore owns the viewport, keep that lock on the
    // viewport interaction generation. The restore task can finish before a
    // replacement table's late height measurement; the next real interaction
    // still cancels the lock through ViewportController.markInteraction().
    viewportController.lockScrollTop(targetTop);
  }
}

export function tableUsableViewportBounds(view: EditorView, element: Element) {
  const viewport = view.scrollDOM.getBoundingClientRect();
  // Editing the primary header must never compete with its passive clone.
  if (element.closest('thead')) return { top: viewport.top, bottom: viewport.bottom };
  const shell = element.closest('.meo-md-html-table-shell');
  const stickyChrome = shell?.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible')
    ?? view.dom.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible');
  const table = element.closest<HTMLTableElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
  const tableRect = table?.getBoundingClientRect();
  const headerRect = table?.tHead?.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  // History restoration can run in the same checkpoint that replaces the
  // table, before the Sticky adapter has marked the new clone visible. Infer
  // the reserved header band from the primary table during that brief gap.
  const bodyOverlapsStickyBand = Boolean(
    headerRect && element.closest('tbody')
    && elementRect.top < viewport.top + headerRect.height
  );
  const headerFits = !headerRect || tableHeaderFitsStickyViewport(viewport.height, headerRect.height);
  const inferredStickyBottom = headerFits && tableRect && headerRect
    && tableRect.bottom > viewport.top
    && (headerRect.bottom <= viewport.top || bodyOverlapsStickyBand)
    ? viewport.top + headerRect.height
    : viewport.top;
  return {
    top: Math.max(
      viewport.top,
      headerFits ? stickyChrome?.getBoundingClientRect().bottom ?? viewport.top : viewport.top,
      inferredStickyBottom
    ),
    bottom: viewport.bottom
  };
}

/** Resolve only the target row, before a native history transaction can paint
 * an unrelated document caret while its table presentation is still pending. */
export function tableHistorySourcePosition(state: EditorState, target: TableHistoryFocusTarget): number | null {
  const start = state.doc.lineAt(Math.max(0, Math.min(target.tableFrom, state.doc.length)));
  const number = start.number + (target.row > 0 ? target.row + 1 : 0);
  if (number > state.doc.lines) return null;
  const line = state.doc.line(number);
  const cell = parseTableLine(number, line.from, line.to, line.text).segments[target.col];
  if (!cell) return null;
  const value = tableCellSourceToEditorValue(state.doc.sliceString(cell.from, cell.to));
  return Math.min(cell.to, cell.from + tableCellEditorOffsetToSourceOffset(value, Math.min(target.caret, value.length)));
}

export function focusTableHistoryChange(
  view: EditorView,
  changed: { from: number; to: number },
  previousViewport: { scrollTop: number; selection: { lineNumber: number; viewportOffset?: number } },
  targetPosition?: number,
  isCurrent: () => boolean = () => true,
  semanticTarget?: TableHistoryFocusTarget
): 'not-rendered' | 'restored' | 'retry' {
  if (!isCurrent()) return 'not-rendered';
  const previousScrollTop = previousViewport.scrollTop;

  const changedLine = view.state.doc.lineAt(Math.min(changed.from, view.state.doc.length)).number;
  const refreshCurrentInputRange = (input: HTMLTextAreaElement): boolean => {
    const range = tableCellSourceRangeForInput(view, input);
    if (!range) return false;
    const { from, to } = range;
    // A history transaction updates the document before Live's derived table
    // presentation is replaced. Never focus that stale textarea: it would be
    // detached on the next frame and the restored focus would immediately vanish.
    const currentSource = view.state.doc.sliceString(from, to).trim();
    if (tableCellEditorValueToSource(input.value).trim() !== currentSource) {
      if (!semanticTarget?.contentOnly) return false;
      // This history event proves the table topology is unchanged. The
      // accepted cell source can update its retained native owner immediately,
      // independently of the whole-document Worker presentation.
      input.value = tableCellSourceToEditorValue(currentSource);
      const shell = input.closest<HTMLElement>('.meo-md-html-table-shell');
      const owner = shell ? tableDomOwners.get(shell) : undefined;
      owner?.refreshCellPreviewFromInput(input);
      const row = input.closest('tr');
      if (row) owner?.resizeRow(row);
    }
    return true;
  };
  const findInput = () => {
    if (semanticTarget) {
      const tableStartLine = view.state.doc.lineAt(
        Math.max(0, Math.min(semanticTarget.tableFrom, view.state.doc.length))
      ).number;
      const input = ensureMountedTableCell(view, tableStartLine, semanticTarget.row, semanticTarget.col);
      if (input && refreshCurrentInputRange(input)) return input;
    }
    let closest: { input: HTMLTextAreaElement; distance: number; viewportDistance: number } | null = null;
    const viewport = view.scrollDOM.getBoundingClientRect();
    for (const input of mountedTableInputsForLine(view, changedLine)) {
      const sourceLine = Number.parseInt(input.closest('tr')?.dataset.sourceLineNumber ?? '', 10);
      if (sourceLine !== changedLine) continue;
      if (!refreshCurrentInputRange(input)) continue;
      const { from, to } = tableCellSourceRangeForInput(view, input)!;
      const distance = changed.to < from
        ? from - changed.to
        : changed.from > to
          ? changed.from - to
          : 0;
      const rect = input.getBoundingClientRect();
      const viewportDistance = rect.bottom < viewport.top
        ? viewport.top - rect.bottom
        : rect.top > viewport.bottom
          ? rect.top - viewport.bottom
          : 0;
      if (
        !closest || distance < closest.distance ||
        (distance === closest.distance && viewportDistance < closest.viewportDistance)
      ) {
        closest = { input, distance, viewportDistance };
      }
    }
    return closest?.input ?? null;
  };

  if (!view.state.doc.line(changedLine).text.includes('|')) return 'not-rendered';
  let viewportPreservationScheduled = false;
  const focusInput = () => {
    if (!isCurrent()) return 'not-rendered' as const;
    const input = findInput();
    if (!input) return 'not-rendered' as const;
    const range = tableCellSourceRangeForInput(view, input);
    if (!range) return 'not-rendered' as const;
    const { from: cellFrom, to: cellTo } = range;
    const sourceCaret = Math.min(Math.max((targetPosition ?? changed.to) - cellFrom, 0), cellTo - cellFrom);
    const caret = semanticTarget && !semanticTarget.contentOnly
      ? Math.min(Math.max(semanticTarget.caret, 0), input.value.length)
      : tableCellSourceOffsetToEditorOffset(input.value, sourceCaret);
    input.focus({ preventScroll: true });
    input.setSelectionRange(caret, semanticTarget?.selectionEnd === undefined ? caret
      : Math.min(Math.max(semanticTarget.selectionEnd, caret), input.value.length), semanticTarget?.selectionDirection);

    const cell = input.closest<HTMLElement>(tableCellSelector);
    if (!cell) return 'restored' as const;
    const scrollerRect = view.scrollDOM.getBoundingClientRect();
    const priorOffset = previousViewport.selection.viewportOffset;
    if (priorOffset !== undefined && previousViewport.selection.lineNumber === changedLine) {
      // A rebuilt row window may have different estimates above this cell.
      // Preserve its painted source row rather than an obsolete absolute offset.
      const row = input.closest('tr')!;
      const controller = getViewportController(view);
      if (controller) controller.retainElementTopWhileMutation(row,
        () => mountedTableInputsForLine(view, changedLine)[0]?.closest('tr') ?? null,
        () => {}, () => true, scrollerRect.top + priorOffset);
      else view.scrollDOM.scrollTop += row.getBoundingClientRect().top - scrollerRect.top - priorOffset;
      return 'restored' as const;
    }
    const usableViewport = tableUsableViewportBounds(view, cell);
    const caretRect = tableCellCaretViewportBounds(input);
    const caretTop = caretRect.top - scrollerRect.top + view.scrollDOM.scrollTop;
    const caretBottom = caretRect.bottom - scrollerRect.top + view.scrollDOM.scrollTop;
    const historyContextMargin = visualLineContextMargin(view, 2.5);
    const primaryTable = cell.closest<HTMLTableElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table)'
    );
    const primaryTableRect = primaryTable?.getBoundingClientRect();
    const headerRect = primaryTable?.tHead?.getBoundingClientRect();
    const headerBottomInScrollContent = headerRect
      ? headerRect.bottom - scrollerRect.top + view.scrollDOM.scrollTop
      : null;
    const tableBottomInScrollContent = primaryTableRect
      ? primaryTableRect.bottom - scrollerRect.top + view.scrollDOM.scrollTop
      : null;
    const previousStickyHeight = headerRect
      && headerBottomInScrollContent !== null
      && tableBottomInScrollContent !== null
      && headerBottomInScrollContent <= previousScrollTop + tableCellCaretRevealEpsilon
      && tableBottomInScrollContent > previousScrollTop
      ? headerRect.height
      : 0;
    const previousUsableTop = previousScrollTop + Math.max(
      previousStickyHeight,
      usableViewport.top - scrollerRect.top
    );
    const caretWasVisible = (
      caretTop >= previousUsableTop - tableCellCaretRevealEpsilon &&
      caretBottom <= previousScrollTop + view.scrollDOM.clientHeight + tableCellCaretRevealEpsilon
    );
    if (caretWasVisible) {
      if (!viewportPreservationScheduled) {
        viewportPreservationScheduled = true;
        stabilizeHistoryScrollTop(view, previousScrollTop, isCurrent);
      }
      return 'restored' as const;
    }
    // CodeMirror may have already moved an offscreen history target just
    // inside the viewport. Reveal the restored cell editor, rather than only
    // its caret line, so a late textarea resize cannot consume the promised
    // reading context. Only the `caretWasVisible` branch above may retain a
    // tighter existing viewport.
    const inputRect = input.getBoundingClientRect();
    const inputHasRevealContext = (
      inputRect.top >= usableViewport.top + historyContextMargin - tableCellCaretRevealEpsilon &&
      inputRect.bottom <= usableViewport.bottom - historyContextMargin + tableCellCaretRevealEpsilon
    );
    if (!inputHasRevealContext) {
      const viewportController = getViewportController(view);
      const isNavigationCurrent = viewportController?.beginNavigationReveal();
      if (viewportController && isNavigationCurrent) {
        const canReveal = () => isCurrent() && isNavigationCurrent();
        viewportController.revealVerticalBounds(
          () => canReveal() && input.isConnected ? input.getBoundingClientRect() : null,
          canReveal,
          {
            yMargin: historyContextMargin,
            readViewportBounds: () => tableUsableViewportBounds(view, cell)
          }
        );
      } else {
        const delta = inputRect.top < usableViewport.top + historyContextMargin
          ? inputRect.top - usableViewport.top - historyContextMargin
          : inputRect.bottom > usableViewport.bottom - historyContextMargin
            ? inputRect.bottom - usableViewport.bottom + historyContextMargin
            : 0;
        if (Math.abs(delta) >= 1) view.scrollDOM.scrollTop += delta;
      }
      return 'retry' as const;
    }
    return 'restored' as const;
  };
  return focusInput();
}

export function focusHistoryChange(
  view: EditorView,
  changed: { from: number; to: number } | null,
  previousScrollTop: number,
  previousSelection?: {
    lineNumber: number;
    visibleFromLineNumber: number;
    visibleToLineNumber: number;
    wasVisible: boolean;
  },
  targetPosition?: number,
  isCurrent: () => boolean = () => true
) {
  if (!isCurrent()) return;
  const target = targetPosition ?? changed?.to;
  const targetLineBeforeFocus = typeof target === 'number'
    ? view.state.doc.lineAt(Math.max(0, Math.min(target, view.state.doc.length))).number
    : null;
  const targetWasVisibleBeforeReplay = targetLineBeforeFocus !== null && Boolean(
    previousSelection &&
    targetLineBeforeFocus >= previousSelection.visibleFromLineNumber &&
    targetLineBeforeFocus <= previousSelection.visibleToLineNumber
  );
  if (typeof target === 'number' && view.state.selection.main.head !== target) {
    view.dispatch({ selection: { anchor: target } });
  }
  // EditorView.focus() suppresses the DOM selection observer while restoring
  // the state selection. Focusing contentDOM directly can replay the stale DOM
  // caret from the previously focused embedded editor and overwrite `target`.
  view.focus();
  let viewportPreservationScheduled = false;
  let tableFocused = false;
  let offscreenRevealScheduled = false;
  const revealOffscreenSelection = () => {
    if (!isCurrent() || tableFocused) return;
    const selection = view.state.selection.main;
    const viewport = getViewportController(view);
    if (viewport) {
      const navigationIsCurrent = viewport.beginNavigationReveal();
      viewport.revealPositionUntilStable(selection.head, {
        geometry: 'line-block',
        marginMode: 'comfort-band',
        retainOnLayout: true,
        y: 'nearest',
        yMargin: visualLineContextMargin(view, 2.5)
      }, () => isCurrent() && navigationIsCurrent());
    } else {
      view.dispatch({ effects: editorScrollIntoView(selection.head, { y: 'nearest' }) });
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
    const wasVisibleBeforeReplay = targetWasVisibleBeforeReplay || (
      block.top >= previousScrollTop &&
      block.bottom <= previousScrollTop + view.scrollDOM.clientHeight
    );
    if (wasVisibleBeforeReplay) {
      if (!viewportPreservationScheduled) {
        viewportPreservationScheduled = true;
        stabilizeHistoryScrollTop(view, previousScrollTop, isCurrent);
      }
      return;
    }
    if (!offscreenRevealScheduled) {
      offscreenRevealScheduled = true;
      revealOffscreenSelection();
    }
    if (getViewportController(view)) {
      return;
    }
    // CodeMirror may already have revealed an offscreen history target while
    // applying the transaction. In that case any second scroll only creates a
    // visible bounce, so keep the current nearest position.
    if (isVisibleNow) return;
    if (!coords) {
      revealOffscreenSelection();
      return;
    }
    if (coords.top < scrollerRect.top || coords.bottom > scrollerRect.bottom) {
      revealOffscreenSelection();
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

function isTableControlTarget(target: EventTarget | null): boolean {
  return Boolean(target instanceof Element && target.closest(tableControlSelector));
}


function isEditingMenuTarget(target: EventTarget | null): boolean {
  return Boolean(target instanceof Element && target.closest('.selection-inline-menu, .meo-input-suggestions, .meo-hex-color-adjustment'));
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
  if (!target || target.closest('.meo-md-image-controls')) return '';
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
const tableInlineTagRe = new RegExp(MARKDOWN_TAG_PATTERN, 'uy');
const tableCellBreakAtRe = /^<br\s*\/?>/i;
const tableCellQuotePrefixRe = /^([ \t]*)>[ \t]?/;
const tableInlineEscapableChars = new Set(['\\', '*', '_', '~', '`', '[', ']', '(', ')', '!', '|', '<', '>']);
const tableSearchStateEventName = 'meo-search-state-change';
const tableDiagnosticSeverityClasses = [
  'meo-diagnostic-error',
  'meo-diagnostic-warning',
  'meo-diagnostic-info',
  'meo-diagnostic-hint'
];

function isTableInlineEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) {
    slashCount += 1;
  }
  return (slashCount % 2) === 1;
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

  const nextMatch = createTextSearch(query, searchState?.caseSensitive)(text);
  const matches: TableSearchMatchRange[] = [];
  for (let match = nextMatch(); match; match = nextMatch()) {
    if (!searchState?.wholeWord || isWholeWordTableSearchRange(text, match.start, match.end)) matches.push(match);
  }
  return matches;
}

interface TableCellLogicalLine {
  text: string;
  from: number;
  breakText: string;
}

interface TableCellLinePresentation {
  input: HTMLTextAreaElement;
  editorValue: string;
  source: string;
  lines: TableCellLogicalLine[];
  line: TableCellLogicalLine;
  valueFrom: number;
  sourceElement: HTMLElement;
  textElement: HTMLElement;
  prefixElement: HTMLElement | null;
  prefixMarkers: TableCellRange[];
  bodyElement: HTMLElement;
  bodyRuns: ReturnType<typeof inlineSourceRuns>;
  inlineRanges: InlineEditRange[];
  editingInline?: InlineEditRange;
  breakElement: HTMLElement | null;
  scrollTop: number;
  measurementKey: string;
  selection: { from: number; to: number } | null;
  highlight: Highlight | null;
  caret: { position: number; wrapStart: boolean; element: HTMLSpanElement } | null;
}

function appendTableCellSourceLine(
  parent: HTMLElement, line: TableCellLogicalLine, bodyFrom: number,
  appendBody: (parent: HTMLElement, text: string, from: number) => void
) {
  const source = document.createElement('div');
  source.className = 'meo-md-table-active-source-line';
  const content = document.createElement('div');
  content.className = 'meo-md-table-source-text';
  const text = line.text + line.breakText;
  setInlineSourceRange(content, { from: line.from, to: line.from + text.length });
  if (bodyFrom > line.from) {
    appendInlineMappedText(content, text.slice(0, bodyFrom - line.from), { from: line.from, to: bodyFrom },
      'meo-md-table-source-prefix');
  }
  const bodyEnd = line.from + line.text.length;
  const body = document.createElement('span');
  body.className = 'meo-md-table-source-body';
  setInlineSourceRange(body, { from: bodyFrom, to: bodyEnd });
  appendBody(body, line.text.slice(bodyFrom - line.from), bodyFrom);
  content.appendChild(body);
  if (line.breakText) {
    appendInlineMappedText(content, line.breakText, { from: bodyEnd, to: line.from + text.length },
      'meo-md-table-source-break');
  }
  if (!text) content.appendChild(document.createElement('br'));
  source.appendChild(content);
  parent.appendChild(source);
}

function splitTableCellLogicalLines(text: string): TableCellLogicalLine[] {
  const lines: TableCellLogicalLine[] = [];
  const syntax = text.includes('[') || text.includes('`') ? parseTableInlineSyntax(text, 0) : null;
  let lineStart = 0;
  for (let index = 0; index < text.length;) {
    const breakMatch = !isTableInlineEscaped(text, index) ? tableCellBreakAtRe.exec(text.slice(index)) : null;
    if (breakMatch) {
      lines.push({ text: text.slice(lineStart, index), from: lineStart, breakText: breakMatch[0] });
      index += breakMatch[0].length;
      lineStart = index;
      continue;
    }

    const protectedNext = consumeTableInlineProtectedSpan(text, index, text.length, syntax);
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
  const syntax = value.includes('[') || value.includes('`') ? parseTableInlineSyntax(value, 0) : null;
  for (let index = 0; index < value.length;) {
    const breakMatch = !isTableInlineEscaped(value, index) ? tableCellBreakAtRe.exec(value.slice(index)) : null;
    if (breakMatch) {
      source += breakMatch[0];
      index += breakMatch[0].length;
      if (value[index] === '\r') index += 1;
      if (value[index] === '\n') index += 1;
      continue;
    }

    const protectedNext = consumeTableInlineProtectedSpan(value, index, value.length, syntax);
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

function tableCellDisplayOffset(source: string, offset: number): number {
  const target = Math.min(source.length, Math.max(0, offset));
  let displayOffset = target;
  // A cursor can split an inline code span or link. Classify breaks from the
  // complete cell so a literal tag before that cursor stays literal.
  for (const line of splitTableCellLogicalLines(source)) {
    if (!line.breakText || line.from + line.text.length + line.breakText.length > target) break;
    displayOffset++;
  }
  return displayOffset;
}

export function tableCellSourceOffsetToEditorOffset(value: string, offset: number): number {
  return tableCellDisplayOffset(tableCellEditorValueToSource(value), offset);
}

function writeTableCellTextSelection(event: ClipboardEvent, input: HTMLTextAreaElement): boolean {
  const { value, selectionStart, selectionEnd } = input;
  if (selectionStart === selectionEnd || !event.clipboardData || !value.includes('\n')) return false;
  const from = tableCellEditorOffsetToSourceOffset(value, selectionStart);
  const to = tableCellEditorOffsetToSourceOffset(value, selectionEnd);
  event.clipboardData.setData('text/plain', tableCellEditorValueToSource(value).slice(from, to));
  event.preventDefault();
  event.stopPropagation();
  return true;
}

function tableCellSelectionHead(input: HTMLTextAreaElement): number {
  return input.selectionDirection === 'backward' ? input.selectionStart : input.selectionEnd;
}

/** Source coordinates belong to the committed row, not every cell DOM node.
 * Row/column identity survives position-only edits without per-cell mutations. */
export function tableCellSourceRangeForInput(
  view: EditorView,
  input: HTMLTextAreaElement
): { from: number; to: number } | null {
  if (!view.contentDOM.contains(input)) return null;
  const lineNumber = Number.parseInt(input.closest('tr')?.dataset.sourceLineNumber ?? '', 10);
  const column = Number.parseInt(input.dataset.tableCol ?? '', 10);
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > view.state.doc.lines ||
    !Number.isInteger(column) || column < 0) return null;
  const line = view.state.doc.line(lineNumber);
  const segment = parseTableLine(line.number, line.from, line.to, line.text).segments[column];
  if (segment) return { from: segment.from, to: segment.to };
  // Short source rows still render normalized empty cells. Their source owner
  // uses a zero-width range at the row start until a structural edit adds it.
  const shell = input.closest<HTMLElement>('.meo-md-html-table-shell');
  const row = Number.parseInt(input.dataset.tableRow ?? '', 10);
  return shell && tableDomOwners.get(shell)?.cellSourceRange(row, column) ? { from: line.from, to: line.from } : null;
}

function withTableCellVisualLineProbe<T>(
  input: HTMLTextAreaElement,
  run: (probe: {
    caret: number;
    lineHeight: number;
    paddingBottom: number;
    lineTopAt(offset: number): number;
    value: string;
  }) => T
): T {
  const value = input.value;
  const caret = Math.max(0, Math.min(tableCellSelectionHead(input), value.length));
  const computed = getComputedStyle(input);
  const mirror = document.createElement('div');
  const copiedProperties = [
    'box-sizing', 'border-left-width', 'border-right-width', 'border-top-width', 'border-bottom-width',
    'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'font-family', 'font-size',
    'font-style', 'font-variant', 'font-weight', 'font-stretch', 'line-height', 'letter-spacing',
    'text-align', 'text-indent', 'text-transform', 'white-space', 'word-break', 'overflow-wrap',
    'tab-size'
  ];
  for (const property of copiedProperties) mirror.style.setProperty(property, computed.getPropertyValue(property));
  mirror.style.position = 'fixed';
  mirror.style.left = '-10000px';
  mirror.style.top = '0';
  mirror.style.width = `${input.getBoundingClientRect().width}px`;
  mirror.style.height = 'auto';
  mirror.style.minHeight = '0';
  mirror.style.visibility = 'hidden';
  mirror.style.pointerEvents = 'none';
  mirror.style.overflow = 'visible';
  document.body.appendChild(mirror);

  const lineTopAt = (offset: number) => {
    const marker = document.createElement('span');
    mirror.replaceChildren(document.createTextNode(value.slice(0, offset)), marker);
    marker.textContent = value.slice(offset) || '.';
    return marker.offsetTop;
  };
  try {
    const parsedLineHeight = Number.parseFloat(computed.lineHeight);
    const parsedFontSize = Number.parseFloat(computed.fontSize);
    return run({
      caret,
      paddingBottom: Number.parseFloat(computed.paddingBottom) || 0,
      lineHeight: Number.isFinite(parsedLineHeight)
        ? parsedLineHeight
        : (Number.isFinite(parsedFontSize) ? parsedFontSize * 1.2 : 16),
      lineTopAt,
      value
    });
  } finally {
    mirror.remove();
  }
}

export function tableCellVisualLineBoundary(input: HTMLTextAreaElement): {
  atFirst: boolean;
  atLast: boolean;
  caretColumn: number;
} {
  return withTableCellVisualLineProbe(input, ({ caret, lineTopAt, value }) => {
    const caretTop = lineTopAt(caret);
    const sameLine = (offset: number) => Math.abs(lineTopAt(offset) - caretTop) < 1;
    let low = 0;
    let high = caret;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (lineTopAt(middle) < caretTop - 0.5) low = middle + 1;
      else high = middle;
    }
    return {
      atFirst: sameLine(0),
      atLast: sameLine(value.length),
      caretColumn: caret - low
    };
  });
}

function tableCellCaretViewportBounds(input: HTMLTextAreaElement): { top: number; bottom: number } {
  const projected = tableCellProjectedCaretRect(input, tableCellSelectionHead(input));
  if (projected) return projected;
  return withTableCellVisualLineProbe(input, ({ caret, lineHeight, lineTopAt, paddingBottom }) => {
    const inputRect = input.getBoundingClientRect();
    const measuredTop = inputRect.top + lineTopAt(caret) - input.scrollTop;
    const latestVisibleTop = Math.max(inputRect.top, inputRect.bottom - lineHeight);
    const top = Math.min(Math.max(measuredTop, inputRect.top), latestVisibleTop);
    const bottom = Math.min(inputRect.bottom, top + lineHeight);
    // At the final painted line, include the cell's fractional bottom border.
    // A taller neighbouring cell must not pull a short input's caret downward.
    const cellBottom = caret === input.value.length && bottom >= inputRect.bottom - paddingBottom - tableCellCaretRevealEpsilon
      ? input.closest<HTMLElement>(tableCellSelector)?.getBoundingClientRect().bottom : undefined;
    return { top, bottom: Math.max(bottom, cellBottom ?? bottom) };
  });
}

export function tableCellProjectedCaretRect(input: HTMLTextAreaElement, offset: number): DOMRect | null {
  const shell = input.closest<HTMLElement>('.meo-md-html-table-shell');
  return shell ? tableDomOwners.get(shell)?.projectedCaretRect(input, offset) ?? null : null;
}

export function tableCellProjectedSourceAtPoint(
  input: HTMLTextAreaElement, clientX: number, clientY: number
): number | null | undefined {
  const shell = input.closest<HTMLElement>('.meo-md-html-table-shell');
  return shell ? tableDomOwners.get(shell)?.projectedSourceAtPoint(input, clientX, clientY) : undefined;
}

function tableCellEditorBreakStart(value: string, newline: number, maxStart = newline): number | null {
  if (value[newline] !== '\n' || value[newline - 1] !== '>') return null;
  const from = value.lastIndexOf('<', newline);
  if (from < 0 || from > maxStart
      || tableCellBreakAtRe.exec(value.slice(from, newline))?.[0].length !== newline - from) return null;
  return splitTableCellLogicalLines(value).some(line => line.breakText && line.from + line.text.length === from)
    ? from
    : null;
}

function tableCellBreakDeletionRange(value: string, caret: number, backward: boolean, projected: boolean): TableCellRange | null {
  const beforeTag = !backward && projected && value[caret] === '<';
  const newline = backward ? caret - 1 : beforeTag ? value.indexOf('\n', caret) : caret;
  const start = tableCellEditorBreakStart(value, newline);
  if (start === null || beforeTag && start !== caret) return null;
  // The textarea's newline only lays out the tag. In whole-cell source, both
  // sides of that newline refer to the same insertion point after `>`.
  if (backward) return { from: projected ? start : newline - 1, to: newline + 1 };
  if (beforeTag) return { from: start, to: newline + 1 };
  return { from: newline + 1, to: findClusterBreak(value, newline + 1) };
}

function normalizeTableCellEditorInput(input: HTMLTextAreaElement, breakSuffix: string | null) {
  // An edit can change the tag and leave its display-only newline in the
  // untouched suffix. Drop that newline before converting real input to source.
  if (breakSuffix && input.value.endsWith(breakSuffix)) {
    const newline = input.value.length - breakSuffix.length;
    if (tableCellEditorBreakStart(input.value, newline) === null) {
      input.setRangeText('', newline, newline + 1, 'preserve');
    }
  }

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

interface TableCellEditorChange {
  from: number;
  to: number;
  insert: string;
}

function applyTableCellEditorChanges(input: HTMLTextAreaElement, changes: TableCellEditorChange[], caret?: number) {
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
  input.setSelectionRange(caret ?? mapPosition(selectionStart), caret ?? mapPosition(selectionEnd));
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const tableCellListRenumbering = orderedListRenumberTransactionFilter(() => true);

function editTableCellMarkup(
  input: HTMLTextAreaElement,
  documentState: EditorState,
  operation: 'break' | 'backspace',
  beforeEdit?: () => void
): boolean {
  const { value, selectionStart, selectionEnd } = input;
  if (selectionStart !== selectionEnd) return false;
  const lineStart = selectionStart ? value.lastIndexOf('\n', selectionStart - 1) + 1 : 0;
  if (!/^[ \t]*(?:[>+*\-]|\d+[.)])/.test(value.slice(lineStart))) return false;
  if (operation === 'backspace') {
    const lineEnd = value.indexOf('\n', selectionStart);
    const lineText = value.slice(lineStart, lineEnd < 0 ? value.length : lineEnd).replace(/<br\s*\/?>$/i, '');
    const prefix = listMarkerDataInContainerLine(lineText);
    const column = selectionStart - lineStart;
    if (!prefix || column < prefix.markerEndOffset || column > prefix.toOffset) return false;
  }

  // Run the same structural commands on the cell's logical lines. The real
  // textarea and its pending cell edit still own the caret, commit and history.
  const lines = splitTableCellLogicalLines(tableCellEditorValueToSource(value));
  let index = lines.length - 1;
  while (index > 0 && lines[index]!.from + index > selectionStart) index--;
  const line = lines[index]!;
  const column = selectionStart - (line.from + index);
  if (column > line.text.length && column !== line.text.length + line.breakText.length) return false;
  const marker = listMarkerDataInContainerLine(line.text);
  const quoted = /^[ \t]*>/.test(line.text);
  if (!marker && (operation === 'backspace' || !quoted)) return false;

  const doc = CodeMirrorText.of(lines.map(line => line.text));
  const state = EditorState.create({
    doc,
    selection: { anchor: doc.line(index + 1).from + Math.min(column, line.text.length) },
    extensions: [
      markdownLanguage, tableCellListRenumbering,
      EditorState.tabSize.of(documentState.tabSize), indentUnit.of(documentState.facet(indentUnit))
    ]
  });
  const editorOffset = (position: number) => {
    const virtualLine = doc.lineAt(position);
    const logicalIndex = virtualLine.number - 1;
    return lines[logicalIndex]!.from + logicalIndex + (position - virtualLine.from);
  };
  const toEditorText = (text: CodeMirrorText) => text.toString().replaceAll('\n', '<br>\n');
  const dispatch = (transaction: Transaction) => {
    const changes: TableCellEditorChange[] = [];
    const head = transaction.newSelection.main.head;
    let caret: number | undefined;
    let documentDelta = 0;
    let editorDelta = 0;
    transaction.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      const from = editorOffset(fromA), to = editorOffset(toA);
      const insert = toEditorText(inserted);
      // Existing break tags only disappear when their virtual newline is
      // removed. Inserted newlines get the cell editor's normal break spelling.
      if (caret === undefined && head <= toB) {
        caret = head < fromB
          ? editorOffset(head - documentDelta) + editorDelta
          : from + editorDelta + toEditorText(inserted.slice(0, head - fromB)).length;
      }
      changes.push({ from, to, insert });
      documentDelta = toB - toA;
      editorDelta += insert.length - (to - from);
    });
    beforeEdit?.();
    applyTableCellEditorChanges(input, changes, caret ?? editorOffset(head - documentDelta) + editorDelta);
  };
  const target = { state, dispatch };
  if (operation === 'backspace') {
    return handleBackspaceAtListContentStart(target)
      || (quoted && column === marker?.toOffset && deleteMarkupBackward(target));
  }
  return handleEnterInList(target, true);
}

function insertTableCellEditorBreak(input: HTMLTextAreaElement, state?: EditorState, beforeEdit?: () => void) {
  if (state?.facet(inputAssistanceFacet).lists && editTableCellMarkup(input, state, 'break', beforeEdit)) return;
  beforeEdit?.();
  replaceTableCellEditorSelection(input, '<br>\n');
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
        marker.orderedNumber,
        false
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
    span.dataset.tooltip = tableDiagnosticTitle(diagnostic);
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

function consumeTableInlineAngleSection(text: string, index: number) {
  if (text[index] !== '<' || isTableInlineEscaped(text, index)) return null;
  const close = text.indexOf('>', index + 1);
  if (close < 0) return null;
  const content = text.slice(index + 1, close);
  // An unfinished tag must leave the next tag available to the inline scanner.
  if (content.includes('<') && content.replace(/"[^"]*"|'[^']*'/g, '').includes('<')) return null;
  return {
    content,
    nextIndex: close + 1
  };
}

function parseTableInlineMarkdownLink(text: string, index: number, syntax: ReturnType<typeof parseTableInlineSyntax> | null, offset: number,
  { image = false, referenceState }: { image?: boolean; referenceState?: EditorState } = {}) {
  const link = syntax?.links.get(offset + index) ?? (referenceState ? syntax?.references.get(offset + index) : undefined);
  if (!link || link.image !== image) return null;
  let url = 'referenceLabel' in link
    ? hrefFromMarkdownReference(referenceState!, link.referenceLabel)
    : normalizeExplicitSourceHref(text.slice(link.urlFrom - offset, link.urlTo - offset));
  if ('referenceLabel' in link && !url) return null;
  if (url.startsWith('<') && url.endsWith('>') && url.length >= 2) {
    url = url.slice(1, -1).trim();
  }

  return {
    label: text.slice(link.labelFrom - offset, link.labelTo - offset),
    labelFrom: link.labelFrom - offset,
    url,
    nextIndex: link.to - offset
  };
}

function parseTableInlineWikiLink(text: string, index: number) {
  const reference = parseWikiReference(text, index);
  if (!reference || reference.embed) return null;
  const contentFrom = index + 2;
  const contentTo = reference.to - 2;
  const pipe = text.indexOf('|', contentFrom);
  const hasAlias = pipe >= 0 && pipe < contentTo && text.slice(pipe + 1, contentTo).trim().length > 0;
  const visibleFrom = hasAlias ? pipe + 1 : contentFrom;
  const visibleRaw = text.slice(visibleFrom, hasAlias || pipe < 0 ? contentTo : pipe);
  return { target: reference.target, visibleText: reference.label,
    visibleTextFrom: visibleFrom + visibleRaw.search(/\S|$/), nextIndex: reference.to };
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

function appendTableInlinePreviewLink(parent: HTMLElement, label: string, href: string, options: {
  baseOffset?: number;
  diagnostics?: TableCellDiagnostics[];
  searchState?: TableSearchState | null;
  sourceRange?: TableCellRange | null;
  presentationFactory: ImagePresentationFactory;
  uiLanguage: UiLanguage;
  view: EditorView;
  literalLabel?: boolean;
  editRange?: InlineEditRange;
}) {
  const wrapper = document.createElement('span');
  const el = document.createElement('span');
  el.className = 'meo-md-link';
  if (href) el.setAttribute('data-meo-link-href', href);
  if (options.editRange) {
    markTableInlineSource(wrapper, options.editRange);
    if (options.baseOffset !== undefined) {
      tableInlineContent.set(wrapper, { element: el, from: options.baseOffset, to: options.baseOffset + label.length });
    }
  }
  if (options.literalLabel) appendTablePlainText(el, label, options.baseOffset ?? 0, options.diagnostics ?? [], options.searchState ?? null, options.sourceRange ?? null);
  else appendTableInlinePreviewNodes(el, label, { ...options, disableLinkParsers: true, imageLinkHref: href });
  if (isMissingLocalLinkTarget(href)) {
    wrapper.appendChild(createMissingLocalLinkIndicator(options.uiLanguage));
  }
  wrapper.appendChild(el);
  if (href) wrapper.appendChild(createOpenLinkButton(href, options.uiLanguage));
  parent.appendChild(wrapper);
}

type TableInlineContent = InlineEditRange & { element: HTMLElement; rawText?: boolean; markersInside?: boolean };
const tableInlineContent = new WeakMap<HTMLElement, TableInlineContent>();

function markTableInlineSource(element: HTMLElement, range: InlineEditRange, atomic = false) {
  element.dataset.meoEditInline = '';
  setInlineSourceRange(element, range, { atomic });
}

function markStyledTableInlineSource(element: HTMLElement, range: InlineEditRange, content: Omit<TableInlineContent, 'element'>) {
  markTableInlineSource(element, range);
  tableInlineContent.set(element, { element, ...content });
}

function revealTableInlineSource(element: HTMLElement, range: InlineEditRange, source: string): void {
  const projected = element.ownerDocument.createElement('span');
  projected.className = 'meo-md-table-inline-source';
  setInlineSourceRange(projected, range);
  const content = tableInlineContent.get(element);
  if (!content) {
    projected.textContent = source.slice(range.from, range.to);
    disposeImagePresentations(element);
    element.replaceWith(projected);
    return;
  }

  const { element: styled, markersInside } = content;
  const markerHost = markersInside ? styled : projected;
  const appendMarker = (from: number, to: number) => from < to
    ? appendInlineMappedText(markerHost, source.slice(from, to), { from, to }, 'meo-md-table-inline-marker') : null;
  element.before(projected);
  // Keep the styled DOM and nested projections. Restore source text in
  // literal payloads whose reading view trimmed spaces or decoded escapes.
  if (content.rawText) {
    const raw = source.slice(content.from, content.to);
    if (styled.textContent !== raw) {
      styled.replaceChildren();
      appendInlineMappedText(styled, raw, content);
    }
  }
  delete styled.dataset.meoEditInline;
  setInlineSourceRange(styled, markersInside ? range : content);
  const opening = appendMarker(range.from, content.from);
  if (markersInside && opening) styled.prepend(opening);
  projected.appendChild(styled);
  appendMarker(content.to, range.to);
  if (styled !== element) {
    disposeImagePresentations(element);
    element.remove();
  }
}

export function refreshTableLocalLinkIndicators(
  root: ParentNode,
  uiLanguage: UiLanguage = 'en'
): void {
  const links = root.querySelectorAll<HTMLElement>(
    '.meo-md-html-table-cell-preview .meo-md-link[data-meo-link-href]'
  );
  for (const link of links) {
    const indicator = link.previousElementSibling?.classList.contains('meo-md-local-link-missing-icon')
      ? link.previousElementSibling
      : null;
    const href = link.getAttribute('data-meo-link-href') ?? '';
    if (isMissingLocalLinkTarget(href)) {
      if (!indicator) link.before(createMissingLocalLinkIndicator(uiLanguage));
    } else {
      indicator?.remove();
    }
  }
}

const tablePreviewImageIdentity = new WeakMap<HTMLElement, { key: string; factory: ImagePresentationFactory }>();
type ReusableTablePreviewImages = Map<string, HTMLElement[]>;

function appendTableInlinePreviewImage(
  parent: HTMLElement,
  altText: string,
  url: string,
  sourceRange: TableCellRange,
  presentationFactory: ImagePresentationFactory,
  uiLanguage: UiLanguage,
  dimensions: { width?: number; height?: number } = {},
  linkUrl = '',
  reusableImages?: ReusableTablePreviewImages
) {
  if (!url) {
    appendInlineMappedText(parent, `![${altText}]()`, sourceRange);
    return;
  }
  // Table cells own pointer selection so image clicks enter the cell editor on
  // pointerup instead of being consumed by the standalone image interaction.
  const key = JSON.stringify([url, altText, linkUrl, dimensions.width, dimensions.height, uiLanguage]);
  const dom = reusableImages?.get(key)?.shift() ?? new ImageWidget(url, decodeTableInlineEscapes(altText), linkUrl, null, presentationFactory, {
    pointerInteractionOwner: 'parent',
    uiLanguage, ...dimensions
  }).toDOM();
  if (dom instanceof HTMLElement) {
    tablePreviewImageIdentity.set(dom, { key, factory: presentationFactory });
    dom.setAttribute('data-meo-link-href', linkUrl || url);
    markTableInlineSource(dom, sourceRange, true);
  }
  parent.appendChild(dom);
}

function appendTableInlinePreviewNodes(parent: HTMLElement, text: string, options: {
  baseOffset?: number;
  diagnostics?: TableCellDiagnostics[];
  disableLinkParsers?: boolean;
  imageLinkHref?: string;
  searchState?: TableSearchState | null;
  sourceRange?: TableCellRange | null;
  presentationFactory: ImagePresentationFactory;
  uiLanguage: UiLanguage;
  view: EditorView;
  inlineSyntax?: ReturnType<typeof parseTableInlineSyntax>;
  reusableImages?: ReusableTablePreviewImages;
}) {
  const { baseOffset = 0, diagnostics = [], disableLinkParsers = false, searchState = null, sourceRange = null } = options;
  const inlineSyntax = options.inlineSyntax ?? parseTableInlineSyntax(text, baseOffset, options.view.state.facet(latexDelimitersFacet));
  options = { ...options, inlineSyntax };
  const colorRangesByStart = new Map(collectHexColorRangesFromText(text).map((range) => [range.from, range]));
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
    const math = (text[i] === '$' || options.view.state.facet(latexDelimitersFacet) && text[i] === '\\') ? parseLatexMathAt(text, i, { latexDelimiters: options.view.state.facet(latexDelimitersFacet), excludedRanges: inlineSyntax.mathExcludedRanges
      .filter(range => range.from > baseOffset + i)
      .map(range => ({ from: range.from - baseOffset, to: range.to - baseOffset })) }) : null;
    if (math) {
      const mathElement = createLatexMathElement(math.content, math.mode);
      if (mathElement) {
        flushBuffer();
        markTableInlineSource(
          mathElement,
          { from: baseOffset + math.from, to: baseOffset + math.to },
          true
        );
        parent.appendChild(mathElement);
      } else {
        appendToBuffer(text.slice(math.from, math.to), math.from);
      }
      i = math.to;
      continue;
    }

    if (text[i] === '\\' && i + 1 < text.length && tableInlineEscapableChars.has(text[i + 1])) {
      flushBuffer();
      const mapped = appendInlineMappedText(parent, text[i + 1], {
        from: baseOffset + i,
        to: baseOffset + i + 2
      });
      mapped.dataset.meoEditInline = '';
      if (diagnostics.length) {
        const diagnostic = diagnostics.find((candidate) => candidate.from < baseOffset + i + 2 && candidate.to > baseOffset + i);
        if (diagnostic) {
          const severityClass = tableDiagnosticSeverityClasses[diagnostic.severity] ?? tableDiagnosticSeverityClasses[0];
          mapped.classList.add('meo-diagnostic', severityClass);
          mapped.dataset.tooltip = tableDiagnosticTitle(diagnostic);
        }
      }
      i += 2;
      continue;
    }

    // Protected link labels keep their inline HTML breaks without starting a
    // new logical list item. Code spans consume their whole payload below.
    const inlineBreak = tableCellBreakAtRe.exec(text.slice(i));
    if (inlineBreak) {
      flushBuffer();
      const br = document.createElement('br');
      markTableInlineSource(br, { from: baseOffset + i, to: baseOffset + i + inlineBreak[0].length }, true);
      parent.appendChild(br);
      i += inlineBreak[0].length;
      continue;
    }

    const htmlCode = text[i] === '<' ? matchInlineHtmlCode(text, i) : null;
    if (htmlCode) {
      flushBuffer();
      const el = document.createElement('code');
      el.className = 'meo-md-inline-code';
      markStyledTableInlineSource(el, { from: baseOffset + i, to: baseOffset + htmlCode.to },
        { from: baseOffset + htmlCode.contentFrom, to: baseOffset + htmlCode.contentTo });
      appendTablePlainText(el, text.slice(htmlCode.contentFrom, htmlCode.contentTo), baseOffset + htmlCode.contentFrom, diagnostics, searchState, sourceRange);
      parent.appendChild(el);
      i = htmlCode.to;
      continue;
    }

    const code = inlineSyntax.codes.get(baseOffset + i);
    if (code) {
      flushBuffer();
      const el = document.createElement('code');
      el.className = 'meo-md-inline-code';
      markStyledTableInlineSource(el, { from: baseOffset + i, to: code.to },
        { from: code.contentFrom, to: code.contentTo, rawText: true, markersInside: true });
      const raw = text.slice(code.contentFrom - baseOffset, code.contentTo - baseOffset);
      // CommonMark strips one bounding space unless the payload is all spaces.
      const padding = raw.startsWith(' ') && raw.endsWith(' ') && /[^ ]/.test(raw) ? 1 : 0;
      const contentFrom = code.contentFrom + padding;
      const content = raw.slice(padding, raw.length - padding);
      let cursor = 0;
      // Only the table-level pipe escape is removed; code backslashes are literal.
      for (const escape of content.matchAll(/\\\|/g)) {
        const index = escape.index!;
        appendTablePlainText(el, content.slice(cursor, index), contentFrom + cursor, diagnostics, searchState, sourceRange);
        appendInlineMappedText(el, '|', { from: contentFrom + index, to: contentFrom + index + 2 });
        cursor = index + 2;
      }
      appendTablePlainText(el, content.slice(cursor), contentFrom + cursor, diagnostics, searchState, sourceRange);
      parent.appendChild(el);
      i = code.to - baseOffset;
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
        const contentFrom = baseOffset + i + kbd.contentFrom;
        markStyledTableInlineSource(el, { from: baseOffset + i, to: baseOffset + kbd.nextIndex },
          { from: contentFrom, to: contentFrom + kbd.content.length, rawText: true });
        appendTablePlainText(
          el,
          keyText,
          contentFrom,
          diagnostics,
          searchState,
          sourceRange
        );
        parent.appendChild(el);
      }
      i = kbd.nextIndex;
      continue;
    }

    const htmlTagEnd = inlineSyntax.htmlTags.get(baseOffset + i);
    if (htmlTagEnd !== undefined) {
      flushBuffer();
      appendTablePlainText(parent, text.slice(i, htmlTagEnd - baseOffset), baseOffset + i, diagnostics, searchState, sourceRange);
      i = htmlTagEnd - baseOffset;
      continue;
    }

    const footnoteMarker = !disableLinkParsers && text.startsWith('[^', i)
      ? /^\[\^([^\]\r\n]+)\]/.exec(text.slice(i)) : null;
    const footnote = footnoteMarker && sourceRange
      ? parseFootnotes(options.view.state).references.find(reference => (
          reference.from === sourceRange.from + baseOffset + i && reference.number !== null
        )) : null;
    if (footnote?.definition && footnoteMarker) {
      flushBuffer();
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'meo-md-footnote-ref';
      button.dataset.tooltip = getUiStrings(options.uiLanguage).jumpToFootnote(footnote.number!);
      button.setAttribute('aria-label', button.dataset.tooltip);
      const number = document.createElement('sup');
      number.textContent = String(footnote.number);
      button.appendChild(number);
      markTableInlineSource(button, { from: baseOffset + i, to: baseOffset + i + footnoteMarker[0].length }, true);
      button.addEventListener('pointerdown', event => { event.preventDefault(); event.stopPropagation(); });
      button.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        const definition = parseFootnotes(options.view.state).definitions.find(candidate => candidate.isPrimary && candidate.normalizedLabel === footnote.normalizedLabel);
        if (!definition) return;
        const viewport = getViewportController(options.view);
        const reveal = viewport?.beginNavigationReveal();
        options.view.dispatch({ selection: { anchor: definition.lineFrom } });
        if (viewport && reveal) viewport.revealPosition(definition.lineFrom, { y: 'center' }, reveal);
        else options.view.dispatch({ effects: editorScrollIntoView(definition.lineFrom, { y: 'center' }) });
        options.view.focus();
      });
      parent.appendChild(button);
      i += footnoteMarker[0].length;
      continue;
    }

    const wikiImage = parseWikiReference(text, i);
    if (wikiImage?.embed && isWikiImageTarget(wikiImage.target)) {
      flushBuffer();
      appendTableInlinePreviewImage(parent, wikiImage.label, wikiImageSrc(wikiImage.target),
        { from: baseOffset + i, to: baseOffset + wikiImage.to }, options.presentationFactory, options.uiLanguage,
        wikiImage, options.imageLinkHref, options.reusableImages);
      i = wikiImage.to;
      continue;
    }

    const image = parseTableInlineMarkdownLink(text, i, inlineSyntax, baseOffset, { image: true, referenceState: options.view.state });
    if (image) {
      flushBuffer();
      appendTableInlinePreviewImage(
        parent,
        image.label,
        decodeTableInlineEscapes(image.url),
        { from: baseOffset + i, to: baseOffset + image.nextIndex },
        options.presentationFactory,
        options.uiLanguage,
        {},
        options.imageLinkHref,
        options.reusableImages
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
          baseOffset: baseOffset + wiki.visibleTextFrom,
          editRange: { from: baseOffset + i, to: baseOffset + wiki.nextIndex }
        });
        i = wiki.nextIndex;
        continue;
      }

      const link = parseTableInlineMarkdownLink(text, i, inlineSyntax, baseOffset, { referenceState: options.view.state });
      if (link) {
        flushBuffer();
        if (link.url) {
          appendTableInlinePreviewLink(parent, link.label, decodeTableInlineEscapes(link.url), {
            ...options,
            baseOffset: baseOffset + link.labelFrom,
            editRange: { from: baseOffset + i, to: baseOffset + link.nextIndex }
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
          baseOffset: baseOffset + i + 1,
          literalLabel: true,
          editRange: { from: baseOffset + i, to: baseOffset + autolink.nextIndex }
        });
        i = autolink.nextIndex;
        continue;
      }
    }

    const script = inlineSyntax.scripts.has(baseOffset + i) ? matchInlineScript(text, i) : null;
    if (script) {
      flushBuffer();
      const el = document.createElement(script.kind === 'subscript' ? 'sub' : 'sup');
      el.className = `meo-md-${script.kind}`;
      markStyledTableInlineSource(el, { from: baseOffset + i, to: baseOffset + script.to },
        { from: baseOffset + i + 1, to: baseOffset + script.to - 1, rawText: true });
      let cursor = i + 1;
      for (const escape of script.escapes) {
        appendTablePlainText(el, text.slice(cursor, escape.from), baseOffset + cursor, diagnostics, searchState, sourceRange);
        appendInlineMappedText(el, text.slice(escape.from + 1, escape.to), {
          from: baseOffset + escape.from, to: baseOffset + escape.to
        });
        cursor = escape.to;
      }
      appendTablePlainText(el, text.slice(cursor, script.to - 1), baseOffset + cursor, diagnostics, searchState, sourceRange);
      parent.appendChild(el);
      i = script.to;
      continue;
    }

    const span = inlineSyntax.spans.get(baseOffset + i);
    if (span) {
      flushBuffer();
      const el = document.createElement(({ em: 'em', strong: 'strong', strike: 'span', highlight: 'mark' } as const)[span.kind]);
      el.className = `meo-md-${span.kind}`;
      markStyledTableInlineSource(el, { from: baseOffset + i, to: span.to }, { from: span.contentFrom, to: span.contentTo });
      appendTableInlinePreviewNodes(el, text.slice(span.contentFrom - baseOffset, span.contentTo - baseOffset), { ...options, baseOffset: span.contentFrom });
      parent.appendChild(el);
      i = span.to - baseOffset;
      continue;
    }

    const color = colorRangesByStart.get(i);
    if (color) {
      flushBuffer();
      const from = sourceRange ? sourceRange.from + baseOffset + i : -1;
      const to = from + color.value.length;
      const current = sourceRange && from >= sourceRange.from && to <= sourceRange.to &&
        to <= options.view.state.doc.length &&
        options.view.state.doc.sliceString(from, to) === color.value;
      const swatch = current
        ? createInteractiveColorSwatchElement(options.view, { from, to, value: color.value })
        : createColorSwatchElement(color.value, options.uiLanguage);
      setInlineSourceRange(swatch, { from: baseOffset + i, to: baseOffset + color.to });
      const group = document.createElement('span');
      group.className = 'meo-md-color-swatch-group';
      group.appendChild(swatch);
      appendTablePlainText(group, color.value, baseOffset + i, diagnostics, searchState, sourceRange);
      parent.appendChild(group);
      i = color.to;
      continue;
    }

    if (!disableLinkParsers) {
      if (text[i] === '#') {
        tableInlineTagRe.lastIndex = i;
        const tag = tableInlineTagRe.exec(text)?.[0];
        if (tag) {
          if (isHexColorLikeLiteral(tag)) {
            appendToBuffer(tag, i);
          } else {
            flushBuffer();
            const el = document.createElement('span');
            el.className = 'meo-md-tag';
            appendTablePlainText(el, tag, baseOffset + i, diagnostics, searchState, sourceRange);
            parent.appendChild(el);
          }
          i += tag.length;
          continue;
        }
      }

      const rawUrl = parseTableInlineRawUrl(text, i);
      if (rawUrl) {
        flushBuffer();
        appendTableInlinePreviewLink(parent, rawUrl.label, rawUrl.href, {
          ...options,
          baseOffset: baseOffset + i,
          literalLabel: true,
          editRange: { from: baseOffset + i, to: baseOffset + rawUrl.nextIndex }
        });
        i = rawUrl.nextIndex;
        continue;
      }
    }

    appendToBuffer(text[i], i);
    i += 1;
  }

  flushBuffer();
}

function tableCellIndentColumns(text: string): number {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? '';
  return countColumn(indent, 4);
}

function parseTableCellListItem(line: TableCellLogicalLine) {
  const marker = readMarkdownListPrefix(line.text);
  if (!marker || marker.toOffset === marker.markerEndOffset) return null;
  const contentOffset = marker.taskBracketStart ?? marker.toOffset;
  return {
    indentColumns: tableCellIndentColumns(marker.leadingWhitespace),
    type: marker.bullet ? 'ul' : 'ol',
    start: marker.orderedNumber ? Number.parseInt(marker.orderedNumber, 10) : 1,
    content: line.text.slice(contentOffset),
    contentFrom: line.from + contentOffset
  } as const;
}

function parseTableCellQuotePrefix(line: TableCellLogicalLine, maxIndentColumns = 3) {
  let text = line.text;
  let from = line.from;
  const indents: number[] = [];
  while (true) {
    const match = tableCellQuotePrefixRe.exec(text);
    if (!match || tableCellIndentColumns(match[1]) > maxIndentColumns) break;
    indents.push(tableCellIndentColumns(match[1]));
    text = text.slice(match[0].length);
    from += match[0].length;
  }
  return { line: { text, from, breakText: line.breakText }, indents };
}

function hasTableCellLineStructure(text: string): boolean {
  const line = { text, from: 0, breakText: '' };
  return parseTableCellListItem(line) !== null || (tableCellQuotePrefixRe.test(text)
    && parseTableCellQuotePrefix(line).indents.length > 0);
}

function canProjectTableCellLines(value: string): boolean {
  return value.includes('\n') || hasTableCellLineStructure(value) || /[*_~^=`[$<#\\]|:\/\/|mailto:|file:|www\./.test(value);
}

function tableCellPrefixMarkers(prefix: string): TableCellRange[] {
  // The rendered prefix can contain several markers, such as "> 2. ".
  // Keep their shared edges out of the editable interior of either marker.
  const markers: TableCellRange[] = [];
  for (let offset = 0; offset < prefix.length;) {
    const quote = tableCellQuotePrefixRe.exec(prefix.slice(offset));
    if (quote) {
      const end = offset + quote[0].length;
      markers.push({ from: offset + quote[1].length, to: end });
      offset = end;
    } else {
      const list = readMarkdownListPrefix(prefix, offset);
      if (!list) break;
      markers.push({ from: list.fromOffset, to: list.toOffset });
      offset = list.toOffset;
    }
  }
  return markers;
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
  presentationFactory: ImagePresentationFactory,
  uiLanguage: UiLanguage,
  view: EditorView,
  sourceLine: TableCellLogicalLine | null = null,
  reusableImages?: ReusableTablePreviewImages
) {
  type ListEntry = { indentColumns: number; type: 'ul' | 'ol'; list: HTMLUListElement | HTMLOListElement; lastItem: HTMLLIElement | null };
  const listsByParent = new WeakMap<HTMLElement, ListEntry[]>();
  const quoteStack: HTMLElement[] = [];
  const listStackFor = (parent: HTMLElement): ListEntry[] => {
    let stack = listsByParent.get(parent);
    if (!stack) {
      stack = [];
      listsByParent.set(parent, stack);
    }
    return stack;
  };
  const appendListItem = (list: HTMLUListElement | HTMLOListElement, item: HTMLLIElement) => {
    list.appendChild(item);
    if (list instanceof HTMLOListElement) {
      const widestNumber = list.start + list.children.length - 1;
      list.style.setProperty('--meo-table-list-digits', String(String(widestNumber).length));
    }
  };
  const appendInline = (parent: HTMLElement, content: string, baseOffset: number) => {
    appendTableInlinePreviewNodes(parent, content, {
      baseOffset,
      diagnostics,
      searchState,
      sourceRange,
      presentationFactory,
      uiLanguage,
      view,
      reusableImages
    });
  };

  const appendAlertContent = (parent: HTMLElement, content: string, from: number): boolean => {
    if (parent.tagName !== 'BLOCKQUOTE' || parent.hasChildNodes()) return false;
    const alert = readMarkdownAlertDirective(content);
    if (!alert) return false;
    const syntax = parseTableInlineSyntax(content, from, view.state.facet(latexDelimitersFacet));
    if (parseTableInlineMarkdownLink(content, 0, syntax, from, { referenceState: view.state })) return false;
    parent.classList.add('meo-md-alert-' + alert.type.toLowerCase());
    const header = document.createElement('div');
    header.appendChild(new AlertIconWidget(alert.type).toDOM(view));
    parent.appendChild(header);
    const body = content.slice(alert.length).trimStart();
    if (body) appendInline(parent, body, from + content.length - body.length);
    return true;
  };

  const appendTaskContent = (
    parent: HTMLElement, content: string, from: number, activeLine: TableCellLogicalLine | null
  ) => {
    const task = markdownTaskContentPrefix.exec(content);
    if (task && parent instanceof HTMLLIElement) {
      const status = task[1].toLowerCase() === 'x' ? 'done' : 'todo';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.disabled = true;
      checkbox.checked = status === 'done';
      checkbox.className = `meo-task-checkbox meo-md-html-table-cell-task-checkbox is-${status}`;
      setInlineSourceRange(checkbox, { from, to: from + task[0].length }, { atomic: true });
      parent.classList.add('meo-md-html-table-cell-task', `is-${status}`);
      const taskBodyFrom = from + task[0].length;
      const row = document.createElement('div');
      row.className = 'meo-md-table-task-content';
      row.appendChild(checkbox);
      if (activeLine) {
        appendTableCellSourceLine(row, activeLine, taskBodyFrom, appendInline);
      } else {
        const body = document.createElement('div');
        appendInline(body, content.slice(task[0].length), taskBodyFrom);
        row.appendChild(body);
      }
      parent.appendChild(row);
      return;
    }
    if (activeLine) appendTableCellSourceLine(parent, activeLine, from, appendInline);
    else appendInline(parent, content, from);
  };

  const appendItemContent = (
    parent: HTMLLIElement, content: string, from: number,
    baseQuoteDepth: number, contentColumn: number, activeLine: TableCellLogicalLine | null
  ): ListEntry[] => {
    if (activeLine) parent.classList.add('meo-md-table-active-list-item');
    const nestedQuote = parseTableCellQuotePrefix({ text: content, from, breakText: '' });
    let quoteParent: HTMLElement = parent;
    for (let depth = 0; depth < nestedQuote.indents.length; depth += 1) {
      const quote = document.createElement('blockquote');
      quote.className = 'meo-md-html-table-cell-quote';
      quoteParent.appendChild(quote);
      quoteParent = quote;
      quoteStack[baseQuoteDepth + depth] = quote;
    }
    quoteStack.length = baseQuoteDepth + nestedQuote.indents.length;
    const nestedItem = parseTableCellListItem(nestedQuote.line);
    if (!nestedItem) {
      if (activeLine || !appendAlertContent(quoteParent, nestedQuote.line.text, nestedQuote.line.from)) {
        appendTaskContent(quoteParent, nestedQuote.line.text, nestedQuote.line.from, activeLine);
      }
      return [];
    }
    const list = document.createElement(nestedItem.type);
    list.className = 'meo-md-html-table-cell-list';
    if (list instanceof HTMLOListElement && nestedItem.start !== 1) list.start = nestedItem.start;
    const child = document.createElement('li');
    const prefix = nestedQuote.line.text.slice(0, nestedItem.contentFrom - nestedQuote.line.from);
    const column = nestedQuote.indents.length ? 0 : contentColumn;
    const nextContentColumn = countColumn(' '.repeat(column) + prefix, 4);
    const descendants = appendItemContent(child, nestedItem.content, nestedItem.contentFrom,
      baseQuoteDepth + nestedQuote.indents.length, nextContentColumn, activeLine);
    appendListItem(list, child);
    quoteParent.appendChild(list);
    const entry: ListEntry = {
      indentColumns: column + nestedItem.indentColumns, type: nestedItem.type, list, lastItem: child
    };
    if (nestedQuote.indents.length) {
      listStackFor(quoteParent).push(entry, ...descendants);
      return [];
    }
    // Same-line list levels also participate in the next logical line's stack;
    // a continuation must keep its innermost item and ordered sequence.
    return [entry, ...descendants];
  };

  for (const logicalLine of splitTableCellLogicalLines(text)) {
    const activeLine = sourceLine?.from === logicalLine.from ? sourceLine : null;
    const hasContainingList = listStackFor(previewEl).length > 0
      || quoteStack.some(quote => listStackFor(quote).length > 0);
    const quoted = parseTableCellQuotePrefix(logicalLine, hasContainingList ? Infinity : 3);
    let parent: HTMLElement = previewEl;
    for (let depth = 0; depth < quoted.indents.length; depth += 1) {
      const previousList = listStackFor(parent).at(-1);
      const quoteParent = previousList?.lastItem && quoted.indents[depth] > previousList.indentColumns
        ? previousList.lastItem : parent;
      if (quoteParent === parent) listStackFor(parent).length = 0;
      let quote = quoteStack[depth];
      if (!quote || quote.parentElement !== quoteParent) {
        quoteStack.length = depth;
        quote = document.createElement('blockquote');
        quote.className = 'meo-md-html-table-cell-quote';
        quoteParent.appendChild(quote);
        quoteStack[depth] = quote;
      }
      parent = quote;
    }
    quoteStack.length = quoted.indents.length;
    const line = quoted.line;
    const listStack = listStackFor(parent);
    const item = parseTableCellListItem(line);
    if (!item) {
      // A blank logical line loosens a list instead of resetting its numbering.
      // Keep the spacer in the previous item so subsequent items stay in order.
      if (!line.text.trim() && listStack.at(-1)?.lastItem) {
        const item = listStack.at(-1)!.lastItem!;
        if (activeLine) appendTableCellSourceLine(item, activeLine, line.from, appendInline);
        else {
          const spacer = document.createElement('br');
          setInlineSourceRange(spacer, { from: logicalLine.from, to: logicalLine.from }, { atomic: true });
          item.appendChild(spacer);
        }
        continue;
      }
      if (!activeLine && appendAlertContent(parent, line.text, line.from)) continue;
      const indentColumns = tableCellIndentColumns(line.text);
      let contentParent: HTMLElement = parent;
      if (line.text.trim() && indentColumns > 0) {
        for (let index = listStack.length - 1; index >= 0; index -= 1) {
          const entry = listStack[index];
          if (entry.lastItem && indentColumns > entry.indentColumns) {
            listStack.length = index + 1;
            contentParent = entry.lastItem;
            break;
          }
        }
      }
      if (contentParent === parent) listStack.length = 0;
      if (activeLine) appendTableCellSourceLine(contentParent, activeLine, line.from, appendInline);
      else {
        const lineEl = document.createElement('div');
        lineEl.className = 'meo-md-html-table-cell-line';
        appendInline(lineEl, line.text, line.from);
        if (!line.text) {
          setInlineSourceRange(lineEl, { from: logicalLine.from, to: logicalLine.from });
          lineEl.appendChild(document.createElement('br'));
        }
        contentParent.appendChild(lineEl);
      }
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
      const listParent = level > 0 ? listStack[level - 1]?.lastItem : parent;
      if (!(listParent instanceof HTMLElement)) {
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
        list.style.setProperty('--meo-table-list-indent', `${Math.max(2, item.indentColumns - parentIndent)}ch`);
      }
      (level > 0 ? listStack[level - 1].lastItem! : parent).appendChild(list);
      entry = { indentColumns: item.indentColumns, type: item.type, list, lastItem: null };
      listStack[level] = entry;
    }

    const listItem = document.createElement('li');
    const contentColumn = countColumn(line.text.slice(0, item.contentFrom - line.from), 4);
    const descendants = appendItemContent(listItem, item.content, item.contentFrom,
      quoted.indents.length, contentColumn, activeLine);
    appendListItem(entry.list, listItem);
    entry.lastItem = listItem;
    listStack.length = level + 1;
    listStack.push(...descendants);
  }
}

function renderTableCellInlinePreview(
  previewEl: HTMLElement,
  value: string,
  diagnostics: TableCellDiagnostics[] = [],
  searchState: TableSearchState | null = null,
  sourceRange: TableCellRange | null,
  presentationFactory: ImagePresentationFactory,
  uiLanguage: UiLanguage,
  view: EditorView,
  sourceLine: TableCellLogicalLine | null = null
) {
  if (!(previewEl instanceof HTMLElement)) return;
  const text = value ?? '';
  const isSearchExpanded = shouldExpandTableCellForSearch(text, searchState);
  previewEl.classList.toggle('is-search-expanded', isSearchExpanded);
  previewEl.parentElement?.classList.toggle('has-search-match', isSearchExpanded);
  if (isSearchExpanded) {
    disposeImagePresentations(previewEl);
    previewEl.replaceChildren();
    appendTableCellSourcePreview(previewEl, text, diagnostics, searchState, sourceRange);
    return;
  }
  const reusableImages: ReusableTablePreviewImages = new Map();
  for (const image of previewEl.querySelectorAll<HTMLElement>('.meo-md-image')) {
    const identity = tablePreviewImageIdentity.get(image);
    if (identity?.factory !== presentationFactory) continue;
    const matches = reusableImages.get(identity.key) ?? [];
    matches.push(image);
    reusableImages.set(identity.key, matches);
  }
  const rendered = reusableImages.size ? document.createElement('div') : previewEl;
  if (rendered === previewEl && previewEl.hasChildNodes()) {
    disposeImagePresentations(previewEl);
    previewEl.replaceChildren();
  }
  appendTableCellRenderedPreview(
    rendered,
    text,
    diagnostics,
    searchState,
    sourceRange,
    presentationFactory,
    uiLanguage,
    view,
    sourceLine,
    reusableImages
  );
  if (rendered !== previewEl) {
    disposeImagePresentations(previewEl);
    previewEl.replaceChildren(...rendered.childNodes);
  }
}

function consumeTableInlineProtectedSpan(text: string, index: number, endIndex: number, syntax: ReturnType<typeof parseTableInlineSyntax> | null): number | null {
  const code = syntax?.codes.get(index);
  if (code && code.to <= endIndex) return code.to;
  const reference = parseWikiReference(text, index);
  if (reference && reference.to <= endIndex) return reference.to;

  const kbd = text[index] === '<' && !isTableInlineEscaped(text, index) ? parseKbdTagAt(text, index) : null;
  if (kbd && kbd.nextIndex <= endIndex) return kbd.nextIndex;

  const wiki = parseTableInlineWikiLink(text, index);
  if (wiki && wiki.nextIndex <= endIndex) return wiki.nextIndex;

  const image = parseTableInlineMarkdownLink(text, index, syntax, 0, { image: true });
  if (image && image.nextIndex <= endIndex) return image.nextIndex;

  const link = parseTableInlineMarkdownLink(text, index, syntax, 0);
  if (link && link.nextIndex <= endIndex) return link.nextIndex;

  const angle = consumeTableInlineAngleSection(text, index);
  if (angle && angle.nextIndex <= endIndex) return angle.nextIndex;

  if (text[index] === '\\' && index + 1 < endIndex) return index + 2;
  return null;
}

function parseTableRowCells(lineText: string, lineFrom = 0): ParsedTableRowCells {
  const quoted = parseTableCellQuotePrefix({ text: lineText, from: lineFrom, breakText: '' });
  if (quoted.indents.length) {
    lineText = quoted.line.text;
    lineFrom = quoted.line.from;
  }
  const leadingWhitespaceLen = /^(\s*)/.exec(lineText)?.[1].length ?? 0;
  let contentStart = leadingWhitespaceLen;
  let contentEnd = lineText.length;
  while (contentStart < contentEnd && /\s/.test(lineText[contentStart])) contentStart += 1;
  while (contentEnd > contentStart && /\s/.test(lineText[contentEnd - 1])) contentEnd -= 1;

  let innerStart = contentStart;
  let innerEnd = contentEnd;
  if (innerStart < innerEnd && lineText[innerStart] === '|') innerStart += 1;
  if (innerEnd > innerStart && lineText[innerEnd - 1] === '|' && !isTableInlineEscaped(lineText, innerEnd - 1)) innerEnd -= 1;

  const allSeparatorPipes = markdownTableSeparatorPipes(lineText);
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
    const empty = to <= from;
    segments.push({ from: lineFrom + (empty ? rawFrom : from), to: lineFrom + (empty ? rawTo : to),
      rawFrom: lineFrom + rawFrom, rawTo: lineFrom + rawTo, cellIndex: i, empty });
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
  const prefix = parseBlockLinePrefix(text);
  const content = { text: prefix.content, from: from + prefix.prefix.length };
  const { cells, pipes, segments } = parseTableRowCells(content.text, content.from);
  return { lineNo, from, to, text: content.text, cells, pipes, segments };
}

/** Undefined leaves insertion in the document editor; null denotes an unsafe table target. */
function sourceTableSnippetTarget(state: EditorState): { header: boolean } | null | undefined {
  const { main, ranges } = state.selection;
  const tree = ensureSyntaxTree(state, state.doc.lineAt(ranges.at(-1)!.to).to, 8);
  if (!tree) return null;
  const tableAt = (position: number, side: -1 | 1) => {
    let node: SyntaxNode | null = tree.resolveInner(position, side);
    while (node && node.name !== 'Table') node = node.parent;
    return node;
  };
  const table = tableAt(main.head, -1) ?? tableAt(main.head, 1);
  if (!table) {
    for (const range of ranges) {
      if (tableAt(range.head, -1) || tableAt(range.head, 1)) return null;
      let intersects = false;
      if (!range.empty) tree.iterate({ from: range.from, to: range.to, enter(node) {
        if (node.name === 'Table' && node.from < range.to && node.to > range.from) intersects = true;
        return !intersects;
      } });
      if (intersects) return null;
    }
    return undefined;
  }
  if (ranges.length !== 1 || main.from < table.from || main.to > table.to) return null;
  const line = state.doc.lineAt(main.head);
  const firstLine = state.doc.lineAt(table.from).number;
  if (line.number === firstLine + 1 || main.from < line.from || main.to > line.to) return null;
  const inCell = parseTableLine(line.number, line.from, line.to, line.text).segments
    .some(({ rawFrom, rawTo }) => rawFrom <= main.from && main.to <= rawTo);
  return inCell ? { header: line.number === firstLine } : null;
}

function tableSnippetPreservesRow(line: string, from: number, to: number, insert: string, header: boolean): boolean {
  if (/[\r\n]/.test(insert)) return false;
  const changed = line.slice(0, from) + insert + line.slice(to);
  const before = parseTableLine(0, 0, line.length, line);
  const after = parseTableLine(0, 0, changed.length, changed);
  const prefix = line.length - before.text.length;
  const start = from - prefix;
  const end = to - prefix;
  return prefix === changed.length - after.text.length && (!header || !isTableDelimiterLine(after.text))
    && before.cells.length === after.cells.length && before.pipes.length === after.pipes.length
    && before.pipes.every((pipe, index) => (pipe < start || pipe >= end)
      && after.pipes[index] === (pipe < start ? pipe : pipe + insert.length - (to - from)));
}

export function isSafeCustomShortcutSelection(state: EditorState): boolean {
  return sourceTableSnippetTarget(state) !== null;
}

type ShortcutSnippetPlan = { kind: 'document' } | ({ kind: 'sourceCell' } & SourceCellSnippetEdit)
  | { kind: 'liveCell'; input: HTMLTextAreaElement; value: string; caret: number };

/** Check the actual selection before the key is claimed, and again when the step runs. */
export function planShortcutSnippet(view: EditorView, template: string, documentId: string, input: HTMLTextAreaElement | null): ShortcutSnippetPlan | null {
  if (view.state.readOnly || view.compositionStarted || (input ? input.readOnly || input.disabled : !view.hasFocus)) return null;
  const target = input ? null : sourceTableSnippetTarget(view.state);
  if (!input && target === undefined) return { kind: 'document' };
  if (!input && !target) return null;

  const { from, to } = view.state.selection.main;
  const start = input?.selectionStart ?? from;
  const end = input?.selectionEnd ?? to;
  const selection = input ? input.value.slice(start, end) : view.state.sliceDoc(from, to);
  const expanded = expandTableShortcutSnippet(template, documentId, selection);
  if (!expanded) return null;
  const source = tableCellEditorValueToSource(expanded.text);
  const sourceCursor = tableCellEditorOffsetToSourceOffset(expanded.text, expanded.caret);
  const pipes = markdownTableSeparatorPipes(source);
  let text = '';
  let offset = 0;
  for (const pipe of pipes) {
    text += source.slice(offset, pipe) + '\\';
    offset = pipe;
  }
  text += source.slice(offset);
  const caret = Math.min(text.length, sourceCursor + pipes.filter(pipe => pipe < sourceCursor).length);

  if (input) {
    const range = tableCellSourceRangeForInput(view, input);
    if (!range) return null;
    const currentSource = tableCellEditorValueToSource(input.value);
    const sourceStart = tableCellEditorOffsetToSourceOffset(input.value, start);
    const sourceEnd = tableCellEditorOffsetToSourceOffset(input.value, end);
    const nextSource = currentSource.slice(0, sourceStart) + text + currentSource.slice(sourceEnd);
    if (/[\r\n]/.test(nextSource) || markdownTableSeparatorPipes(nextSource).length) return null;
    const line = view.state.doc.lineAt(range.from);
    // A normalized blank cell can exist in Live before its short source row contains it.
    if (!(range.from === line.from && range.to === line.from) && !tableSnippetPreservesRow(line.text,
      range.from - line.from, range.to - line.from, nextSource.trim(), input.dataset.tableRow === '0')) return null;
    return { kind: 'liveCell', input, value: tableCellSourceToEditorValue(nextSource),
      caret: tableCellDisplayOffset(nextSource, sourceStart + caret) };
  }

  const line = view.state.doc.lineAt(from);
  return target && tableSnippetPreservesRow(line.text, from - line.from, to - line.from, text, target.header)
    ? { kind: 'sourceCell', from, to, text, caret: from + caret } : null;
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
    const parsed = parseTableLine(lineNo, line.from, line.to, text);
    if (delimiterIdx === -1 && isTableDelimiterLine(parsed.text)) {
      delimiterIdx = lines.length;
    }
    lines.push(parsed);
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
  // Body cells beyond the header width are ignored, rather than adding columns.
  const colCount = Math.max(
    headerLine?.cells.length ?? 0,
    alignments.length
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

function tableWidthIdentity(tableData: WidgetTableData): string {
  return JSON.stringify({
    colCount: tableData.colCount,
    alignments: tableData.alignments
  });
}

function buildWidgetTableData(
  state: EditorState,
  data: BuiltTableData,
  diagnostics: EditorDiagnostic[] = [],
  diffLineFlags: readonly (TableDiffFlags | undefined)[] | null | undefined = null
): WidgetTableData | null {
  const { from, to, headerLine, dataLines, alignments, colCount, startLine, endLine } = data;
  if (colCount === 0 || !headerLine) return null;
  const sourceHeader = state.doc.sliceString(headerLine.from, headerLine.to);
  const indent = parseBlockLinePrefix(sourceHeader, state.tabSize).prefix;
  const blockIndent = indent ? getLiveBlockIndent(state, headerLine.from + indent.length) : null;
  const visualIndent = blockIndent && (blockIndent.footnoteNumber !== null || blockIndent.quoteColumns?.length || blockIndent.taskIndent?.checkboxes)
    ? blockIndent : tableCellIndentColumns(indent);
  const normalizedAlignments = normalizeRow(alignments, colCount, '').map((value) => value ?? null);
  const headerCells = normalizeRow(headerLine.cells, colCount, '');
  const rows = dataLines.map((line) => normalizeRow(line.cells, colCount, ''));
  const diffFlagsByLine = collectTableDiffFlags(data, diffLineFlags);
  const comparison = state.facet(gitDiffLineFlagsFacet);
  const tableDiagnostics = collectTableDiagnostics(data, diagnostics);
  const cells = [headerCells, ...rows];
  const hasReferenceCandidate = cells.some(row => row.some(cell => possibleTableReferenceLink.test(cell)));
  const hasFootnoteCandidate = cells.some(row => row.some(cell => /\[\^|\^\[/.test(cell)));
  return {
    from,
    to,
    indent,
    visualIndent,
    colCount,
    alignments: normalizedAlignments,
    headerCells,
    rows,
    signature: JSON.stringify({
      latexDelimiters: state.facet(latexDelimitersFacet),
      colCount,
      headerCells,
      rows,
      normalizedAlignments,
      diagnostics: tableDiagnostics,
      diffFlagsByLine,
      referenceTargets: hasReferenceCandidate ? markdownReferenceTargetSignature(state) : undefined,
      footnoteReferences: !hasFootnoteCandidate ? [] : parseFootnotes(state).references
        .filter(reference => reference.from >= from && reference.to <= to)
        // Click handlers resolve the current definition by label. Its absolute
        // position is not table content and must not invalidate measured DOM.
        .map(reference => [reference.from - from, reference.number])
    }),
    startLine,
    endLine,
    diagnostics: tableDiagnostics,
    sourceRanges: collectTableSourceRanges(data),
    diffBaseline: comparison?.lines === diffLineFlags ? comparison.baseline : undefined,
    diffFlagsByLine
  };
}

const mountedTableWidgets = new WeakMap<EditorView, Set<HtmlTableController>>();
const tableDomOwners = new WeakMap<HTMLElement, HtmlTableController>();

const tableLineNumberSelector = ':scope > .cm-gutters > .cm-lineNumbers';

type TableLineNumberMeasurement = {
  gutter: HTMLElement | null;
  gutterWidth: number;
  rows: Map<number, { text: string; top: number; active: boolean }>;
};

/** The gutter outlives individual tables. CodeMirror may replace a table DOM
 * while reconciling the document or its viewport. Keep the accepted labels
 * attached until the next measurement can see the new, connected rows. */
export const tableLineNumbers = ViewPlugin.fromClass(class {
  private disposed = false;
  private layer: HTMLElement | undefined;
  private readonly labels = new Map<number, HTMLElement>();

  constructor(private readonly view: EditorView) {}

  private readonly measure = {
    read: (view: EditorView): TableLineNumberMeasurement | null => {
      if (this.disposed) return null;
      const gutter = view.scrollDOM.querySelector<HTMLElement>(tableLineNumberSelector);
      const rows: TableLineNumberMeasurement['rows'] = new Map();
      let gutterWidth = 0;
      const widgets = mountedTableWidgets.get(view);
      if (gutter && widgets?.size) {
        const { top, width } = gutter.getBoundingClientRect();
        gutterWidth = width;
        const tables = [...widgets].sort((left, right) => left.tableData.startLine - right.tableData.startLine);
        for (const table of tables) {
          if (!table.domRefs?.shell.isConnected) continue;
          const anchor = table.cellSelection.snapshot().anchor?.row;
          for (const { row, rowIndex } of table.tableRowsForGutter()) {
            const number = Number(row.dataset.sourceLineNumber);
            if (!number || number > view.state.doc.lines) continue;
            const text = formatSourceLineNumber(number, view.state);
            if (text) rows.set(number, { text, top: row.getBoundingClientRect().top - top, active: rowIndex === anchor });
          }
        }
      }
      return { gutter, gutterWidth, rows };
    },
    write: (measurement: TableLineNumberMeasurement | null) => {
      if (this.disposed || !measurement) return;
      const { gutter, gutterWidth, rows } = measurement;
      for (const [number, label] of this.labels) {
        if (rows.has(number)) continue;
        label.remove();
        this.labels.delete(number);
      }
      if (!gutter || !rows.size) {
        this.layer?.remove();
        return;
      }
      const doc = gutter.ownerDocument;
      if (!this.layer) {
        this.layer = doc.createElement('div');
        this.layer.className = 'meo-md-html-table-line-numbers';
      }
      if (this.layer.parentElement !== gutter) gutter.appendChild(this.layer);
      const width = `${gutterWidth}px`;
      if (this.layer.style.width !== width) this.layer.style.width = width;
      let next = this.layer.firstChild;
      for (const [number, { text, top, active }] of rows) {
        let label = this.labels.get(number);
        if (!label) {
          label = doc.createElement('div');
          label.className = 'meo-md-html-table-line-number';
          this.labels.set(number, label);
        }
        if (label === next) next = next.nextSibling;
        else this.layer.insertBefore(label, next);
        if (label.textContent !== text) label.textContent = text;
        const position = `${top}px`;
        if (label.style.top !== position) label.style.top = position;
        label.classList.toggle('is-active', active);
      }
    }
  };

  request({ beforePaint = false } = {}): void {
    if (!this.labels.size && this.view.state.facet(sourceLineNumberModeFacet) === 'off') return;
    this.view.requestMeasure(this.measure);
    if (beforePaint) commitObservedEditorSize(this.view);
  }

  update(update: ViewUpdate): void {
    if (!this.labels.size && !mountedTableWidgets.get(update.view)?.size) return;
    const mode = update.state.facet(sourceLineNumberModeFacet);
    if (mode !== update.startState.facet(sourceLineNumberModeFacet) || update.viewportChanged
        || !update.docChanged && update.geometryChanged
        || mode !== 'on' && mode !== 'off' && (update.selectionSet || update.docChanged)) {
      this.request();
    }
  }

  destroy(): void {
    this.disposed = true;
    this.layer?.remove();
    this.labels.clear();
  }
});

export function focusMountedTableInput(input: Element | null): boolean {
  if (!(input instanceof HTMLTextAreaElement)) return false;
  const shell = input.closest<HTMLElement>('.meo-md-html-table-shell');
  return !!shell && tableDomOwners.get(shell)?.focusTableInput(input) === true;
}
const cellPreviewSignatures = new WeakMap<WidgetTableData, string>();

/** Navigation names a source cell; the reading projection mounts it on demand. */
export function ensureMountedTableCell(view: EditorView, startLine: number, row: number, col: number): HTMLTextAreaElement | undefined {
  const shell = view.dom.querySelector<HTMLElement>(`.meo-md-html-table-shell[data-meo-rendered-block-start-line="${startLine}"]`);
  return shell ? tableDomOwners.get(shell)?.cellInput(row, col) : undefined;
}

/** Source navigation can address a row that has never had cell DOM. */
export function mountedTableInputsForLine(view: EditorView, line: number): readonly HTMLTextAreaElement[] {
  for (const owner of mountedTableWidgets.get(view) ?? []) {
    const start = owner.tableData.startLine;
    if (line < start || line > owner.tableData.endLine || line === start + 1) continue;
    const row = line === start ? 0 : line - start - 1;
    owner.cellInput(row, 0);
    return owner.domRefs?.allRowInputs[row] ?? [];
  }
  return [];
}

export function mountedTableEntryInput(wrap: HTMLElement, direction: 'up' | 'down'): HTMLTextAreaElement | undefined {
  const shell = wrap.closest<HTMLElement>('.meo-md-html-table-shell');
  const owner = shell ? tableDomOwners.get(shell) : undefined;
  return owner?.cellInput(direction === 'down' ? 0 : owner.tableData.rows.length,
    direction === 'down' ? 0 : owner.tableData.colCount - 1);
}

function cellPreviewSignature(data: WidgetTableData): string {
  let signature = cellPreviewSignatures.get(data);
  if (signature === undefined) {
    const { diffFlagsByLine: _diff, ...presentation } = JSON.parse(data.signature);
    signature = JSON.stringify(presentation);
    cellPreviewSignatures.set(data, signature);
  }
  return signature;
}

/** Ends native cell presentation when document navigation supersedes its return point. */
export function endTableCellEditing(view: EditorView): void {
  for (const widget of mountedTableWidgets.get(view) ?? []) {
    if (widget.cellInteraction.snapshot().editingTarget) widget.clearSelection('external');
  }
}

/**
 * The editor owns the recovery publication boundary; tables only report that
 * their native input projection changed. The callback is scoped to one
 * CodeMirror state rather than a document-wide DOM event bus.
 */
export type TablePendingDraftProjectionReporter = (view: EditorView) => void;
export const tablePendingDraftProjectionReporterFacet = Facet.define<
  TablePendingDraftProjectionReporter,
  TablePendingDraftProjectionReporter | null
>({ combine: values => values.at(-1) ?? null });

/**
 * Build the pending native-cell projection from the current CodeMirror source.
 * Only mounted controllers with pending input participate; cell line breaks
 * serialize as `<br>`, so these changes cannot move later table line numbers.
 */
export function pendingTableDraftProjectionChanges(view: EditorView): ChangeSet | null {
  const edits = Array.from(mountedTableWidgets.get(view) ?? [])
    .flatMap(controller => controller.pendingRecoveryEdits(view))
    .sort((left, right) => left.edit.sequence - right.edit.sequence);
  if (edits.length === 0) return ChangeSet.empty(view.state.doc.length);

  let source: CodeMirrorText = view.state.doc;
  let projection = ChangeSet.empty(source.length);
  for (const { controller, edit, tableStartLine } of edits) {
    const change = controller.pendingCellSourceChange({ doc: source }, edit, tableStartLine);
    if (!change) continue;
    const step = ChangeSet.of(change, source.length);
    source = step.apply(source);
    projection = projection.compose(step);
  }
  return projection;
}

/** Retain a table gesture or its accepted cell range across native focus restoration. */
export function restoreTablePointerSelection(view: EditorView, includeCompletedRange = false): void {
  for (const widget of mountedTableWidgets.get(view) ?? []) {
    const { phase } = widget.cellSelection.snapshot();
    if (phase === 'text-candidate') {
      widget.projectPointerTextSelection(widget.selectionDomHead);
      return;
    }
    if ((phase === 'dragging' || includeCompletedRange && phase === 'persisted' &&
      widget.cellSelection.selectedCellRange()) && widget.domRefs) {
      widget.setTableInteractionActive(widget.domRefs.wrap, true);
      widget.domRefs.table.focus({ preventScroll: true });
      return;
    }
  }
}

export function refreshMountedTablePositions(
  view: EditorView,
  diagnostics: EditorDiagnostic[] = [],
  diffLineFlags: readonly (TableDiffFlags | undefined)[] | null | undefined = null
): void {
  const widgets = mountedTableWidgets.get(view);
  if (!widgets) return;
  for (const widget of widgets) widget.refreshCurrentPosition(view, diagnostics, diffLineFlags);
}

/** Maps unaffected mounted tables before consumers read their visible positions.
 * Deferred input keeps the DOM and native cell/composition state intact. */
export function projectMountedTablePositions(view: EditorView, changes: ChangeDesc): void {
  for (const widget of mountedTableWidgets.get(view) ?? []) widget.projectPosition(view.state, changes);
}

export function refreshMountedTableUiLanguage(view: EditorView, language: UiLanguage): void {
  const widgets = mountedTableWidgets.get(view);
  if (!widgets) return;
  for (const widget of widgets) widget.refreshUiLanguage(language);
}

export function scheduleMountedTableRowSizing(view: EditorView): void {
  for (const widget of mountedTableWidgets.get(view) ?? []) widget.scheduleLayout({ resizeRows: true });
}

/** Completes attached table geometry before a mode transition exposes the editor. */
export function flushMountedTableLayouts(view: EditorView): boolean {
  const widgets = mountedTableWidgets.get(view);
  if (!widgets) return false;
  let flushed = false;
  for (const widget of widgets) flushed = widget.flushPendingLayout() || flushed;
  return flushed;
}

function sameTableSourceRanges(left: TableCellRange[][] | undefined, right: TableCellRange[][] | undefined): boolean {
  if (left === right) return true;
  if (!left || !right || left.length !== right.length) return false;
  for (let row = 0; row < left.length; row++) {
    if (left[row].length !== right[row].length) return false;
    for (let cell = 0; cell < left[row].length; cell++) {
      if (left[row][cell].from !== right[row][cell].from || left[row][cell].to !== right[row][cell].to) return false;
    }
  }
  return true;
}

function sameTableShape(left: WidgetTableData, right: WidgetTableData): boolean {
  return left.indent === right.indent
    && liveBlockIndentKey(left.visualIndent) === liveBlockIndentKey(right.visualIndent)
    && left.colCount === right.colCount && left.headerCells.length === right.headerCells.length
    && left.rows.length === right.rows.length
    && left.rows.every((row, index) => row.length === right.rows[index]?.length)
    && left.alignments.every((alignment, index) => alignment === right.alignments[index]);
}

function tablePreviewHeight(data: WidgetTableData): RenderedBlockPreviewHeight {
  return new RenderedBlockPreviewHeight(JSON.stringify([
    'table', data.indent, liveBlockIndentKey(data.visualIndent), data.colCount,
    data.headerCells.length, data.rows.map(row => row.length), data.alignments
  ]));
}

/** A decoration is an immutable source value, even when TileCache recycles its DOM. */
class HtmlTableWidget extends UiLanguageSensitiveWidget {
  private measuredHeightCache: RenderedBlockPreviewHeight;
  private mountedController: WeakRef<HtmlTableController> | undefined;
  private replacedRowWindow: WeakRef<HtmlTableController> | undefined;

  constructor(
    readonly tableData: WidgetTableData,
    readonly stickyHeaderAdapterFactory: TableStickyHeaderAdapterFactory,
    readonly tableCommandEnvironment: TableCommandEnvironment
  ) {
    super();
    this.measuredHeightCache = tablePreviewHeight(tableData);
  }

  get [renderedBlockPreviewHeight](): RenderedBlockPreviewHeight { return this.measuredHeightCache; }
  get measuredHeight(): number { return this.measuredHeightCache.height; }
  get estimatedHeight(): number {
    return estimateBlockWidgetHeight({ kind: 'table', headerCells: this.tableData.headerCells,
      rows: this.tableData.rows, measuredHeight: this.measuredHeight });
  }

  [mapLiveWidgetPositions](changes: ChangeDesc, state: EditorState): WidgetType {
    const previous = this.tableData;
    const from = changes.mapPos(previous.from, 1), to = changes.mapPos(previous.to, -1);
    // The eligibility proof keeps this table's contents and global references
    // unchanged. Edits above it can still move both offsets and source lines.
    const startLine = state.doc.lineAt(from).number, endLine = state.doc.lineAt(Math.max(from, to - 1)).number;
    const delta = startLine - previous.startLine;
    const diffFlagsByLine = previous.diffFlagsByLine && Object.fromEntries(Object.entries(previous.diffFlagsByLine)
      .map(([line, flags]) => [Number(line) + delta, flags]));
    const signature = JSON.parse(previous.signature);
    signature.diffFlagsByLine = diffFlagsByLine;
    const nextSignature = JSON.stringify(signature);
    if (from === previous.from && to === previous.to && startLine === previous.startLine && endLine === previous.endLine && nextSignature === previous.signature) return this;
    const next = new HtmlTableWidget({ ...previous, from, to, startLine, endLine, diffFlagsByLine, signature: nextSignature,
      sourceRanges: previous.sourceRanges?.map(row => row.map(range => ({ ...range,
        from: changes.mapPos(range.from, 1), to: changes.mapPos(range.to, -1) })))
    }, this.stickyHeaderAdapterFactory, this.tableCommandEnvironment);
    next.measuredHeightCache = this.measuredHeightCache;
    next.mountedController = this.mountedController;
    return next;
  }

  private currentController(): HtmlTableController | undefined {
    const owner = this.mountedController?.deref();
    return owner?.domRefs?.shell.isConnected && owner.tableData.from === this.tableData.from
      && owner.tableData.to === this.tableData.to && owner.tableData.signature === this.tableData.signature ? owner : undefined;
  }

  eq(other: WidgetType): boolean {
    if (!(other instanceof HtmlTableWidget) || !this.hasSameUiLanguageEpoch(other)
      || this.stickyHeaderAdapterFactory !== other.stickyHeaderAdapterFactory
      || this.tableCommandEnvironment !== other.tableCommandEnvironment
      || !sameTableShape(this.tableData, other.tableData)
      || this.tableData.signature !== other.tableData.signature
      || this.tableData.from !== other.tableData.from || this.tableData.to !== other.tableData.to
      || this.tableData.startLine !== other.tableData.startLine || this.tableData.endLine !== other.tableData.endLine
      || !sameTableSourceRanges(this.tableData.sourceRanges, other.tableData.sourceRanges)) return false;
    const mounted = this.currentController() ?? other.currentController();
    const cache = mounted?.measuredHeightCache ?? (
      this.measuredHeight >= other.measuredHeight ? this.measuredHeightCache : other.measuredHeightCache
    );
    this.measuredHeightCache = other.measuredHeightCache = cache;
    if (mounted) this.mountedController = other.mountedController = new WeakRef(mounted);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const owner = new HtmlTableController(this.tableData, this.stickyHeaderAdapterFactory,
      this.tableCommandEnvironment, this.measuredHeightCache);
    this.mountedController = new WeakRef(owner);
    const previous = this.replacedRowWindow?.deref();
    this.replacedRowWindow = undefined;
    return owner.toDOM(view, previous);
  }

  updateDOM(dom: HTMLElement, view: EditorView, _previous: WidgetType): boolean {
    const owner = tableDomOwners.get(dom);
    if (!owner || owner.destroyed || owner.view !== view) return false;
    if (!owner.canReuseTableDom(this)) {
      if (owner.rowWindow && owner.tableData.from === this.tableData.from) this.replacedRowWindow = new WeakRef(owner);
      return false;
    }
    owner.adoptPresentation(this.tableData, this.measuredHeightCache, view.state.doc);
    this.mountedController = new WeakRef(owner);
    return true;
  }

  ignoreEvent(): boolean { return true; }
  destroy(dom: HTMLElement): void { tableDomOwners.get(dom)?.destroy(dom); }
}

/** Native input, resources and projected positions belong to this DOM alone. */
class HtmlTableController extends UiLanguageSensitiveWidget {
  private positionDocument: WeakRef<EditorState['doc']> | null = null;
  tableData: WidgetTableData;
  view: EditorView | null;
  layoutFrame: number;
  pendingResizeRows: boolean;
  domRefs: DomRefs | null;
  cleanupFns: (() => void)[];
  cellSelection: TableCellSelection;
  cellInteraction: TableCellInteraction;
  private heldCellPresentation: { input: HTMLTextAreaElement; pointerId: number } | null = null;
  private linePresentation: TableCellLinePresentation | null = null;
  private readonly editingPreviews = new WeakMap<HTMLElement, { width: number; readingPreview?: HTMLElement }>();
  private cellVerticalGoal: { input: HTMLTextAreaElement; head: number; x: number } | null = null;
  private cellWrapStart: { input: HTMLTextAreaElement; position: number } | null = null;
  private wholeCellInput: HTMLTextAreaElement | null = null;
  pendingCellAutoCommitTimer: number | null;
  readonly cellSymbolSnapshots = new Map<number, readonly AutomaticSymbolPair[]>();
  composingInput: HTMLTextAreaElement | null = null;
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
  private selectionDomAnchor: { node: Node; offset: number; cell: HTMLTableCellElement | undefined; projected: boolean } | null = null;
  selectionDomHead: { node: Node; offset: number } | null = null;
  private pointerTextHighlight: Highlight | null = null;
  private readonly textSelectionPaint = new TableTextSelectionPaint();
  measuredHeightCache: RenderedBlockPreviewHeight;
  pendingContextMenuRestore: boolean;
  contextPage: TableContextPage;
  deleteTableConfirmationTimer: number | null = null;
  tableCaretRevealGeneration: number;
  destroyed: boolean;
  rowWindow: TableRowWindow | undefined;
  rowWindowLayoutKey: string | undefined;

  constructor(
    tableData: WidgetTableData,
    stickyHeaderAdapterFactory: TableStickyHeaderAdapterFactory,
    tableCommandEnvironment: TableCommandEnvironment,
    measuredHeightCache: RenderedBlockPreviewHeight
  ) {
    super();
    this.tableData = tableData;
    this.view = null;
    this.layoutFrame = 0;
    this.pendingResizeRows = false;
    this.domRefs = null;
    this.cleanupFns = [];
    this.cellSelection = new TableCellSelection();
    this.cellInteraction = createTableCellInteraction();
    this.pendingCellAutoCommitTimer = null;
    this.pendingCellSwitchCommit = false;
    this.activeTarget = { row: this.tableData.rows.length > 0 ? 1 : 0, col: 0 };
    this.searchState = null;
    this.tableCommandEnvironment = tableCommandEnvironment;
    this.tableCommandTargetId = '';
    this.tableCommandTargetRegistration = null;
    this.measuredHeightCache = measuredHeightCache;
    this.pendingContextMenuRestore = false;
    this.contextPage = 'structure';
    this.tableCaretRevealGeneration = 0;
    this.destroyed = false;
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
    this.stickyHeaderAdapter = this.createStickyHeaderAdapter();
  }

  createStickyHeaderAdapter(): TableStickyHeaderAdapter {
    return this.stickyHeaderAdapterFactory.create({
      scheduler: this.layoutScheduler,
      resolveElements: () => this.resolveStickyHeaderElements(),
      controlsHeight: () => 0,
      navigateToSourceHeader: () => this.navigateToSourceHeader()
    });
  }

  get measuredHeight(): number {
    return this.measuredHeightCache.height;
  }

  canReuseTableDom(other: HtmlTableWidget): boolean {
    return this.hasSameUiLanguageEpoch(other) && sameTableShape(this.tableData, other.tableData)
      && this.stickyHeaderAdapterFactory === other.stickyHeaderAdapterFactory
      && this.tableCommandEnvironment === other.tableCommandEnvironment;
  }

  adoptPresentation(tableData: WidgetTableData, height: RenderedBlockPreviewHeight, document: EditorState['doc']): void {
    // Seed a new value numerically; recycling DOM must never alias the previous
    // source value's cache and overwrite its geometry with a different table.
    if (height.height <= 0) height.height = this.measuredHeight;
    this.measuredHeightCache = height;
    this.adoptEquivalentTableData(tableData);
    this.positionDocument = new WeakRef(document);
  }

  projectPosition(state: EditorState, changes: ChangeDesc): void {
    if (this.positionDocument?.deref() === state.doc) return;
    this.positionDocument = new WeakRef(state.doc);
    const previous = this.tableData;
    let touched = false;
    changes.iterChangedRanges((from, to) => {
      if (from === to ? from > previous.from && from < previous.to : from < previous.to && to > previous.from) touched = true;
    });
    if (touched) return;
    const from = changes.mapPos(previous.from, 1);
    const to = changes.mapPos(previous.to, -1);
    const startLine = state.doc.lineAt(from).number;
    if (from === previous.from && to === previous.to && startLine === previous.startLine) return;
    const delta = startLine - previous.startLine;
    this.adoptEquivalentTableData({
      ...previous, from, to, startLine, endLine: state.doc.lineAt(Math.max(from, to - 1)).number,
      sourceRanges: previous.sourceRanges?.map(row => row.map(range => ({ ...range, from: changes.mapPos(range.from, 1), to: changes.mapPos(range.to, -1) }))),
      diffFlagsByLine: previous.diffFlagsByLine && Object.fromEntries(Object.entries(previous.diffFlagsByLine).map(([line, flags]) => [Number(line) + delta, flags]))
    });
  }

  adoptEquivalentTableData(tableData: WidgetTableData): void {
    // Git row flags own their separate gutter; changing their line coordinates
    // does not change cell text, diagnostics or footnote presentation.
    const contentChanged = this.tableData.signature !== tableData.signature
      && cellPreviewSignature(this.tableData) !== cellPreviewSignature(tableData);
    const previousData = this.tableData;
    const previousStartLine = previousData.startLine;
    this.tableData = tableData;
    if (!this.domRefs) return;
    const { shell, table, rowEntries, allRowInputs } = this.domRefs;
    // Geometry-only viewport updates retain the same source coordinates. Even
    // assigning an identical dataset value wakes column/header observers, which
    // can otherwise turn one scroll receipt into another projection and layout.
    const setSourceData = (element: HTMLElement, key: string, value: string) => {
      if (element.dataset[key] !== value) element.dataset[key] = value;
    };
    setSourceData(shell, 'meoRenderedBlockStartLine', String(tableData.startLine));
    setSourceData(shell, 'meoRenderedBlockEndLine', String(tableData.endLine));
    setSourceData(table, 'tableFrom', String(tableData.from));
    setSourceData(table, 'tableTo', String(tableData.to));
    setSourceData(table, 'tableSignature', tableWidthIdentity(tableData));
    if (previousStartLine !== tableData.startLine) {
      for (const { row } of rowEntries) {
        const bodyIndex = row.dataset.tableBodyRow;
        setSourceData(row, 'sourceLineNumber', String(tableData.startLine + (bodyIndex === undefined ? 0 : Number(bodyIndex) + 2)));
      }
      this.view?.plugin(tableLineNumbers)?.request();
    }
    if (previousData.sourceRanges !== tableData.sourceRanges) {
      // Absolute action coordinates are metadata, not a reason to rebuild an
      // unchanged preview (and reload its images). Rebase only those controls.
      for (const swatch of table.querySelectorAll<HTMLElement>('.meo-md-color-swatch-interactive')) {
        const input = swatch.closest('.meo-md-html-table-cell-content')?.querySelector<HTMLTextAreaElement>('textarea');
        const coords = input && this.parseCellCoords(input.dataset.tableRow, input.dataset.tableCol);
        if (!coords) continue;
        const previousRange = previousData.sourceRanges?.[coords.row]?.[coords.col];
        const nextRange = tableData.sourceRanges?.[coords.row]?.[coords.col];
        const from = Number(swatch.dataset.colorFrom);
        if (previousRange && nextRange && previousRange.from !== nextRange.from && Number.isInteger(from)) {
          swatch.dataset.colorFrom = String(from + nextRange.from - previousRange.from);
        }
      }
    }
    if (contentChanged) {
      const values = [tableData.headerCells, ...tableData.rows];
      const previousValues = [previousData.headerCells, ...previousData.rows];
      const previousSignature = JSON.parse(previousData.signature), nextSignature = JSON.parse(tableData.signature);
      const footnotesChanged = JSON.stringify(previousSignature.footnoteReferences) !== JSON.stringify(nextSignature.footnoteReferences);
      const referenceTargetsChanged = previousSignature.referenceTargets !== nextSignature.referenceTargets;
      const mathSyntaxChanged = previousSignature.latexDelimiters !== nextSignature.latexDelimiters;
      const { pending, editingTarget } = this.cellInteraction.snapshot();
      for (let row = 0; row < allRowInputs.length; row += 1) {
        for (let col = 0; col < allRowInputs[row].length; col += 1) {
          const input = allRowInputs[row][col];
          const value = tableCellSourceToEditorValue(values[row]?.[col] ?? '');
          // A late parse or diagnostic still describes the accepted source.
          // The native textarea may already own a newer, uncommitted edit.
          const ownsPending = pending.some(edit => edit.row === row && edit.col === col);
          // Source cells omit edge padding. An acknowledged native edit can
          // still contain the space separating it from the user's next word.
          const ownsEquivalentEdit = editingTarget?.row === row && editingTarget.col === col
            && tableCellEditorValueToSource(input.value).trim() === (values[row]?.[col] ?? '').trim();
          if (input !== this.composingInput && !ownsPending && !ownsEquivalentEdit && input.value !== value) input.value = value;
          // A cell owns its preview; reference numbering remains a dependency
          // even when the cell's own source text has not changed.
          if (previousValues[row]?.[col] !== values[row]?.[col]
            || mathSyntaxChanged && /\\[([]/.test(values[row]?.[col] ?? '')
            || referenceTargetsChanged && possibleTableReferenceLink.test(values[row]?.[col] ?? '')
            || JSON.stringify(previousData.diagnostics?.[row]?.[col] ?? []) !== JSON.stringify(tableData.diagnostics?.[row]?.[col] ?? [])
            || footnotesChanged && /\[\^|\^\[/.test(values[row]?.[col] ?? '')) {
            this.refreshCellPreviewFromInput(input);
          }
        }
      }
      this.stickyHeaderAdapter.update();
      this.scheduleLayout({ resizeRows: true });
    } else {
      this.scheduleLayout();
    }
  }

  refreshCurrentPosition(
    view: EditorView = this.view!,
    diagnostics: EditorDiagnostic[] = [],
    diffLineFlags: readonly (TableDiffFlags | undefined)[] | null | undefined = null
  ): void {
    if (!view || !this.domRefs?.shell.isConnected) return;
    const pos = view.posAtDOM(this.domRefs.wrap, 0);
    // Offset zero of the retained block DOM is the table's opening boundary.
    // Looking left can resolve Document/the preceding block and skip refresh.
    let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 1);
    while (node && node.name !== 'Table') node = node.parent;
    if (!node) {
      this.resolveCurrentTableRange(view, this.domRefs.wrap);
      return;
    }
    const current = buildWidgetTableData(
      view.state,
      buildTableData(view.state, node),
      diagnostics,
      diffLineFlags
    );
    if (
      !current || current.colCount !== this.tableData.colCount ||
      current.rows.length !== this.tableData.rows.length ||
      current.rows.some((row, index) => row.length !== this.tableData.rows[index]?.length)
    ) return;
    this.adoptEquivalentTableData(current);
  }

  get hasPendingCellEdits() {
    return this.cellInteraction.snapshot().pending.length > 0;
  }

  pendingRecoveryEdits(view: EditorView): Array<{
    controller: HtmlTableController;
    edit: TableCellEditIntent;
    tableStartLine: number;
  }> {
    const pending = this.cellInteraction.snapshot().pending;
    if (pending.length === 0) return [];
    const wrap = this.domRefs?.wrap;
    if (!wrap || this.view !== view || this.destroyed) return [];
    const range = this.resolveCurrentTableRange(view, wrap);
    if (!range) return [];
    return pending.flatMap((edit) => {
      const tableStartLine = this.resolveCurrentTableStartLine(view, edit.row, range);
      return tableStartLine === null ? [] : [{ controller: this, edit, tableStartLine }];
    });
  }

  discardPendingCellEdits() {
    this.composingInput = null;
    this.cellInteraction.accept({ type: 'invalidate', reason: 'replacement' });
    this.cancelPendingCellAutoCommit();
  }

  resolveStickyHeaderElements(): TableStickyHeaderElements | null {
    if (!this.domRefs || !this.view) return null;
    const {
      wrap,
      table,
      stickyChrome,
      stickyShadow,
      stickyHeaderViewport,
      stickyTable,
      stickyHeaderRow
    } = this.domRefs;
    return {
      scroller: this.view.scrollDOM,
      horizontalScroller: wrap,
      table,
      stickyChrome,
      stickyShadow,
      stickyHeaderViewport,
      stickyTable,
      stickyHeaderRow
    };
  }

  navigateToSourceHeader(): void {
    const view = this.view;
    const header = this.domRefs?.table.tHead?.rows[0];
    if (!view || !header?.isConnected) return;
    this.tableCaretRevealGeneration += 1;
    const margin = visualLineContextMargin(view, 0.75);
    const viewport = getViewportController(view);
    if (viewport) {
      const isCurrent = viewport.beginNavigationReveal();
      viewport.revealVerticalBounds(
        () => header.isConnected
          ? { top: header.getBoundingClientRect().top, bottom: header.getBoundingClientRect().bottom }
          : null,
        isCurrent,
        { yMargin: margin }
      );
      return;
    }
    const scrollerRect = view.scrollDOM.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    view.scrollDOM.scrollTop = Math.max(
      0,
      view.scrollDOM.scrollTop + headerRect.top - scrollerRect.top - margin
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
      // Replacement widgets map their DOM position to the end of the replaced
      // range. Resolve toward the table at that boundary; resolving forward can
      // land after the table and fall back to absolute offsets captured before
      // an embedded editor inserted lines above it.
      let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, -1);
      while (node) {
        if (node.name === 'Table') {
          if (this.tableData) {
            const delta = node.from - this.tableData.from;
            const sourceRanges = delta === 0
              ? this.tableData.sourceRanges
              : this.tableData.sourceRanges?.map((row) => row.map((range) => ({
                from: range.from + delta,
                to: range.to + delta
              })));
            this.adoptEquivalentTableData({
              ...this.tableData,
              from: node.from,
              to: node.to,
              startLine: view.state.doc.lineAt(node.from).number,
              endLine: view.state.doc.lineAt(Math.max(node.from, node.to - 1)).number,
              sourceRanges
            });
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

  resolveCurrentTableStartLine(view: EditorView, row: number, fallbackRange: TableRange | null = null): number | null {
    const renderedRow = this.domRefs?.allRowInputs[row]?.[0]?.closest('tr');
    const renderedLine = Number.parseInt(renderedRow?.dataset.sourceLineNumber ?? '', 10);
    const candidate = renderedLine - (row === 0 ? 0 : row + 1);
    if (
      Number.isInteger(candidate) && candidate >= 1 && candidate < view.state.doc.lines &&
      isTableDelimiterLine(view.state.doc.line(candidate + 1).text)
    ) return candidate;
    const range = fallbackRange ?? (
      this.domRefs ? this.resolveCurrentTableRange(view, this.domRefs.wrap) : null
    );
    return range ? view.state.doc.lineAt(range.from).number : null;
  }

  readCellMatrix(): CellMatrix {
    if (!this.domRefs) return { headerCells: [], rows: [], alignments: [] };
    const { headerInputs, rowInputs } = this.domRefs;
    const sourceHeader = this.sourceRow(0);
    const headerCells = normalizeRow(
      Array.from({ length: this.tableData.colCount }, (_, column) => headerInputs[column]
        ? tableCellEditorValueToSource(headerInputs[column].value).trim() : sourceHeader[column] ?? ''),
      this.tableData.colCount,
      ''
    );

    const rows = this.tableData.rows.map((_source, row) => {
      const source = this.sourceRow(row + 1);
      return normalizeRow(
        Array.from({ length: this.tableData.colCount }, (_, column) => rowInputs[row]?.[column]
          ? tableCellEditorValueToSource(rowInputs[row][column].value).trim() : source[column] ?? ''),
        this.tableData.colCount,
        ''
      );
    });

    return { headerCells, rows, alignments: this.tableData.alignments };
  }

  sourceRow(row: number): readonly string[] {
    const line = this.tableData.startLine + (row === 0 ? 0 : row + 1);
    const doc = this.view?.state.doc;
    // The accepted source may be newer than the asynchronous presentation.
    // Evicting a row must never restore that older presentation's cell text.
    if (doc && line >= 1 && line <= doc.lines) {
      const source = doc.line(line);
      return parseTableLine(line, source.from, source.to, source.text).cells;
    }
    return row === 0 ? this.tableData.headerCells : this.tableData.rows[row - 1] ?? [];
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

  selectedBodyRows(target: TableCommandTarget = this.currentCommandTarget()): number[] {
    const selection = target.selection;
    const rows: number[] = [];
    if (selection && (selection.fromRow !== selection.toRow || selection.fromColumn !== selection.toColumn)) {
      for (let row = Math.max(1, selection.fromRow); row <= selection.toRow; row += 1) {
        const bodyIndex = row - 1;
        if (bodyIndex >= 0 && bodyIndex < this.tableData.rows.length) rows.push(bodyIndex);
      }
      return rows;
    }
    const bodyRow = this.bodyRowIndexFor(target.row);
    return bodyRow === null ? [] : [bodyRow];
  }

  selectedColumns(target: TableCommandTarget = this.currentCommandTarget()): number[] {
    const selection = target.selection;
    const columns: number[] = [];
    if (selection && (selection.fromRow !== selection.toRow || selection.fromColumn !== selection.toColumn)) {
      for (let column = selection.fromColumn; column <= selection.toColumn; column += 1) {
        if (column >= 0 && column < this.tableData.colCount) columns.push(column);
      }
      return columns;
    }
    const column = this.columnIndexFor(target.column);
    return column === null ? [] : [column];
  }

  currentCommandTarget(): TableCommandTarget {
    const selectionRange = this.cellSelection.snapshot().range;
    return {
      tableId: this.tableCommandTargetId,
      row: this.activeTarget.row,
      column: this.activeTarget.col,
      selection: selectionRange ? {
        fromRow: selectionRange.fromRow,
        toRow: selectionRange.toRow,
        fromColumn: selectionRange.fromCol,
        toColumn: selectionRange.toCol
      } : null
    };
  }

  updateContextMenuState() {
    if (!this.domRefs) return;
    const { contextButtons } = this.domRefs;
    const input = this.domRefs.allRowInputs[this.activeTarget.row]?.[this.activeTarget.col];
    contextButtons.editEntireCell.hidden = !input || this.wholeCellInput === input || !canProjectTableCellLines(input.value);
    contextButtons.editEntireCell.disabled = contextButtons.editEntireCell.hidden;
    const targetRow = this.cellSelection.snapshot().anchor?.row ?? this.activeTarget.row;
    const rows = this.selectedBodyRows();
    const columns = this.selectedColumns();
    const hasRows = rows.length > 0;
    const hasColumns = columns.length > 0;

    contextButtons.insertRowAbove.disabled = this.tableData.colCount === 0 || targetRow === 0;
    contextButtons.insertRowBelow.disabled = this.tableData.colCount === 0;
    contextButtons.moveRowUp.disabled = !hasRows || Math.min(...rows) <= 0;
    contextButtons.moveRowDown.disabled = !hasRows || Math.max(...rows) >= this.tableData.rows.length - 1;
    contextButtons.deleteRow.disabled = !hasRows || rows.length >= this.tableData.rows.length;
    contextButtons.insertColumnLeft.disabled = !hasColumns;
    contextButtons.insertColumnRight.disabled = !hasColumns;
    contextButtons.moveColumnLeft.disabled = !hasColumns || Math.min(...columns) <= 0;
    contextButtons.moveColumnRight.disabled = !hasColumns || Math.max(...columns) >= this.tableData.colCount - 1;
    contextButtons.deleteColumn.disabled = !hasColumns || columns.length >= this.tableData.colCount;
    contextButtons.alignColumnLeft.disabled = !hasColumns;
    contextButtons.alignColumnCenter.disabled = !hasColumns;
    contextButtons.alignColumnRight.disabled = !hasColumns;
    const canSort = this.activeColumnIndex() !== null && this.tableData.rows.length > 1;
    contextButtons.sortAscending.disabled = !canSort;
    contextButtons.sortDescending.disabled = !canSort;
    const selectedAlignments = columns.map((column) => this.tableData.alignments[column] ?? 'left');
    const selectedAlignment = selectedAlignments.length > 0
      && selectedAlignments.every((alignment) => alignment === selectedAlignments[0])
      ? selectedAlignments[0]
      : null;
    for (const [button, alignment] of [
      [contextButtons.alignColumnLeft, 'left'],
      [contextButtons.alignColumnCenter, 'center'],
      [contextButtons.alignColumnRight, 'right']
    ] as const) {
      const active = selectedAlignment === alignment;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-checked', String(active));
    }
  }

  updateActionTargetStyles() {
    this.updateContextMenuState();
    this.updateContextControlsPosition();
  }

  setActionTarget(target: TableActionTarget) {
    const row = Math.min(Math.max(target.row ?? 0, 0), this.tableData.rows.length);
    const col = Math.min(Math.max(target.col ?? 0, 0), Math.max(0, this.tableData.colCount - 1));
    this.activeTarget = { row, col };
    this.updateActionTargetStyles();
    this.view?.plugin(tableLineNumbers)?.request();
  }

  requestTableCommand(command: TableCommand, enabled = true, target = this.currentCommandTarget()) {
    this.clearDeleteTableConfirmation();
    this.pendingContextMenuRestore = Boolean(this.domRefs && !this.domRefs.contextMenu.hidden);
    return this.tableCommandEnvironment.dispatch({
      type: 'request',
      command,
      target,
      enabled
    });
  }

  requestInsertRowAbove(container: HTMLElement) {
    void container;
    this.requestTableCommand(
      'insert-row-above',
      this.tableData.colCount > 0 && this.currentCommandTarget().row !== 0
    );
  }

  requestInsertRowBelow(container: HTMLElement) {
    void container;
    this.requestTableCommand('insert-row-below', this.tableData.colCount > 0);
  }

  requestMoveRow(container: HTMLElement, direction: 'up' | 'down') {
    void container;
    const rows = this.selectedBodyRows();
    const enabled = rows.length > 0 && (
      direction === 'up' ? Math.min(...rows) > 0 : Math.max(...rows) < this.tableData.rows.length - 1
    );
    this.requestTableCommand(direction === 'up' ? 'move-row-up' : 'move-row-down', enabled);
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

  requestMoveColumn(container: HTMLElement, direction: 'left' | 'right') {
    void container;
    const columns = this.selectedColumns();
    const enabled = columns.length > 0 && (
      direction === 'left' ? Math.min(...columns) > 0 : Math.max(...columns) < this.tableData.colCount - 1
    );
    this.requestTableCommand(direction === 'left' ? 'move-column-left' : 'move-column-right', enabled);
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

  focusTableInput(input: HTMLTextAreaElement, caret: number | null = null, {
    revealCaret = true, selectionAnchor, wrapStart = false
  }: { revealCaret?: boolean; selectionAnchor?: number; wrapStart?: boolean } = {}) {
    if (!(input instanceof HTMLTextAreaElement)) return false;
    this.cellVerticalGoal = null;
    const view = this.view;
    const viewport = view ? getViewportController(view) : null;
    const scrollTop = !revealCaret ? view?.scrollDOM.scrollTop : undefined;
    const hadProjectedLine = !revealCaret && (this.linePresentation !== null || (
      view && [...mountedTableWidgets.get(view) ?? []].some(widget => widget.linePresentation !== null)
    ));
    const top = !revealCaret && !hadProjectedLine ? nativeInputViewportReference(input).getBoundingClientRect().top : undefined;
    this.setCellEditingState(input, true);
    input.focus({ preventScroll: true });
    const nextCaret = Math.min(Math.max(caret ?? input.value.length, 0), input.value.length);
    const anchor = Math.min(Math.max(selectionAnchor ?? nextCaret, 0), input.value.length);
    this.cellWrapStart = wrapStart ? { input, position: nextCaret } : null;
    input.setSelectionRange(Math.min(anchor, nextCaret), Math.max(anchor, nextCaret),
      nextCaret < anchor ? 'backward' : 'forward');
    const projected = this.updateCellLinePresentation(input);
    if (revealCaret) this.revealTableCellCaretIfNeeded(input, viewport?.beginNavigationReveal());
    // Anchoring the newly clicked line would scroll the old text when its
    // source closes and the two lines move relative to one another.
    if (scrollTop !== undefined && (projected || hadProjectedLine)) {
      viewport?.lockScrollTop(scrollTop);
    } else if (top !== undefined && viewport?.captureNativeInputViewport(input, top)) {
      viewport.reconcileAfterEditorUpdate();
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
      this.setSingleCellSelection(coords, 'command');
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
      if (nearestFallback) {
        const atom = preview.ownerDocument.elementFromPoint(clientX, clientY)
          ?.closest('[data-meo-edit-inline][data-meo-source-atom="true"]') ?? null;
        const range = atom && preview.contains(atom) ? readInlineSourceRange(atom) : null;
        if (range && range.to > range.from + 1) resolution.sourceOffset = range.from + 1;
      }
    } finally {
      input.style.pointerEvents = previousInputPointerEvents;
      preview.style.visibility = previousPreviewVisibility;
    }
    const presentation = this.linePresentation;
    if (presentation?.input === input && presentation.breakElement) {
      const { breakElement, line, valueFrom } = presentation;
      const sourceEnd = line.from + line.text.length;
      const tagEnd = sourceEnd + line.breakText.length;
      const { sourceOffset } = resolution;
      const onTag = Array.from(breakElement.getClientRects()).some(rect =>
        clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom
      );
      if (onTag && sourceOffset !== null && sourceOffset >= sourceEnd && sourceOffset <= tagEnd) {
        // The last glyph still belongs to this source line. The general offset
        // mapper would move its end past the textarea's display-only newline.
        return { domCaret: resolution.domCaret, editorOffset: valueFrom + sourceOffset - line.from };
      }
      const pointedNode = resolution.domCaret?.node;
      const bounds = presentation.textElement.getBoundingClientRect();
      const inSourceLine = pointedNode
        ? presentation.textElement.contains(pointedNode)
        : clientY >= bounds.top && clientY < bounds.bottom;
      const bodyEnd = this.projectedCaretRect(input, valueFrom + line.text.length);
      const pastBodyEnd = bodyEnd && clientX >= bodyEnd.left && clientY >= bodyEnd.top && clientY < bodyEnd.bottom;
      if (inSourceLine && (pastBodyEnd || (sourceOffset !== null && sourceOffset >= sourceEnd && sourceOffset <= tagEnd))) {
        const text = presentation.bodyRuns.at(-1)?.node;
        resolution = {
          sourceOffset: sourceEnd,
          domCaret: text instanceof Text ? { node: text, offset: text.length }
            : { node: presentation.bodyElement, offset: 0 }
        };
      }
    }
    return {
      domCaret: resolution.domCaret,
      editorOffset: resolution.sourceOffset === null
        ? null
        : tableCellSourceOffsetToEditorOffset(input.value, resolution.sourceOffset)
    };
  }

  focusCellInputAt(row: number, col: number, caret: number | null = null) {
    const input = this.cellInput(row, col);
    return input ? this.focusTableInput(input, caret) : false;
  }

  cellInput(row: number, col: number): HTMLTextAreaElement | undefined {
    if (row > 0) this.rowWindow?.ensure(row - 1);
    return this.domRefs?.allRowInputs[row]?.[col];
  }

  moveVerticalOutOfTable(
    container: HTMLElement,
    direction: 'up' | 'down',
    preferredColumn = 0,
    createLineIfMissing = false
  ) {
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
    const appendLine = createLineIfMissing && direction === 'down' && targetLineNo === view.state.doc.lines + 1;
    if (!appendLine && (targetLineNo < 1 || targetLineNo > view.state.doc.lines)) return false;

    const viewport = getViewportController(view);
    const isRevealCurrent = viewport?.beginNavigationReveal();
    const shell = container.closest<HTMLElement>('.meo-md-html-table-shell');
    const tableTop = shell?.getBoundingClientRect().top;
    const resolveShell = () => shell?.isConnected ? shell : view.contentDOM.querySelector<HTMLElement>(
      `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${firstLine.number}"]`
    );
    const readOrigin = tableTop === undefined ? undefined : () => {
      const currentShell = resolveShell();
      const top = currentShell?.getBoundingClientRect().top ?? view.documentTop + view.lineBlockAt(firstLine.from).top;
      return view.scrollDOM.scrollTop + (top - tableTop) / view.scaleY;
    };
    // Release the textarea only after reserving the visible table as the
    // handoff's reference. The appended line can rebuild the Live height map.
    let destination: { doc: typeof view.state.doc; position: number } | undefined;
    const isCurrent = () => isRevealCurrent?.() === true && (!destination
      || (view.state.doc === destination.doc && view.state.selection.main.head === destination.position));
    const retention = tableTop === undefined ? null : viewport?.retainElementTop(
      shell, resolveShell, isCurrent, { position: firstLine.from, top: tableTop }
    );
    try {
      commitPendingTableEdits(view);
      this.exitTableInteraction(container);
      const doc = view.state.doc;
      const targetLine = appendLine ? null : doc.line(targetLineNo);
      const targetPos = targetLine ? Math.min(targetLine.from + Math.max(preferredColumn, 0), targetLine.to) : doc.length + 1;
      view.dispatch({
        changes: appendLine ? { from: doc.length, insert: '\n' } : undefined,
        selection: { anchor: targetPos },
        // Enter adds a normal editing revision. Keep pending Live presentation
        // through this handoff, including when the table was just inserted.
        userEvent: appendLine ? 'input.table-exit' : undefined
      });
      destination = { doc: view.state.doc, position: targetPos };
      if (!viewport) view.dispatch({ effects: editorScrollIntoView(targetPos, { y: 'nearest' }) });
      view.focus();
      if (viewport) {
        flushEditorLayout(view);
        retention?.correct();
        const caret = view.coordsAtPos(targetPos);
        const bounds = editorViewportBounds(view);
        if (!retention?.isCurrent() || !caret || caret.top < bounds.top || caret.bottom > bounds.bottom) {
          retention?.cancel();
          viewport.revealPositionUntilStable(targetPos, {
            yMargin: visualLineContextMargin(view, 1), originScrollTop: readOrigin, retainOnLayout: true
          }, isCurrent);
          flushEditorLayout(view);
        }
      }
    } finally {
      if (destination) retention?.finish();
      else retention?.cancel();
    }
    return true;
  }

  isCellSelected(row: number, col: number, range: TableSelectionRange | null): boolean {
    if (!range) return false;
    return row >= range.fromRow && row <= range.toRow && col >= range.fromCol && col <= range.toCol;
  }

  applySelection(range: TableSelectionRange | null) {
    if (!this.domRefs) return;
    const showSelectionStyle = this.cellSelection.selectedCellRange() !== null;
    const { table, cellGrid } = this.domRefs;
    table.classList.toggle('has-table-cell-selection', range !== null && showSelectionStyle);
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

  applyCellSelectionTransition(
    transition: TableCellSelectionTransition,
    context: {
      event?: Event;
      domCaret?: { node: Node; offset: number } | null;
      primaryError?: unknown;
    } = {}
  ) {
    if (!transition.accepted) return false;
    const table = this.domRefs?.table;
    const wrap = this.domRefs?.wrap ?? table;
    let hasPrimaryError = Object.prototype.hasOwnProperty.call(context, 'primaryError');
    let primaryError: unknown = context.primaryError;
    const cleanupErrors: unknown[] = [];
    const runPrimary = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        if (!hasPrimaryError) {
          hasPrimaryError = true;
          primaryError = error;
        } else {
          cleanupErrors.push(error);
        }
      }
    };
    const runCleanup = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        cleanupErrors.push(error);
      }
    };
    const clearNativeTextSelection = (onlyOwned = false) => {
      this.selectionDomAnchor?.cell?.classList.remove(tableCellTextSelectingClass);
      this.clearPointerTextHighlight();
      this.selectionDomAnchor = null;
      this.selectionDomHead = null;
      const selection = document.getSelection();
      // Virtual widget disposal must not clear a caret owned by another editor.
      if (onlyOwned && !wrap?.contains(selection?.anchorNode ?? null) &&
        !wrap?.contains(selection?.focusNode ?? null)) return;
      selection?.removeAllRanges();
    };

    for (const effect of transition.effects) {
      if (effect.kind === 'caret-request') continue;
      if (effect.kind === 'prevent-default') {
        runPrimary(() => context.event?.preventDefault());
        continue;
      }
      if (effect.kind === 'set-action-target') {
        runPrimary(() => this.setActionTarget(effect.cell));
        continue;
      }
      if (effect.kind === 'capture-pointer') {
        try {
          table?.setPointerCapture?.(effect.pointerId);
        } catch {
          // Synthetic pointer events and already-released pointers cannot be captured.
        }
        continue;
      }
      if (effect.kind === 'release-pointer') {
        runCleanup(() => {
          if (table?.hasPointerCapture?.(effect.pointerId)) table.releasePointerCapture?.(effect.pointerId);
        });
        continue;
      }
      if (effect.kind === 'clear-text') {
        runPrimary(clearNativeTextSelection);
        continue;
      }
      if (effect.kind === 'clear') {
        if (effect.reason !== 'pointercancel' && effect.reason !== 'lostcapture') {
          runPrimary(() => this.endCellEditing());
        }
        runPrimary(() => clearNativeTextSelection(effect.reason === 'dispose'));
        runPrimary(() => this.applySelection(null));
        if (wrap && effect.reason === 'cross-table') {
          runPrimary(() => {
            const shell = wrap.closest('.meo-md-html-table-shell');
            if (shell instanceof HTMLElement) {
              shell.classList.remove('is-interacting');
              this.setContextMenuOpen(false);
            }
          });
          runPrimary(() => this.stickyHeaderAdapter.invalidate());
        } else if (wrap && effect.reason !== 'pointercancel' && effect.reason !== 'lostcapture') {
          runPrimary(() => this.setTableInteractionActive(wrap, false));
        }
        runPrimary(() => this.view?.plugin(tableLineNumbers)?.request());
        continue;
      }
      if (effect.kind === 'cells') {
        const held = effect.pointerId !== null && this.cellSelection.ownsPointer(effect.pointerId);
        if (!held && (effect.focus === 'table' || effect.range.fromRow !== effect.range.toRow || effect.range.fromCol !== effect.range.toCol)) {
          // A rectangular drag can blur the native input before release. Keep
          // its source geometry until the pointer has accepted the final range.
          runPrimary(() => this.endCellEditing());
        }
        runPrimary(clearNativeTextSelection);
        if (wrap) runPrimary(() => this.setTableInteractionActive(wrap, true));
        runPrimary(() => this.applySelection(effect.range));
        if (effect.focus === 'table') runPrimary(() => table?.focus({ preventScroll: true }));
        continue;
      }
      if (effect.phase === 'begin') {
        const presentation = this.linePresentation;
        if (presentation) {
          runPrimary(() => {
            this.clearCellLineHighlight(presentation);
            presentation.selection = null;
          });
        }
        runPrimary(clearNativeTextSelection);
        runPrimary(() => this.applySelection(null));
        runPrimary(() => {
          const cell = this.domRefs?.cellGrid[effect.cell.row]?.[effect.cell.col];
          const input = this.cellInput(effect.cell.row, effect.cell.col);
          const projected = !!input && this.canProjectCellLine(input)
            && !shouldExpandTableCellForSearch(tableCellEditorValueToSource(input.value), this.searchState);
          this.selectionDomAnchor = context.domCaret ? { ...context.domCaret, cell, projected } : null;
          if (effect.anchorCaret === effect.headCaret) return;
          const preview = input?.parentElement?.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
          if (!input || !preview) return;
          const anchor = tableCellEditorOffsetToSourceOffset(input.value, effect.anchorCaret);
          const range = inlineSourceSelectionRanges(preview, anchor, anchor + 1)[0];
          if (range) this.selectionDomAnchor = { node: range.startContainer, offset: range.startOffset, cell, projected };
        });
        runPrimary(() => {
          const active = document.activeElement;
          if (active instanceof HTMLElement && this.view?.contentDOM.contains(active)) {
            // The gesture owns its DOM range while held. Move focus out of
            // CodeMirror's editable body so its selection observer cannot
            // replace the table's live text selection with the old body caret.
            // This also hands off an activation-restored native cell directly.
            table?.focus({ preventScroll: true });
          }
        });
        runPrimary(() => this.projectPointerTextSelection(context.domCaret));
        continue;
      }
      if (effect.phase === 'preview') {
        runPrimary(() => this.applySelection(null));
        runPrimary(() => this.projectPointerTextSelection(context.domCaret));
        continue;
      }
      runPrimary(clearNativeTextSelection);
      const input = this.cellInput(effect.cell.row, effect.cell.col);
      if (!(input instanceof HTMLTextAreaElement)) continue;
      runPrimary(() => {
        let wrapStart = false;
        const source = this.linePresentation;
        if (source?.input === input && context.event instanceof PointerEvent &&
            context.domCaret && source.textElement.contains(context.domCaret.node)) {
          const previous = this.projectedCaretRect(input, effect.headCaret, false);
          const next = this.projectedCaretRect(input, effect.headCaret, true);
          wrapStart = !!previous && !!next && next.top > previous.top + 1 && context.event.clientY >= next.top;
        }
        this.focusTableInput(input, effect.headCaret, {
          revealCaret: false, selectionAnchor: effect.anchorCaret, wrapStart
        });
      });
    }
    // Rectangular selection and clearing it also change the document selection.
    // Publish once after all effects (including focus) have settled, not only
    // after the native textarea selection branch.
    if (wrap && transition.effects.length) runPrimary(() => this.emitTableSelectionChange(wrap));
    if (hasPrimaryError && cleanupErrors.length) {
      throw new AggregateError(
        [primaryError, ...cleanupErrors],
        'Table cell selection effect cleanup failed',
        { cause: primaryError }
      );
    }
    if (hasPrimaryError) throw primaryError;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Table cell selection cleanup failed', { cause: cleanupErrors[0] });
    }
    return true;
  }

  projectPointerTextSelection(domHead: { node: Node; offset: number } | null | undefined) {
    const anchor = this.selectionDomAnchor;
    if (!anchor || !domHead) return;
    this.selectionDomHead = domHead;
    const selection = document.getSelection();
    try {
      selection?.setBaseAndExtent(anchor.node, anchor.offset, domHead.node, domHead.offset);
    } catch {
      selection?.removeAllRanges();
    }
    // Once text has been selected, keep the stroke on this cell even if the
    // pointer returns to the starting character before the gesture ends.
    if (selection && !selection.isCollapsed) anchor.cell?.classList.toggle(tableCellTextSelectingClass, true);
    if (!anchor.projected || !selection?.rangeCount || selection.isCollapsed || !CSS.highlights || typeof Highlight === 'undefined') {
      this.clearPointerTextHighlight();
      return;
    }
    const range = selection.getRangeAt(0);
    const highlight = this.pointerTextHighlight;
    if (highlight) {
      highlight.clear();
      highlight.add(range);
    } else {
      this.pointerTextHighlight = new Highlight(range);
      CSS.highlights.set('meo-table-cell-selection', this.pointerTextHighlight);
      anchor.cell?.classList.add('has-projected-text-selection');
    }
    const content = anchor.cell?.querySelector<HTMLElement>('.meo-md-html-table-cell-content');
    if (content) this.textSelectionPaint.paint(content, [range]);
  }

  private clearPointerTextHighlight() {
    if (!this.pointerTextHighlight) return;
    if (CSS.highlights?.get('meo-table-cell-selection') === this.pointerTextHighlight) {
      CSS.highlights.delete('meo-table-cell-selection');
    }
    this.pointerTextHighlight = null;
    this.textSelectionPaint.clear();
    this.selectionDomAnchor?.cell?.classList.remove('has-projected-text-selection');
  }

  setSingleCellSelection(coords: CellCoords, origin: 'focus' | 'command') {
    const transition = this.cellSelection.accept({ type: 'select', anchor: coords, head: coords, origin });
    if (!transition.accepted) return false;
    this.applyCellSelectionTransition(transition);
    return true;
  }

  clearSelection(reason: 'outside' | 'escape' | 'cross-table' | 'external' | 'replacement' = 'external') {
    this.endCellEditing();
    const transition = this.cellSelection.accept({ type: 'clear', reason });
    this.applyCellSelectionTransition(transition);
  }

  exitTableInteraction(container: HTMLElement, reason: 'outside' | 'escape' | 'external' | 'replacement' = 'external') {
    this.clearSelection(reason);
  }

  transferTableInteraction(container: HTMLElement) {
    this.clearSelection('cross-table');
  }

  setTableInteractionActive(container: HTMLElement, active: boolean) {
    const shell = container?.closest?.('.meo-md-html-table-shell');
    if (shell instanceof HTMLElement) {
      shell.classList.toggle('is-interacting', active);
    }
    if (!active) this.setContextMenuOpen(false);
    else this.updateContextControlsPosition();
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

  tableCellCopyValue(row: number, col: number): TableCellCopyValue {
    const input = this.domRefs?.allRowInputs[row]?.[col];
    const source = input ? tableCellEditorValueToSource(input.value).trim()
      : this.sourceRow(row)[col]?.trim() ?? '';
    const mounted = this.domRefs?.cellGrid[row]?.[col]?.querySelector('.meo-md-html-table-cell-preview');
    const preview = mounted ?? this.createCellPreview(source, this.cellDiagnostics(row, col), this.cellSourceRange(row, col));
    const readInline = (parent: Node): TableCellCopyInline[] => {
      const inline: TableCellCopyInline[] = [];
      for (const node of parent.childNodes) {
        if (node instanceof Text) {
          inline.push(node.data);
          continue;
        }
        if (!(node instanceof Element)) continue;
        const children = readInline(node);
        if (node.tagName === 'STRONG' || node.tagName === 'B') {
          inline.push({ kind: 'strong', children });
        } else {
          inline.push(...children);
        }
      }
      return inline;
    };
    try { return { plain: source, inline: readInline(preview) }; }
    finally { if (!mounted) disposeImagePresentations(preview); }
  }

  copyCellMatrix(range: TableSelectionRange): TableCellCopyValue[][] {
    const cells: TableCellCopyValue[][] = [];
    for (let row = range.fromRow; row <= range.toRow; row++) {
      const values: TableCellCopyValue[] = [];
      for (let col = range.fromCol; col <= range.toCol; col++) values[col] = this.tableCellCopyValue(row, col);
      cells[row] = values;
    }
    return cells;
  }

  clipboardPayload(event: ClipboardEvent): TableClipboardMatrix | null {
    const clipboard = event.clipboardData;
    if (!clipboard) return null;
    return parseMeoTableClipboard(clipboard.getData(meoTableClipboardMime))
      ?? parseHtmlTableClipboard(clipboard.getData('text/html'), this.view?.state.facet(inputAssistanceFacet).pasteHtml ?? defaultInputAssistance.pasteHtml)
      ?? parseTsvTableClipboard(clipboard.getData('text/plain')) ?? (() => { const table = parseMarkdownTable(clipboard.getData('text/plain')); return table ? { cells: table.cells, source: 'meo' as const } : null; })();
  }

  buildPasteCellsTransaction(
    payload: TableClipboardMatrix,
    target: CellCoords
  ): TableCommandTransactionPlan {
    const dom = this.domRefs?.wrap;
    if (!dom || !payload.cells.length) return { transaction: null, outcome: 'no-op' };
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return { transaction: null, outcome: 'no-op' };
    const sourceWidth = Math.max(...payload.cells.map((row) => row.length));
    const requiredColumns = target.col + sourceWidth;
    const finalColumns = Math.max(matrix.headerCells.length, requiredColumns);
    while (matrix.headerCells.length < finalColumns) matrix.headerCells.push('');
    matrix.rows = matrix.rows.map((row) => normalizeRow(row, finalColumns, ''));
    const alignments = normalizeRow(this.tableData.alignments, finalColumns, '').map((value) => value ?? null);
    matrix.alignments = alignments;
    const requiredTableRows = target.row + payload.cells.length;
    while (matrix.rows.length + 1 < requiredTableRows) {
      matrix.rows.push(new Array(finalColumns).fill(''));
    }
    const sourceValue = (value: string) => payload.source === 'meo'
      ? value
      : externalTableCellToMarkdown(value);
    for (let rowOffset = 0; rowOffset < payload.cells.length; rowOffset += 1) {
      const destinationRow = target.row + rowOffset;
      const destination = destinationRow === 0
        ? matrix.headerCells
        : matrix.rows[destinationRow - 1];
      if (!destination) continue;
      for (let columnOffset = 0; columnOffset < payload.cells[rowOffset].length; columnOffset += 1) {
        destination[target.col + columnOffset] = sourceValue(payload.cells[rowOffset][columnOffset]);
      }
    }
    return this.buildMatrixTransaction(matrix, dom, target, { preserveScrollPosition: true });
  }

  applyTablePaste(payload: TableClipboardMatrix, target: CellCoords) {
    const view = this.view;
    if (!view) return;
    const commit = this.cellInteraction.accept({ type: 'commit', reason: 'command' }).commit;
    const confirmation = commit
      ? createTableCellCommitConfirmation(this.cellInteraction, commit.generation)
      : null;
    if (confirmation) this.cancelPendingCellAutoCommit();
    let plan: TableCommandTransactionPlan;
    try {
      plan = this.buildPasteCellsTransaction(payload, target);
    } catch (error) {
      confirmation?.settle('failed');
      throw error;
    }
    const confirmations = confirmation ? [confirmation] : [];
    executeTableCellCommitBoundary(confirmations, () => {
      if (!plan.transaction) return;
      for (const pending of confirmations) pending.applied = true;
      this.preserveTableCommandViewport(() => view.dispatch({ userEvent: 'input.table-command.paste', ...plan.transaction! }));
      plan.restoreInteraction?.();
    });
  }

  clearSelectedCellContents(): boolean {
    const range = this.cellSelection.selectedCellRange();
    const view = this.view;
    const dom = this.domRefs?.wrap;
    if (!range || !view || !dom) return false;
    // The history event owns the same semantic target as the immediate focus
    // restore. This survives host-driven undo where no textarea is focused.
    const revealTarget = { row: range.fromRow, col: range.fromCol };
    const currentRange = this.resolveCurrentTableRange(view, dom);
    const tableStartLine = currentRange
      ? view.state.doc.lineAt(currentRange.from).number
      : this.tableData.startLine;
    const historyFocusEffects = currentRange
      ? [getTableHistoryFocus(view.state).effect({
          tableFrom: currentRange.from,
          ...revealTarget,
          caret: 0
        })]
      : [];

    const commit = this.cellInteraction.accept({ type: 'commit', reason: 'command' }).commit;
    const confirmation = commit
      ? createTableCellCommitConfirmation(this.cellInteraction, commit.generation)
      : null;
    if (confirmation) this.cancelPendingCellAutoCommit();
    let plan: TableCommandTransactionPlan;
    try {
      const matrix = this.readCellMatrix();
      for (let row = range.fromRow; row <= range.toRow; row += 1) {
        const cells = row === 0 ? matrix.headerCells : matrix.rows[row - 1];
        if (!cells) continue;
        for (let col = range.fromCol; col <= range.toCol; col += 1) {
          if (col < cells.length) cells[col] = '';
        }
      }
      plan = this.buildMatrixTransaction(matrix, dom, null, {
        preserveScrollPosition: true,
        extraEffects: historyFocusEffects
      });
    } catch (error) {
      confirmation?.settle('failed');
      throw error;
    }

    const replacedInput = dom.querySelector<HTMLTextAreaElement>(
      `textarea[data-table-row="${revealTarget.row}"][data-table-col="${revealTarget.col}"]`
    );
    const confirmations = confirmation ? [confirmation] : [];
    executeTableCellCommitBoundary(confirmations, () => {
      if (!plan.transaction) return;
      for (const pending of confirmations) pending.applied = true;
      this.preserveTableCommandViewport(() => view.dispatch({ userEvent: 'input.table-command.clear', ...plan.transaction! }));
      this.scheduleFocusCellAfterCommit(
        view,
        tableStartLine,
        { ...revealTarget, caret: 0 },
        replacedInput
      );
    });
    return true;
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
    const cancelOutsidePointerExit = () => {
      pendingOutsidePointerId = null;
      if (outsidePointerExitTimer !== null) window.clearTimeout(outsidePointerExitTimer);
      outsidePointerExitTimer = null;
    };

    const applyPointerTransition = (
      transition: TableCellSelectionTransition,
      event: PointerEvent,
      caretCell: HTMLTableCellElement | null
    ) => {
      if (!transition.accepted) return false;
      const request = transition.effects.find((effect) => effect.kind === 'caret-request');
      if (!request || request.kind !== 'caret-request') {
        return this.applyCellSelectionTransition(transition, { event });
      }
      if (!caretCell) return false;
      let pointerCaret: TablePointerCaret;
      try {
        pointerCaret = this.pointerCaretForCell(caretCell, event.clientX, event.clientY, {
          nearestFallback: request.nearestFallback
        });
      } catch (primaryError) {
        const failed = this.cellSelection.accept({
          type: 'caret-failed',
          requestId: request.requestId
        });
        if (!failed.accepted) throw primaryError;
        return this.applyCellSelectionTransition(failed, { event, primaryError });
      }
      const completed = this.cellSelection.accept({
        type: 'caret-resolved',
        requestId: request.requestId,
        numericOffset: pointerCaret.editorOffset ?? request.fallbackOffset
      });
      return this.applyCellSelectionTransition(completed, { event, domCaret: pointerCaret.domCaret });
    };

    const exitAfterOutsidePointer = () => {
      const wrap = getWrap();
      const active = document.activeElement;
      this.exitTableInteraction(wrap, 'outside');
      if (active instanceof HTMLElement && table.contains(active)) {
        active.blur();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      cancelOutsidePointerExit();
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
      const hit = tablePointerTarget(event);
      if (hit.kind !== 'cell') {
        // Grid pixels have no text caret. Prevent CodeMirror's outer hit test
        // without inventing a neighbouring cell or changing the prior range.
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const cell = hit.cell;
      this.setContextMenuOpen(false);
      const current = this.coordsFromCell(cell);
      if (!current) return;
      const selectionPhase = this.cellSelection.snapshot().phase;
      if (
        this.cellSelection.ownsPointer(event.pointerId) &&
        (selectionPhase === 'text-candidate' || selectionPhase === 'dragging')
      ) {
        // A window-focus change can swallow pointerup/pointercancel and leave the
        // previous gesture owning the state machine forever. A renewed press from
        // that same pointer is a definitive boundary, so retire it first.
        this.clearSelection('replacement');
      }
      if (event.target instanceof HTMLTextAreaElement && this.linePresentation?.input !== event.target) {
        const transition = this.cellSelection.accept({
          type: 'activate', pointerId: event.pointerId, cell: current, origin: 'textarea'
        });
        if (!transition.accepted) return;
        pendingOutsidePointerId = null;
        if (outsidePointerExitTimer !== null) {
          window.clearTimeout(outsidePointerExitTimer);
          outsidePointerExitTimer = null;
        }
        this.applyCellSelectionTransition(transition, { event });
        return;
      }
      const anchor = current;
      const input = cell.querySelector('textarea');
      const extendFrom = event.shiftKey && input instanceof HTMLTextAreaElement && this.linePresentation?.input === input
        ? input.selectionDirection === 'backward' ? input.selectionEnd : input.selectionStart
        : undefined;
      const transition = this.cellSelection.accept({
        type: 'begin',
        pointerId: event.pointerId,
        cell: anchor,
        fallbackOffset: input instanceof HTMLTextAreaElement ? input.value.length : 0,
        extendFrom
      });
      if (!transition.accepted) return;
      pendingOutsidePointerId = null;
      if (outsidePointerExitTimer !== null) {
        window.clearTimeout(outsidePointerExitTimer);
        outsidePointerExitTimer = null;
      }
      applyPointerTransition(transition, event, cell);
    };

    const findDragCell = (event: PointerEvent, preserveTextCandidate = true): HTMLTableCellElement | null => {
      const hit = this.findCellElement(document.elementFromPoint(event.clientX, event.clientY));
      if (hit) return hit;
      const grid = this.rowWindow && this.domRefs
        ? this.domRefs.rowEntries.map(({ row }) => Array.from(row.cells))
        : this.domRefs?.cellGrid;
      if (!grid?.length || !grid[0].length) return null;
      // Project onto this table's nearest row and column, including beyond its edges.
      // Binary search uses current geometry without scanning every cell in a large table.
      let row = 0;
      let lastRow = grid.length - 1;
      while (row < lastRow) {
        const middle = Math.floor((row + lastRow) / 2);
        if (event.clientY < grid[middle][0].getBoundingClientRect().bottom) lastRow = middle;
        else row = middle + 1;
      }
      const cells = grid[row];
      let col = 0;
      let lastCol = cells.length - 1;
      while (col < lastCol) {
        const middle = Math.floor((col + lastCol) / 2);
        if (event.clientX < cells[middle].getBoundingClientRect().right) lastCol = middle;
        else col = middle + 1;
      }
      const state = this.cellSelection.snapshot();
      // Leaving a text drag in its original cell still ends the native text preview.
      if (preserveTextCandidate && state.phase === 'text-candidate' && state.anchor?.row === Number(cells[col].dataset.tableRow) && state.anchor.col === col) return null;
      return cells[col];
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!this.cellSelection.ownsPointer(event.pointerId)) return;
      const cell = findDragCell(event);
      if (!cell) {
        const transition = this.cellSelection.accept({
          type: 'move', pointerId: event.pointerId, cell: null
        });
        this.applyCellSelectionTransition(transition, { event });
        return;
      }
      const current = this.coordsFromCell(cell);
      if (!current) return;
      const transition = this.cellSelection.accept({
        type: 'move',
        pointerId: event.pointerId,
        cell: current
      });
      applyPointerTransition(transition, event, cell);
    };

    const endPointerSelection = (event: PointerEvent) => {
      const hit = event.type === 'pointerup' ? document.elementFromPoint(event.clientX, event.clientY) : null;
      const endedInsideTable = (hit instanceof Node && table.contains(hit)) || (
        !event.isTrusted && event.target instanceof Node && table.contains(event.target)
      );
      const releaseCell = event.type === 'pointerup'
        ? this.findCellElement(hit) ?? (endedInsideTable && this.cellSelection.ownsPointer(event.pointerId)
          ? findDragCell(event, false) : null)
        : null;
      const releaseCoords = releaseCell ? this.coordsFromCell(releaseCell) : null;
      const transition = event.type === 'pointerup'
        ? this.cellSelection.accept({
            type: 'end',
            pointerId: event.pointerId,
            cell: releaseCoords,
            insideTable: endedInsideTable
          })
        : this.cellSelection.accept({
            type: 'abort',
            pointerId: event.pointerId,
            reason: event.type === 'lostpointercapture' ? 'lostcapture' : 'pointercancel'
          });
      applyPointerTransition(transition, event, releaseCell);
    };

    const onCopy = (event: ClipboardEvent) => {
      if (!this.domRefs) return;
      const range = this.cellSelection.selectedCellRange();
      if (!range) {
        if (event.target instanceof HTMLTextAreaElement && table.contains(event.target)) {
          writeTableCellTextSelection(event, event.target);
        }
        return;
      }
      const values = this.copyCellMatrix(range);
      const serialized = this.cellSelection.copy(values);
      if (!serialized) return;
      event.preventDefault();
      event.stopPropagation();
      event.clipboardData?.setData('text/plain', serialized.plain);
      event.clipboardData?.setData('text/html', serialized.html);
      event.clipboardData?.setData(meoTableClipboardMime, serialized.meo);
    };

    const onDoubleClick = (event: MouseEvent) => {
      const presentation = this.linePresentation;
      if (!presentation || this.composingInput || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const { input, line, valueFrom } = presentation;
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      if (document.activeElement !== input || this.findCellElement(hit) !== input.closest(tableCellSelector)) return;
      // Mixed lines use the table's pointer selection, so restore the native
      // double-click word selection after the release has placed the caret.
      const text = line.text + line.breakText;
      const segments = new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text);
      const offset = input.selectionStart - valueFrom;
      const current = segments.containing(offset);
      const previous = segments.containing(offset - 1);
      const word = current?.isWordLike ? current : previous?.isWordLike ? previous : current;
      if (!word) return;
      event.preventDefault();
      input.setSelectionRange(valueFrom + word.index, valueFrom + word.index + word.segment.length);
      this.updateCellLinePresentation(input);
      this.emitTableSelectionChange(getWrap());
    };

    const onPaste = (event: ClipboardEvent) => {
      if (!(event.target instanceof Node) || !table.contains(event.target)) return;
      const payload = this.clipboardPayload(event);
      if (!payload) return;
      const targetCell = this.findCellElement(event.target);
      const target = targetCell ? this.coordsFromCell(targetCell) : this.cellSelection.snapshot().anchor;
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      const height = Math.max(this.tableData.rows.length + 1, target.row + payload.cells.length);
      const width = Math.max(this.tableData.colCount, target.col + payload.cells[0].length);
      if (height * width > 10_000) return;
      this.applyTablePaste(payload, target);
    };

    const onDragStart = (event: DragEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.meo-md-html-table-cell-preview')) return;
      event.preventDefault();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (this.composingInput || event.isComposing || event.keyCode === 229) return;
      if (this.handleHistoryShortcut(event, table)) {
        return;
      }
      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey &&
        this.clearSelectedCellContents()
      ) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
        event.preventDefault();
        event.stopPropagation();
        this.setContextMenuOpen(true, true);
      }
    };

    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (this.composingInput || event.isComposing || event.keyCode === 229) return;
      if (event.key !== 'Escape') return;
      // A modal owns Escape while the cell selection is kept for focus return.
      if (event.target instanceof Element && event.target.closest('dialog[open]')) return;
      this.releaseCellPresentation();
      if (this.domRefs && !this.domRefs.contextMenu.hidden) {
        event.preventDefault();
        event.stopPropagation();
        if (this.deleteTableConfirmationTimer !== null) {
          this.clearDeleteTableConfirmation();
          this.updateContextControlsPosition();
          return;
        }
        this.setContextMenuOpen(false);
        return;
      }
      const transition = this.cellSelection.accept({ type: 'clear', reason: 'escape' });
      this.applyCellSelectionTransition(transition, { event });
    };

    const onFocusOut = (event: FocusEvent) => {
      const phase = this.cellSelection.snapshot().phase;
      // A native focus return must not retire a newer held pointer, including
      // a multi-cell range whose former editing target has already ended.
      if (phase === 'text-candidate' || phase === 'dragging') return;
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Element && nextTarget.closest('.meo-hex-color-adjustment')) return;
      const wrap = this.domRefs?.wrap ?? table;
      const container = this.domRefs?.container ?? wrap;
      if (nextTarget instanceof Node && container.contains(nextTarget)) return;
      const nextTableShell = nextTarget instanceof Element
        ? nextTarget.closest('.meo-md-html-table-shell')
        : null;
      if (nextTableShell) {
        if (nextTableShell !== this.domRefs?.shell) this.transferTableInteraction(wrap);
        return;
      }
      if (pendingTableSwitchPointerId !== null) {
        this.transferTableInteraction(wrap);
        return;
      }
      const view = this.getEditorView(wrap);
      if (view) commitPendingTableEdits(view);
      // Window activation and Webview chrome suspend the native input. Only a
      // new document focus target ends the cell session; outside clicks have
      // their own explicit boundary below, including clicks with no focus target.
      if (!this.cellInteraction.snapshot().editingTarget || (nextTarget instanceof Node && view?.dom.contains(nextTarget))) {
        this.exitTableInteraction(wrap);
      }
    };

    const onDocumentPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (this.heldCellPresentation) {
        this.holdCellPresentation(event.pointerId);
        pendingTableSwitchPointerId = event.pointerId;
      }
      // Menu actions clear confirmation on click. Collapsing on pointerdown moves
      // trailing controls before pointerup and loses the original click target.
      if (!this.domRefs?.contextMenu.contains(event.target)) this.clearDeleteTableConfirmation();
      const wrap = getWrap();
      const container = getContainer();
      // Chrome and modals temporarily own focus. A delayed outside-table exit
      // would otherwise clear the cell after their close handler restores it.
      if (isEditingMenuTarget(event.target) || (event.target instanceof Element && event.target.closest('dialog[open], .mode-toolbar, .find-panel'))) {
        return;
      }
      const isOutsideTable = !container.contains(event.target);
      // Focus-preserving toolbar presses do not end editing in the active cell.
      if (isOutsideTable && event.defaultPrevented) return;
      const targetTableShell = event.target instanceof Element
        ? event.target.closest('.meo-md-html-table-shell')
        : null;
      if (isOutsideTable && targetTableShell) {
        pendingTableSwitchPointerId = event.pointerId;
        this.holdCellPresentation(event.pointerId);
        this.transferTableInteraction(wrap);
        return;
      }
      if (!isOutsideTable && isModifierLinkActivationEvent(event)) return;
      if (!isOutsideTable && isTableControlTarget(event.target)) {
        return;
      }
      this.setContextMenuOpen(false);
      const active = document.activeElement;
      if (isOutsideTable) {
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
      if (event.buttons === 0 && this.heldCellPresentation?.pointerId === event.pointerId) {
        this.releaseCellPresentation();
        pendingTableSwitchPointerId = null;
      }
      if (table.hasPointerCapture?.(event.pointerId)) return;
      if (event.target instanceof Node && table.contains(event.target)) return;
      onPointerMove(event);
    };

    const onDocumentPointerEnd = (event: PointerEvent) => {
      if (event.pointerId === pendingTableSwitchPointerId || this.heldCellPresentation?.pointerId === event.pointerId) {
        const pointerId = event.pointerId;
        const presentation = this.heldCellPresentation;
        window.setTimeout(() => {
          if (pendingTableSwitchPointerId === pointerId) pendingTableSwitchPointerId = null;
          this.releaseCellPresentation(presentation);
        }, 0);
      }
      const targetInsideTable = event.target instanceof Node && table.contains(event.target);
      if (!table.hasPointerCapture?.(event.pointerId) || !targetInsideTable) {
        endPointerSelection(event);
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
    table.addEventListener('dblclick', onDoubleClick);
    table.addEventListener('pointercancel', endPointerSelection);
    table.addEventListener('lostpointercapture', endPointerSelection);
    document.addEventListener('copy', onCopy, true);
    document.addEventListener('paste', onPaste, true);
    table.addEventListener('dragstart', onDragStart);
    table.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    table.addEventListener('focusout', onFocusOut);
    // Find and other explicit navigation can return to a cell before a prior
    // outside click's deferred commit runs. That old gesture must not end the
    // new native editing session or blur its selection on the following frame.
    table.addEventListener('focusin', cancelOutsidePointerExit);
    document.addEventListener('pointerdown', onDocumentPointerDown, true);
    document.addEventListener('pointermove', onDocumentPointerMove, true);
    document.addEventListener('pointerup', onDocumentPointerEnd, true);
    document.addEventListener('pointercancel', onDocumentPointerEnd, true);
    const onExternalPresentation = (event: Event) => {
      if (!(event instanceof CustomEvent) || event.detail?.owner !== this.view?.dom) return;
      this.releaseCellPresentation();
      this.discardPendingCellEdits();
      this.exitTableInteraction(getWrap(), 'external');
    };
    document.addEventListener('meo-table-selection-external-presentation', onExternalPresentation);
    const onCommitTableEdits = (event: Event) => {
      const hadPendingEdits = this.hasPendingCellEdits;
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      if (isPendingTableCommitDetail(detail)) {
        const pending = this.takePendingTransactionBuilders(getWrap());
        if (pending) {
          detail.transactionBuilders.push(...pending.builders);
          detail.confirmations.push(pending.confirmation);
        }
        detail.committed = Boolean(detail.committed || hadPendingEdits);
      }
    };
    document.addEventListener('meo-commit-table-edits', onCommitTableEdits);
    this.cleanupFns.push(() => {
      table.removeEventListener('pointerdown', onPointerDown);
      table.removeEventListener('pointermove', onPointerMove);
      table.removeEventListener('pointerup', endPointerSelection);
      table.removeEventListener('dblclick', onDoubleClick);
      table.removeEventListener('pointercancel', endPointerSelection);
      table.removeEventListener('lostpointercapture', endPointerSelection);
      document.removeEventListener('copy', onCopy, true);
      document.removeEventListener('paste', onPaste, true);
      table.removeEventListener('dragstart', onDragStart);
      table.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keydown', onDocumentKeyDown, true);
      table.removeEventListener('focusout', onFocusOut);
      table.removeEventListener('focusin', cancelOutsidePointerExit);
      document.removeEventListener('pointerdown', onDocumentPointerDown, true);
      document.removeEventListener('pointermove', onDocumentPointerMove, true);
      document.removeEventListener('pointerup', onDocumentPointerEnd, true);
      document.removeEventListener('pointercancel', onDocumentPointerEnd, true);
      document.removeEventListener('meo-table-selection-external-presentation', onExternalPresentation);
      document.removeEventListener('meo-commit-table-edits', onCommitTableEdits);
      pendingOutsidePointerId = null;
      pendingTableSwitchPointerId = null;
      this.heldCellPresentation = null;
      if (outsidePointerExitTimer !== null) {
        window.clearTimeout(outsidePointerExitTimer);
        outsidePointerExitTimer = null;
      }
    });
  }

  takePendingTransactionBuilders(dom: HTMLElement | undefined): {
    view: EditorView;
    builders: PendingTableTransactionBuilder[];
    confirmation: TableCellCommitConfirmation;
  } | null {
    const commit = this.cellInteraction.accept({ type: 'commit', reason: 'command' }).commit;
    if (!commit) return null;
    const view = this.getEditorView(dom);
    if (!view) {
      this.cellInteraction.accept({ type: 'commit-result', generation: commit.generation, outcome: 'failed' });
      return null;
    }
    const currentRange = dom ? this.resolveCurrentTableRange(view, dom) : null;
    if (!currentRange) {
      this.cellInteraction.accept({ type: 'commit-result', generation: commit.generation, outcome: 'failed' });
      return null;
    }
    const pendingCellEdits = commit.edits;
    const confirmation = createTableCellCommitConfirmation(this.cellInteraction, commit.generation);
    this.cancelPendingCellAutoCommit();
    if (pendingCellEdits.length) {
      // The widget can survive edits made before the table, so its captured
      // absolute offset may be stale. Resolve through the mounted DOM before
      // translating row coordinates back into current Markdown line numbers.
      return {
        view,
        confirmation,
        builders: pendingCellEdits.map((edit) => ({
          sequence: edit.sequence,
          confirmation,
          build: (state) => {
            const tableStartLine = this.resolveCurrentTableStartLine(view, edit.row, currentRange);
            if (tableStartLine === null) return null;
            const change = this.pendingCellSourceChange(state, edit, tableStartLine);
            if (!change) return null;
            // Only the next line's coordinates are needed here. Constructing a
            // speculative EditorState also runs every presentation field before
            // the real native-input transaction below can defer its parsing.
            const next = state.changes(change).apply(state.doc);
            const line = next.line(tableStartLine + (edit.row === 0 ? 0 : edit.row + 1));
            const segment = parseTableLine(line.number, line.from, line.to, line.text).segments[edit.col];
            const origins = this.cellSymbolSnapshots.get(edit.sequence) ?? [];
            this.cellSymbolSnapshots.delete(edit.sequence);
            const source = tableCellEditorValueToSource(edit.value);
            const sourcePadding = source.length - source.trimStart().length;
            const content = segment ? next.sliceString(segment.from, segment.to) : '';
            const start = segment ? segment.from + content.length - content.trimStart().length : 0;
            const pairs = origins.map(pair => ({ ...pair, from: start + tableCellEditorOffsetToSourceOffset(edit.value, pair.from) - sourcePadding, to: start + tableCellEditorOffsetToSourceOffset(edit.value, pair.to) - sourcePadding }))
              .filter(pair => !!segment && pair.from >= segment.from && pair.to <= segment.to);
            const stableRow = next.lines === state.doc.lines
              && parseTableLine(line.number, 0, 0, state.doc.line(line.number).text).cells.length === parseTableLine(line.number, 0, 0, line.text).cells.length
              && !(edit.row === 0 && isTableDelimiterLine(line.text));
            return state.update({ changes: change, effects: [
              ...(segment ? [replaceAutomaticSymbolPairArea(segment.from, segment.to, pairs)] : []),
              ...(stableRow ? [getTableHistoryFocus(state).effect({ tableFrom: next.line(tableStartLine).from,
                row: edit.row, col: edit.col, caret: 0, contentOnly: true })] : [])
            ],
              annotations: [isolateHistory.of('full'), ...(usesLargeDocumentDerivedWorkBudget(state) ? [markLiveInputNestedProjection()] : [])] });
          }
        }))
      };
    }
    const changes = this.collectPendingCellSourceChanges(view);
    return {
      view,
      confirmation,
      builders: changes.length ? [{
        sequence: ++nextTableCellEditSequence,
        confirmation,
        build: (state) => state.update({ changes, annotations: [isolateHistory.of('full'), ...(usesLargeDocumentDerivedWorkBudget(state) ? [markLiveInputNestedProjection()] : [])] })
      }] : []
    };
  }

  preserveTableCommandViewport(run: () => void) {
    const view = this.view;
    const controller = view ? getViewportController(view) : null;
    if (!view || !controller) {
      run();
      return;
    }
    const scrollLeft = view.scrollDOM.scrollLeft;
    const shell = this.domRefs?.shell ?? null;
    const tableStartLine = shell?.dataset.meoRenderedBlockStartLine;
    if (!shell || !tableStartLine) {
      const scrollTop = view.scrollDOM.scrollTop;
      run();
      view.scrollDOM.scrollLeft = scrollLeft;
      controller.lockScrollTop(scrollTop);
      return;
    }
    controller.preserveElementPositionWhileMutation(
      shell,
      () => view.dom.querySelector<HTMLElement>(
        `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${tableStartLine}"]`
      ),
      () => {
        run();
        view.scrollDOM.scrollLeft = scrollLeft;
      },
      'immediate',
      true
    );
  }

  buildAlignmentTransaction(
    alignment: 'left' | 'center' | 'right',
    target: TableCommandTarget
  ): TableCommandTransactionPlan {
    const dom = this.domRefs?.wrap;
    const view = this.view;
    const columns = this.selectedColumns(target);
    if (!dom || !view || !columns.length) return { transaction: null, outcome: 'no-op' };
    if (!this.resolveCurrentTableRange(view, dom)) return { transaction: null, outcome: 'no-op' };
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return { transaction: null, outcome: 'no-op' };
    const alignments = normalizeRow(this.tableData.alignments, matrix.headerCells.length, '').map((value) => value ?? null);
    for (const column of columns) alignments[column] = alignment;
    matrix.alignments = alignments;
    return this.buildMatrixTransaction(matrix, dom, { row: target.row ?? 0, col: columns[0] }, {
      alignmentOverrideColumns: columns
    });
  }

  buildTableCommandTransaction(
    command: TableCommand,
    target: TableCommandTarget
  ): TableCommandTransactionPlan {
    const view = this.view, dom = this.domRefs?.wrap;
    const range = view && dom ? this.resolveCurrentTableRange(view, dom) : null;
    const row = target.row ?? this.activeTarget.row, col = target.column ?? this.activeTarget.col;
    const input = this.domRefs?.allRowInputs?.[row]?.[col];
    const beforeFocus: TableHistoryFocusTarget | null = range ? { tableFrom: range.from, row, col,
      caret: input?.selectionStart ?? 0, selectionEnd: input?.selectionEnd ?? 0,
      selectionDirection: input?.selectionDirection ?? 'none' } : null;
    const commit = this.cellInteraction.accept({ type: 'commit', reason: 'command' }).commit;
    const confirmation = commit
      ? createTableCellCommitConfirmation(this.cellInteraction, commit.generation)
      : null;
    if (confirmation) this.cancelPendingCellAutoCommit();
    try {
      let plan = this.buildTableCommandTransactionPlan(command, target);
      if (view && range && plan.transaction?.changes) {
        const changes = view.state.changes(plan.transaction.changes);
        if (!changes.empty) {
          if (plan.historyFocusAfter === undefined) throw new Error('Table command must declare its history focus');
          const afterFocus: TableHistoryFocusTarget | null = plan.historyFocusAfter === null ? null
            : { tableFrom: changes.mapPos(range.from, -1), ...plan.historyFocusAfter, caret: plan.historyFocusAfter.caret ?? 0 };
          const effects = plan.transaction.effects;
          const previous: readonly StateEffect<unknown>[] = !effects ? [] : Array.isArray(effects) ? effects : [effects as StateEffect<unknown>];
          plan = { ...plan, transaction: { ...plan.transaction,
            effects: [...previous, getTableHistoryFocus(view.state).effect(afterFocus, beforeFocus)] } };
        }
      }
      const movedToInsertedRow = command === 'insert-row-below' && target.insertedRowFocus !== undefined;
      const preserveViewport = command !== 'delete-table' && !movedToInsertedRow;
      if (!confirmation) return plan.transaction ? { ...plan, preserveViewport } : plan;
      if (!plan.transaction) {
        confirmation.settle('failed');
        return plan;
      }
      return { ...plan, preserveViewport, confirmations: [confirmation] };
    } catch (error) {
      confirmation?.settle('failed');
      throw error;
    }
  }

  buildTableCommandTransactionPlan(
    command: TableCommand,
    target: TableCommandTarget
  ): TableCommandTransactionPlan {
    const dom = this.domRefs?.wrap;
    if (!dom) return { transaction: null, outcome: 'no-op' };
    const bodyRow = this.bodyRowIndexFor(target.row);
    const column = this.columnIndexFor(target.column);
    const selectedRows = this.selectedBodyRows(target);
    const selectedColumns = this.selectedColumns(target);

    switch (command) {
      case 'insert-row-above': {
        const firstRow = selectedRows.length ? Math.min(...selectedRows) : bodyRow;
        return firstRow === null
          ? this.buildAddRowAfter(dom, -1, column ?? 0)
          : this.buildAddRowBefore(dom, firstRow, column ?? 0);
      }
      case 'insert-row-below': {
        const lastRow = selectedRows.length ? Math.max(...selectedRows) : bodyRow;
        return this.buildAddRowAfter(dom, lastRow ?? -1, column ?? 0, target.insertedRowFocus);
      }
      case 'move-row-up':
        return this.buildMoveRows(dom, selectedRows, 'up', column ?? 0, target.row ?? 1);
      case 'move-row-down':
        return this.buildMoveRows(dom, selectedRows, 'down', column ?? 0, target.row ?? 1);
      case 'delete-row': {
        return this.buildRemoveRowsAt(dom, selectedRows, column ?? 0);
      }
      case 'insert-column-left': {
        const firstColumn = selectedColumns.length ? Math.min(...selectedColumns) : column;
        return firstColumn === null
          ? { transaction: null, outcome: 'no-op' }
          : this.buildAddColumnBefore(dom, firstColumn, target.row ?? 0);
      }
      case 'insert-column-right': {
        const lastColumn = selectedColumns.length ? Math.max(...selectedColumns) : column;
        return lastColumn === null
          ? { transaction: null, outcome: 'no-op' }
          : this.buildAddColumnAfter(dom, lastColumn, target.row ?? 0);
      }
      case 'move-column-left':
        return this.buildMoveColumns(dom, selectedColumns, 'left', target.row ?? 0, column ?? 0);
      case 'move-column-right':
        return this.buildMoveColumns(dom, selectedColumns, 'right', target.row ?? 0, column ?? 0);
      case 'delete-column': {
        return this.buildRemoveColumnsAt(dom, selectedColumns, target.row ?? 0);
      }
      case 'delete-table':
        return this.buildDeleteTableTransaction(dom);
      case 'align-left':
        return this.buildAlignmentTransaction('left', target);
      case 'align-center':
        return this.buildAlignmentTransaction('center', target);
      case 'align-right':
        return this.buildAlignmentTransaction('right', target);
      case 'sort-ascending':
      case 'sort-descending':
        return column === null
          ? { transaction: null, outcome: 'no-op' }
          : this.buildSortedRowsTransaction(dom, column, command === 'sort-ascending', target.row ?? 0);
    }
  }

  buildDeleteTableTransaction(dom: HTMLElement): TableCommandTransactionPlan {
    const view = this.getEditorView(dom);
    const range = view ? this.resolveCurrentTableRange(view, dom) : null;
    if (!view || !range) return { transaction: null, outcome: 'no-op' };
    const from = view.state.doc.lineAt(range.from).from;
    const to = view.state.doc.lineAt(Math.max(range.from, range.to - 1)).to;
    return {
      transaction: { changes: { from, to, insert: '' }, selection: { anchor: from } },
      outcome: 'changed',
      historyFocusAfter: null,
      afterDispatch: () => {
        this.pendingContextMenuRestore = false;
        this.setContextMenuOpen(false);
      },
      restoreInteraction: () => {
        view.focus();
        const viewport = getViewportController(view);
        if (viewport) viewport.revealPositionUntilStable(from, { yMargin: view.defaultLineHeight }, viewport.beginNavigationReveal());
      }
    };
  }

  buildSortedRowsTransaction(
    dom: HTMLElement,
    column: number,
    ascending: boolean,
    focusRow: number
  ): TableCommandTransactionPlan {
    const matrix = this.readCellMatrix();
    if (matrix.rows.length < 2) return { transaction: null, outcome: 'no-op' };
    // Compare the existing inline presentation, while moving the original Markdown
    // cells together. Pending native input must be reflected before reading its label.
    const values = matrix.rows.map((row, index) => {
      const input = this.domRefs?.rowInputs[index]?.[column];
      if (input && row[column] !== this.tableData.rows[index]?.[column]) this.refreshCellPreviewFromInput(input);
      const mounted = this.domRefs?.cellGrid[index + 1]?.[column]?.querySelector('.meo-md-html-table-cell-preview');
      const preview = mounted ? mounted.cloneNode(true) as HTMLElement
        : this.createCellPreview(row[column] ?? '', this.cellDiagnostics(index + 1, column), this.cellSourceRange(index + 1, column));
      preview.querySelectorAll('button, svg, .katex-mathml').forEach((element) => element.remove());
      preview.querySelectorAll('br').forEach((element) => element.replaceWith(' '));
      preview.querySelectorAll('img').forEach((element) => element.replaceWith(element.alt));
      const value = (preview.textContent ?? '').trim();
      if (!mounted) disposeImagePresentations(preview);
      return value;
    });
    const numeric = values.every((value) => !value || (
      /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))
    ));
    const collator = new Intl.Collator(this.view!.state.facet(uiLanguageFacet), { numeric: true, sensitivity: 'base' });
    const sourceRowOrder = matrix.rows.map((_row, index) => index).sort((left, right) => {
      const a = values[left], b = values[right];
      if (!a || !b) return Number(!a) - Number(!b) || left - right;
      const compared = numeric ? Number(a) - Number(b) : collator.compare(a, b);
      return compared * (ascending ? 1 : -1) || left - right;
    });
    matrix.rows = sourceRowOrder.map((index) => matrix.rows[index]);
    const plan = this.buildMatrixTransaction(matrix, dom, {
      row: focusRow > 0 ? sourceRowOrder.indexOf(focusRow - 1) + 1 : 0,
      col: column
    }, { sourceRowOrder, preserveScrollPosition: true });
    return {
      ...plan,
      afterDispatch: () => this.applyCellSelectionTransition(this.cellSelection.accept({ type: 'clear', reason: 'escape' }))
    };
  }

  recordPendingCellEdit(row: number, col: number, value: string) {
    const sequence = ++nextTableCellEditSequence;
    const input = this.domRefs?.allRowInputs?.[row]?.[col];
    if (input) this.cellSymbolSnapshots.set(sequence, nativeSymbolInput(input)?.snapshot() ?? []);
    if (this.cellSymbolSnapshots.size > 512) this.cellSymbolSnapshots.delete(this.cellSymbolSnapshots.keys().next().value!);
    const inputResult = this.cellInteraction.accept({ type: 'input', target: { row, col }, value, sequence });
    this.view?.state.facet(tablePendingDraftProjectionReporterFacet)?.(this.view);
    return inputResult.scheduleAutoCommit?.generation ?? null;
  }

  cancelPendingCellAutoCommit() {
    if (this.pendingCellAutoCommitTimer === null) return;
    window.clearTimeout(this.pendingCellAutoCommitTimer);
    this.pendingCellAutoCommitTimer = null;
  }

  schedulePendingCellAutoCommit(input: HTMLTextAreaElement, row: number, col: number, generation: number | null) {
    if (generation === null) return;
    this.cancelPendingCellAutoCommit();
    this.pendingCellAutoCommitTimer = window.setTimeout(() => {
      this.pendingCellAutoCommitTimer = null;
      const view = this.view;
      if (!view || !this.cellInteraction.accept({ type: 'timer', generation }).timerCurrent || document.activeElement !== input) return;
      const currentRange = this.domRefs ? this.resolveCurrentTableRange(view, this.domRefs.wrap) : null;
      if (!currentRange) return;
      const tableStartLine = this.resolveCurrentTableStartLine(view, row, currentRange);
      if (tableStartLine === null) return;
      const focusTarget = { row, col, caret: input.selectionStart ?? 0 };
      if (commitPendingTableEdits(view)) {
        // Source confirmation stays within the native editing session. Its
        // painted anchor survives later parser and layout updates; no absolute
        // scroll lock, new navigation or caret rewrite is needed for this DOM.
        if (input.isConnected && document.activeElement === input) return;
        this.scheduleFocusCellAfterCommit(
          view,
          tableStartLine,
          focusTarget,
          input,
          null,
          { revealCaret: false }
        );
      }
    }, tableCellAutoCommitDelayMs);
  }

  pendingCellSourceChange(state: Pick<EditorState, 'doc'>, edit: TableCellEditIntent, tableStartLine: number): ChangeSpec | null {
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
    return { from: line.from, to: line.to, insert: `${this.tableData.indent}| ${cells.join(' | ')} |` };
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
        const range = tableCellSourceRangeForInput(view, input);
        if (!range) { requiresRowReplacement = true; continue; }
        const { from, to } = range;
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

  scheduleFocusCellAfterCommit(
    view: EditorView,
    tableStartLine: number,
    focusTarget: PendingCellFocus,
    replacedInput: HTMLTextAreaElement | null = null,
    replacedShell: HTMLElement | null = null,
    options: { revealCaret?: boolean; tableTop?: number } = {}
  ) {
    const { revealCaret = true, tableTop } = options;
    const viewport = getViewportController(view);
    const restoreContextMenu = this.pendingContextMenuRestore;
    const isRevealCurrent = restoreContextMenu || !revealCaret
      ? viewport?.captureNavigationCurrentness() ?? (() => true)
      : viewport?.beginNavigationReveal() ?? (() => true);
    let observer: MutationObserver | null = null;
    let timeout: number | null = null;
    const dispose = () => {
      observer?.disconnect();
      observer = null;
      if (timeout !== null) window.clearTimeout(timeout);
      timeout = null;
    };
    const focusCell = () => {
      if (!isRevealCurrent()) {
        dispose();
        return false;
      }
      const input = ensureMountedTableCell(view, tableStartLine, focusTarget.row, focusTarget.col);
      if (!(input instanceof HTMLTextAreaElement)) return false;
      const shell = input.closest<HTMLElement>('.meo-md-html-table-shell');
      if (replacedShell && shell === replacedShell) return false;
      const owner = shell ? tableDomOwners.get(shell) : undefined;
      // Value-only commits reuse the mounted table DOM, so the original input
      // is already the durable target. Structural commits still replace it and
      // reach this method again through the observer below.
      if (input === replacedInput && !input.isConnected) return false;
      const caret = Math.min(Math.max(focusTarget.caret ?? 0, 0), input.value.length);
      input.focus({ preventScroll: true });
      // Structural replacements can map the outer caret to the table header.
      // Adopt the restored cell explicitly; toolbar/keyboard commands do not
      // own a text-pointer release that could project this position for them.
      const range = tableCellSourceRangeForInput(view, input), head = view.state.selection.main.head;
      if (range && (head < range.from || head > range.to)) {
        view.dispatch({ selection: { anchor: Math.min(range.to,
          range.from + tableCellEditorOffsetToSourceOffset(input.value, caret)) },
          annotations: Transaction.addToHistory.of(false) });
      }
      input.setSelectionRange(caret, caret);
      if (restoreContextMenu) {
        owner?.setContextPage(this.contextPage);
        owner?.setContextMenuOpen(true);
        this.pendingContextMenuRestore = false;
      }
      dispose();
      // A structural commit can destroy this controller before the new cell is mounted.
      if (revealCaret && !restoreContextMenu) {
        if (viewport && shell && tableTop !== undefined) {
          // Earlier rows can still settle after the new cell gets focus.
          // Anchor the editing session to the table, whose top is unaffected
          // by those row heights. A clipped target owns its own reveal instead.
          const shift = tableTop - shell.getBoundingClientRect().top;
          const caret = tableCellCaretViewportBounds(input), bounds = tableUsableViewportBounds(view, input);
          if (caret.top + shift >= bounds.top && caret.bottom + shift <= bounds.bottom
            && viewport.captureNativeInputViewport(input, tableTop, shell)) {
            viewport.reconcileAfterEditorUpdate();
            flushEditorLayout(view);
          }
        }
        owner?.revealTableCellCaretIfNeeded(input, isRevealCurrent);
      } else if (revealCaret) {
        // Most contextual commands stay in place. Sorting/moving can relocate
        // the focused cell outside the viewport; only that case transfers
        // ownership from the old table anchor to a minimal caret reveal.
        const caret = tableCellCaretViewportBounds(input), bounds = tableUsableViewportBounds(view, input);
        if (caret.top < bounds.top || caret.bottom > bounds.bottom) {
          owner?.revealTableCellCaretIfNeeded(input, viewport?.beginNavigationReveal() ?? isRevealCurrent);
        }
      }
      return true;
    };

    if (focusCell()) return;
    // Live derived work can replace a large table later than the fixed eight-frame
    // retry window. Observe the actual replacement so focus returns in the same
    // microtask checkpoint in which the new textarea is mounted.
    observer = new MutationObserver(() => {
      focusCell();
    });
    observer.observe(view.contentDOM, { childList: true, subtree: true });
    timeout = window.setTimeout(dispose, 1500);
    requestAnimationFrame(() => focusCell());
  }

  revealTableCellCaretIfNeeded(input: HTMLTextAreaElement, isCurrent?: () => boolean) {
    const view = this.view;
    if (!view) return;
    const viewport = getViewportController(view);
    if (viewport) {
      const revealIsCurrent = isCurrent ?? viewport.captureNavigationCurrentness();
      if (!revealIsCurrent()) return;
      const revealGeneration = ++this.tableCaretRevealGeneration;
      const canReveal = () => revealIsCurrent() && revealGeneration === this.tableCaretRevealGeneration
        && input.ownerDocument.activeElement === input;
      const inputContextMargin = visualLineContextMargin(view, 1);
      const readUsableViewportBounds = () => tableUsableViewportBounds(view, input);
      let attempts = 0;
      const settle = () => {
        if (!canReveal() || !input.isConnected || attempts >= 8) return;
        attempts += 1;
        const caret = tableCellCaretViewportBounds(input);
        const viewportRect = readUsableViewportBounds();
        const delta = caret.top < viewportRect.top
          ? caret.top - viewportRect.top - inputContextMargin
          : caret.bottom > viewportRect.bottom
            ? caret.bottom - viewportRect.bottom + inputContextMargin
            : 0;
        if (Math.abs(delta) >= 1) {
          viewport.revealVerticalBounds(
            () => canReveal() && input.isConnected ? tableCellCaretViewportBounds(input) : null,
            canReveal,
            { yMargin: inputContextMargin, readViewportBounds: readUsableViewportBounds }
          );
          return;
        }
        requestAnimationFrame(settle);
      };
      settle();
    } else {
      const caret = tableCellCaretViewportBounds(input);
      const viewportRect = tableUsableViewportBounds(view, input);
      if (
        caret.top >= viewportRect.top &&
        caret.bottom <= viewportRect.bottom
      ) return;
      input.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }
  }

  buildMatrixTransaction(
    matrix: CellMatrix,
    dom: HTMLElement,
    focusTarget: PendingCellFocus | null = null,
    {
      preserveScrollPosition = false,
      sourceRowOrder = null,
      focusTableTop,
      extraEffects = [],
      alignmentOverrideColumns = []
    }: {
      preserveScrollPosition?: boolean;
      sourceRowOrder?: number[] | null;
      focusTableTop?: number;
      extraEffects?: readonly StateEffect<unknown>[];
      alignmentOverrideColumns?: readonly number[];
    } = {}
  ): TableCommandTransactionPlan {
    const view = this.getEditorView(dom);
    if (!view) return { transaction: null, outcome: 'no-op' };

    const { headerCells, rows, alignments = this.tableData.alignments } = matrix;
    if (!headerCells.length) return { transaction: null, outcome: 'no-op' };
    const range = this.resolveCurrentTableRange(view, dom);
    if (!range) return { transaction: null, outcome: 'no-op' };
    const tableStartLine = view.state.doc.lineAt(range.from).number;
    const replacedShell = this.domRefs?.shell ?? null;
    const expectsReplacement = (
      headerCells.length !== this.tableData.headerCells.length ||
      rows.length !== this.tableData.rows.length ||
      alignments.some((alignment, index) => alignment !== this.tableData.alignments[index])
    );
    const markdown = serializeTableMarkdown(this.tableData.indent, headerCells, alignments, rows);
    const current = view.state.doc.sliceString(range.from, range.to);
    const commandEffects = alignmentOverrideColumns.length === 0
      ? [...extraEffects]
      : [
          ...extraEffects,
          ...alignmentOverrideColumns.map((column) => setTableHeaderAlignmentOverrideEffect.of({
              from: range.from,
              to: range.from + markdown.length,
              column
            }))
        ];
    if (current === markdown) {
      if (commandEffects.length) {
        return {
          transaction: { effects: commandEffects },
          outcome: 'changed',
          historyFocusAfter: focusTarget,
          restoreInteraction: focusTarget
            ? () => this.scheduleFocusCellAfterCommit(
                view,
                tableStartLine,
                focusTarget,
                null,
                expectsReplacement ? replacedShell : null
              )
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
    return {
      transaction: {
        changes: { from: range.from, to: range.to, insert: markdown },
        effects: [provenanceEffect, ...commandEffects]
      },
      outcome: 'changed',
      preserveViewport: preserveScrollPosition,
      historyFocusAfter: focusTarget,
      restoreInteraction: focusTarget
        ? () => this.scheduleFocusCellAfterCommit(
            view,
            tableStartLine,
            focusTarget,
            null,
            expectsReplacement ? replacedShell : null,
            { tableTop: focusTableTop }
          )
        : undefined
    };
  }

  buildAddRowAfter(
    dom: HTMLElement, rowIndex: number, focusColumn: number, insertedRowFocus?: TableCommandTarget['insertedRowFocus']
  ): TableCommandTransactionPlan {
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return { transaction: null, outcome: 'no-op' };
    const insertAt = Math.min(Math.max(rowIndex + 1, 0), matrix.rows.length);
    const focusTarget = insertedRowFocus
      ? { row: insertAt + 1, col: insertedRowFocus === 'first-cell' ? 0 : focusColumn, caret: 0 }
      : this.focusTargetAfterRowInsertion(insertAt, focusColumn);
    // A windowed table's offscreen rows are still estimates. Its targeted
    // row reveal already preserves the visible region without a shell anchor.
    const tableTop = insertedRowFocus && !this.rowWindow ? this.domRefs?.shell.getBoundingClientRect().top : undefined;
    const sourcePlan = this.buildInsertSourceRowTransaction(dom, insertAt, matrix.headerCells.length, focusTarget, tableTop);
    if (sourcePlan) return sourcePlan;
    matrix.rows.splice(insertAt, 0, new Array(matrix.headerCells.length).fill(''));
    const sourceRowOrder = matrix.rows.map((_row, index) => (
      index < insertAt ? index : index === insertAt ? -1 : index - 1
    ));
    return this.buildMatrixTransaction(
      matrix,
      dom,
      focusTarget,
      { sourceRowOrder, focusTableTop: tableTop }
    );
  }

  focusTargetAfterRowInsertion(insertAt: number, fallbackColumn: number): PendingCellFocus {
    const active = document.activeElement;
    const activeCoords = active instanceof HTMLTextAreaElement && this.domRefs?.shell.contains(active)
      ? this.parseCellCoords(active.dataset.tableRow, active.dataset.tableCol)
      : null;
    const row = activeCoords?.row ?? this.activeTarget.row;
    return {
      row: row > 0 && row - 1 >= insertAt ? row + 1 : row,
      col: activeCoords?.col ?? fallbackColumn,
      caret: active instanceof HTMLTextAreaElement && activeCoords
        ? active.selectionStart ?? 0
        : 0
    };
  }

  buildAddRowBefore(dom: HTMLElement, rowIndex: number, focusColumn: number): TableCommandTransactionPlan {
    const matrix = this.readCellMatrix();
    if (!matrix.headerCells.length) return { transaction: null, outcome: 'no-op' };
    const insertAt = Math.min(Math.max(rowIndex, 0), matrix.rows.length);
    const focusTarget = this.focusTargetAfterRowInsertion(insertAt, focusColumn);
    const sourcePlan = this.buildInsertSourceRowTransaction(dom, insertAt, matrix.headerCells.length, focusTarget);
    if (sourcePlan) return sourcePlan;
    matrix.rows.splice(insertAt, 0, new Array(matrix.headerCells.length).fill(''));
    const sourceRowOrder = matrix.rows.map((_row, index) => (
      index < insertAt ? index : index === insertAt ? -1 : index - 1
    ));
    return this.buildMatrixTransaction(
      matrix,
      dom,
      focusTarget,
      { sourceRowOrder }
    );
  }

  buildMoveRows(
    dom: HTMLElement,
    rowIndexes: number[],
    direction: 'up' | 'down',
    focusColumn: number,
    focusTableRow: number
  ): TableCommandTransactionPlan {
    const indexes = [...new Set(rowIndexes)].sort((left, right) => left - right);
    if (!indexes.length) return { transaction: null, outcome: 'no-op' };
    const first = indexes[0];
    const last = indexes[indexes.length - 1];
    if (indexes.some((index, offset) => index !== first + offset)) {
      return { transaction: null, outcome: 'no-op' };
    }
    if (direction === 'up' ? first <= 0 : last >= this.tableData.rows.length - 1) {
      return { transaction: null, outcome: 'no-op' };
    }
    const matrix = this.readCellMatrix();
    const sourceRowOrder = matrix.rows.map((_row, index) => index);
    if (direction === 'up') {
      sourceRowOrder.splice(first - 1, indexes.length + 1, ...indexes, first - 1);
    } else {
      sourceRowOrder.splice(first, indexes.length + 1, last + 1, ...indexes);
    }
    matrix.rows = sourceRowOrder.map((index) => matrix.rows[index]);
    return this.buildMatrixTransaction(
      matrix,
      dom,
      {
        row: Math.min(Math.max(focusTableRow + (direction === 'up' ? -1 : 1), 1), matrix.rows.length),
        col: focusColumn,
        caret: this.focusedCellCaret(focusTableRow, focusColumn)
      },
      { sourceRowOrder, preserveScrollPosition: true }
    );
  }

  private focusedCellCaret(row: number, col: number): number | undefined {
    const input = this.domRefs?.allRowInputs[row]?.[col];
    if (input && input === input.ownerDocument.activeElement) return tableCellSelectionHead(input);
    return undefined;
  }

  buildInsertSourceRowTransaction(
    dom: HTMLElement,
    insertAt: number,
    colCount: number,
    focusTarget: PendingCellFocus,
    tableTop?: number
  ): TableCommandTransactionPlan | null {
    const view = this.getEditorView(dom);
    if (!view || colCount <= 0) return null;
    const range = this.resolveCurrentTableRange(view, dom);
    if (!range) return null;

    const tableStartLine = this.resolveCurrentTableStartLine(view, 0, range);
    if (tableStartLine === null) return null;
    const blankRow = `${this.tableData.indent}| ${new Array(colCount).fill('').join(' | ')} |`;
    const changes = this.collectPendingCellSourceChanges(view);
    const provenance = getTableTransactionProvenance(view.state);
    let insertedRowAnchor: number;
    let insertedRowOffset = 0;
    if (insertAt < this.tableData.rows.length) {
      const line = view.state.doc.line(tableStartLine + 2 + insertAt);
      changes.push({ from: line.from, to: line.from, insert: `${blankRow}\n` });
      insertedRowAnchor = line.from;
    } else {
      const previousLine = view.state.doc.line(tableStartLine + 1 + this.tableData.rows.length);
      changes.push({ from: previousLine.to, to: previousLine.to, insert: `\n${blankRow}` });
      insertedRowAnchor = previousLine.to;
      insertedRowOffset = 1;
    }
    changes.sort((left, right) => left.from - right.from || left.to - right.to);
    const insertedRowEffect = provenance.effect({
      type: 'insertedRow',
      at: view.state.changes(changes).mapPos(insertedRowAnchor, -1),
      assoc: -1,
      offset: insertedRowOffset
    });
    return {
      transaction: { changes, effects: insertedRowEffect },
      outcome: 'changed',
      historyFocusAfter: focusTarget,
      restoreInteraction: () => this.scheduleFocusCellAfterCommit(
        view,
        tableStartLine,
        focusTarget,
        null,
        this.domRefs?.shell ?? null,
        { tableTop }
      )
    };
  }

  buildRemoveRowsAt(dom: HTMLElement, rowIndexes: number[], focusColumn: number): TableCommandTransactionPlan {
    const uniqueIndexes = [...new Set(rowIndexes)].sort((left, right) => right - left);
    if (!uniqueIndexes.length) return { transaction: null, outcome: 'no-op' };
    const matrix = this.readCellMatrix();
    const validIndexes = uniqueIndexes.filter((index) => index >= 0 && index < matrix.rows.length);
    if (!validIndexes.length || validIndexes.length >= matrix.rows.length) {
      return { transaction: null, outcome: 'no-op' };
    }
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
    // Presentation can retain the previous comparison while its replacement is
    // computing. Its row identities must never become provenance for a new
    // baseline. With no accepted mapping, the actual diff resolves the deletion.
    const comparison = view.state.facet(gitDiffLineFlagsFacet);
    const currentLines = comparison?.baselineCurrent && comparison.doc === view.state.doc ? comparison.lines : null;
    const projectedBaselineCurrent = comparison?.baselineCurrent !== false
      && (!comparison || this.tableData.diffBaseline === comparison.baseline);
    const sortedIndexes = [...rowIndexes].sort((left, right) => left - right);
    const removedIndexes = new Set(sortedIndexes);
    const groups: Array<{ from: number; to: number }> = [];
    for (const index of sortedIndexes) {
      const previous = groups[groups.length - 1];
      if (previous && index === previous.to + 1) previous.to = index;
      else groups.push({ from: index, to: index });
    }

    const deletionIntents: Array<Extract<
      CodeMirrorTableProvenanceIntent,
      { readonly type: 'deletedRows' }
    >> = groups.flatMap((group) => {
      const baselineLines = sortedIndexes
        .filter((index) => index >= group.from && index <= group.to)
        .map((index) => currentLines
          ? currentLines[tableStartLine + 1 + index]?.baselineLineNumber
          : projectedBaselineCurrent ? this.tableData.diffFlagsByLine?.[tableStartLine + 2 + index]?.baselineLineNumber : undefined)
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
      return [{
        type: 'deletedRows',
        at: anchor,
        assoc: deletionAtEnd ? -1 : 1,
        baselineRanges,
        deletionAtEnd
      }];
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
    const ownChanges = view.state.changes(changes);
    const provenance = getTableTransactionProvenance(view.state);
    const deletionEffects = deletionIntents.map((intent) => provenance.effect({
      ...intent,
      at: ownChanges.mapPos(intent.at, intent.assoc)
    }));
    return {
      transaction: { changes, effects: deletionEffects },
      outcome: 'changed',
      historyFocusAfter: focusTarget,
      restoreInteraction: () => this.scheduleFocusCellAfterCommit(
        view,
        tableStartLine,
        focusTarget,
        null,
        this.domRefs?.shell ?? null
      )
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
    return this.buildMatrixTransaction(matrix, dom, this.focusTargetAfterColumnInsertion(insertAt, focusRow));
  }

  focusTargetAfterColumnInsertion(insertAt: number, fallbackRow: number): PendingCellFocus {
    const active = document.activeElement;
    const activeCoords = active instanceof HTMLTextAreaElement && this.domRefs?.shell.contains(active)
      ? this.parseCellCoords(active.dataset.tableRow, active.dataset.tableCol)
      : null;
    const col = activeCoords?.col ?? this.activeTarget.col;
    return {
      row: activeCoords?.row ?? fallbackRow,
      col: col >= insertAt ? col + 1 : col,
      caret: active instanceof HTMLTextAreaElement && activeCoords
        ? active.selectionStart ?? 0
        : 0
    };
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
    return this.buildMatrixTransaction(matrix, dom, this.focusTargetAfterColumnInsertion(insertAt, focusRow));
  }

  buildMoveColumns(
    dom: HTMLElement,
    columnIndexes: number[],
    direction: 'left' | 'right',
    focusRow: number,
    focusColumn: number
  ): TableCommandTransactionPlan {
    const indexes = [...new Set(columnIndexes)].sort((left, right) => left - right);
    if (!indexes.length) return { transaction: null, outcome: 'no-op' };
    const first = indexes[0];
    const last = indexes[indexes.length - 1];
    if (indexes.some((index, offset) => index !== first + offset)) {
      return { transaction: null, outcome: 'no-op' };
    }
    if (direction === 'left' ? first <= 0 : last >= this.tableData.colCount - 1) {
      return { transaction: null, outcome: 'no-op' };
    }
    const matrix = this.readCellMatrix();
    const sourceTable = this.domRefs?.table ?? null;
    const commandRoot = this.view?.dom ?? null;
    const columnPermutation = matrix.headerCells.map((_cell, index) => index);
    if (direction === 'left') {
      columnPermutation.splice(first - 1, indexes.length + 1, ...indexes, first - 1);
    } else {
      columnPermutation.splice(first, indexes.length + 1, last + 1, ...indexes);
    }
    matrix.headerCells = columnPermutation.map((index) => matrix.headerCells[index]);
    matrix.rows = matrix.rows.map((row) => columnPermutation.map((index) => row[index] ?? ''));
    const alignments = normalizeRow(this.tableData.alignments, columnPermutation.length, '').map((value) => value ?? null);
    matrix.alignments = columnPermutation.map((index) => alignments[index] ?? null);
    const plan = this.buildMatrixTransaction(matrix, dom, {
      row: focusRow,
      col: Math.min(Math.max(focusColumn + (direction === 'left' ? -1 : 1), 0), matrix.headerCells.length - 1),
      caret: this.focusedCellCaret(focusRow, focusColumn)
    });
    if (!plan.transaction || !sourceTable || !commandRoot) return plan;
    return {
      ...plan,
      afterDispatch: () => commandRoot.dispatchEvent(new CustomEvent('meo-table-column-permutation', {
        detail: { table: sourceTable, permutation: columnPermutation }
      }))
    };
  }

  buildRemoveColumnsAt(dom: HTMLElement, columnIndexes: number[], focusRow: number): TableCommandTransactionPlan {
    const uniqueIndexes = [...new Set(columnIndexes)].sort((left, right) => right - left);
    if (!uniqueIndexes.length) return { transaction: null, outcome: 'no-op' };
    const matrix = this.readCellMatrix();
    const validIndexes = uniqueIndexes.filter((index) => index >= 0 && index < matrix.headerCells.length);
    if (!validIndexes.length || validIndexes.length >= matrix.headerCells.length) {
      return { transaction: null, outcome: 'no-op' };
    }
    const firstRemoved = Math.min(...validIndexes);
    for (const index of validIndexes) matrix.headerCells.splice(index, 1);
    matrix.rows = matrix.rows.map((row) => {
      const next = row.slice();
      for (const index of validIndexes) next.splice(index, 1);
      return next;
    });
    const alignments = normalizeRow(this.tableData.alignments, matrix.headerCells.length + validIndexes.length, '').map((value) => value ?? null);
    for (const index of validIndexes) alignments.splice(index, 1);
    matrix.alignments = alignments;
    const focusCol = Math.min(firstRemoved, matrix.headerCells.length - 1);
    return this.buildMatrixTransaction(matrix, dom, { row: focusRow, col: focusCol });
  }

  cellDiagnostics(rowIndex: number, colIndex: number): TableCellDiagnostics[] {
    return this.tableData.diagnostics?.[rowIndex]?.[colIndex] ?? [];
  }

  wireInput(input: HTMLTextAreaElement, rowEl: HTMLTableRowElement, rowInputs: HTMLTextAreaElement[], container: HTMLElement, rowIndex: number, colIndex: number) {
    wireNativeSymbolInput(input, {
      originEpoch: () => this.view ? symbolOriginEpoch(this.view.state) : -1,
      preferences: () => this.view?.state.facet(inputAssistanceFacet) ?? defaultInputAssistance,
      readOrigins: () => {
        const view = this.view, range = this.cellSourceRange(rowIndex, colIndex);
        if (!view || !range) return [];
        return automaticSymbolPairs(view.state, range.from, range.to).map(pair => ({ ...pair,
          from: tableCellSourceOffsetToEditorOffset(input.value, pair.from - range.from),
          to: tableCellSourceOffsetToEditorOffset(input.value, pair.to - range.from) }));
      }
    });
    let compositionEndedAt = Number.NEGATIVE_INFINITY;
    let scrollTopBeforeInput: number | null = null;
    let revealCaretAfterInput = false;
    let breakSuffixBeforeInput: string | null = null;
    const refreshPreview = () => {
      if (this.destroyed || !this.view) return;
      this.refreshCellPreviewFromInput(input);
    };
    const notifySelectionChange = (event?: Event) => {
      if (input.ownerDocument.activeElement === input) {
        this.updateCellLinePresentation(input);
        if (event instanceof KeyboardEvent && !event.isComposing && this.composingInput !== input
            && tableCellCaretNavigationKeys.has(event.key)) {
          this.revealTableCellCaretIfNeeded(input);
        }
      }
      this.emitTableSelectionChange(container);
    };
    const captureInputViewportIntent = () => {
      const view = this.view;
      if (!view || input.ownerDocument.activeElement !== input) {
        scrollTopBeforeInput = null;
        revealCaretAfterInput = false;
        return;
      }
      const caret = tableCellCaretViewportBounds(input);
      const viewport = tableUsableViewportBounds(view, input);
      const caretIsVisible = (
        caret.top >= viewport.top - tableCellCaretRevealEpsilon &&
        caret.bottom <= viewport.bottom + tableCellCaretRevealEpsilon
      );
      scrollTopBeforeInput = caretIsVisible ? view.scrollDOM.scrollTop : null;
      revealCaretAfterInput = !caretIsVisible;
    };
    const captureBeforeInput = (isComposing: boolean, editEnd = input.selectionEnd) => {
      captureInputViewportIntent();
      const { value } = input;
      const newline = value.indexOf('\n', editEnd);
      breakSuffixBeforeInput =
        !isComposing && this.composingInput !== input
        && tableCellEditorBreakStart(value, newline, editEnd) !== null
          ? value.slice(newline)
          : null;
    };
    input.addEventListener('beforeinput', event => captureBeforeInput(event.isComposing), { capture: true });
    input.addEventListener('cut', event => {
      if (this.composingInput === input || !writeTableCellTextSelection(event, input)) return;
      captureBeforeInput(false);
      replaceTableCellEditorSelection(input, '');
    });
    input.addEventListener('input', () => {
      this.cellVerticalGoal = null;
      this.cellWrapStart = null;
      const preservedScrollTop = scrollTopBeforeInput;
      const shouldRevealCaret = revealCaretAfterInput;
      const breakSuffix = breakSuffixBeforeInput;
      scrollTopBeforeInput = null;
      revealCaretAfterInput = false;
      breakSuffixBeforeInput = null;
      normalizeTableCellEditorInput(input, breakSuffix);
      // Preedit belongs to the native textarea until the IME confirms it.
      // Save-triggered commits must not consume an unfinished candidate.
      if (this.composingInput !== input) {
        const autoCommitGeneration = this.recordPendingCellEdit(rowIndex, colIndex, input.value);
        this.schedulePendingCellAutoCommit(input, rowIndex, colIndex, autoCommitGeneration);
      }
      const hadSearchMatch = input.parentElement?.classList.contains('has-search-match') ?? false;
      const sourceValue = tableCellEditorValueToSource(input.value);
      if (this.searchState && (hadSearchMatch || shouldExpandTableCellForSearch(sourceValue, this.searchState))) {
        refreshPreview();
      }
      this.updateCellLinePresentation(input);
      // Resize the focused row in the input event's task. Deferring this mutation to
      // CodeMirror's next measure lets the textarea scroll its caret for one paint,
      // then snap back after the row catches up.
      const resizeAndSchedule = () => {
        // Non-search previews stay untouched while editing so inline image DOM is not recreated.
        this.resizeRow(rowEl, rowInputs);
        if (rowIndex === 0) this.stickyHeaderAdapter.update();
        this.scheduleLayout();
      };
      resizeAndSchedule();
      const view = this.view;
      const caretAfterResize = view ? tableCellCaretViewportBounds(input) : null;
      const viewportAfterResize = view ? tableUsableViewportBounds(view, input) : null;
      const caretNeedsReveal = shouldRevealCaret || Boolean(
        caretAfterResize && viewportAfterResize && (
          caretAfterResize.top < viewportAfterResize.top - tableCellCaretRevealEpsilon ||
          caretAfterResize.bottom > viewportAfterResize.bottom + tableCellCaretRevealEpsilon
        )
      );
      // A character can create a new visual line even when the caret was visible
      // before input. Recheck after the synchronous row growth so that the new
      // line is revealed before paint instead of locking the now-stale viewport.
      if (caretNeedsReveal) {
        this.revealTableCellCaretIfNeeded(input);
      } else if (preservedScrollTop !== null && input.ownerDocument.activeElement === input) {
        const controller = view ? getViewportController(view) : null;
        if (controller) controller.lockScrollTop(preservedScrollTop);
        else if (view) view.scrollDOM.scrollTop = preservedScrollTop;
      }
      notifySelectionChange();
    });
    input.addEventListener('select', notifySelectionChange);
    input.addEventListener('selectionchange', notifySelectionChange);
    input.addEventListener('keyup', notifySelectionChange);
    input.addEventListener('pointerup', notifySelectionChange);
    input.addEventListener('scroll', () => {
      const presentation = this.linePresentation;
      if (presentation?.input === input && this.composingInput !== input && input.scrollTop !== presentation.scrollTop) {
        input.scrollTop = presentation.scrollTop;
      }
    });
    input.addEventListener('compositionstart', () => {
      this.composingInput = input;
      input.parentElement?.classList.add('is-cell-composing');
      this.cancelPendingCellAutoCommit();
    });
    input.addEventListener('compositionend', () => {
      this.composingInput = null;
      input.parentElement?.classList.remove('is-cell-composing');
      compositionEndedAt = performance.now();
      this.updateCellLinePresentation(input);
      this.schedulePendingCellAutoCommit(
        input,
        rowIndex,
        colIndex,
        this.recordPendingCellEdit(rowIndex, colIndex, input.value)
      );
    });
    input.addEventListener('keydown', (event) => {
      const followsCompositionEnd = performance.now() - compositionEndedAt < 100;
      if (this.composingInput === input || event.isComposing || event.keyCode === 229 || (
        followsCompositionEnd && (event.key === 'Enter' || event.key === ' ')
      )) return;
      const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
      const projectedNavigation = !event.altKey && !event.ctrlKey && !event.metaKey;
      if (!vertical || !projectedNavigation) this.cellVerticalGoal = null;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight' || !projectedNavigation) this.cellWrapStart = null;
      const painted = projectedNavigation && (vertical || event.key === 'Home' || event.key === 'End')
        ? this.moveProjectedCellCaret(input, event.key, event.shiftKey) : null;
      if (painted === 'handled') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      const keyboard = this.cellInteraction.accept({
        type: 'keyboard',
        input: {
          key: event.key,
          shiftKey: event.shiftKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
          appendOnLastTab: webviewShortcutPlatform === 'windows',
          useCtrlEnterForCellBreak: webviewShortcutPlatform !== 'windows',
          row: rowIndex,
          col: colIndex,
          rowCount: this.tableData.rows.length + 1,
          colCount: this.tableData.colCount,
          selectionStart: input.selectionStart ?? 0,
          selectionEnd: input.selectionEnd ?? input.selectionStart ?? 0,
          value: input.value,
          visualLine: vertical && projectedNavigation && !event.shiftKey && input.selectionStart === input.selectionEnd
            ? painted ?? tableCellVisualLineBoundary(input)
            : undefined,
          composing: event.isComposing || event.keyCode === 229
        }
      }).keyboard;
      if (keyboard?.type === 'consume') {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      if (keyboard?.type === 'append-row') {
        event.preventDefault();
        event.stopPropagation();
        void this.requestTableCommand('insert-row-below', true, {
          tableId: this.tableCommandTargetId, row: rowIndex, column: colIndex, selection: null, insertedRowFocus: 'first-cell'
        });
        return;
      }
      if (keyboard?.type === 'insert-line-break') {
        event.preventDefault();
        event.stopPropagation();
        // This keyboard path mutates the textarea with setRangeText and emits a
        // synthetic input event, so the browser does not provide beforeinput.
        // Capture the same viewport intent as native typing before row growth.
        insertTableCellEditorBreak(input, this.view?.state, captureInputViewportIntent);
        return;
      }
      if (keyboard?.type === 'commit-and-exit') {
        event.preventDefault();
        event.stopPropagation();
        this.cancelPendingCellAutoCommit();
        const view = this.view;
        if (view) commitPendingTableEdits(view);
        input.blur();
        this.exitTableInteraction(container);
        return;
      }
      if (keyboard?.type === 'focus-cell') {
        event.preventDefault();
        event.stopPropagation();
        const target = this.cellInput(keyboard.target.row, keyboard.target.col);
        if (target) this.focusTableInput(target, Math.min(keyboard.caretColumn, target.value.length));
        return;
      }
      if (keyboard?.type === 'move-out-of-table') {
        event.preventDefault();
        event.stopPropagation();
        this.moveVerticalOutOfTable(
          container,
          keyboard.direction,
          keyboard.column,
          keyboard.createLineIfMissing === true
        );
        return;
      }
      if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === ']' || event.key === '[')) {
        if (adjustTableCellListIndent(input, event.key === ']' ? 'indent' : 'outdent')) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (
        (event.key === 'Backspace' || event.key === 'Delete')
        && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
        && input.selectionStart === input.selectionEnd
      ) {
        const { value, selectionStart: caret } = input;
        const deletion = tableCellBreakDeletionRange(value, caret, event.key === 'Backspace', this.linePresentation?.input === input);
        if (deletion) {
          event.preventDefault();
          event.stopPropagation();
          if (deletion.from < deletion.to) {
            captureBeforeInput(false, deletion.to);
            input.setRangeText('', deletion.from, deletion.to, 'preserve');
            input.dispatchEvent(new Event('input', { bubbles: true }));
          }
          return;
        }
        const state = this.view?.state;
        if (event.key === 'Backspace' && state && editTableCellMarkup(input, state, 'backspace', captureInputViewportIntent)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
    });
    input.addEventListener('focus', () => {
      const { selectionStart, selectionEnd, selectionDirection } = input;
      const view = this.view;
      const wrap = this.domRefs?.wrap;
      if (view && wrap) this.resolveCurrentTableRange(view, wrap);
      this.setCellEditingState(input, true);
      const pending = this.cellInteraction.snapshot().pending;
      const lastPendingEdit = pending[pending.length - 1];
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
          const tableStartLine = this.resolveCurrentTableStartLine(
            view,
            focusTarget.row,
            this.resolveCurrentTableRange(view, wrap)
          );
          if (tableStartLine === null) return;
          const caret = activeInput.selectionStart ?? 0;
          if (commitPendingTableEdits(view)) {
            this.scheduleFocusCellAfterCommit(view, tableStartLine, { ...focusTarget, caret });
          }
        });
      }
      this.setTableInteractionActive(container, true);
      this.setSingleCellSelection({ row: rowIndex, col: colIndex }, 'focus');
      // Clearing the former document selection also resets Chromium's native
      // textarea range. A focus return must retain the cell's caret/selection.
      input.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
      notifySelectionChange();
    });
    input.addEventListener('blur', (event) => {
      if (this.destroyed || !this.view) return;
      refreshPreview();
      this.cellInteraction.accept({ type: 'blur', target: { row: rowIndex, col: colIndex } });
      notifySelectionChange();
      const nextTarget = event.relatedTarget;
      if (nextTarget instanceof Element && nextTarget.closest('.meo-hex-color-adjustment')) return;
      const nextTableShell = nextTarget instanceof Element
        ? nextTarget.closest('.meo-md-html-table-shell')
        : null;
      if (nextTableShell) {
        if (nextTableShell !== this.domRefs?.shell) {
          this.transferTableInteraction(container);
        }
        return;
      }
      this.setTableInteractionActive(container, false);
    });
  }

  resizeRow(row: HTMLTableRowElement, rowInputs: HTMLTextAreaElement[] | null = null) {
    if (!row) return;
    this.resizeRows([{ row, inputs: rowInputs ?? Array.from(row.querySelectorAll('textarea')) }]);
  }

  resizeRows(entries: readonly RowEntry[]) {
    const projection = this.linePresentation;
    const projectedRow = projection?.input.closest('tr');
    if (projection && entries.some(({ row }) => row === projectedRow)) {
      this.layoutCellSourceLine(projection);
    }
    this.refreshEditingHeightBaselines(entries);
    // Only the current display layer sizes each cell. Active source editors
    // retain their entry baseline without reserving space for hidden URLs.
    if (typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content')) {
      const rows = entries.map(({ row }) => Array.from(
        row.querySelectorAll<HTMLElement>('.meo-md-html-table-cell-content')
      ));
      for (const contents of rows) {
        for (const content of contents) content.style.removeProperty('min-height');
      }
      // Retain full-row editing targets, but discard the previous minimum before
      // reading natural CSS heights so input deletion and wider columns shrink.
      const heights = rows.map(contents => Math.max(0, ...contents.map(content =>
        Number.parseFloat(getComputedStyle(content).height) || 0
      )));
      rows.forEach((contents, index) => {
        for (const content of contents) content.style.minHeight = `${heights[index]}px`;
      });
      return;
    }
    const rows = entries.map(({ row, inputs }) => {
      const contents = Array.from(row.querySelectorAll<HTMLElement>('.meo-md-html-table-cell-content'));
      const editingInputs = inputs.filter(input => input.parentElement?.classList.contains('is-editing')
        && !input.parentElement.classList.contains('is-editing-line'));
      return {
        contents,
        inputs: editingInputs,
        widths: editingInputs.map((input) => input.getBoundingClientRect().width),
        // Editing keeps the previous preview DOM alive, but its stale height
        // must not keep a row from shrinking as the user deletes text.
        previewHeight: Math.max(0, ...contents.map(content => {
          const minimum = Number.parseFloat(content.style.getPropertyValue(tableCellEditMinHeight)) || 0;
          const preview = content.matches('.is-editing:not(.is-editing-line, .has-search-match)')
            ? null : content.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
          return Math.max(minimum, preview?.scrollHeight ?? 0);
        }))
      };
    }).filter(({ contents }) => contents.length > 0);
    // A virtualized table can remount during a scroll. Attach all zero-height
    // probes before measuring so layout work is bounded per table, not per cell.
    const measurements = rows.map((row) => ({
      ...row,
      probes: row.inputs.map((input, index) => {
        const probe = input.cloneNode(false) as HTMLTextAreaElement;
        probe.value = input.value;
        probe.tabIndex = -1;
        probe.setAttribute('aria-hidden', 'true');
        Object.assign(probe.style, {
          inset: 'auto', top: '0', left: '0', height: '0px',
          width: `${row.widths[index]}px`, visibility: 'hidden', pointerEvents: 'none'
        });
        row.inputs[index]!.parentElement!.appendChild(probe);
        return probe;
      })
    }));
    const heights = measurements.map(({ probes, previewHeight }) =>
      Math.max(previewHeight, ...probes.map((probe) => probe.scrollHeight))
    );
    for (const [index, { probes, contents }] of measurements.entries()) {
      for (const probe of probes) probe.remove();
      for (const content of contents) content.style.minHeight = `${heights[index]}px`;
    }
  }

  private refreshEditingHeightBaselines(entries: readonly RowEntry[]) {
    const changed: { content: HTMLElement; width: number; height: string }[] = [];
    for (const { inputs } of entries) {
      for (const input of inputs) {
        const content = input.parentElement;
        if (!content?.classList.contains('is-editing')) continue;
        const previous = this.editingPreviews.get(content);
        const preview = previous?.readingPreview ?? content.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
        if (!preview) continue;
        // The cell wrapper fills the whole row and may still have the old
        // row's minimum after a reorder. Use the retained preview's own size.
        const { width, height } = getComputedStyle(preview);
        const previewWidth = Number.parseFloat(width);
        if (previewWidth > 0 && previous?.width !== previewWidth) {
          changed.push({ content, width: previewWidth, height });
        }
      }
    }
    for (const { content, width, height } of changed) {
      this.editingPreviews.set(content, { ...this.editingPreviews.get(content), width });
      content.style.setProperty(tableCellEditMinHeight, height);
    }
  }

  private retainCellReadingPreview(content: HTMLElement, preview: HTMLElement) {
    const editing = this.editingPreviews.get(content);
    if (!editing || editing.readingPreview) return;
    // The mixed preview replaces one rendered line, so keep its reading
    // geometry available for column reflow throughout the edit.
    const readingPreview = preview.cloneNode(true) as HTMLElement;
    readingPreview.className = 'meo-md-html-table-cell-reading-preview';
    readingPreview.inert = true;
    readingPreview.setAttribute('aria-hidden', 'true');
    content.appendChild(readingPreview);
    editing.readingPreview = readingPreview;
  }

  private releaseCellReadingPreview(content: HTMLElement) {
    this.editingPreviews.get(content)?.readingPreview?.remove();
    this.editingPreviews.delete(content);
    content.style.removeProperty(tableCellEditMinHeight);
  }

  resizeAllRows() {
    if (!this.domRefs) return;
    const { table, rowEntries } = this.domRefs;
    const resize = () => this.resizeRows(rowEntries);
    if (preserveTableColumnResizeLayout(table, resize)) return;
    const active = table.ownerDocument.activeElement;
    const controller = this.view ? getViewportController(this.view) : null;
    if (
      active instanceof HTMLTextAreaElement && table.contains(active) && controller &&
      !this.domRefs.shell.classList.contains('is-context-menu-open')
    ) {
      // Intrinsic sizing can shrink rows before CodeMirror's next measurement.
      // Keep the row's reference through that measurement. The textarea can
      // move within the row when its source wraps.
      const reference = nativeInputViewportReference(active);
      controller.retainElementTopWhileMutation(
        reference,
        () => table.ownerDocument.activeElement === active ? nativeInputViewportReference(active) : null,
        resize,
        () => table.ownerDocument.activeElement === active && !controller.isUserScrolling()
      );
    } else {
      resize();
    }
  }

  tableRowsForGutter() {
    const entries = this.domRefs?.rowEntries ?? [];
    const entry = ({ row }: RowEntry, index: number) => ({ row, rowIndex: this.rowWindow
      ? row.dataset.tableBodyRow === undefined ? 0 : Number(row.dataset.tableBodyRow) + 1 : index });
    if (entries.length < 256 || !this.view) return entries.map(entry);
    // Table rows stay in source order even when a cell wraps. Locate a reading
    // band by geometry without measuring every offscreen row on focus/scroll.
    const viewport = this.view.scrollDOM.getBoundingClientRect();
    const top = viewport.top - viewport.height, bottom = viewport.bottom + viewport.height;
    let low = 0, high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle]!.row.getBoundingClientRect().bottom < top) low = middle + 1;
      else high = middle;
    }
    const first = low;
    high = entries.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (entries[middle]!.row.getBoundingClientRect().top <= bottom) low = middle + 1;
      else high = middle;
    }
    return entries.slice(first, low).map((row, index) => entry(row, first + index));
  }

  recalcLayout() {
    const recalc = () => this.recalcTableLayout();
    if (!this.domRefs || !preserveTableColumnResizeLayout(this.domRefs.table, recalc)) recalc();
  }

  recalcTableLayout() {
    if (this.pendingResizeRows && this.rowWindow && this.domRefs) {
      // The row window sizes the body. The mounted header reflows separately.
      this.resizeRows(this.domRefs.rowEntries.slice(0, 1));
      this.rowWindow.invalidate();
    }
    this.rowWindow?.update();
    if (this.pendingResizeRows) {
      if (!this.rowWindow) this.resizeAllRows();
      this.domRefs?.shell.style.removeProperty('min-height');
      this.view?.plugin(tableLineNumbers)?.request();
    }
    this.syncTableDiffMarkers();
    for (const task of Array.from(this.layoutTasks)) task();
    this.updateContextControlsPosition();
  }

  syncTableDiffMarkers() {
    if (this.destroyed || !this.domRefs?.shell.isConnected) return;
    const { diffMarkerLayer } = this.domRefs;
    const gutter = this.view?.dom.querySelector('.meo-git-gutter');
    if (!(gutter instanceof HTMLElement)) return;
    if (diffMarkerLayer.parentElement !== gutter) gutter.appendChild(diffMarkerLayer);

    const gutterRect = gutter.getBoundingClientRect();
    const rows = this.tableRowsForGutter()
      .flatMap(({ row }) => {
        const lineNumber = Number.parseInt(row.dataset.sourceLineNumber ?? '', 10);
        const flags = this.tableData.diffFlagsByLine?.[lineNumber];
        if (!flags || (!flags.added && !flags.modified && !flags.deleted)) return [];
        const rect = row.getBoundingClientRect();
        return [{ lineNumber, flags, top: rect.top - gutterRect.top, height: rect.height }];
      });
    diffMarkerLayer.style.left = '0';
    diffMarkerLayer.style.width = `${gutterRect.width}px`;
    let itemIndex = 0;
    for (const { lineNumber, flags, top, height } of rows) {
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
      item.style.top = `${top}px`;
      item.style.height = `${height}px`;
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
      // The editor may already have measured in this frame. Publish row
      // positions after the column/font relayout before its first paint.
      if (this.pendingResizeRows) this.view?.plugin(tableLineNumbers)?.request({ beforePaint: true });
      this.pendingResizeRows = false;
    });
    this.view?.plugin(tableLineNumbers)?.request();
  }

  flushPendingLayout(): boolean {
    if (!this.layoutFrame || !this.domRefs?.shell.isConnected) return false;
    cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = 0;
    this.recalcLayout();
    this.pendingResizeRows = false;
    return true;
  }

  renderCellPreview(
    preview: HTMLElement,
    value: string,
    diagnostics: TableCellDiagnostics[] = [],
    sourceRange: TableCellRange | null = null,
    sourceLine: TableCellLogicalLine | null = null
  ) {
    if (!(preview instanceof HTMLElement)) return;
    renderTableCellInlinePreview(
      preview,
      value ?? '',
      diagnostics,
      this.searchState,
      sourceRange,
      getImagePresentationFactory(this.view!.state),
      this.view!.state.facet(uiLanguageFacet),
      this.view!,
      sourceLine
    );
    // A focusable color button cannot live inside an aria-hidden preview.
    if (preview.querySelector('.meo-md-color-swatch-interactive, .meo-md-footnote-ref')) preview.removeAttribute('aria-hidden');
    else if (preview.getAttribute('aria-hidden') !== 'true') preview.setAttribute('aria-hidden', 'true');
  }

  private clearCellLinePresentation(input: HTMLTextAreaElement) {
    const presentation = this.linePresentation;
    if (presentation?.input !== input) return;
    this.linePresentation = null;
    this.clearCellLineHighlight(presentation);
    presentation.caret?.element.remove();
    input.parentElement?.classList.remove('is-editing-line');
    input.scrollTop = 0;
  }

  private clearCellLineHighlight(presentation: TableCellLinePresentation) {
    if (presentation.highlight) this.textSelectionPaint.clear();
    if (CSS.highlights?.get('meo-table-cell-selection') === presentation.highlight) {
      CSS.highlights.delete('meo-table-cell-selection');
    }
    presentation.highlight = null;
  }

  private layoutCellSourceLine(presentation: TableCellLinePresentation) {
    const { input, sourceElement, textElement, prefixElement, valueFrom } = presentation;
    const content = input.parentElement;
    const preview = sourceElement.closest<HTMLElement>('.meo-md-html-table-cell-preview');
    if (!content || !preview || !sourceElement.isConnected) return;
    const prefixVisible = sourceElement.classList.contains('is-prefix-source');
    const previewRect = preview.getBoundingClientRect();
    const innerLeft = previewRect.left + (parseFloat(getComputedStyle(preview).paddingLeft) || 0);
    const bodyLeft = sourceElement.getBoundingClientRect().left;
    // Editing a structural prefix starts at the cell's padding. As it grows,
    // text wraps to the right from that stable origin.
    sourceElement.style.setProperty('--meo-cell-source-shift',
      `${prefixVisible ? Math.max(0, bodyLeft - innerLeft) : 0}px`);
    const contentRect = content.getBoundingClientRect();
    const sourceRect = textElement.getBoundingClientRect();
    if (!sourceRect.width) return;
    const hiddenPrefixWidth = prefixVisible ? 0 : prefixElement?.getBoundingClientRect().width ?? 0;
    const nativeLeft = Math.max(innerLeft, sourceRect.left - hiddenPrefixWidth);
    const nativeWidth = sourceRect.right - nativeLeft;
    const nativeInset = sourceRect.left - nativeLeft;
    input.style.setProperty('--meo-cell-source-top', `${sourceRect.top - contentRect.top}px`);
    input.style.setProperty('--meo-cell-source-left', `${nativeLeft - contentRect.left}px`);
    input.style.setProperty('--meo-cell-source-height', `${sourceRect.height}px`);
    const style = getComputedStyle(textElement);
    const measurementKey = [nativeWidth, nativeInset, style.fontSize, style.fontFamily, style.fontWeight,
      style.fontStyle, style.lineHeight, style.letterSpacing, style.textAlign, style.tabSize].join(':');
    if (presentation.measurementKey !== measurementKey) {
      presentation.measurementKey = measurementKey;
      input.style.setProperty('--meo-cell-source-width', `${nativeWidth}px`);
      input.style.setProperty('--meo-cell-source-prefix-width', `${nativeInset}px`);
      input.style.setProperty('--meo-cell-source-align', style.textAlign);
      presentation.scrollTop = withTableCellVisualLineProbe(input, ({ lineTopAt }) => lineTopAt(valueFrom));
    }
    if (this.composingInput !== input && input.scrollTop !== presentation.scrollTop) {
      input.scrollTop = presentation.scrollTop;
    }
    if (presentation.highlight) this.textSelectionPaint.paint(content, presentation.highlight);
    this.paintCellSourceCaret(presentation, sourceRect.right);
  }

  private paintCellSourceCaret(presentation: TableCellLinePresentation, right: number) {
    const { input, sourceElement } = presentation;
    const position = input.selectionStart;
    const wrapStart = this.cellWrapStart?.input === input && this.cellWrapStart.position === position;
    const rect = position === input.selectionEnd ? this.projectedCaretRect(input, position, wrapStart) : null;
    if (!rect) {
      presentation.caret?.element.remove();
      presentation.caret = null;
      return;
    }
    let caret = presentation.caret;
    // Moving to a new insertion point starts a new blink. A layout pass at
    // the same insertion point only moves the existing caret's box.
    if (!caret || caret.position !== position || caret.wrapStart !== wrapStart) {
      const element = document.createElement('span');
      element.className = 'meo-md-table-source-caret';
      element.setAttribute('aria-hidden', 'true');
      caret?.element.remove();
      sourceElement.appendChild(element);
      presentation.caret = caret = { position, wrapStart, element };
    }
    const bounds = sourceElement.getBoundingClientRect();
    caret.element.style.left = `${Math.min(rect.left, right - 1) - bounds.left}px`;
    caret.element.style.top = `${rect.top - bounds.top}px`;
    caret.element.style.height = `${rect.height}px`;
  }

  projectedCaretRect(input: HTMLTextAreaElement, position: number, wrapStart =
    this.cellWrapStart?.input === input && this.cellWrapStart.position === position): DOMRect | null {
    const presentation = this.linePresentation;
    if (presentation?.input !== input || presentation.editorValue !== input.value || this.composingInput === input) return null;
    const { sourceElement, textElement, prefixElement, bodyRuns, breakElement, line, valueFrom } = presentation;
    const offset = position - valueFrom;
    if (offset < 0 || offset > line.text.length + line.breakText.length) return null;
    const prefixHidden = !sourceElement.classList.contains('is-prefix-source');
    const prefixLength = prefixElement?.textContent?.length ?? 0;
    const markerEdge = prefixHidden && offset < prefixLength
      ? sourceElement.closest('.meo-md-html-table-cell-list, .meo-md-html-table-cell-quote')?.getBoundingClientRect().left
      : undefined;
    let text: Node | null | undefined, visibleOffset = 0;
    if (!prefixHidden && offset < prefixLength) {
      text = prefixElement?.firstChild;
      visibleOffset = offset;
    } else if (offset > line.text.length && breakElement) {
      text = breakElement.firstChild;
      visibleOffset = offset - line.text.length;
    } else if (bodyRuns.length) {
      const source = line.from + Math.min(offset, line.text.length);
      let low = 0, high = bodyRuns.length - 1;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (bodyRuns[mid]!.to < source || wrapStart && bodyRuns[mid]!.to === source) low = mid + 1;
        else high = mid;
      }
      const run = bodyRuns[low]!;
      if (run.node instanceof HTMLElement) {
        const rect = run.node.getBoundingClientRect();
        const height = parseFloat(getComputedStyle(textElement).lineHeight) || rect.height;
        return new DOMRect(source <= run.from ? rect.left : rect.right, rect.bottom - height, 0, height);
      }
      text = run.node;
      visibleOffset = Math.max(0, Math.min(run.node.length, Math.round(
        (source - run.from) * run.node.length / Math.max(1, run.to - run.from)
      )));
    }
    if (text instanceof Text) {
      const range = input.ownerDocument.createRange();
      range.setStart(text, visibleOffset);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      // A collapsed DOM range chooses the previous row at a soft wrap. The
      // next grapheme also supplies a caret position at the same source offset.
      if (wrapStart && visibleOffset < text.length) {
        range.setEnd(text, findClusterBreak(text.data, visibleOffset));
        const glyph = range.getClientRects()[0];
        if (glyph && glyph.top > rect.top + 1) {
          range.collapse(false);
          const after = range.getBoundingClientRect();
          const x = after.left > glyph.left + glyph.width / 2 ? glyph.left : glyph.right;
          return new DOMRect(x, glyph.top, 0, glyph.height);
        }
      }
      if (rect.height) return markerEdge === undefined ? rect : new DOMRect(markerEdge, rect.top, 0, rect.height);
    }
    const bounds = textElement.getBoundingClientRect();
    const style = getComputedStyle(textElement);
    if (!bounds.height) return null;
    const left = markerEdge ?? (style.textAlign === 'center' ? bounds.left + bounds.width / 2
      : style.textAlign === 'right' ? bounds.right : bounds.left);
    const height = parseFloat(style.lineHeight) || bounds.height;
    return new DOMRect(left, bounds.top, 0, height);
  }

  private projectedVisualRow(presentation: TableCellLinePresentation, position: number, wrapStart?: boolean) {
    const { input, sourceElement, prefixElement, line, valueFrom } = presentation;
    const first = valueFrom + (sourceElement.classList.contains('is-prefix-source') ? 0 : prefixElement?.textContent?.length ?? 0);
    // A break tag remains editable by moving horizontally into it. Vertical
    // movement and End use the content boundary, including when the tag wraps.
    const last = Math.max(position, valueFrom + line.text.length);
    const caret = this.projectedCaretRect(input, position, wrapStart);
    if (!caret) return null;
    const search = (from: number, to: number, boundary: 'start' | 'end') => {
      while (from < to) {
        const mid = boundary === 'start' ? Math.floor((from + to) / 2) : Math.ceil((from + to) / 2);
        const y = this.projectedCaretRect(input, mid, boundary === 'start')?.top ?? caret.top;
        if (boundary === 'start') {
          if (y < caret.top - 1) from = mid + 1;
          else to = mid;
        } else {
          if (y > caret.top + 1) to = mid - 1;
          else from = mid;
        }
      }
      return from;
    };
    const from = search(Math.min(first, position), position, 'start');
    const to = search(position, last, 'end');
    return { first, last, from, to, x: caret.left };
  }

  private moveProjectedCellCaret(input: HTMLTextAreaElement, key: string, extend: boolean):
    'handled' | { atFirst: boolean; atLast: boolean; caretColumn: number } | null {
    const presentation = this.linePresentation;
    if (presentation?.input !== input) return null;
    const head = tableCellSelectionHead(input);
    const row = this.projectedVisualRow(presentation, head);
    if (!row) return null;
    const anchor = !extend ? null : input.selectionDirection === 'backward' ? input.selectionEnd : input.selectionStart;
    const place = (position: number, wrapStart = false) => {
      const start = anchor ?? position;
      this.cellWrapStart = wrapStart ? { input, position } : null;
      input.setSelectionRange(Math.min(start, position), Math.max(start, position), position < start ? 'backward' : 'forward');
      this.updateCellLinePresentation(input);
    };
    if (key === 'Home' || key === 'End') {
      place(key === 'Home' ? row.from : row.to, key === 'Home');
      return 'handled';
    }

    const up = key === 'ArrowUp';
    const nextIndex = presentation.valueFrom - presentation.line.from + (up ? -1 : 1);
    const nextLine = presentation.lines[nextIndex];
    const atRowEdge = up ? row.from <= row.first : row.to >= row.last;
    if (atRowEdge && !nextLine) {
      // Keep the existing inter-cell navigation at the first and last rows.
      if (!extend && input.selectionStart === input.selectionEnd) {
        return { atFirst: up, atLast: !up, caretColumn: head - row.from };
      }
      place(up ? row.first : row.last);
      this.cellVerticalGoal = null;
      return 'handled';
    }

    const cellLeft = input.parentElement!.getBoundingClientRect().left;
    const goal = this.cellVerticalGoal;
    const x = goal?.input === input && goal.head === head ? goal.x : row.x - cellLeft;
    let nextRow;
    if (atRowEdge && nextLine) {
      // Activate the adjoining row first so alignment, inline syntax and
      // hidden structural prefixes are measured in the layout we will paint.
      const nextStart = nextIndex + nextLine.from;
      place(nextStart + nextLine.text.length);
      const nextPresentation = this.linePresentation;
      if (nextPresentation?.input !== input) return 'handled';
      const initial = this.projectedVisualRow(nextPresentation, tableCellSelectionHead(input));
      if (!initial) return 'handled';
      nextRow = up ? initial : this.projectedVisualRow(nextPresentation, initial.first, true);
    } else {
      const boundary = up ? row.from : row.to;
      nextRow = this.projectedVisualRow(presentation, boundary, !up);
      if (nextRow?.from === row.from && nextRow.to === row.to) {
        nextRow = this.projectedVisualRow(presentation, findClusterBreak(input.value, boundary, !up), !up);
      }
    }
    if (!nextRow) return 'handled';
    let closest = nextRow.from;
    let distance = Infinity;
    for (let offset = closest; offset <= nextRow.to; offset = findClusterBreak(input.value, offset)) {
      const rect = this.projectedCaretRect(input, offset, offset === nextRow.from);
      if (!rect) break;
      const delta = Math.abs(rect.left - cellLeft - x);
      if (delta < distance) {
        distance = delta;
        closest = offset;
      }
      if (offset === nextRow.to) break;
    }
    place(closest, closest === nextRow.from);
    this.cellVerticalGoal = { input, x, head: closest };
    return 'handled';
  }

  projectedSourceAtPoint(input: HTMLTextAreaElement, clientX: number, clientY: number): number | null | undefined {
    const presentation = this.linePresentation;
    if (presentation?.input !== input || this.composingInput === input) return undefined;
    const { bodyElement } = presentation;
    const previous = input.style.pointerEvents;
    let resolution: InlineCaretResolution;
    try {
      input.style.pointerEvents = 'none';
      resolution = resolveInlineCaretAtPoint(bodyElement, clientX, clientY, { nearestFallback: false });
    } finally {
      input.style.pointerEvents = previous;
    }
    const { domCaret: caret, sourceOffset } = resolution;
    if (!caret || !(caret.node instanceof Text)) return null;
    const text = caret.node;
    const range = input.ownerDocument.createRange();
    for (const offset of [caret.offset, caret.offset - 1]) {
      if (offset < 0 || offset >= text.length || /\s/.test(text.data[offset]!)) continue;
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      if (Array.from(range.getClientRects()).some(rect =>
        clientX >= rect.left && clientX < rect.right && clientY >= rect.top && clientY < rect.bottom
      )) return sourceOffset;
    }
    return null;
  }

  private paintCellLineSelection(presentation: TableCellLinePresentation, preview: HTMLElement, from: number, to: number) {
    if (presentation.selection?.from === from && presentation.selection.to === to) return;
    presentation.selection = { from, to };
    const { line, prefixMarkers } = presentation;
    const start = from - line.from, end = to - line.from;
    const first = prefixMarkers[0], last = prefixMarkers.at(-1);
    const editingPrefix = start === end
      ? prefixMarkers.some(marker => selectionEditsListMarker(start, end, marker.from, marker.to))
      : !!first && !!last && selectionEditsListMarker(start, end, first.from, last.to);
    presentation.sourceElement.classList.toggle('is-prefix-source', editingPrefix);
    if (!CSS.highlights || typeof Highlight === 'undefined') return;
    if (from === to) {
      this.clearCellLineHighlight(presentation);
      return;
    }
    const highlight = new Highlight();
    for (const range of inlineSourceSelectionRanges(preview, from, to)) highlight.add(range);
    CSS.highlights.set('meo-table-cell-selection', highlight);
    presentation.highlight = highlight;
  }

  private canProjectCellLine(input: HTMLTextAreaElement): boolean {
    return input !== this.wholeCellInput && canProjectTableCellLines(input.value);
  }

  private updateCellLinePresentation(input: HTMLTextAreaElement, force = false): boolean {
    const content = input.parentElement;
    const current = this.linePresentation?.input === input ? this.linePresentation : null;
    if (!content?.classList.contains('is-editing')) return false;
    const phase = this.cellSelection.snapshot().phase;
    if (this.composingInput === input || phase === 'text-candidate' || phase === 'dragging') return !!current;
    const projectLine = this.canProjectCellLine(input);
    if (!current && !projectLine) return false;
    const preview = content.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
    if (!preview) return false;
    const resize = () => {
      const row = input.closest('tr');
      if (row) this.resizeRow(row);
    };
    const cached = current?.editorValue === input.value ? current : null;
    const source = cached?.source ?? tableCellEditorValueToSource(input.value);
    const lines = cached?.lines ?? splitTableCellLogicalLines(source);
    const coords = this.parseCellCoords(input.dataset.tableRow, input.dataset.tableCol);
    const diagnostics = coords ? this.cellDiagnostics(coords.row, coords.col) : [];
    const sourceRange = coords ? this.cellSourceRange(coords.row, coords.col) : null;
    if (!projectLine || shouldExpandTableCellForSearch(source, this.searchState)) {
      if (current) {
        this.clearCellLinePresentation(input);
        this.renderCellPreview(preview, source, diagnostics, sourceRange);
        resize();
      }
      return false;
    }

    const { selectionStart, selectionEnd } = input;
    const from = tableCellEditorOffsetToSourceOffset(input.value, selectionStart);
    const to = tableCellEditorOffsetToSourceOffset(input.value, selectionEnd);
    // The two sides of the display-only newline share one source offset.
    // Use native text coordinates to keep an end-of-line caret on its old line.
    const nativeHead = tableCellSelectionHead(input);
    let index = lines.length - 1;
    while (index > 0 && lines[index]!.from + index > nativeHead) index--;
    const line = lines[index]!;
    const previousTarget = cached?.editingInline;
    const side = previousTarget?.to === from ? -1 : previousTarget?.from === from ? 1
      : cached?.selection && cached.selection.from > from ? 1 : -1;
    const editingInline = cached && inlineSourceTarget(cached.inlineRanges, { from, to }, side);
    if (cached && !force && cached.line === line && cached.editingInline === editingInline) {
      const prefixVisible = cached.sourceElement.classList.contains('is-prefix-source');
      this.paintCellLineSelection(cached, preview, from, to);
      if (prefixVisible !== cached.sourceElement.classList.contains('is-prefix-source')) resize();
      else this.layoutCellSourceLine(cached);
      return true;
    }

    if (this.linePresentation) this.clearCellLinePresentation(this.linePresentation.input);
    this.retainCellReadingPreview(content, preview);
    this.renderCellPreview(preview, source, diagnostics, sourceRange, line);
    const sourceElement = preview.querySelector<HTMLElement>('.meo-md-table-active-source-line');
    const textElement = sourceElement?.querySelector<HTMLElement>('.meo-md-table-source-text');
    const bodyElement = textElement?.querySelector<HTMLElement>('.meo-md-table-source-body');
    if (!sourceElement || !textElement || !bodyElement) return false;
    const candidates = Array.from(bodyElement.querySelectorAll<HTMLElement>('[data-meo-edit-inline]'));
    const inlineRanges = candidates.map(element => readInlineSourceRange(element)!);
    const revealed = inlineSourceTarget(inlineRanges, { from, to }, side);
    if (revealed) {
      for (let index = inlineRanges.length - 1; index >= 0; index--) {
        const range = inlineRanges[index]!;
        if (inlineSourceContains(range, revealed)) revealTableInlineSource(candidates[index]!, range, source);
      }
    }
    content.classList.add('is-editing-line');
    const prefixElement = textElement.querySelector<HTMLElement>('.meo-md-table-source-prefix');
    const presentation: TableCellLinePresentation = {
      input, editorValue: input.value, source, lines, line, valueFrom: line.from + index, sourceElement, textElement,
      prefixElement, prefixMarkers: tableCellPrefixMarkers(prefixElement?.textContent ?? ''),
      bodyElement, bodyRuns: inlineSourceRuns(bodyElement),
      inlineRanges, editingInline: revealed, breakElement: textElement.querySelector('.meo-md-table-source-break'),
      scrollTop: 0, measurementKey: '', selection: null, highlight: null, caret: null
    };
    this.linePresentation = presentation;
    this.paintCellLineSelection(presentation, preview, from, to);
    // Use the mixed preview's source height with the same reading minimum.
    resize();
    return true;
  }

  refreshCellPreviewFromInput(input: HTMLTextAreaElement, reading = false) {
    if (!(input instanceof HTMLTextAreaElement)) return;
    const preview = input.parentElement?.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
    if (!preview) return;
    if (!reading && this.updateCellLinePresentation(input, true)) return;
    this.clearCellLinePresentation(input);
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
    const target = this.parseCellCoords(input.dataset.tableRow, input.dataset.tableCol);
    if (isEditing && target) {
      this.releaseCellPresentation();
      for (const widget of this.view ? mountedTableWidgets.get(this.view) ?? [] : []) {
        if (widget !== this) {
          widget.releaseCellPresentation();
          widget.endCellEditing();
        }
      }
      const previous = this.cellInteraction.snapshot().editingTarget;
      if (previous && (previous.row !== target.row || previous.col !== target.col)) this.endCellEditing();
      this.cellInteraction.accept({ type: 'focus', target });
      if (input.ownerDocument.activeElement !== input || !input.ownerDocument.hasFocus()) {
        this.cellInteraction.accept({ type: 'blur', target });
      }
    }
    if (content.classList.contains('is-editing') === isEditing) return;
    if (!isEditing) {
      this.clearCellLinePresentation(input);
      if (this.wholeCellInput === input) this.wholeCellInput = null;
      content.classList.remove('is-cell-composing');
      this.releaseCellReadingPreview(content);
    }
    content.classList.toggle('is-editing', isEditing);
    const row = content.closest('tr');
    if (row) this.resizeRow(row);
    this.stickyHeaderAdapter.update();
    this.scheduleLayout();
  }

  private holdCellPresentation(pointerId: number) {
    const target = this.cellInteraction.snapshot().editingTarget;
    const input = target ? this.domRefs?.allRowInputs[target.row]?.[target.col] : this.heldCellPresentation?.input;
    if (input?.parentElement?.classList.contains('is-editing')) this.heldCellPresentation = { input, pointerId };
  }

  private releaseCellPresentation(presentation = this.heldCellPresentation) {
    if (!presentation || presentation !== this.heldCellPresentation) return;
    this.heldCellPresentation = null;
    if (!presentation.input.isConnected) {
      const content = presentation.input.parentElement;
      if (!content) return;
      content.classList.remove('is-editing');
      this.releaseCellReadingPreview(content);
      for (const cell of content.closest('tr')?.querySelectorAll<HTMLElement>('.meo-md-html-table-cell-content') ?? []) {
        cell.style.removeProperty('min-height');
      }
      return;
    }
    this.refreshCellPreviewFromInput(presentation.input, true);
    this.setCellEditingState(presentation.input, false);
  }

  endCellEditing() {
    const target = this.cellInteraction.snapshot().editingTarget;
    this.cancelPendingCellAutoCommit();
    const input = target ? this.domRefs?.allRowInputs[target.row]?.[target.col] : null;
    if (input) {
      if (this.heldCellPresentation?.input !== input) this.refreshCellPreviewFromInput(input, true);
      // Cross-table capture retires the logical owner immediately. Its source
      // geometry stays until the new pointer target has accepted the gesture.
      if (this.heldCellPresentation?.input !== input) this.setCellEditingState(input, false);
    }
    this.cellInteraction.accept({ type: 'exit' });
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
    this.wireInput(input, rowEl, rowInputs, container, rowIndex, colIndex);
    content.append(preview, input);
    return { content, input };
  }

  createContextIcon(icon: IconNode, className = '') {
    return createElement(icon, {
      width: 18,
      height: 18,
      'aria-hidden': 'true',
      class: `meo-md-html-table-context-icon${className ? ` ${className}` : ''}`
    });
  }

  createContextButton(
    label: string,
    command: TableCommand | null,
    icon: IconNode,
    onClick: () => void,
    badge?: { icon: IconNode; placement: 'top' | 'bottom' | 'left' | 'right' | 'bottom-right' }
  ) {
    const button = document.createElement('button');
    button.type = 'button';
    button.tabIndex = -1;
    button.className = 'meo-md-html-table-context-btn';
    button.dataset.tooltip = label;
    button.setAttribute('aria-label', label);
    button.setAttribute('role', 'menuitem');
    if (command) {
      button.dataset.command = command;
      const shortcutCommand = Object.entries(tableShortcutCommands).find(([, target]) => target === command)?.[0];
      if (shortcutCommand) button.dataset.tooltipCommand = shortcutCommand;
    }
    button.appendChild(this.createContextIcon(icon));
    if (badge) {
      button.appendChild(this.createContextIcon(
        badge.icon,
        `meo-md-html-table-context-icon-badge is-${badge.placement}`
      ));
    }
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      // Preserve the cell selection; activate on click so a held button can
      // paint its native pressed state before a command replaces the table DOM.
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 0 && !button.disabled) onClick();
    });
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  visibleContextMenuButtons(): HTMLButtonElement[] {
    if (!this.domRefs) return [];
    return Array.from(this.domRefs.contextPages[this.contextPage].querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
  }

  refreshUiLanguage(language: UiLanguage) {
    if (!this.domRefs) return;
    this.clearDeleteTableConfirmation();
    const strings = getUiStrings(language);
    const { contextTrigger, contextMenu, contextButtons, stickyHeaderViewport } = this.domRefs;
    contextTrigger.dataset.tooltip = strings.tableActions;
    contextTrigger.setAttribute('aria-label', strings.tableActions);
    contextMenu.setAttribute('aria-label', strings.tableActions);
    stickyHeaderViewport.dataset.tooltip = strings.returnToTableHeader;

    const commandLabels: Array<[HTMLButtonElement, string]> = [
      [contextButtons.collapse, strings.tableCollapse],
      [contextButtons.collapseArrangement, strings.tableCollapse],
      [contextButtons.previousPage, strings.tablePreviousActions],
      [contextButtons.nextPage, strings.tableMoreActions],
      [contextButtons.insertRowAbove, strings.insertRowAbove],
      [contextButtons.insertRowBelow, strings.insertRowBelow],
      [contextButtons.moveRowUp, strings.moveRowUp],
      [contextButtons.moveRowDown, strings.moveRowDown],
      [contextButtons.deleteRow, strings.deleteRow],
      [contextButtons.insertColumnLeft, strings.insertColumnLeft],
      [contextButtons.insertColumnRight, strings.insertColumnRight],
      [contextButtons.moveColumnLeft, strings.moveColumnLeft],
      [contextButtons.moveColumnRight, strings.moveColumnRight],
      [contextButtons.deleteColumn, strings.deleteColumn],
      [contextButtons.deleteTable, strings.deleteTable],
      [contextButtons.alignColumnLeft, strings.alignColumnLeft],
      [contextButtons.alignColumnCenter, strings.alignColumnCenter],
      [contextButtons.alignColumnRight, strings.alignColumnRight],
      [contextButtons.sortAscending, strings.sortTableAscending],
      [contextButtons.sortDescending, strings.sortTableDescending],
      [contextButtons.editEntireCell, strings.tableEditEntireCell]
    ];
    for (const [button, accessibleLabel] of commandLabels) {
      button.dataset.tooltip = accessibleLabel;
      button.setAttribute('aria-label', accessibleLabel);
    }
    this.updateContextControlsPosition();
  }

  clearDeleteTableConfirmation() {
    if (this.deleteTableConfirmationTimer !== null) window.clearTimeout(this.deleteTableConfirmationTimer);
    this.deleteTableConfirmationTimer = null;
    const button = this.domRefs?.contextButtons.deleteTable;
    if (button) {
      button.classList.remove('is-delete-armed');
      button.querySelector('.meo-md-html-table-context-delete-label')!.textContent = '';
      button.dataset.tooltip = button.getAttribute('aria-label') ?? '';
    }
  }

  setContextPage(page: TableContextPage, focusFirst = false) {
    this.clearDeleteTableConfirmation();
    this.contextPage = page;
    if (!this.domRefs) return;
    const { contextMenu, contextPages } = this.domRefs;
    contextPages.structure.hidden = page !== 'structure';
    contextPages.arrangement.hidden = page !== 'arrangement';
    contextMenu.dataset.activePage = page;
    this.updateContextControlsPosition();
    if (focusFirst && !contextMenu.hidden) {
      this.visibleContextMenuButtons()[0]?.focus({ preventScroll: true });
    }
  }

  setContextMenuOpen(open: boolean, focusFirst = false) {
    if (!open) this.clearDeleteTableConfirmation();
    if (!this.domRefs) return;
    const { shell, contextTrigger, contextMenu } = this.domRefs;
    contextMenu.hidden = !open;
    contextTrigger.setAttribute('aria-expanded', String(open));
    shell.classList.toggle('is-context-menu-open', open);
    if (!open) return;
    this.setContextPage(this.contextPage);
    this.updateContextMenuState();
    this.updateContextControlsPosition();
    if (focusFirst && !contextMenu.hidden) {
      this.visibleContextMenuButtons()[0]?.focus({ preventScroll: true });
    }
  }

  updateContextControlsPosition() {
    // toDOM builds this shell before CodeMirror attaches it. Its scheduled
    // layout will position controls; measuring here or during disposal only
    // flushes unrelated document layout for geometry we cannot use.
    if (this.destroyed || !this.domRefs?.shell.isConnected) return;
    const { shell, wrap, contextTrigger, contextMenu } = this.domRefs;
    const rowIndex = this.cellSelection.snapshot().anchor?.row ?? this.activeTarget.row;
    const row = this.domRefs.allRowInputs[rowIndex]?.[0]?.closest('tr');
    if (!row) { contextTrigger.hidden = true; return; }
    const shellRect = shell.getBoundingClientRect();
    const wrapRect = wrap.getBoundingClientRect();
    const viewportRect = this.view?.scrollDOM.getBoundingClientRect() ?? {
      left: 0,
      right: window.innerWidth,
      top: 0,
      bottom: window.innerHeight
    };
    const rowRect = row.getBoundingClientRect();
    const stickyHeaderVisible = this.domRefs.stickyChrome.classList.contains('is-visible');
    const effectiveViewportTop = stickyHeaderVisible
      ? Math.max(viewportRect.top, this.domRefs.stickyChrome.getBoundingClientRect().bottom)
      : viewportRect.top;
    const targetOutsideViewport = rowRect.bottom <= effectiveViewportTop || rowRect.top >= viewportRect.bottom;
    const targetHiddenByStickyHeader = rowIndex === 0 && stickyHeaderVisible;
    contextTrigger.hidden = targetOutsideViewport || targetHiddenByStickyHeader;
    if (contextTrigger.hidden && !contextMenu.hidden) this.setContextMenuOpen(false);
    if (contextTrigger.hidden) return;
    const visibleTop = Math.max(effectiveViewportTop, wrapRect.top);
    const visibleBottom = Math.min(viewportRect.bottom, wrapRect.bottom);
    const hasCellSelection = this.cellSelection.selectedCellRange() !== null;
    const focusedInput = document.activeElement;
    const targetInput = focusedInput instanceof HTMLTextAreaElement && row.contains(focusedInput)
      ? focusedInput
      : this.domRefs.allRowInputs[rowIndex]?.[this.activeTarget.col] ?? null;
    // Passive reading has no native caret to follow. Creating its mirror here
    // forces layout and also wakes floating chrome's body mutation observer.
    const caretBounds = !hasCellSelection && targetInput
      && (targetInput === focusedInput || !contextMenu.hidden)
      ? tableCellCaretViewportBounds(targetInput)
      : null;
    const anchorCenter = caretBounds
      ? (caretBounds.top + caretBounds.bottom) / 2
      : rowRect.top + rowRect.height / 2;
    const rowCenterInViewport = Math.min(
      Math.max(anchorCenter, visibleTop + 14),
      visibleBottom - 14
    );
    const rowCenter = rowCenterInViewport - shellRect.top;
    const triggerLeft = Math.max(
      viewportRect.left - shellRect.left + 2,
      wrapRect.left - shellRect.left - contextTrigger.offsetWidth - 4
    );
    contextTrigger.style.left = `${triggerLeft}px`;
    contextTrigger.style.top = `${rowCenter}px`;
    if (contextMenu.hidden) return;
    const gap = 8;
    const menuWidth = contextMenu.offsetWidth;
    const menuHeight = contextMenu.offsetHeight;
    const visibleLeft = Math.max(shellRect.left, viewportRect.left);
    const visibleRight = Math.min(shellRect.right, viewportRect.right);
    const preferredLeft = shellRect.left + triggerLeft;
    const menuLeft = Math.min(
      Math.max(preferredLeft, visibleLeft + 4),
      Math.max(visibleLeft + 4, visibleRight - menuWidth - 4)
    );
    const minimumMenuTop = effectiveViewportTop + 4;
    const maximumMenuTop = Math.max(minimumMenuTop, viewportRect.bottom - menuHeight - 4);
    const aboveRow = rowRect.top - menuHeight - gap;
    const belowRow = rowRect.bottom + gap;
    let menuTop: number;
    if (belowRow <= maximumMenuTop) {
      menuTop = belowRow;
    } else if (aboveRow >= minimumMenuTop) {
      menuTop = aboveRow;
    } else {
      // A row taller than the viewport has no true "outside" position. Keep the
      // toolbar away from the editing point and pin it to a viewport edge instead
      // of letting it float beside the caret in the middle of the window.
      const viewportCenter = (effectiveViewportTop + viewportRect.bottom) / 2;
      menuTop = rowCenterInViewport <= viewportCenter
        ? maximumMenuTop
        : minimumMenuTop;
    }
    contextMenu.style.left = `${menuLeft - shellRect.left}px`;
    contextMenu.style.top = `${menuTop - shellRect.top}px`;
  }

  createTableContextControls(container: HTMLElement) {
    const strings = getUiStrings(this.view!.state.facet(uiLanguageFacet));
    const menuId = `meo-table-context-menu-${++nextTableContextMenuSequence}`;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.tabIndex = -1;
    trigger.className = 'meo-md-html-table-context-trigger';
    trigger.dataset.tooltip = strings.tableActions;
    trigger.setAttribute('aria-label', strings.tableActions);
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', menuId);
    trigger.appendChild(this.createContextIcon(EllipsisVertical));

    const menu = document.createElement('div');
    menu.id = menuId;
    menu.className = 'meo-visual-surface meo-md-html-table-context-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', strings.tableActions);
    menu.dataset.activePage = this.contextPage;
    menu.hidden = true;

    const collapse = this.createContextButton(strings.tableCollapse, null, X, () => {
      this.setContextMenuOpen(false);
    });
    collapse.classList.add('meo-md-html-table-context-collapse');
    const collapseArrangement = this.createContextButton(strings.tableCollapse, null, X, () => {
      this.setContextMenuOpen(false);
    });
    collapseArrangement.classList.add('meo-md-html-table-context-collapse');
    const previousPage = this.createContextButton(strings.tablePreviousActions, null, ChevronLeft, () => {
      this.setContextPage('structure', document.activeElement === previousPage);
    });
    previousPage.classList.add('meo-md-html-table-context-page-btn', 'meo-md-html-table-context-previous');
    previousPage.dataset.pageAction = 'previous';
    const nextPage = this.createContextButton(strings.tableMoreActions, null, ChevronRight, () => {
      this.setContextPage('arrangement', document.activeElement === nextPage);
    });
    nextPage.classList.add('meo-md-html-table-context-page-btn', 'meo-md-html-table-context-next');
    nextPage.dataset.pageAction = 'next';
    const insertRowAbove = this.createContextButton(strings.insertRowAbove, 'insert-row-above', Rows2, () => {
      this.requestInsertRowAbove(container);
    }, { icon: Plus, placement: 'top' });
    const insertRowBelow = this.createContextButton(strings.insertRowBelow, 'insert-row-below', Rows2, () => {
      this.requestInsertRowBelow(container);
    }, { icon: Plus, placement: 'bottom' });
    const moveRowUp = this.createContextButton(strings.moveRowUp, 'move-row-up', ArrowUp, () => {
      this.requestMoveRow(container, 'up');
    });
    const moveRowDown = this.createContextButton(strings.moveRowDown, 'move-row-down', ArrowDown, () => {
      this.requestMoveRow(container, 'down');
    });
    const deleteRow = this.createContextButton(strings.deleteRow, 'delete-row', Rows2, () => {
      this.requestDeleteRow(container);
    }, { icon: X, placement: 'bottom-right' });
    const insertColumnLeft = this.createContextButton(strings.insertColumnLeft, 'insert-column-left', Columns2, () => {
      this.requestInsertColumnLeft(container);
    }, { icon: Plus, placement: 'left' });
    const insertColumnRight = this.createContextButton(strings.insertColumnRight, 'insert-column-right', Columns2, () => {
      this.requestInsertColumnRight(container);
    }, { icon: Plus, placement: 'right' });
    const moveColumnLeft = this.createContextButton(strings.moveColumnLeft, 'move-column-left', ArrowLeft, () => {
      this.requestMoveColumn(container, 'left');
    });
    const moveColumnRight = this.createContextButton(strings.moveColumnRight, 'move-column-right', ArrowRight, () => {
      this.requestMoveColumn(container, 'right');
    });
    const deleteColumn = this.createContextButton(strings.deleteColumn, 'delete-column', Columns2, () => {
      this.requestDeleteColumn(container);
    }, { icon: X, placement: 'bottom-right' });
    const deleteTable = this.createContextButton(strings.deleteTable, 'delete-table', Trash2, () => {
      if (this.destroyed || !this.domRefs) return;
      if (this.deleteTableConfirmationTimer !== null) {
        this.clearDeleteTableConfirmation();
        this.requestTableCommand('delete-table');
        return;
      }
      // Keep the collapsed icon's text empty so shared hints do not suppress its
      // label as duplicate visible text. Read the current label after language changes.
      deleteLabel.textContent = deleteTable.getAttribute('aria-label') ?? strings.deleteTable;
      deleteTable.style.setProperty('--meo-table-delete-confirm-width', `${Math.ceil(deleteLabel.getBoundingClientRect().width) + 16}px`);
      deleteTable.classList.add('is-delete-armed');
      deleteTable.removeAttribute('data-tooltip');
      this.deleteTableConfirmationTimer = window.setTimeout(() => {
        this.clearDeleteTableConfirmation();
        this.updateContextControlsPosition();
      }, 3000);
    });
    deleteTable.classList.add('meo-md-html-table-context-delete-btn', 'meo-md-html-table-context-delete-table');
    const deleteLabel = document.createElement('span');
    deleteLabel.className = 'meo-md-html-table-context-delete-label';
    deleteLabel.setAttribute('aria-hidden', 'true');
    deleteTable.append(deleteLabel);
    deleteTable.addEventListener('keydown', (event) => {
      if (!event.repeat) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
    deleteTable.addEventListener('transitionend', (event) => {
      if (event.propertyName === 'width') this.updateContextControlsPosition();
    });
    const alignColumnLeft = this.createContextButton(strings.alignColumnLeft, 'align-left', AlignLeft, () => {
      this.requestColumnAlignment(container, 'left');
    });
    alignColumnLeft.classList.add('meo-md-html-table-context-align-left');
    const alignColumnCenter = this.createContextButton(strings.alignColumnCenter, 'align-center', AlignCenter, () => {
      this.requestColumnAlignment(container, 'center');
    });
    alignColumnCenter.classList.add('meo-md-html-table-context-align-center');
    const alignColumnRight = this.createContextButton(strings.alignColumnRight, 'align-right', AlignRight, () => {
      this.requestColumnAlignment(container, 'right');
    });
    alignColumnRight.classList.add('meo-md-html-table-context-align-right');
    const sortAscending = this.createContextButton(strings.sortTableAscending, 'sort-ascending', ArrowDownAZ, () => {
      this.requestTableCommand('sort-ascending', !sortAscending.disabled);
    });
    const sortDescending = this.createContextButton(strings.sortTableDescending, 'sort-descending', ArrowDownZA, () => {
      this.requestTableCommand('sort-descending', !sortDescending.disabled);
    });
    const editEntireCell = this.createContextButton(strings.tableEditEntireCell, null, Pencil, () => {
      const input = this.cellInput(this.activeTarget.row, this.activeTarget.col);
      if (!input) return;
      this.wholeCellInput = input;
      const { selectionStart, selectionEnd, selectionDirection } = input;
      const backward = selectionDirection === 'backward';
      this.setContextMenuOpen(false);
      this.focusTableInput(input, backward ? selectionStart : selectionEnd, {
        selectionAnchor: backward ? selectionEnd : selectionStart
      });
      if (input.parentElement?.closest('tr')) this.resizeRow(input.parentElement.closest('tr')!);
    });
    editEntireCell.hidden = true;
    editEntireCell.disabled = true;
    alignColumnLeft.setAttribute('role', 'menuitemradio');
    alignColumnCenter.setAttribute('role', 'menuitemradio');
    alignColumnRight.setAttribute('role', 'menuitemradio');
    deleteRow.classList.add('meo-md-html-table-context-delete-btn');
    deleteColumn.classList.add('meo-md-html-table-context-delete-btn');

    const createSeparator = (edgePosition?: 'after-leading-control' | 'before-trailing-control') => {
      const separator = document.createElement('span');
      separator.className = 'meo-md-html-table-context-separator';
      if (edgePosition) separator.classList.add(`is-${edgePosition}`);
      separator.setAttribute('role', 'separator');
      separator.setAttribute('aria-orientation', 'vertical');
      return separator;
    };
    const structurePage = document.createElement('div');
    structurePage.className = 'meo-md-html-table-context-page';
    structurePage.dataset.contextPage = 'structure';
    structurePage.append(
      collapse,
      createSeparator('after-leading-control'),
      insertRowAbove,
      insertRowBelow,
      deleteRow,
      createSeparator(),
      insertColumnLeft,
      insertColumnRight,
      deleteColumn,
      createSeparator(),
      deleteTable,
      createSeparator('before-trailing-control'),
      nextPage
    );
    const arrangementPage = document.createElement('div');
    arrangementPage.className = 'meo-md-html-table-context-page';
    arrangementPage.dataset.contextPage = 'arrangement';
    arrangementPage.hidden = true;
    arrangementPage.append(
      collapseArrangement,
      createSeparator('after-leading-control'),
      moveRowUp,
      moveRowDown,
      moveColumnLeft,
      moveColumnRight,
      createSeparator(),
      alignColumnLeft,
      alignColumnCenter,
      alignColumnRight,
      createSeparator(),
      sortAscending,
      sortDescending,
      editEntireCell,
      createSeparator('before-trailing-control'),
      previousPage
    );
    menu.append(structurePage, arrangementPage);

    trigger.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    });
    trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.button !== 0) return;
      if (menu.hidden) this.setContextPage('structure');
      this.setContextMenuOpen(menu.hidden);
    });
    trigger.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'ArrowDown') return;
      event.preventDefault();
      event.stopPropagation();
      this.setContextPage('structure');
      this.setContextMenuOpen(true, true);
    });
    menu.addEventListener('keydown', (event) => {
      const buttons = this.visibleContextMenuButtons();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (this.deleteTableConfirmationTimer !== null) {
          this.clearDeleteTableConfirmation();
          deleteTable.focus({ preventScroll: true });
          return;
        }
        this.setContextMenuOpen(false);
        trigger.focus({ preventScroll: true });
        return;
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault();
        buttons[event.key === 'Home' ? 0 : buttons.length - 1]?.focus({ preventScroll: true });
        return;
      }
      if (!['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      buttons[(index + delta + buttons.length) % buttons.length]?.focus({ preventScroll: true });
    });

    return {
      trigger,
      menu,
      pages: {
        structure: structurePage,
        arrangement: arrangementPage
      },
      buttons: {
        collapse,
        collapseArrangement,
        previousPage,
        nextPage,
        insertRowAbove,
        insertRowBelow,
        moveRowUp,
        moveRowDown,
        deleteRow,
        insertColumnLeft,
        insertColumnRight,
        moveColumnLeft,
        moveColumnRight,
        deleteColumn,
        deleteTable,
        alignColumnLeft,
        alignColumnCenter,
        alignColumnRight,
        sortAscending,
        sortDescending,
        editEntireCell
      }
    };
  }

  toDOM(view: EditorView, previous?: HtmlTableController) {
    const acceptedDiff = view.state.facet(gitDiffLineFlagsFacet);
    if (acceptedDiff?.doc === view.state.doc) {
      const diffFlagsByLine = collectTableDiffFlags(buildTableData(view.state, this.tableData), acceptedDiff.lines);
      const signature = { ...JSON.parse(this.tableData.signature), diffFlagsByLine };
      this.tableData = { ...this.tableData, diffFlagsByLine, diffBaseline: acceptedDiff.baseline, signature: JSON.stringify(signature) };
    }
    this.positionDocument = new WeakRef(view.state.doc);
    this.view = view;
    const existingSearchState = (view.dom as any).__meoSearchState;
    if (existingSearchState && typeof existingSearchState === 'object') {
      this.searchState = existingSearchState.text ? existingSearchState : null;
    }
    const shell = document.createElement('div');
    shell.className = 'meo-md-html-table-shell';
    // A remounted table sizes its native inputs in the next layout frame. Keep
    // the measured block height until then so virtualization cannot shrink it.
    if (this.measuredHeight > 0) shell.style.minHeight = `${this.measuredHeight}px`;
    tableDomOwners.set(shell, this);
    applyLiveBlockIndent(shell, this.tableData.visualIndent);
    shell.style.setProperty(
      '--meo-html-table-indent',
      liveBlockIndentCssValue(this.tableData.visualIndent) ?? '0ch'
    );
    const wrap = document.createElement('div');
    wrap.className = 'meo-md-html-table-wrap';
    if (Number.isFinite(this.tableData.startLine)) {
      shell.dataset.meoRenderedBlockStartLine = String(this.tableData.startLine);
    }
    if (Number.isFinite(this.tableData.endLine)) {
      shell.dataset.meoRenderedBlockEndLine = String(this.tableData.endLine);
    }
    shell.dataset.meoRenderedBlockKind = 'table';
    if (typeof ResizeObserver !== 'undefined') {
      const heightObserver = new ResizeObserver(() => {
        const height = shell.getBoundingClientRect().height;
        const previous = this.measuredHeightCache.height;
        if (height <= 0) return;
        this.measuredHeightCache.height = height;
        if (Math.abs(previous - height) > .1) view.plugin(tableLineNumbers)?.request({ beforePaint: true });
      });
      heightObserver.observe(shell);
      this.cleanupFns.push(() => heightObserver.disconnect());
    }
    const {
      trigger: contextTrigger,
      menu: contextMenu,
      pages: contextPages,
      buttons: contextButtons
    } = this.createTableContextControls(wrap);

    const table = document.createElement('table');
    table.className = 'meo-md-html-table';
    table.tabIndex = -1;
    table.dataset.tableColumnWidth = 'true';
    table.dataset.tablePreferredColumnWidth = '90';
    table.dataset.tableSignature = tableWidthIdentity(this.tableData);
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
    headerRow.setAttribute('aria-rowindex', '1');
    headerRow.dataset.sourceLineNumber = String(this.tableData.startLine ?? '');
    rowEntries.push({ row: headerRow, inputs: headerInputs });
    const headerCells: HTMLTableCellElement[] = [];
    const headerAlignmentOverrides = this.headerAlignmentOverrideColumns(view);
    for (let col = 0; col < this.tableData.colCount; col++) {
      const th = document.createElement('th');
      const headerAlignment = this.tableData.alignments[col]
        ?? (headerAlignmentOverrides?.has(col) ? 'left' : 'center');
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
      th.appendChild(createTableColumnResizeHandle(col));

      headerRow.appendChild(th);
    }
    cellGrid.push(headerCells);
    allRowInputs.push(headerInputs);
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const bodyRowInputs: HTMLTextAreaElement[][] = Array.from({ length: this.tableData.rows.length }, () => []);
    allRowInputs.push(...bodyRowInputs);
    cellGrid.push(...Array.from({ length: this.tableData.rows.length }, () => [] as HTMLTableCellElement[]));
    const renderBodyRow = (rowIdx: number) => {
      const source = this.sourceRow(rowIdx + 1);
      const tr = document.createElement('tr');
      tr.setAttribute('aria-rowindex', String(rowIdx + 2));
      tr.dataset.sourceLineNumber = String((this.tableData.startLine ?? 0) + rowIdx + 2);
      tr.dataset.tableBodyRow = String(rowIdx);
      tr.dataset.tableRowEven = String(rowIdx % 2 === 1);
      const inputs = bodyRowInputs[rowIdx]!;
      rowEntries.push({ row: tr, inputs });
      const bodyCells = cellGrid[rowIdx + 1]!;
      const tableRowIndex = rowIdx + 1;
      for (let col = 0; col < this.tableData.colCount; col++) {
        const td = document.createElement('td');
        const columnAlignment = this.tableData.alignments[col] ?? 'left';
        td.dataset.tableRow = String(tableRowIndex);
        td.dataset.tableCol = String(col);
        td.style.textAlign = columnAlignment;
        const { content, input } = this.createCellEditor(
          source[col] ?? '',
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
        td.appendChild(createTableColumnResizeHandle(col));

        tr.appendChild(td);
      }
      return tr;
    };
    // Three-round comparisons found gains at 512+ rows, while forcing a
    // 256-row/four-column table added startup work. Keep both row/cell floors.
    const windowRows = this.tableData.rows.length >= 512 && this.tableData.rows.length * this.tableData.colCount >= 1024
      && !view.dom.ownerDocument.body.classList.contains('vscode-using-screen-reader');
    if (!windowRows) for (let row = 0; row < this.tableData.rows.length; row++) tbody.append(renderBodyRow(row));
    table.appendChild(tbody);

    const stickyChrome = document.createElement('div');
    stickyChrome.className = 'meo-md-html-table-sticky-chrome';
    stickyChrome.setAttribute('aria-hidden', 'true');
    const stickyShadow = document.createElement('div');
    stickyShadow.className = 'meo-md-html-table-sticky-shadow';
    stickyShadow.hidden = true;
    stickyShadow.setAttribute('aria-hidden', 'true');
    const stickyHeaderViewport = document.createElement('div');
    stickyHeaderViewport.className = 'meo-md-html-table-sticky-header';
    stickyHeaderViewport.dataset.tooltipPositioning = 'pointer';
    stickyHeaderViewport.dataset.tooltip = getUiStrings(view.state.facet(uiLanguageFacet)).returnToTableHeader;
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
    stickyChrome.append(stickyHeaderViewport);

    const diffMarkerLayer = document.createElement('div');
    diffMarkerLayer.className = 'meo-md-html-table-diff-markers';
    const diffGutter = view.dom.querySelector('.meo-git-gutter');
    if (diffGutter instanceof HTMLElement) diffGutter.appendChild(diffMarkerLayer);
    this.cleanupFns.push(() => diffMarkerLayer.remove());
    wrap.append(table);
    shell.append(contextTrigger, contextMenu, wrap, stickyChrome, stickyShadow);
    this.domRefs = {
      shell,
      wrap,
      table,
      tbody,
      container: shell,
      diffMarkerLayer,
      rowEntries,
      headerInputs,
      rowInputs: bodyRowInputs,
      allRowInputs,
      cellGrid,
      sourceBodyRowInputs: bodyRowInputs,
      stickyChrome,
      stickyShadow,
      stickyHeaderViewport,
      stickyTable,
      stickyHeaderRow,
      contextTrigger,
      contextMenu,
      contextPages,
      contextButtons
    };
    if (windowRows) {
      table.dataset.meoTableWindowed = 'true';
      table.setAttribute('aria-rowcount', String(this.tableData.rows.length + 1));
      table.setAttribute('aria-colcount', String(this.tableData.colCount));
      const estimateLayout = () => estimateTableLayout({ kind: 'table', headerCells: this.tableData.headerCells,
        rows: this.tableData.rows, contentWidth: Math.max(352, view.scrollDOM.clientWidth - 24) }, view.contentDOM);
      const layoutKey = () => {
        const style = getComputedStyle(view.contentDOM);
        return [view.scrollDOM.clientWidth, style.fontSize, style.fontFamily, style.fontWeight, style.lineHeight].join('|');
      };
      let estimatedLayoutKey = layoutKey();
      const layout = estimateLayout();
      this.rowWindowLayoutKey = estimatedLayoutKey;
      let estimatedHeights = layout.rowHeights.slice(1);
      const previousColumns = previous?.domRefs?.table.querySelectorAll<HTMLTableColElement>(':scope > colgroup > col');
      if (previous && previous.rowWindow && previous.rowWindowLayoutKey === estimatedLayoutKey
        && previousColumns?.length === layout.columnWidths.length
        && layout.columnWidths.every((width, index) => Math.abs(parseFloat(previousColumns[index]!.style.width) - width) < 0.1)) {
        // Replacing the table does not invalidate offscreen rows with the same
        // content and layout. Seed their accepted heights before the new DOM
        // can expose a different viewport or mount a different row band.
        const heights = previous.rowWindow.readHeights();
        const active = view.dom.ownerDocument.activeElement;
        const editingRow = active instanceof HTMLTextAreaElement && previous.domRefs?.shell.contains(active)
          ? Number(active.dataset.tableRow) - 1 : -1;
        const byContent = new Map<string, { heights: (number | undefined)[]; next: number }>();
        previous.tableData.rows.forEach((row, index) => {
          const key = JSON.stringify(row);
          let group = byContent.get(key);
          if (!group) {
            group = { heights: [], next: 0 };
            byContent.set(key, group);
          }
          group.heights.push(index === editingRow ? undefined : heights[index]);
        });
        estimatedHeights = this.tableData.rows.map((row, index) => {
          const group = byContent.get(JSON.stringify(row));
          return group?.heights[group.next++] ?? estimatedHeights[index]!;
        });
      }
      table.style.tableLayout = 'fixed';
      table.style.width = `${layout.columnWidths.reduce((sum, width) => sum + width, 0)}px`;
      colgroup.forEach((col, index) => { col.style.width = `${layout.columnWidths[index]}px`; });
      this.rowWindow = createTableRowWindow({ body: tbody, viewport: view.scrollDOM,
        rowCount: this.tableData.rows.length, columnCount: this.tableData.colCount,
        estimateHeight: 32, estimatedHeights,
        refreshEstimatedHeights: () => {
          const key = layoutKey();
          if (key === estimatedLayoutKey) return undefined;
          estimatedLayoutKey = key;
          this.rowWindowLayoutKey = key;
          return estimateLayout().rowHeights.slice(1);
        },
        render: renderBodyRow,
        scrollbarDragging: () => getViewportController(view)?.isScrollbarDragging() ?? false,
        release: (index, row) => {
          disposeImagePresentations(row);
          bodyRowInputs[index]!.length = 0; cellGrid[index + 1]!.length = 0;
          const entry = rowEntries.findIndex(item => item.row === row);
          if (entry >= 0) rowEntries.splice(entry, 1);
        },
        retain: () => {
          if (view.dom.ownerDocument.body.classList.contains('vscode-using-screen-reader')) return bodyRowInputs.map((_, index) => index);
          const interaction = this.cellInteraction.snapshot(), selection = this.cellSelection.snapshot();
          return [interaction.editingTarget?.row, ...interaction.pending.map(edit => edit.row),
            selection.anchor?.row, selection.range?.fromRow, selection.range?.toRow]
            .filter((row): row is number => row !== undefined && row > 0).map(row => row - 1);
        },
        size: rows => this.resizeRows(rows.map(row => ({ row,
          inputs: bodyRowInputs[Number(row.dataset.tableBodyRow)]! }))),
        changed: () => {
          rowEntries.sort((left, right) => Number(left.row.dataset.tableBodyRow ?? -1) - Number(right.row.dataset.tableBodyRow ?? -1));
          view.requestMeasure();
          if (shell.isConnected) view.plugin(tableLineNumbers)?.request({ beforePaint: true });
        }
      });
      this.rowWindow.update();
      let screenReader = false;
      const accessibility = new MutationObserver(() => {
        const next = view.dom.ownerDocument.body.classList.contains('vscode-using-screen-reader');
        if (next !== screenReader) { screenReader = next; this.rowWindow?.update(); }
      });
      accessibility.observe(view.dom.ownerDocument.body, { attributes: true, attributeFilter: ['class'] });
      this.cleanupFns.push(() => accessibility.disconnect());
    }
    const cancelCaretReveal = () => { this.tableCaretRevealGeneration += 1; };
    const updateActiveContextControls = () => {
      if (!this.domRefs || (!this.rowWindow && this.domRefs.rowEntries.length < 256 &&
        !this.domRefs.shell.matches(':focus-within, .is-interacting, .is-context-menu-open'))) return;
      this.scheduleLayout();
    };
    view.scrollDOM.addEventListener('wheel', cancelCaretReveal, { passive: true });
    view.scrollDOM.addEventListener('touchstart', cancelCaretReveal, { passive: true });
    view.scrollDOM.addEventListener('scroll', updateActiveContextControls, { passive: true });
    view.scrollDOM.ownerDocument.defaultView?.addEventListener('resize', updateActiveContextControls);
    this.cleanupFns.push(() => {
      view.scrollDOM.removeEventListener('wheel', cancelCaretReveal);
      view.scrollDOM.removeEventListener('touchstart', cancelCaretReveal);
      view.scrollDOM.removeEventListener('scroll', updateActiveContextControls);
      view.scrollDOM.ownerDocument.defaultView?.removeEventListener('resize', updateActiveContextControls);
    });
    let mounted = mountedTableWidgets.get(view);
    if (!mounted) {
      mounted = new Set();
      mountedTableWidgets.set(view, mounted);
    }
    mounted.add(this);
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
    const onColumnWidthProjected = () => {
      this.stickyHeaderAdapter.invalidate();
      this.scheduleLayout({ resizeRows: true });
    };
    table.addEventListener('meo-table-column-width-projected', onColumnWidthProjected);
    this.cleanupFns.push(() => {
      table.removeEventListener('meo-table-column-width-projected', onColumnWidthProjected);
    });
    this.updateActionTargetStyles();
    this.wireTableSelection(table);
    this.pendingResizeRows = true;
    this.scheduleLayout({ resizeRows: true });

    const onSearchStateChange = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      this.setSearchState(isTableSearchState(detail) ? detail : null);
    };
    view.dom.addEventListener(tableSearchStateEventName, onSearchStateChange);
    this.cleanupFns.push(() => {
      view.dom.removeEventListener(tableSearchStateEventName, onSearchStateChange);
    });
    return shell;
  }

  ignoreEvent() {
    return true;
  }

  destroy(dom: HTMLElement) {
    tableDomOwners.delete(dom);
    this.clearDeleteTableConfirmation();
    this.destroyed = true;
    const selectionDisposal = this.cellSelection.accept({ type: 'dispose' });
    this.applyCellSelectionTransition(selectionDisposal);
    if (this.linePresentation) this.clearCellLinePresentation(this.linePresentation.input);
    disposeImagePresentations(dom);
    this.tableCommandTargetRegistration?.dispose();
    this.tableCommandTargetRegistration = null;
    this.stickyHeaderAdapter.unmount();
    this.stickyHeaderAdapter.dispose();
    this.rowWindow?.dispose(); this.rowWindow = undefined;
    for (const dispose of this.cleanupFns) dispose();
    this.cleanupFns = [];
    if (this.layoutFrame) {
      cancelAnimationFrame(this.layoutFrame);
      this.layoutFrame = 0;
    }
    this.layoutTasks.clear();
    if (this.view && mountedTableWidgets.get(this.view)?.delete(this)) this.view.plugin(tableLineNumbers)?.request();
    this.domRefs = null;
    this.view = null;
    this.cellInteraction.accept({ type: 'dispose' });
    this.cancelPendingCellAutoCommit();
    this.pendingCellSwitchCommit = false;
    this.destroyed = true;
  }
}

export function isTableDelimiterLine(lineText: string): boolean {
  return isMarkdownTableDelimiter(parseBlockLinePrefix(lineText).content);
}

/** Source geometry does not need cell segmentation, inline Markdown or widget
 * data. Keep the same header/delimiter/body bounds as the detailed table model. */
export function getTableSourceBounds(state: EditorState, tableNode: Pick<SyntaxNodeRef, 'from' | 'to'>) {
  const first = state.doc.lineAt(tableNode.from);
  const last = state.doc.lineAt(Math.max(tableNode.to - 1, tableNode.from));
  let delimiterLine: number | null = null, headerLine = first.number, endLine = last.number;
  for (let number = first.number; number <= last.number; number++) {
    const line = state.doc.line(number);
    const content = parseBlockLinePrefix(line.text).content;
    if (delimiterLine === null) {
      if (isTableDelimiterLine(content)) {
        delimiterLine = number;
        headerLine = Math.max(first.number, number - 1);
        endLine = number;
      }
    } else {
      if (!isTableContentLine(content)) break;
      endLine = number;
    }
  }
  return { from: state.doc.line(headerLine).from, to: state.doc.line(endLine).to,
    startLine: headerLine, endLine, delimiterLine };
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
    state,
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
    state,
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
  state: EditorState,
  data: BuiltTableData,
  stickyHeaderAdapterFactory: TableStickyHeaderAdapterFactory | null,
  tableCommandEnvironment: TableCommandEnvironment | null,
  diagnostics: EditorDiagnostic[] = [],
  diffLineFlags: readonly (TableDiffFlags | undefined)[] | null | undefined = null
) {
  const tableData = buildWidgetTableData(state, data, diagnostics, diffLineFlags);
  if (!tableData) return;
  if (!stickyHeaderAdapterFactory) {
    throw new Error('Table Sticky Header Adapter factory is not configured');
  }
  if (!tableCommandEnvironment) {
    throw new Error('Table Command environment is not configured');
  }

  builder.push(
    Decoration.replace({
      block: true,
      meoTable: true,
      widget: new HtmlTableWidget(
        tableData,
        stickyHeaderAdapterFactory,
        tableCommandEnvironment
      )
    }).range(tableData.from, tableData.to)
  );
}

function buildSourceTableHeaderDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const tree = currentSyntaxTree(state);
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
    if (!transaction.docChanged && !syntaxTreeChanged(transaction)) {
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

/** Reuses the mounted table's command target, pending-cell commit and selection owner. */
export function requestMountedTableShortcut(view: EditorView, command: EditorCommandId, skipIfDisabled: boolean) {
  const active = view.dom.ownerDocument.activeElement;
  const shell = active instanceof Element ? active.closest<HTMLElement>('.meo-md-html-table-shell') : null;
  const owner = shell ? tableDomOwners.get(shell) : null;
  if (!owner || !shell) return null;
  const mapped = tableShortcutCommands[command]; if (!mapped) return null;
  owner.updateContextMenuState();
  const control = shell.querySelector<HTMLButtonElement>(`[data-command='${mapped}']`);
  const enabled = !!control && !control.disabled;
  if (skipIfDisabled && !enabled) return false;
  const target = owner.currentCommandTarget();
  if (command === 'rowBelow' && active instanceof HTMLTextAreaElement) {
    return owner.requestTableCommand(mapped, enabled, { ...target, insertedRowFocus: 'current-column' });
  }
  return owner.requestTableCommand(mapped, enabled, target);
}
export function mountedTableClipboardText(view: EditorView, format: 'markdown' | 'csv'): string | null {
  const active = view.dom.ownerDocument.activeElement;
  const shell = active instanceof Element ? active.closest<HTMLElement>('.meo-md-html-table-shell') : null;
  const owner = shell ? tableDomOwners.get(shell) : null;
  if (!owner?.domRefs) return null;
  const selection = owner.cellSelection.snapshot().range;
  const matrix = owner.readCellMatrix();
  const cells = [matrix.headerCells, ...matrix.rows];
  const selected = selection ? cells.slice(selection.fromRow, selection.toRow + 1).map(row => row.slice(selection.fromCol, selection.toCol + 1)) : cells;
  return format === 'csv' ? serializeDelimitedTable(selected, ',') : markdownTableFromCells(selected, true);
}

/** Read the existing rectangular selection without committing cell drafts or changing focus. */
export function mountedTableStatisticsSelection(view: EditorView): { ranges: TableCellRange[]; head: number } | null {
  const active = view.dom.ownerDocument.activeElement;
  const shell = active instanceof Element ? active.closest<HTMLElement>('.meo-md-html-table-shell') : null;
  const owner = shell && view.dom.contains(shell) ? tableDomOwners.get(shell) : null;
  const state = owner?.cellSelection.snapshot();
  const selection = state?.range;
  if (!owner || !selection || !state || state.phase !== 'dragging' && state.phase !== 'persisted') return null;
  const ranges: TableCellRange[] = [];
  for (let row = selection.fromRow; row <= selection.toRow; row++) {
    for (let column = selection.fromCol; column <= selection.toCol; column++) {
      const range = owner.cellSourceRange(row, column);
      if (range) ranges.push(range);
    }
  }
  const headRow = state.anchor?.row === selection.fromRow ? selection.toRow : selection.fromRow;
  const headCol = state.anchor?.col === selection.fromCol ? selection.toCol : selection.fromCol;
  const head = owner.cellSourceRange(headRow, headCol)?.to ?? ranges[0]?.from;
  return head === undefined ? null : { ranges, head };
}

/** Explicit/rebound cell-break commands share the native cell input and commit path. */
export function insertMountedTableCellBreak(view: EditorView): boolean {
  const input = document.activeElement;
  if (!(input instanceof HTMLTextAreaElement) || !view.dom.contains(input)) return false;
  insertTableCellEditorBreak(input, view.state);
  return true;
}
