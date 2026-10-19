import { editorScrollIntoView, isEditorScrollEffect } from './editor/scrollEffects';
import { documentLines } from './helpers/documentLines';
import { isAutomaticSymbolPairHistoryEffect } from './editor/typingAssistance';
import { liveWidgetPresentationLayers, mapLiveWidgetPositions, mapStableLiveDecorations, prepareLiveWidgetPositions, replaceLivePresentationRanges } from './editor/liveWidgetPositions';
import { livePresentationWindow } from './helpers/livePresentationWindow';
import { liveViewportPresentationExtensions, restrictLiveWidgetPresentation, getLivePresentationBand,
  isLiveViewportPresentationEffect, livePresentationBandChanged } from './helpers/liveViewportPresentation';
import { undoDepth } from '@codemirror/commands';
import { blockStickyHeaderExtension } from './helpers/blockStickyHeader';
import { countColumn, RangeSetBuilder, StateEffect, StateField, EditorState, type ChangeDesc, type Range, type RangeSet, type Extension, type EditorSelection, type Transaction } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, syntaxTreeAvailable } from '@codemirror/language';
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutterLineClass,
  lineNumberWidgetMarker,
  type DecorationSet
} from '@codemirror/view';
import { IterMode, type SyntaxNode, type SyntaxNodeRef, type Tree } from '@lezer/common';
import { createElement, AlertCircle, Code2, Delete } from 'lucide';
import {
  resolveCodeLanguage,
  isFenceMarker,
  addFenceOpeningLineMarker,
  addCodeLanguageLabel,
  addCodeBlockLineNumbers,
  codeBlockLineNumberDecoration,
  addTopLineCopyButton,
  addTopLinePillLabel,
  addMermaidDiagram,
  addCopyCodeButton
} from './helpers/codeBlocks';
import { ImageGroupWidget, ImageWidget, getImageData, isImageUrl, type ImageGroupItem } from './helpers/images';
import { getImagePresentationFactory } from './editor/imagePresentation';
import { liveHighlightStyle, sourceMarkdownHighlightProps } from './theme';
import { inlineMarkdownExtensions } from './helpers/inlineMarkdownParser';
import { collectKbdTagRangesFromText, hasKbdTagMarker } from './helpers/kbd';
import { currentSyntaxTree, getFencedCodeInfo, headingContentRange, headingLevelFromName, resolvedSyntaxTree, syntaxTreeChanged, withMarkdownSyntaxSnapshot } from './helpers/markdownSyntax';
import { hasSameLiveMarkdownSyntax, hasSameLiveMarkdownOutsideBlock } from './helpers/livePresentationSyntax';
import { indexSourceRanges } from './helpers/sourceRangeIndex';
import { detailsBlockLiveExtensions, getDetailsBlocks, toggleDetailsBlock } from './helpers/detailsBlocks';
import {
  addListMarkerDecoration,
  listMarkerData,
  detectListIndentStylesByLine,
  nextOrderedSequenceNumber
} from './helpers/listMarkers';
import { addTableDecorations, addTableDecorationsForLineRange, isTableDelimiterLine, parseTableInfo } from './helpers/tables';
import {
  forEachYamlFrontmatterLayoutLine,
  parseFrontmatter,
  parseFrontmatterCandidate,
  parseSimpleYamlFlowArrayValue,
  isInsideFrontmatter,
  isInsideFrontmatterContent,
  isThematicBreakLine,
  type FrontmatterInfo
} from './helpers/frontmatter';
import { isWikiLinkNode, parseWikiLinkData, getWikiLinkStatus, getWikiLinkIssue } from './helpers/wikiLinks';
import {
  createMissingLocalLinkIndicator,
  isMissingLocalLinkTarget
} from './helpers/localLinks';
import { mergeConflictSourceExtensions, parseMergeConflicts } from './helpers/mergeConflicts';
import {
  AlertType,
  type AlertBlock,
  AlertIconWidget,
  detectAlertInBlockquote
} from './helpers/alerts';
import {
  parseFootnotes,
  projectUnchangedFootnotes,
  footnoteReferenceKey,
  type FootnoteReference,
  type ParsedFootnotes
} from './helpers/footnotes';
import { getLiveRenderedBlocks, projectUnchangedLiveRenderedBlocks, type LiveRenderedBlock } from './helpers/liveRenderedBlocks';
import { findRawSourceUrlMatches, normalizeSourceHref } from './helpers/rawUrls';
import { trimDecoratedUrlRange } from './helpers/urlDecorationRange';
import { createOpenLinkButton } from './helpers/linkOpenButton';
import { getViewportController } from './helpers/viewportController';
import { estimateBlockWidgetHeight } from './editor/blockWidgetHeight';
import { collectInlineFootnoteMarkerRanges } from './helpers/inlineFootnotes';
import {
  renderLatexMathToHtml,
  type LatexMathRange,
  type LatexMathMode
} from './helpers/math';
import { collectDocumentMathRanges, getDisplayMathSource, type DocumentMathRange } from './helpers/displayMathBlocks';
import { isMathFenceLanguage } from '../../src/shared/mathFence';
import { diagnosticDataField, type EditorDiagnostic } from './helpers/diagnostics';
import { gitDiffLineFlagsField, isGitDiffPresentationEffect } from './helpers/gitDiffGutter';
import { isTableBaselineRefreshEffect } from './adapters/codeMirrorTableTransactionProvenanceAdapter';
import { markdownTagField } from './helpers/tags';
import {
  getMermaidBlockMode,
  MermaidEditingWidget,
  mermaidEditingStateField,
  setMermaidBlockModeEffect,
  setMermaidSearchRevealEffect
} from './helpers/mermaidEditing';
import { collectMarkdownLiteralRanges } from './helpers/markdownLiteralRanges';
import { collectHexColorRangesFromText } from '../../src/shared/hexColorSwatches';
import { shikiRefreshEffect } from './helpers/shikiDecorations';
import { addColorSwatchDecoration, hexColorAdjustmentExtension } from './helpers/colorSwatches';
import { isLongCodeBlockInteractionEffect, longCodeBlockSessionUiExtension } from './helpers/longCodeBlocks';
import { attachLatexMathViewport, type LatexMathViewportController } from './helpers/latexMathViewport';
import { createCopyCodeButton } from './helpers/codeBlockControls';
import { formatSourceLineNumber } from './editor/sourceLineNumbers';
import { mountProjectedLineNumbers } from './editor/projectedLineNumbers';
import { createDisplayMathActions, displayMathResultField, getPreviousDisplayMathResult, isDisplayMathEditing } from './helpers/displayMathEditing';
import {
  addHtmlContentDecorations,
  enterHtmlSource,
  getHtmlEditingRange,
  setHtmlEditingRangeEffect,
  htmlContentExtensions
} from './helpers/htmlContent';

import {
  LatexMathEditingWidget,
  latexMathEditingStateField,
  setLatexMathBlockModeEffect,
  setLatexMathSearchRevealEffect
} from './helpers/latexMathEditing';
import {
  applyLiveBlockIndent,
  getLiveBlockIndent,
  getLiveTaskListIndent,
  liveTaskListIndentCssValue,
  type TaskListIndent,
  getCodeBlockSourceLines,
  parseBlockLinePrefix,
  liveBlockIndentCssValue,
  liveBlockIndentKey,
  liveBlockIndentProperty,
  type LiveBlockIndentValue
} from './helpers/blockIndent';
import {
  createRenderedBlockPreviewShell,
  RenderedBlockPreviewHeight,
  renderedBlockPreviewHeight,
  preserveRenderedBlockPreviewHeights,
  hasRenderedBlockPreview,
  renderedBlockPreview
} from './helpers/renderedBlockPreview';
import { getUiStrings } from './application/uiLanguage';
import {
  getUiLanguageWidgetEpoch,
  UiLanguageSensitiveWidget,
  uiLanguageFacet
} from './editor/uiLanguage';
import {
  isLiveInputDerivedWorkBookkeeping,
  isLiveInputDerivedWorkRefresh,
  isLiveInputNestedProjection,
  markLiveInputPresentationMapped,
  hasMappedLiveInputPresentation,
  isLiveInputDerivedWorkPending,
  isMappedLiveInputRefresh,
  liveInputDerivedWorkExtensions,
  mapLiveInputDerivedDecorations,
  replaceLiveInputNestedDecorationEffect,
  shouldDeferLiveInputDerivedWork,
  usesLargeDocumentDerivedWorkBudget
} from './editor/liveInputDerivedWork';

const markerDeco = Decoration.mark({ class: 'meo-md-marker' });
const quoteMarkerDeco = Decoration.mark({ class: 'meo-md-marker meo-md-quote-marker' });

// The benchmark viewport exposes at most ~70 CodeMirror lines. Retaining 80
// lines on either side keeps the current surface live without mapping the file.
const largeDocumentInputLineRadius = 80;
const activeLineMarkerDeco = Decoration.mark({ class: 'meo-md-marker-active' });
const activeQuoteMarkerDeco = Decoration.mark({ class: 'meo-md-marker-active meo-md-quote-marker-active' });
const frontmatterBoundaryMarkerDeco = Decoration.mark({ class: 'meo-md-frontmatter-boundary-marker' });
const linkMarkerDeco = Decoration.mark({ class: 'meo-md-marker meo-md-link-marker' });
const activeLinkMarkerDeco = Decoration.mark({ class: 'meo-md-marker-active meo-md-link-marker-active' });
const linkLabelBracketDeco = Decoration.mark({
  class: 'meo-md-link-label-bracket',
  attributes: {
    style: 'color: var(--meo-semantic-markdownSyntax) !important; -webkit-text-fill-color: var(--meo-semantic-markdownSyntax) !important;'
  }
});
const activeLinkLabelBracketDeco = Decoration.mark({
  class: 'meo-md-link-label-bracket-active',
  attributes: {
    style: 'color: var(--meo-semantic-markdownSyntax) !important; -webkit-text-fill-color: var(--meo-semantic-markdownSyntax) !important;'
  }
});
const footnoteMarkerDeco = Decoration.mark({
  class: 'meo-md-footnote-marker',
  attributes: {
    style: 'color: var(--meo-semantic-markdownSyntax) !important; -webkit-text-fill-color: var(--meo-semantic-markdownSyntax) !important;'
  }
});
const footnoteLiteralDeco = Decoration.mark({ class: 'meo-md-footnote-literal' });
const footnoteDefinitionContentDeco = Decoration.mark({ class: 'meo-md-footnote-definition-content' });
const wikiLinkMarkerDeco = Decoration.mark({ class: 'meo-md-marker meo-md-link-marker meo-md-wiki-marker' });
const activeWikiLinkMarkerDeco = Decoration.mark({ class: 'meo-md-marker-active meo-md-link-marker-active meo-md-wiki-marker' });
const emptyWikiLinkMarkerDeco = Decoration.mark({ class: 'meo-md-marker meo-md-link-marker meo-md-wiki-marker meo-md-wiki-empty-marker' });
const strikeMarkerDeco = Decoration.mark({
  class: 'meo-md-marker meo-md-strike-marker'
});
const activeStrikeMarkerDeco = Decoration.mark({
  class: 'meo-md-marker-active meo-md-strike-marker-active'
});
const highlightMarkerDeco = Decoration.mark({
  class: 'meo-md-marker meo-md-highlight-marker'
});
const activeHighlightMarkerDeco = Decoration.mark({
  class: 'meo-md-marker-active meo-md-highlight-marker-active'
});
const emMarkerDeco = Decoration.mark({
  class: 'meo-md-marker meo-md-em-marker'
});
const activeEmMarkerDeco = Decoration.mark({
  class: 'meo-md-marker-active meo-md-em-marker-active'
});
const codeMarkerDeco = Decoration.mark({ class: 'meo-md-code-marker' });
const activeCodeMarkerDeco = Decoration.mark({ class: 'meo-md-code-marker-active' });
// Content-only ranges include input at either edge during deferred refreshes.
// Delimiters keep separate marks, so typing outside them does not inherit styles.
const subscriptContentDeco = Decoration.mark({ class: 'meo-md-subscript', inclusive: true });
const superscriptContentDeco = Decoration.mark({ class: 'meo-md-superscript', inclusive: true });
const fenceMarkerDeco = Decoration.mark({ class: 'meo-md-fence-marker' });
const headingContentDeco = Decoration.mark({ class: 'meo-md-heading-content' });
const strongMarkerDeco = Decoration.mark({
  class: 'meo-md-marker meo-md-strong-marker'
});
const activeStrongMarkerDeco = Decoration.mark({
  class: 'meo-md-marker-active meo-md-strong-marker-active'
});
class InlineSyntaxBoundaryWidget extends WidgetType {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  toDOM() {
    const span = document.createElement('span');
    span.className = 'meo-md-inline-syntax-boundary';
    span.setAttribute('aria-hidden', 'true');
    return span;
  }
}
const inlineSyntaxBoundaryDeco = Decoration.widget({
  widget: new InlineSyntaxBoundaryWidget(),
  side: -1
});
const hrMarkerDeco = Decoration.mark({ class: 'meo-md-hr-marker' });
const hiddenLinkUrlDeco = Decoration.mark({ class: 'meo-md-link-url-hidden' });
const linkBoundaryDeco = Decoration.mark({ class: 'meo-md-url-boundary' });
const hiddenDetailsSourceDeco = Decoration.replace({
  inclusiveStart: false,
  inclusiveEnd: false
});
const tableDelimiterGutterLineClassMarker = new (class extends GutterMarker {
  elementClass = 'meo-md-hide-line-number';
})();
const indentedCodeGutterLineClassMarker = new (class extends GutterMarker {
  elementClass = 'meo-md-indented-code-line-number';
})();
const headingGutterLineClassMarkers = Array.from({ length: 6 }, (_, index) => new (class extends GutterMarker {
  elementClass = `meo-md-heading-line-number meo-md-heading-line-number-h${index + 1}`;
})());
const renderedBlockPreviewAnchorGutterMarker = new (class extends GutterMarker {
  elementClass = 'meo-rendered-block-preview-anchor-gutter';
})();
type RenderedBlockDocumentLineNumberKind = 'mermaid' | 'math';

class RenderedBlockPreviewLineNumberMarker extends GutterMarker {
  elementClass = 'meo-rendered-block-preview-line-number';

  constructor(readonly lineNumber: string) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof RenderedBlockPreviewLineNumberMarker
      && other.lineNumber === this.lineNumber;
  }

  toDOM(): Node {
    return document.createTextNode(String(this.lineNumber));
  }
}

type RenderedBlockDocumentLineNumberColumn = HTMLDivElement & {
  __meoRenderedBlockLineNumberCleanup?: () => void;
};

class RenderedBlockDocumentLineNumbersMarker extends GutterMarker {
  elementClass = 'meo-rendered-block-document-line-numbers';

  constructor(
    readonly kind: RenderedBlockDocumentLineNumberKind,
    readonly anchor: number,
    readonly startLine: number,
    readonly lineNumbers: readonly string[]
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof RenderedBlockDocumentLineNumbersMarker
      && other.kind === this.kind
      && other.anchor === this.anchor
      && other.startLine === this.startLine
      && other.lineNumbers.length === this.lineNumbers.length
      && other.lineNumbers.every((number, index) => number === this.lineNumbers[index]);
  }

  toDOM(view: EditorView): Node {
    const column = document.createElement('div') as RenderedBlockDocumentLineNumberColumn;
    column.className = 'meo-rendered-block-document-line-number-column';
    const rootSelector = this.kind === 'mermaid'
      ? `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${this.anchor}"]`
      : `.meo-latex-math-editing-block[data-meo-latex-math-anchor="${this.anchor}"]`;
    const sourceSelector = this.kind === 'mermaid' ? '.meo-mermaid-source-editor' : '.meo-latex-math-source-editor';
    column.__meoRenderedBlockLineNumberCleanup = mountProjectedLineNumbers(view, column,
      'meo-rendered-block-document-line-number', () => {
        const source = view.dom.querySelector<HTMLElement>(`${rootSelector} ${sourceSelector}`);
        const innerGutter = source?.querySelector<HTMLElement>('.cm-lineNumbers');
        const content = source?.querySelector<HTMLElement>('.cm-content');
        if (!source || !innerGutter || !content) return null;
        const innerMarkers = Array.from(innerGutter.querySelectorAll<HTMLElement>(':scope > .cm-gutterElement'))
          .filter(element => getComputedStyle(element).visibility !== 'hidden'
            && element.getBoundingClientRect().height > 0 && /^\d+$/.test(element.textContent?.trim() ?? ''));
        const sourceLines = Array.from(content.querySelectorAll<HTMLElement>(':scope > .cm-line'));
        // Both editors own their geometry. Match visible native rows to source
        // offsets; never estimate row positions from a font or fixed line height.
        const measuredLines = sourceLines.length === innerMarkers.length ? sourceLines : innerMarkers;
        const top = column.getBoundingClientRect().top;
        const rows = innerMarkers.flatMap((marker, position) => {
          const index = Number(marker.textContent?.trim()) - 1;
          const label = this.lineNumbers[index];
          if (label === undefined) return [];
          const rect = measuredLines[position].getBoundingClientRect();
          return [{ key: String(index), label, top: rect.top - top, height: rect.height }];
        });
        return { rows, elements: [source, ...measuredLines], mutations: [innerGutter, content] };
      });
    return column;
  }

  destroy(dom: Node): void {
    (dom as RenderedBlockDocumentLineNumberColumn).__meoRenderedBlockLineNumberCleanup?.();
  }
}
const renderedBlockLineNumberMarker = lineNumberWidgetMarker.of((view, widget, block) => {
  if (block.height < 1) return null;
  if (hasRenderedBlockPreview(widget)) {
    return new RenderedBlockPreviewLineNumberMarker(formatSourceLineNumber(view.state.doc.lineAt(block.from).number, view.state));
  }
  if (widget instanceof MermaidEditingWidget) {
    return new RenderedBlockDocumentLineNumbersMarker(
      'mermaid',
      widget.block.anchor,
      widget.block.startLine + 1,
      widget.block.diagramText.split('\n').map((_, index) =>
        formatSourceLineNumber(widget.block.startLine + 1 + index, view.state))
    );
  }
  if (widget instanceof LatexMathEditingWidget) {
    return new RenderedBlockDocumentLineNumbersMarker(
      'math',
      widget.block.anchor,
      widget.block.lineNumber + 1,
      widget.block.sourceText.split('\n').map((_, index) =>
        formatSourceLineNumber(widget.block.lineNumber + 1 + index, view.state))
    );
  }
  return null;
});
const isTableContentLine = (lineText: string): boolean => lineText.includes('|');

type DecorationCollector = Array<Range<Decoration>>;
type SourceRange = { from: number; to: number };
type LiveDecorationScope = SourceRange & { fromLine: number; toLine: number };

function scopedDocumentLines(state: EditorState, scope?: LiveDecorationScope) {
  return documentLines(state.doc, scope?.fromLine, scope?.toLine);
}
type ActiveImageGroup = { line: ReturnType<EditorState['doc']['line']>; items: ImageGroupItem[] };

type LivePointerSelectionState = {
  active: boolean;
  preservedLine: number | null;
};

export const setLivePointerSelectionActiveEffect = StateEffect.define<LivePointerSelectionState>();
export const setLiveDocumentIdleEffect = StateEffect.define<boolean>();
export const preserveLiveDecorationsForSearchEffect = StateEffect.define<true>();
export const refreshLiveDecorationsAfterSearchEffect = StateEffect.define<true>();

const livePointerSelectionActiveField = StateField.define<LivePointerSelectionState>({
  create() {
    return { active: false, preservedLine: null };
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLivePointerSelectionActiveEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

const liveDocumentIdleField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setLiveDocumentIdleEffect)) {
        return effect.value;
      }
    }
    return value;
  }
});

const lineStyleDecos = {
  h1: Decoration.line({ class: 'meo-md-h1' }),
  h2: Decoration.line({ class: 'meo-md-h2' }),
  h3: Decoration.line({ class: 'meo-md-h3' }),
  h4: Decoration.line({ class: 'meo-md-h4' }),
  h5: Decoration.line({ class: 'meo-md-h5' }),
  h6: Decoration.line({ class: 'meo-md-h6' }),
  detailsSummary: Decoration.line({ class: 'meo-md-details-summary-line' }),
  quote: Decoration.line({ class: 'meo-md-quote' }),
  mergeIncomingHeader: Decoration.line({ class: 'meo-merge-line meo-merge-incoming-header' }),
  codeBlock: Decoration.line({ class: 'meo-md-code-block' }),
  codeBlockStart: Decoration.line({ class: 'meo-md-code-block-start' }),
  codeBlockEnd: Decoration.line({ class: 'meo-md-code-block-end' }),
  indentedCodeBlockStart: Decoration.line({ class: 'meo-md-indented-code-block-start' }),
  indentedCodeBlockEnd: Decoration.line({ class: 'meo-md-indented-code-block-end' }),
  renderedBlockPreviewAnchor: Decoration.line({ class: 'meo-rendered-block-preview-anchor-line' }),
  footnote: Decoration.line({ class: 'meo-md-footnote-line' }),
  footnoteContinuation: Decoration.line({ class: 'meo-md-footnote-line meo-md-footnote-continuation' }),
  frontmatterContent: Decoration.line({ class: 'meo-md-frontmatter-content' }),
  frontmatterProperty: Decoration.line({ class: 'meo-md-frontmatter-property' }),
  frontmatterBlockContent: Decoration.line({ class: 'meo-md-frontmatter-property meo-md-frontmatter-block-content' }),
  frontmatterOpening: Decoration.line({ class: 'meo-md-hr meo-md-frontmatter-boundary meo-md-frontmatter-opening' }),
  frontmatterClosing: Decoration.line({ class: 'meo-md-hr meo-md-frontmatter-boundary meo-md-frontmatter-closing' }),
  hrActive: Decoration.line({ class: 'meo-md-hr-active' }),
  hr: Decoration.line({ class: 'meo-md-hr' })
};

const alertLineDecos: Record<AlertType, ReturnType<typeof Decoration.line>> = {
  NOTE: Decoration.line({ class: 'meo-md-alert meo-md-alert-note' }),
  TIP: Decoration.line({ class: 'meo-md-alert meo-md-alert-tip' }),
  IMPORTANT: Decoration.line({ class: 'meo-md-alert meo-md-alert-important' }),
  WARNING: Decoration.line({ class: 'meo-md-alert meo-md-alert-warning' }),
  CAUTION: Decoration.line({ class: 'meo-md-alert meo-md-alert-caution' })
};

const alertMarkerDeco = Decoration.mark({ class: 'meo-md-alert-marker' });
const alertLabelActiveDeco = Decoration.mark({ class: 'meo-md-alert-label-active' });
const hiddenAlertMarkerDeco = Decoration.mark({ class: 'meo-md-alert-marker-hidden' });
const frontmatterKeyDeco = Decoration.mark({ class: 'meo-md-frontmatter-key' });
const frontmatterValueDeco = Decoration.mark({ class: 'meo-md-frontmatter-value' });
const mergeConflictMarkerPrefixes = ['<<<<<<<', '|||||||', '=======', '>>>>>>>'];
const fileSchemePrefix = 'file:';
const rawFileUrlBlockedAncestorNames = new Set([
  'Link',
  'Autolink',
  'URL',
  'Image',
  'InlineCode',
  'CodeText',
  'FencedCode',
  'CodeBlock',
  'HTMLTag',
  'HTMLBlock',
  'Table'
]);

function addFrontmatterValueUrlDecorations(builder: DecorationCollector, valueFrom: number, valueText: string): void {
  for (const match of findRawSourceUrlMatches(valueText)) {
    const urlFrom = valueFrom + match.index;
    const rawUrl = valueText.slice(match.index, match.index + match.length);
    addTrimmedUrlLinkMark(builder, urlFrom, urlFrom + match.length, rawUrl, match.href, true);
  }
}

const listLineDecoCache = new Map<string, Decoration>();
const listIndentWidgetCache = new Map<number, ListIndentWidget>();
const blockIndentLineDecoCache = new Map<string, ReturnType<typeof Decoration.line>>();
const frontmatterArrayPillWidgetCache = new Map<string, FrontmatterArrayPillsWidget>();
const htmlBreakTagRegex = /^<br\s*\/?>$/i;

class HtmlBreakWidget extends WidgetType {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  eq(other: WidgetType): boolean {
    return other instanceof HtmlBreakWidget;
  }

  toDOM(): HTMLElement {
    const element = document.createElement('br');
    element.className = 'meo-md-html-break';
    return element;
  }

  get lineBreaks(): number {
    return 1;
  }
}

const htmlBreakWidget = new HtmlBreakWidget();

function addHtmlBreakDecoration(
  builder: DecorationCollector,
  state: EditorState,
  node: SyntaxNodeRef,
  activeLines: Set<number>,
  frontmatter: FrontmatterInfo | null
): void {
  if (isInsideFrontmatter(frontmatter, node.from)) {
    return;
  }

  const source = state.doc.sliceString(node.from, node.to);
  if (!htmlBreakTagRegex.test(source)) {
    return;
  }

  const line = state.doc.lineAt(node.from);
  const needsVisualBreak = state.doc.sliceString(node.to, line.to).trim().length > 0;
  if (activeLines.has(line.number)) {
    if (needsVisualBreak) {
      builder.push(
        Decoration.widget({ widget: htmlBreakWidget, side: 1 }).range(node.to)
      );
    }
    return;
  }

  builder.push(
    Decoration.replace({
      widget: needsVisualBreak ? htmlBreakWidget : undefined,
      inclusive: false
    }).range(node.from, node.to)
  );
}

function isMergeConflictMarkerLine(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  const lineText = state.doc.sliceString(line.from, line.to).trimStart();
  return mergeConflictMarkerPrefixes.some((prefix) => lineText.startsWith(prefix));
}

class ListIndentWidget extends WidgetType {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  indentColumns: number;

  constructor(indentColumns: number) {
    super();
    this.indentColumns = indentColumns;
  }

  eq(other: WidgetType): boolean {
    return other instanceof ListIndentWidget && other.indentColumns === this.indentColumns;
  }

  toDOM(): HTMLElement {
    const spacer = document.createElement('span');
    spacer.className = 'meo-md-list-indent-spacer';
    spacer.style.width = `${Math.max(0, this.indentColumns)}ch`;
    return spacer;
  }
}

function listIndentWidget(indentColumns: number): ListIndentWidget {
  const normalized = Math.max(0, Math.round(indentColumns));
  let widget = listIndentWidgetCache.get(normalized);
  if (widget) {
    return widget;
  }
  widget = new ListIndentWidget(normalized);
  listIndentWidgetCache.set(normalized, widget);
  return widget;
}

class FootnoteBackrefSpacerWidget extends WidgetType {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  footnoteNumber: number;

  constructor(footnoteNumber: number) {
    super();
    this.footnoteNumber = footnoteNumber;
  }

  eq(other: WidgetType): boolean {
    return other instanceof FootnoteBackrefSpacerWidget && other.footnoteNumber === this.footnoteNumber;
  }

  toDOM(): HTMLElement {
    const marker = document.createElement('span');
    marker.className = 'meo-md-footnote-backref meo-md-footnote-backref-spacer';
    marker.style.width = liveBlockIndentCssValue({ columns: 0, footnoteNumber: this.footnoteNumber })!;
    marker.textContent = `${this.footnoteNumber}.`;
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }
}

class FootnoteReferenceSeparatorWidget extends WidgetType {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  eq(other: WidgetType): boolean {
    return other instanceof FootnoteReferenceSeparatorWidget;
  }

  toDOM(): HTMLElement {
    const sep = document.createElement('span');
    sep.className = 'meo-md-footnote-separator';
    sep.textContent = ',';
    sep.setAttribute('aria-hidden', 'true');
    return sep;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const footnoteReferenceSeparatorWidget = new FootnoteReferenceSeparatorWidget();

function listLineDeco(
  contentOffsetColumns: number,
  indentColumns: number,
  guideStepColumns = 2,
  selected = false,
  isTask = false,
  taskHiddenPrefixColumns = 0,
  isOrdered = false
): Decoration {
  const offset = Math.max(0, contentOffsetColumns);
  const indent = Math.max(0, indentColumns);
  const guideStep = Math.max(2, guideStepColumns);
  const hiddenTaskPrefix = Math.max(0, taskHiddenPrefixColumns);
  const key = `${offset}:${indent}:${guideStep}:${selected ? 1 : 0}:${isTask ? 1 : 0}:${hiddenTaskPrefix}:${isOrdered ? 1 : 0}`;
  let deco = listLineDecoCache.get(key);
  if (deco) {
    return deco;
  }

  const classes = ['meo-md-list-line'];
  if (selected) {
    classes.push('meo-md-list-line-selected');
  }
  if (isTask) {
    classes.push('meo-md-list-line-task');
  }
  if (isOrdered) {
    classes.push('meo-md-list-line-ordered');
  }

  deco = Decoration.line({
    class: classes.join(' '),
    attributes: {
      style: `--meo-list-hanging-indent:calc(${offset}ch + var(--meo-list-footnote-offset, 0px));--meo-list-indent-columns:${indent}ch;--meo-list-guide-step:${guideStep}ch;--meo-task-hidden-prefix-columns:${hiddenTaskPrefix}ch;`
    }
  });
  listLineDecoCache.set(key, deco);
  return deco;
}

const inlineStyleDecos = {
  em: Decoration.mark({ class: 'meo-md-em', inclusive: true }),
  strong: Decoration.mark({ class: 'meo-md-strong', inclusive: true }),
  strike: Decoration.mark({ class: 'meo-md-strike', inclusive: true }),
  highlight: Decoration.mark({ class: 'meo-md-highlight', inclusive: true }),
  inlineCode: Decoration.mark({ class: 'meo-md-inline-code' })
};
function addDelimitedInlineStyleDecoration(
  builder: DecorationCollector,
  state: EditorState,
  node: SyntaxNodeRef,
  decoration: Decoration,
  markers: readonly string[]
): void {
  const text = state.doc.sliceString(node.from, node.to);
  const marker = markers.find((candidate) => text.startsWith(candidate) && text.endsWith(candidate));
  if (!marker) {
    addRange(builder, node.from, node.to, decoration);
    return;
  }
  if (node.to - node.from <= marker.length * 2) return;
  addRange(builder, node.from + marker.length, node.to - marker.length, decoration);
}

function addEmphasisDecorations(builder: DecorationCollector, state: EditorState, node: SyntaxNodeRef): void {
  addDelimitedInlineStyleDecoration(builder, state, node, inlineStyleDecos.em, ['*', '_']);
}

function addStrongEmphasisDecorations(builder: DecorationCollector, state: EditorState, node: SyntaxNodeRef): void {
  addDelimitedInlineStyleDecoration(builder, state, node, inlineStyleDecos.strong, ['**', '__']);
}

function addStrikethroughDecorations(builder: DecorationCollector, state: EditorState, node: SyntaxNodeRef): void {
  addDelimitedInlineStyleDecoration(builder, state, node, inlineStyleDecos.strike, ['~~']);
}

function addHighlightDecorations(builder: DecorationCollector, state: EditorState, node: SyntaxNodeRef): void {
  addDelimitedInlineStyleDecoration(builder, state, node, inlineStyleDecos.highlight, ['==']);
}

function addFrontmatterBoundaryDecorations(
  builder: DecorationCollector,
  state: EditorState,
  frontmatter: FrontmatterInfo,
  activeLines: Set<number>
): void {
  if (frontmatter.contentTo > frontmatter.contentFrom) {
    addLineClass(builder, state, frontmatter.contentFrom, frontmatter.contentTo, lineStyleDecos.frontmatterContent);
    const propertyLineDeco = lineStyleDecos.frontmatterProperty;

    forEachYamlFrontmatterLayoutLine(state, frontmatter, (entry) => {
      const { line } = entry;
      if (entry.kind === 'block-content') {
        addLineClass(builder, state, line.from, line.to, lineStyleDecos.frontmatterBlockContent);
        if (line.from < line.to) {
          addFrontmatterValueUrlDecorations(builder, line.from, line.text);
          addRange(builder, line.from, line.to, frontmatterValueDeco);
        }
        return;
      }
      if (entry.kind === 'scalar-list') {
        addLineClass(builder, state, line.from, line.to, propertyLineDeco);
        if (line.from < line.to) {
          addFrontmatterValueUrlDecorations(builder, line.from, line.text);
          addRange(builder, line.from, line.to, frontmatterValueDeco);
        }
        return;
      }
      if (entry.kind !== 'field') {
        return;
      }

      const { keyTo, valueFrom, valueTo } = entry;
      addLineClass(builder, state, line.from, line.to, propertyLineDeco);
      const lineIsActive = activeLines.has(line.number) || overlapsSelection(state, line.from, line.to);
      addRange(builder, line.from, keyTo, frontmatterKeyDeco);
      if (valueFrom !== null && valueFrom < valueTo) {
        const selectionOverlapsValue = overlapsSelection(state, valueFrom, valueTo);
        const valueText = line.text.slice(valueFrom - line.from);
        const parsedArrayValue = !lineIsActive && !selectionOverlapsValue
          ? parseSimpleYamlFlowArrayValue(line.text, valueFrom - line.from)
          : null;

        if (parsedArrayValue) {
          const arrayFrom = line.from + parsedArrayValue.fromOffset;
          builder.push(
            Decoration.replace({
              widget: frontmatterArrayPillsWidget(parsedArrayValue.items.map((item) => item.text)),
              inclusive: false
            }).range(arrayFrom, line.from + parsedArrayValue.toOffset)
          );
          return;
        }

        addFrontmatterValueUrlDecorations(builder, valueFrom, valueText);
        addRange(builder, valueFrom, valueTo, frontmatterValueDeco);
      }
    });
  }

  const boundaries = [
    { from: frontmatter.openingFrom, to: frontmatter.openingTo, isOpening: true },
    { from: frontmatter.closingFrom, to: frontmatter.closingTo }
  ];

  for (const boundary of boundaries) {
    addLineClass(
      builder,
      state,
      boundary.from,
      boundary.to,
      boundary.isOpening ? lineStyleDecos.frontmatterOpening : lineStyleDecos.frontmatterClosing
    );
    const lineNo = state.doc.lineAt(boundary.from).number;
    const boundarySelected = overlapsSelection(state, boundary.from, boundary.to);
    if (activeLines.has(lineNo) || boundarySelected) {
      addLineClass(builder, state, boundary.from, boundary.to, lineStyleDecos.hrActive);
      addRange(builder, boundary.from, boundary.to, activeLineMarkerDeco);
    } else {
      if (boundary.isOpening) {
        const line = state.doc.lineAt(boundary.from);
        addTopLinePillLabel(
          builder,
          line.to,
          getUiStrings(state.facet(uiLanguageFacet)).properties
        );
      }
      addRange(builder, boundary.from, boundary.to, frontmatterBoundaryMarkerDeco);
    }
  }
}

function addThematicBreakDecorations(
  builder: DecorationCollector,
  state: EditorState,
  from: number,
  to: number,
  activeLines: Set<number>
): void {
  addLineClass(builder, state, from, to, lineStyleDecos.hr);
  const lineNo = state.doc.lineAt(from).number;
  if (activeLines.has(lineNo)) {
    addLineClass(builder, state, from, to, lineStyleDecos.hrActive);
    addRange(builder, from, to, activeLineMarkerDeco);
  } else {
    addRange(builder, from, to, hrMarkerDeco);
  }
}

function addForcedThematicBreakDecorations(
  builder: DecorationCollector,
  state: EditorState,
  tree: Tree,
  activeLines: Set<number>,
  frontmatter: FrontmatterInfo | null,
  codeBlockLines: Set<number> | null = null,
  scope?: LiveDecorationScope
): void {
  for (const line of scopedDocumentLines(state, scope)) {
    const lineNo = line.number;
    if (
      !isThematicBreakLine(line.text) ||
      isInsideFrontmatter(frontmatter, line.from) ||
      codeBlockLines?.has(lineNo)
    ) {
      continue;
    }
    // A dash-only line can belong to a heading; its parsed block owns the syntax.
    let node = tree.resolveInner(line.to, -1);
    while (node.parent && node.name !== 'HorizontalRule' && !node.name.startsWith('SetextHeading')) node = node.parent;
    if (node.name === 'HorizontalRule' || node.name.startsWith('SetextHeading')) continue;
    addThematicBreakDecorations(builder, state, line.from, line.to, activeLines);
  }
}

function getNodeHref(state: EditorState, node: SyntaxNode): string {
  const href = state.doc.sliceString(node.from, node.to).trim();
  return normalizeSourceHref(href);
}

function addLinkMark(
  builder: DecorationCollector,
  from: number,
  to: number,
  href: string,
  openButtonPos: number | null = null
): void {
  if (!href) {
    return;
  }
  addRange(
    builder,
    from,
    to,
    Decoration.mark({
      class: 'meo-md-link',
      attributes: { 'data-meo-link-href': href }
    })
  );
  if (openButtonPos !== null && Number.isFinite(openButtonPos)) {
    builder.push(
      Decoration.widget({
        widget: new OpenLinkWidget(href),
        side: 1
      }).range(openButtonPos)
    );
  }
}

function addTrimmedUrlLinkMark(
  builder: DecorationCollector,
  from: number,
  to: number,
  rawUrl: string,
  href: string,
  showOpenButton = false
): void {
  if (!href) {
    return;
  }
  const range = trimDecoratedUrlRange(from, to, rawUrl, href);
  if (from < range.from) {
    addRange(builder, from, range.from, linkBoundaryDeco);
  }
  if (range.to < to) {
    addRange(builder, range.to, to, linkBoundaryDeco);
  }
  addLinkMark(builder, range.from, range.to, href, showOpenButton ? range.to : null);
}

function findChildNode(node: SyntaxNode | SyntaxNodeRef | null, name: string): SyntaxNode | null {
  const syntaxNode = node?.node ?? null;
  if (!syntaxNode?.firstChild) {
    return null;
  }
  for (let child: SyntaxNode | null = syntaxNode.firstChild; child; child = child.nextSibling) {
    if (child.name === name) {
      return child;
    }
  }
  return null;
}

class ClearLinkUrlWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc): WidgetType {
    const from = changes.mapPos(this.urlFrom, 1), to = changes.mapPos(this.urlTo, -1);
    return from === this.urlFrom && to === this.urlTo ? this : new ClearLinkUrlWidget(from, to);
  }
  urlFrom: number;
  urlTo: number;

  constructor(urlFrom: number, urlTo: number) {
    super();
    this.urlFrom = urlFrom;
    this.urlTo = urlTo;
  }

  eq(other: WidgetType): boolean {
    return other instanceof ClearLinkUrlWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.urlFrom === this.urlFrom &&
      other.urlTo === this.urlTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'meo-md-link-clear-btn';
    button.dataset.tooltip = strings.clearLinkUrl;
    button.setAttribute('aria-label', strings.clearLinkUrl);
    button.appendChild(createElement(Delete, { 'aria-hidden': 'true' }));
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const view = EditorView.findFromDOM(button);
      if (!view) {
        return;
      }
      view.dispatch({
        changes: { from: this.urlFrom, to: this.urlTo, insert: '' },
        selection: { anchor: this.urlFrom }
      });
      view.focus();
    });
    return button;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class OpenLinkWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  href: string;

  constructor(href: string) {
    super();
    this.href = href;
  }

  eq(other: WidgetType): boolean {
    return other instanceof OpenLinkWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.href === this.href;
  }

  toDOM(view: EditorView): HTMLElement {
    return createOpenLinkButton(this.href, view.state.facet(uiLanguageFacet));
  }

  ignoreEvent(): boolean {
    return false;
  }
}

class MissingWikiLinkWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  constructor(readonly issue?: string) { super(); }
  eq(other: WidgetType): boolean {
    return other instanceof MissingWikiLinkWidget && other.issue === this.issue && this.hasSameUiLanguageEpoch(other);
  }

  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const badge = document.createElement('span');
    badge.className = 'meo-md-wiki-missing-icon';
    badge.dataset.tooltip = this.issue ?? strings.missingWikiLink;
    badge.dataset.tooltipKind = 'description';
    badge.setAttribute('aria-label', this.issue ?? strings.missingWikiLink);
    badge.appendChild(createElement(AlertCircle, { 'aria-hidden': 'true' }));
    return badge;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class MissingLocalLinkWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  eq(other: WidgetType): boolean {
    return other instanceof MissingLocalLinkWidget && this.hasSameUiLanguageEpoch(other);
  }

  toDOM(view: EditorView): HTMLElement {
    return createMissingLocalLinkIndicator(view.state.facet(uiLanguageFacet));
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class FrontmatterArrayPillsWidget extends WidgetType {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  itemLabels: string[];
  cacheKey: string;

  constructor(itemLabels: string[], cacheKey: string) {
    super();
    this.itemLabels = itemLabels;
    this.cacheKey = cacheKey;
  }

  eq(other: WidgetType): boolean {
    return other instanceof FrontmatterArrayPillsWidget && other.cacheKey === this.cacheKey;
  }

  toDOM(): HTMLElement {
    const container = document.createElement('span');
    container.className = 'meo-md-frontmatter-value meo-md-frontmatter-array-pills';
    container.setAttribute('aria-hidden', 'true');
    for (const labelText of this.itemLabels) {
      const pill = document.createElement('span');
      pill.className = 'meo-md-frontmatter-pill';
      pill.textContent = labelText;
      container.appendChild(pill);
    }
    container.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const view = EditorView.findFromDOM(container);
      if (!view) {
        return;
      }
      const anchor = view.posAtDOM(container);
      view.dispatch({ selection: { anchor: Math.min(anchor + 1, view.state.doc.length) } });
      view.focus();
    });
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function blockIndentLineDeco(indent: LiveBlockIndentValue) {
  const key = liveBlockIndentKey(indent);
  const cssValue = liveBlockIndentCssValue(indent);
  let decoration = blockIndentLineDecoCache.get(key);
  if (!decoration) {
    decoration = Decoration.line({
      class: 'meo-live-indented-block-line',
      attributes: { style: `${liveBlockIndentProperty}:${cssValue}` }
    });
    blockIndentLineDecoCache.set(key, decoration);
  }
  return decoration;
}

function addBlockIndentLines(builder: DecorationCollector, state: EditorState, from: number, to: number, indent: LiveBlockIndentValue): void {
  // Source lines already paint their own quote prefix and definition spacer.
  if ((typeof indent !== 'number' && indent.quoteColumns?.length) || liveBlockIndentCssValue(indent) === null) {
    return;
  }
  addLineClass(builder, state, from, to, blockIndentLineDeco(indent));
}

/** Code owns its source prefix; prose/footnote spacers must not project it again. */
function addCodeContainerLines(
  builder: DecorationCollector,
  state: EditorState,
  node: SyntaxNode,
  indent: LiveBlockIndentValue
): void {
  const cssIndent = liveBlockIndentCssValue(indent) ?? '0px';
  const quoted = typeof indent !== 'number' && Boolean(indent.quoteColumns?.length);
  for (const line of getCodeBlockSourceLines(state, node)) {
    const visibleColumns = line.prefixColumns - line.quoteDepth;
    builder.push(Decoration.line({ attributes: {
      class: 'meo-md-code-container-line' + (quoted ? ' meo-md-quoted-code-block' : ''),
      style: liveBlockIndentProperty + ':' + cssIndent + ';--meo-code-prefix-width:' + visibleColumns + 'ch;--meo-code-prefix-inset:' + line.payloadInset + 'ch;'
    } }).range(line.from));
    if (line.prefixTo > line.from) {
      builder.push(Decoration.mark({ class: 'meo-md-code-container-prefix' }).range(line.from, line.prefixTo));
    }
  }
}

function frontmatterArrayPillsWidget(itemLabels: string[]): FrontmatterArrayPillsWidget {
  const cacheKey = JSON.stringify(itemLabels);
  let widget = frontmatterArrayPillWidgetCache.get(cacheKey);
  if (widget) {
    return widget;
  }
  widget = new FrontmatterArrayPillsWidget(itemLabels, cacheKey);
  frontmatterArrayPillWidgetCache.set(cacheKey, widget);
  return widget;
}

class DetailsSummaryWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc): WidgetType {
    const anchor = changes.mapPos(this.anchor, 1), from = changes.mapPos(this.lineFrom, 1);
    return anchor === this.anchor && from === this.lineFrom ? this : new DetailsSummaryWidget(anchor, from, this.summaryText, this.collapsed);
  }
  anchor: number;
  lineFrom: number;
  summaryText: string;
  collapsed: boolean;

  constructor(anchor: number, lineFrom: number, summaryText: string, collapsed: boolean) {
    super();
    this.anchor = anchor;
    this.lineFrom = lineFrom;
    this.summaryText = summaryText;
    this.collapsed = collapsed;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof DetailsSummaryWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.anchor === this.anchor &&
      other.lineFrom === this.lineFrom &&
      other.summaryText === this.summaryText &&
      other.collapsed === this.collapsed
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'meo-md-details-summary';
    button.dataset.tooltip = this.collapsed ? strings.expandDetails : strings.collapseDetails;
    button.setAttribute('aria-label', button.dataset.tooltip ?? '');
    button.setAttribute('aria-expanded', String(!this.collapsed));

    const icon = document.createElement('span');
    icon.className = 'meo-md-details-summary-icon';
    icon.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'meo-md-details-summary-label';
    label.textContent = this.summaryText;
    button.append(icon, label);

    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleDetailsBlock(view, this.anchor);
    });

    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class FootnoteReferenceWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc): WidgetType {
    const from = changes.mapPos(this.definitionFrom, 1);
    return from === this.definitionFrom ? this : new FootnoteReferenceWidget(this.footnoteNumber, from);
  }
  footnoteNumber: number;
  definitionFrom: number;

  constructor(footnoteNumber: number, definitionFrom: number) {
    super();
    this.footnoteNumber = footnoteNumber;
    this.definitionFrom = definitionFrom;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof FootnoteReferenceWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.footnoteNumber === this.footnoteNumber &&
      other.definitionFrom === this.definitionFrom
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'meo-md-footnote-ref';
    button.dataset.tooltip = strings.jumpToFootnote(this.footnoteNumber);
    button.setAttribute('aria-label', button.dataset.tooltip ?? '');

    const number = document.createElement('sup');
    number.textContent = String(this.footnoteNumber);
    button.appendChild(number);

    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const viewport = getViewportController(view);
      const isRevealCurrent = viewport?.beginNavigationReveal();
      view.dispatch({ selection: { anchor: this.definitionFrom } });
      if (viewport && isRevealCurrent) viewport.revealPosition(this.definitionFrom, { y: 'center' }, isRevealCurrent);
      else view.dispatch({ effects: editorScrollIntoView(this.definitionFrom, { y: 'center' }) });
      view.focus();
    });

    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class FootnoteBacklinkWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc): WidgetType {
    const from = changes.mapPos(this.referenceFrom, 1);
    return from === this.referenceFrom ? this : new FootnoteBacklinkWidget(this.footnoteNumber, from);
  }
  footnoteNumber: number;
  referenceFrom: number;

  constructor(footnoteNumber: number, referenceFrom: number) {
    super();
    this.footnoteNumber = footnoteNumber;
    this.referenceFrom = referenceFrom;
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof FootnoteBacklinkWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.footnoteNumber === this.footnoteNumber &&
      other.referenceFrom === this.referenceFrom
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'meo-md-footnote-backref';
    button.style.width = 'calc(' + (String(this.footnoteNumber).length + 1) + ' * var(--meo-live-container-ch))';
    button.style.textIndent = '0';
    button.dataset.tooltip = strings.jumpToFootnoteReference(this.footnoteNumber);
    button.setAttribute('aria-label', button.dataset.tooltip ?? '');
    button.textContent = `${this.footnoteNumber}.`;

    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const viewport = getViewportController(view);
      const isRevealCurrent = viewport?.beginNavigationReveal();
      view.dispatch({ selection: { anchor: this.referenceFrom } });
      if (viewport && isRevealCurrent) viewport.revealPosition(this.referenceFrom, { y: 'center' }, isRevealCurrent);
      else view.dispatch({ effects: editorScrollIntoView(this.referenceFrom, { y: 'center' }) });
      view.focus();
    });

    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function addMarkdownLinkDecorations(builder: DecorationCollector, state: EditorState, node: SyntaxNodeRef, activeLines: Set<number>): void {
  const urlNode = findChildNode(node, 'URL');
  if (!urlNode) {
    return;
  }

  const prefix = state.doc.sliceString(node.from, urlNode.from);
  const closeTextAt = prefix.lastIndexOf('](');
  if (closeTextAt <= 0) {
    return;
  }

  const textFrom = node.from + 1;
  const textTo = node.from + closeTextAt;
  if (textFrom >= textTo) {
    return;
  }
  const href = getNodeHref(state, urlNode);
  const urlLine = state.doc.lineAt(urlNode.from);
  const isActiveLine = activeLines.has(urlLine.number);
  const containsImage = Boolean(findChildNode(node, 'Image'));
  addLinkMark(builder, textFrom, textTo, href, !isActiveLine && !containsImage ? textTo : null);

  if (isMissingLocalLinkTarget(href)) {
    const iconPos = textFrom < textTo ? textFrom : node.from + 1;
    builder.push(
      Decoration.widget({
        widget: new MissingLocalLinkWidget(),
        side: -1
      }).range(iconPos)
    );
  }

  if (!href) {
    return;
  }
  if (!isActiveLine) {
    addRange(builder, urlNode.from, urlNode.to, hiddenLinkUrlDeco);
    return;
  }

  if (!href.startsWith('#')) {
    builder.push(
      Decoration.widget({
        widget: new ClearLinkUrlWidget(urlNode.from, urlNode.to),
        side: 1
      }).range(urlNode.to)
    );
  }
}

class DetailsSourceToggleWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc): WidgetType {
    const from = changes.mapPos(this.from, 1), to = changes.mapPos(this.to, -1);
    return from === this.from && to === this.to ? this : new DetailsSourceToggleWidget(from, to);
  }
  constructor(readonly from: number, readonly to: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof DetailsSourceToggleWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.from === this.from && other.to === this.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'meo-md-html-mode-btn meo-md-html-source-toggle meo-md-details-source-toggle';
    button.dataset.tooltip = strings.showHtmlSource;
    button.setAttribute('aria-label', strings.showHtmlSource);
    button.appendChild(createElement(Code2, { width: 18, height: 18, 'aria-hidden': 'true' }));
    button.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      enterHtmlSource(view, { from: this.from, to: this.to });
    });
    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function addFootnoteReferenceDecorations(builder: DecorationCollector, state: EditorState, reference: FootnoteReference, activeLines: Set<number>): boolean {
  if (!shouldRenderFootnoteReference(state, reference, activeLines)) {
    return false;
  }

  builder.push(
    Decoration.replace({
      widget: new FootnoteReferenceWidget(reference.number as number, reference.definition!.lineFrom),
      inclusive: false
    }).range(reference.from, reference.to)
  );

  return true;
}

function shouldRenderFootnoteReference(state: EditorState, reference: FootnoteReference, activeLines: Set<number>): boolean {
  const line = state.doc.lineAt(reference.from);
  const editingReference = activeLines.has(line.number) || overlapsSelection(state, reference.from, reference.to);
  return !editingReference && Boolean(reference.number) && Boolean(reference.definition);
}

function addInlineFootnoteMarkerSyntaxDecorations(
  builder: DecorationCollector,
  containerFrom: number,
  markerRanges: Array<{ label: string; fromOffset: number; toOffset: number }>
) {
  for (const markerRange of markerRanges) {
    const markerFrom = containerFrom + markerRange.fromOffset;
    const markerTo = containerFrom + markerRange.toOffset;
    if (markerTo - markerFrom < 3) {
      continue;
    }

    addRange(builder, markerFrom, markerFrom + 1, footnoteMarkerDeco);
    addRange(builder, markerFrom + 1, markerFrom + 2, footnoteMarkerDeco);
    addRange(builder, markerTo - 1, markerTo, footnoteMarkerDeco);
  }
}

function getEmptyImageLinkUrl(state: EditorState, node: SyntaxNodeRef): string {
  const urlNode = findChildNode(node, 'URL');
  if (!urlNode) {
    return '';
  }

  const prefix = state.doc.sliceString(node.from, urlNode.from);
  const closeTextAt = prefix.lastIndexOf('](');
  if (closeTextAt < 1) {
    return '';
  }

  const textFrom = node.from + 1;
  const textTo = node.from + closeTextAt;
  if (state.doc.sliceString(textFrom, textTo).trim()) {
    return '';
  }

  const url = state.doc.sliceString(urlNode.from, urlNode.to).trim();
  return isImageUrl(url) ? url : '';
}

function addAutolinkDecorations(builder: DecorationCollector, state: EditorState, node: SyntaxNodeRef, activeLines: Set<number>): void {
  const urlNode = findChildNode(node, 'URL');
  if (!urlNode) {
    return;
  }
  const href = getNodeHref(state, urlNode);
  const rawUrl = state.doc.sliceString(urlNode.from, urlNode.to);
  const isActiveLine = activeLines.has(state.doc.lineAt(urlNode.from).number);
  addTrimmedUrlLinkMark(builder, urlNode.from, urlNode.to, rawUrl, href, !isActiveLine);
}

function addWikiLinkDecorations(builder: DecorationCollector, state: EditorState, node: SyntaxNodeRef, activeLines: Set<number>): boolean {
  const wikiLink = parseWikiLinkData(state, node);
  if (!wikiLink) {
    return false;
  }

  const hasVisibleText = wikiLink.textFrom >= 0 && wikiLink.textTo > wikiLink.textFrom;
  const lineNo = state.doc.lineAt(node.from).number;
  const isActiveLine = activeLines.has(lineNo);
  if (wikiLink.href && hasVisibleText) {
    addLinkMark(
      builder,
      wikiLink.textFrom,
      wikiLink.textTo,
      wikiLink.href,
      isActiveLine ? null : wikiLink.textTo
    );
  }
  const marker = isActiveLine
    ? activeWikiLinkMarkerDeco
    : hasVisibleText
      ? wikiLinkMarkerDeco
      : emptyWikiLinkMarkerDeco;
  addRange(builder, wikiLink.openFrom, wikiLink.openTo, marker);
  addRange(builder, wikiLink.closeFrom, wikiLink.closeTo, marker);

  if (!isActiveLine && wikiLink.hideTo > wikiLink.hideFrom) {
    addRange(builder, wikiLink.hideFrom, wikiLink.hideTo, hiddenLinkUrlDeco);
  }

  const localTargetStatus = getWikiLinkStatus(wikiLink.localTarget);
  if (wikiLink.localTarget && localTargetStatus === false) {
    const iconPos = hasVisibleText ? wikiLink.textFrom : wikiLink.openTo;
    builder.push(
      Decoration.widget({
        widget: new MissingWikiLinkWidget(getWikiLinkIssue(wikiLink.localTarget)),
        side: -1
      }).range(iconPos)
    );
  }

  return true;
}

function addRange(builder: DecorationCollector, from: number, to: number, deco: Decoration): void {
  if (to <= from) {
    return;
  }
  builder.push(deco.range(from, to));
}

function addLineAwareRange(builder: DecorationCollector, activeLines: Set<number>, lineNo: number, from: number, to: number, inactiveDeco: Decoration, activeDeco: Decoration): void {
  addRange(builder, from, to, activeLines.has(lineNo) ? activeDeco : inactiveDeco);
}

function addInlineMarkerRange(builder: DecorationCollector, activeLines: Set<number>, lineNo: number, from: number, to: number, inactiveDeco: Decoration, activeDeco: Decoration, closing = false): void {
  const active = activeLines.has(lineNo);
  addRange(builder, from, to, active ? activeDeco : inactiveDeco);
  if (active && closing) {
    builder.push(inlineSyntaxBoundaryDeco.range(to));
  }
}

function collectActiveLines(state: EditorState): Set<number> {
  const pointerSelection = state.field(livePointerSelectionActiveField);
  if (state.field(liveDocumentIdleField)) {
    return new Set();
  }
  if (pointerSelection.active) {
    return pointerSelection.preservedLine === null
      ? new Set()
      : new Set([pointerSelection.preservedLine]);
  }

  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    // In live mode, only reveal markdown markers on the focused line.
    const focusLine = state.doc.lineAt(range.head).number;
    lines.add(focusLine);
  }
  return lines;
}

function collectIndentSelectedLines(state: EditorState): Set<number> {
  const lines = new Set<number>();
  for (const range of state.selection.ranges) {
    if (range.empty) {
      continue;
    }
    const from = Math.min(range.from, range.to);
    const to = Math.max(range.from, range.to);
    const startLine = state.doc.lineAt(from).number;
    const endLine = state.doc.lineAt(to - 1).number;
    for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
      const lineStart = state.doc.line(lineNo).from;
      if (lineStart >= from && lineStart < to) {
        lines.add(lineNo);
      }
    }
  }
  return lines;
}

function addLineClass(builder: DecorationCollector, state: EditorState, from: number, to: number, deco: Decoration): void {
  const startLine = state.doc.lineAt(from).number;
  const endLine = state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
    const line = state.doc.line(lineNo);
    builder.push(deco.range(line.from));
  }
}

function rangeTouchesActiveLine(state: EditorState, from: number, to: number, activeLines: Set<number>): boolean {
  if (to <= from) {
    return false;
  }

  const startLine = state.doc.lineAt(from).number;
  const endLine = state.doc.lineAt(Math.max(from, to - 1)).number;
  for (let lineNo = startLine; lineNo <= endLine; lineNo += 1) {
    if (activeLines.has(lineNo)) {
      return true;
    }
  }
  return false;
}

function addDetailsBlockDecorations(builder: DecorationCollector, state: EditorState, detailsBlocks: ReturnType<typeof getDetailsBlocks>): void {
  for (const detailsBlock of detailsBlocks) {
    addLineClass(builder, state, detailsBlock.lineFrom, detailsBlock.lineTo, lineStyleDecos.detailsSummary);

    if (detailsBlock.summaryFrom > detailsBlock.anchorFrom) {
      builder.push(
        hiddenDetailsSourceDeco.range(detailsBlock.anchorFrom, detailsBlock.summaryFrom)
      );
    }

    builder.push(
      Decoration.replace({
        widget: new DetailsSummaryWidget(
          detailsBlock.anchorFrom,
          detailsBlock.lineFrom,
          detailsBlock.summaryText,
          detailsBlock.collapsed
        )
      }).range(detailsBlock.summaryFrom, detailsBlock.summaryTo)
    );
    builder.push(
      Decoration.widget({
        widget: new DetailsSourceToggleWidget(detailsBlock.sectionFrom, detailsBlock.sectionTo),
        side: 1
      }).range(detailsBlock.lineFrom)
    );

    if (detailsBlock.anchorTo > detailsBlock.summaryTo) {
      builder.push(
        hiddenDetailsSourceDeco.range(detailsBlock.summaryTo, detailsBlock.anchorTo)
      );
    }

    builder.push(hiddenDetailsSourceDeco.range(detailsBlock.closingFrom, detailsBlock.closingTo));

    if (detailsBlock.collapsed && detailsBlock.bodyTo > detailsBlock.bodyFrom) {
      builder.push(hiddenDetailsSourceDeco.range(detailsBlock.bodyFrom, detailsBlock.bodyTo));
    }
  }
}

function addFootnoteDefinitionDecorations(builder: DecorationCollector, state: EditorState, footnotes: ParsedFootnotes, activeLines: Set<number>, codeBlockLines: Set<number>, scope?: LiveDecorationScope): void {
  for (const definition of footnotes.definitions) {
    if (scope && (definition.lineTo < scope.from || definition.lineFrom > scope.to)) continue;
    if (!definition.isPrimary) {
      continue;
    }

    const showRawSyntax =
      rangeTouchesActiveLine(state, definition.lineFrom, definition.lineTo, activeLines) ||
      overlapsSelection(state, definition.lineFrom, definition.lineTo);
    if (definition.number === null || definition.firstReferenceFrom === null) {
      addRange(builder, definition.markerFrom, definition.markerFrom + 2, footnoteMarkerDeco);
      addRange(builder, definition.markerFrom + 2, definition.colonFrom - 1, footnoteLiteralDeco);
      addRange(builder, definition.colonFrom - 1, definition.colonFrom, footnoteMarkerDeco);
      addRange(builder, definition.colonFrom, definition.colonTo, activeLinkMarkerDeco);
      continue;
    }

    const firstLine = state.doc.lineAt(definition.lineFrom);
    if (showRawSyntax) {
      addRange(builder, definition.markerFrom, definition.markerFrom + 2, footnoteMarkerDeco);
      addRange(builder, definition.markerFrom + 2, definition.colonFrom - 1, footnoteLiteralDeco);
      addRange(builder, definition.colonFrom - 1, definition.colonFrom, footnoteMarkerDeco);
      addRange(builder, definition.colonFrom, definition.colonTo, activeLinkMarkerDeco);
    } else {
      builder.push(
        Decoration.replace({
          widget: new FootnoteBacklinkWidget(definition.number, definition.firstReferenceFrom),
          inclusive: false
        }).range(definition.markerFrom, definition.markerTo)
      );
      builder.push(lineStyleDecos.footnote.range(firstLine.from));
      let plainParagraph = true;
      for (let node: SyntaxNode | null = resolvedSyntaxTree(state).resolveInner(definition.contentFrom, 1); node; node = node.parent) {
        if (node.name === 'ListItem' || node.name === 'Blockquote' || node.name === 'CodeBlock' || node.name === 'FencedCode') plainParagraph = false;
      }
      if (plainParagraph) {
        const slot = liveBlockIndentCssValue({ columns: 0, footnoteNumber: definition.number });
        builder.push(Decoration.line({ attributes: {
          class: 'meo-md-container-prose',
          style: '--meo-live-prose-indent:' + slot + ';--meo-live-prose-prefix:' + slot + ';'
        } }).range(firstLine.from));
      }
    }

    for (const continuationLine of definition.continuationLines) {
      builder.push(lineStyleDecos.footnoteContinuation.range(continuationLine.from));
      builder.push(Decoration.line({ attributes: {
        style: '--meo-list-footnote-offset:calc(' + liveBlockIndentCssValue({ columns: 0, footnoteNumber: definition.number }) + ' - 4 * var(--meo-live-container-ch));'
      } }).range(continuationLine.from));
      if (codeBlockLines.has(state.doc.lineAt(continuationLine.from).number)) continue;
      if (continuationLine.hideIndentFrom !== null && continuationLine.hideIndentTo !== null) {
        builder.push(
          Decoration.replace({
            widget: new FootnoteBackrefSpacerWidget(definition.number),
            inclusive: false
          }).range(continuationLine.hideIndentFrom, continuationLine.hideIndentTo)
        );
        if (continuationLine.extraIndentColumns > 0) {
          builder.push(
            Decoration.widget({
              widget: listIndentWidget(continuationLine.extraIndentColumns),
              side: 1
            }).range(continuationLine.hideIndentTo)
          );
        }
      }
    }
  }
}

function addAtxHeadingPrefixMarkers(builder: DecorationCollector, state: EditorState, from: number, activeLines: Set<number>): void {
  const line = state.doc.lineAt(from);
  const text = state.doc.sliceString(line.from, line.to);
  const match = /^(#{1,6}[ \t]+)/.exec(text);
  if (!match) {
    return;
  }

  const prefixTo = line.from + match[1].length;
  if (activeLines.has(line.number)) {
    addRange(builder, line.from, prefixTo, activeLineMarkerDeco);
    return;
  }
  addRange(builder, line.from, prefixTo, markerDeco);
}

function isFootnoteDefinitionMarker(footnotes: ParsedFootnotes, from: number, to: number): boolean {
  return footnotes.definitions.some(
    (definition) => from >= definition.markerFrom && to <= definition.colonTo
  );
}

function isFootnoteDefinitionContent(footnotes: ParsedFootnotes, from: number, to: number): boolean {
  return footnotes.definitions.some(
    (definition) => from >= definition.contentFrom && to <= definition.contentTo
  );
}

export function collectInlineMarkdownSyntaxRanges(text: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const patterns = [
    /\*\*|__|~~|`+/g,
    /(?<!\\)[*_]/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (
        match[0] === '_' &&
        /[\p{L}\p{N}\p{M}_]/u.test(text[match.index - 1] ?? '') &&
        /[\p{L}\p{N}\p{M}_]/u.test(text[match.index + 1] ?? '')
      ) {
        continue;
      }
      ranges.push({ from: match.index, to: match.index + match[0].length });
    }
  }

  ranges.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: SourceRange[] = [];
  for (const range of ranges) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function addHeadingContentColor(builder: DecorationCollector, state: EditorState, contentFrom: number, to: number): void {
  if (contentFrom >= to) {
    return;
  }

  const syntaxRanges = collectInlineMarkdownSyntaxRanges(state.doc.sliceString(contentFrom, to));
  let segmentFrom = contentFrom;
  for (const syntaxRange of syntaxRanges) {
    const syntaxFrom = contentFrom + syntaxRange.from;
    const syntaxTo = contentFrom + syntaxRange.to;
    if (segmentFrom < syntaxFrom) {
      addRange(builder, segmentFrom, syntaxFrom, headingContentDeco);
    }
    segmentFrom = Math.max(segmentFrom, syntaxTo);
  }
  if (segmentFrom < to) {
    addRange(builder, segmentFrom, to, headingContentDeco);
  }
}

interface ParsedListMarker {
  readonly listMarkFrom: number;
  readonly containerKey: string;
  readonly depth: number;
}

function parsedListMarkersByLine(state: EditorState, tree: Tree, scope?: LiveDecorationScope) {
  const cached = scope ? undefined : parsedContainerCache.get(state.doc);
  if (cached?.tree === tree) return cached.value;
  const markers = new Map<number, ParsedListMarker[]>();
  const quoteMarks = new Map<number, Array<{ from: number; to: number }>>();
  tree.iterate({
    ...scope,
    enter(node: SyntaxNodeRef) {
      if (node.name === 'QuoteMark') {
        const lineNo = state.doc.lineAt(node.from).number;
        const ends = quoteMarks.get(lineNo) ?? [];
        ends.push({ from: node.from, to: node.to });
        quoteMarks.set(lineNo, ends);
        return;
      }
      if (node.name !== 'ListItem') return;
      let listMark = node.node.firstChild;
      while (listMark && listMark.name !== 'ListMark') listMark = listMark.nextSibling;
      if (!listMark) return;
      const lineNo = state.doc.lineAt(listMark.from).number;
      let depth = 0;
      for (let parent = node.node.parent; parent; parent = parent.parent) {
        if (parent.name === 'BulletList' || parent.name === 'OrderedList') depth += 1;
      }
      const container = node.node.parent;
      const entries = markers.get(lineNo) ?? [];
      entries.push({
        listMarkFrom: listMark.from,
        containerKey: `${container?.from}:${container?.to}`,
        depth: Math.max(0, depth - 1)
      });
      markers.set(lineNo, entries);
    }
  });
  const result = { markers, quoteMarks };
  if (!scope) parsedContainerCache.set(state.doc, { tree, value: result });
  return result;
}

const parsedContainerCache = new WeakMap<EditorState['doc'], { tree: Tree; value: { markers: Map<number, ParsedListMarker[]>;
  quoteMarks: Map<number, Array<SourceRange>> } }>();

function addListLineDecorations(
  builder: DecorationCollector,
  state: EditorState,
  indentSelectedLines: Set<number>,
  parsedContainers: ReturnType<typeof parsedListMarkersByLine>,
  frontmatter: FrontmatterInfo | null = null,
  literalBlockLines: Set<number> | null = null,
  scope?: LiveDecorationScope
): void {
  const stylesByLine = detectListIndentStylesByLine(state, scope);
  const { markers: parsedMarkers, quoteMarks: quoteMarksByLine } = parsedContainers;
  const orderedCountsByContainer = new Map<string, number>();
  const legacyOrderedCountsByLevel: Array<number | null> = [];

  for (const line of scopedDocumentLines(state, scope)) {
    const lineNo = line.number;
    if (literalBlockLines?.has(lineNo)) {
      legacyOrderedCountsByLevel.length = 0;
      continue;
    }
    const lineText = line.text;
    const style = stylesByLine.get(lineNo);
    const entries = parsedMarkers.get(lineNo) ?? [];
    if (!entries.length) {
      // Preserve Live's existing rendering for list-like lines that CommonMark
      // treats as paragraph continuations (for example, a non-1 ordered start).
      let marker = listMarkerData(lineText, null, style);
      if (!marker) {
        legacyOrderedCountsByLevel.length = 0;
        continue;
      }
      const { expected } = nextOrderedSequenceNumber(
        legacyOrderedCountsByLevel, marker.indentLevel, marker.orderedNumber
      );
      if (marker.orderedNumber && expected !== null && String(expected).length > marker.orderedNumber.length) {
        marker = listMarkerData(lineText, expected, style)!;
      }
      if (isInsideFrontmatterContent(frontmatter, line.from)) {
        addListMarkerDecoration(builder, state, line.from, expected, style, { useSourceStyleLiteral: true });
        continue;
      }
      if (marker.fromOffset > 0 && marker.indentColumns > 0
        && getLiveBlockIndent(state, line.from + marker.fromOffset).footnoteNumber === null) {
        builder.push(Decoration.replace({
          widget: listIndentWidget(marker.indentColumns), inclusive: false
        }).range(line.from, line.from + marker.fromOffset));
      }
      builder.push(listLineDeco(
        marker.contentOffsetColumns, marker.indentColumns, style?.columns ?? 2,
        indentSelectedLines.has(lineNo), marker.isTask, marker.taskHiddenPrefixColumns,
        Boolean(marker.orderedNumber)
      ).range(line.from));
      addListMarkerDecoration(builder, state, line.from, expected, style);
      continue;
    }
    legacyOrderedCountsByLevel.length = 0;
    const inFrontmatterContent = isInsideFrontmatterContent(frontmatter, line.from);
    let deepest: { marker: NonNullable<ReturnType<typeof listMarkerData>>; depth: number; showTaskListMarker: boolean } | null = null;
    let previousMarkerEnd = line.from;
    for (const entry of entries) {
      const precedingQuoteMarks = (quoteMarksByLine.get(lineNo) ?? []).filter((mark) => mark.to <= entry.listMarkFrom);
      const quoteEnd = Math.max(line.from, ...precedingQuoteMarks.map((mark) => mark.to));
      const markerOffset = Math.max(quoteEnd, previousMarkerEnd) - line.from;
      let marker = listMarkerData(lineText, null, style, markerOffset);
      if (!marker || line.from + marker.fromOffset !== entry.listMarkFrom) continue;
      previousMarkerEnd = line.from + marker.toOffset;
      const previousCount = orderedCountsByContainer.get(entry.containerKey);
      const orderedDisplayIndex = marker.orderedNumber === undefined
        ? null
        : previousCount === undefined ? Number.parseInt(marker.orderedNumber, 10) : previousCount + 1;
      if (orderedDisplayIndex !== null) orderedCountsByContainer.set(entry.containerKey, orderedDisplayIndex);
      if (marker.orderedNumber && orderedDisplayIndex !== null
        && String(orderedDisplayIndex).length > marker.orderedNumber.length) {
        marker = listMarkerData(lineText, orderedDisplayIndex, style, markerOffset)!;
      }
      // Parsed container offsets are physical columns, including tab stops.
      marker.indentColumns = countColumn(lineText, state.tabSize, marker.fromOffset)
        - countColumn(lineText, state.tabSize, markerOffset);
      marker.contentOffsetColumns = countColumn(lineText, state.tabSize, marker.toOffset) + marker.displayExtraColumns;
      if (inFrontmatterContent) {
        addListMarkerDecoration(builder, state, line.from, orderedDisplayIndex, style, {
          useSourceStyleLiteral: true
        }, markerOffset);
        continue;
      }
      if (marker.fromOffset > markerOffset && marker.indentColumns > 0
        && (markerOffset > 0 || getLiveBlockIndent(state, line.from + marker.fromOffset).footnoteNumber === null)) {
        builder.push(Decoration.replace({
          widget: listIndentWidget(marker.indentColumns),
          inclusive: false
        }).range(line.from + markerOffset, line.from + marker.fromOffset));
      }
      const showTaskListMarker = marker.isTask && entries.length > 1;
      addListMarkerDecoration(builder, state, line.from, orderedDisplayIndex, style,
        showTaskListMarker ? { showTaskListMarker: true } : null, markerOffset);
      if (!deepest || entry.depth >= deepest.depth) {
        deepest = { marker, depth: entry.depth, showTaskListMarker };
      }
    }
    if (deepest && !inFrontmatterContent) {
      const { marker, showTaskListMarker } = deepest;
      builder.push(listLineDeco(
        marker.contentOffsetColumns,
        marker.indentColumns,
        style?.columns ?? 2,
        indentSelectedLines.has(lineNo),
        marker.isTask,
        showTaskListMarker && marker.taskBracketStart !== undefined
          ? Math.max(0, marker.toOffset - marker.taskBracketStart - 1)
          : marker.taskHiddenPrefixColumns,
        Boolean(marker.orderedNumber)
      ).range(line.from));
    }
  }
}

function buildDecorationRanges(state: EditorState, previous?: DecorationSet, changes?: ChangeDesc, scope?: LiveDecorationScope): {
  ranges: DecorationCollector; tree: Tree
} {
  const ranges: DecorationCollector = [];
  const diagnostics = state.field(diagnosticDataField, false) ?? [];
  const activeLines = collectActiveLines(state);
  const indentSelectedLines = collectIndentSelectedLines(state);
  const tree = resolvedSyntaxTree(state);
  const footnotes = parseFootnotes(state);
  const detailsBlocks = getDetailsBlocks(state, tree);
  const codeBlockLines = collectCodeBlockLines(state, tree, scope);
  const renderedTableRanges: SourceRange[] = [];
  if (scope) tree.iterate({ ...scope, enter(node) {
    if (node.name === 'Table') { renderedTableRanges.push({ from: node.from, to: node.to }); return false; }
  } });
  else renderedTableRanges.push(...collectRenderedTableRanges(state, getLiveRenderedBlocks(state)));
  if (scope) for (const block of detectTableBlocks(state, scope)) {
    const from = state.doc.line(block.startLineNo).from, to = state.doc.line(block.endLineNo).to;
    if (!isInsideCodeBlock(tree, from) && !overlapsParsedTableRange(from, to, renderedTableRanges)) renderedTableRanges.push({ from, to });
  }
  renderedTableRanges.sort((left, right) => left.from - right.from);
  const parsedContainers = parsedListMarkersByLine(state, tree, scope);
  const activeImageGroups = new Map<number, ActiveImageGroup>();
  const parsedTableRanges: SourceRange[] = [];
  const quoteDepthByLine = new Map<number, number>();
  const quoteBarsByLine = new Map<number, { columns: number[]; taskIndents: TaskListIndent[]; insideList: boolean }>();
  let tableDepth = 0;

  let frontmatter: FrontmatterInfo | null = null;
  try {
    frontmatter = parseFrontmatter(state);
    if (frontmatter && (!scope || frontmatter.closingTo >= scope.from && frontmatter.openingFrom <= scope.to)) {
      addFrontmatterBoundaryDecorations(ranges, state, frontmatter, activeLines);
    } else if (!frontmatter) {
      frontmatter = parseFrontmatterCandidate(state);
    }
  } catch {
    frontmatter = null;
  }
  const mathRanges = collectMathRanges(state, tree, renderedTableRanges, frontmatter, scope)
    .filter(range => !scope || range.to >= scope.from && range.from <= scope.to);
  const insideMath = indexSourceRanges(mathRanges);
  const insideFencedMathLine = indexSourceRanges(mathRanges.filter(math => math.fencedDisplay).map(math => ({
    from: state.doc.lineAt(math.from).from,
    to: math.to
  })));
  // Markdown fallbacks must not turn TeX operators or indentation into prose widgets.
  const literalBlockLines = new Set(codeBlockLines);
  for (const math of mathRanges) {
    if (!math.fencedDisplay) continue;
    const lastLine = state.doc.lineAt(math.to - 1).number;
    for (let lineNo = state.doc.lineAt(math.from).number; lineNo <= lastLine; lineNo += 1) {
      literalBlockLines.add(lineNo);
    }
  }
  addForcedThematicBreakDecorations(ranges, state, tree, activeLines, frontmatter, literalBlockLines, scope);
  const literalRanges = collectMarkdownLiteralRanges(state, tree, scope);
  const htmlCodeBodies = literalRanges.flatMap(range => range.htmlCode ? [range.htmlCode] : []);
  const insideHtmlCode = indexSourceRanges(htmlCodeBodies);
  for (const body of htmlCodeBodies) if (!scope || body.to >= scope.from && body.from <= scope.to) addRange(ranges, body.from, body.to, inlineStyleDecos.inlineCode);
  const inlineHtmlRanges: Array<{ from: number; to: number }> = [];
  const renderedHtmlBlocks = addHtmlContentDecorations(ranges, state, activeLines, previous, changes, inlineHtmlRanges, scope);

  // Foundation readers can finish the parser while preparing shared context.
  // Render the completed outer Markdown tree now, rather than publishing a
  // partial presentation whose first caret movement must rebuild the file.
  const preparedTree = resolvedSyntaxTree(state, 0);
  if (!scope && usesLargeDocumentDerivedWorkBudget(state) && preparedTree !== tree
    && syntaxTreeAvailable(state, state.doc.length) && !hasSameLiveMarkdownSyntax(tree, preparedTree)) {
    return buildDecorationRanges(state, previous, changes);
  }

  tree.iterate({
    ...scope,
    enter: (node: SyntaxNodeRef) => {
      if (scope && (node.to < scope.from || node.from > scope.to)) return false;
      // Formula source owns the whole line prefix. Hiding only opening-line
      // quote markers would give its delimiter a different visual source width.
      if (node.name === 'QuoteMark' && insideFencedMathLine(node.from, node.to)) return false;
      // Literal HTML code and TeX source keep their original characters when widgets reveal source.
      // Lezer can otherwise pair a TeX caret with one in a later formula or style code contents.
      if (insideHtmlCode(node.from, node.to) || insideMath(node.from, node.to)
        || ['Subscript', 'Superscript', 'Emphasis', 'StrongEmphasis', 'Strikethrough', 'Highlight'].includes(node.name)
          && insideMath(node.from, node.from + 1)) return false;
      if (hasCodeBlockAncestor(node)) {
        if (node.name === 'QuoteMark') {
          const line = state.doc.lineAt(node.from);
          addLineAwareRange(
            ranges,
            activeLines,
            line.number,
            node.from,
            node.to,
            markerDeco,
            activeLineMarkerDeco
          );
          return;
        }
        if (!node.name.endsWith('Mark') || !isFenceMarker(state, node.from, node.to)) {
          return;
        }
      }

      if (node.name === 'Table') {
        tableDepth += 1;
      }
      if (node.name === 'HorizontalRule' && !isInsideFrontmatter(frontmatter, node.from)) {
        addThematicBreakDecorations(ranges, state, node.from, node.to, activeLines);
        return;
      }

      const headingLevel = headingLevelFromName(node.name);
      if (headingLevel !== null) {
        if (tableDepth === 0 && !isInsideFrontmatter(frontmatter, node.from)) {
          const content = headingContentRange(state, node.node);
          if (node.name.startsWith('SetextHeading')) {
            const underline = node.node.lastChild!;
            const active = rangeTouchesActiveLine(state, node.from, node.to, activeLines);
            addRange(ranges, underline.from, underline.to, active ? activeLineMarkerDeco : markerDeco);
          } else {
            addAtxHeadingPrefixMarkers(ranges, state, node.from, activeLines);
          }
          addHeadingContentColor(ranges, state, content.from, content.to);
          const headingDecoration = [
            lineStyleDecos.h1,
            lineStyleDecos.h2,
            lineStyleDecos.h3,
            lineStyleDecos.h4,
            lineStyleDecos.h5,
            lineStyleDecos.h6
          ][headingLevel - 1];
          addLineClass(ranges, state, node.from, content.to, headingDecoration);
        }
      }

      if (node.name === 'Blockquote') {
        const line = state.doc.lineAt(node.from);
        const lineText = state.doc.sliceString(line.from, line.to).trimStart();
        if (lineText.startsWith('>>>>>>>')) {
          addLineClass(ranges, state, node.from, node.to, lineStyleDecos.mergeIncomingHeader);
          return;
        }
        let depth = 1;
        let insideList = false;
        for (let parent = node.node.parent; parent; parent = parent.parent) {
          if (parent.name === 'Blockquote') depth += 1;
          if (parent.name === 'ListItem') insideList = true;
        }
        // Quote glyphs and list widgets retain their source column widths.
        const initialColumn = countColumn(line.text, state.tabSize, node.from - line.from);
        const lastLine = state.doc.lineAt(Math.max(node.from, node.to - 1)).number;
        for (let lineNo = line.number; lineNo <= lastLine; lineNo += 1) {
          if (depth > 1) {
            quoteDepthByLine.set(lineNo, Math.max(depth, quoteDepthByLine.get(lineNo) ?? 0));
          }
          const lineStart = state.doc.line(lineNo).from;
          const marks = parsedContainers.quoteMarks.get(lineNo) ?? [];
          const explicitMark = marks[depth - 1];
          const column = explicitMark
            ? countColumn(state.doc.line(lineNo).text, state.tabSize, explicitMark.from - lineStart)
            : initialColumn;
          const bars = quoteBarsByLine.get(lineNo) ?? { columns: [], taskIndents: [], insideList: false };
          bars.columns.push(Math.max(0, column));
          bars.taskIndents.push(getLiveTaskListIndent(state, lineStart, node.node));
          bars.insideList ||= insideList;
          quoteBarsByLine.set(lineNo, bars);
        }
        const alertBlock = detectAlertInBlockquote(state, node);
        if (alertBlock) {
          addAlertBlockDecorations(ranges, state, node, alertBlock, activeLines);
          return;
        }
        addLineClass(ranges, state, node.from, node.to, lineStyleDecos.quote);
      } else if (node.name === 'Table') {
        const tableInfo = parseTableInfo(state, node);
        parsedTableRanges.push({ from: tableInfo.from, to: tableInfo.to });
        addTableDecorations(ranges, state, node, diagnostics, state.field(gitDiffLineFlagsField, false));
      } else if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
        const sourceDecorationStart = ranges.length;
        const indentColumns = getLiveBlockIndent(state, node.from, node.node);
        addLineClass(ranges, state, node.from, node.to, lineStyleDecos.codeBlock);
        addBlockIndentLines(ranges, state, node.from, node.to, indentColumns);
        addCodeContainerLines(ranges, state, node.node, indentColumns);
        ranges.push(lineStyleDecos.codeBlockStart.range(state.doc.lineAt(node.from).from));
        ranges.push(lineStyleDecos.codeBlockEnd.range(state.doc.lineAt(Math.max(node.to - 1, node.from)).from));
        if (node.name === 'FencedCode') {
          addFenceOpeningLineMarker(
            ranges,
            state,
            node.from,
            activeLines,
            addRange,
            activeLineMarkerDeco,
            fenceMarkerDeco
          );

          const codeInfo = getFencedCodeInfo(state, node);
          if (codeInfo === 'mermaid') {
            const sourceDecorationEnd = ranges.length;
            if (addMermaidDiagram(ranges, state, node, activeLines)) {
              ranges.splice(sourceDecorationStart, sourceDecorationEnd - sourceDecorationStart);
            }
            return;
          }
        }
        addCodeLanguageLabel(ranges, state, node, activeLines);
        if (node.name === 'CodeBlock') {
          ranges.push(lineStyleDecos.indentedCodeBlockStart.range(state.doc.lineAt(node.from).from));
          ranges.push(lineStyleDecos.indentedCodeBlockEnd.range(state.doc.lineAt(Math.max(node.to - 1, node.from)).from));
        }
        addCodeBlockLineNumbers(ranges, state, node);
        addCopyCodeButton(ranges, state, node);
      }

      if (node.name === 'Emphasis') {
        addEmphasisDecorations(ranges, state, node);
      } else if (node.name === 'StrongEmphasis') {
        addStrongEmphasisDecorations(ranges, state, node);
      } else if (node.name === 'Strikethrough') {
        addStrikethroughDecorations(ranges, state, node);
      } else if (node.name === 'Highlight') {
        addHighlightDecorations(ranges, state, node);
      } else if (node.name === 'InlineCode' || node.name === 'CodeText') {
        addRange(ranges, node.from, node.to, inlineStyleDecos.inlineCode);
      } else if (node.name === 'LinkLabel') {
        const parentName = node.node.parent?.name ?? '';
        if (
          parentName === 'Link' &&
          node.to - node.from >= 2 &&
          !isFootnoteDefinitionMarker(footnotes, node.from, node.to)
        ) {
          const line = state.doc.lineAt(node.from);
          const markerDecoForLine = activeLines.has(line.number) ? activeLinkLabelBracketDeco : linkLabelBracketDeco;
          addRange(ranges, node.from, node.from + 1, markerDecoForLine);
          addRange(ranges, node.to - 1, node.to, markerDecoForLine);
        }
      } else if (node.name === 'Link') {
        const markerRanges = collectInlineFootnoteMarkerRanges(state.doc.sliceString(node.from, node.to));
        if (markerRanges.length) {
          addInlineFootnoteMarkerSyntaxDecorations(ranges, node.from, markerRanges);
        }

        const footnoteReferences = footnotes.referencesByContainerKey.get(footnoteReferenceKey(node.from, node.to));
        if (markerRanges.length) {
          const resolvedReferenceKeys = new Set(
            (footnoteReferences ?? []).map((reference) => footnoteReferenceKey(reference.from, reference.to))
          );
          const renderedFootnoteReferences: FootnoteReference[] = [];
          for (const footnoteReference of footnoteReferences ?? []) {
            if (addFootnoteReferenceDecorations(ranges, state, footnoteReference, activeLines)) {
              renderedFootnoteReferences.push(footnoteReference);
            }
          }
          for (let index = 0; index < renderedFootnoteReferences.length - 1; index += 1) {
            const currentReference = renderedFootnoteReferences[index];
            const nextReference = renderedFootnoteReferences[index + 1];
            if (currentReference.to !== nextReference.from) {
              continue;
            }
            ranges.push(
              Decoration.widget({
                widget: footnoteReferenceSeparatorWidget,
                side: 1
              }).range(currentReference.to)
            );
          }
          for (const markerRange of markerRanges) {
            const markerFrom = node.from + markerRange.fromOffset;
            const markerTo = node.from + markerRange.toOffset;
            if (resolvedReferenceKeys.has(footnoteReferenceKey(markerFrom, markerTo))) {
              continue;
            }
            addRange(ranges, markerFrom + 2, markerTo - 1, footnoteLiteralDeco);
          }
          return;
        }
        if (addWikiLinkDecorations(ranges, state, node, activeLines)) {
          return;
        }
        const emptyImageUrl = getEmptyImageLinkUrl(state, node);
        if (emptyImageUrl) {
          const line = state.doc.lineAt(node.from);
          if (!activeLines.has(line.number)) {
            const linkSelection = overlapsSelection(state, node.from, node.to);
            if (!linkSelection) {
              ranges.push(
                Decoration.replace({
                  widget: new ImageWidget(
                    emptyImageUrl,
                    '',
                    '',
                    node.from,
                    getImagePresentationFactory(state),
                    { uiLanguage: state.facet(uiLanguageFacet) }
                  ),
                  inclusive: false
                }).range(node.from, node.to)
              );
              return;
            }
          }
        }
        addMarkdownLinkDecorations(ranges, state, node, activeLines);
      } else if (node.name === 'Autolink') {
        addAutolinkDecorations(ranges, state, node, activeLines);
      } else if (node.name === 'URL') {
        const parentName = node.node.parent?.name ?? '';
        if (parentName === 'LinkReference' && isFootnoteDefinitionContent(footnotes, node.from, node.to)) {
          addRange(ranges, node.from, node.to, footnoteDefinitionContentDeco);
        } else if (parentName !== 'Link' && parentName !== 'Autolink') {
          const href = getNodeHref(state, node.node);
          const rawUrl = state.doc.sliceString(node.from, node.to);
          if (isInsideFrontmatterContent(frontmatter, node.from)) {
            return;
          }
          const isActiveLine = activeLines.has(state.doc.lineAt(node.from).number);
          addTrimmedUrlLinkMark(ranges, node.from, node.to, rawUrl, href, !isActiveLine);
        }
      } else if (node.name === 'Image') {
        const line = state.doc.lineAt(node.from);
        const isActiveLine = activeLines.has(line.number);
        const imageSelection = overlapsSelection(state, node.from, node.to);

        if (isActiveLine || imageSelection) {
          const { url, altText, linkUrl, width, height } = getImageData(state, node);
          if (url) {
            const group = activeImageGroups.get(line.number) ?? { line, items: [] };
            group.items.push({ url, altText, linkUrl, width, height, sourceFrom: node.from });
            activeImageGroups.set(line.number, group);
          }
          return;
        }

        const { url, altText, linkUrl, width, height } = getImageData(state, node);
        if (url) {
          ranges.push(
            Decoration.replace({
              widget: new ImageWidget(
                url,
                altText,
                linkUrl,
                node.from,
                getImagePresentationFactory(state),
                { uiLanguage: state.facet(uiLanguageFacet), width, height }
              ),
              inclusive: false
            }).range(node.from, node.to)
          );
        }
      } else if ((node.name === 'HTMLTag' || node.name === 'HTMLBlock') && tableDepth === 0) {
        addHtmlBreakDecoration(ranges, state, node, activeLines, frontmatter);
      }

      if (node.name === 'Subscript' || node.name === 'Superscript') {
        const footnoteContainer = node.node.parent?.name === 'Link' ? node.node.parent : null;
        const isFootnoteReference = Boolean(
          footnoteContainer && footnotes.referencesByContainerKey.has(
            footnoteReferenceKey(footnoteContainer.from, footnoteContainer.to)
          )
        );
        if (!isFootnoteReference && node.to - node.from > 2) {
          addRange(
            ranges,
            node.from + 1,
            node.to - 1,
            node.name === 'Subscript' ? subscriptContentDeco : superscriptContentDeco
          );
          const active = activeLines.has(state.doc.lineAt(node.from).number);
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.name === 'Escape') {
              addRange(ranges, child.from, child.from + 1, active ? activeLineMarkerDeco : markerDeco);
            }
          }
        }
      }

      if (!node.name.endsWith('Mark')) {
        return;
      }

      const line = state.doc.lineAt(node.from);
      if (isInsideFrontmatterContent(frontmatter, node.from)) {
        return;
      }
      if (isMergeConflictMarkerLine(state, node.from)) {
        // Keep merge conflict markers visible in live mode (e.g. ">>>>>>> branch")
        // even when the Markdown parser tokenizes them as quote markers.
        return;
      }
      if (tableDepth > 0 && node.name === 'HeaderMark') {
        return;
      }
      if (node.name === 'HeaderMark' && node.node.parent?.name.startsWith('SetextHeading')) return;
      if (isFenceMarker(state, node.from, node.to)) {
        // Show fence markers on all lines (not just active)
        addLineAwareRange(ranges, activeLines, line.number, node.from, node.to, fenceMarkerDeco, activeLineMarkerDeco);
      } else if (node.name === 'EmphasisMark') {
        const parentName = node.node.parent?.name;
        const inactiveDeco = parentName === 'StrongEmphasis' ? strongMarkerDeco : emMarkerDeco;
        const activeDeco = parentName === 'StrongEmphasis' ? activeStrongMarkerDeco : activeEmMarkerDeco;
        addInlineMarkerRange(
          ranges,
          activeLines,
          line.number,
          node.from,
          node.to,
          inactiveDeco,
          activeDeco,
          node.node.parent?.to === node.to
        );
      } else if (node.name === 'StrikethroughMark') {
        addInlineMarkerRange(
          ranges,
          activeLines,
          line.number,
          node.from,
          node.to,
          strikeMarkerDeco,
          activeStrikeMarkerDeco,
          node.node.parent?.to === node.to
        );
      } else if (node.name === 'HighlightMark') {
        addInlineMarkerRange(
          ranges,
          activeLines,
          line.number,
          node.from,
          node.to,
          highlightMarkerDeco,
          activeHighlightMarkerDeco,
          node.node.parent?.to === node.to
        );
      } else if (node.name === 'CodeMark') {
        addInlineMarkerRange(
          ranges,
          activeLines,
          line.number,
          node.from,
          node.to,
          codeMarkerDeco,
          activeCodeMarkerDeco,
          node.node.parent?.to === node.to
        );
      } else if (node.name === 'LinkMark') {
        const parentName = node.node.parent?.name ?? '';
        if (
          parentName === 'Link' &&
          footnotes.referencesByContainerKey.has(
            footnoteReferenceKey(node.node.parent?.from ?? -1, node.node.parent?.to ?? -1)
          )
        ) {
          return;
        }
        // For image links, check if the image node overlaps with selection to show markers
        let useActiveDeco = activeLines.has(line.number);
        if (parentName === 'Image') {
          const imageNode = node.node.parent;
          if (!imageNode) {
            return;
          }
          const { url } = getImageData(state, imageNode);
          if (!url) {
            return;
          }
          // Also show active markers if the image is selected
          if (!useActiveDeco && overlapsSelection(state, imageNode.from, imageNode.to)) {
            useActiveDeco = true;
          }
        } else if (parentName === 'Link') {
          if (isWikiLinkNode(state, node.node.parent)) {
            return;
          }
          const urlNode = findChildNode(node.node.parent, 'URL');
          if (!urlNode) {
            return;
          }
          const href = getNodeHref(state, urlNode);
          if (!href) {
            return;
          }
        }
        addRange(ranges, node.from, node.to, useActiveDeco ? activeLinkMarkerDeco : linkMarkerDeco);
      } else if (
        node.name === 'SuperscriptMark' &&
        node.node.parent?.parent?.name === 'Link' &&
        footnotes.referencesByContainerKey.has(
          footnoteReferenceKey(node.node.parent.parent.from, node.node.parent.parent.to)
        )
      ) {
        // Keep "^" visible for unresolved markers inside partially-resolved
        // adjacent footnote sequences (e.g. "[^4][^5]" where only "[^4]" resolves).
        return;
      } else if (activeLines.has(line.number)) {
        addRange(ranges, node.from, node.to, node.name === 'QuoteMark' ? activeQuoteMarkerDeco : activeLineMarkerDeco);
      } else {
        addRange(ranges, node.from, node.to, node.name === 'QuoteMark' ? quoteMarkerDeco : markerDeco);
      }
    },
    leave: (node: SyntaxNodeRef) => {
      if (node.name === 'Table') {
        tableDepth -= 1;
      }
    },
  });

  for (const [lineNo, depth] of quoteDepthByLine) {
    ranges.push(Decoration.line({
      attributes: {
        class: 'meo-md-quote-nested',
        style: `--meo-quote-extra-width:${depth - 1}ch;`
      }
    }).range(state.doc.line(lineNo).from));
  }

  // An inner quote belongs after its enclosing list marker, even on continuation lines.
  for (const [lineNo, bars] of quoteBarsByLine) {
    const line = state.doc.line(lineNo);
    const definition = footnotes.definitions.find(candidate => candidate.isPrimary && candidate.number !== null
      && line.from > candidate.lineFrom && line.from <= candidate.lineTo);
    if (!codeBlockLines.has(lineNo)) {
      const prefix = parseBlockLinePrefix(line.text, state.tabSize).prefix;
      const hiddenDefinitionIndent = definition ? (/^[ \t]*/.exec(line.text)?.[0].length ?? 0) : 0;
      // A proportional font's spaces are narrower than its column unit. Keep
      // source prefixes the same width as rendered tables and list spacers.
      for (const match of prefix.matchAll(/[ \t]+/g)) {
        if (match.index < hiddenDefinitionIndent) continue;
        const startColumns = parseBlockLinePrefix(prefix.slice(0, match.index), state.tabSize).columns;
        const endColumns = parseBlockLinePrefix(prefix.slice(0, match.index + match[0].length), state.tabSize).columns;
        ranges.push(Decoration.mark({ attributes: {
          class: 'meo-md-quote-prefix-space',
          style: '--meo-quote-space-width:calc(' + (endColumns - startColumns) + ' * var(--meo-live-container-ch));'
        } }).range(line.from + match.index, line.from + match.index + match[0].length));
      }
    }
    const columns = [...new Set(bars.columns)].sort((left, right) => left - right);
    const taskOffsets = columns.map(column => liveTaskListIndentCssValue(bars.taskIndents[bars.columns.indexOf(column)]!));
    const first = columns[0];
    const sourceFirstColumn = definition
      ? 'calc(' + (Math.max(0, first - 4) + String(definition.number).length + 1) + ' * var(--meo-live-container-ch) + 0.45 * var(--meo-user-editor-font-size, var(--meo-font-live-size)))'
      : 'calc(' + first + ' * var(--meo-live-container-ch))';
    const firstColumn = 'calc(' + sourceFirstColumn + ' + ' + taskOffsets[0] + ')';
    const ruleColor = 'var(--meo-quote-rule-color, var(--meo-semantic-blockquoteBorder))';
    const backgrounds = columns.map((column, index) =>
      `linear-gradient(${ruleColor}, ${ruleColor}) calc(${column - first} * var(--meo-live-container-ch) + ${taskOffsets[index]} - ${taskOffsets[0]}) 0 / 3px 100% no-repeat`
    ).join(',');
    const firstListMarker = parsedContainers.markers.get(lineNo)?.[0]?.listMarkFrom;
    const leadingQuote = firstListMarker !== undefined && (parsedContainers.quoteMarks.get(lineNo)?.at(-1)?.to ?? line.from) <= firstListMarker;
    ranges.push(Decoration.line({ attributes: {
      class: 'meo-md-quote-source-order' + (leadingQuote ? ' meo-md-quote-leading' : ''),
      style: `--meo-quote-first-column:${firstColumn};--meo-quote-bars:${backgrounds};`
    } }).range(state.doc.line(lineNo).from));
  }

  for (const { line, items } of activeImageGroups.values()) {
    const widget = items.length === 1
      ? new ImageWidget(
        items[0].url,
        items[0].altText,
        items[0].linkUrl,
        items[0].sourceFrom,
        getImagePresentationFactory(state),
        { uiLanguage: state.facet(uiLanguageFacet) }
      )
      : new ImageGroupWidget(
        items,
        getImagePresentationFactory(state),
        state.facet(uiLanguageFacet)
      );
    ranges.push(
      Decoration.widget({ widget, side: 1, block: true }).range(line.to)
    );
  }

  addFallbackTableDecorations(ranges, state, tree, parsedTableRanges, diagnostics, scope);
  addRawFileUrlDecorations(ranges, state, tree, activeLines, frontmatter, scope);
  // Source prose and rendered blocks consume the same task-marker width delta.
  for (const line of scopedDocumentLines(state, scope)) {
    const lineNo = line.number;
    if (literalBlockLines.has(lineNo)) continue;
    const prefix = parseBlockLinePrefix(line.text, state.tabSize);
    if (!prefix.prefix) continue;
    const contentFrom = line.from + prefix.prefix.length;
    const indent = getLiveBlockIndent(state, contentFrom);
    const taskIndent = indent.taskIndent ?? { checkboxes: 0, sourceColumns: 0 };
    if (taskIndent.checkboxes) ranges.push(Decoration.line({ attributes: {
      class: 'meo-md-task-continuation',
      style: '--meo-live-task-indent:' + liveTaskListIndentCssValue(taskIndent) + ';'
    } }).range(line.from));
    if (!prefix.prefix || parsedContainers.markers.has(lineNo) || listMarkerData(line.text)) continue;
    const proseIndent = liveBlockIndentCssValue(indent);
    if (!proseIndent) continue;
    if (!prefix.quoteColumns.length && indent.footnoteNumber === null) ranges.push(Decoration.mark({ attributes: {
      class: 'meo-md-quote-prefix-space',
      style: '--meo-quote-space-width:calc(' + prefix.columns + ' * var(--meo-live-container-ch));'
    } }).range(line.from, contentFrom));
    ranges.push(Decoration.line({ attributes: {
      class: 'meo-md-container-prose',
      style: '--meo-live-prose-indent:' + proseIndent + ';--meo-live-prose-prefix:calc(' + proseIndent + ' - '
        + liveTaskListIndentCssValue(taskIndent) + ');'
    } }).range(line.from));
  }
  addListLineDecorations(ranges, state, indentSelectedLines, parsedContainers, frontmatter, literalBlockLines, scope);
  addMathDecorations(ranges, state, mathRanges, activeLines);
  addColorSwatchDecorations(
    ranges,
    state,
    tree,
    activeLines,
    [
      renderedTableRanges,
      mathRanges,
      frontmatter ? [{ from: frontmatter.openingFrom, to: frontmatter.closingTo }] : []
    ],
    scope
  );
  addKbdTagDecorations(ranges, state, activeLines, renderedTableRanges, mathRanges, frontmatter, codeBlockLines, scope);
  addFootnoteDefinitionDecorations(ranges, state, footnotes, activeLines, literalBlockLines, scope);
  const htmlEditingRange = getHtmlEditingRange(state);
  addDetailsBlockDecorations(
    ranges,
    state,
    detailsBlocks.filter((detailsBlock) => (!scope || detailsBlock.sectionFrom >= scope.from && detailsBlock.sectionTo <= scope.to) && !renderedHtmlBlocks.some((htmlBlock) => (
      htmlBlock.from === detailsBlock.anchorFrom
    )) && !(
      htmlEditingRange?.from === detailsBlock.sectionFrom &&
      htmlEditingRange.to === detailsBlock.sectionTo
    ))
  );
  preserveRenderedBlockPreviewHeights(ranges, changes ? previous?.map(changes) : previous);
  restrictLiveWidgetPresentation(ranges, state);
  return { ranges, tree };
}

function buildDecorations(state: EditorState, previous?: DecorationSet, changes?: ChangeDesc): DecorationSet {
  const initialTree = resolvedSyntaxTree(state);
  const window = withMarkdownSyntaxSnapshot(state, initialTree, () => livePresentationWindow(state, initialTree));
  const { ranges, tree } = window
    ? withMarkdownSyntaxSnapshot(state, initialTree, () => buildDecorationRanges(state, previous, changes, window.scope))
    : buildDecorationRanges(state, previous, changes);
  const result = Decoration.set(window ? window.project(ranges, changes ? previous?.map(changes) : previous) : ranges, true);
  let filtered = filterDecorationsOutsideMergeConflicts(state, result);
  if (usesLargeDocumentDerivedWorkBudget(state)) {
    // Helpers may finish embedded language parsing. Certify the actual outer
    // Markdown structure against the completed parse, never a lagging snapshot.
    const complete = syntaxTreeAvailable(state, state.doc.length)
      && hasSameLiveMarkdownSyntax(tree, resolvedSyntaxTree(state, 0));
    liveDecorationMetadata.set(state, { ...liveDecorationMetadata.get(state), complete });
    if (complete) filtered = prepareLiveWidgetPositions(filtered, !!getLivePresentationBand(state));
    if (complete && !isEmptyDecorationSet(filtered)) completeLiveDecorationSets.add(filtered);
  }
  return filtered;
}

function hasCodeBlockAncestor(node: SyntaxNodeRef): boolean {
  let parent = node.node.parent;
  while (parent) {
    if (parent.name === 'FencedCode' || parent.name === 'CodeBlock') {
      return true;
    }
    parent = parent.parent;
  }
  return false;
}

function addAlertBlockDecorations(
  builder: DecorationCollector,
  state: EditorState,
  node: SyntaxNodeRef,
  alertBlock: AlertBlock,
  activeLines: Set<number>
): void {
  const startLine = state.doc.lineAt(node.from);
  const endLine = state.doc.lineAt(node.to);
  const lineDeco = alertLineDecos[alertBlock.type];

  for (let lineNo = startLine.number; lineNo <= endLine.number; lineNo += 1) {
    const line = state.doc.line(lineNo);
    builder.push(lineDeco.range(line.from));
  }

  if (!activeLines.has(startLine.number)) {
    builder.push(
      Decoration.widget({
        widget: new AlertIconWidget(alertBlock.type),
        side: -1
      }).range(alertBlock.directiveFrom)
    );
    addRange(builder, alertBlock.directiveFrom, alertBlock.directiveTo, hiddenAlertMarkerDeco);
  } else {
    addRange(builder, alertBlock.directiveFrom, alertBlock.directiveTo, alertMarkerDeco);
    addRange(builder, alertBlock.labelFrom, alertBlock.labelTo, alertLabelActiveDeco);
  }
}

function safeBuildDecorations(
  state: EditorState,
  fallback: DecorationSet,
  context: 'create' | 'update',
  extra: { docChanged?: boolean; selection?: EditorSelection; changes?: ChangeDesc } = {}
): DecorationSet {
  try {
    return buildDecorations(state, fallback, extra.changes);
  } catch (error) {
    liveDecorationMetadata.set(state, { complete: false });
    console.error('[MEO liveMode] decoration build failed', {
      context,
      docLength: state.doc.length,
      ...extra,
      error
    });
    return fallback;
  }
}

const mergeConflictRangeCache = new WeakMap<EditorState['doc'], SourceRange[]>();
function mergeConflictRanges(state: EditorState): SourceRange[] {
  const cached = mergeConflictRangeCache.get(state.doc);
  if (cached) return cached;
  const ranges = parseMergeConflicts(state).map((conflict) => ({
    from: conflict.blockFrom,
    to: conflict.blockTo
  }));
  mergeConflictRangeCache.set(state.doc, ranges);
  return ranges;
}

function pointInsideRanges(pos: number, ranges: ReadonlyArray<SourceRange>): boolean {
  for (const range of ranges) {
    if (pos >= range.from && pos < range.to) {
      return true;
    }
  }
  return false;
}

function rangeOverlapsRanges(from: number, to: number, ranges: ReadonlyArray<SourceRange>): boolean {
  for (const range of ranges) {
    if (rangesOverlap(from, to, range.from, range.to)) {
      return true;
    }
  }
  return false;
}

function filterDecorationsOutsideMergeConflicts(state: EditorState, decorations: DecorationSet): DecorationSet {
  const conflicts = mergeConflictRanges(state);
  if (!conflicts.length || isEmptyDecorationSet(decorations)) {
    return decorations;
  }

  const filtered: DecorationCollector = [];
  decorations.between(0, state.doc.length, (from: number, to: number, value: Decoration) => {
    const overlaps = to > from
      ? rangeOverlapsRanges(from, to, conflicts)
      : pointInsideRanges(from, conflicts);
    if (!overlaps) {
      filtered.push(value.range(from, to));
    }
  });

  return Decoration.set(filtered, true);
}

const codeBlockLineCache = new WeakMap<EditorState['doc'], { tree: Tree; lines: Set<number> }>();
function collectCodeBlockLines(state: EditorState, tree: Tree, scope?: LiveDecorationScope): Set<number> {
  const cached = scope ? undefined : codeBlockLineCache.get(state.doc);
  if (cached?.tree === tree) return cached.lines;
  const lines = new Set<number>();
  tree.iterate({
    ...scope,
    enter(node: SyntaxNodeRef) {
      if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') {
        return;
      }

      const startLineNo = state.doc.lineAt(node.from).number;
      const endLineNo = state.doc.lineAt(Math.max(node.to - 1, node.from)).number;
      for (let lineNo = startLineNo; lineNo <= endLineNo; lineNo += 1) {
        lines.add(lineNo);
      }
      return false;
    }
  });

  if (!scope) codeBlockLineCache.set(state.doc, { tree, lines });
  return lines;
}

class KbdTagWidget extends WidgetType {
  [mapLiveWidgetPositions](): WidgetType { return this; }
  keyText: string;

  constructor(keyText: string) {
    super();
    this.keyText = keyText;
  }

  eq(other: WidgetType): boolean {
    return other instanceof KbdTagWidget && other.keyText === this.keyText;
  }

  toDOM(): HTMLElement {
    const el = document.createElement('kbd');
    el.className = 'meo-md-kbd';
    el.textContent = this.keyText;
    return el;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const kbdWidgetCache = new Map<string, WidgetType>();

function getKbdWidget(keyText: string): WidgetType {
  let widget = kbdWidgetCache.get(keyText);
  if (!widget) {
    widget = new KbdTagWidget(keyText);
    kbdWidgetCache.set(keyText, widget);
  }
  return widget;
}

type LatexMathWidgetElement = HTMLElement & {
  __meoLatexMathViewport?: LatexMathViewportController;
  __meoLatexMathWidget?: LatexMathWidget;
};

class DisplayMathSourceActionsWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc): WidgetType {
    const anchor = changes.mapPos(this.anchor, 1);
    return anchor === this.anchor ? this : new DisplayMathSourceActionsWidget(anchor);
  }
  constructor(readonly anchor: number) { super(); }
  eq(other: WidgetType): boolean { return other instanceof DisplayMathSourceActionsWidget && other.anchor === this.anchor; }
  toDOM(view: EditorView): HTMLElement {
    const actions = createDisplayMathActions(view, () => this.anchor);
    actions.classList.add('meo-math-source-actions');
    return actions;
  }
  ignoreEvent(): boolean { return true; }
}

class LatexMathWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc, state: EditorState): WidgetType {
    if (!this.fencedDisplay) return this;
    const anchor = changes.mapPos(this.anchor, 1), to = changes.mapPos(this.blockTo, -1);
    const startLine = state.doc.lineAt(anchor).number, endLine = state.doc.lineAt(Math.max(anchor, to - 1)).number;
    if (anchor === this.anchor && to === this.blockTo && startLine === this.startLine && endLine === this.endLine) return this;
    const next = new LatexMathWidget(this.html, this.mode, this.fencedDisplay, startLine, endLine,
      this.indentColumns, anchor, this.sourceText, to, this.editing, this.stale);
    next[renderedBlockPreviewHeight].seed(this[renderedBlockPreviewHeight]);
    return next;
  }
  readonly [renderedBlockPreviewHeight]: RenderedBlockPreviewHeight;
  html: string;
  mode: LatexMathMode;
  fencedDisplay: boolean;
  startLine: number;
  endLine: number;
  indentColumns: LiveBlockIndentValue;
  anchor: number;
  sourceText: string;
  blockTo: number;
  editing: boolean;
  stale: boolean;

  constructor(
    html: string,
    mode: LatexMathMode,
    fencedDisplay = false,
    startLine = 0,
    endLine = 0,
    indentColumns: LiveBlockIndentValue = 0,
    anchor = 0,
    sourceText = '',
    blockTo = 0,
    editing = false,
    stale = false
  ) {
    super();
    this[renderedBlockPreviewHeight] = new RenderedBlockPreviewHeight(JSON.stringify([
      // Reading and editing have different padding, so their measured heights cannot be shared.
      // Editing updates the mounted result in place. Preserve its measured height
      // until ResizeObserver reports new geometry, instead of painting an estimate
      // in the gutter for each new rendered formula.
      'math', editing ? null : html, mode, fencedDisplay, liveBlockIndentKey(indentColumns), editing
    ]));
    this.html = html;
    this.mode = mode;
    this.fencedDisplay = fencedDisplay;
    this.startLine = startLine;
    this.endLine = endLine;
    this.indentColumns = indentColumns;
    this.anchor = anchor;
    this.sourceText = sourceText;
    this.blockTo = blockTo;
    this.editing = editing;
    this.stale = stale;
  }

  get estimatedHeight(): number {
    if (!this.fencedDisplay || this.mode !== 'display') return -1;
    const height = this[renderedBlockPreviewHeight].height;
    return height > 0 ? height : estimateBlockWidgetHeight({
      kind: 'latex-display',
      html: this.html
    }) + (this.editing ? 49 : 16);
  }

  eq(other: WidgetType): boolean {
    return (
      other instanceof LatexMathWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.html === this.html &&
      other.mode === this.mode &&
      other.fencedDisplay === this.fencedDisplay &&
      other.startLine === this.startLine &&
      other.endLine === this.endLine &&
      liveBlockIndentKey(other.indentColumns) === liveBlockIndentKey(this.indentColumns) &&
      other.anchor === this.anchor &&
      other.sourceText === this.sourceText &&
      other.blockTo === this.blockTo &&
      other.editing === this.editing &&
      other.stale === this.stale
    );
  }

  get [renderedBlockPreview](): boolean { return this.fencedDisplay && this.mode === 'display' && !this.editing; }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = view.dom.ownerDocument.createElement(this.mode === 'display' ? 'div' : 'span') as LatexMathWidgetElement;
    wrapper.__meoLatexMathWidget = this;
    wrapper.className = `meo-md-math meo-md-math-${this.mode}`;
    if (this.fencedDisplay && this.mode === 'display') {
      wrapper.classList.add('meo-md-math-fenced-display');
      wrapper.classList.toggle('meo-math-live-result', this.editing);
      wrapper.addEventListener('pointerdown', (event: PointerEvent) => {
        if (event.button === 0) {
          event.preventDefault();
        }
      });
    }
    wrapper.innerHTML = this.html;
    if (this.fencedDisplay && this.mode === 'display') {
      applyLiveBlockIndent(wrapper, this.indentColumns);
      wrapper.__meoLatexMathViewport = attachLatexMathViewport(wrapper);
      if (!this.editing) wrapper.append(createDisplayMathActions(view, () => wrapper.__meoLatexMathWidget!.anchor));
      this.updateResultLabel(wrapper, view);
      // Enter before pointerdown bubbles: another embedded editor may release
      // its projected selection and replace this DOM before a click can arrive.
      wrapper.addEventListener('pointerdown', event => {
        if (event.button !== 0) return;
        event.preventDefault();
        const widget = wrapper.__meoLatexMathWidget!;
        if (!widget.editing) {
          const line = view.state.doc.line(Math.min(widget.startLine + 1, view.state.doc.lines));
          const range = collectDocumentMathRanges(view.state).find(range => range.fencedDisplay
            && view.state.doc.lineAt(range.from).from === widget.anchor);
          const source = range && getDisplayMathSource(view.state, range);
          view.dispatch({ selection: { anchor: source?.from ?? line.from }, scrollIntoView: true });
        }
        view.focus();
      });
      this[renderedBlockPreviewHeight].observe(wrapper, view);
      return wrapper;
    }
    applyLiveBlockIndent(wrapper, this.indentColumns);
    return wrapper;
  }

  private updateResultLabel(wrapper: HTMLElement, view: EditorView): void {
    wrapper.querySelector(':scope > .meo-math-result-status')?.remove();
    if (!this.editing) return;
    const label = wrapper.ownerDocument.createElement('span');
    label.className = 'meo-math-result-status';
    const chinese = view.state.facet(uiLanguageFacet) === 'zh-CN';
    label.textContent = this.stale ? (chinese ? '预览 · 上次有效结果' : 'Preview · last valid result') : (chinese ? '预览' : 'Preview');
    if (this.stale) label.setAttribute('role', 'status');
    wrapper.append(label);
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const wrapper = dom as LatexMathWidgetElement;
    const previous = wrapper.__meoLatexMathWidget;
    if (!this.fencedDisplay || !previous?.fencedDisplay || previous.editing !== this.editing) return false;
    // Keep both DOM and its fitted height across caret/input transactions.
    // Mounted callbacks resolve the current widget instead of a stale source range.
    wrapper.__meoLatexMathWidget = this;
    applyLiveBlockIndent(wrapper, this.indentColumns);
    if (previous.html !== this.html) wrapper.__meoLatexMathViewport?.setContent(this.html);
    this.updateResultLabel(wrapper, view);
    this[renderedBlockPreviewHeight].observe(wrapper, view);
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    this[renderedBlockPreviewHeight].destroy(dom);
    const wrapper = (dom.matches('.meo-md-math-fenced-display')
      ? dom
      : dom.querySelector('.meo-md-math-fenced-display')) as LatexMathWidgetElement | null;
    wrapper?.__meoLatexMathViewport?.destroy();
    if (wrapper) delete wrapper.__meoLatexMathViewport;
  }
}

const MATH_WIDGET_CACHE_LIMIT = 300;
const mathWidgetCache = new Map<string, WidgetType>();

function getMathWidget(
  html: string,
  mode: LatexMathMode,
  fencedDisplay = false,
  startLine = 0,
  endLine = 0,
  indentColumns: LiveBlockIndentValue = 0,
  anchor = 0,
  sourceText = '',
  blockTo = 0,
  editing = false,
  stale = false
): WidgetType {
  // Measured block geometry must never be shared by two editor instances.
  if (fencedDisplay) {
    return new LatexMathWidget(html, mode, true, startLine, endLine, indentColumns, anchor, sourceText, blockTo, editing, stale);
  }
  const key = `${getUiLanguageWidgetEpoch()}:${mode}:${fencedDisplay ? 1 : 0}:${startLine}:${endLine}:${liveBlockIndentKey(indentColumns)}:${anchor}:${blockTo}:${sourceText}:${html}`;
  let widget = mathWidgetCache.get(key);
  if (widget) {
    mathWidgetCache.delete(key);
    mathWidgetCache.set(key, widget);
    return widget;
  }

  widget = new LatexMathWidget(
    html,
    mode,
    fencedDisplay,
    startLine,
    endLine,
    indentColumns,
    anchor,
    sourceText,
    blockTo
  );
  mathWidgetCache.set(key, widget);
  if (mathWidgetCache.size > MATH_WIDGET_CACHE_LIMIT) {
    const oldestKey = mathWidgetCache.keys().next().value;
    if (oldestKey !== undefined) {
      mathWidgetCache.delete(oldestKey);
    }
  }

  return widget;
}

function collectRenderedTableRanges(
  state: EditorState,
  blocks: ReadonlyArray<LiveRenderedBlock>
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  for (const block of blocks) {
    if (block.kind !== 'table') {
      continue;
    }
    ranges.push({
      from: state.doc.line(block.startLine).from,
      to: state.doc.line(block.endLine).to
    });
  }
  return ranges;
}

const liveMathRangeCache = new WeakMap<EditorState['doc'], { tree: Tree; tabSize: number; ranges: DocumentMathRange[] }>();
function collectMathRanges(
  state: EditorState,
  tree: Tree,
  renderedTableRanges: ReadonlyArray<SourceRange>,
  frontmatter: FrontmatterInfo | null = null,
  scope?: LiveDecorationScope
): DocumentMathRange[] {
  const cached = scope ? undefined : liveMathRangeCache.get(state.doc);
  if (cached?.tree === tree && cached.tabSize === state.tabSize) return cached.ranges;
  const excludedRanges = [...renderedTableRanges];

  if (frontmatter) {
    excludedRanges.push({ from: frontmatter.openingFrom, to: frontmatter.closingTo });
  }

  const ranges = collectDocumentMathRanges(state, tree, excludedRanges, scope);
  if (!scope) liveMathRangeCache.set(state.doc, { tree, tabSize: state.tabSize, ranges });
  return ranges;
}

function addMathDecorations(
  builder: DecorationCollector,
  state: EditorState,
  mathRanges: ReadonlyArray<DocumentMathRange>,
  activeLines: Set<number>
): void {
  for (const mathRange of mathRanges) {
    if (mathRange.to <= mathRange.from) {
      continue;
    }
    const fencedDisplay = mathRange.mode === 'display' && mathRange.fencedDisplay === true;
    let editingBoundary = !fencedDisplay && (
      rangeTouchesActiveLine(state, mathRange.from, mathRange.to, activeLines) ||
      overlapsSelection(state, mathRange.from, mathRange.to)
    );

    if (fencedDisplay) {
      const openingLine = state.doc.lineAt(mathRange.from);
      const closingLine = state.doc.lineAt(Math.max(mathRange.to - 1, mathRange.from));
      const startLineNo = openingLine.number;
      const endLineNo = closingLine.number;
      const indentColumns = getLiveBlockIndent(state, mathRange.from);
      const source = getDisplayMathSource(state, mathRange);
      const sourceText = source?.text ?? '';
      const anchor = openingLine.from;
      const editing = isDisplayMathEditing(state, startLineNo, endLineNo);
      const currentHtml = renderLatexMathToHtml(mathRange.content, 'display');
      const invalid = !currentHtml || currentHtml.includes('class="katex-error"');
      const previousHtml = invalid && mathRange.content.trim()
        ? getPreviousDisplayMathResult(state, mathRange.from, mathRange.to) : undefined;
      const html = previousHtml ?? currentHtml ?? `<span class="meo-math-empty">${state.facet(uiLanguageFacet) === 'zh-CN'
        ? '输入 LaTeX 公式' : 'Enter a LaTeX formula'}</span>`;
      if (!html) continue;
      const widget = getMathWidget(html, 'display', true, startLineNo, endLineNo,
        indentColumns, anchor, sourceText, mathRange.to, editing, !!previousHtml);
      if (editing) {
        // Leave source, delimiters, selections and history in the main editor.
        for (let lineNo = startLineNo; lineNo <= endLineNo; lineNo++) {
          const line = state.doc.line(lineNo);
          const prefix = lineNo === startLineNo ? state.doc.sliceString(line.from, mathRange.from)
            : lineNo === endLineNo ? parseBlockLinePrefix(line.text, state.tabSize).prefix
            : source?.prefix && line.text.startsWith(source.prefix) ? source.prefix
            : source?.prefix && line.text === source.prefix.trimEnd() ? line.text : '';
          const parsedPrefix = parseBlockLinePrefix(prefix, state.tabSize);
          builder.push(Decoration.line({ attributes: {
            class: 'meo-math-source-line' + (lineNo === startLineNo ? ' meo-math-source-start' : ''),
            style: '--meo-math-source-prefix-width:' + (parsedPrefix.columns + (parsedPrefix.quoteColumns.length ? 1 : 0)) + 'ch;'
          } }).range(line.from));
          // Both halves use the same container boundary; source-font prefix
          // compensation in CSS keeps TeX inside it without changing the text.
          if (liveBlockIndentCssValue(indentColumns) !== null) {
            builder.push(blockIndentLineDeco(indentColumns).range(line.from));
          }
        }
        builder.push(Decoration.widget({ widget: new DisplayMathSourceActionsWidget(anchor), side: 1 }).range(openingLine.to));
        // Keep the result on the following line boundary. Rebuilding a widget
        // inside the closing source line discards that line's measured height,
        // briefly estimating it with the surrounding prose font instead.
        const followingLine = endLineNo < state.doc.lines ? state.doc.line(endLineNo + 1) : null;
        builder.push(Decoration.widget({ widget, block: true, side: followingLine ? -1 : 1 })
          .range(followingLine?.from ?? closingLine.to));
      } else {
        builder.push(lineStyleDecos.renderedBlockPreviewAnchor.range(openingLine.from));
        builder.push(Decoration.replace({ widget, block: true }).range(openingLine.from, closingLine.to));
      }
      continue;
    }

    if (editingBoundary) {
      if (mathRange.mode === 'inline') builder.push(Decoration.mark({ class: 'meo-md-math-inline-source' }).range(mathRange.from, mathRange.to));
      continue;
    }

    const html = renderLatexMathToHtml(mathRange.content, mathRange.mode);
    if (!html) {
      continue;
    }

    builder.push(
      Decoration.replace({
        widget: getMathWidget(html, mathRange.mode, false, 0, 0),
        inclusive: false
      }).range(mathRange.from, mathRange.to)
    );
  }
}

function addKbdTagDecorations(
  builder: DecorationCollector,
  state: EditorState,
  activeLines: Set<number>,
  renderedTableRanges: ReadonlyArray<SourceRange>,
  mathRanges: ReadonlyArray<LatexMathRange> = [],
  frontmatter: FrontmatterInfo | null = null,
  codeBlockLines: Set<number> | null = null,
  scope?: LiveDecorationScope
): void {
  for (const line of scopedDocumentLines(state, scope)) {
    const lineNo = line.number;
    if (activeLines.has(lineNo) || codeBlockLines?.has(lineNo)) {
      continue;
    }

    if (isInsideFrontmatterContent(frontmatter, line.from)) {
      continue;
    }

    const lineText = line.text;
    if (!hasKbdTagMarker(lineText)) {
      continue;
    }
    if (overlapsParsedTableRange(line.from, line.to, renderedTableRanges)) {
      continue;
    }

    const kbdRanges = collectKbdTagRangesFromText(lineText, line.from);
    for (const kbdRange of kbdRanges) {
      if (overlapsSelection(state, kbdRange.from, kbdRange.to)) {
        continue;
      }
      if (overlapsParsedTableRange(kbdRange.from, kbdRange.to, renderedTableRanges)) {
        continue;
      }
      if (overlapsParsedTableRange(kbdRange.from, kbdRange.to, mathRanges)) {
        continue;
      }

      const keyText = kbdRange.content.trim();
      if (!keyText) {
        continue;
      }

      builder.push(
        Decoration.replace({
          widget: getKbdWidget(keyText),
          inclusive: false
        }).range(kbdRange.from, kbdRange.to)
      );
    }
  }
}

const colorExcludedSyntaxNodes = new Set([
  'Link',
  'Image',
  'Autolink',
  'URL',
  'LinkLabel',
  'LinkReference',
  'InlineCode',
  'CodeText',
  'FencedCode',
  'CodeBlock',
  'HTMLTag',
  'InlineHTML',
  'HTMLBlock'
]);

const colorSyntaxCache = new WeakMap<Tree, { scanRanges: SourceRange[]; excludedRanges: SourceRange[] }>();
function collectColorSyntaxRanges(tree: Tree, scope?: SourceRange): {
  scanRanges: SourceRange[];
  excludedRanges: SourceRange[];
} {
  const cached = !scope && colorSyntaxCache.get(tree);
  if (cached) return cached;
  const scanRanges: SourceRange[] = [];
  const excludedRanges: SourceRange[] = [];
  const blockStack: Array<SourceRange & { hasBlockChild: boolean }> = [];
  tree.iterate({
    ...scope,
    enter(node: SyntaxNodeRef) {
      if (node.type.is('Block')) {
        const parentBlock = blockStack[blockStack.length - 1];
        if (parentBlock) parentBlock.hasBlockChild = true;
        blockStack.push({ from: node.from, to: node.to, hasBlockChild: false });
      }
      if (colorExcludedSyntaxNodes.has(node.name)) {
        excludedRanges.push({ from: node.from, to: node.to });
      }
    },
    leave(node: SyntaxNodeRef) {
      if (!node.type.is('Block')) return;
      const block = blockStack.pop();
      if (block && !block.hasBlockChild && block.from < block.to) {
        scanRanges.push({ from: block.from, to: block.to });
      }
    }
  });
  const result = { scanRanges, excludedRanges };
  if (!scope) colorSyntaxCache.set(tree, result);
  return result;
}

/** Merges the fixed set of source-ordered exclusion streams in O(total ranges). */
function mergeOrderedRangeStreams(
  streams: ReadonlyArray<ReadonlyArray<SourceRange>>
): SourceRange[] {
  const streamIndexes = streams.map(() => 0);
  const merged: SourceRange[] = [];

  while (true) {
    let nextStreamIndex = -1;
    let nextRange: SourceRange | undefined;
    for (let streamIndex = 0; streamIndex < streams.length; streamIndex += 1) {
      const candidate = streams[streamIndex][streamIndexes[streamIndex]];
      if (candidate && (!nextRange
        || candidate.from < nextRange.from
        || (candidate.from === nextRange.from && candidate.to < nextRange.to))) {
        nextStreamIndex = streamIndex;
        nextRange = candidate;
      }
    }
    if (!nextRange || nextStreamIndex < 0) break;
    streamIndexes[nextStreamIndex] += 1;
    if (nextRange.to <= nextRange.from) continue;

    const previous = merged[merged.length - 1];
    if (previous && nextRange.from <= previous.to) {
      previous.to = Math.max(previous.to, nextRange.to);
    } else {
      merged.push({ from: nextRange.from, to: nextRange.to });
    }
  }

  return merged;
}

function addColorSwatchDecorations(
  ranges: DecorationCollector,
  state: EditorState,
  tree: Tree,
  activeLines: Set<number>,
  excludedRangeStreams: ReadonlyArray<ReadonlyArray<SourceRange>>,
  scope?: LiveDecorationScope
): void {
  const offset = scope?.from ?? 0;
  const documentText = scope ? state.doc.sliceString(scope.from, scope.to) : state.doc.toString();
  const syntaxRanges = collectColorSyntaxRanges(tree, scope);
  const colorRanges = [];
  for (const scanRange of syntaxRanges.scanRanges) {
    if (scope && (scanRange.to < scope.from || scanRange.from > scope.to)) continue;
    // An empty source band can visit only the Document ancestor. Its bounds
    // cover the file, so clip that fallback instead of discovering distant
    // colors and forcing a complete presentation rebuild.
    const scan = { from: Math.max(0, scanRange.from - offset),
      to: Math.min(documentText.length, scanRange.to - offset) };
    for (const colorRange of collectHexColorRangesFromText(documentText, offset, scan)) {
      colorRanges.push(colorRange);
    }
  }
  const syntaxExcludedRanges = mergeOrderedRangeStreams([
    syntaxRanges.excludedRanges,
    ...excludedRangeStreams
  ]);

  let excludedIndex = 0;
  for (const colorRange of colorRanges) {
    while (syntaxExcludedRanges[excludedIndex]?.to <= colorRange.from) excludedIndex += 1;
    const excludedRange = syntaxExcludedRanges[excludedIndex];
    if (excludedRange
      && rangesOverlap(colorRange.from, colorRange.to, excludedRange.from, excludedRange.to)) {
      continue;
    }
    const line = state.doc.lineAt(colorRange.from);
    if (activeLines.has(line.number) || overlapsSelection(state, colorRange.from, colorRange.to)) {
      continue;
    }
    addColorSwatchDecoration(ranges, colorRange);
  }
}

function retainLargeDocumentInputDecorations(
  decorations: DecorationSet,
  transaction: Transaction
): DecorationSet {
  const document = transaction.startState.doc;
  let from = document.length;
  let to = 0;
  const retainLineRange = (startLine: number, endLine: number) => {
    from = Math.min(from, document.line(Math.max(1, startLine - largeDocumentInputLineRadius)).from);
    to = Math.max(to, document.line(Math.min(document.lines, endLine + largeDocumentInputLineRadius)).to);
  };
  for (const selection of transaction.startState.selection.ranges) {
    const startLine = document.lineAt(Math.min(selection.from, document.length)).number;
    const endLine = document.lineAt(Math.min(selection.to, document.length)).number;
    retainLineRange(startLine, endLine);
  }
  // Embedded Mermaid/math editors can own focus while the outer CodeMirror
  // selection remains elsewhere. Retain presentation around the actual edit as
  // well, otherwise the live widget is discarded before it can project input.
  transaction.changes.iterChangedRanges((fromA, toA) => {
    retainLineRange(
      document.lineAt(Math.min(fromA, document.length)).number,
      document.lineAt(Math.min(toA, document.length)).number
    );
  });
  const retained: DecorationCollector = [];
  decorations.between(from, to, (rangeFrom, rangeTo, value) => {
    retained.push(value.range(rangeFrom, rangeTo));
  });
  return Decoration.set(retained, true);
}

function codeBlockAtInputPosition(tree: Tree, position: number): SyntaxNode | null {
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(position, side);
    while (node) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') return node;
      node = node.parent;
    }
  }
  return null;
}

function blockquoteLineDecorationsAtInputPosition(
  state: EditorState,
  tree: Tree,
  position: number
): Decoration[] {
  const blockquotes = new Map<string, SyntaxNode>();
  for (const side of [-1, 1] as const) {
    let node: SyntaxNode | null = tree.resolveInner(position, side);
    while (node) {
      if (node.name === 'Blockquote') blockquotes.set(`${node.from}:${node.to}`, node);
      node = node.parent;
    }
  }

  const decorations = new Map<string, Decoration>();
  for (const blockquote of blockquotes.values()) {
    const firstLine = state.doc.lineAt(blockquote.from);
    const firstLineText = state.doc.sliceString(firstLine.from, firstLine.to).trimStart();
    if (firstLineText.startsWith('>>>>>>>')) continue;
    const alertBlock = detectAlertInBlockquote(state, blockquote);
    const decoration = alertBlock ? alertLineDecos[alertBlock.type] : lineStyleDecos.quote;
    decorations.set(decoration.spec.class as string, decoration);
  }
  return [...decorations.values()];
}

/**
 * A continued blockquote line is visible before deferred Live decorations are
 * rebuilt. Carry the enclosing line style and refresh the affected quote marks
 * so that the split lines match the authoritative refresh on their first frame.
 */
function projectInputBlockquoteLines(
  decorations: DecorationSet,
  transaction: Transaction
): DecorationSet {
  const startDocument = transaction.startState.doc;
  const nextDocument = transaction.newDoc;
  const tree = currentSyntaxTree(transaction.startState);
  const activeLines = collectActiveLines(transaction.state);
  const lineAdditions = new Map<string, Range<Decoration>>();
  const markerAdditions = new Map<string, Range<Decoration>>();
  const markerRanges = new Set<string>();
  let markerFilterFrom = nextDocument.length;
  let markerFilterTo = 0;

  transaction.changes.iterChangedRanges((fromA, _toA, fromB, toB) => {
    if (nextDocument.sliceString(fromB, toB).search(/[\r\n]/) < 0) return;
    const lineDecorations = blockquoteLineDecorationsAtInputPosition(
      transaction.startState,
      tree,
      Math.min(fromA, startDocument.length)
    );
    if (lineDecorations.length === 0) return;

    const changedLine = nextDocument.lineAt(Math.min(fromB, nextDocument.length));
    const carriedContainerDecorations: Decoration[] = [];
    decorations.between(changedLine.from, changedLine.from, (from, to, decoration) => {
      const className = decoration.spec.attributes?.class ?? decoration.spec.class;
      if (from === to && from === changedLine.from &&
        ['meo-md-quote-source-order', 'meo-md-container-prose', 'meo-md-quote-nested'].includes(className)) {
        carriedContainerDecorations.push(decoration);
      }
    });
    const firstInsertedLine = changedLine.number + 1;
    const lastInsertedLine = nextDocument.lineAt(Math.min(toB, nextDocument.length)).number;
    for (let lineNumber = changedLine.number; lineNumber <= lastInsertedLine; lineNumber += 1) {
      const line = nextDocument.line(lineNumber);
      const prefix = /^[ \t]{0,3}(?:>[ \t]?)+/.exec(line.text)?.[0];
      if (!prefix) continue;
      if (lineNumber >= firstInsertedLine) {
        // Preserve the container geometry while the deferred syntax tree catches up.
        for (const decoration of [...lineDecorations, ...carriedContainerDecorations]) {
          const className = decoration.spec.attributes?.class ?? decoration.spec.class;
          lineAdditions.set(`${line.from}:${className}`, decoration.range(line.from));
        }
        for (const match of prefix.matchAll(/[ \t]+/g)) {
          const startColumns = parseBlockLinePrefix(prefix.slice(0, match.index), transaction.state.tabSize).columns;
          const endColumns = parseBlockLinePrefix(prefix.slice(0, match.index + match[0].length), transaction.state.tabSize).columns;
          const from = line.from + match.index;
          markerAdditions.set(`space:${from}`, Decoration.mark({ attributes: {
            class: 'meo-md-quote-prefix-space',
            style: '--meo-quote-space-width:calc(' + (endColumns - startColumns) + ' * var(--meo-live-container-ch));'
          } }).range(from, from + match[0].length));
        }
      }
      const markerDecoration = activeLines.has(lineNumber) ? activeQuoteMarkerDeco : quoteMarkerDeco;
      for (let offset = 0; offset < prefix.length; offset += 1) {
        if (prefix[offset] !== '>') continue;
        const from = line.from + offset;
        const key = `${from}:${from + 1}`;
        markerRanges.add(key);
        markerAdditions.set(key, markerDecoration.range(from, from + 1));
        markerFilterFrom = Math.min(markerFilterFrom, from);
        markerFilterTo = Math.max(markerFilterTo, from + 1);
      }
    }
  });

  if (lineAdditions.size === 0 && markerAdditions.size === 0) return decorations;
  const markerClasses = new Set([
    markerDeco.spec.class, quoteMarkerDeco.spec.class, activeLineMarkerDeco.spec.class, activeQuoteMarkerDeco.spec.class
  ]);
  return decorations.update({
    filterFrom: markerFilterFrom,
    filterTo: markerFilterTo,
    filter: (from, to, decoration) => (
      !markerRanges.has(`${from}:${to}`) || !markerClasses.has(decoration.spec.class)
    ),
    add: [...lineAdditions.values(), ...markerAdditions.values()],
    sort: true
  });
}

/**
 * Input-derived work intentionally waits for an idle frame, but a newline in a
 * code block creates a visible line immediately. Project just that block's line
 * decorations from the pre-input syntax tree so the first painted frame already
 * has the correct gutter and block boundaries; the normal derived-work refresh remains authoritative.
 */
function projectInputCodeBlockLines(
  decorations: DecorationSet,
  transaction: Transaction
): DecorationSet {
  const startDocument = transaction.startState.doc;
  const nextDocument = transaction.newDoc;
  const tree = currentSyntaxTree(transaction.startState);
  const projectedBlocks = new Set<string>();
  let projected = decorations;

  transaction.changes.iterChangedRanges((fromA, toA, _fromB, toB) => {
    const lookupPosition = Math.min(fromA, startDocument.length);
    let node = codeBlockAtInputPosition(tree, lookupPosition);
    if (!node) {
      // Typing into a trailing indented blank can extend an existing block.
      const nextNode = codeBlockAtInputPosition(currentSyntaxTree(transaction.state), toB);
      if (nextNode?.name !== 'CodeBlock') return;
      node = codeBlockAtInputPosition(tree, transaction.changes.invertedDesc.mapPos(nextNode.from, -1));
    }
    if (!node) return;

    const startLine = startDocument.lineAt(node.from);
    const endLine = startDocument.lineAt(Math.max(node.to - 1, node.from));
    const lastChild = node.lastChild;
    const hasClosingFence = node.name === 'FencedCode'
      && lastChild?.name === 'CodeMark'
      && startDocument.lineAt(lastChild.from).number === endLine.number;
    const info = node.getChild('CodeInfo');
    // Formula source owns its layout. Projecting ordinary code's inner line
    // numbers changes wrap width until the deferred formula refresh removes them.
    if (hasClosingFence && isMathFenceLanguage(info ? startDocument.sliceString(info.from, info.to) : null)) return;
    const firstContentLine = node.name === 'FencedCode' ? startLine.number + 1 : startLine.number;
    const lastContentLine = endLine.number - (hasClosingFence ? 1 : 0);
    if (firstContentLine > lastContentLine) return;

    const contentFrom = startDocument.line(firstContentLine).from;
    const contentTo = startDocument.line(lastContentLine).to;
    if (node.name === 'FencedCode' && (fromA < contentFrom || toA > contentTo)) return;

    const key = `${node.from}:${node.to}`;
    if (projectedBlocks.has(key)) return;
    projectedBlocks.add(key);

    const mappedFrom = transaction.changes.mapPos(node.from, -1);
    const mappedTo = transaction.changes.mapPos(node.to, 1);
    const nextStartLine = nextDocument.lineAt(Math.min(mappedFrom, nextDocument.length));
    const mappedEndLine = nextDocument.lineAt(Math.max(mappedFrom, Math.min(mappedTo - 1, nextDocument.length)));
    // Indented blocks have padding on their boundary rows. Move those rows in
    // the input transaction as well, rather than painting the old footer above
    // the new text until the deferred presentation catches up.
    const nextIndentedBlock = node.name === 'CodeBlock'
      ? codeBlockAtInputPosition(currentSyntaxTree(transaction.state), nextStartLine.to)
      : null;
    const nextEndLine = nextIndentedBlock?.name === 'CodeBlock'
      ? nextDocument.lineAt(Math.max(nextIndentedBlock.from, nextIndentedBlock.to - 1))
      : mappedEndLine;
    const nextFirstContentLine = node.name === 'FencedCode'
      ? nextStartLine.number + 1
      : nextStartLine.number;
    const nextLastContentLine = nextEndLine.number - (hasClosingFence ? 1 : 0);
    const lineCount = Math.max(0, nextLastContentLine - nextFirstContentLine + 1);
    const numberWidth = Math.max(2, String(lineCount).length);
    const additions: Range<Decoration>[] = [];
    for (let lineNumber = nextFirstContentLine; lineNumber <= nextLastContentLine; lineNumber += 1) {
      const line = nextDocument.line(lineNumber);
      additions.push(codeBlockLineNumberDecoration(
        lineNumber - nextFirstContentLine + 1,
        numberWidth
      ).range(line.from));
      if (node.name === 'CodeBlock') additions.push(lineStyleDecos.codeBlock.range(line.from));
    }
    const projectedClasses = new Set(['meo-md-code-line-numbered']);
    if (node.name === 'CodeBlock') {
      for (const decoration of [lineStyleDecos.codeBlock, lineStyleDecos.codeBlockStart,
        lineStyleDecos.codeBlockEnd, lineStyleDecos.indentedCodeBlockStart, lineStyleDecos.indentedCodeBlockEnd]) {
        projectedClasses.add(decoration.spec.class);
      }
      additions.push(lineStyleDecos.codeBlockStart.range(nextStartLine.from),
        lineStyleDecos.indentedCodeBlockStart.range(nextStartLine.from),
        lineStyleDecos.codeBlockEnd.range(nextEndLine.from),
        lineStyleDecos.indentedCodeBlockEnd.range(nextEndLine.from));
      const indent = getLiveBlockIndent(transaction.startState, node.from, node);
      if (nextIndentedBlock?.name === 'CodeBlock') {
        // New source lines must consume their prefix before the deferred refresh.
        projectedClasses.add('meo-md-code-container-line');
        projectedClasses.add('meo-md-code-container-prefix');
        addCodeContainerLines(additions, transaction.state, nextIndentedBlock, indent);
      } else {
        addBlockIndentLines(additions, transaction.state, nextStartLine.from, nextEndLine.to, indent);
      }
    }

    projected = projected.update({
      filterFrom: nextStartLine.from,
      filterTo: Math.max(mappedEndLine.to, nextEndLine.to),
      filter: (_from, _to, value) => !(value.spec.class ?? value.spec.attributes?.class ?? '')
        .split(/\s+/).some((className: string) => projectedClasses.has(className)),
      add: additions,
      sort: true
    });
  });

  return projected;
}

type LiveDecorationCheckpoint = {
  readonly doc: EditorState['doc'];
  readonly selection: EditorSelection;
  readonly decorations: DecorationSet;
};
type LiveDecorationMetadata = {
  readonly complete: boolean;
  readonly checkpoint?: LiveDecorationCheckpoint;
};
// One complete checkpoint per current editor state. Values retain no prior
// EditorState or checkpoint chain, and disappear with their editor's state.
const liveDecorationMetadata = new WeakMap<EditorState, LiveDecorationMetadata>();
// Creation during reconfiguration may use a provisional state identity. The
// value's proof survives that handoff without retaining the provisional state.
const completeLiveDecorationSets = new WeakSet<DecorationSet>();
const localLiveSelectionUpdates = new WeakSet<EditorState>();

function isGitOnlyPresentationUpdate(transaction: Transaction): boolean {
  return transaction.effects.some(isGitDiffPresentationEffect)
    && transaction.effects.every(effect => isGitDiffPresentationEffect(effect) || isTableBaselineRefreshEffect(effect));
}

/** A caret changes presentation in its old/new source blocks, never the rest of
 * an unchanged document. Keep the complete Markdown context (reference labels,
 * numbering and containers) while running the canonical renderer on those blocks. */
function rebuildLiveSelectionBlocks(decorations: DecorationSet, transaction: Transaction): DecorationSet | undefined {
  const before = transaction.startState, state = transaction.state;
  if (!usesLargeDocumentDerivedWorkBudget(state) || transaction.docChanged || transaction.reconfigured
    || !liveDecorationMetadata.get(before)?.complete
    || !transaction.effects.every(effect => effect.is(setLivePointerSelectionActiveEffect) || effect.is(setLiveDocumentIdleEffect)
      || isLiveViewportPresentationEffect(effect) || isLongCodeBlockInteractionEffect(effect) || isEditorScrollEffect(effect)
      || effect.is(setMermaidBlockModeEffect) || effect.is(setMermaidSearchRevealEffect)
      || effect.is(setLatexMathBlockModeEffect) || effect.is(setLatexMathSearchRevealEffect)
      || effect.is(setHtmlEditingRangeEffect))) return;
  for (const selection of [before.selection, state.selection]) for (const range of selection.ranges) {
    if (state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number > 128) return;
  }
  const tree = syntaxTreeAvailable(state, state.doc.length) ? resolvedSyntaxTree(state, 0) : currentSyntaxTree(state);
  if (tree.length !== state.doc.length) return;
  // A caret transaction can publish the already completed parse too. Only
  // accept that publication when both complete outer Markdown trees agree;
  // a genuinely extended/inconclusive syntax result still takes the full path.
  if (syntaxTreeChanged(transaction) && (!syntaxTreeAvailable(before, before.doc.length)
    || !hasSameLiveMarkdownSyntax(resolvedSyntaxTree(before, 0), tree))) return;
  return withMarkdownSyntaxSnapshot(state, tree, () => rebuildLiveSelectionWithSyntax(decorations, transaction, tree));
}

function rebuildLiveSelectionWithSyntax(decorations: DecorationSet, transaction: Transaction, tree: Tree): DecorationSet | undefined {
  const before = transaction.startState, state = transaction.state;
  let changedBlockContext = false;
  const active = new Set([...collectActiveLines(before), ...collectActiveLines(state)]);
  // The pointer's new selection can be masked during pointerdown; include both
  // caret locations so later pointerup reveals exactly the same source block.
  for (const selection of [before.selection, state.selection]) for (const range of selection.ranges) {
    const first = state.doc.lineAt(range.from).number, last = state.doc.lineAt(range.to).number;
    for (let line = first; line <= last; line += 1) active.add(line);
  }
  const includeChangedModes = (previous: ReadonlyMap<number, string> | undefined, next: ReadonlyMap<number, string> | undefined) => {
    if (previous === next) return;
    for (const anchor of new Set([...(previous?.keys() ?? []), ...(next?.keys() ?? [])])) {
      if (previous?.get(anchor) !== next?.get(anchor)) {
        changedBlockContext = true; active.add(state.doc.lineAt(anchor).number);
      }
    }
  };
  const includeChangedRange = (previous: SourceRange | null | undefined, next: SourceRange | null | undefined) => {
    if (previous?.from === next?.from && previous?.to === next?.to) return;
    changedBlockContext = true;
    for (const range of [previous, next]) if (range) {
      active.add(state.doc.lineAt(range.from).number); active.add(state.doc.lineAt(range.to).number);
    }
  };
  for (const [previous, next] of [
    [before.field(mermaidEditingStateField, false), state.field(mermaidEditingStateField, false)],
    [before.field(latexMathEditingStateField, false), state.field(latexMathEditingStateField, false)]
  ] as const) {
    includeChangedModes(previous?.modes, next?.modes);
    includeChangedRange(previous?.searchReveal, next?.searchReveal);
  }
  includeChangedRange(getHtmlEditingRange(before), getHtmlEditingRange(state));
  if (livePresentationBandChanged(transaction)) for (const source of [before, state]) {
    const band = getLivePresentationBand(source);
    if (!band) continue;
    tree.iterate({ from: band.from, to: band.to, enter(node) {
      if (node.name === 'Document') return;
      active.add(state.doc.lineAt(node.from).number);
      active.add(state.doc.lineAt(node.to).number);
      return false;
    } });
  }
  const scopes: SourceRange[] = [];
  const frontmatter = parseFrontmatter(state);
  const details = getDetailsBlocks(state, tree);
  const definitions = parseFootnotes(state).definitions;
  const includeRoot = (range: SourceRange): SourceRange => {
    const expanded = { ...range };
    for (const position of [range.from, range.to]) {
      let node = tree.resolveInner(position, position === range.from ? 1 : -1);
      while (node.parent && node.parent.name !== 'Document') node = node.parent;
      if (node.name !== 'Document' && node.from <= range.to && node.to >= range.from) {
        expanded.from = Math.min(expanded.from, state.doc.lineAt(node.from).from);
        expanded.to = Math.max(expanded.to, state.doc.lineAt(node.to).to);
        if (node.name === 'FencedCode' && isMathFenceLanguage(getFencedCodeInfo(state, node))) {
          const closing = state.doc.lineAt(Math.max(node.from, node.to - 1));
          if (closing.number < state.doc.lines) expanded.to = Math.max(expanded.to, state.doc.line(closing.number + 1).from);
        }
      }
    }
    return expanded;
  };
  for (const lineNumber of active) {
    const line = state.doc.line(lineNumber);
    if (scopes.some(scope => line.from >= scope.from && line.to <= scope.to)) continue;
    let scope = includeRoot({ from: line.from, to: line.to });
    // HTML details and replacement widgets can span several Markdown roots.
    // Never remove one half of a cross-block decoration.
    let settled = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const previous = { ...scope };
      if (frontmatter && scope.from <= frontmatter.closingTo && scope.to >= frontmatter.openingFrom) {
        scope.from = Math.min(scope.from, frontmatter.openingFrom);
        scope.to = Math.max(scope.to, frontmatter.closingTo);
      }
      for (const block of details) if (scope.from < block.sectionTo && scope.to > block.sectionFrom) {
        scope.from = Math.min(scope.from, block.sectionFrom);
        scope.to = Math.max(scope.to, block.sectionTo);
      }
      for (const definition of definitions) if (scope.from <= definition.lineTo && scope.to >= definition.lineFrom) {
        scope.from = Math.min(scope.from, definition.lineFrom);
        scope.to = Math.max(scope.to, definition.lineTo, ...definition.continuationLines.map(line => line.to));
      }
      decorations.between(scope.from, scope.to, (from, to) => {
        scope.from = Math.min(scope.from, from); scope.to = Math.max(scope.to, to);
      });
      scope = includeRoot(scope);
      if (scope.from === previous.from && scope.to === previous.to) { settled = true; break; }
    }
    if (!settled) return;
    scopes.push(scope);
  }
  scopes.sort((left, right) => left.from - right.from);
  const merged: SourceRange[] = [];
  for (const scope of scopes) {
    const last = merged.at(-1);
    if (last && scope.from <= last.to) last.to = Math.max(last.to, scope.to);
    else merged.push({ ...scope });
  }
  let result = decorations;
  for (const range of merged) {
    const scope = { ...range, fromLine: state.doc.lineAt(range.from).number, toLine: state.doc.lineAt(range.to).number };
    const rebuilt = buildDecorationRanges(state, decorations, undefined, scope).ranges;
    const additions: DecorationCollector = [];
    const conflicts = mergeConflictRanges(state);
    for (const range of rebuilt) {
      if (range.from < scope.from || range.to > scope.to) return;
      if (range.to > range.from ? rangeOverlapsRanges(range.from, range.to, conflicts) : pointInsideRanges(range.from, conflicts)) continue;
      additions.push(range);
    }
    result = replaceLivePresentationRanges(result, scope.from, scope.to, additions);
  }
  const band = getLivePresentationBand(state);
  if (band && (livePresentationBandChanged(transaction)
    || merged.some(range => range.from < band.from || range.to > band.to))) {
    const window = livePresentationWindow(state, tree);
    if (window) {
      const ranges: Range<Decoration>[] = [];
      for (const cursor = result.iter(); cursor.value; cursor.next()) ranges.push(cursor.value.range(cursor.from, cursor.to));
      result = prepareLiveWidgetPositions(filterDecorationsOutsideMergeConflicts(state,
        Decoration.set(window.project(ranges, decorations), true)), true);
    }
  }
  if (!changedBlockContext) localLiveSelectionUpdates.add(state);
  liveDecorationMetadata.set(state, { ...liveDecorationMetadata.get(state), complete: true });
  completeLiveDecorationSets.add(result);
  return result;
}

function hasDefaultLiveBlockPresentation(state: EditorState): boolean {
  const mermaid = state.field(mermaidEditingStateField, false);
  const math = state.field(latexMathEditingStateField, false);
  return !mermaid?.modes.size && !mermaid?.searchReveal && !math?.modes.size && !math?.searchReveal
    && !getHtmlEditingRange(state);
}

function hasDefaultLivePresentation(state: EditorState): boolean {
  return hasDefaultLiveBlockPresentation(state) && !state.field(livePointerSelectionActiveField).active
    && !state.field(liveDocumentIdleField);
}

// Ordinary punctuation cannot introduce reference/fence delimiters. The mapped
// path additionally proves both complete paragraph trees and raw helper syntax.
const ordinaryProseInputCharacters = /^[\p{L}\p{N} \t.,!?;'"()，。！？；、：“”‘’（）《》【】…—–-]*$/u;

function isPlainProseInput(transaction: Transaction, nested = false): boolean {
  if (!transaction.isUserEvent('input') || transaction.startState.selection.ranges.length !== 1
    || !transaction.startState.selection.main.empty) return false;
  const document = transaction.startState.doc;
  const tree = currentSyntaxTree(transaction.startState);
  let count = 0;
  let valid = true;
  const characters = nested ? ordinaryProseInputCharacters : /^[\p{L}\p{N} \t]*$/u;
  transaction.changes.iterChangedRanges((from, to, nextFrom, nextTo) => {
    count += 1;
    if (!characters.test(document.sliceString(from, to))
      || !characters.test(transaction.newDoc.sliceString(nextFrom, nextTo))) {
      valid = false;
      return;
    }
    const line = document.lineAt(from);
    if (document.lineAt(to).number !== line.number || from > tree.length) {
      valid = false;
      return;
    }
    const side = from === line.from ? 1 : -1;
    let node = nested ? tree.cursor(IterMode.IgnoreMounts).moveTo(from, side).node : tree.resolveInner(from, side);
    while (node.parent && node.name !== 'Paragraph') node = node.parent;
    valid &&= node.name === 'Paragraph' && !node.firstChild && (nested || node.parent?.name === 'Document')
      || node.name === 'Document' && line.text.length === 0;
  });
  return valid && count === 1;
}

function hasUnchangedLivePresentationContext(transaction: Transaction): boolean {
  return !transaction.reconfigured
    && transaction.effects.every(effect => isLiveInputDerivedWorkBookkeeping(effect)
      || isAutomaticSymbolPairHistoryEffect(effect) || effect.is(shikiRefreshEffect) || isLongCodeBlockInteractionEffect(effect) || isEditorScrollEffect(effect))
    && hasDefaultLivePresentation(transaction.startState) && hasDefaultLivePresentation(transaction.state)
    && (!transaction.selection || transaction.docChanged
      || transaction.startState.selection.eq(transaction.state.selection));
}

function plainPresentationParagraph(state: EditorState, tree: Tree, position: number, nested = false): SyntaxNode | null {
  // Mounted Markdown inside a literal code fence is not editable document prose.
  let node = nested ? tree.cursor(IterMode.IgnoreMounts).moveTo(position, -1).node : tree.resolveInner(position, -1);
  while (node.parent && node.name !== 'Paragraph') node = node.parent;
  // These raw syntaxes have presentation outside the Markdown tree. Bound this
  // proof so a huge paragraph cannot add a full text scan to every interaction.
  if (node.name !== 'Paragraph' || node.firstChild || (!nested && node.parent?.name !== 'Document')
    || node.to - node.from > 4_096
    || /[#$:<>\[\]\\|]/.test(state.doc.sliceString(node.from, node.to))) return null;
  return node;
}

function canMapUnchangedProseDecorations(decorations: DecorationSet, transaction: Transaction): boolean {
  if (!liveDecorationMetadata.get(transaction.startState)?.complete
    || !hasUnchangedLivePresentationContext(transaction) || !isPlainProseInput(transaction, true)
    || transaction.state.selection.ranges.length !== 1 || !transaction.state.selection.main.empty
    || transaction.state.selection.main.head !== transaction.changes.mapPos(transaction.startState.selection.main.head, 1)) return false;
  const before = currentSyntaxTree(transaction.startState);
  const after = currentSyntaxTree(transaction.state);
  // The accepted presentation already covers the whole document. A closed,
  // unchanged plain paragraph below proves this edit without requiring distant
  // embedded languages to finish again. Following proven edits may retain that
  // same complete presentation while their published syntax is still a prefix.
  if (!hasMappedLiveInputPresentation(transaction.startState)
    && (before.length !== transaction.startState.doc.length
      || !syntaxTreeAvailable(transaction.startState, before.length))) return false;
  let valid = true;
  transaction.changes.iterChangedRanges((from, to, nextFrom, nextTo) => {
    const previous = plainPresentationParagraph(transaction.startState, before, to, true);
    const next = plainPresentationParagraph(transaction.state, after, nextTo, true);
    if (!previous || !next || previous.from !== next.from || transaction.changes.mapPos(previous.to, 1) !== next.to) {
      valid = false;
      return;
    }
    // Prefix spacers and container styling elsewhere in a nested paragraph do
    // not depend on the edited word. Touching any presentation, including its
    // boundary, still keeps the authoritative scoped path for that content.
    decorations.between(Math.max(previous.from, from - 1), Math.min(previous.to, to + 1), () => { valid = false; });
    if (!valid) return;
    const oldLine = transaction.startState.doc.lineAt(from);
    const newLine = transaction.newDoc.lineAt(nextFrom);
    valid &&= oldLine.text.match(/^[ \t]*/)![0] === newLine.text.match(/^[ \t]*/)![0];
  });
  // Nested prose can move definition/reference coordinates without changing
  // their syntax. Keep that shared cache current before preserving its widgets.
  if (!valid) return false;
  try { return projectUnchangedFootnotes(transaction.startState, transaction.state, transaction.changes); }
  catch { return false; } // The guarded scoped builder owns unsupported projections.
}

/** Rebuild a closed changed block from the shared renderer and map the rest.
 * Whitespace line changes additionally prove every outer node outside that
 * block unchanged. Definitions and reference labels keep global invalidation. */
function projectLiveLocalInput(decorations: DecorationSet, transaction: Transaction): DecorationSet | undefined {
  const before = transaction.startState, state = transaction.state;
  if (!(transaction.isUserEvent('input') || transaction.isUserEvent('delete') || transaction.isUserEvent('undo') || transaction.isUserEvent('redo'))
    || !liveDecorationMetadata.get(before)?.complete
    || !hasUnchangedLivePresentationContext(transaction) || before.selection.ranges.length !== 1
    || !before.selection.main.empty || state.selection.ranges.length !== 1 || !state.selection.main.empty) return;
  let change: { from: number; to: number; nextFrom: number; nextTo: number } | undefined;
  let supported = true, lineChanged = false;
  transaction.changes.iterChangedRanges((from, to, nextFrom, nextTo) => {
    const removed = before.doc.sliceString(from, to), inserted = state.doc.sliceString(nextFrom, nextTo);
    lineChanged = removed.includes('\n') || inserted.includes('\n');
    if (change || (lineChanged
      ? !/^[ \t\n]*$/.test(removed) || !/^[ \t\n]*$/.test(inserted) || Math.max(removed.length, inserted.length) > 256
      : !ordinaryProseInputCharacters.test(removed) || !ordinaryProseInputCharacters.test(inserted)
        || before.doc.lineAt(from).number !== before.doc.lineAt(to).number)) { supported = false; return; }
    change = { from, to, nextFrom, nextTo };
  });
  if (!supported || !change) return;
  // Foundation readers can finish parsing without publishing a new language
  // state. Use that already completed tree; a lagging published snapshot must
  // not retire the complete presentation and force a later full rebuild.
  const oldTree = syntaxTreeAvailable(before, before.doc.length) ? resolvedSyntaxTree(before, 0) : currentSyntaxTree(before);
  let newTree = syntaxTreeAvailable(state, state.doc.length) ? resolvedSyntaxTree(state, 0) : currentSyntaxTree(state);
  // An accepted inline edit can exhaust CodeMirror's update slice just before
  // EOF. Finish only that small remainder once; nested readers below still use
  // one snapshot. A genuinely incomplete parse retains the full proof checks.
  if (!lineChanged && oldTree.length === before.doc.length && newTree.length >= change.nextTo
    && newTree.length < state.doc.length && state.doc.length - newTree.length <= 1_024) {
    newTree = resolvedSyntaxTree(state, 2);
  }
  if (oldTree.length !== before.doc.length || newTree.length !== state.doc.length) return;
  const notes = parseFootnotes(before);
  if (notes.references.some(reference => change!.from > reference.containerFrom && change!.from < reference.containerTo
    || change!.to > reference.containerFrom && change!.from < reference.containerTo)) return;
  const definition = notes.definitions.find(definition => change!.from >= definition.lineFrom && change!.from <= definition.lineTo);
  if (definition) {
    if (lineChanged && (definition.lineTo - definition.lineFrom > 32_768
      || change.from <= definition.contentTo || change.to > definition.lineTo
      || before.doc.sliceString(definition.contentTo, definition.lineTo).includes('[^'))) return;
    if (change.from < definition.contentFrom || change.to < definition.contentFrom) return;
    const line = before.doc.lineAt(change.from), content = line.from + (line.text.match(/^[ \t]*/)?.[0].length ?? 0);
    if (change.from < content || change.from === content && /^\s*$/.test(state.doc.sliceString(change.nextFrom, change.nextTo))) return;
  }
  const rootAt = (tree: Tree, position: number) => {
    // Embedded Markdown has its own Document root. Presentation is owned by
    // the outer fence, so an inner paragraph is not a closed rebuild scope.
    let node = tree.cursor(IterMode.IgnoreMounts).moveTo(position, -1).node;
    for (let ancestor: SyntaxNode | null = node; ancestor; ancestor = ancestor.parent) {
      if (['LinkReference', 'HTMLBlock', 'HTMLTag'].includes(ancestor.name)) return null;
    }
    while (node.parent && node.parent.name !== 'Document') node = node.parent;
    return node.name === 'Document' ? null : node;
  };
  const previous = rootAt(oldTree, change.from), next = rootAt(newTree, change.nextFrom);
  if (!previous) return;
  let oldScope: SourceRange = previous, nextScope: SourceRange;
  let unchangedParagraphMembership = false;
  if (lineChanged) {
    if (!['Paragraph', 'Blockquote', 'OrderedList', 'BulletList', 'FootnoteDefinition'].includes(previous.name)) return;
    if (previous.name === 'FootnoteDefinition' && (!definition || !next || next.name !== previous.name
      || previous.from !== next.from || transaction.changes.mapPos(previous.to, 1) !== next.to)) return;
    oldScope = { from: before.doc.lineAt(previous.from).from,
      to: before.doc.lineAt(Math.max(previous.to, change.to)).to };
    nextScope = { from: transaction.changes.mapPos(oldScope.from, -1), to: transaction.changes.mapPos(oldScope.to, 1) };
    if (nextScope.to - nextScope.from > 32_768) return;
    // A tighter proof can also preserve the global rich-block index. Requiring
    // every node outside this bare paragraph to match catches list/indentation
    // changes that would absorb or expose an adjacent code, table or HTML block.
    const paragraph = plainPresentationParagraph(before, oldTree, change.from, true);
    unchangedParagraphMembership = !!paragraph && paragraph.from <= change.from && change.to <= paragraph.to
      // A newline can turn literal unmatched backticks/tildes into a new fence
      // wholly inside this scope, where the outside comparison cannot see it.
      && !/[`~]/.test(before.doc.sliceString(paragraph.from, paragraph.to))
      && hasSameLiveMarkdownOutsideBlock(oldTree, newTree, transaction.changes, paragraph,
        { from: transaction.changes.mapPos(paragraph.from, -1), to: transaction.changes.mapPos(paragraph.to, 1) });
    if (!unchangedParagraphMembership
      && !hasSameLiveMarkdownOutsideBlock(oldTree, newTree, transaction.changes, oldScope, nextScope)) return;
    // A line break can create/remove a definition even though every outer node
    // beyond this region is identical. Its references are global consumers.
    const hasDefinition = (tree: Tree, scope: SourceRange) => {
      let found = false;
      tree.iterate({ ...scope, enter(node) {
        if (found) return false;
        if (node.name === 'LinkReference' || node.name === 'FootnoteDefinition'
          && (!definition || node.from !== transaction.changes.mapPos(definition.lineFrom, 1))) { found = true; return false; }
      } });
      return found;
    };
    if (hasDefinition(oldTree, oldScope) || hasDefinition(newTree, nextScope)) return;
  } else {
    if (!next) return;
    nextScope = next;
    const oldLine = before.doc.lineAt(change.from), newLine = state.doc.lineAt(change.nextFrom);
    if (previous.name !== next.name || previous.from !== next.from || transaction.changes.mapPos(previous.to, 1) !== next.to
      || oldLine.text.match(/^[ \t]*/)![0] !== newLine.text.match(/^[ \t]*/)![0]
      || next.to - next.from > 32_768) return;
    if (!syntaxTreeAvailable(state, state.doc.length)
      && !hasSameLiveMarkdownOutsideBlock(oldTree, newTree, transaction.changes, previous, next)) return;
  }
  // A previously empty/invalid marker can gain a label/body without adding any
  // delimiter. Its numbering is global, so it must not inherit the old cache.
  if (previous.to - previous.from > 32_768 + 256) return;
  for (const marker of before.doc.sliceString(previous.from, previous.to).matchAll(/\[\^[^\]]*\]|\^\[[^\]]*\]/g)) {
    const start = previous.from + marker.index!, end = start + marker[0].length;
    const isProtected = (tree: Tree, position: number) => {
      for (let node: SyntaxNode | null = tree.cursor(IterMode.IgnoreMounts).moveTo(position, 1).node; node; node = node.parent) {
        if (node.name === 'InlineCode' || node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
      }
      return false;
    };
    const protectedBefore = isProtected(oldTree, start), protectedAfter = isProtected(newTree, transaction.changes.mapPos(start, 1));
    if (protectedBefore !== protectedAfter || !protectedBefore
      && (change.from > start && change.from < end || change.to > start && change.from < end)) return;
  }
  const frontmatter = parseFrontmatter(state);
  let from = state.doc.lineAt(nextScope.from).from, to = state.doc.lineAt(nextScope.to).to;
  if (frontmatter && change.nextFrom <= frontmatter.closingTo) {
    from = frontmatter.openingFrom; to = frontmatter.closingTo;
  }
  if (definition) {
    from = Math.min(from, transaction.changes.mapPos(definition.lineFrom, 1));
    to = Math.max(to, transaction.changes.mapPos(definition.lineTo, 1),
      ...definition.continuationLines.map(line => transaction.changes.mapPos(line.to, 1)));
  }
  if (next?.name === 'FencedCode') {
    const closing = state.doc.lineAt(next.to);
    if (closing.number < state.doc.lines) to = state.doc.line(closing.number + 1).from;
  }
  const mapped = mapStableLiveDecorations(decorations, transaction.changes, state);
  if (!mapped) return;
  // The original block must remain closed over its replacement widgets too.
  let crossesScope = false;
  mapped.decorations.between(from, to, (start, end) => { if (start < from || end > to) crossesScope = true; });
  if (crossesScope) return;
  if (!projectUnchangedFootnotes(before, state, transaction.changes, lineChanged ? definition : undefined)) return;
  const previousConflicts = mergeConflictRangeCache.get(before.doc);
  if (previousConflicts) mergeConflictRangeCache.set(state.doc, previousConflicts.map(range => ({
    from: transaction.changes.mapPos(range.from, 1), to: transaction.changes.mapPos(range.to, -1)
  })));
  const scope = { from, to, fromLine: state.doc.lineAt(from).number, toLine: state.doc.lineAt(to).number };
  const ranges = withMarkdownSyntaxSnapshot(state, newTree,
    () => buildDecorationRanges(state, mapped.decorations, undefined, scope).ranges);
  const conflicts = mergeConflictRanges(state);
  if (ranges.some(range => range.from < from || range.to > to)) return;
  const result = replaceLivePresentationRanges(mapped.decorations, from, to, ranges.filter(range => !(
    range.to > range.from ? rangeOverlapsRanges(range.from, range.to, conflicts) : pointInsideRanges(range.from, conflicts)
  )));
  liveDecorationMetadata.set(state, { complete: true,
    checkpoint: mapped.rebasedWidgets ? undefined : liveDecorationMetadata.get(state)?.checkpoint });
  // Rebuilding a closed code/image/formula block proves canonical correctness,
  // not that every other structure consumer has already accepted its contents.
  // A later plain key must also retain any earlier unrefreshed structural edit.
  const oldParagraph = !lineChanged && plainPresentationParagraph(before, oldTree, change.to, true);
  const newParagraph = !lineChanged && plainPresentationParagraph(state, newTree, change.nextTo, true);
  if ((!isLiveInputDerivedWorkPending(before) || hasMappedLiveInputPresentation(before))
    && oldParagraph && newParagraph && oldParagraph.from === newParagraph.from
    && transaction.changes.mapPos(oldParagraph.to, 1) === newParagraph.to) {
    markLiveInputPresentationMapped(state);
    projectUnchangedLiveRenderedBlocks(before, state, transaction.changes, oldTree, newTree);
  }
  if (unchangedParagraphMembership) projectUnchangedLiveRenderedBlocks(before, state, transaction.changes, oldTree, newTree);
  completeLiveDecorationSets.add(result);
  return result;
}

function canKeepPlainProseCaret(decorations: DecorationSet, transaction: Transaction): boolean {
  if (transaction.docChanged || transaction.reconfigured || transaction.effects.length
    || !transaction.selection || transaction.startState.selection.eq(transaction.state.selection)
    || !liveDecorationMetadata.get(transaction.startState)?.complete
    || !hasDefaultLivePresentation(transaction.startState) || !hasDefaultLivePresentation(transaction.state)
    || transaction.startState.selection.ranges.length !== 1 || transaction.state.selection.ranges.length !== 1
    || !transaction.startState.selection.main.empty || !transaction.state.selection.main.empty
    || syntaxTreeChanged(transaction)) return false;
  const doc = transaction.startState.doc;
  const line = doc.lineAt(transaction.startState.selection.main.head);
  const cursor = decorations.iter(line.from);
  // Caret-only moves leave later widget offsets intact. Only decorations on
  // this line can change their presentation when the caret moves within it.
  if (doc.lineAt(transaction.state.selection.main.head).number !== line.number
    || (cursor.value && cursor.from <= line.to)) return false;
  const tree = currentSyntaxTree(transaction.startState);
  return tree.length === doc.length && !!plainPresentationParagraph(transaction.startState, tree, line.to);
}

/** Exact history restoration can reuse a full presentation without remapping widgets. */
function restoreLiveDecorationCheckpoint(
  decorations: DecorationSet,
  transaction: Transaction
): DecorationSet | undefined {
  if (!usesLargeDocumentDerivedWorkBudget(transaction.state)) return;
  const previous = liveDecorationMetadata.get(transaction.startState);
  const contextUnchanged = hasUnchangedLivePresentationContext(transaction);
  let checkpoint = contextUnchanged ? previous?.checkpoint : undefined;
  if (transaction.docChanged) {
    const isHistory = transaction.isUserEvent('undo') || transaction.isUserEvent('redo');
    const current = contextUnchanged && previous?.complete ? {
      doc: transaction.startState.doc, selection: transaction.startState.selection, decorations
    } : undefined;
    if (isHistory) {
      const restored = checkpoint?.selection.eq(transaction.state.selection)
        && checkpoint.doc.eq(transaction.newDoc) ? checkpoint.decorations : undefined;
      liveDecorationMetadata.set(transaction.state, { checkpoint: current, complete: restored !== undefined });
      return restored;
    }
    const startsHistoryGroup = undoDepth(transaction.state) > undoDepth(transaction.startState);
    checkpoint = contextUnchanged && isPlainProseInput(transaction)
      ? startsHistoryGroup ? current : checkpoint ?? current
      : undefined;
  }
  liveDecorationMetadata.set(transaction.state, { checkpoint, complete: contextUnchanged && previous?.complete === true });
}

const liveDecorationField = StateField.define<DecorationSet>({
  create(state: EditorState): DecorationSet {
    return safeBuildDecorations(state, Decoration.none, 'create');
  },
  update(decorations: DecorationSet, transaction: Transaction): DecorationSet {
    // A newly added field was created from the final transaction state. The
    // reconfiguration then calls update for that same state; rebuilding here
    // doubles the full-document work on every Source-to-Live switch.
    if (transaction.reconfigured && !transaction.startState.field(liveDecorationField, false)) {
      // Creation can use a provisional reconfiguration state. Associate the
      // completed value with the final state too; failed creation returns none.
      if (usesLargeDocumentDerivedWorkBudget(transaction.state)) {
        liveDecorationMetadata.set(transaction.state, {
          complete: completeLiveDecorationSets.has(decorations)
        });
      }
      return decorations;
    }
    // Publishing completed syntax changes neither the source nor its selection.
    // Preserve the full presentation, including an active search range and its
    // focused widgets, when the complete outer Markdown is identical.
    if (!transaction.docChanged && !transaction.selection && !transaction.reconfigured
      && (transaction.effects.every(effect => isLiveInputDerivedWorkBookkeeping(effect) || isEditorScrollEffect(effect))
        || isGitOnlyPresentationUpdate(transaction))
      && liveDecorationMetadata.get(transaction.startState)?.complete
      && (!syntaxTreeChanged(transaction) || syntaxTreeAvailable(transaction.startState, transaction.startState.doc.length)
        && syntaxTreeAvailable(transaction.state, transaction.state.doc.length)
        && hasSameLiveMarkdownSyntax(resolvedSyntaxTree(transaction.startState, 0), resolvedSyntaxTree(transaction.state, 0)))) {
      liveDecorationMetadata.set(transaction.state, liveDecorationMetadata.get(transaction.startState)!);
      if (hasMappedLiveInputPresentation(transaction.startState)) markLiveInputPresentationMapped(transaction.state);
      return decorations;
    }
    if (!transaction.docChanged && !transaction.selection && !transaction.reconfigured
      && transaction.effects.length > 0 && transaction.effects.every(isEditorScrollEffect)) {
      const previous = liveDecorationMetadata.get(transaction.startState);
      if (previous?.complete) {
        liveDecorationMetadata.set(transaction.state, previous);
        return decorations;
      }
    }
    if (!transaction.docChanged && !transaction.selection && !transaction.reconfigured
      && transaction.effects.length > 0 && transaction.effects.every(isLongCodeBlockInteractionEffect)
      && !syntaxTreeChanged(transaction)) {
      const previous = liveDecorationMetadata.get(transaction.startState);
      if (previous) liveDecorationMetadata.set(transaction.state, previous);
      return decorations;
    }
    const restored = restoreLiveDecorationCheckpoint(decorations, transaction);
    if (restored !== undefined) return restored;
    if (usesLargeDocumentDerivedWorkBudget(transaction.state) && canKeepPlainProseCaret(decorations, transaction)) {
      liveDecorationMetadata.set(transaction.state, { ...liveDecorationMetadata.get(transaction.state), complete: true });
      return decorations;
    }
    let rebuiltSelection: DecorationSet | undefined;
    try { rebuiltSelection = rebuildLiveSelectionBlocks(decorations, transaction); }
    catch { /* The guarded authoritative builder below owns failures. */ }
    if (rebuiltSelection !== undefined) return rebuiltSelection;
    // Search highlights are maintained independently. Preserving the existing
    // live decorations prevents a transient parse result from exposing source.
    if (
      transaction.effects.some((effect) => effect.is(preserveLiveDecorationsForSearchEffect)) &&
      !transaction.effects.some((effect) => effect.is(refreshLiveDecorationsAfterSearchEffect))
    ) {
      return decorations;
    }
    if (transaction.docChanged && usesLargeDocumentDerivedWorkBudget(transaction.state)
      && (transaction.isUserEvent('delete') || transaction.isUserEvent('undo') || transaction.isUserEvent('redo'))) {
      let inline: DecorationSet | undefined;
      try { inline = projectLiveLocalInput(decorations, transaction); }
      catch { /* The authoritative builder handles unsupported history edits. */ }
      if (inline !== undefined) return inline;
    }
    if (shouldDeferLiveInputDerivedWork(transaction)) {
      // Phase bookkeeping, especially settlement after an authoritative refresh,
      // must not discard distant block heights a second time.
      if (!transaction.docChanged) return decorations;
      if (usesLargeDocumentDerivedWorkBudget(transaction.state)
        && canMapUnchangedProseDecorations(decorations, transaction)) {
        const mapped = mapStableLiveDecorations(decorations, transaction.changes, transaction.state);
        if (mapped) {
          // Mounted tables can adopt the replacement's coordinates when their
          // DOM is retained. A prior checkpoint must not reuse that old widget.
          const previous = liveDecorationMetadata.get(transaction.state);
          liveDecorationMetadata.set(transaction.state, { checkpoint: mapped.rebasedWidgets ? undefined : previous?.checkpoint, complete: true });
          if (!isLiveInputDerivedWorkPending(transaction.startState) || hasMappedLiveInputPresentation(transaction.startState)) {
            markLiveInputPresentationMapped(transaction.state);
            projectUnchangedLiveRenderedBlocks(transaction.startState, transaction.state, transaction.changes,
              resolvedSyntaxTree(transaction.startState, 0), resolvedSyntaxTree(transaction.state, 0));
          }
          if (!isEmptyDecorationSet(mapped.decorations)) completeLiveDecorationSets.add(mapped.decorations);
          return mapped.decorations;
        }
      }
      if (usesLargeDocumentDerivedWorkBudget(transaction.state)) {
        let inline: DecorationSet | undefined;
        try { inline = projectLiveLocalInput(decorations, transaction); }
        catch { /* Keep the guarded deferred builder for unsupported input. */ }
        if (inline !== undefined) return inline;
      }
      if (usesLargeDocumentDerivedWorkBudget(transaction.state)) {
        liveDecorationMetadata.set(transaction.state, { ...liveDecorationMetadata.get(transaction.state), complete: false });
      }
      const inputDecorations = usesLargeDocumentDerivedWorkBudget(transaction.state)
        ? retainLargeDocumentInputDecorations(decorations, transaction)
        : decorations;
      return transaction.docChanged
        ? isLiveInputNestedProjection(transaction)
          ? transaction.effects
            .filter((effect) => effect.is(replaceLiveInputNestedDecorationEffect))
            .reduce((mapped, effect) => {
              const { from, to, decoration } = effect.value;
              return mapped.update({
                filterFrom: from,
                filterTo: to,
                filter: (_rangeFrom, _rangeTo, value) => !value.spec.widget,
                add: [decoration.range(from, to)]
              });
            }, inputDecorations.map(transaction.changes))
          : projectInputCodeBlockLines(
            projectInputBlockquoteLines(
              mapLiveInputDerivedDecorations(inputDecorations, transaction),
              transaction
            ),
            transaction
          )
        : inputDecorations;
    }
    if (!transaction.docChanged && isLiveInputDerivedWorkRefresh(transaction)
      && liveDecorationMetadata.get(transaction.startState)?.complete
      && hasUnchangedLivePresentationContext(transaction) && !syntaxTreeChanged(transaction)) {
      return decorations;
    }
    // Shiki owns its own decorations. Its token refresh does not change Live
    // structure, while other effects may refresh resources or presentation.
    // An explicit selection can end an editing/search reveal even at the same position.
    const identicalPlainSelection = usesLargeDocumentDerivedWorkBudget(transaction.state)
      && transaction.startState.selection.eq(transaction.state.selection)
      && hasDefaultLivePresentation(transaction.startState) && hasDefaultLivePresentation(transaction.state);
    if (!transaction.docChanged && (!transaction.selection || identicalPlainSelection) && !transaction.reconfigured
      && (transaction.effects.every((effect) => effect.is(shikiRefreshEffect))
        || isGitOnlyPresentationUpdate(transaction))
      && !syntaxTreeChanged(transaction)) {
      const previous = liveDecorationMetadata.get(transaction.startState);
      if (previous) liveDecorationMetadata.set(transaction.state, previous);
      return decorations;
    }
    const next = safeBuildDecorations(transaction.state, decorations, 'update', {
      docChanged: transaction.docChanged,
      selection: transaction.selection,
      changes: transaction.docChanged ? transaction.changes : undefined
    });

    // Guard against transient empty parse results on selection-only transactions.
    if (!transaction.docChanged && !isLiveInputDerivedWorkRefresh(transaction)
      && isEmptyDecorationSet(next) && !isEmptyDecorationSet(decorations)
      && !liveDecorationMetadata.get(transaction.state)?.complete) {
      liveDecorationMetadata.set(transaction.state, { complete: false });
      return decorations;
    }

    return next;
  },
  provide: (field) => EditorView.decorations.computeN([field], state => liveWidgetPresentationLayers(state.field(field)))
});

/** Canonical presentation remains one value even when the View consumes its
 * point and mark layers separately. */
export function getLivePresentationDecorations(state: EditorState): DecorationSet {
  return state.field(liveDecorationField);
}

function isRenderedBlockPreview(state: EditorState, block: LiveRenderedBlock): boolean {
  if (block.kind === 'mermaid' && block.endLine > block.startLine + 1) {
    const anchor = state.doc.line(block.startLine).from;
    const contentFrom = state.doc.line(block.startLine + 1).from;
    const contentTo = state.doc.line(block.endLine - 1).to;
    if (contentFrom >= contentTo || !state.doc.sliceString(contentFrom, contentTo).trim()) {
      return false;
    }
    return getMermaidBlockMode(state, anchor, contentFrom, contentTo).decision.effectiveMode === 'preview';
  }
  if (block.kind === 'math') {
    return !isDisplayMathEditing(state, block.startLine, block.endLine);
  }
  return false;
}

function buildLiveLineNumberMarkers(state: EditorState): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const band = getLivePresentationBand(state);
  const firstLine = band ? state.doc.lineAt(band.from).number : 1;
  const lastLine = band ? state.doc.lineAt(band.to).number : state.doc.lines;
  const conflictLineNumbers = new Set<number>();
  for (const conflict of parseMergeConflicts(state)) {
    for (let lineNo = conflict.startLineNo; lineNo <= conflict.endLineNo; lineNo += 1) {
      conflictLineNumbers.add(lineNo);
    }
  }
  for (const block of getLiveRenderedBlocks(state, { includeSelectedMath: true })) {
    if (block.endLine < firstLine || block.startLine > lastLine) continue;
    if (block.kind === 'math' && isDisplayMathEditing(state, block.startLine, block.endLine)) continue;
    if (isRenderedBlockPreview(state, block)) {
      const anchorLine = state.doc.line(block.startLine);
      builder.add(anchorLine.from, anchorLine.from, renderedBlockPreviewAnchorGutterMarker);
    }
    if (block.lineNumberHiddenFrom < 1 || block.lineNumberHiddenTo < block.lineNumberHiddenFrom) {
      continue;
    }
    for (let lineNo = Math.max(firstLine, block.lineNumberHiddenFrom); lineNo <= Math.min(lastLine, block.lineNumberHiddenTo); lineNo += 1) {
      if (conflictLineNumbers.has(lineNo)) {
        continue;
      }
      const line = state.doc.line(lineNo);
      builder.add(line.from, line.from, tableDelimiterGutterLineClassMarker);
    }
  }
  return builder.finish();
}

const fallbackTableCache = new WeakMap<EditorState['doc'], Array<{ startLineNo: number; endLineNo: number }>>();
function detectTableBlocks(state: EditorState, scope?: LiveDecorationScope): Array<{ startLineNo: number; endLineNo: number }> {
  const cached = !scope && fallbackTableCache.get(state.doc);
  if (cached) return cached;
  const blocks: Array<{ startLineNo: number; endLineNo: number }> = [];
  let scannedThrough = 1;
  for (const delimiterLine of scopedDocumentLines(state, scope)) {
    const lineNo = delimiterLine.number;
    if (lineNo <= scannedThrough) continue;
    const delimiterText = delimiterLine.text;
    if (isThematicBreakLine(delimiterText)) continue;
    if (!isTableDelimiterLine(delimiterText)) continue;
    const commonIndent = parseBlockLinePrefix(delimiterText, state.tabSize).prefix;

    const headerLineNo = lineNo - 1;
    const headerLine = state.doc.line(headerLineNo);
    const headerText = headerLine.text;
    if (parseBlockLinePrefix(headerText, state.tabSize).prefix !== commonIndent) continue;
    if (!isTableContentLine(headerText)) continue;

    let endLineNo = lineNo;
    for (let rowLineNo = lineNo + 1; rowLineNo <= state.doc.lines; rowLineNo += 1) {
      const rowLine = state.doc.line(rowLineNo);
      const rowText = rowLine.text;
      if (!isTableContentLine(rowText)) break;
      if (parseBlockLinePrefix(rowText, state.tabSize).prefix !== commonIndent) break;
      endLineNo = rowLineNo;
    }

    blocks.push({ startLineNo: headerLineNo, endLineNo });
    scannedThrough = endLineNo;
  }
  if (!scope) fallbackTableCache.set(state.doc, blocks);
  return blocks;
}

function addFallbackTableDecorations(
  builder: DecorationCollector,
  state: EditorState,
  tree: Tree,
  parsedTableRanges: ReadonlyArray<SourceRange>,
  diagnostics: EditorDiagnostic[] = [],
  scope?: LiveDecorationScope
): void {
  const tableBlocks = detectTableBlocks(state, scope);
  for (const block of tableBlocks) {
    if (scope && (block.endLineNo < scope.fromLine || block.startLineNo > scope.toLine)) continue;
    const from = state.doc.line(block.startLineNo).from;
    const to = state.doc.line(block.endLineNo).to;
    if (overlapsParsedTableRange(from, to, parsedTableRanges)) continue;
    const headerText = state.doc.line(block.startLineNo).text;
    const syntaxProbe = from + parseBlockLinePrefix(headerText, state.tabSize).prefix.length;
    if (isInsideCodeBlock(tree, syntaxProbe)) continue;
    addTableDecorationsForLineRange(
      builder,
      state,
      block.startLineNo,
      block.endLineNo,
      diagnostics,
      state.field(gitDiffLineFlagsField, false)
    );
  }
}

function hasBlockedRawFileUrlAncestor(tree: Tree, from: number, to: number): boolean {
  const positions = [from, Math.max(from, to - 1)];
  for (const position of positions) {
    let node: SyntaxNode | null = tree.resolveInner(position, 1);
    while (node) {
      if (rawFileUrlBlockedAncestorNames.has(node.name)) {
        return true;
      }
      node = node.parent;
    }
  }
  return false;
}

function addRawFileUrlDecorations(
  builder: DecorationCollector,
  state: EditorState,
  tree: Tree,
  activeLines: Set<number>,
  frontmatter: FrontmatterInfo | null = null,
  scope?: LiveDecorationScope
): void {
  for (const line of scopedDocumentLines(state, scope)) {
    const lineNo = line.number;
    if (line.text.indexOf(fileSchemePrefix) === -1) {
      continue;
    }

    const matches = findRawSourceUrlMatches(line.text);
    for (const match of matches) {
      if (!match.href.toLowerCase().startsWith(fileSchemePrefix)) {
        continue;
      }
      const from = line.from + match.index;
      const to = from + match.length;
      if (to <= from) {
        continue;
      }
      if (isInsideFrontmatterContent(frontmatter, from)) {
        continue;
      }
      if (hasBlockedRawFileUrlAncestor(tree, from, to)) {
        continue;
      }
      addLinkMark(builder, from, to, match.href, activeLines.has(lineNo) ? null : to);
    }
  }
}

function rangesOverlap(fromA: number, toA: number, fromB: number, toB: number): boolean {
  return fromA < toB && toA > fromB;
}

function overlapsSelection(state: EditorState, from: number, to: number): boolean {
  if (state.field(livePointerSelectionActiveField).active || state.field(liveDocumentIdleField)) {
    return false;
  }

  return state.selection.ranges.some((range) => rangesOverlap(from, to, range.from, range.to));
}

function overlapsParsedTableRange(from: number, to: number, ranges: ReadonlyArray<SourceRange>): boolean {
  return ranges.some((range) => rangesOverlap(from, to, range.from, range.to));
}

function isInsideCodeBlock(tree: Tree, pos: number): boolean {
  let node: SyntaxNode | null = tree.resolveInner(pos, 1);
  while (node) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') return true;
    node = node.parent;
  }
  return false;
}

const liveLineNumberMarkerField = StateField.define<RangeSet<GutterMarker>>({
  create(state: EditorState): RangeSet<GutterMarker> {
    return buildLiveLineNumberMarkers(state);
  },
  update(markers: RangeSet<GutterMarker>, transaction: Transaction): RangeSet<GutterMarker> {
    if (localLiveSelectionUpdates.has(transaction.state) && !livePresentationBandChanged(transaction)) return markers;
    if (isMappedLiveInputRefresh(transaction) || shouldDeferLiveInputDerivedWork(transaction)) {
      return transaction.docChanged ? markers.map(transaction.changes) : markers;
    }
    const renderedBlockPresentationChanged = transaction.effects.some((effect) => (
      effect.is(setMermaidBlockModeEffect)
      || effect.is(setMermaidSearchRevealEffect)
      || effect.is(setLatexMathBlockModeEffect)
      || effect.is(setLatexMathSearchRevealEffect)
    ));
    if (!transaction.docChanged
      && !isLiveInputDerivedWorkRefresh(transaction)
      && !livePresentationBandChanged(transaction)
      && !renderedBlockPresentationChanged
      && transaction.startState.selection.eq(transaction.state.selection)) {
      return markers;
    }
    return buildLiveLineNumberMarkers(transaction.state);
  },
  provide: (field) => gutterLineClass.from(field)
});

function buildStyledLineNumberMarkers(state: EditorState): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const frontmatter = parseFrontmatter(state);
  resolvedSyntaxTree(state).iterate({
    ...getLivePresentationBand(state),
    enter(node) {
      if (node.name === 'CodeBlock' && !hasCodeBlockAncestor(node)) {
        const line = state.doc.lineAt(node.from);
        builder.add(line.from, line.from, indentedCodeGutterLineClassMarker);
        return false;
      }
      const level = headingLevelFromName(node.name);
      if (level === null || isInsideFrontmatter(frontmatter, node.from)) return;
      const line = state.doc.lineAt(node.from);
      builder.add(line.from, line.from, headingGutterLineClassMarkers[level - 1]);
    }
  });
  return builder.finish();
}

const styledLineNumberMarkerField = StateField.define<RangeSet<GutterMarker>>({
  create: buildStyledLineNumberMarkers,
  update(markers, transaction) {
    if (isMappedLiveInputRefresh(transaction) || shouldDeferLiveInputDerivedWork(transaction)) return transaction.docChanged ? markers.map(transaction.changes) : markers;
    if (!transaction.docChanged && !isLiveInputDerivedWorkRefresh(transaction) && !livePresentationBandChanged(transaction)) return markers;
    return buildStyledLineNumberMarkers(transaction.state);
  },
  provide: (field) => gutterLineClass.from(field)
});

// Both modes edit the same grammar. Stable language identity lets CodeMirror
// retain its incremental parse when only presentation extensions change.
export const editorMarkdownLanguage = markdown({
  base: markdownLanguage,
  addKeymap: false,
  codeLanguages: resolveCodeLanguage,
  extensions: [...inlineMarkdownExtensions,
    { props: [sourceMarkdownHighlightProps] }, { remove: ['Emoji'] }]
});

export function liveModeExtensions(options: { readonly largeDocument?: boolean } = {}): Extension[] {
  return [
    ...liveInputDerivedWorkExtensions(options),
    ...(options.largeDocument ? liveViewportPresentationExtensions() : []),
    editorMarkdownLanguage,
    syntaxHighlighting(liveHighlightStyle),
    markdownTagField,
    livePointerSelectionActiveField,
    liveDocumentIdleField,
    mermaidEditingStateField,
    latexMathEditingStateField,
    displayMathResultField,
    hexColorAdjustmentExtension(),
    ...htmlContentExtensions(),
    liveDecorationField,
    renderedBlockLineNumberMarker,
    ...longCodeBlockSessionUiExtension(),
    ...blockStickyHeaderExtension(),
    liveLineNumberMarkerField,
    styledLineNumberMarkerField,
    ...mergeConflictSourceExtensions(),
    ...detailsBlockLiveExtensions()
  ];
}

function isEmptyDecorationSet(set: DecorationSet): boolean {
  const cursor = set.iter();
  return cursor.value === null;
}
