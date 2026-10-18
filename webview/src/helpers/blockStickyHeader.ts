import type { EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate, type WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';
import { currentSyntaxTree, getFencedCodeInfo } from './markdownSyntax';
import { createCodeBlockActionsWidget } from './codeBlocks';
import { createFloatingMermaidToolbarWidget, getMermaidBlockMode } from './mermaidEditing';
import { getLiveRenderedBlocks } from './liveRenderedBlocks';
import { getFencedCodeContent } from './mermaidDiagram';
import { getUiStrings } from '../application/uiLanguage';
import { uiLanguageFacet } from '../editor/uiLanguage';
import { measureFixedContainingBlockMapping } from '../editor/fixedChromeDomGeometry';
import { projectFixedChromeGeometry, type FixedChromeRect } from '../editor/fixedChromeGeometry';
import { getRenderedBlockPreviewControlsOwner, mountFloatingRenderedBlockPreviewControls } from './renderedBlockModeControls';
import { isLiveInputDerivedWorkPending, usesLargeDocumentDerivedWorkBudget } from '../editor/liveInputDerivedWork';

const HEADER_HEIGHT = 30;
const shellSelector = '.meo-rendered-block-preview, .meo-rendered-block-mode-shell';

type BlockHeader = {
  from: number;
  to: number;
  language: string;
  languageClass: 'meo-code-language-label' | 'meo-rendered-block-preview-language';
  quoted: boolean;
  widget: WidgetType;
  kind: 'code' | 'mermaid' | 'math';
};
type Measurement = {
  block: BlockHeader;
  rect: FixedChromeRect;
  previewOwner: ReturnType<typeof getRenderedBlockPreviewControlsOwner>;
};

function codeNodeAt(view: EditorView, position: number): SyntaxNode | null {
  // At the last character boundary, the right side may already be outside
  // the block. Losing that block for one measure drops the header's inset.
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = currentSyntaxTree(view.state).resolveInner(position, side); node; node = node.parent) {
      if (node.name === 'FencedCode' || node.name === 'CodeBlock') return node;
    }
  }
  return null;
}

const headerCache = new WeakMap<EditorState, BlockHeader[]>();

function blockHeaderAt(view: EditorView, position: number): BlockHeader | null {
  const cached = headerCache.get(view.state) ?? [];
  const found = cached.find(block => block.from <= position && block.to >= position);
  if (found) return found;
  const block = readBlockHeader(view, position);
  if (block) { cached.push(block); headerCache.set(view.state, cached); }
  return block;
}

function mountedLine(view: EditorView, node: Node): HTMLElement | null {
  const line = (node instanceof Element ? node : node.parentElement)?.closest<HTMLElement>('.cm-line');
  return line?.closest('.cm-content') === view.contentDOM ? line : null;
}

function mountedSourceLine(view: EditorView, position: number): HTMLElement | null {
  const line = mountedLine(view, view.domAtPos(position).node);
  return line && view.state.doc.lineAt(view.posAtDOM(line, 0)).from === view.state.doc.lineAt(position).from
    ? line : null;
}

function readBlockHeader(view: EditorView, position: number): BlockHeader | null {
  const state = view.state;
  const line = state.doc.lineAt(position);
  // Prose never owns this header. Resolve the local syntax before consulting
  // rich-block discovery, which otherwise scans the new document on each key.
  const node = codeNodeAt(view, position);
  if (!node) return null;
  let quoted = false;
  for (let node: SyntaxNode | null = currentSyntaxTree(state).resolveInner(line.to, -1); node; node = node.parent) {
    if (node.name === 'Blockquote') { quoted = true; break; }
  }
  // Geometry reads reuse the published tree rather than extending the parse.
  const rendered = getLiveRenderedBlocks(state, { includeSelectedMath: true, tree: currentSyntaxTree(state) }).find((block) => (
    (block.kind === 'mermaid' || block.kind === 'math') && block.startLine <= line.number && block.endLine >= line.number
  ));
  if (rendered) {
    const opening = state.doc.line(rendered.startLine);
    const ending = state.doc.line(rendered.endLine);
    if (rendered.kind === 'mermaid') {
      const node = codeNodeAt(view, opening.to);
      if (!node) return null;
      const content = getFencedCodeContent(state, node);
      const mode = getMermaidBlockMode(
        state, opening.from, state.doc.line(opening.number + 1).from, state.doc.line(ending.number - 1).to
      ).decision.effectiveMode;
      return { from: opening.from, to: ending.to, language: 'mermaid', kind: 'mermaid', quoted,
        languageClass: mode === 'preview' ? 'meo-rendered-block-preview-language' : 'meo-code-language-label',
        widget: createFloatingMermaidToolbarWidget(opening.from, opening.number, mode, content, ending.to) };
    }
    return null;
  }
  const widget = createCodeBlockActionsWidget(state, node);
  if (!widget) return null;
  return { from: state.doc.lineAt(node.from).from, to: state.doc.lineAt(Math.max(node.from, node.to - 1)).to,
    language: node.name === 'CodeBlock' ? getUiStrings(state.facet(uiLanguageFacet)).indentedCodeBlockLabel : getFencedCodeInfo(state, { node }) || 'Plain text',
    languageClass: 'meo-code-language-label', kind: 'code', quoted, widget };
}

class BlockStickyHeader {
  readonly header = document.createElement('div');
  private toolbar: HTMLElement | null = null;
  private widget: WidgetType | null = null;
  private identity = '';
  private previewOwner: Measurement['previewOwner'] = null;
  private previewCleanup: () => void = () => undefined;
  private readonly contentObserver: MutationObserver;
  private readonly fullscreenObserver: MutationObserver;
  private destroyed = false;
  private measurePending = false;

  constructor(readonly view: EditorView) {
    this.header.className = 'meo-block-sticky-header';
    this.header.hidden = true;
    view.dom.append(this.header);
    // The bar is passive document chrome. It must not move the caret below it.
    for (const type of ['pointerdown', 'click', 'dblclick', 'contextmenu']) {
      this.header.addEventListener(type, (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (type === 'pointerdown' || !target?.closest('button, [role="button"], summary')) event.preventDefault();
        event.stopPropagation();
      });
    }
    this.header.addEventListener('wheel', (event) => {
      if (event.ctrlKey) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? view.defaultLineHeight : event.deltaMode === 2 ? view.scrollDOM.clientHeight : 1;
      view.scrollDOM.scrollBy(event.deltaX * scale, event.deltaY * scale);
    }, { passive: false });
    view.scrollDOM.addEventListener('scroll', this.requestMeasure, { passive: true });
    this.contentObserver = new MutationObserver(this.requestMeasure);
    this.contentObserver.observe(view.contentDOM, { childList: true, subtree: true });
    this.fullscreenObserver = new MutationObserver(this.requestMeasure);
    this.fullscreenObserver.observe(view.dom.ownerDocument.body, { childList: true });
    this.requestMeasure();
  }

  update(update: ViewUpdate): void {
    // Do not leave old document offsets clickable before the next geometry read.
    if (update.docChanged) this.clear();
    if (update.transactions.length > 0) {
      this.requestMeasure();
    } else if (!this.measurePending) {
      // Layout updates run inside CodeMirror's measure loop. Let its scroll
      // anchor settle before chrome adds another read/write request.
      this.measurePending = true;
      queueMicrotask(() => {
        this.measurePending = false;
        this.requestMeasure();
      });
    }
  }

  private requestMeasure = (): void => {
    if (this.destroyed) return;
    this.view.requestMeasure({ key: this, read: () => this.measure(), write: (value) => this.render(value) });
  };

  private measure(): Measurement | 'fullscreen' | null {
    const view = this.view;
    if (this.destroyed) return null;
    // Header geometry must not rediscover every rich block between keystrokes.
    // The accepted presentation refresh schedules another measurement.
    if (usesLargeDocumentDerivedWorkBudget(view.state) && isLiveInputDerivedWorkPending(view.state)) return null;
    if (view.dom.ownerDocument.querySelector('.meo-mermaid-fullscreen-scrim, .meo-latex-math-fullscreen-scrim')) return 'fullscreen';
    const scroller = view.scrollDOM.getBoundingClientRect();
    if (scroller.height < HEADER_HEIGHT * 2) return null;
    const content = view.contentDOM.getBoundingClientRect();
    // A virtual gap can change the height map before its scroll compensation
    // settles. Read through the floating bar to the painted main-editor line;
    // nested editors and unmounted regions retain the height-map fallback.
    const probeX = Math.max(scroller.left + 1, Math.min(scroller.right - 1, (content.left + content.right) / 2));
    const paintedLine = view.dom.ownerDocument.elementsFromPoint(probeX, scroller.top + 1)
      .map(element => mountedLine(view, element)).find(line => line !== null);
    const position = paintedLine ? view.posAtDOM(paintedLine, 0)
      : view.lineBlockAtHeight(Math.max(0, (scroller.top - view.documentTop + 1) / view.scaleY)).from;
    const block = blockHeaderAt(view, position);
    if (!block) return null;
    const shell = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(shellSelector)).find((candidate) => (
      Number(candidate.dataset.meoRenderedBlockStartLine) === view.state.doc.lineAt(block.from).number ||
      candidate.dataset.meoMermaidAnchor === String(block.from) || candidate.dataset.meoLatexMathAnchor === String(block.from)
    ));
    const opening = block.kind === 'code' ? mountedSourceLine(view, block.from) : null;
    const ending = block.kind === 'code' ? mountedSourceLine(view, block.to) : null;
    const foldedTail = block.kind === 'code'
      ? Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.meo-md-long-code-placeholder'))
        .find(element => {
          const position = view.posAtDOM(element, 0);
          return position >= block.from && position <= block.to;
        }) : null;
    const top = shell?.getBoundingClientRect().top ?? opening?.getBoundingClientRect().top
      ?? view.documentTop + view.lineBlockAt(block.from).top * view.scaleY;
    const bottom = shell?.getBoundingClientRect().bottom ?? foldedTail?.getBoundingClientRect().bottom
      ?? ending?.getBoundingClientRect().bottom ?? view.documentTop + view.lineBlockAt(block.to).bottom * view.scaleY;
    if (bottom - top < HEADER_HEIGHT * 3 || top >= scroller.top - 1 || bottom < scroller.top + HEADER_HEIGHT) return null;
    const line = view.domAtPos(Math.max(block.from, Math.min(position, block.to))).node;
    let lineElement = paintedLine ?? mountedLine(view, line);
    // Code tail widgets have no .cm-line; keep the last source row's bounds and indentation.
    if (!lineElement && block.kind === 'code' && position > block.from) {
      lineElement = mountedLine(view, view.domAtPos(position - 1).node);
    }
    const lineRect = lineElement?.getBoundingClientRect();
    const gutterRight = view.scrollDOM.querySelector(':scope > .cm-gutters')?.getBoundingClientRect().right ?? scroller.left;
    const scaleX = view.scrollDOM.offsetWidth > 0 ? scroller.width / view.scrollDOM.offsetWidth : 1;
    const visibleRight = scroller.right - (view.scrollDOM.offsetWidth - view.scrollDOM.clientWidth) * scaleX;
    const left = Math.max(scroller.left, gutterRight, shell?.getBoundingClientRect().left ?? lineRect?.left ?? content.left);
    const right = Math.min(visibleRight, shell?.getBoundingClientRect().right ?? lineRect?.right ?? content.right);
    if (right - left < 100) return null;
    const mapping = measureFixedContainingBlockMapping(this.header);
    if (!mapping) return null;
    const projection = projectFixedChromeGeometry(mapping, {
      rect: { left, top: scroller.top, width: right - left, height: HEADER_HEIGHT }, vectors: []
    });
    if (!projection.ok) return null;
    return { block, rect: projection.geometry.rect, previewOwner: shell ? getRenderedBlockPreviewControlsOwner(shell) : null };
  }

  private render(value: Measurement | 'fullscreen' | null): void {
    if (this.destroyed) return;
    if (value === 'fullscreen') {
      // Keep the originating button attached so fullscreen exit can restore focus.
      this.header.hidden = true;
      delete this.view.scrollDOM.dataset.meoBlockHeaderInset;
      return;
    }
    if (!value) { this.clear(); return; }
    const { block, rect } = value;
    Object.assign(this.header.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    const identity = `${block.kind}:${block.from}:${this.view.state.doc.lineAt(block.from).number}:${this.view.state.facet(uiLanguageFacet)}`;
    if (identity !== this.identity || !this.toolbar || !this.widget ||
        (!block.widget.eq(this.widget) && !block.widget.updateDOM(this.toolbar, this.view))) {
      this.previewCleanup(); this.previewOwner = null;
      this.toolbar = block.widget.toDOM(this.view);
      const label = document.createElement('span');
      label.className = 'meo-block-sticky-language';
      label.textContent = block.language;
      this.header.replaceChildren(label, this.toolbar);
      this.identity = identity;
    }
    this.header.classList.toggle('is-quoted', block.quoted);
    this.header.classList.toggle('meo-md-code-block-start',
      block.kind === 'math' || codeNodeAt(this.view, this.view.state.doc.lineAt(block.from).to)?.name === 'FencedCode');
    const label = this.header.firstElementChild!;
    label.className = `meo-code-block-pill meo-block-sticky-language ${block.languageClass}`;
    label.setAttribute('aria-hidden', 'true');
    this.widget = block.widget;
    this.header.dataset.meoBlockFrom = String(block.from);
    this.header.dataset.meoBlockTo = String(block.to);
    this.header.hidden = false;
    this.view.scrollDOM.dataset.meoBlockHeaderInset = String(HEADER_HEIGHT);
    if (this.previewOwner !== value.previewOwner) {
      this.previewCleanup();
      this.previewOwner = value.previewOwner;
      this.previewCleanup = value.previewOwner
        ? mountFloatingRenderedBlockPreviewControls(value.previewOwner, this.toolbar, this.header) : () => undefined;
    }
  }

  private clear(): void {
    this.header.hidden = true;
    delete this.view.scrollDOM.dataset.meoBlockHeaderInset;
    this.previewCleanup(); this.previewCleanup = () => undefined;
    this.previewOwner = null; this.identity = ''; this.toolbar = null; this.widget = null;
    this.header.replaceChildren();
  }

  destroy(): void {
    this.destroyed = true;
    this.view.scrollDOM.removeEventListener('scroll', this.requestMeasure);
    this.contentObserver.disconnect(); this.fullscreenObserver.disconnect();
    this.clear(); this.header.remove();
  }
}

export function blockStickyHeaderExtension() {
  return [ViewPlugin.fromClass(BlockStickyHeader), EditorView.scrollMargins.of((view) => {
    // Reserve space before a reveal mounts the header at a previously offscreen target.
    const block = blockHeaderAt(view, view.state.selection.main.head);
    const reservesTargetHeader = block
      && view.state.doc.lineAt(view.state.selection.main.head).from > block.from
      && view.lineBlockAt(block.to).bottom - view.lineBlockAt(block.from).top >= HEADER_HEIGHT * 3;
    return { top: view.scrollDOM.dataset.meoBlockHeaderInset || reservesTargetHeader ? HEADER_HEIGHT : 0 };
  })];
}
