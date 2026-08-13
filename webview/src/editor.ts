import { EditorState, Compartment, Prec, Transaction, StateEffect, StateField, RangeSetBuilder, type ChangeSpec, type EditorSelection, type Extension, type SelectionRange, type Text } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, lineNumbers, highlightActiveLineGutter, Decoration, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { defaultKeymap, history, historyKeymap, indentMore, indentLess, redo, redoDepth, undo, undoDepth } from '@codemirror/commands';
import { markdown, markdownKeymap, markdownLanguage } from '@codemirror/lang-markdown';
import { indentUnit, syntaxHighlighting, syntaxTree, forceParsing } from '@codemirror/language';
import { sourceHighlightStyle } from './theme';
import { shikiCodeHighlight } from './helpers/shikiDecorations';
import { liveModeExtensions, preserveLiveDecorationsForSearchEffect, refreshLiveDecorationsAfterSearchEffect, setLiveDocumentIdleEffect, setLivePointerSelectionActiveEffect, setLongCodeBlockSearchRevealEffect } from './liveMode';
import { detailsBlockStateExtensions } from './helpers/detailsBlocks';
import { resolveCodeLanguage, insertCodeBlock, sourceCodeBlockField } from './helpers/codeBlocks';
import { sourceStrikeMarkerField } from './helpers/strikeMarkers';
import { highlightMarkdownExtension, sourceHighlightField } from './helpers/highlightSyntax';
import { sourceWikiMarkerField } from './helpers/wikiLinks';
import { sourceFileLinkField } from './helpers/sourceRawLinks';
import { sourceUrlBoundaryField } from './helpers/sourceUrlBoundaries';
import { sourceFootnoteMarkerField } from './helpers/sourceFootnotes';
import { markdownTagField } from './helpers/tags';
import { findDocumentFragmentPosition, getLinkHrefAtPointer, isPrimaryModifierPointerClick } from './helpers/linkNavigation';
import {
  gitDiffGutterBaselineExtensions,
  gitDiffGutterLiveRenderExtensions,
  gitDiffGutterRenderExtensions,
  setGitBaselineEffect
} from './helpers/gitDiffGutter';
import { gitDiffLineHighlightsField } from './helpers/gitDiffLineHighlights';
import { createTableTransactionProvenance } from './application/tableTransactionProvenance';
import { createCodeMirrorTableTransactionProvenanceAdapter } from './adapters/codeMirrorTableTransactionProvenanceAdapter';
import { createCodeMirrorDomTableColumnWidthAdapter } from './editor/tableColumnWidthAdapter';
import { tableColumnWidthPolicy } from './editor/tableColumnWidthPolicy';
import { createCodeMirrorDomTableStickyHeaderAdapter } from './editor/internal/codeMirrorDomTableStickyHeaderAdapter';
import { tableStickyHeaderPolicy } from './editor/tableStickyHeaderPolicy';
import {
  tableStickyHeaderAdapterFactoryFacet,
  type TableStickyHeaderAdapterFactory
} from './editor/tableStickyHeaderAdapter';
import { createTableCommandApplication } from './application/tableCommand';
import { createTableCommandRuntime } from './adapters/tableCommandRuntime';
import { createCodeMirrorTableCommandEffectAdapter } from './editor/internal/codeMirrorTableCommandEffectAdapter';
import {
  tableCommandEnvironmentFacet,
  type TableCommandEnvironment
} from './editor/tableCommandAdapter';
import { createTableCommandTargetRegistry } from './editor/tableCommandTargetRegistry';
import { createGitDiffOverviewRulerController } from './helpers/gitDiffOverviewRuler';
import { createSearchOverviewRulerController } from './helpers/searchOverviewRuler';
import { createGitDiffContentHoverController } from './helpers/gitDeletionHover';
import { mergeConflictSourceExtensions } from './helpers/mergeConflicts';
import { resolvedSyntaxTree, extractHeadings } from './helpers/markdownSyntax';
import {
  sourceListMarkerField,
  listMarkerData,
  handleArrowLeftAtListContentStart,
  handleArrowRightAtListLineStart,
  handleBackspaceAtListContentStart,
  handleEnterAtListContentStart,
  handleEnterOnEmptyListItem,
  handleEnterContinueList,
  handleEnterBeforeNestedList,
  collectOrderedListRenumberChanges,
  indentListByTwoSpaces,
  outdentListByTwoSpaces
} from './helpers/listMarkers';
import {
  insertTable,
  sourceTableHeaderLineField,
  refreshTableLocalLinkIndicators,
  tableCellEditorOffsetToSourceOffset,
  tableHeaderAlignmentOverrideField,
  commitPendingTableEdits,
  focusHistoryChange,
  focusTableHistoryChange
} from './helpers/tables';
import { parseFrontmatter, sourceFrontmatterField } from './helpers/frontmatter';
import { collectLatexMathRanges } from './helpers/math';
import { diagnosticDataField, diagnosticField, setDiagnosticsEffect, type EditorDiagnostic } from './helpers/diagnostics';
import type { GitBaselinePayload } from '../../src/protocol/git';
import type { SelectionMenuState } from './helpers/selectionMenu';
import { focusMermaidEditingOffset, getMermaidBlockMode, setMermaidBlockModeEffect, setMermaidSearchRevealEffect } from './helpers/mermaidEditing';
import { focusLatexMathEditingOffset, getLatexMathBlockMode, setLatexMathBlockModeEffect, setLatexMathSearchRevealEffect } from './helpers/latexMathEditing';
import { getLiveRenderedBlocks } from './helpers/liveRenderedBlocks';
import { setLongCodeBlockFoldingEnabled } from './helpers/longCodeBlocks';
import { ViewportController } from './helpers/viewportController';
import { collectRenderableHtmlBlocks, setHtmlEditingRangeEffect } from './helpers/htmlContent';
import { setEditorHistoryRunner, type EditorHistoryDirection } from './helpers/historyCommands';
import { createEditorHistoryApplication, type EditorHistoryContext, type EditorHistoryViewport } from './application/editorHistory';
import { createEditorHistoryEffectAdapter, type EditorHistoryRestoreRequest } from './adapters/editorHistoryEffectAdapter';
import { createEditorHistoryRuntime, type EditorHistoryRuntime } from './adapters/editorHistoryRuntime';
import { resolveConfiguredImageSrc } from './helpers/images';
import {
  createImagePresentationFactory,
  createImagePresentationResourcePool,
  loadBrowserImage
} from './editor/imagePresentationAdapter';
import { imagePresentationFactoryFacet } from './editor/imagePresentation';
import {
  mermaidDiagramPresentationFactoryFacet,
  type MermaidDiagramPresentationFactory
} from './editor/mermaidDiagramPresentation';

declare module '@codemirror/view' {
  interface EditorView {
    EDIT_CONTEXT?: boolean;
  }
}

type SearchOptions = {
  wholeWord?: boolean;
  caseSensitive?: boolean;
};

type SearchQueryState = {
  text: string;
  wholeWord: boolean;
  caseSensitive: boolean;
};

type SearchMatchRange = {
  start: number;
  end: number;
};

type SearchMatchFieldValue = {
  matches: SearchMatchRange[];
  decorations: DecorationSet;
};

type InlineSelectionRange = {
  from: number;
  to: number;
  anchor: number;
  head: number;
  empty: boolean;
};

type MarkerReplacementContext = {
  contentStart: number;
  oldMarkerLen: number;
  isExistingTask: boolean;
};

type EditableEditorMode = 'source' | 'live';

type CreateEditorOptions = {
  parent: HTMLElement;
  text: string;
  onApplyChanges: (text: string) => void;
  onOpenLink?: (href: string) => void;
  onSelectionChange?: (state: SelectionMenuState & { from?: number; to?: number }) => void;
  onViewportChange?: () => void;
  initialMode?: EditableEditorMode;
  initialTopLine?: number | null;
  initialTopLineOffset?: number;
  initialLineNumbers?: boolean;
  initialGitGutter?: boolean;
  initialDiagnostics?: readonly EditorDiagnostic[];
  mermaidDiagramPresentationFactory: MermaidDiagramPresentationFactory;
};

type PointerClickState = { pointerId: number };
type InlineCodeClickState = PointerClickState & { inInlineCode: boolean };
type FrontmatterBoundaryClickState = PointerClickState & { cursorEnd: number };
type PointerPosition = { x: number; y: number };
type TableTextTransform = (value: string, start: number, end: number) => boolean;
type TableFormatAction = 'inlineCode' | 'kbd' | 'underline' | 'bold' | 'italic' | 'lineover' | 'strike' | 'highlight' | 'link' | 'wikiLink';
type SyncChange = { from: number; to: number; insert: string };
type RevealOptions = { focusEditor?: boolean; align?: 'center' | 'upper' | 'top' | 'nearest' | 'none' };
type EditorFormatAction = TableFormatAction | 'heading' | 'bulletList' | 'numberedList' | 'task' | 'codeBlock' | 'quote' | 'hr' | 'table' | 'image';
type EditorFormatLevel = number | { cols: number; rows: number };

const setSearchQueryEffect = StateEffect.define<SearchQueryState>();
const refreshDecorationsEffect = StateEffect.define();
const searchMatchStyle = 'color: var(--meo-semantic-searchMatchForeground) !important; -webkit-text-fill-color: var(--meo-semantic-searchMatchForeground) !important;';
const activeSearchMatchStyle = 'color: var(--meo-semantic-searchMatchActiveForeground) !important; -webkit-text-fill-color: var(--meo-semantic-searchMatchActiveForeground) !important;';
const searchMatchMark = Decoration.mark({ class: 'meo-search-match', attributes: { style: searchMatchStyle } });
const activeSearchMatchMark = Decoration.mark({ class: 'meo-search-match meo-search-match-active', attributes: { style: activeSearchMatchStyle } });
const tableSearchStateEventName = 'meo-search-state-change';
const existingListMarkerRegex = /^(\s*)([-+*]\s+\[[ xX~\-]\]|[-+*]|\d+[.)])\s+/;
const existingHeadingMarkerRegex = /^(\s*)(#{1,6})\s+/;
const existingTaskMarkerRegex = /^[-+*]\s+\[[ xX~\-]\]/;
const blockquoteLinePrefixRegex = /^[ \t]{0,3}(?:>[ \t]?)+/;
const quotedCodeBlockAncestorNames = new Set(['FencedCode', 'CodeBlock']);

const buildSearchDecorations = (state: EditorState, matches: SearchMatchRange[]) => {
  if (!matches.length) {
    return Decoration.none;
  }

  const builder = new RangeSetBuilder<Decoration>();
  const selection = state.selection.main;
  const selectionFrom = Math.min(selection.from, selection.to);
  const selectionTo = Math.max(selection.from, selection.to);
  for (const match of matches) {
    const mark = match.start === selectionFrom && match.end === selectionTo
      ? activeSearchMatchMark
      : searchMatchMark;
    builder.add(match.start, match.end, mark);
  }
  return builder.finish();
};

const searchQueryField = StateField.define({
  create() {
    return createSearchQueryState('');
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setSearchQueryEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

const searchMatchField = StateField.define<SearchMatchFieldValue>({
  create() {
    return { matches: [], decorations: Decoration.none };
  },
  update(value, tr: Transaction) {
    let changedQuery: SearchQueryState | null = null;
    for (const effect of tr.effects) {
      if (effect.is(setSearchQueryEffect)) {
        changedQuery = effect.value;
        break;
      }
    }

    if (tr.docChanged || changedQuery) {
      const searchQuery = changedQuery ?? tr.state.field(searchQueryField);
      const matches = searchQuery.text
        ? findSearchMatchRanges(tr.state.doc.toString(), searchQuery.text, searchQuery)
        : [];
      return {
        matches,
        decorations: buildSearchDecorations(tr.state, matches)
      };
    }

    if (tr.selection) {
      return {
        matches: value.matches,
        decorations: buildSearchDecorations(tr.state, value.matches)
      };
    }

    return value;
  },
  provide(field) {
    return EditorView.decorations.from(field, (value) => value.decorations);
  }
});

export function createEditor({
  parent,
  text,
  onApplyChanges,
  onOpenLink,
  onSelectionChange,
  onViewportChange,
  initialMode = 'source',
  initialTopLine = null,
  initialTopLineOffset = 0,
  initialLineNumbers = true,
  initialGitGutter = true,
  initialDiagnostics = [],
  mermaidDiagramPresentationFactory
}: CreateEditorOptions) {
  // VS Code webviews can hit cross-origin window access issues in the EditContext path.
  // Disable it explicitly for stability in embedded Chromium.
  const editorViewConstructor: typeof EditorView & { EDIT_CONTEXT?: boolean } = EditorView;
  editorViewConstructor.EDIT_CONTEXT = false;
  if (!mermaidDiagramPresentationFactory) {
    throw new Error('Mermaid diagram presentation factory is required');
  }

  const modeCompartment = new Compartment();
  const gitGutterCompartment = new Compartment();
  const startMode = initialMode === 'live' ? 'live' : 'source';
  let lineNumbersVisible = initialLineNumbers !== false;
  let gitGutterVisible = initialGitGutter !== false;
  let currentDiagnostics: EditorDiagnostic[] = Array.isArray(initialDiagnostics) ? initialDiagnostics : [];
  let applyingExternal = false;
  let imeCompositionActive = false;
  let imeCompositionChanged = false;
  let imeCompositionFlushTimer: number | null = null;
  let capturedPointerId: number | null = null;
  let liveSelectionPointerId: number | null = null;
  let liveSelectionGeneration = 0;
  let inlineCodeClick: InlineCodeClickState | null = null;
  let checkboxClick: PointerClickState | null = null;
  let frontmatterBoundaryClick: FrontmatterBoundaryClickState | null = null;
  let view: EditorView;
  let currentMode: EditableEditorMode = startMode;
  let applyingRenumber = false;
  let lastSearchStateSignature = '';
  let tableInteractionActive = false;
  let tableInteractionOwner: HTMLElement | null = null;
  let tableInteractionClassFrame = 0;
  let onTableInteraction: EventListener | null = null;
  let onWidgetOpenLink: EventListener | null = null;
  let onWidgetActivateImage: EventListener | null = null;
  let onTableSelectionChange: EventListener | null = null;
  let onScroll: (() => void) | null = null;
  let viewportController: ViewportController;
  let onWindowPointerUp: ((event: PointerEvent) => void) | null = null;
  let onWindowPointerCancel: ((event: PointerEvent) => void) | null = null;
  let onWindowBlur: (() => void) | null = null;
  let onDocumentSelectionChange: (() => void) | null = null;
  let onHtmlContentPointerDown: ((event: PointerEvent) => void) | null = null;
  let suppressSelectionMenuForNativeHtml = false;
  let onBlockActionPointerMove: ((event: PointerEvent) => void) | null = null;
  let onBlockActionPointerLeave: (() => void) | null = null;
  let editorHistoryRuntime: EditorHistoryRuntime | null = null;
  let historyScrollGuard: EditorHistoryViewport | null = null;
  let pendingRenderedHistoryFocus: { replayId: number; run: () => boolean } | null = null;
  let recentRenderedReplayPresentation: { anchor: number; mode: 'preview' | 'split' | 'source' } | null = null;
  let onHistoryKeyDown: ((event: KeyboardEvent) => void) | null = null;
  let onHistoryBeforeInput: ((event: InputEvent) => void) | null = null;
  let onHistoryPointerDown: (() => void) | null = null;
  let onHistoryBlur: ((event: FocusEvent) => void) | null = null;
  let blockActionToolbarReconcileFrame: number | null = null;
  let pendingLiveSearchRevealFrame: number | null = null;
  let pendingLiveSearchRevealGeneration = 0;
  let pendingLiveSearchDecorationRefreshFrame: number | null = null;
  let pendingLiveSearchDecorationRefreshGeneration = 0;
  let gitDiffContentHover: ReturnType<typeof createGitDiffContentHoverController> | null = null;
  let gitDiffOverviewRuler: ReturnType<typeof createGitDiffOverviewRulerController> | null = null;
  let searchOverviewRuler: ReturnType<typeof createSearchOverviewRulerController> | null = null;
  let editableLinkHoverPointerActive = false;
  let editableLinkHoverPosition: PointerPosition | null = null;
  let editableLinkHoverMode = currentMode;
  let hoveredBlockActionToolbar: HTMLElement | null = null;
  let hoveredBlockActionRange: { from: number; to: number } | null = null;
  const publishComposedDocumentChange = () => {
    if (!view || applyingExternal || applyingRenumber) {
      return;
    }
    const renumberChanges = collectOrderedListRenumberChanges(view.state);
    if (renumberChanges.length) {
      applyingRenumber = true;
      try {
        view.dispatch({
          changes: renumberChanges,
          annotations: Transaction.addToHistory.of(false)
        });
      } finally {
        applyingRenumber = false;
      }
    }
    onApplyChanges(view.state.doc.toString());
  };
  const scheduleImeCompositionFlush = () => {
    if (imeCompositionFlushTimer !== null) {
      window.clearTimeout(imeCompositionFlushTimer);
    }
    imeCompositionFlushTimer = window.setTimeout(() => {
      imeCompositionFlushTimer = null;
      if (!imeCompositionChanged || imeCompositionActive) {
        return;
      }
      imeCompositionChanged = false;
      publishComposedDocumentChange();
    }, 20);
  };
  const getLineStartOffset = (docText: string, targetLineNumber: number) => {
    const targetLine = Math.max(1, Math.floor(targetLineNumber));
    if (targetLine === 1) {
      return 0;
    }
    let line = 1;
    for (let index = 0; index < docText.length; index += 1) {
      if (docText.charCodeAt(index) !== 10) {
        continue;
      }
      line += 1;
      if (line === targetLine) {
        return index + 1;
      }
    }
    return docText.length;
  };
  const initialCursorPos = (() => {
    if (typeof initialTopLine === 'number' && Number.isFinite(initialTopLine)) {
      return getLineStartOffset(text ?? '', initialTopLine);
    }
    if (!text) {
      return 0;
    }
    const firstLineEnd = text.indexOf('\n');
    return firstLineEnd === -1 ? text.length : firstLineEnd;
  })();
  const targetElementFrom = (target: EventTarget | null) => (
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null
  );
  const blockActionToolbarSelector = [
    '.meo-code-block-actions',
    '.meo-mermaid-toolbar',
    '.meo-latex-math-toolbar'
  ].join(', ');
  const readBlockActionToolbarRange = (toolbar: HTMLElement) => {
    const from = Number.parseInt(toolbar.dataset.meoBlockFrom ?? '', 10);
    const to = Number.parseInt(toolbar.dataset.meoBlockTo ?? '', 10);
    return Number.isFinite(from) && Number.isFinite(to) ? { from, to } : null;
  };
  const setHoveredBlockActionToolbar = (toolbar: HTMLElement | null) => {
    if (hoveredBlockActionToolbar === toolbar) {
      return;
    }
    hoveredBlockActionToolbar?.classList.remove('is-block-hovered');
    hoveredBlockActionToolbar = toolbar;
    hoveredBlockActionRange = toolbar ? readBlockActionToolbarRange(toolbar) : null;
    hoveredBlockActionToolbar?.classList.add('is-block-hovered');
  };
  const scheduleBlockActionToolbarReconcile = () => {
    if (blockActionToolbarReconcileFrame !== null || !hoveredBlockActionRange) return;
    blockActionToolbarReconcileFrame = window.requestAnimationFrame(() => {
      blockActionToolbarReconcileFrame = null;
      if (!hoveredBlockActionRange || hoveredBlockActionToolbar?.isConnected) return;
      const expectedRange = hoveredBlockActionRange;
      const replacement = Array.from(
        view.dom.querySelectorAll(blockActionToolbarSelector)
      ).find((toolbar) => {
        if (!(toolbar instanceof HTMLElement)) return false;
        const range = readBlockActionToolbarRange(toolbar);
        return range?.from === expectedRange.from && range.to === expectedRange.to;
      });
      hoveredBlockActionToolbar = replacement instanceof HTMLElement ? replacement : null;
      hoveredBlockActionToolbar?.classList.add('is-block-hovered');
    });
  };
  const updateBlockActionToolbarHover = (event: PointerEvent, editorView: EditorView) => {
    const targetElement = targetElementFrom(event.target);
    const directToolbar = targetElement?.closest(blockActionToolbarSelector);
    if (directToolbar instanceof HTMLElement) {
      setHoveredBlockActionToolbar(directToolbar);
      return;
    }

    const position = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) {
      setHoveredBlockActionToolbar(null);
      return;
    }

    const matchingToolbar = Array.from(
      editorView.dom.querySelectorAll(blockActionToolbarSelector)
    ).find((toolbar): toolbar is HTMLElement => {
      if (!(toolbar instanceof HTMLElement)) {
        return false;
      }
      const blockFrom = Number.parseInt(toolbar.dataset.meoBlockFrom ?? '', 10);
      const blockTo = Number.parseInt(toolbar.dataset.meoBlockTo ?? '', 10);
      return Number.isFinite(blockFrom) && Number.isFinite(blockTo) &&
        position >= blockFrom && position <= blockTo;
    }) ?? null;
    setHoveredBlockActionToolbar(matchingToolbar);
  };
  const openHref = (href: string, editorView: EditorView) => {
    if (href.startsWith('#')) {
      const initialTargetPosition = findDocumentFragmentPosition(editorView.state, href);
      if (initialTargetPosition !== null) {
        // Focusing can commit an active table cell and rebuild layout. Complete
        // that transition before resolving and scrolling to the fragment.
        editorView.focus();
        const targetPosition = findDocumentFragmentPosition(editorView.state, href);
        if (targetPosition === null) return true;
        viewportController?.markInteraction();
        editorView.dispatch({
          selection: { anchor: targetPosition },
          effects: EditorView.scrollIntoView(targetPosition, { y: 'start' })
        });
      }
      return true;
    }
    onOpenLink?.(href);
    return true;
  };
  const openLinkIfModifierClick = (event: PointerEvent, editorView: EditorView) => {
    if (!isPrimaryModifierPointerClick(event)) {
      return false;
    }
    const href = getLinkHrefAtPointer(event, editorView);
    if (!href) {
      return false;
    }
    event.preventDefault();
    event.stopPropagation();
    return openHref(href, editorView);
  };
  const setEditableLinkHoverCursor = (editorView: EditorView, active: boolean) => {
    if (editableLinkHoverPointerActive === active) {
      return;
    }
    editableLinkHoverPointerActive = active;
    const cursor = active ? 'pointer' : '';
    editorView.dom.style.cursor = cursor;
    editorView.contentDOM.style.cursor = cursor;
    editorView.dom.classList.toggle('meo-link-modifier-hover', active);
  };
  const isEditableLinkTarget = (target: EventTarget | null, editorView: EditorView) => {
    if (!(target instanceof Node)) return false;
    if (currentMode === 'source') return editorView.contentDOM.contains(target);
    const targetElement = targetElementFrom(target);
    return currentMode === 'live' && Boolean(targetElement?.closest('.cm-activeLine'));
  };
  const updateEditableLinkHoverCursor = (event: PointerEvent, editorView: EditorView) => {
    const target = event.target;
    if (!isEditableLinkTarget(target, editorView)) {
      editableLinkHoverPosition = null;
      setEditableLinkHoverCursor(editorView, false);
      return;
    }
    editableLinkHoverPosition = { x: event.clientX, y: event.clientY };
    const href = isPrimaryModifierPointerClick(event)
      ? getLinkHrefAtPointer(event, editorView, { exactTextHit: true })
      : '';
    setEditableLinkHoverCursor(editorView, Boolean(href));
  };
  const updateEditableLinkHoverCursorForModifier = (event: KeyboardEvent, editorView: EditorView) => {
    if (!editableLinkHoverPosition) {
      setEditableLinkHoverCursor(editorView, false);
      return;
    }
    const target = document.elementFromPoint(editableLinkHoverPosition.x, editableLinkHoverPosition.y);
    if (!isEditableLinkTarget(target, editorView)) {
      setEditableLinkHoverCursor(editorView, false);
      return;
    }
    const pointerEvent = {
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      clientX: editableLinkHoverPosition.x,
      clientY: editableLinkHoverPosition.y,
      target
    };
    const href = isPrimaryModifierPointerClick(pointerEvent)
      ? getLinkHrefAtPointer(pointerEvent, editorView, { exactTextHit: true })
      : '';
    setEditableLinkHoverCursor(editorView, Boolean(href));
  };
  const isLiveMode = (editorView: EditorView) => editorView.dom.classList.contains('meo-mode-live');
  const isPlainPrimaryPointerEvent = (event: PointerEvent) => (
    event.button === 0 && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey
  );
  const frontmatterBoundaryCursorEnd = (state: EditorState, pos: number) => {
    const frontmatter = parseFrontmatter(state);
    if (!frontmatter) {
      return null;
    }
    const line = state.doc.lineAt(pos);
    const openingLineNo = state.doc.lineAt(frontmatter.openingFrom).number;
    const closingLineNo = state.doc.lineAt(frontmatter.closingFrom).number;
    if (line.number !== openingLineNo && line.number !== closingLineNo) {
      return null;
    }
    const lineText = state.doc.sliceString(line.from, line.to);
    const markerStart = lineText.indexOf('---');
    return markerStart >= 0 ? line.from + markerStart + 3 : null;
  };
  const emptyBlockquoteLineCursorEnd = (state: EditorState, pos: number) => {
    const line = state.doc.lineAt(pos);
    const lineText = state.doc.sliceString(line.from, line.to);
    const quoteMatch = /^[ \t]{0,3}(?:>[ \t]?)+$/.exec(lineText);
    if (!quoteMatch) {
      return null;
    }

    const probePos = Math.min(line.to, line.from + 1);
    let node = resolvedSyntaxTree(state).resolveInner(probePos, 1);
    while (node) {
      if (node.name === 'Blockquote') {
        return line.from + quoteMatch[0].length;
      }
      node = node.parent;
    }

    return null;
  };
  const trackFrontmatterBoundaryClick = (event: PointerEvent, editorView: EditorView) => {
    frontmatterBoundaryClick = null;
    if (!isLiveMode(editorView) || !isPlainPrimaryPointerEvent(event)) {
      return;
    }
    const clickedPos = editorView.posAtCoords({ x: event.clientX, y: event.clientY });
    if (clickedPos === null) {
      return;
    }
    const cursorEnd = frontmatterBoundaryCursorEnd(editorView.state, clickedPos);
    if (cursorEnd === null) {
      return;
    }
    frontmatterBoundaryClick = {
      pointerId: event.pointerId,
      cursorEnd
    };
  };

  const setTableInteractionActive = (active: boolean, owner: HTMLElement | null = null) => {
    if (!view) return;

    if (active) {
      const wasActive = tableInteractionActive;
      tableInteractionActive = true;
      tableInteractionOwner = owner;
      if (!wasActive && currentMode === 'live') {
        view.dispatch({ effects: setLiveDocumentIdleEffect.of(true) });
      }
      view.dom.classList.add('meo-table-interaction-active');
      if (tableInteractionClassFrame) {
        cancelAnimationFrame(tableInteractionClassFrame);
      }
      tableInteractionClassFrame = requestAnimationFrame(() => {
        tableInteractionClassFrame = 0;
        if (view && tableInteractionActive && tableInteractionOwner === owner) {
          view.dom.classList.add('meo-table-interaction-active');
        }
      });
      return;
    }

    if (!tableInteractionActive || (owner && tableInteractionOwner && owner !== tableInteractionOwner)) {
      return;
    }

    tableInteractionActive = false;
    tableInteractionOwner = null;
    if (tableInteractionClassFrame) {
      cancelAnimationFrame(tableInteractionClassFrame);
      tableInteractionClassFrame = 0;
    }
    if (currentMode === 'live') {
      view.dispatch({ effects: setLiveDocumentIdleEffect.of(false) });
    }
    view.dom.classList.remove('meo-table-interaction-active');
  };
  const tableEntryCellSelector = 'th[data-table-row][data-table-col], td[data-table-row][data-table-col]';
  const tableEntryProbeOffsetsY = [1, 4, 8, 12, 18];
  const focusTableEntryInput = (input: Element | null) => {
    if (!(input instanceof HTMLTextAreaElement)) {
      return false;
    }
    input.focus({ preventScroll: true });
    const caret = input.value.length;
    input.setSelectionRange(caret, caret);
    input.closest(tableEntryCellSelector)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    return true;
  };
  const findTableEntryInput = (wrap: HTMLElement, hit: Element, direction: 'up' | 'down') => {
    const cell = hit.closest(tableEntryCellSelector);
    if (cell instanceof HTMLElement && wrap.contains(cell)) {
      const cellInput = cell.querySelector('textarea');
      if (cellInput instanceof HTMLTextAreaElement) {
        return cellInput;
      }
    }

    if (direction === 'down') {
      const first = wrap.querySelector('textarea');
      return first instanceof HTMLTextAreaElement ? first : null;
    }

    const inputs = wrap.querySelectorAll('textarea');
    const last = inputs.length ? inputs[inputs.length - 1] : null;
    return last instanceof HTMLTextAreaElement ? last : null;
  };

  const tryEnterAdjacentTable = (editorView: EditorView, direction: 'up' | 'down') => {
    if ((direction !== 'down' && direction !== 'up') || currentMode !== 'live' || tableInteractionActive) {
      return false;
    }

    const selection = editorView.state.selection.main;
    if (!selection.empty) {
      return false;
    }

    const caretRect = editorView.coordsAtPos(selection.head);
    if (!caretRect) {
      return false;
    }

    const contentRect = editorView.contentDOM.getBoundingClientRect();
    if (!contentRect || contentRect.width <= 0 || contentRect.height <= 0) {
      return false;
    }

    const clampX = (x: number) => Math.min(Math.max(x, contentRect.left + 1), contentRect.right - 1);
    const probeXs = [
      clampX(caretRect.left + 1),
      clampX(contentRect.left + Math.min(24, Math.max(8, contentRect.width * 0.05)))
    ];

    for (const offsetY of tableEntryProbeOffsetsY) {
      const y = direction === 'down'
        ? caretRect.bottom + offsetY
        : caretRect.top - offsetY;
      if (y < 0 || y >= window.innerHeight) {
        if (direction === 'down' && y >= window.innerHeight) break;
        continue;
      }
      for (const x of probeXs) {
        const hit = document.elementFromPoint(x, y);
        if (!(hit instanceof Element)) {
          continue;
        }
        const wrap = hit.closest('.meo-md-html-table-wrap');
        if (!(wrap instanceof HTMLElement) || !editorView.dom.contains(wrap)) {
          continue;
        }
        const input = findTableEntryInput(wrap, hit, direction);
        if (!focusTableEntryInput(input)) {
          continue;
        }
        return true;
      }
    }

    return false;
  };

  const syncModeClasses = () => {
    if (!view) {
      return;
    }
    const isLiveModeActive = currentMode === 'live';
    view.dom.classList.toggle('meo-mode-live', currentMode === 'live');
    view.dom.classList.toggle('meo-mode-source', currentMode !== 'live');
    // Keep active typography vars explicitly synced to mode so source/live
    // font sizing and line-height don't depend on selector cascade.
    view.dom.style.setProperty('--meo-active-editor-font', isLiveModeActive ? 'var(--meo-font-live)' : 'var(--meo-font-source)');
    view.dom.style.setProperty('--meo-active-editor-font-weight', isLiveModeActive ? 'var(--meo-font-live-weight)' : 'var(--meo-font-source-weight)');
    view.dom.style.setProperty('--meo-active-editor-font-size', isLiveModeActive ? 'var(--meo-font-live-size)' : 'var(--meo-font-source-size)');
    view.dom.style.setProperty('--meo-active-editor-line-height', isLiveModeActive ? 'var(--meo-line-height-live)' : 'var(--meo-line-height-source)');
    if (editableLinkHoverMode !== currentMode) {
      editableLinkHoverMode = currentMode;
      editableLinkHoverPosition = null;
      setEditableLinkHoverCursor(view, false);
    }
  };

  const syncLineNumbersVisibility = () => {
    if (!view) {
      return;
    }
    view.dom.classList.toggle('meo-line-numbers-hidden', !lineNumbersVisible);
  };

  const syncGitGutterVisibility = () => {
    if (!view) {
      return;
    }
    const shouldShowGitGutter = gitGutterVisible;
    view.dom.classList.toggle('meo-git-gutter-hidden', !shouldShowGitGutter);
    gitDiffOverviewRuler?.refresh();
  };

  const releasePointerCaptureIfHeld = (pointerId: number | null) => {
    if (!view || pointerId === null) {
      return;
    }
    if (view.dom.releasePointerCapture && view.dom.hasPointerCapture(pointerId)) {
      view.dom.releasePointerCapture(pointerId);
    }
  };

  const clearLivePointerSelection = () => {
    if (liveSelectionPointerId === null) {
      return;
    }
    liveSelectionPointerId = null;
    if (view && currentMode === 'live') {
      view.dom.classList.remove('meo-live-pointer-selecting');
      view.dom.style.cursor = '';
      view.dispatch({
        effects: setLivePointerSelectionActiveEffect.of({ active: false, preservedLine: null })
      });
    }
  };

  const finishLivePointerSelection = (pointerId: number, defer = false) => {
    if (liveSelectionPointerId === pointerId) {
      if (defer) {
        const generation = liveSelectionGeneration;
        requestAnimationFrame(() => {
          if (liveSelectionPointerId === pointerId && liveSelectionGeneration === generation) {
            clearLivePointerSelection();
          }
        });
      } else {
        clearLivePointerSelection();
      }
    }
  };

  const syncSelectionClass = () => {
    if (!view) {
      return;
    }
    const hasSelection = view.state.selection.ranges.some((range) => !range.empty);
    const hasSearchSelection = view.state.selection.ranges.some((range) =>
      isSearchMatchSelection(Math.min(range.from, range.to), Math.max(range.from, range.to))
    );
    view.dom.classList.toggle('has-selection', hasSelection);
    view.dom.classList.toggle('has-search-selection', hasSearchSelection);
  };

  const emitSearchStateChange = () => {
    if (!view) {
      return;
    }

    const searchQuery = view.state.field(searchQueryField);
    const selection = view.state.selection.main;
    const detail = {
      text: searchQuery.text,
      wholeWord: searchQuery.wholeWord,
      caseSensitive: searchQuery.caseSensitive,
      selectionFrom: Math.min(selection.from, selection.to),
      selectionTo: Math.max(selection.from, selection.to)
    };
    (view.dom as any).__meoSearchState = detail;
    const signature = JSON.stringify(detail);
    if (signature === lastSearchStateSignature) {
      return;
    }
    lastSearchStateSignature = signature;
    view.dom.dispatchEvent(new CustomEvent(tableSearchStateEventName, { detail }));
  };

  const getActiveTableInput = () => {
    if (!view) {
      return null;
    }
    const active = document.activeElement;
    if (!(active instanceof HTMLTextAreaElement)) {
      return null;
    }
    if (!view.dom.contains(active)) {
      return null;
    }
    return active.closest('.meo-md-html-table-wrap') ? active : null;
  };

  const getTableInputSourceRange = (input: HTMLTextAreaElement): { from: number; to: number } | null => {
    const from = Number.parseInt(input.dataset.tableCellFrom ?? '', 10);
    const to = Number.parseInt(input.dataset.tableCellTo ?? '', 10);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from) {
      return null;
    }
    return { from, to };
  };

  const getTableInputDocumentSelection = (
    input: HTMLTextAreaElement
  ): { from: number; to: number; anchorX: number; anchorY: number; anchorBottomY: number } | null => {
    const sourceRange = getTableInputSourceRange(input);
    if (!sourceRange) {
      return null;
    }
    const rawStart = input.selectionStart ?? 0;
    const rawEnd = input.selectionEnd ?? rawStart;
    if (rawStart === rawEnd) {
      return null;
    }
    const selectionStart = Math.min(rawStart, rawEnd);
    const selectionEnd = Math.max(rawStart, rawEnd);
    const coords = measureTextareaSelectionStart(input, selectionStart);
    const lineHeight = parseFloat(getComputedStyle(input).lineHeight);
    return {
      from: sourceRange.from + tableCellEditorOffsetToSourceOffset(input.value, selectionStart),
      to: sourceRange.from + tableCellEditorOffsetToSourceOffset(input.value, selectionEnd),
      anchorX: coords.left,
      anchorY: coords.top,
      anchorBottomY: coords.top + (Number.isFinite(lineHeight) ? lineHeight : 20)
    };
  };

  const commitActiveTableInput = () => {
    if (!view) {
      return false;
    }
    return commitPendingTableEdits(view);
  };

  const requestEditorHistoryReplay = async (direction: EditorHistoryDirection): Promise<boolean> => {
    const result = await editorHistoryRuntime?.dispatch({ type: 'requestReplay', direction });
    return result === true;
  };

  const editorHistoryKeymap = historyKeymap.map((binding) => ({
    ...binding,
    run: () => {
      const key = binding.key?.toLowerCase() ?? '';
      const direction = key.includes('y') || key.includes('shift-z') ? 'redo' : 'undo';
      void requestEditorHistoryReplay(direction);
      return true;
    }
  }));

  const measureTextareaSelectionStart = (input: HTMLTextAreaElement, index: number) => {
    const doc = input.ownerDocument;
    const mirror = doc.createElement('div');
    const marker = doc.createElement('span');
    const computed = window.getComputedStyle(input);

    mirror.style.position = 'fixed';
    mirror.style.left = '0';
    mirror.style.top = '0';
    mirror.style.visibility = 'hidden';
    mirror.style.pointerEvents = 'none';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.overflowWrap = 'break-word';
    mirror.style.wordBreak = 'break-word';
    mirror.style.boxSizing = computed.boxSizing;
    mirror.style.width = `${input.getBoundingClientRect().width}px`;
    mirror.style.minHeight = computed.height;
    mirror.style.padding = computed.padding;
    mirror.style.border = computed.border;
    mirror.style.font = computed.font;
    mirror.style.fontFamily = computed.fontFamily;
    mirror.style.fontSize = computed.fontSize;
    mirror.style.fontWeight = computed.fontWeight;
    mirror.style.fontStyle = computed.fontStyle;
    mirror.style.letterSpacing = computed.letterSpacing;
    mirror.style.lineHeight = computed.lineHeight;
    mirror.style.textTransform = computed.textTransform;
    mirror.style.textIndent = computed.textIndent;
    mirror.style.tabSize = computed.tabSize;

    mirror.textContent = input.value.slice(0, index);
    marker.textContent = '\u200b';
    mirror.appendChild(marker);
    doc.body.appendChild(mirror);

    const markerRect = marker.getBoundingClientRect();
    const mirrorRect = mirror.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const coords = {
      left: inputRect.left + (markerRect.left - mirrorRect.left),
      top: inputRect.top + (markerRect.top - mirrorRect.top)
    };

    mirror.remove();
    return coords;
  };

  const getActiveTableSelectionState = (input: HTMLTextAreaElement): (SelectionMenuState & { from: number; to: number }) | null => {
    const selection = getTableInputDocumentSelection(input);
    if (!selection) return null;
    return {
      visible: true,
      from: selection.from,
      to: selection.to,
      anchorX: selection.anchorX,
      anchorY: selection.anchorY,
      anchorBottomY: selection.anchorBottomY
    };
  };

  const updateActiveTableInput = (input: HTMLTextAreaElement, nextValue: string, anchor: number, head = anchor) => {
    input.value = nextValue;
    input.focus({ preventScroll: true });
    input.setSelectionRange(
      Math.min(anchor, head),
      Math.max(anchor, head),
      anchor <= head ? 'forward' : 'backward'
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
    emitSelectionChange();
    return true;
  };

  const editActiveTableInputWithSelection = (input: HTMLTextAreaElement, transform: TableTextTransform) => {
    const rawStart = input.selectionStart ?? 0;
    const rawEnd = input.selectionEnd ?? rawStart;
    const start = Math.min(rawStart, rawEnd);
    const end = Math.max(rawStart, rawEnd);
    return transform(input.value, start, end);
  };

  const trimTrailingNewlines = (value: string, start: number, end: number) => {
    let nextEnd = end;
    while (nextEnd > start && value.slice(nextEnd - 1, nextEnd) === '\n') {
      nextEnd -= 1;
    }
    return nextEnd;
  };

  const wrapActiveTableInputSelection = (
    input: HTMLTextAreaElement,
    openMarker: string,
    closeMarker = openMarker,
    { toggle = true, selectWrapped = true }: { toggle?: boolean; selectWrapped?: boolean } = {}
  ) => {
    return editActiveTableInputWithSelection(input, (value, start, end) => {
      if (start === end) {
        const insert = `${openMarker}${closeMarker}`;
        const nextValue = value.slice(0, start) + insert + value.slice(end);
        return updateActiveTableInput(input, nextValue, start + openMarker.length);
      }

      const trimmedEnd = trimTrailingNewlines(value, start, end);
      if (toggle) {
        const hasOpenMarker =
          start >= openMarker.length && value.slice(start - openMarker.length, start) === openMarker;
        const hasCloseMarker = value.slice(trimmedEnd, trimmedEnd + closeMarker.length) === closeMarker;
        if (hasOpenMarker && hasCloseMarker) {
          const nextValue =
            value.slice(0, start - openMarker.length) +
            value.slice(start, trimmedEnd) +
            value.slice(trimmedEnd + closeMarker.length);
          return updateActiveTableInput(
            input,
            nextValue,
            start - openMarker.length,
            trimmedEnd - openMarker.length
          );
        }
      }

      const nextValue =
        value.slice(0, start) +
        openMarker +
        value.slice(start, trimmedEnd) +
        closeMarker +
        value.slice(trimmedEnd);
      if (!selectWrapped) {
        const cursor = start + openMarker.length + (trimmedEnd - start) + closeMarker.length;
        return updateActiveTableInput(input, nextValue, cursor);
      }
      return updateActiveTableInput(input, nextValue, start + openMarker.length, trimmedEnd + openMarker.length);
    });
  };

  const insertFormatInActiveTableInput = (input: HTMLTextAreaElement, action: EditorFormatAction) => {
    switch (action) {
      case 'inlineCode':
        return wrapActiveTableInputSelection(input, '`', '`', { toggle: false, selectWrapped: false });
      case 'kbd':
        return wrapActiveTableInputSelection(input, '<kbd>', '</kbd>');
      case 'underline':
        return wrapActiveTableInputSelection(input, '<u>', '</u>');
      case 'bold':
        return wrapActiveTableInputSelection(input, '**');
      case 'italic':
        return wrapActiveTableInputSelection(input, '*');
      case 'lineover':
      case 'strike':
        return wrapActiveTableInputSelection(input, '~~');
      case 'highlight':
        return wrapActiveTableInputSelection(input, '==');
      case 'link':
        return editActiveTableInputWithSelection(input, (value, start, end) => {
          if (start !== end) {
            const trimmedEnd = trimTrailingNewlines(value, start, end);
            const selectedText = value.slice(start, trimmedEnd);
            const insert = `[${selectedText}]()`;
            const nextValue = value.slice(0, start) + insert + value.slice(trimmedEnd);
            return updateActiveTableInput(input, nextValue, start + insert.length - 1);
          }

          const insert = '[]()';
          const nextValue = value.slice(0, start) + insert + value.slice(end);
          return updateActiveTableInput(input, nextValue, start + 3);
        });
      case 'wikiLink':
        return editActiveTableInputWithSelection(input, (value, start, end) => {
          if (start !== end) {
            const trimmedEnd = trimTrailingNewlines(value, start, end);
            const selectedText = value.slice(start, trimmedEnd);
            const insert = `[[${selectedText}]]`;
            const nextValue = value.slice(0, start) + insert + value.slice(trimmedEnd);
            return updateActiveTableInput(input, nextValue, start + insert.length);
          }

          const insert = '[[]]';
          const nextValue = value.slice(0, start) + insert + value.slice(end);
          return updateActiveTableInput(input, nextValue, start + 2);
        });
      default:
        return false;
    }
  };

  const forEachSelectedLine = (
    state: EditorState,
    callback: (line: { from: number; to: number; number: number }) => void
  ): void => {
    const seen = new Set<number>();
    for (const range of state.selection.ranges) {
      const fromLine = state.doc.lineAt(range.from).number;
      const toPos = Math.max(range.from, range.to - (range.empty ? 0 : 1));
      const toLine = state.doc.lineAt(toPos).number;
      for (let lineNumber = fromLine; lineNumber <= toLine; lineNumber += 1) {
        if (seen.has(lineNumber)) {
          continue;
        }
        seen.add(lineNumber);
        callback(state.doc.line(lineNumber));
      }
    }
  };

  const lineMarkerReplacementContext = (
    state: EditorState,
    line: { from: number; to: number }
  ): MarkerReplacementContext => {
    const lineText = state.doc.sliceString(line.from, line.to);
    const existingMarker = existingListMarkerRegex.exec(lineText);
    const existingHeading = existingHeadingMarkerRegex.exec(lineText);
    const leadingWhitespace = existingMarker?.[1] ?? existingHeading?.[1] ?? /^(\s*)/.exec(lineText)?.[1] ?? '';

    const contentStart = line.from + leadingWhitespace.length;
    let oldMarkerLen = 0;
    if (existingMarker) {
      oldMarkerLen = existingMarker[0].length - leadingWhitespace.length;
    } else if (existingHeading) {
      oldMarkerLen = existingHeading[0].length - leadingWhitespace.length;
    }

    const isExistingTask = Boolean(existingMarker && existingTaskMarkerRegex.test(existingMarker[0]));
    return { contentStart, oldMarkerLen, isExistingTask };
  };

  const buildListFormatChangesForSelection = (state: EditorState, insert: string): ChangeSpec[] => {
    const changes: ChangeSpec[] = [];
    forEachSelectedLine(state, (line) => {
      const { contentStart, oldMarkerLen } = lineMarkerReplacementContext(state, line);
      changes.push({ from: contentStart, to: contentStart + oldMarkerLen, insert });
    });
    return changes;
  };

  const dispatchSelectedListFormatChanges = (
    state: EditorState,
    changes: ChangeSpec[],
    shouldRenumberOrdered: boolean
  ): void => {
    if (!changes.length) {
      return;
    }

    if (!shouldRenumberOrdered) {
      view.dispatch({ changes });
      return;
    }

    const withMarkers = state.update({ changes });
    const renumberChanges = collectOrderedListRenumberChanges(withMarkers.state);
    if (!renumberChanges.length) {
      view.dispatch(withMarkers);
      return;
    }

    view.dispatch(
      state.update(
        { changes },
        { changes: renumberChanges, sequential: true }
      )
    );
  };

  const isSearchMatchSelection = (from: number, to: number) => {
    if (from >= to) {
      return false;
    }

    const searchQuery = view.state.field(searchQueryField);
    if (!searchQuery.text || to - from !== searchQuery.text.length) {
      return false;
    }

    return view.state.field(searchMatchField).matches.some((match) => (
      match.start === from && match.end === to
    ));
  };

  const resolveNativeSelectionAnchor = (): { anchorX: number; anchorY: number; anchorBottomY: number } | null => {
    if (!view) {
      return null;
    }

    const nativeSelection = window.getSelection();
    if (!nativeSelection || nativeSelection.isCollapsed || nativeSelection.rangeCount === 0) {
      return null;
    }

    let topRect: DOMRect | null = null;
    for (let rangeIndex = 0; rangeIndex < nativeSelection.rangeCount; rangeIndex += 1) {
      const range = nativeSelection.getRangeAt(rangeIndex);
      const ancestor = range.commonAncestorContainer;
      if (!view.dom.contains(ancestor)) {
        continue;
      }

      const rects = range.getClientRects();
      for (let rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {
        const rect = rects.item(rectIndex);
        if (!rect || (rect.width <= 0 && rect.height <= 0)) {
          continue;
        }
        if (!topRect || rect.top < topRect.top || (rect.top === topRect.top && rect.left < topRect.left)) {
          topRect = rect;
        }
      }
    }

    if (!topRect) {
      return null;
    }

    return {
      anchorX: topRect.left,
      anchorY: topRect.top,
      anchorBottomY: topRect.bottom
    };
  };

  const emitSelectionChange = () => {
    if (!view || typeof onSelectionChange !== 'function') {
      return;
    }

    if (suppressSelectionMenuForNativeHtml) {
      onSelectionChange({ visible: false });
      return;
    }

    const activeTableInput = getActiveTableInput();
    if (activeTableInput) {
      onSelectionChange(getActiveTableSelectionState(activeTableInput) ?? { visible: false });
      return;
    }

    const selection = view.state.selection.main;
    if (selection.empty) {
      onSelectionChange({ visible: false });
      return;
    }

    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    if (isSearchMatchSelection(from, to)) {
      onSelectionChange({ visible: false });
      return;
    }

    if (!isRegularInlineSelection(view.state, from, to)) {
      onSelectionChange({ visible: false });
      return;
    }

    const nativeAnchor = resolveNativeSelectionAnchor();
    if (nativeAnchor) {
      onSelectionChange({
        visible: true,
        from,
        to,
        anchorX: nativeAnchor.anchorX,
        anchorY: nativeAnchor.anchorY,
        anchorBottomY: nativeAnchor.anchorBottomY
      });
      return;
    }

    const fromCoords = view.coordsAtPos(from);
    const toCoords = view.coordsAtPos(to);
    if (!fromCoords || !toCoords) {
      onSelectionChange({ visible: false });
      return;
    }

    const fromCharCoords = view.coordsForChar(from);
    const anchorX = fromCharCoords?.left ?? fromCoords.left;
    const anchorY = fromCharCoords ? Math.min(fromCoords.top, fromCharCoords.top) : fromCoords.top;
    const anchorBottomY = fromCharCoords ? Math.max(fromCoords.bottom, fromCharCoords.bottom) : fromCoords.bottom;

    onSelectionChange({
      visible: true,
      from,
      to,
      anchorX,
      anchorY,
      anchorBottomY
    });
  };

  const isHistoryReplayUpdate = (update: ViewUpdate): boolean => {
    return update.transactions.some((transaction) => {
      const userEvent = transaction.annotation(Transaction.userEvent);
      return (
        typeof userEvent === 'string' &&
        (userEvent === 'undo' || userEvent === 'redo' || userEvent.startsWith('undo.') || userEvent.startsWith('redo.'))
      );
    });
  };

  const inlineCodeCaretPosition = (state: EditorState, position: number) => {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, -1);
    while (node && node.name !== 'InlineCode' && node.name !== 'CodeText') {
      node = node.parent;
    }
    if (!node) {
      return null;
    }

    const text = state.doc.sliceString(node.from, node.to);
    const openTicks = (/^`+/.exec(text) ?? [''])[0].length;
    const closeTicks = (/`+$/.exec(text) ?? [''])[0].length;
    if (!openTicks || !closeTicks) {
      return null;
    }

    const min = node.from + openTicks;
    const max = node.to - closeTicks;
    if (min > max) {
      return null;
    }
    if (position < min) {
      return min;
    }
    if (position > max) {
      return max;
    }
    return null;
  };

  const scheduleLiveSearchMatchReveal = (position: number) => {
    pendingLiveSearchRevealGeneration += 1;
    const revealGeneration = pendingLiveSearchRevealGeneration;
    if (pendingLiveSearchRevealFrame !== null) {
      window.cancelAnimationFrame(pendingLiveSearchRevealFrame);
      pendingLiveSearchRevealFrame = null;
    }
    if (currentMode !== 'live') {
      return;
    }

    pendingLiveSearchRevealFrame = window.requestAnimationFrame(() => {
      pendingLiveSearchRevealFrame = null;
      if (!view || currentMode !== 'live' || revealGeneration !== pendingLiveSearchRevealGeneration) {
        return;
      }

      view.requestMeasure({
        read(editorView) {
          if (currentMode !== 'live' || revealGeneration !== pendingLiveSearchRevealGeneration) {
            return null;
          }
          const max = editorView.state.doc.length;
          const targetPos = Math.max(0, Math.min(position, max));
          const coords = editorView.coordsAtPos(targetPos);
          const scrollerRect = editorView.scrollDOM.getBoundingClientRect();
          if (!coords || scrollerRect.height <= 0) {
            return null;
          }
          if (coords.top >= scrollerRect.top && coords.bottom <= scrollerRect.bottom) {
            return null;
          }

          const lineBlock = editorView.lineBlockAt(targetPos);
          const targetTop = Math.max(
            0,
            lineBlock.top - Math.max(0, (editorView.scrollDOM.clientHeight - lineBlock.height) / 2)
          );
          return { targetTop };
        },
        write(measure, editorView) {
          if (!measure || currentMode !== 'live' || revealGeneration !== pendingLiveSearchRevealGeneration) {
            return;
          }
          viewportController.navigateBy({ top: measure.targetTop - editorView.scrollDOM.scrollTop });
        }
      });
    });
  };

  const scheduleLiveSearchDecorationRefresh = (targetPosition: number | null = null) => {
    pendingLiveSearchDecorationRefreshGeneration += 1;
    const refreshGeneration = pendingLiveSearchDecorationRefreshGeneration;
    if (pendingLiveSearchDecorationRefreshFrame !== null) {
      window.cancelAnimationFrame(pendingLiveSearchDecorationRefreshFrame);
    }
    if (currentMode !== 'live') {
      pendingLiveSearchDecorationRefreshFrame = null;
      return;
    }

    pendingLiveSearchDecorationRefreshFrame = window.requestAnimationFrame(() => {
      pendingLiveSearchDecorationRefreshFrame = null;
      if (!view || currentMode !== 'live' || refreshGeneration !== pendingLiveSearchDecorationRefreshGeneration) {
        return;
      }
      if (typeof targetPosition === 'number' && Number.isFinite(targetPosition)) {
        forceParsing(view, Math.min(view.state.doc.length, Math.max(0, targetPosition) + 2_000), 100);
      }
      view.dispatch({ effects: refreshLiveDecorationsAfterSearchEffect.of(undefined) });
    });
  };

  const selectSearchMatch = (from: number, to: number, { focusEditor = true }: { focusEditor?: boolean } = {}) => {
    const htmlBlock = currentMode === 'live'
      ? collectRenderableHtmlBlocks(view.state).find((block) => from < block.to && to > block.from)
      : null;
    viewportController.markInteraction();
    view.dispatch({
      selection: { anchor: from, head: to },
      effects: [
        EditorView.scrollIntoView(from, { y: 'center' }),
        setLongCodeBlockSearchRevealEffect.of({ from, to }),
        setMermaidSearchRevealEffect.of({ from, to }),
        setLatexMathSearchRevealEffect.of({ from, to }),
        ...(htmlBlock ? [setHtmlEditingRangeEffect.of({ from: htmlBlock.from, to: htmlBlock.to })] : []),
        preserveLiveDecorationsForSearchEffect.of(undefined)
      ]
    });
    scheduleLiveSearchDecorationRefresh(to);
    scheduleLiveSearchMatchReveal(from);
    if (focusEditor) {
      view.focus();
    }
  };

  const applyRevealSelection = (anchor: number, head = anchor, { focusEditor = true, align = 'center' }: RevealOptions = {}) => {
    const max = view.state.doc.length;
    const nextAnchor = Math.max(0, Math.min(anchor, max));
    const nextHead = Math.max(0, Math.min(head, max));
    const scrollOptions = align === 'upper'
      ? { y: 'start' as const, yMargin: Math.round(view.scrollDOM.clientHeight * 0.3) }
      : { y: align === 'top' ? 'start' as const : align === 'nearest' ? 'nearest' as const : 'center' as const };
    const scrollEffects = align === 'none' ? [] : [EditorView.scrollIntoView(nextAnchor, scrollOptions)];
    const selection = view.state.selection.main;
    if (scrollEffects.length > 0) viewportController.markInteraction();

    if (selection.anchor === nextAnchor && selection.head === nextHead) {
      view.dispatch({
        effects: scrollEffects
      });
      if (focusEditor) {
        view.focus();
      }
      return;
    }

    view.dispatch({
      selection: { anchor: nextAnchor, head: nextHead },
      effects: scrollEffects
    });
    if (focusEditor) {
      view.focus();
    }
  };

  const isPositionVisible = (position: number) => {
    const coords = view.coordsAtPos(position);
    if (!coords) {
      return false;
    }
    const viewport = view.scrollDOM.getBoundingClientRect();
    return coords.top >= viewport.top && coords.bottom <= viewport.bottom;
  };

  const suppressHistoryAutoScrollAt = (position: number): boolean => {
    if (!historyScrollGuard) return false;
    const coords = view.coordsAtPos(position);
    const viewport = view.scrollDOM.getBoundingClientRect();
    if (coords) {
      return coords.top >= viewport.top && coords.bottom <= viewport.bottom;
    }
    const block = view.lineBlockAt(position);
    return block.bottom > view.scrollDOM.scrollTop
      && block.top < view.scrollDOM.scrollTop + view.scrollDOM.clientHeight;
  };

  const prepareRenderedHistoryPosition = (
    position: number
  ): (() => boolean) | null => {
    if (currentMode !== 'live') {
      return null;
    }

    const targetPosition = Math.max(0, Math.min(position, view.state.doc.length));
    const targetLineNumber = view.state.doc.lineAt(targetPosition).number;
    const renderedBlocks = getLiveRenderedBlocks(view.state, { includeSelectedMath: true });
    const block = renderedBlocks.find((candidate) => (
      (candidate.kind === 'mermaid' || candidate.kind === 'math') && (
        (
          targetLineNumber >= candidate.lineNumberHiddenFrom &&
          targetLineNumber <= candidate.lineNumberHiddenTo
        ) || targetPosition === view.state.doc.line(candidate.endLine).from
      )
    ));
    if (!block || block.startLine >= view.state.doc.lines) {
      return null;
    }

    const openingLine = view.state.doc.line(block.startLine);
    const contentFrom = view.state.doc.line(block.startLine + 1).from;
    const closingLine = view.state.doc.line(block.endLine);
    const contentTo = Math.max(contentFrom, closingLine.from - 1);
    const offset = Math.max(0, Math.min(targetPosition - contentFrom, contentTo - contentFrom));
    const manualMode = block.kind === 'mermaid'
      ? getMermaidBlockMode(view.state, openingLine.from, contentFrom, contentTo).manual
      : getLatexMathBlockMode(view.state, openingLine.from, contentFrom, contentTo).manual;
    const desiredMode = recentRenderedReplayPresentation?.anchor === openingLine.from
      ? recentRenderedReplayPresentation.mode
      : manualMode === 'preview' ? 'split' : manualMode;
    const modeEffect = desiredMode !== manualMode
      ? block.kind === 'mermaid'
        ? setMermaidBlockModeEffect.of({ anchor: openingLine.from, mode: desiredMode })
        : setLatexMathBlockModeEffect.of({ anchor: openingLine.from, mode: desiredMode })
      : null;

    viewportController.markInteraction();
    view.dispatch({
      selection: { anchor: targetPosition },
      effects: [
        ...(modeEffect ? [modeEffect] : []),
        EditorView.scrollIntoView(openingLine.from, {
          y: isPositionVisible(openingLine.from) ? 'nearest' : 'center'
        })
      ]
    });
    // Mode effects dispatched by this replay synchronously invalidate the
    // previous hint. Record the accepted presentation only after dispatch so
    // a later replay can reuse it, while a user-initiated mode effect wins.
    recentRenderedReplayPresentation = { anchor: openingLine.from, mode: desiredMode };
    // Keep the outer editor focused until the target controller mounts. The
    // coordinator owns cancellation when a newer command or user action wins.
    view.focus();
    return () => block.kind === 'mermaid'
      ? focusMermaidEditingOffset(view, openingLine.from, offset)
      : focusLatexMathEditingOffset(view, openingLine.from, offset);
  };

  const revealRenderedSourceLine = (lineNumber: number) => {
    if (currentMode !== 'live') {
      return false;
    }

    const block = getLiveRenderedBlocks(view.state).find((candidate) => (
      (candidate.kind === 'mermaid' || candidate.kind === 'math' || candidate.kind === 'html') &&
      lineNumber >= candidate.lineNumberHiddenFrom &&
      lineNumber <= candidate.lineNumberHiddenTo
    ));
    if (!block) {
      return false;
    }

    const openingLine = view.state.doc.line(block.startLine);
    const targetLine = view.state.doc.line(lineNumber);
    if (block.kind === 'html') {
      const htmlBlock = collectRenderableHtmlBlocks(view.state).find((candidate) => (
        candidate.startLine === block.startLine && candidate.endLine === block.endLine
      ));
      if (!htmlBlock) return false;
      viewportController.markInteraction();
      view.dispatch({
        selection: { anchor: targetLine.from },
        effects: [
          setHtmlEditingRangeEffect.of({ from: htmlBlock.from, to: htmlBlock.to }),
          EditorView.scrollIntoView(targetLine.from, {
            y: isPositionVisible(openingLine.from) ? 'nearest' : 'center'
          })
        ]
      });
      view.focus();
      return true;
    }
    const contentFrom = view.state.doc.line(block.startLine + 1).from;
    const offset = targetLine.from - contentFrom;
    const modeEffect = block.kind === 'mermaid'
      ? setMermaidBlockModeEffect.of({ anchor: openingLine.from, mode: 'source' })
      : setLatexMathBlockModeEffect.of({ anchor: openingLine.from, mode: 'source' });

    viewportController.markInteraction();
    view.dispatch({
      selection: { anchor: targetLine.from },
      effects: [
        modeEffect,
        EditorView.scrollIntoView(openingLine.from, {
          y: isPositionVisible(openingLine.from) ? 'nearest' : 'center'
        })
      ]
    });
    view.requestMeasure({
      read() {
        return null;
      },
      write() {
        const focusSource = () => block.kind === 'mermaid'
          ? focusMermaidEditingOffset(view, openingLine.from, offset)
          : focusLatexMathEditingOffset(view, openingLine.from, offset);
        requestAnimationFrame(() => {
          if (!focusSource()) {
            requestAnimationFrame(focusSource);
          }
        });
      }
    });
    return true;
  };

  const revealRenderedTableLine = (lineNumber: number) => {
    if (currentMode !== 'live') {
      return false;
    }

    const block = getLiveRenderedBlocks(view.state).find((candidate) => (
      candidate.kind === 'table' &&
      lineNumber >= candidate.startLine &&
      lineNumber <= candidate.endLine
    ));
    if (!block) {
      return false;
    }

    const targetLine = view.state.doc.line(lineNumber);
    const rowLineNumber = lineNumber === block.delimiterLine ? block.startLine : lineNumber;
    viewportController.markInteraction();
    view.dispatch({
      selection: { anchor: targetLine.from },
      effects: EditorView.scrollIntoView(targetLine.from, { y: 'center' })
    });
    view.requestMeasure({
      read() {
        return null;
      },
      write() {
        const focusRow = () => {
          const shell = view.dom.querySelector(
            `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${block.startLine}"]`
          ) as HTMLElement | null;
          const input = shell?.querySelector(
            `tr[data-source-line-number="${rowLineNumber}"] textarea`
          ) as HTMLTextAreaElement | null;
          if (!input) return false;
          input.focus({ preventScroll: true });
          input.setSelectionRange(0, 0);
          input.closest('th, td')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
          return true;
        };
        requestAnimationFrame(() => {
          if (!focusRow()) {
            requestAnimationFrame(focusRow);
          }
        });
      }
    });
    return true;
  };

  const syncCursorToTopVisibleLine = () => {
    const position = viewportController.getTopVisiblePosition();
    const line = view.state.doc.line(position.line);
    const anchor = line.from;
    const selection = view.state.selection.main;
    if (selection.anchor === anchor && selection.head === anchor) {
      return;
    }
    view.dispatch({
      selection: { anchor },
      annotations: Transaction.addToHistory.of(false)
    });
  };

  const computeTopVisiblePosition = () => {
    const position = viewportController.getTopVisiblePosition();
    return {
      lineNumber: position.line,
      lineOffset: position.lineOffset
    };
  };

  const captureViewportAnchor = () => viewportController.captureDocumentAnchor();

  const restoreViewportAnchor = (position: number, lineOffset = 0) => {
    viewportController.restoreDocumentAnchor({ position, lineOffset });
  };

  const restoreTopVisibleLine = (lineNumber: number, lineOffset = 0, { syncCursor = true, force = false }: { syncCursor?: boolean; force?: boolean } = {}) => {
    viewportController.restoreTopVisibleLine(
      lineNumber,
      lineOffset,
      syncCursor ? syncCursorToTopVisibleLine : undefined,
      { force }
    );
  };

  let searchResultCache: {
    doc: unknown;
    query: string;
    wholeWord: boolean;
    caseSensitive: boolean;
    matches: SearchMatchRange[];
  } | null = null;
  const getSearchMatches = (query: string, options: SearchOptions = {}): SearchMatchRange[] => {
    if (!query) return [];
    const wholeWord = options.wholeWord === true;
    const caseSensitive = options.caseSensitive === true;
    const activeQuery = view.state.field(searchQueryField);
    if (
      activeQuery.text === query &&
      activeQuery.wholeWord === wholeWord &&
      activeQuery.caseSensitive === caseSensitive
    ) {
      return view.state.field(searchMatchField).matches;
    }
    if (
      searchResultCache?.doc === view.state.doc &&
      searchResultCache.query === query &&
      searchResultCache.wholeWord === wholeWord &&
      searchResultCache.caseSensitive === caseSensitive
    ) {
      return searchResultCache.matches;
    }
    const matches = findSearchMatchRanges(view.state.doc.toString(), query, { wholeWord, caseSensitive });
    searchResultCache = { doc: view.state.doc, query, wholeWord, caseSensitive, matches };
    return matches;
  };

  const findMatch = (
    query: string,
    backward = false,
    { focusEditor = true, ...searchOptions }: SearchOptions & { focusEditor?: boolean } = {}
  ) => {
    if (!query) {
      return { found: false, current: 0, total: 0 };
    }

    const selection = view.state.selection.main;
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    const matches = getSearchMatches(query, searchOptions);
    const total = matches.length;

    if (!total) {
      return { found: false, current: 0, total };
    }

    let matchIndex = -1;
    if (backward) {
      for (let index = matches.length - 1; index >= 0; index -= 1) {
        if (matches[index].start < from) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex < 0) {
        matchIndex = matches.length - 1;
      }
    } else {
      for (let index = 0; index < matches.length; index += 1) {
        if (matches[index].start >= to) {
          matchIndex = index;
          break;
        }
      }
      if (matchIndex < 0) {
        matchIndex = 0;
      }
    }

    const match = matches[matchIndex];
    selectSearchMatch(match.start, match.end, { focusEditor });
    return {
      found: true,
      current: matchIndex + 1,
      total
    };
  };

  const replaceCurrentMatch = (query: string, replacement: string, options: SearchOptions = {}) => {
    if (!query) {
      return { replaced: false, found: false, current: 0, total: 0 };
    }

    const selection = view.state.selection.main;
    const from = Math.min(selection.from, selection.to);
    const to = Math.max(selection.from, selection.to);
    const matches = getSearchMatches(query, options);
    const matchIndex = findSelectedSearchMatchIndex(matches, from, to);
    if (matchIndex < 0) {
      return { replaced: false, ...findMatch(query, false, options) };
    }

    view.dispatch({
      changes: { from, to, insert: replacement },
      selection: { anchor: from, head: from + replacement.length }
    });
    const nextMatch = findMatch(query, false, options);
    if (nextMatch.found) {
      return { replaced: true, ...nextMatch };
    }

    const remaining = getSearchMatches(query, options).length;
    return { replaced: true, found: false, current: 0, total: remaining };
  };

  const tableTransactionProvenanceAdapter = createCodeMirrorTableTransactionProvenanceAdapter(
    createTableTransactionProvenance()
  );
  const tableColumnWidthAdapter = createCodeMirrorDomTableColumnWidthAdapter({
    root: parent,
    policy: tableColumnWidthPolicy
  });
  const tableStickyHeaderAdapterFactory: TableStickyHeaderAdapterFactory = {
    create(options) {
      return createCodeMirrorDomTableStickyHeaderAdapter({
        ...options,
        policy: tableStickyHeaderPolicy
      });
    }
  };
  const tableCommandTargetRegistry = createTableCommandTargetRegistry();
  const tableCommandApplication = createTableCommandApplication();
  const tableCommandEffectAdapter = createCodeMirrorTableCommandEffectAdapter({
    resolveTarget(tableId) {
      return tableCommandTargetRegistry.resolve(tableId);
    },
    reportError(error) {
      console.error('Table command effect failed', error);
    },
    dispose() {
      tableCommandTargetRegistry.dispose();
    }
  });
  const tableCommandRuntime = createTableCommandRuntime(
    tableCommandApplication,
    tableCommandEffectAdapter,
    (error) => console.error('Table command Runtime failed', error)
  );
  const tableCommandEnvironment: TableCommandEnvironment = {
    dispatch(input) {
      return tableCommandRuntime.dispatch(input);
    },
    registerTarget(target) {
      return tableCommandTargetRegistry.register(target);
    }
  };
  const imagePresentationResourcePool = createImagePresentationResourcePool({
    resolveSource: (_contextKey, rawSrc) => resolveConfiguredImageSrc(rawSrc),
    loadImage: loadBrowserImage
  });
  const imagePresentationFactory = createImagePresentationFactory({
    resources: imagePresentationResourcePool,
    resourceContextKey: 'editor-document'
  });
  const state = EditorState.create({
    doc: text,
    selection: { anchor: initialCursorPos },
    extensions: [
      EditorState.tabSize.of(4),
      indentUnit.of('  '),
      keymap.of([
        { key: 'Tab', run: (view) => indentListByTwoSpaces(view) || indentMore(view) },
        { key: 'Shift-Tab', run: (view) => outdentListByTwoSpaces(view) || indentLess(view) },
        { key: 'Alt-]', run: indentListByTwoSpaces },
        { key: 'Alt-[', run: outdentListByTwoSpaces },
        { key: 'Backspace', run: deleteBackwardSmart },
        { key: 'ArrowLeft', run: (view) => isLiveMode(view) && handleArrowLeftAtListContentStart(view) },
        { key: 'ArrowRight', run: (view) => isLiveMode(view) && handleArrowRightAtListLineStart(view) },
        {
          key: 'Enter',
          run: (view) =>
            handleEnterContinueQuotedCodeBlock(view) ||
            handleEnterOnEmptyListItem(view) ||
            handleEnterAtListContentStart(view) ||
            handleEnterContinueList(view) ||
            handleEnterBeforeNestedList(view)
        },
        { key: 'Shift-Enter', run: insertTableCellLineBreak },
        { key: 'Ctrl-Enter', run: insertTableCellLineBreak },
        { key: 'ArrowUp', run: (view) => tryEnterAdjacentTable(view, 'up') },
        { key: 'ArrowDown', run: (view) => tryEnterAdjacentTable(view, 'down') },
        ...markdownKeymap,
        ...defaultKeymap,
        ...editorHistoryKeymap
      ]),
      history(),
      lineNumbers(),
      tableTransactionProvenanceAdapter.extension,
      ...gitDiffGutterBaselineExtensions(),
      gitGutterCompartment.of(startMode === 'live' ? gitDiffGutterLiveRenderExtensions() : gitDiffGutterRenderExtensions()),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      shikiCodeHighlight,
      EditorView.lineWrapping,
      EditorView.domEventHandlers({
        beforeinput(event) {
          if (imeCompositionActive && event.inputType === 'insertText' && !event.isComposing) {
            imeCompositionActive = false;
            scheduleImeCompositionFlush();
          }
          return false;
        },
        blur() {
          if (imeCompositionActive) {
            imeCompositionActive = false;
            scheduleImeCompositionFlush();
          }
          return false;
        },
        compositionstart() {
          imeCompositionActive = true;
          if (imeCompositionFlushTimer !== null) {
            window.clearTimeout(imeCompositionFlushTimer);
            imeCompositionFlushTimer = null;
          }
          return false;
        },
        compositionend() {
          imeCompositionActive = false;
          scheduleImeCompositionFlush();
          return false;
        },
        pointerdown(event, view) {
          if (event.button !== 0) {
            frontmatterBoundaryClick = null;
            return false;
          }
          if (openLinkIfModifierClick(event, view)) {
            frontmatterBoundaryClick = null;
            return true;
          }

          const target = event.target;
          const targetElement = targetElementFrom(target);
          if (!(target instanceof Node) || !view.contentDOM.contains(target)) return false;

          if (tableInteractionActive && !targetElement?.closest('.meo-md-html-table-shell')) {
            setTableInteractionActive(false);
          }

          trackFrontmatterBoundaryClick(event, view);

          if (targetElement && targetElement.closest(
            '.meo-mermaid-zoom-controls, .meo-latex-math-zoom-controls'
          )) {
            event.preventDefault();
            event.stopPropagation();
            return true;
          }

          if (targetElement && targetElement.closest('.meo-task-checkbox')) {
            checkboxClick = { pointerId: event.pointerId };
            return false;
          }

          // Let interactive HTML table widget controls handle focus/click natively.
          if (targetElement && targetElement.closest('.meo-md-html-table-shell')) {
            inlineCodeClick = null;
            checkboxClick = null;
            return false;
          }

          inlineCodeClick = {
            pointerId: event.pointerId,
            inInlineCode: Boolean(
              currentMode === 'live' &&
              targetElement?.closest('.meo-md-inline-code')
            )
          };

          if (currentMode === 'live') {
            const pointerPos = view.posAtCoords({ x: event.clientX, y: event.clientY });
            const pointerLine = pointerPos === null ? null : view.state.doc.lineAt(pointerPos).number;
            const preservedLine = pointerLine !== null && view.state.selection.ranges.some(
              (range) => view.state.doc.lineAt(range.head).number === pointerLine
            ) ? pointerLine : null;
            liveSelectionGeneration += 1;
            liveSelectionPointerId = event.pointerId;
            view.dom.classList.add('meo-live-pointer-selecting');
            view.dom.style.cursor = 'text';
            view.dispatch({
              effects: setLivePointerSelectionActiveEffect.of({ active: true, preservedLine })
            });
          }

          if (view.dom.setPointerCapture) {
            view.dom.setPointerCapture(event.pointerId);
            capturedPointerId = event.pointerId;
          }
          return false;
        },
        pointerup(event, view) {
          finishLivePointerSelection(event.pointerId, true);

          if (checkboxClick?.pointerId === event.pointerId) {
            frontmatterBoundaryClick = null;
            checkboxClick = null;
            return false;
          }

          if (capturedPointerId !== event.pointerId) {
            if (frontmatterBoundaryClick?.pointerId === event.pointerId) {
              frontmatterBoundaryClick = null;
            }
            return false;
          }

          releasePointerCaptureIfHeld(event.pointerId);
          capturedPointerId = null;

          if (
            inlineCodeClick?.pointerId === event.pointerId &&
            inlineCodeClick.inInlineCode &&
            isLiveMode(view)
          ) {
            const { head, empty } = view.state.selection.main;
            if (empty) {
              const clamped = inlineCodeCaretPosition(view.state, head);
              if (clamped !== null && clamped !== head) {
                view.dispatch({ selection: { anchor: clamped } });
              }
            }
          }

          if (frontmatterBoundaryClick?.pointerId === event.pointerId) {
            if (isLiveMode(view)) {
              const selection = view.state.selection.main;
              if (selection.empty && selection.head !== frontmatterBoundaryClick.cursorEnd) {
                view.dispatch({ selection: { anchor: frontmatterBoundaryClick.cursorEnd } });
              }
            }
            frontmatterBoundaryClick = null;
          }

          if (isLiveMode(view)) {
            const { head, empty } = view.state.selection.main;
            if (empty) {
              const emptyQuoteCursorEnd = emptyBlockquoteLineCursorEnd(view.state, head);
              if (emptyQuoteCursorEnd !== null && head < emptyQuoteCursorEnd) {
                view.dispatch({ selection: { anchor: emptyQuoteCursorEnd } });
                return false;
              }

              const node = resolvedSyntaxTree(view.state).resolveInner(head, -1);
              if (node.name === 'HorizontalRule') {
                const line = view.state.doc.lineAt(head);
                const lineText = view.state.doc.sliceString(line.from, line.to);
                const hrMatch = /^[ \t]*(-{3,}|\*{3,}|_{3,})/.exec(lineText);
                if (hrMatch) {
                  const cursorEnd = line.from + hrMatch[0].length;
                  if (head !== cursorEnd) {
                    view.dispatch({ selection: { anchor: cursorEnd } });
                  }
                }
              }
            }
          }

          inlineCodeClick = null;
          return false;
        },
        pointercancel(event, _view) {
          finishLivePointerSelection(event.pointerId);

          if (capturedPointerId !== event.pointerId) {
            if (frontmatterBoundaryClick?.pointerId === event.pointerId) {
              frontmatterBoundaryClick = null;
            }
            return false;
          }

          releasePointerCaptureIfHeld(event.pointerId);
          capturedPointerId = null;
          frontmatterBoundaryClick = null;
          inlineCodeClick = null;
          checkboxClick = null;
          return false;
        },
        pointermove(event, view) {
          updateEditableLinkHoverCursor(event, view);
          return false;
        },
        pointerleave(_event, view) {
          editableLinkHoverPosition = null;
          setEditableLinkHoverCursor(view, false);
          return false;
        },
        keydown(event, view) {
          if (event.key === 'Control' || event.key === 'Meta' || event.key === 'Alt' || event.key === 'Shift') {
            updateEditableLinkHoverCursorForModifier(event, view);
          }
          return false;
        },
        keyup(event, view) {
          if (event.key === 'Control' || event.key === 'Meta' || event.key === 'Alt' || event.key === 'Shift') {
            updateEditableLinkHoverCursorForModifier(event, view);
          }
          return false;
        }
      }),
      ...detailsBlockStateExtensions(),
      tableHeaderAlignmentOverrideField,
      tableColumnWidthAdapter.extension,
      tableStickyHeaderAdapterFactoryFacet.of(tableStickyHeaderAdapterFactory),
      tableCommandEnvironmentFacet.of(tableCommandEnvironment),
      imagePresentationFactoryFacet.of(imagePresentationFactory),
      mermaidDiagramPresentationFactoryFacet.of(
        mermaidDiagramPresentationFactory as MermaidDiagramPresentationFactory
      ),
      modeCompartment.of(startMode === 'live' ? liveModeExtensions() : sourceMode()),
      searchQueryField,
      Prec.high(searchMatchField),
      diagnosticDataField,
      diagnosticField,
      EditorView.scrollHandler.of((editorView, range) => {
        void editorView;
        return suppressHistoryAutoScrollAt(range.head);
      }),
      EditorView.updateListener.of((update) => {
        scheduleBlockActionToolbarReconcile();
        viewportController?.reconcileAfterEditorUpdate(
          update.docChanged ? (position) => update.changes.mapPos(position, 1) : undefined
        );
        syncModeClasses();
        syncLineNumbersVisibility();
        syncGitGutterVisibility();
        emitSearchStateChange();
        const searchQueryChanged = update.transactions.some((transaction) => (
          transaction.effects.some((effect) => effect.is(setSearchQueryEffect))
        ));
        const renderedPresentationChanged = update.transactions.some((transaction) => (
          transaction.effects.some((effect) => (
            effect.is(setMermaidBlockModeEffect) || effect.is(setLatexMathBlockModeEffect)
          ))
        ));
        if (renderedPresentationChanged) {
          recentRenderedReplayPresentation = null;
        }
        if (update.docChanged || update.selectionSet || searchQueryChanged) {
          searchOverviewRuler?.refresh({ positionsChanged: update.docChanged || searchQueryChanged });
        }

        if (update.selectionSet) {
          suppressSelectionMenuForNativeHtml = false;
          syncSelectionClass();
          emitSelectionChange();
        } else if (update.viewportChanged) {
          emitSelectionChange();
          onViewportChange?.();
        }

        if (update.docChanged) {
          if (!applyingExternal && !applyingRenumber && !isHistoryReplayUpdate(update)) {
            recentRenderedReplayPresentation = null;
            void editorHistoryRuntime?.dispatch({ type: 'localDocumentEdited' });
          }
        }

        if (!update.docChanged || applyingExternal || applyingRenumber) {
          return;
        }

        if (imeCompositionActive) {
          imeCompositionChanged = true;
          return;
        }

        imeCompositionChanged = false;

        if (isHistoryReplayUpdate(update)) {
          onApplyChanges(update.state.doc.toString());
          return;
        }

        publishComposedDocumentChange();
      })
    ]
  });

  const initialScrollTo = (() => {
    if (typeof initialTopLine !== 'number' || !Number.isFinite(initialTopLine)) {
      return undefined;
    }
    const lineNumber = Math.min(Math.max(1, Math.floor(initialTopLine)), state.doc.lines);
    const line = state.doc.line(lineNumber);
    return EditorView.scrollIntoView(line.from, { y: 'start' });
  })();

  view = new EditorView({
    state,
    parent,
    scrollTo: initialScrollTo
  });
  tableColumnWidthAdapter.adapter.refresh();
  // CodeMirror deliberately suppresses editor handlers for some block widgets.
  // Native listeners keep hover behavior consistent across code, Mermaid, and math blocks.
  onBlockActionPointerMove = (event) => updateBlockActionToolbarHover(event, view);
  onBlockActionPointerLeave = () => setHoveredBlockActionToolbar(null);
  view.dom.addEventListener('pointermove', onBlockActionPointerMove);
  view.dom.addEventListener('pointerleave', onBlockActionPointerLeave);
  viewportController = new ViewportController(view, {
    getMode: () => currentMode === 'live' ? 'live' : 'source'
  });
  const editorHistoryApplication = createEditorHistoryApplication();
  const editorHistoryEffectAdapter = createEditorHistoryEffectAdapter({
    captureContext(): EditorHistoryContext {
      return {
        viewport: viewportController.captureHistorySnapshot()
      };
    },
    commitTransientEdits() {
      commitActiveTableInput();
    },
    runNativeHistory(direction) {
      const guard = viewportController.captureHistorySnapshot();
      historyScrollGuard = guard;
      const beforeDocument = view.state.doc;
      try {
        const applied = direction === 'undo' ? undo(view) : redo(view);
        return {
          applied,
          changedRange: applied ? changedCodeMirrorDocumentRange(beforeDocument, view.state.doc) : null
        };
      } finally {
        queueMicrotask(() => {
          if (historyScrollGuard === guard) historyScrollGuard = null;
        });
      }
    },
    attemptBoundaryRestore(request: EditorHistoryRestoreRequest) {
      const changedRangeIsTable = request.changedRange
        ? isTableHistoryRange(view.state, request.changedRange)
        : false;
      if (changedRangeIsTable) {
        if (!request.changedRange) return 'not-rendered';
        recentRenderedReplayPresentation = null;
        if (focusTableHistoryChange(
          view,
          request.changedRange,
          request.previousViewport.scrollTop,
          request.targetPosition ?? undefined
        )) return 'restored';
        focusHistoryChange(
          view,
          request.changedRange,
          request.previousViewport.scrollTop,
          (anchor, head) => applyRevealSelection(anchor, head, { focusEditor: true, align: 'nearest' }),
          request.previousViewport.selection,
          request.targetPosition ?? undefined
        );
        return 'retry';
      }
      if (request.targetPosition === null) {
        return 'not-rendered';
      }
      if (pendingRenderedHistoryFocus?.replayId !== request.replayId) {
        const run = prepareRenderedHistoryPosition(
          request.targetPosition
        );
        if (!run) return 'not-rendered';
        pendingRenderedHistoryFocus = { replayId: request.replayId, run };
      }
      if (!pendingRenderedHistoryFocus.run()) return 'retry';
      pendingRenderedHistoryFocus = null;
      return 'restored';
    },
    restoreEditorInteraction(request) {
      recentRenderedReplayPresentation = null;
      focusHistoryChange(
        view,
        request.changedRange,
        request.previousViewport.scrollTop,
        (anchor, head) => applyRevealSelection(anchor, head, { focusEditor: true, align: 'nearest' }),
        request.previousViewport.selection,
        request.targetPosition ?? undefined
      );
    },
    scheduleFocusRetry(run) {
      let cancelled = false;
      let frame: number | null = null;
      const observer = new MutationObserver(() => trigger());
      const cleanup = () => {
        if (cancelled) return;
        cancelled = true;
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
        observer.disconnect();
        pendingRenderedHistoryFocus = null;
      };
      const trigger = () => {
        if (cancelled) return;
        cleanup();
        run();
      };
      observer.observe(view.dom, { childList: true, subtree: true });
      view.requestMeasure({ read: () => null, write: trigger });
      frame = requestAnimationFrame(trigger);
      return cleanup;
    },
    reportError(operation, error) {
      console.error(`Editor history ${operation} failed`, error);
    },
    dispose() {
      pendingRenderedHistoryFocus = null;
      recentRenderedReplayPresentation = null;
      historyScrollGuard = null;
      setEditorHistoryRunner(view, null);
      if (onHistoryKeyDown) view.dom.removeEventListener('keydown', onHistoryKeyDown, true);
      if (onHistoryBeforeInput) view.dom.removeEventListener('beforeinput', onHistoryBeforeInput, true);
      if (onHistoryPointerDown) view.dom.removeEventListener('pointerdown', onHistoryPointerDown, true);
      if (onHistoryBlur) view.dom.removeEventListener('blur', onHistoryBlur, true);
      onHistoryKeyDown = null;
      onHistoryBeforeInput = null;
      onHistoryPointerDown = null;
      onHistoryBlur = null;
    }
  });
  editorHistoryRuntime = createEditorHistoryRuntime(
    editorHistoryApplication,
    editorHistoryEffectAdapter,
    (error) => console.error('Editor history Runtime failed', error)
  );
  setEditorHistoryRunner(view, (direction) => requestEditorHistoryReplay(direction));
  onHistoryKeyDown = (event) => {
    const key = event.key.toLowerCase();
    const isHistory = (event.ctrlKey || event.metaKey) && (key === 'z' || key === 'y');
    const isModifier = key === 'control' || key === 'shift' || key === 'alt' || key === 'meta' || key === 'altgraph';
    if (isHistory) {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('.meo-mermaid-toolbar, .meo-latex-math-toolbar')) {
        event.preventDefault();
        event.stopPropagation();
        void requestEditorHistoryReplay(key === 'z' && !event.shiftKey ? 'undo' : 'redo');
      }
      return;
    }
    if (!isModifier) void editorHistoryRuntime?.dispatch({ type: 'cancelRestore' });
  };
  onHistoryBeforeInput = (event) => {
    if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') {
      void editorHistoryRuntime?.dispatch({ type: 'cancelRestore' });
    }
  };
  onHistoryPointerDown = () => { void editorHistoryRuntime?.dispatch({ type: 'cancelRestore' }); };
  onHistoryBlur = (event) => {
    const next = event.relatedTarget;
    if (next instanceof Node && view.dom.contains(next)) return;
    queueMicrotask(() => {
      if (!view.dom.contains(view.dom.ownerDocument.activeElement)) {
        void editorHistoryRuntime?.dispatch({ type: 'cancelRestore' });
      }
    });
  };
  view.dom.addEventListener('keydown', onHistoryKeyDown, true);
  view.dom.addEventListener('beforeinput', onHistoryBeforeInput, true);
  view.dom.addEventListener('pointerdown', onHistoryPointerDown, true);
  view.dom.addEventListener('blur', onHistoryBlur, true);
  if (typeof initialTopLine === 'number' && Number.isFinite(initialTopLine)) {
    restoreTopVisibleLine(initialTopLine, initialTopLineOffset, { syncCursor: true });
  }
  onTableInteraction = (event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    const active = Boolean(detail && typeof detail === 'object' && 'active' in detail && detail.active);
    const owner = detail && typeof detail === 'object' && 'owner' in detail && detail.owner instanceof HTMLElement
      ? detail.owner
      : null;
    setTableInteractionActive(active, owner);
  };
  view.dom.addEventListener('meo-table-interaction', onTableInteraction);
  onWidgetOpenLink = (event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    const href = detail && typeof detail === 'object' && 'href' in detail ? detail.href : null;
    if (typeof href !== 'string' || !href) {
      return;
    }
    openHref(href, view);
  };
  view.dom.addEventListener('meo-open-link', onWidgetOpenLink);
  onWidgetActivateImage = (event) => {
    const detail: unknown = event instanceof CustomEvent ? event.detail : null;
    const from = detail && typeof detail === 'object' && 'from' in detail ? detail.from : null;
    if (typeof from !== 'number' || !Number.isInteger(from)) {
      return;
    }
    if (tableInteractionActive) {
      setTableInteractionActive(false);
    }
    const anchor = Math.max(0, Math.min(from, view.state.doc.length));
    view.dispatch({ selection: { anchor } });
    view.focus();
  };
  view.dom.addEventListener('meo-activate-image', onWidgetActivateImage);
  onTableSelectionChange = () => {
    emitSelectionChange();
  };
  view.dom.addEventListener('meo-table-selection-change', onTableSelectionChange);
  onHtmlContentPointerDown = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest('.meo-md-html-content')) {
      return;
    }
    suppressSelectionMenuForNativeHtml = true;
    onSelectionChange?.({ visible: false });
  };
  view.dom.addEventListener('pointerdown', onHtmlContentPointerDown, true);
  onDocumentSelectionChange = () => {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed) {
      return;
    }
    const selectionNodeInsideHtml = (node: Node | null) => {
      const element = node instanceof Element ? node : node?.parentElement;
      return Boolean(element?.closest('.meo-md-html-content'));
    };
    if (!selectionNodeInsideHtml(selection.anchorNode) && !selectionNodeInsideHtml(selection.focusNode)) {
      return;
    }
    suppressSelectionMenuForNativeHtml = true;
    onSelectionChange?.({ visible: false });
  };
  document.addEventListener('selectionchange', onDocumentSelectionChange);
  onWindowPointerUp = (event) => {
    clearLivePointerSelection();
  };
  onWindowPointerCancel = (event) => {
    clearLivePointerSelection();
  };
  onWindowBlur = () => clearLivePointerSelection();
  window.addEventListener('pointerup', onWindowPointerUp, true);
  window.addEventListener('pointercancel', onWindowPointerCancel, true);
  window.addEventListener('blur', onWindowBlur);
  onScroll = () => {
    emitSelectionChange();
    gitDiffOverviewRuler?.refresh();
    onViewportChange?.();
  };
  view.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
  gitDiffContentHover = createGitDiffContentHoverController(view);
  gitDiffOverviewRuler = createGitDiffOverviewRulerController({
    view,
    getMode: () => currentMode,
    isGitChangesVisible: () => gitGutterVisible
  });
  searchOverviewRuler = createSearchOverviewRulerController({
    view,
    getMatches: () => {
      const matches = view.state.field(searchMatchField).matches;
      const selection = view.state.selection.main;
      const selectionFrom = Math.min(selection.from, selection.to);
      const selectionTo = Math.max(selection.from, selection.to);
      return matches.map((match) => ({
        from: match.start,
        active: match.start === selectionFrom && match.end === selectionTo
      }));
    }
  });
  syncModeClasses();
  syncLineNumbersVisibility();
  syncGitGutterVisibility();
  syncSelectionClass();
  view.dispatch({ effects: setDiagnosticsEffect.of(currentDiagnostics) });
  emitSelectionChange();

  return {
    view,
    state: view.state,
    getText() {
      commitActiveTableInput();
      return view.state.doc.toString();
    },
    revealDocumentFragment(href: string) {
      const fragmentHref = href.startsWith('#') ? href : `#${href}`;
      return openHref(fragmentHref, view);
    },
    commitTransientEdits() {
      return commitActiveTableInput();
    },
    selectAll() {
      view.dispatch({
        selection: {
          anchor: 0,
          head: view.state.doc.length
        }
      });
      return true;
    },
    undo() {
      return requestEditorHistoryReplay('undo');
    },
    redo() {
      return requestEditorHistoryReplay('redo');
    },
    getHistoryDepth() {
      return { undo: undoDepth(view.state), redo: redoDepth(view.state) };
    },
    findNext(query: string, options: SearchOptions & { focusEditor?: boolean } = {}) {
      return findMatch(query, false, options);
    },
    findPrevious(query: string, options: SearchOptions & { focusEditor?: boolean } = {}) {
      return findMatch(query, true, options);
    },
    replaceCurrent(query: string, replacement: string, options: SearchOptions = {}) {
      return replaceCurrentMatch(query, replacement, options);
    },
    replaceAll(query: string, replacement: string, options: SearchOptions = {}) {
      if (!query) {
        return { replaced: 0, total: 0 };
      }

      const text = view.state.doc.toString();
      const matches = getSearchMatches(query, options);
      const replaced = matches.length;
      if (!replaced) {
        return { replaced: 0, total: 0 };
      }

      const nextText = replaceMatchRanges(text, matches, replacement);
      view.dispatch({
        changes: { from: 0, to: text.length, insert: nextText },
        selection: { anchor: 0 }
      });
      return { replaced, total: getSearchMatches(query, options).length };
    },
    countMatches(query: string, options: SearchOptions = {}) {
      if (!query) {
        return 0;
      }
      return getSearchMatches(query, options).length;
    },
    setSearchQuery(query: string, options: SearchOptions = {}) {
      const nextQuery = createSearchQueryState(query, options);
      const currentQuery = view.state.field(searchQueryField);
      if (
        currentQuery.text === nextQuery.text &&
        currentQuery.wholeWord === nextQuery.wholeWord &&
        currentQuery.caseSensitive === nextQuery.caseSensitive
      ) {
        return;
      }
      view.dispatch({
        effects: [
          setSearchQueryEffect.of(nextQuery),
          setLongCodeBlockSearchRevealEffect.of(null),
          setMermaidSearchRevealEffect.of(null),
          setLatexMathSearchRevealEffect.of(null),
          preserveLiveDecorationsForSearchEffect.of(undefined)
        ]
      });
      scheduleLiveSearchDecorationRefresh();
    },
    hasFocus() {
      return view.hasFocus;
    },
    focus() {
      const activeTableInput = getActiveTableInput();
      if (activeTableInput) {
        activeTableInput.focus({ preventScroll: true });
        return;
      }
      view.focus();
    },
    destroy() {
      view.dom.classList.remove('meo-live-pointer-selecting');
      gitDiffContentHover?.destroy();
      gitDiffContentHover = null;
      gitDiffOverviewRuler?.destroy();
      gitDiffOverviewRuler = null;
      searchOverviewRuler?.destroy();
      searchOverviewRuler = null;
      if (pendingLiveSearchDecorationRefreshFrame !== null) {
        cancelAnimationFrame(pendingLiveSearchDecorationRefreshFrame);
        pendingLiveSearchDecorationRefreshFrame = null;
      }
      if (onScroll) {
        view.scrollDOM.removeEventListener('scroll', onScroll);
        onScroll = null;
      }
      if (imeCompositionFlushTimer !== null) {
        window.clearTimeout(imeCompositionFlushTimer);
        imeCompositionFlushTimer = null;
      }
      if (onTableInteraction) {
        view.dom.removeEventListener('meo-table-interaction', onTableInteraction);
        onTableInteraction = null;
      }
      if (onWidgetOpenLink) {
        view.dom.removeEventListener('meo-open-link', onWidgetOpenLink);
        onWidgetOpenLink = null;
      }
      if (onWidgetActivateImage) {
        view.dom.removeEventListener('meo-activate-image', onWidgetActivateImage);
        onWidgetActivateImage = null;
      }
      if (onTableSelectionChange) {
        view.dom.removeEventListener('meo-table-selection-change', onTableSelectionChange);
        onTableSelectionChange = null;
      }
      if (onHtmlContentPointerDown) {
        view.dom.removeEventListener('pointerdown', onHtmlContentPointerDown, true);
        onHtmlContentPointerDown = null;
      }
      if (onBlockActionPointerMove) {
        view.dom.removeEventListener('pointermove', onBlockActionPointerMove);
        onBlockActionPointerMove = null;
      }
      if (onBlockActionPointerLeave) {
        view.dom.removeEventListener('pointerleave', onBlockActionPointerLeave);
        onBlockActionPointerLeave = null;
      }
      if (blockActionToolbarReconcileFrame !== null) {
        window.cancelAnimationFrame(blockActionToolbarReconcileFrame);
        blockActionToolbarReconcileFrame = null;
      }
      if (onDocumentSelectionChange) {
        document.removeEventListener('selectionchange', onDocumentSelectionChange);
        onDocumentSelectionChange = null;
      }
      if (onWindowPointerUp) {
        window.removeEventListener('pointerup', onWindowPointerUp, true);
        onWindowPointerUp = null;
      }
      if (onWindowPointerCancel) {
        window.removeEventListener('pointercancel', onWindowPointerCancel, true);
        onWindowPointerCancel = null;
      }
      if (onWindowBlur) {
        window.removeEventListener('blur', onWindowBlur);
        onWindowBlur = null;
      }
      if (capturedPointerId !== null) {
        releasePointerCaptureIfHeld(capturedPointerId);
        capturedPointerId = null;
      }
      pendingLiveSearchRevealGeneration += 1;
      if (pendingLiveSearchRevealFrame !== null) {
        window.cancelAnimationFrame(pendingLiveSearchRevealFrame);
        pendingLiveSearchRevealFrame = null;
      }
      setEditableLinkHoverCursor(view, false);
      editorHistoryRuntime?.dispose();
      editorHistoryRuntime = null;
      tableCommandRuntime.dispose();
      viewportController.destroy();
      tableTransactionProvenanceAdapter.dispose();
      tableColumnWidthAdapter.adapter.dispose();
      view.destroy();
      imagePresentationFactory.dispose();
      imagePresentationResourcePool.dispose();
    },
    setText(textValue: string) {
      tableCommandRuntime.externalDocumentPresented();
      imagePresentationFactory.externalDocumentPresented();
      void editorHistoryRuntime?.dispatch({ type: 'externalDocumentPresented' });
      recentRenderedReplayPresentation = null;
      const currentText = view.state.doc.toString();
      const syncChange = findSyncChange(currentText, textValue);
      if (!syncChange) {
        view.dispatch({
          effects: tableTransactionProvenanceAdapter.effect({ type: 'externalDocumentPresented' }),
          annotations: Transaction.addToHistory.of(false)
        });
        tableColumnWidthAdapter.adapter.refresh();
        return;
      }

      mermaidDiagramPresentationFactory.externalDocumentPresented();

      const viewportAnchor = captureViewportAnchor();
      const { anchor, head } = view.state.selection.main;
      const newLength = textValue.length;
      const mappedAnchor = Math.min(mapPositionThroughTextChange(anchor, currentText, textValue, syncChange), newLength);
      const mappedHead = Math.min(mapPositionThroughTextChange(head, currentText, textValue, syncChange), newLength);
      const mappedViewportAnchor = Math.min(
        mapPositionThroughTextChange(viewportAnchor.position, currentText, textValue, syncChange),
        newLength
      );
      clearLivePointerSelection();
      setTableInteractionActive(false);
      applyingExternal = true;
      try {
        view.dispatch({
          changes: syncChange,
          selection: { anchor: mappedAnchor, head: mappedHead },
          effects: tableTransactionProvenanceAdapter.effect({ type: 'externalDocumentPresented' }),
          annotations: Transaction.addToHistory.of(false)
        });
      } finally {
        applyingExternal = false;
      }
      tableColumnWidthAdapter.adapter.refresh();
      restoreViewportAnchor(mappedViewportAnchor, viewportAnchor.lineOffset);
      syncSelectionClass();
      emitSelectionChange();
    },
    setMode(mode: EditableEditorMode) {
      commitActiveTableInput();
      const nextMode = mode === 'live' ? 'live' : 'source';
      if (nextMode === currentMode) {
        return;
      }

      void editorHistoryRuntime?.dispatch({ type: 'presentationChanged' });
      recentRenderedReplayPresentation = null;

      const topPosition = computeTopVisiblePosition();
      viewportController.markInteraction();

      const previousMode = currentMode;
      currentMode = nextMode;
      try {
        view.dispatch({
          effects: [
            modeCompartment.reconfigure(nextMode === 'live' ? liveModeExtensions() : sourceMode()),
            gitGutterCompartment.reconfigure(
              nextMode === 'live' ? gitDiffGutterLiveRenderExtensions() : gitDiffGutterRenderExtensions()
            )
          ]
        });
        forceParsing(view, view.state.doc.length, 500);
      } catch (error) {
        currentMode = previousMode;
        syncModeClasses();
        throw error;
      }
      syncModeClasses();
      syncGitGutterVisibility();

      restoreTopVisibleLine(topPosition.lineNumber, topPosition.lineOffset, { syncCursor: false, force: true });
    },
    setLineNumbers(visible: boolean) {
      const nextVisible = visible !== false;
      if (nextVisible === lineNumbersVisible) {
        return;
      }
      lineNumbersVisible = nextVisible;
      syncLineNumbersVisibility();
    },
    setLongCodeBlockFoldingEnabled(enabled: boolean) {
      setLongCodeBlockFoldingEnabled(view, enabled === true);
    },
    setGitGutterVisible(visible: boolean) {
      const nextVisible = visible !== false;
      if (nextVisible === gitGutterVisible) {
        return;
      }
      gitGutterVisible = nextVisible;
      syncGitGutterVisibility();
    },
    insertFormat(action: EditorFormatAction, level?: EditorFormatLevel) {
      const activeTableInput = getActiveTableInput();
      if (activeTableInput) {
        return insertFormatInActiveTableInput(activeTableInput, action);
      }

      const { state } = view;
      const selection = state.selection.main;
      let cachedInlineSelection: InlineSelectionRange | null = null;
      const inlineSelection = (): InlineSelectionRange => {
        if (cachedInlineSelection) {
          return cachedInlineSelection;
        }
        cachedInlineSelection = currentMode === 'live'
          ? normalizeLiveInlineSelectionForListContent(state, selection)
          : selection;
        return cachedInlineSelection;
      };

      let insert = '';
      switch (action) {
        case 'heading':
          insert = `${'#'.repeat(typeof level === 'number' ? level : 1)} `;
          break;
        case 'bulletList':
          insert = '- ';
          break;
        case 'numberedList':
          insert = '1. ';
          break;
        case 'task':
          insert = '- [ ] ';
          break;
        case 'codeBlock':
          return insertCodeBlock(view, selection);
        case 'inlineCode':
          return insertInlineCode(view, inlineSelection());
        case 'kbd':
          return insertKbd(view, inlineSelection());
        case 'underline':
          return insertUnderline(view, inlineSelection());
        case 'bold':
          return insertInlineFence(view, inlineSelection(), '**');
        case 'italic':
          return insertInlineFence(view, inlineSelection(), '*');
        case 'lineover':
        case 'strike':
          return insertInlineFence(view, inlineSelection(), '~~');
        case 'highlight':
          return insertInlineFence(view, inlineSelection(), '==');
        case 'quote':
          return insertQuote(view, selection);
        case 'hr':
          return insertHr(view, selection);
        case 'table':
          return insertTable(
            view,
            selection,
            typeof level === 'object' ? level.cols : undefined,
            typeof level === 'object' ? level.rows : undefined
          );
        case 'link':
          return insertLink(view, inlineSelection());
        case 'wikiLink':
          return insertWikiLink(view, inlineSelection());
        case 'image':
          return insertImage(view, inlineSelection());
      }

      if (!selection.empty && (action === 'bulletList' || action === 'numberedList')) {
        const changes = buildListFormatChangesForSelection(state, insert);
        dispatchSelectedListFormatChanges(state, changes, action === 'numberedList');
        return;
      }

      const line = state.doc.lineAt(selection.from);
      const { contentStart, oldMarkerLen, isExistingTask } = lineMarkerReplacementContext(state, line);
      if (action === 'task' && isExistingTask) {
        return;
      }

      const newMarkerLen = insert.length;
      const cursorOffset = selection.from - (contentStart + oldMarkerLen);
      const newCursorPos = contentStart + newMarkerLen + Math.max(0, cursorOffset);

      view.dispatch({
        changes: { from: contentStart, to: contentStart + oldMarkerLen, insert },
        selection: { anchor: newCursorPos }
      });
    },
    getHeadings() {
      return extractHeadings(view.state);
    },
    getViewportAnchorOffset(ratio = 0.2) {
      const normalizedRatio = Math.min(1, Math.max(0, Number.isFinite(ratio) ? ratio : 0.2));
      const height = view.scrollDOM.scrollTop + view.scrollDOM.clientHeight * normalizedRatio;
      return view.lineBlockAtHeight(height).from;
    },
    getVisibleDocumentRange() {
      const top = view.lineBlockAtHeight(view.scrollDOM.scrollTop);
      const bottom = view.lineBlockAtHeight(view.scrollDOM.scrollTop + view.scrollDOM.clientHeight);
      return {
        from: top.from,
        to: bottom.to,
        fromLine: view.state.doc.lineAt(top.from).number,
        toLine: view.state.doc.lineAt(bottom.to).number
      };
    },
    getScrollElement() {
      return view.scrollDOM;
    },
    scrollToLine(lineNumber: number, align: RevealOptions['align'] = 'center') {
      const line = view.state.doc.line(Math.min(lineNumber, view.state.doc.lines));
      if (align === 'upper' && revealRenderedTableLine(line.number)) {
        return;
      }
      if (align === 'upper' && revealRenderedSourceLine(line.number)) {
        return;
      }
      const targetIsVisible = align === 'upper' && isPositionVisible(line.from);
      const effectiveAlign = targetIsVisible ? 'nearest' : align;
      applyRevealSelection(line.from, line.from, { focusEditor: true, align: effectiveAlign });
      if (align === 'top') {
        // Outline navigation must survive delayed block-widget measurements.
        restoreTopVisibleLine(line.number, 0, { syncCursor: false });
      }
    },
    restoreTopLine(lineNumber: number, lineOffset: number, { syncCursor = true, force = false }: { syncCursor?: boolean; force?: boolean } = {}) {
      restoreTopVisibleLine(lineNumber, lineOffset, { syncCursor, force });
    },
    getTopVisiblePosition() {
      const position = computeTopVisiblePosition();
      return {
        line: position.lineNumber,
        lineOffset: position.lineOffset
      };
    },
    getTopVisibleLine() {
      return computeTopVisiblePosition().lineNumber;
    },
    revealSelection(anchor: number, head: number, options?: RevealOptions) {
      applyRevealSelection(anchor, head, options);
    },
    refreshSelectionOverlay() {
      emitSelectionChange();
    },
    refreshDecorations() {
      view.dispatch({ effects: refreshDecorationsEffect.of(null) });
      refreshTableLocalLinkIndicators(view.dom);
    },
    preserveViewport(mutate: () => void) {
      viewportController.preserveDocumentAnchorWhileMutation(mutate);
    },
    setDiagnostics(diagnostics: EditorDiagnostic[]) {
      currentDiagnostics = Array.isArray(diagnostics) ? diagnostics : [];
      view.dispatch({ effects: setDiagnosticsEffect.of(currentDiagnostics) });
    },
    refreshLayout() {
      view.requestMeasure();
      if (currentMode === 'live') {
        forceParsing(view, view.state.doc.length, 500);
      }
      emitSelectionChange();
    },
    setGitBaseline(snapshot: GitBaselinePayload) {
      // Baseline decorations can change rendered line heights (especially around
      // tables, images, Mermaid, and math). Keep the document anchor stable while
      // the decoration transaction and its deferred measurements settle.
      viewportController.preserveDocumentAnchorWhileMutation(() => {
        view.dispatch({
          effects: [
            setGitBaselineEffect.of(snapshot),
            tableTransactionProvenanceAdapter.effect({ type: 'baselineRefreshed' })
          ]
        });
        gitDiffContentHover?.hide();
        gitDiffOverviewRuler?.refresh();
      });
    }
  };
}

function insertTableCellLineBreak(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!isInsideTableCell(state, selection.from) || !isInsideTableCell(state, selection.to)) {
    return false;
  }

  const insert = '<br>';
  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: { anchor: selection.from + insert.length }
  });
  return true;
}

function handleEnterContinueQuotedCodeBlock(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }

  const quotePrefix = getQuotedCodeBlockLinePrefix(state, selection.from);
  if (!quotePrefix) {
    return false;
  }

  const insert = `\n${quotePrefix}`;
  const nextPos = selection.from + insert.length;
  view.dispatch({
    changes: { from: selection.from, to: selection.from, insert },
    selection: { anchor: nextPos }
  });
  return true;
}

function getQuotedCodeBlockLinePrefix(state: EditorState, position: number): string | null {
  const line = state.doc.lineAt(position);
  const lineText = state.doc.sliceString(line.from, line.to);
  const match = blockquoteLinePrefixRegex.exec(lineText);
  if (!match) {
    return null;
  }

  return isInsideQuotedCodeBlock(state, position) ? match[0] : null;
}

function isInsideQuotedCodeBlock(state: EditorState, position: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, -1);
  let insideCodeBlock = false;
  let insideBlockquote = false;

  while (node) {
    if (quotedCodeBlockAncestorNames.has(node.name)) {
      insideCodeBlock = true;
    } else if (node.name === 'Blockquote') {
      insideBlockquote = true;
    }
    if (insideCodeBlock && insideBlockquote) {
      return true;
    }
    node = node.parent;
  }

  return false;
}

function deleteTableCellLineBreakBackward(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }

  const pos = selection.from;
  if (!isInsideTableCell(state, pos)) {
    return false;
  }

  const from = Math.max(0, pos - 8);
  const before = state.doc.sliceString(from, pos);
  const match = /<br\s*\/?>$/i.exec(before);
  if (!match) {
    return false;
  }

  const start = pos - match[0].length;
  view.dispatch({
    changes: { from: start, to: pos },
    selection: { anchor: start }
  });
  return true;
}

function deleteBackwardSmart(view: EditorView): boolean {
  return handleBackspaceAtListContentStart(view) || deleteTableCellLineBreakBackward(view);
}

function isInsideTableCell(state: EditorState, position: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, -1);
  while (node) {
    if (node.name === 'TableCell') {
      return true;
    }
    if (node.name === 'TableDelimiter' || node.name === 'Table') {
      return false;
    }
    node = node.parent;
  }
  return false;
}

function isTableHistoryRange(
  state: EditorState,
  range: { readonly from: number; readonly to: number }
): boolean {
  const positions = new Set([
    Math.min(range.from, state.doc.length),
    Math.min(Math.max(range.from, range.to - 1), state.doc.length)
  ]);
  for (const position of positions) {
    let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, -1);
    while (node) {
      if (node.name === 'Table') return true;
      node = node.parent;
    }
  }
  return false;
}

function findSyncChange(previousText: string, nextText: string): SyncChange | null {
  if (previousText === nextText) {
    return null;
  }

  let from = 0;
  const maxStart = Math.min(previousText.length, nextText.length);
  while (from < maxStart && previousText.charCodeAt(from) === nextText.charCodeAt(from)) {
    from += 1;
  }

  let previousTo = previousText.length;
  let nextTo = nextText.length;
  while (
    previousTo > from &&
    nextTo > from &&
    previousText.charCodeAt(previousTo - 1) === nextText.charCodeAt(nextTo - 1)
  ) {
    previousTo -= 1;
    nextTo -= 1;
  }

  return {
    from,
    to: previousTo,
    insert: nextText.slice(from, nextTo)
  };
}

// Map a position through a single replace change so external syncs keep the cursor nearby.
function mapPositionThroughChange(position: number, change: SyncChange): number {
  const insertLength = change.insert.length;
  const deletedLength = change.to - change.from;
  const delta = insertLength - deletedLength;

  if (position <= change.from) {
    return position;
  }

  if (position >= change.to) {
    return position + delta;
  }

  return change.from + insertLength;
}

function mapPositionThroughTextChange(position: number, previousText: string, nextText: string, change: SyncChange): number {
  if (position <= change.from || position >= change.to) {
    return mapPositionThroughChange(position, change);
  }

  const contextRadius = 80;
  const contextFrom = Math.max(change.from, position - contextRadius);
  const contextTo = Math.min(change.to, position + contextRadius);
  const context = previousText.slice(contextFrom, contextTo);
  if (context.length >= 16) {
    const contextIndex = nextText.indexOf(context);
    if (contextIndex >= 0 && nextText.indexOf(context, contextIndex + 1) < 0) {
      return contextIndex + (position - contextFrom);
    }
  }

  const lineFrom = previousText.lastIndexOf('\n', Math.max(0, position - 1)) + 1;
  const lineBreak = previousText.indexOf('\n', position);
  const lineTo = lineBreak < 0 ? previousText.length : lineBreak;
  const lineText = previousText.slice(lineFrom, lineTo);
  if (lineText.trim()) {
    const expected = mapPositionThroughChange(position, change);
    let bestLineFrom = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let searchFrom = 0;
    while (searchFrom <= nextText.length) {
      const match = nextText.indexOf(lineText, searchFrom);
      if (match < 0) break;
      const distance = Math.abs(match - expected);
      if (distance < bestDistance) {
        bestLineFrom = match;
        bestDistance = distance;
      }
      searchFrom = match + Math.max(1, lineText.length);
    }
    if (bestLineFrom >= 0) {
      return bestLineFrom + Math.min(position - lineFrom, lineText.length);
    }
  }

  const replacedLength = change.to - change.from;
  if (replacedLength > 0 && change.insert.length > 0) {
    const relativeOffset = (position - change.from) / replacedLength;
    return change.from + Math.round(relativeOffset * change.insert.length);
  }

  return mapPositionThroughChange(position, change);
}

function createSearchQueryState(query: string | null | undefined, options: SearchOptions = {}): SearchQueryState {
  return {
    text: query ?? '',
    wholeWord: options.wholeWord === true,
    caseSensitive: options.caseSensitive === true
  };
}

function isWordBoundaryCharacter(value: string): boolean {
  return /[0-9A-Za-z_]/.test(value);
}

function isWholeWordRange(text: string, start: number, end: number): boolean {
  const previous = start > 0 ? text.slice(start - 1, start) : '';
  const next = end < text.length ? text.slice(end, end + 1) : '';
  return !isWordBoundaryCharacter(previous) && !isWordBoundaryCharacter(next);
}

function findSearchMatchRanges(text: string, query: string, options: SearchOptions = {}): SearchMatchRange[] {
  if (!query) {
    return [];
  }

  const haystack = options.caseSensitive ? text : text.toLocaleLowerCase();
  const needle = options.caseSensitive ? query : query.toLocaleLowerCase();
  const matches: SearchMatchRange[] = [];
  let offset = 0;
  while (offset <= text.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) {
      break;
    }

    const end = index + query.length;
    if (!options.wholeWord || isWholeWordRange(text, index, end)) {
      matches.push({ start: index, end });
    }
    offset = end;
  }
  return matches;
}

function findSelectedSearchMatchIndex(matches: SearchMatchRange[], from: number, to: number): number {
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index].start === from && matches[index].end === to) {
      return index;
    }
  }
  return -1;
}

function replaceMatchRanges(text: string, matches: SearchMatchRange[], replacement: string): string {
  if (!matches.length) {
    return text;
  }

  let nextText = '';
  let offset = 0;
  for (const match of matches) {
    nextText += text.slice(offset, match.start);
    nextText += replacement;
    offset = match.end;
  }
  nextText += text.slice(offset);
  return nextText;
}

function normalizeLiveInlineSelectionForListContent(
  state: EditorState,
  selection: InlineSelectionRange
): InlineSelectionRange {
  if (selection.empty) {
    return selection;
  }

  let from = Math.min(selection.from, selection.to);
  const to = Math.max(selection.from, selection.to);
  if (to <= from) {
    return selection;
  }

  const startLine = state.doc.lineAt(from);
  const endLine = state.doc.lineAt(to - 1);
  if (startLine.number !== endLine.number) {
    return selection;
  }

  const lineText = state.doc.sliceString(startLine.from, startLine.to);
  const marker = listMarkerData(lineText);
  if (!marker) {
    return selection;
  }

  const contentFrom = startLine.from + marker.toOffset;
  if (from >= contentFrom || to <= contentFrom) {
    return selection;
  }

  from = contentFrom;
  if (from >= to) {
    return selection;
  }

  if (selection.anchor <= selection.head) {
    return { from, to, anchor: from, head: to, empty: false };
  }
  return { from, to, anchor: to, head: from, empty: false };
}

function insertInlineCode(view: EditorView, selection: InlineSelectionRange | SelectionRange): void {
  const { state } = view;

  if (!selection.empty) {
    let from = Math.min(selection.from, selection.to);
    let to = Math.max(selection.from, selection.to);
    while (to > from && state.doc.sliceString(to - 1, to) === '\n') {
      to -= 1;
    }
    const selectedText = state.doc.sliceString(from, to);
    const insert = `\`${selectedText}\``;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length }
    });
    return;
  }

  const insert = '``';
  view.dispatch({
    changes: { from: selection.from, insert },
    selection: { anchor: selection.from + 1 }
  });
}

function toggleInlineWrapper(
  view: EditorView,
  selection: InlineSelectionRange | SelectionRange,
  openMarker: string,
  closeMarker = openMarker
): void {
  const { state } = view;

  if (selection.empty) {
    const insert = `${openMarker}${closeMarker}`;
    view.dispatch({
      changes: { from: selection.from, insert },
      selection: { anchor: selection.from + openMarker.length }
    });
    return;
  }

  const from = Math.min(selection.from, selection.to);
  let to = Math.max(selection.from, selection.to);
  while (to > from && state.doc.sliceString(to - 1, to) === '\n') {
    to -= 1;
  }

  const hasOpenMarker =
    from >= openMarker.length && state.doc.sliceString(from - openMarker.length, from) === openMarker;
  const hasCloseMarker = state.doc.sliceString(to, to + closeMarker.length) === closeMarker;

  if (hasOpenMarker && hasCloseMarker) {
    view.dispatch({
      changes: [
        { from: to, to: to + closeMarker.length, insert: '' },
        { from: from - openMarker.length, to: from, insert: '' }
      ],
      selection: {
        anchor: from - openMarker.length,
        head: to - openMarker.length
      }
    });
    return;
  }

  view.dispatch({
    changes: [
      { from: to, insert: closeMarker },
      { from, insert: openMarker }
    ],
    selection: {
      anchor: from + openMarker.length,
      head: to + openMarker.length
    }
  });
}

function insertKbd(view: EditorView, selection: InlineSelectionRange | SelectionRange): void {
  return toggleInlineWrapper(view, selection, '<kbd>', '</kbd>');
}

const changedCodeMirrorDocumentRange = (before: Text, after: Text): { from: number; to: number } | null => {
  const sharedLength = Math.min(before.length, after.length);
  let prefixLow = 0;
  let prefixHigh = sharedLength;
  while (prefixLow < prefixHigh) {
    const middle = Math.ceil((prefixLow + prefixHigh) / 2);
    if (before.slice(0, middle).eq(after.slice(0, middle))) prefixLow = middle;
    else prefixHigh = middle - 1;
  }
  const from = prefixLow;
  if (from === before.length && from === after.length) return null;

  let suffixLow = 0;
  let suffixHigh = sharedLength - from;
  while (suffixLow < suffixHigh) {
    const middle = Math.ceil((suffixLow + suffixHigh) / 2);
    if (before.slice(before.length - middle).eq(after.slice(after.length - middle))) suffixLow = middle;
    else suffixHigh = middle - 1;
  }
  return { from, to: after.length - suffixLow };
};

function insertUnderline(view: EditorView, selection: InlineSelectionRange | SelectionRange): void {
  return toggleInlineWrapper(view, selection, '<u>', '</u>');
}

function insertInlineFence(view: EditorView, selection: InlineSelectionRange | SelectionRange, marker: string): void {
  return toggleInlineWrapper(view, selection, marker);
}

function insertQuote(view: EditorView, selection: InlineSelectionRange | SelectionRange): void {
  const { state } = view;
  const line = state.doc.lineAt(selection.from);
  const lineText = state.doc.sliceString(line.from, line.to);

  const existingQuote = /^(\s*)(>\s*)/.exec(lineText);
  if (existingQuote) {
    return;
  }

  const leadingWhitespace = /^(\s*)/.exec(lineText)?.[1] ?? '';
  const insert = '> ';
  const contentStart = line.from + leadingWhitespace.length;
  const cursorOffset = selection.from - contentStart;

  view.dispatch({
    changes: { from: contentStart, insert },
    selection: { anchor: contentStart + insert.length + cursorOffset }
  });
}

function insertHr(view: EditorView, selection: InlineSelectionRange | SelectionRange): void {
  const { state } = view;
  const line = state.doc.lineAt(selection.from);
  const lineText = state.doc.sliceString(line.from, line.to);
  const trimmed = lineText.trim();

  if (!trimmed) {
    const insert = '---';
    const cursorPos = line.from + insert.length;
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: cursorPos }
    });
  } else {
    const insert = '\n---';
    const cursorPos = line.to + insert.length;
    view.dispatch({
      changes: { from: line.to, insert },
      selection: { anchor: cursorPos }
    });
  }
}

function insertLink(view: EditorView, selection: InlineSelectionRange | SelectionRange): void {
  const { state } = view;

  if (!selection.empty) {
    let from = Math.min(selection.from, selection.to);
    let to = Math.max(selection.from, selection.to);
    while (to > from && state.doc.sliceString(to - 1, to) === '\n') {
      to -= 1;
    }
    const selectedText = state.doc.sliceString(from, to);
    const insert = `[${selectedText}]()`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length - 1 }
    });
    return;
  }

  const insert = '[]()';
  view.dispatch({
    changes: { from: selection.from, insert },
    selection: { anchor: selection.from + 3 }
  });
}

function insertImage(view: EditorView, selection: InlineSelectionRange | SelectionRange): void {
  const { state } = view;

  if (!selection.empty) {
    let from = Math.min(selection.from, selection.to);
    let to = Math.max(selection.from, selection.to);
    while (to > from && state.doc.sliceString(to - 1, to) === '\n') {
      to -= 1;
    }
    const selectedText = state.doc.sliceString(from, to);
    const insert = `![${selectedText}]()`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length - 1 }
    });
    return;
  }

  const insert = '![]()';
  view.dispatch({
    changes: { from: selection.from, insert },
    selection: { anchor: selection.from + 4 }
  });
}

function insertWikiLink(view: EditorView, selection: InlineSelectionRange | SelectionRange): void {
  const { state } = view;

  if (!selection.empty) {
    let from = Math.min(selection.from, selection.to);
    let to = Math.max(selection.from, selection.to);
    while (to > from && state.doc.sliceString(to - 1, to) === '\n') {
      to -= 1;
    }
    const selectedText = state.doc.sliceString(from, to);
    const insert = `[[${selectedText}]]`;
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length }
    });
    return;
  }

  const insert = '[[]]';
  view.dispatch({
    changes: { from: selection.from, insert },
    selection: { anchor: selection.from + 2 }
  });
}

function sourceMode(): Extension[] {
  return [
    markdown({
      base: markdownLanguage,
      addKeymap: false,
      codeLanguages: resolveCodeLanguage,
      extensions: [highlightMarkdownExtension, { remove: ['SetextHeading'] }]
    }),
    syntaxHighlighting(sourceHighlightStyle),
    sourceCodeBlockField,
    sourceListMarkerField,
    sourceStrikeMarkerField,
    sourceHighlightField,
    sourceWikiMarkerField,
    sourceFileLinkField,
    sourceUrlBoundaryField,
    sourceFootnoteMarkerField,
    markdownTagField,
    sourceTableHeaderLineField,
    sourceFrontmatterField,
    gitDiffLineHighlightsField,
    ...mergeConflictSourceExtensions()
  ];
}

const blockedInlineSelectionAncestors = new Set([
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'InlineCode',
  'URL',
  'Autolink',
  'HTMLBlock',
  'HTMLTag',
  'TableDelimiter'
]);

const latexSelectionBlockCache = new WeakMap<object, Array<{ from: number; to: number }>>();

function hasBlockedInlineAncestor(state: EditorState, position: number): boolean {
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(position, 1);
  while (node) {
    if (blockedInlineSelectionAncestors.has(node.name)) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

function getLatexSelectionBlockRanges(state: EditorState): Array<{ from: number; to: number }> {
  const docKey = state.doc as unknown as object;
  const cached = latexSelectionBlockCache.get(docKey);
  if (cached) {
    return cached;
  }

  const text = state.doc.toString();
  if (text.indexOf('$') === -1) {
    latexSelectionBlockCache.set(docKey, []);
    return [];
  }

  const ranges = collectLatexMathRanges(text).map((range) => ({ from: range.from, to: range.to }));
  latexSelectionBlockCache.set(docKey, ranges);
  return ranges;
}

function overlapsLatexMathSelection(state: EditorState, from: number, to: number): boolean {
  if (to <= from) {
    return false;
  }
  const ranges = getLatexSelectionBlockRanges(state);
  for (const range of ranges) {
    if (range.from < to && range.to > from) {
      return true;
    }
  }
  return false;
}

function isRegularInlineSelection(state: EditorState, from: number, to: number): boolean {
  if (to <= from) {
    return false;
  }
  const text = state.doc.sliceString(from, to);
  const trimmedText = text.trim();
  if (!trimmedText) {
    return false;
  }
  if (trimmedText.includes('\n')) {
    return false;
  }
  if (hasBlockedInlineAncestor(state, from) || hasBlockedInlineAncestor(state, to - 1)) {
    return false;
  }
  if (overlapsLatexMathSelection(state, from, to)) {
    return false;
  }
  return true;
}
