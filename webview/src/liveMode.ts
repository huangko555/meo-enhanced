import { RangeSetBuilder, StateEffect, StateField, EditorState, type Range, type RangeSet, type Extension, type EditorSelection, type Transaction } from '@codemirror/state';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutterLineClass,
  lineNumberWidgetMarker,
  type DecorationSet
} from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef, Tree } from '@lezer/common';
import { createElement, AlertCircle, Code2, Delete } from 'lucide';
import {
  resolveCodeLanguage,
  isFenceMarker,
  addFenceOpeningLineMarker,
  addCodeLanguageLabel,
  addCodeBlockLineNumbers,
  addTopLineCopyButton,
  addTopLinePillLabel,
  addMermaidDiagram,
  addCopyCodeButton
} from './helpers/codeBlocks';
import { ImageGroupWidget, ImageWidget, getImageData, isImageUrl, type ImageGroupItem } from './helpers/images';
import { getImagePresentationFactory } from './editor/imagePresentation';
import { liveHighlightStyle, sourceMarkdownHighlightProps } from './theme';
import { highlightMarkdownExtension } from './helpers/highlightSyntax';
import { collectSingleTildeStrikePairs, collectStrikethroughRanges } from './helpers/strikeMarkers';
import { collectKbdTagRangesFromText, hasKbdTagMarker } from './helpers/kbd';
import { getFencedCodeInfo, headingLevelFromName, resolvedSyntaxTree } from './helpers/markdownSyntax';
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
import { isWikiLinkNode, parseWikiLinkData, getWikiLinkStatus } from './helpers/wikiLinks';
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
  footnoteMarkdownExtension,
  parseFootnotes,
  footnoteReferenceKey,
  type FootnoteReference,
  type ParsedFootnotes
} from './helpers/footnotes';
import { getLiveRenderedBlocks, type LiveRenderedBlock } from './helpers/liveRenderedBlocks';
import { findRawSourceUrlMatches, normalizeSourceHref } from './helpers/rawUrls';
import { trimDecoratedUrlRange } from './helpers/urlDecorationRange';
import { createOpenLinkButton } from './helpers/linkOpenButton';
import { getViewportController } from './helpers/viewportController';
import { estimateBlockWidgetHeight } from './editor/blockWidgetHeight';
import { collectInlineFootnoteMarkerRanges } from './helpers/inlineFootnotes';
import {
  collectLatexMathRanges,
  renderLatexMathToHtml,
  resolveFencedDisplayMathInnerLineRange,
  type LatexMathRange,
  type LatexMathMode
} from './helpers/math';
import { diagnosticDataField, type EditorDiagnostic } from './helpers/diagnostics';
import { gitDiffLineFlagsField } from './helpers/gitDiffGutter';
import { markdownTagField } from './helpers/tags';
import {
  getMermaidBlockMode,
  MermaidEditingWidget,
  mermaidEditingStateField,
  setMermaidBlockModeEffect,
  setMermaidSearchRevealEffect
} from './helpers/mermaidEditing';
import { collectPunctuationClosingInlineStyles, type ParsedInlineStyleRange } from './helpers/inlineStyleFallback';
import { collectHexColorRangesFromText } from '../../src/shared/hexColorSwatches';
import { addColorSwatchDecoration } from './helpers/colorSwatches';
import { longCodeBlockSessionUiExtension } from './helpers/longCodeBlocks';
import { attachLatexMathViewport, type LatexMathViewportController } from './helpers/latexMathViewport';
import {
  addHtmlContentDecorations,
  enterHtmlSource,
  getHtmlEditingRange,
  htmlContentExtensions
} from './helpers/htmlContent';

import {
  addLatexMathToolbar,
  createLatexMathToolbarWidget,
  getLatexMathBlockMode,
  LatexMathEditingWidget,
  latexMathEditingStateField,
  setLatexMathBlockModeEffect,
  setLatexMathSearchRevealEffect
} from './helpers/latexMathEditing';
import {
  applyLiveBlockIndent,
  getLiveBlockIndent,
  liveBlockIndentCssValue,
  liveBlockIndentKey,
  liveBlockIndentProperty,
  type LiveBlockIndentValue
} from './helpers/blockIndent';
import {
  createRenderedBlockPreviewShell,
  getRenderedBlockPreviewStartLine,
  renderedBlockPreviewStartLine
} from './helpers/renderedBlockPreview';
import { getUiStrings } from './application/uiLanguage';
import {
  getUiLanguageWidgetEpoch,
  UiLanguageSensitiveWidget,
  uiLanguageFacet
} from './editor/uiLanguage';
import {
  isLiveInputDerivedWorkRefresh,
  isLiveInputNestedProjection,
  liveInputDerivedWorkExtensions,
  mapLiveInputDerivedDecorations,
  replaceLiveInputNestedDecorationEffect,
  shouldDeferLiveInputDerivedWork,
  usesLargeDocumentDerivedWorkBudget
} from './editor/liveInputDerivedWork';

const markerDeco = Decoration.mark({ class: 'meo-md-marker' });
// The benchmark viewport exposes at most ~70 CodeMirror lines. Retaining 80
// lines on either side keeps the current surface live without mapping the file.
const largeDocumentInputLineRadius = 80;
const activeLineMarkerDeco = Decoration.mark({ class: 'meo-md-marker-active' });
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
const subscriptContentDeco = Decoration.mark({ class: 'meo-md-subscript' });
const superscriptContentDeco = Decoration.mark({ class: 'meo-md-superscript' });
const fenceMarkerDeco = Decoration.mark({ class: 'meo-md-fence-marker' });
const headingContentDeco = Decoration.mark({ class: 'meo-md-heading-content' });
const strongMarkerDeco = Decoration.mark({
  class: 'meo-md-marker meo-md-strong-marker'
});
const activeStrongMarkerDeco = Decoration.mark({
  class: 'meo-md-marker-active meo-md-strong-marker-active'
});
class InlineSyntaxBoundaryWidget extends WidgetType {
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
const headingGutterLineClassMarkers = Array.from({ length: 6 }, (_, index) => new (class extends GutterMarker {
  elementClass = `meo-md-heading-line-number meo-md-heading-line-number-h${index + 1}`;
})());
const renderedBlockPreviewAnchorGutterMarker = new (class extends GutterMarker {
  elementClass = 'meo-rendered-block-preview-anchor-gutter';
})();
type RenderedBlockDocumentLineNumberKind = 'mermaid' | 'math';

class RenderedBlockPreviewLineNumberMarker extends GutterMarker {
  elementClass = 'meo-rendered-block-preview-line-number';

  constructor(readonly lineNumber: number) {
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
    readonly lineCount: number
  ) {
    super();
  }

  eq(other: GutterMarker): boolean {
    return other instanceof RenderedBlockDocumentLineNumbersMarker
      && other.kind === this.kind
      && other.anchor === this.anchor
      && other.startLine === this.startLine
      && other.lineCount === this.lineCount;
  }

  toDOM(view: EditorView): Node {
    const column = document.createElement('div') as RenderedBlockDocumentLineNumberColumn;
    column.className = 'meo-rendered-block-document-line-number-column';
    for (let index = 0; index < this.lineCount; index += 1) {
      const marker = document.createElement('span');
      marker.className = 'meo-rendered-block-document-line-number';
      marker.textContent = String(this.startLine + index);
      column.appendChild(marker);
    }

    const rootSelector = this.kind === 'mermaid'
      ? `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${this.anchor}"]`
      : `.meo-latex-math-editing-block[data-meo-latex-math-anchor="${this.anchor}"]`;
    const sourceSelector = this.kind === 'mermaid'
      ? '.meo-mermaid-source-editor'
      : '.meo-latex-math-source-editor';
    let timer = 0;
    let observer: ResizeObserver | null = null;
    let observedElements: Element[] = [];

    const sync = (): boolean => {
      const outerMarker = column.closest<HTMLElement>('.cm-gutterElement');
      const source = view.dom.querySelector<HTMLElement>(`${rootSelector} ${sourceSelector}`);
      const innerMarkers = Array.from(
        source?.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement') ?? []
      ).filter((element) => (
        getComputedStyle(element).visibility !== 'hidden'
        && element.getBoundingClientRect().height > 0
        && Boolean(element.textContent?.trim())
      ));
      if (!outerMarker || innerMarkers.length < this.lineCount) return false;

      column.style.top = '';
      const columnRect = column.getBoundingClientRect();
      const firstInnerRect = innerMarkers[0].getBoundingClientRect();
      column.style.top = `${firstInnerRect.top - columnRect.top}px`;
      const lineMarkers = Array.from(column.children) as HTMLElement[];
      for (let index = 0; index < lineMarkers.length; index += 1) {
        lineMarkers[index].style.height = `${innerMarkers[index].getBoundingClientRect().height}px`;
      }

      if (typeof ResizeObserver !== 'undefined') {
        const nextObserved = [source!, ...innerMarkers];
        if (
          !observer
          || nextObserved.length !== observedElements.length
          || nextObserved.some((element, index) => element !== observedElements[index])
        ) {
          observer?.disconnect();
          observer = new ResizeObserver(() => sync());
          observedElements = nextObserved;
          for (const element of observedElements) observer.observe(element);
        }
      }
      return true;
    };
    const settle = (attemptsLeft: number): void => {
      if (sync() || attemptsLeft <= 1) return;
      timer = window.setTimeout(() => settle(attemptsLeft - 1));
    };
    queueMicrotask(() => settle(4));
    column.__meoRenderedBlockLineNumberCleanup = () => {
      window.clearTimeout(timer);
      observer?.disconnect();
      observer = null;
      observedElements = [];
    };
    return column;
  }

  destroy(dom: Node): void {
    (dom as RenderedBlockDocumentLineNumberColumn).__meoRenderedBlockLineNumberCleanup?.();
  }
}
const renderedBlockLineNumberMarker = lineNumberWidgetMarker.of((_view, widget, block) => {
  if (block.height < 1) return null;
  const previewStartLine = getRenderedBlockPreviewStartLine(widget);
  if (previewStartLine !== null) {
    return new RenderedBlockPreviewLineNumberMarker(previewStartLine);
  }
  if (widget instanceof MermaidEditingWidget) {
    return new RenderedBlockDocumentLineNumbersMarker(
      'mermaid',
      widget.block.anchor,
      widget.block.startLine + 1,
      widget.block.diagramText.split('\n').length
    );
  }
  if (widget instanceof LatexMathEditingWidget) {
    return new RenderedBlockDocumentLineNumbersMarker(
      'math',
      widget.block.anchor,
      widget.block.lineNumber + 1,
      widget.block.sourceText.split('\n').length
    );
  }
  return null;
});
const isTableContentLine = (lineText: string): boolean => lineText.includes('|');

type DecorationCollector = Array<Range<Decoration>>;
type SourceRange = { from: number; to: number };
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
    marker.textContent = `${this.footnoteNumber}.`;
    marker.setAttribute('aria-hidden', 'true');
    return marker;
  }
}

class FootnoteReferenceSeparatorWidget extends WidgetType {
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
      style: `--meo-list-hanging-indent:${offset}ch;--meo-list-indent-columns:${indent}ch;--meo-list-guide-step:${guideStep}ch;--meo-task-hidden-prefix-columns:${hiddenTaskPrefix}ch;`
    }
  });
  listLineDecoCache.set(key, deco);
  return deco;
}

const inlineStyleDecos = {
  em: Decoration.mark({ class: 'meo-md-em' }),
  strong: Decoration.mark({ class: 'meo-md-strong' }),
  strike: Decoration.mark({ class: 'meo-md-strike' }),
  highlight: Decoration.mark({ class: 'meo-md-highlight' }),
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
  addDelimitedInlineStyleDecoration(builder, state, node, inlineStyleDecos.strike, ['~~', '~']);
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
  activeLines: Set<number>,
  frontmatter: FrontmatterInfo | null,
  codeBlockLines: Set<number> | null = null
): void {
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    if (
      !isThematicBreakLine(line.text) ||
      isInsideFrontmatter(frontmatter, line.from) ||
      codeBlockLines?.has(lineNo)
    ) {
      continue;
    }
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
    button.title = strings.clearLinkUrl;
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
  eq(other: WidgetType): boolean {
    return other instanceof MissingWikiLinkWidget && this.hasSameUiLanguageEpoch(other);
  }

  toDOM(view: EditorView): HTMLElement {
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    const badge = document.createElement('span');
    badge.className = 'meo-md-wiki-missing-icon';
    badge.title = strings.missingWikiLink;
    badge.setAttribute('aria-label', strings.missingWikiLink);
    badge.appendChild(createElement(AlertCircle, { 'aria-hidden': 'true' }));
    return badge;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class MissingLocalLinkWidget extends UiLanguageSensitiveWidget {
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
  if (liveBlockIndentCssValue(indent) === null) {
    return;
  }
  addLineClass(builder, state, from, to, blockIndentLineDeco(indent));
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
    button.title = this.collapsed ? strings.expandDetails : strings.collapseDetails;
    button.setAttribute('aria-label', button.title);

    const label = document.createElement('span');
    label.className = 'meo-md-details-summary-label';
    label.textContent = this.summaryText;
    button.appendChild(label);

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
    button.title = strings.jumpToFootnote(this.footnoteNumber);
    button.setAttribute('aria-label', button.title);

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
      else view.dispatch({ effects: EditorView.scrollIntoView(this.definitionFrom, { y: 'center' }) });
      view.focus();
    });

    return button;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class FootnoteBacklinkWidget extends UiLanguageSensitiveWidget {
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
    button.title = strings.jumpToFootnoteReference(this.footnoteNumber);
    button.setAttribute('aria-label', button.title);
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
      else view.dispatch({ effects: EditorView.scrollIntoView(this.referenceFrom, { y: 'center' }) });
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
    button.title = strings.showHtmlSource;
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
        widget: new MissingWikiLinkWidget(),
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

function addSingleTildeStrikeDecorations(builder: DecorationCollector, state: EditorState, activeLines: Set<number>, existingStrikeRanges: SourceRange[], codeBlockLines: Set<number> | null = null): void {
  const pairs = collectSingleTildeStrikePairs(state, existingStrikeRanges);
  for (const pair of pairs) {
    if (codeBlockLines?.has(pair.lineNo)) {
      continue;
    }
    addRange(builder, pair.strikeFrom, pair.strikeTo, inlineStyleDecos.strike);
    addInlineMarkerRange(
      builder,
      activeLines,
      pair.lineNo,
      pair.openFrom,
      pair.openTo,
      strikeMarkerDeco,
      activeStrikeMarkerDeco
    );
    addInlineMarkerRange(
      builder,
      activeLines,
      pair.lineNo,
      pair.closeFrom,
      pair.closeTo,
      strikeMarkerDeco,
      activeStrikeMarkerDeco,
      true
    );
  }
}

function addPunctuationClosingInlineStyleDecorations(
  builder: DecorationCollector,
  state: EditorState,
  activeLines: Set<number>,
  parsedStyleRanges: ReadonlyArray<ParsedInlineStyleRange>,
  codeBlockLines: Set<number> | null = null,
  blockedRanges: ReadonlyArray<SourceRange> = [],
  frontmatter: FrontmatterInfo | null = null
): void {
  const decorationsByNodeName = {
    StrongEmphasis: { content: inlineStyleDecos.strong, inactive: strongMarkerDeco, active: activeStrongMarkerDeco },
    Strikethrough: { content: inlineStyleDecos.strike, inactive: strikeMarkerDeco, active: activeStrikeMarkerDeco },
    Highlight: {
      content: inlineStyleDecos.highlight,
      inactive: highlightMarkerDeco,
      active: activeHighlightMarkerDeco
    },
    Emphasis: { content: inlineStyleDecos.em, inactive: emMarkerDeco, active: activeEmMarkerDeco }
  };

  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    if (codeBlockLines?.has(lineNo)) continue;
    const line = state.doc.line(lineNo);
    if (
      isInsideFrontmatterContent(frontmatter, line.from) ||
      blockedRanges.some((range) => line.from < range.to && line.to > range.from)
    ) {
      continue;
    }
    for (const range of collectPunctuationClosingInlineStyles(line.text, line.from, parsedStyleRanges)) {
      const style = decorationsByNodeName[range.nodeName];
      addRange(builder, range.contentFrom, range.contentTo, style.content);
      addInlineMarkerRange(
        builder,
        activeLines,
        lineNo,
        range.from,
        range.contentFrom,
        style.inactive,
        style.active
      );
      addInlineMarkerRange(
        builder,
        activeLines,
        lineNo,
        range.closeFrom,
        range.to,
        style.inactive,
        style.active,
        true
      );
    }
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

function addFootnoteDefinitionDecorations(builder: DecorationCollector, state: EditorState, footnotes: ParsedFootnotes, activeLines: Set<number>): void {
  for (const definition of footnotes.definitions) {
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
    }

    for (const continuationLine of definition.continuationLines) {
      builder.push(lineStyleDecos.footnoteContinuation.range(continuationLine.from));
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

function addAtxHeadingContentColor(builder: DecorationCollector, state: EditorState, from: number, to: number): void {
  const line = state.doc.lineAt(from);
  const text = state.doc.sliceString(line.from, line.to);
  const match = /^(#{1,6}[ \t]+)/.exec(text);
  const contentFrom = match ? line.from + match[1].length : from;
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

function addListLineDecorations(
  builder: DecorationCollector,
  state: EditorState,
  indentSelectedLines: Set<number>,
  frontmatter: FrontmatterInfo | null = null,
  codeBlockLines: Set<number> | null = null
): void {
  const stylesByLine = detectListIndentStylesByLine(state);
  const orderedCountsByLevel: Array<number | null> = [];

  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    if (codeBlockLines?.has(lineNo)) {
      orderedCountsByLevel.length = 0;
      continue;
    }
    const line = state.doc.line(lineNo);
    const lineText = state.doc.sliceString(line.from, line.to);
    const style = stylesByLine.get(lineNo);
    const marker = listMarkerData(lineText, null, style);
    if (!marker) {
      orderedCountsByLevel.length = 0;
      continue;
    }

    const level = marker.indentLevel;
    const { expected: orderedDisplayIndex } = nextOrderedSequenceNumber(
      orderedCountsByLevel,
      level,
      marker.orderedNumber
    );

    const inFrontmatterContent = isInsideFrontmatterContent(frontmatter, line.from);
    if (inFrontmatterContent) {
      // Keep front matter list-like values rendered literally (source-style),
      // while still tinting the prefix as a list marker.
      addListMarkerDecoration(builder, state, line.from, orderedDisplayIndex, style, {
        useSourceStyleLiteral: true
      });
      continue;
    }

    if (marker.fromOffset > 0 && (marker.indentColumns ?? 0) > 0) {
      builder.push(
        Decoration.replace({
          widget: listIndentWidget(marker.indentColumns ?? 0),
          inclusive: false
        }).range(line.from, line.from + marker.fromOffset)
      );
    }

    builder.push(
      listLineDeco(
        marker.contentOffsetColumns ?? marker.toOffset,
        marker.indentColumns ?? 0,
        style?.columns ?? 2,
        indentSelectedLines.has(lineNo),
        Boolean(marker.isTask),
        marker.taskHiddenPrefixColumns ?? 0,
        Boolean(marker.orderedNumber)
      ).range(line.from)
    );
    addListMarkerDecoration(builder, state, line.from, orderedDisplayIndex, style);
  }
}

function buildDecorations(state: EditorState): DecorationSet {
  const ranges: DecorationCollector = [];
  const diagnostics = state.field(diagnosticDataField, false) ?? [];
  const activeLines = collectActiveLines(state);
  const indentSelectedLines = collectIndentSelectedLines(state);
  const tree = resolvedSyntaxTree(state);
  const footnotes = parseFootnotes(state);
  const detailsBlocks = getDetailsBlocks(state, tree);
  const strikeRanges = collectStrikethroughRanges(tree);
  const parsedInlineStyleRanges: ParsedInlineStyleRange[] = [];
  tree.iterate({
    enter(node: SyntaxNodeRef) {
      if (node.name === 'StrongEmphasis' || node.name === 'Emphasis' || node.name === 'Strikethrough' || node.name === 'Highlight' || node.name === 'InlineCode') {
        parsedInlineStyleRanges.push({ from: node.from, to: node.to, nodeName: node.name });
      }
    }
  });
  const codeBlockLines = collectCodeBlockLines(state, tree);
  const renderedTableRanges = collectRenderedTableRanges(
    state,
    getLiveRenderedBlocks(state)
  );
  const activeImageGroups = new Map<number, ActiveImageGroup>();
  const parsedTableRanges: SourceRange[] = [];
  let tableDepth = 0;

  let frontmatter: FrontmatterInfo | null = null;
  try {
    frontmatter = parseFrontmatter(state);
    if (frontmatter) {
      addFrontmatterBoundaryDecorations(ranges, state, frontmatter, activeLines);
    } else {
      frontmatter = parseFrontmatterCandidate(state);
    }
  } catch {
    frontmatter = null;
  }
  addForcedThematicBreakDecorations(ranges, state, activeLines, frontmatter, codeBlockLines);
  const mathRanges = collectMathRanges(state, tree, renderedTableRanges, frontmatter);
  const renderedHtmlBlocks = addHtmlContentDecorations(ranges, state, activeLines);

  tree.iterate({
    enter: (node: SyntaxNodeRef) => {
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

      const headingLevel = headingLevelFromName(node.name);
      if (headingLevel !== null) {
        if (tableDepth === 0 && !isInsideFrontmatter(frontmatter, node.from)) {
          addAtxHeadingPrefixMarkers(ranges, state, node.from, activeLines);
          addAtxHeadingContentColor(ranges, state, node.from, node.to);
          const headingDecoration = [
            lineStyleDecos.h1,
            lineStyleDecos.h2,
            lineStyleDecos.h3,
            lineStyleDecos.h4,
            lineStyleDecos.h5,
            lineStyleDecos.h6
          ][headingLevel - 1];
          addLineClass(ranges, state, node.from, node.to, headingDecoration);
        }
      }

      if (node.name === 'Blockquote') {
        const line = state.doc.lineAt(node.from);
        const lineText = state.doc.sliceString(line.from, line.to).trimStart();
        if (lineText.startsWith('>>>>>>>')) {
          addLineClass(ranges, state, node.from, node.to, lineStyleDecos.mergeIncomingHeader);
          return;
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
          addCodeLanguageLabel(ranges, state, node, activeLines);
        }
        addCodeBlockLineNumbers(ranges, state, node);
        addCopyCodeButton(ranges, state, node.from, node.to);
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
          const { url, altText, linkUrl } = getImageData(state, node);
          if (url) {
            const group = activeImageGroups.get(line.number) ?? { line, items: [] };
            group.items.push({ url, altText, linkUrl, sourceFrom: node.from });
            activeImageGroups.set(line.number, group);
          }
          return;
        }

        const { url, altText, linkUrl } = getImageData(state, node);
        if (url) {
          ranges.push(
            Decoration.replace({
              widget: new ImageWidget(
                url,
                altText,
                linkUrl,
                node.from,
                getImagePresentationFactory(state),
                { uiLanguage: state.facet(uiLanguageFacet) }
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
        addRange(ranges, node.from, node.to, activeLineMarkerDeco);
      } else {
        addRange(ranges, node.from, node.to, markerDeco);
      }
    },
    leave: (node: SyntaxNodeRef) => {
      if (node.name === 'Table') {
        tableDepth -= 1;
      }
    },
  });

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

  addFallbackTableDecorations(ranges, state, tree, parsedTableRanges, diagnostics);
  addRawFileUrlDecorations(ranges, state, tree, activeLines, frontmatter);
  addPunctuationClosingInlineStyleDecorations(
    ranges,
    state,
    activeLines,
    parsedInlineStyleRanges,
    codeBlockLines,
    [...renderedTableRanges, ...mathRanges],
    frontmatter
  );
  addSingleTildeStrikeDecorations(ranges, state, activeLines, strikeRanges, codeBlockLines);
  addListLineDecorations(ranges, state, indentSelectedLines, frontmatter, codeBlockLines);
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
    ]
  );
  addKbdTagDecorations(ranges, state, activeLines, renderedTableRanges, mathRanges, frontmatter, codeBlockLines);
  addFootnoteDefinitionDecorations(ranges, state, footnotes, activeLines);
  const htmlEditingRange = getHtmlEditingRange(state);
  addDetailsBlockDecorations(
    ranges,
    state,
    detailsBlocks.filter((detailsBlock) => !renderedHtmlBlocks.some((htmlBlock) => (
      htmlBlock.from === detailsBlock.anchorFrom
    )) && !(
      htmlEditingRange?.from === detailsBlock.sectionFrom &&
      htmlEditingRange.to === detailsBlock.sectionTo
    ))
  );
  const result = Decoration.set(ranges, true);
  return filterDecorationsOutsideMergeConflicts(state, result);
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
      }).range(startLine.from)
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
  extra: { docChanged?: boolean; selection?: EditorSelection } = {}
): DecorationSet {
  try {
    return buildDecorations(state);
  } catch (error) {
    console.error('[MEO liveMode] decoration build failed', {
      context,
      docLength: state.doc.length,
      ...extra,
      error
    });
    return fallback;
  }
}

function mergeConflictRanges(state: EditorState): SourceRange[] {
  return parseMergeConflicts(state).map((conflict) => ({
    from: conflict.blockFrom,
    to: conflict.blockTo
  }));
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

function collectCodeBlockLines(state: EditorState, tree: Tree): Set<number> {
  const lines = new Set<number>();
  tree.iterate({
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

  return lines;
}

class KbdTagWidget extends WidgetType {
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
};

class LatexMathWidget extends UiLanguageSensitiveWidget {
  html: string;
  mode: LatexMathMode;
  fencedDisplay: boolean;
  startLine: number;
  endLine: number;
  indentColumns: LiveBlockIndentValue;
  anchor: number;
  sourceText: string;
  blockTo: number;

  constructor(
    html: string,
    mode: LatexMathMode,
    fencedDisplay = false,
    startLine = 0,
    endLine = 0,
    indentColumns: LiveBlockIndentValue = 0,
    anchor = 0,
    sourceText = '',
    blockTo = 0
  ) {
    super();
    this.html = html;
    this.mode = mode;
    this.fencedDisplay = fencedDisplay;
    this.startLine = startLine;
    this.endLine = endLine;
    this.indentColumns = indentColumns;
    this.anchor = anchor;
    this.sourceText = sourceText;
    this.blockTo = blockTo;
  }

  get estimatedHeight(): number {
    return this.fencedDisplay && this.mode === 'display'
      ? estimateBlockWidgetHeight({
          kind: 'latex-display',
          html: this.html
        })
      : -1;
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
      other.indentColumns === this.indentColumns &&
      other.anchor === this.anchor &&
      other.sourceText === this.sourceText &&
      other.blockTo === this.blockTo
    );
  }

  get [renderedBlockPreviewStartLine](): number | undefined {
    return this.fencedDisplay && this.mode === 'display'
      ? this.startLine
      : undefined;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrapper = document.createElement(this.mode === 'display' ? 'div' : 'span') as LatexMathWidgetElement;
    wrapper.className = `meo-md-math meo-md-math-${this.mode}`;
    if (this.fencedDisplay && this.mode === 'display') {
      wrapper.classList.add('meo-md-math-fenced-display');
      wrapper.addEventListener('pointerdown', (event: PointerEvent) => {
        if (event.button === 0) {
          event.preventDefault();
        }
      });
    }
    wrapper.innerHTML = this.html;
    if (this.fencedDisplay && this.mode === 'display') {
      wrapper.__meoLatexMathViewport = attachLatexMathViewport(wrapper, {
        interactive: true,
        uiLanguage: view.state.facet(uiLanguageFacet)
      });
      return createRenderedBlockPreviewShell({
        kind: 'math',
        language: 'latex',
        startLine: this.startLine,
        endLine: this.endLine,
        indentColumns: this.indentColumns,
        toolbar: createLatexMathToolbarWidget(
          this.anchor,
          this.startLine,
          'preview',
          this.sourceText,
          this.blockTo
        ).toDOM(view),
        content: wrapper
      });
    }
    applyLiveBlockIndent(wrapper, this.indentColumns);
    return wrapper;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
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
  blockTo = 0
): WidgetType {
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

function mergeSimpleRanges(ranges: Array<{ from: number; to: number }>): Array<{ from: number; to: number }> {
  const filtered = ranges
    .filter((range) => Number.isFinite(range.from) && Number.isFinite(range.to) && range.to > range.from)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  if (!filtered.length) {
    return [];
  }

  const merged = [filtered[0]];
  for (let index = 1; index < filtered.length; index += 1) {
    const current = filtered[index];
    const previous = merged[merged.length - 1];
    if (current.from <= previous.to) {
      if (current.to > previous.to) {
        previous.to = current.to;
      }
      continue;
    }
    merged.push({ from: current.from, to: current.to });
  }
  return merged;
}

function collectInlineCodeRanges(tree: Tree): SourceRange[] {
  const ranges: Array<{ from: number; to: number }> = [];
  tree.iterate({
    enter(node: SyntaxNodeRef) {
      if (node.name === 'InlineCode' || node.name === 'CodeText') {
        ranges.push({ from: node.from, to: node.to });
      }
    }
  });
  return ranges;
}

function collectCodeBlockRanges(tree: Tree): SourceRange[] {
  const ranges: Array<{ from: number; to: number }> = [];

  tree.iterate({
    enter(node: SyntaxNodeRef) {
      if (node.name !== 'FencedCode' && node.name !== 'CodeBlock') {
        return;
      }
      ranges.push({ from: node.from, to: node.to });
      return false;
    }
  });

  return ranges;
}

function collectMathRanges(
  state: EditorState,
  tree: Tree,
  renderedTableRanges: ReadonlyArray<SourceRange>,
  frontmatter: FrontmatterInfo | null = null
): LatexMathRange[] {
  const excludedRanges = [
    ...collectInlineCodeRanges(tree),
    ...collectCodeBlockRanges(tree),
    ...renderedTableRanges
  ];

  if (frontmatter) {
    excludedRanges.push({ from: frontmatter.openingFrom, to: frontmatter.closingTo });
  }

  const text = state.doc.toString();
  if (text.indexOf('$') === -1) {
    return [];
  }

  return collectLatexMathRanges(text, {
    excludedRanges: mergeSimpleRanges(excludedRanges)
  });
}

function resolveFencedMathRenderSpan(
  state: EditorState,
  startLineNo: number,
  endLineNo: number
): { innerFrom: number; innerTo: number } | null {
  const innerLineRange = resolveFencedDisplayMathInnerLineRange(
    startLineNo,
    endLineNo
  );
  if (!innerLineRange) {
    return null;
  }

  const innerStartLine = state.doc.line(innerLineRange.innerStartLine);
  const innerEndLine = state.doc.line(innerLineRange.innerEndLine);
  if (innerEndLine.to <= innerStartLine.from) {
    return null;
  }

  return {
    innerFrom: innerStartLine.from,
    innerTo: innerEndLine.to
  };
}

function addMathDecorations(
  builder: DecorationCollector,
  state: EditorState,
  mathRanges: ReadonlyArray<LatexMathRange>,
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
      const indentColumns = getLiveBlockIndent(state, openingLine.from);
      const renderSpan = resolveFencedMathRenderSpan(state, startLineNo, endLineNo);
      if (renderSpan) {
        editingBoundary =
          rangeTouchesActiveLine(state, renderSpan.innerFrom, renderSpan.innerTo, activeLines) ||
          overlapsSelection(state, renderSpan.innerFrom, renderSpan.innerTo);
      }

      const copyContent = renderSpan
        ? state.doc.sliceString(renderSpan.innerFrom, renderSpan.innerTo)
        : '';
      const anchor = openingLine.from;
      const mode = renderSpan
        ? getLatexMathBlockMode(state, anchor, renderSpan.innerFrom, renderSpan.innerTo)
        : null;
      const decision = mode?.decision ?? null;
      if (copyContent && decision) {
        if (decision.effectiveMode !== 'preview' && !activeLines.has(openingLine.number)) {
          addTopLinePillLabel(builder, openingLine.from, 'latex', -1);
        }
        if (decision.effectiveMode !== 'preview') {
          addLatexMathToolbar(
            builder,
            openingLine.to,
            anchor,
            openingLine.number,
            decision.effectiveMode,
            copyContent,
            mathRange.to
          );
        }
      }

      const sourceDecorationStart = builder.length;
      addLineClass(builder, state, openingLine.from, closingLine.to, lineStyleDecos.codeBlock);
      addBlockIndentLines(builder, state, openingLine.from, closingLine.to, indentColumns);
      builder.push(lineStyleDecos.codeBlockStart.range(openingLine.from));
      builder.push(lineStyleDecos.codeBlockEnd.range(closingLine.from));

      addRange(
        builder,
        openingLine.from,
        openingLine.to,
        activeLines.has(openingLine.number) ? activeCodeMarkerDeco : fenceMarkerDeco
      );
      if (decision) {
        addRange(
          builder,
          closingLine.from,
          closingLine.to,
          activeLines.has(closingLine.number) ? activeCodeMarkerDeco : fenceMarkerDeco
        );
      }

      if (!renderSpan || !mode || !decision) {
        continue;
      }

      if (decision.effectiveMode !== 'preview') {
        builder.push(
          Decoration.replace({
            widget: new LatexMathEditingWidget({
              anchor,
              lineNumber: openingLine.number,
              contentFrom: renderSpan.innerFrom,
              contentTo: renderSpan.innerTo,
              sourceText: copyContent,
              indentColumns
            }, decision.effectiveMode, mode.searchReveal),
            block: true
          }).range(renderSpan.innerFrom, renderSpan.innerTo)
        );
        continue;
      }

      const html = renderLatexMathToHtml(mathRange.content, mathRange.mode);
      if (!html) continue;
      builder.splice(sourceDecorationStart, builder.length - sourceDecorationStart);
      builder.push(lineStyleDecos.renderedBlockPreviewAnchor.range(openingLine.from));
      builder.push(
        Decoration.replace({
          widget: getMathWidget(
            html,
            mathRange.mode,
            true,
            startLineNo,
            endLineNo,
            indentColumns,
            anchor,
            copyContent,
            mathRange.to
          ),
          block: true
        }).range(openingLine.from, closingLine.to)
      );
      continue;
    }

    if (editingBoundary) {
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
  codeBlockLines: Set<number> | null = null
): void {
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    if (activeLines.has(lineNo) || codeBlockLines?.has(lineNo)) {
      continue;
    }

    const line = state.doc.line(lineNo);
    if (isInsideFrontmatterContent(frontmatter, line.from)) {
      continue;
    }

    const lineText = state.doc.sliceString(line.from, line.to);
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

function collectColorSyntaxRanges(tree: Tree): {
  scanRanges: SourceRange[];
  excludedRanges: SourceRange[];
} {
  const scanRanges: SourceRange[] = [];
  const excludedRanges: SourceRange[] = [];
  const blockStack: Array<SourceRange & { hasBlockChild: boolean }> = [];
  tree.iterate({
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
  return { scanRanges, excludedRanges };
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
  excludedRangeStreams: ReadonlyArray<ReadonlyArray<SourceRange>>
): void {
  const documentText = state.doc.toString();
  const syntaxRanges = collectColorSyntaxRanges(tree);
  const colorRanges = [];
  for (const scanRange of syntaxRanges.scanRanges) {
    for (const colorRange of collectHexColorRangesFromText(documentText, 0, scanRange)) {
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

const liveDecorationField = StateField.define<DecorationSet>({
  create(state: EditorState): DecorationSet {
    return safeBuildDecorations(state, Decoration.none, 'create');
  },
  update(decorations: DecorationSet, transaction: Transaction): DecorationSet {
    // Search highlights are maintained independently. Preserving the existing
    // live decorations prevents a transient parse result from exposing source.
    if (
      transaction.effects.some((effect) => effect.is(preserveLiveDecorationsForSearchEffect)) &&
      !transaction.effects.some((effect) => effect.is(refreshLiveDecorationsAfterSearchEffect))
    ) {
      return decorations;
    }
    if (shouldDeferLiveInputDerivedWork(transaction)) {
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
          : mapLiveInputDerivedDecorations(inputDecorations, transaction)
        : inputDecorations;
    }
    // Recompute on every transaction so live mode stays in sync with parser updates
    // that may arrive without direct doc/selection changes.
    const next = safeBuildDecorations(transaction.state, decorations, 'update', {
      docChanged: transaction.docChanged,
      selection: transaction.selection
    });

    // Guard against transient empty parse results on selection-only transactions.
    if (!transaction.docChanged && isEmptyDecorationSet(next) && !isEmptyDecorationSet(decorations)) {
      return decorations;
    }

    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

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
    const span = resolveFencedMathRenderSpan(state, block.startLine, block.endLine);
    if (!span) return false;
    const anchor = state.doc.line(block.startLine).from;
    return getLatexMathBlockMode(state, anchor, span.innerFrom, span.innerTo).decision.effectiveMode === 'preview';
  }
  return false;
}

function buildLiveLineNumberMarkers(state: EditorState): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  const conflictLineNumbers = new Set<number>();
  for (const conflict of parseMergeConflicts(state)) {
    for (let lineNo = conflict.startLineNo; lineNo <= conflict.endLineNo; lineNo += 1) {
      conflictLineNumbers.add(lineNo);
    }
  }
  for (const block of getLiveRenderedBlocks(state, { includeSelectedMath: true })) {
    if (isRenderedBlockPreview(state, block)) {
      const anchorLine = state.doc.line(block.startLine);
      builder.add(anchorLine.from, anchorLine.from, renderedBlockPreviewAnchorGutterMarker);
    }
    if (block.lineNumberHiddenFrom < 1 || block.lineNumberHiddenTo < block.lineNumberHiddenFrom) {
      continue;
    }
    for (let lineNo = block.lineNumberHiddenFrom; lineNo <= block.lineNumberHiddenTo; lineNo += 1) {
      if (conflictLineNumbers.has(lineNo)) {
        continue;
      }
      const line = state.doc.line(lineNo);
      builder.add(line.from, line.from, tableDelimiterGutterLineClassMarker);
    }
  }
  return builder.finish();
}

function detectTableBlocks(state: EditorState): Array<{ startLineNo: number; endLineNo: number }> {
  const blocks: Array<{ startLineNo: number; endLineNo: number }> = [];
  for (let lineNo = 2; lineNo <= state.doc.lines; lineNo += 1) {
    const delimiterLine = state.doc.line(lineNo);
    const delimiterText = state.doc.sliceString(delimiterLine.from, delimiterLine.to);
    if (isThematicBreakLine(delimiterText)) continue;
    if (!isTableDelimiterLine(delimiterText)) continue;
    const commonIndent = /^[ \t]*/.exec(delimiterText)?.[0] ?? '';

    const headerLineNo = lineNo - 1;
    const headerLine = state.doc.line(headerLineNo);
    const headerText = state.doc.sliceString(headerLine.from, headerLine.to);
    if (!headerText.startsWith(commonIndent) || (/^[ \t]*/.exec(headerText)?.[0] ?? '') !== commonIndent) continue;
    if (!isTableContentLine(headerText)) continue;

    let endLineNo = lineNo;
    for (let rowLineNo = lineNo + 1; rowLineNo <= state.doc.lines; rowLineNo += 1) {
      const rowLine = state.doc.line(rowLineNo);
      const rowText = state.doc.sliceString(rowLine.from, rowLine.to);
      if (!isTableContentLine(rowText)) break;
      if ((/^[ \t]*/.exec(rowText)?.[0] ?? '') !== commonIndent) break;
      endLineNo = rowLineNo;
    }

    blocks.push({ startLineNo: headerLineNo, endLineNo });
    lineNo = endLineNo;
  }
  return blocks;
}

function addFallbackTableDecorations(
  builder: DecorationCollector,
  state: EditorState,
  tree: Tree,
  parsedTableRanges: ReadonlyArray<SourceRange>,
  diagnostics: EditorDiagnostic[] = []
): void {
  const tableBlocks = detectTableBlocks(state);
  for (const block of tableBlocks) {
    const from = state.doc.line(block.startLineNo).from;
    const to = state.doc.line(block.endLineNo).to;
    if (overlapsParsedTableRange(from, to, parsedTableRanges)) continue;
    const headerText = state.doc.line(block.startLineNo).text;
    const syntaxProbe = from + (/^[ \t]*/.exec(headerText)?.[0].length ?? 0);
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
  frontmatter: FrontmatterInfo | null = null
): void {
  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
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
    if (shouldDeferLiveInputDerivedWork(transaction)) {
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
      && !renderedBlockPresentationChanged
      && transaction.startState.selection.eq(transaction.state.selection)) {
      return markers;
    }
    return buildLiveLineNumberMarkers(transaction.state);
  },
  provide: (field) => gutterLineClass.from(field)
});

function buildHeadingLineNumberMarkers(state: EditorState): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  resolvedSyntaxTree(state).iterate({
    enter(node) {
      const level = headingLevelFromName(node.name);
      if (level === null) return;
      const line = state.doc.lineAt(node.from);
      builder.add(line.from, line.from, headingGutterLineClassMarkers[level - 1]);
    }
  });
  return builder.finish();
}

const headingLineNumberMarkerField = StateField.define<RangeSet<GutterMarker>>({
  create: buildHeadingLineNumberMarkers,
  update(markers, transaction) {
    if (!transaction.docChanged && !isLiveInputDerivedWorkRefresh(transaction)) return markers;
    return buildHeadingLineNumberMarkers(transaction.state);
  },
  provide: (field) => gutterLineClass.from(field)
});

// Both modes edit the same grammar. Stable language identity lets CodeMirror
// retain its incremental parse when only presentation extensions change.
export const editorMarkdownLanguage = markdown({
  base: markdownLanguage,
  addKeymap: false,
  codeLanguages: resolveCodeLanguage,
  extensions: [footnoteMarkdownExtension, highlightMarkdownExtension,
    { props: [sourceMarkdownHighlightProps] }, { remove: ['SetextHeading'] }]
});

export function liveModeExtensions(options: { readonly largeDocument?: boolean } = {}): Extension[] {
  return [
    ...liveInputDerivedWorkExtensions(options),
    editorMarkdownLanguage,
    syntaxHighlighting(liveHighlightStyle),
    markdownTagField,
    livePointerSelectionActiveField,
    liveDocumentIdleField,
    mermaidEditingStateField,
    latexMathEditingStateField,
    ...htmlContentExtensions(),
    liveDecorationField,
    renderedBlockLineNumberMarker,
    ...longCodeBlockSessionUiExtension(),
    liveLineNumberMarkerField,
    headingLineNumberMarkerField,
    ...mergeConflictSourceExtensions(),
    ...detailsBlockLiveExtensions()
  ];
}

function isEmptyDecorationSet(set: DecorationSet): boolean {
  const cursor = set.iter();
  return cursor.value === null;
}
