import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, indentLess, indentMore } from '@codemirror/commands';
import { createCopyCodeButton, createSelectAllCodeButton } from './codeBlockControls';
import { renderLatexMathToHtml } from './math';
import { getViewportController, visualLineContextMargin } from './viewportController';
import { applyLiveBlockIndent, liveBlockIndentKey, type LiveBlockIndentValue } from './blockIndent';
import { consumeEditorHistoryCommand } from './historyCommands';
import { attachLatexMathViewport, type LatexMathViewportController } from './latexMathViewport';
import {
  markLiveInputNestedProjection,
  supersedeLiveInputDerivedWork
} from '../editor/liveInputDerivedWork';
import {
  decideRenderedBlockModeShell,
  type RenderedBlockMode,
  type RenderedBlockModeShellDecision
} from '../editor/renderedBlockModeShell';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';
import type { UiLanguage } from '../../../src/foundation/uiLanguage';
import {
  renderRenderedBlockModeButton,
  retainRenderedBlockModePointerFocus
} from './renderedBlockModeControls';
import { estimateBlockWidgetHeight } from '../editor/blockWidgetHeight';
import {
  createNestedEditorInteractionContinuity,
  type EditorInteractionContinuity
} from '../editor/interactionContinuity';
import { getLiveRenderedBlocks } from './liveRenderedBlocks';
import { shikiDocumentHighlight } from './shikiDecorations';

export type LatexMathBlockMode = RenderedBlockMode;

type LatexMathModeChange = {
  anchor: number;
  mode: LatexMathBlockMode;
};

type LatexMathSearchReveal = {
  from: number;
  to: number;
} | null;

type LatexMathEditingState = {
  modes: Map<number, LatexMathBlockMode>;
  searchReveal: LatexMathSearchReveal;
};

type LatexMathEditingBlock = {
  anchor: number;
  lineNumber: number;
  contentFrom: number;
  contentTo: number;
  sourceText: string;
  indentColumns: LiveBlockIndentValue;
};

export const setLatexMathBlockModeEffect = StateEffect.define<LatexMathModeChange>();
export const setLatexMathSearchRevealEffect = StateEffect.define<LatexMathSearchReveal>();
const setInnerLatexMathSearchRangeEffect = StateEffect.define<LatexMathSearchReveal>();

const innerLatexMathSearchMark = Decoration.mark({
  class: 'meo-search-match meo-search-match-active'
});

const innerLatexMathSearchField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setInnerLatexMathSearchRangeEffect)) {
        next = effect.value
          ? Decoration.set([innerLatexMathSearchMark.range(effect.value.from, effect.value.to)])
          : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

function isLatexMathAnchor(state: EditorState, anchor: number): boolean {
  if (anchor < 0 || anchor > state.doc.length) {
    return false;
  }
  const line = state.doc.lineAt(anchor);
  if (line.from !== anchor) return false;
  return getLiveRenderedBlocks(state, { includeSelectedMath: true }).some((block) => (
    block.kind === 'math' && block.startLine === line.number
  ));
}

function resolveLatexMathAnchorAtLine(state: EditorState, lineNumber: number): number | null {
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > state.doc.lines) {
    return null;
  }
  const anchor = state.doc.line(lineNumber).from;
  return isLatexMathAnchor(state, anchor) ? anchor : null;
}

function resolveLatexMathToolbarAnchor(
  view: EditorView,
  toolbar: HTMLElement,
  fallbackLineNumber: number
): number | null {
  const declaredAnchor = Number.parseInt(toolbar.dataset.meoBlockFrom ?? '', 10);
  if (Number.isFinite(declaredAnchor) && isLatexMathAnchor(view.state, declaredAnchor)) {
    return declaredAnchor;
  }
  try {
    const position = view.posAtDOM(toolbar);
    const line = view.state.doc.lineAt(Math.max(0, Math.min(position, view.state.doc.length)));
    if (isLatexMathAnchor(view.state, line.from)) return line.from;
  } catch {
    // Fall through for a retained toolbar whose DOM position is unavailable.
  }
  return resolveLatexMathAnchorAtLine(view.state, fallbackLineNumber);
}

export const latexMathEditingStateField = StateField.define<LatexMathEditingState>({
  create() {
    return { modes: new Map(), searchReveal: null };
  },
  update(value, transaction) {
    const modes = new Map<number, LatexMathBlockMode>();
    for (const [anchor, mode] of value.modes) {
      const mappedAnchor = transaction.changes.mapPos(anchor, 1);
      if (isLatexMathAnchor(transaction.state, mappedAnchor)) {
        modes.set(mappedAnchor, mode);
      }
    }

    let searchReveal = value.searchReveal;
    if (searchReveal && transaction.docChanged) {
      searchReveal = {
        from: transaction.changes.mapPos(searchReveal.from, 1),
        to: transaction.changes.mapPos(searchReveal.to, -1)
      };
    }

    let searchRevealChanged = false;
    for (const effect of transaction.effects) {
      if (effect.is(setLatexMathBlockModeEffect)) {
        searchReveal = null;
        if (effect.value.mode === 'preview') {
          modes.delete(effect.value.anchor);
        } else {
          modes.set(effect.value.anchor, effect.value.mode);
        }
      } else if (effect.is(setLatexMathSearchRevealEffect)) {
        searchReveal = effect.value;
        searchRevealChanged = true;
      }
    }

    if (searchReveal && transaction.selection && !searchRevealChanged) {
      const selection = transaction.state.selection.main;
      const selectionFrom = Math.min(selection.from, selection.to);
      const selectionTo = Math.max(selection.from, selection.to);
      if (selectionFrom !== searchReveal.from || selectionTo !== searchReveal.to) {
        searchReveal = null;
      }
    }

    return { modes, searchReveal };
  }
});

export function getLatexMathBlockMode(
  state: EditorState,
  anchor: number,
  contentFrom: number,
  contentTo: number
): {
  manual: LatexMathBlockMode;
  decision: RenderedBlockModeShellDecision;
  searchReveal: LatexMathSearchReveal;
} {
  const editingState = state.field(latexMathEditingStateField, false);
  const manual = editingState?.modes.get(anchor) ?? 'preview';
  const searchReveal = editingState?.searchReveal ?? null;
  const searchInside = Boolean(
    searchReveal &&
    searchReveal.from < contentTo &&
    searchReveal.to > contentFrom
  );
  const decision = decideRenderedBlockModeShell({
    kind: 'latex',
    lineNumber: state.doc.lineAt(anchor).number,
    manualMode: manual,
    temporaryReveal: searchInside,
    uiLanguage: state.facet(uiLanguageFacet)
  });
  return {
    manual,
    decision,
    searchReveal: searchInside ? searchReveal : null
  };
}

const latexToolbarSourceText = Symbol('latexToolbarSourceText');
type LatexToolbarElement = HTMLSpanElement & {
  [latexToolbarSourceText]: string;
};

const latexToolbarDomCache = new WeakMap<EditorView, Map<string, LatexToolbarElement>>();
const LATEX_TOOLBAR_DOM_CACHE_LIMIT = 300;

function getLatexToolbarDomCache(view: EditorView): Map<string, LatexToolbarElement> {
  let cache = latexToolbarDomCache.get(view);
  if (!cache) {
    cache = new Map();
    latexToolbarDomCache.set(view, cache);
  }
  return cache;
}

function updateLatexMathModeButton(
  button: HTMLButtonElement,
  mode: LatexMathBlockMode,
  lineNumber: number,
  uiLanguage: UiLanguage
): void {
  const decision = decideRenderedBlockModeShell({
    kind: 'latex',
    lineNumber,
    manualMode: mode,
    temporaryReveal: false,
    uiLanguage
  });
  renderRenderedBlockModeButton(button, decision);
}

function preserveToolbarWhileDispatching(
  view: EditorView,
  toolbar: HTMLElement,
  anchor: number,
  effects: StateEffect<unknown> | readonly StateEffect<unknown>[]
): void {
  const controller = getViewportController(view);
  if (!controller) {
    view.dispatch({ effects });
    return;
  }
  controller.preserveElementPositionWhileMutation(
    toolbar,
    () => view.dom.querySelector<HTMLElement>(
      `.meo-latex-math-toolbar[data-meo-block-from="${anchor}"]`
    ),
    () => view.dispatch({ effects }),
    'immediate'
  );
}

class LatexMathToolbarWidget extends UiLanguageSensitiveWidget {
  constructor(
    readonly anchor: number,
    readonly lineNumber: number,
    readonly mode: LatexMathBlockMode,
    readonly sourceText: string,
    readonly blockTo: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof LatexMathToolbarWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.anchor === this.anchor &&
      other.lineNumber === this.lineNumber &&
      other.mode === this.mode &&
      other.sourceText === this.sourceText &&
      other.blockTo === this.blockTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const uiLanguage = view.state.facet(uiLanguageFacet);
    const cache = getLatexToolbarDomCache(view);
    const cacheKey = `${this.anchor}:${this.lineNumber}:${uiLanguage}`;
    const cachedToolbar = cache.get(cacheKey);
    if (cachedToolbar && this.updateDOM(cachedToolbar, view)) {
      cache.delete(cacheKey);
      cache.set(cacheKey, cachedToolbar);
      return cachedToolbar;
    }
    const decision = decideRenderedBlockModeShell({
      kind: 'latex',
      lineNumber: this.lineNumber,
      manualMode: this.mode,
      temporaryReveal: false,
      uiLanguage
    });
    const toolbar = document.createElement('span') as LatexToolbarElement;
    toolbar.className = 'meo-latex-math-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', decision.controlsLabel);
    toolbar.dataset.meoBlockFrom = String(this.anchor);
    toolbar.dataset.meoBlockTo = String(this.blockTo);
    toolbar.dataset.meoLatexMathMode = this.mode;
    toolbar.dataset.meoUiLanguage = uiLanguage;
    toolbar[latexToolbarSourceText] = this.sourceText;
    toolbar.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    });

    const modeButton = document.createElement('button');
    modeButton.type = 'button';
    modeButton.className = 'meo-latex-math-mode-btn';
    retainRenderedBlockModePointerFocus(modeButton);
    updateLatexMathModeButton(modeButton, this.mode, this.lineNumber, uiLanguage);
    modeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentAnchor = resolveLatexMathToolbarAnchor(view, toolbar, this.lineNumber);
      if (currentAnchor === null) return;
      const currentMode = toolbar.dataset.meoLatexMathMode as LatexMathBlockMode;
      const nextMode = decideRenderedBlockModeShell({
        kind: 'latex',
        lineNumber: this.lineNumber,
        manualMode: currentMode,
        temporaryReveal: false,
        uiLanguage
      }).nextManualMode;
      const isRevealCurrent = getViewportController(view)?.beginNavigationReveal() ?? (() => true);
      preserveToolbarWhileDispatching(
        view,
        toolbar,
        currentAnchor,
        [
          supersedeLiveInputDerivedWork(),
          setLatexMathBlockModeEffect.of({ anchor: currentAnchor, mode: nextMode })
        ]
      );
      requestAnimationFrame(() => {
        if (!isRevealCurrent()) return;
        if (nextMode === 'preview') {
          const currentModeButton = view.dom.querySelector<HTMLButtonElement>(
            `.meo-latex-math-toolbar[data-meo-block-from="${currentAnchor}"] .meo-latex-math-mode-btn`
          );
          currentModeButton?.focus({ preventScroll: true });
          return;
        }
        const editingBlock = view.dom.querySelector<HTMLElement>(
          `.meo-latex-math-editing-block[data-meo-latex-math-anchor="${currentAnchor}"]`
        );
        (editingBlock as LatexMathEditingBlockElement | null)?.__meoLatexMathEditingController?.focus();
      });
    });

    const selectAllButton = createSelectAllCodeButton(() => {
      const currentAnchor = resolveLatexMathToolbarAnchor(view, toolbar, this.lineNumber);
      if (currentAnchor === null) return;
      const isRevealCurrent = getViewportController(view)?.beginNavigationReveal() ?? (() => true);
      const scrollTop = view.scrollDOM.scrollTop;
      preserveToolbarWhileDispatching(
        view,
        toolbar,
        currentAnchor,
        [
          supersedeLiveInputDerivedWork(),
          setLatexMathBlockModeEffect.of({ anchor: currentAnchor, mode: 'source' })
        ]
      );
      requestAnimationFrame(() => {
        if (!isRevealCurrent()) return;
        const editingBlock = view.dom.querySelector<HTMLElement>(
          `.meo-latex-math-editing-block[data-meo-latex-math-anchor="${currentAnchor}"]`
        );
        (editingBlock as LatexMathEditingBlockElement | null)?.__meoLatexMathEditingController?.selectAll();
        getViewportController(view)?.lockScrollTop(scrollTop, isRevealCurrent);
      });
    }, uiLanguage);

    toolbar.append(
      modeButton,
      selectAllButton,
      createCopyCodeButton(() => toolbar[latexToolbarSourceText] ?? '', uiLanguage)
    );
    cache.set(cacheKey, toolbar);
    if (cache.size > LATEX_TOOLBAR_DOM_CACHE_LIMIT) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    return toolbar;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const toolbar = dom as LatexToolbarElement;
    const uiLanguage = view.state.facet(uiLanguageFacet);
    if (
      !toolbar.classList.contains('meo-latex-math-toolbar') ||
      toolbar.dataset.meoBlockFrom !== String(this.anchor) ||
      toolbar.dataset.meoUiLanguage !== uiLanguage
    ) return false;
    const modeButton = toolbar.querySelector<HTMLButtonElement>('.meo-latex-math-mode-btn');
    if (!modeButton) return false;
    // Equal-length edits can change line identity without changing the anchor.
    toolbar.setAttribute('aria-label', decideRenderedBlockModeShell({
      kind: 'latex', lineNumber: this.lineNumber, manualMode: this.mode,
      temporaryReveal: false, uiLanguage
    }).controlsLabel);
    toolbar.dataset.meoLatexMathMode = this.mode;
    toolbar.dataset.meoBlockTo = String(this.blockTo);
    toolbar[latexToolbarSourceText] = this.sourceText;
    updateLatexMathModeButton(
      modeButton,
      this.mode,
      this.lineNumber,
      uiLanguage
    );
    return true;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function addLatexMathToolbar(
  builder: any[],
  position: number,
  anchor: number,
  lineNumber: number,
  mode: LatexMathBlockMode,
  sourceText: string,
  blockTo: number,
  side = 1
): void {
  builder.push(
    Decoration.widget({
      widget: createLatexMathToolbarWidget(anchor, lineNumber, mode, sourceText, blockTo),
      side
    }).range(position)
  );
}

export function createLatexMathToolbarWidget(
  anchor: number,
  lineNumber: number,
  mode: LatexMathBlockMode,
  sourceText: string,
  blockTo: number
): WidgetType {
  return new LatexMathToolbarWidget(anchor, lineNumber, mode, sourceText, blockTo);
}

type LatexMathEditingBlockElement = HTMLElement & {
  __meoLatexMathEditingController?: LatexMathEditingController;
};

export function focusLatexMathEditingOffset(
  view: EditorView,
  anchor: number,
  offset: number,
  isCurrent: () => boolean = () => true
): boolean {
  if (!isCurrent()) return false;
  const editingBlock = view.dom.querySelector<HTMLElement>(
    `.meo-latex-math-editing-block[data-meo-latex-math-anchor="${anchor}"]`
  ) as LatexMathEditingBlockElement | null;
  if (!editingBlock?.__meoLatexMathEditingController) {
    return false;
  }
  return editingBlock.__meoLatexMathEditingController.focusOffset(offset, isCurrent);
}

class LatexMathEditingController {
  private outerView: EditorView;
  private block: LatexMathEditingBlock;
  private mode: Exclude<LatexMathBlockMode, 'preview'>;
  private root: LatexMathEditingBlockElement;
  private sourceHost: HTMLElement;
  private innerView: EditorView;
  private previewShell: HTMLElement | null = null;
  private previewHost: HTMLElement | null = null;
  private previewViewport: LatexMathViewportController | null = null;
  private syncingFromOuter = false;
  private innerInteractionContinuity: EditorInteractionContinuity | null = null;

  constructor(
    outerView: EditorView,
    block: LatexMathEditingBlock,
    mode: Exclude<LatexMathBlockMode, 'preview'>,
    searchReveal: LatexMathSearchReveal
  ) {
    this.outerView = outerView;
    this.block = block;
    this.mode = mode;
    this.root = document.createElement('div') as LatexMathEditingBlockElement;
    this.root.className = 'meo-latex-math-editing-block meo-rendered-block-mode-shell';
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', decideRenderedBlockModeShell({
      kind: 'latex',
      lineNumber: block.lineNumber,
      manualMode: mode,
      temporaryReveal: false,
      uiLanguage: outerView.state.facet(uiLanguageFacet)
    }).editorLabel);
    this.root.dataset.meoLatexMathAnchor = String(block.anchor);

    const sourcePane = document.createElement('div');
    sourcePane.className = 'meo-latex-math-source-pane meo-rendered-block-source-pane';
    const sourceSticky = document.createElement('div');
    sourceSticky.className = 'meo-latex-math-source-sticky';
    this.sourceHost = document.createElement('div');
    this.sourceHost.className = 'meo-latex-math-source-editor';
    sourceSticky.appendChild(this.sourceHost);
    sourcePane.appendChild(sourceSticky);
    this.root.appendChild(sourcePane);

    this.innerView = new EditorView({
      state: EditorState.create({
        doc: block.sourceText,
        extensions: [
          lineNumbers(),
          shikiDocumentHighlight('latex'),
          innerLatexMathSearchField,
          EditorView.lineWrapping,
          keymap.of([
            { key: 'Mod-z', run: () => consumeEditorHistoryCommand(this.outerView, 'undo') },
            { key: 'Mod-y', run: () => consumeEditorHistoryCommand(this.outerView, 'redo') },
            { key: 'Mod-Shift-z', run: () => consumeEditorHistoryCommand(this.outerView, 'redo') },
            { key: 'Tab', run: indentMore, shift: indentLess },
            ...defaultKeymap
          ]),
          EditorView.updateListener.of((update) => {
            this.innerInteractionContinuity?.observe(update);
            if (!update.docChanged || this.syncingFromOuter) {
              return;
            }
            const sourceText = update.state.doc.toString();
            const { contentFrom, contentTo } = this.block;
            if (this.outerView.state.doc.sliceString(contentFrom, contentTo) === sourceText) {
              return;
            }
            const userEvent = update.transactions.reduce<string | undefined>(
              (current, transaction) => transaction.annotation(Transaction.userEvent) ?? current,
              undefined
            ) ?? 'input';
            this.block = { ...this.block, contentTo: contentFrom + sourceText.length, sourceText };
            this.outerView.dispatch({
              changes: { from: contentFrom, to: contentTo, insert: sourceText },
              annotations: [
                Transaction.userEvent.of(userEvent),
                markLiveInputNestedProjection()
              ]
            });
            this.renderPreview();
          })
        ]
      }),
      parent: this.sourceHost
    });

    this.innerInteractionContinuity = createNestedEditorInteractionContinuity({
      view: this.innerView,
      isActive: () => this.root.isConnected,
      interactionTarget: this.outerView.scrollDOM,
      viewport: {
        readBounds: () => this.outerView.scrollDOM.getBoundingClientRect(),
        revealCaret: (caret, isCurrent) => {
          if (!isCurrent()) return;
          const bounds = this.outerView.scrollDOM.getBoundingClientRect();
          const margin = visualLineContextMargin(this.outerView, 1);
          const top = caret.top < bounds.top
            ? caret.top - bounds.top - margin
            : caret.bottom > bounds.bottom
              ? caret.bottom - bounds.bottom + margin
              : 0;
          if (top !== 0) getViewportController(this.outerView)?.navigateBy({ top });
        }
      }
    });

    this.setMode(mode, true);
    this.setSearchReveal(searchReveal);
    this.root.__meoLatexMathEditingController = this;
  }

  get dom(): HTMLElement {
    return this.root;
  }

  focus(): void {
    this.innerView.focus();
  }

  selectAll(): void {
    this.innerView.dispatch({
      selection: { anchor: 0, head: this.innerView.state.doc.length }
    });
    this.innerView.focus();
  }

  focusOffset(offset: number, isCurrent: () => boolean = () => true): boolean {
    if (!isCurrent()) return false;
    const position = Math.max(0, Math.min(offset, this.innerView.state.doc.length));
    this.innerView.dispatch({
      selection: { anchor: position },
      scrollIntoView: true
    });
    if (!isCurrent()) return false;
    this.innerView.focus();
    if (!isCurrent()) return false;
    // Measure after the outer replacement settles so a temporary caret offset
    // cannot start a competing history navigation.
    const isNavigationCurrent = getViewportController(this.outerView)?.captureNavigationCurrentness() ?? (() => true);
    requestAnimationFrame(() => {
      if (!isCurrent() || !isNavigationCurrent() || !this.root.isConnected) return;
      this.innerView.requestMeasure({
        read: (innerView) => {
          if (!isCurrent() || !isNavigationCurrent()) return null;
          const coords = innerView.coordsAtPos(position);
          const viewport = this.outerView.scrollDOM.getBoundingClientRect();
          if (!coords || (coords.top >= viewport.top && coords.bottom <= viewport.bottom)) {
            return null;
          }
          return coords.top - viewport.top - viewport.height * 0.3;
        },
        write: (delta) => {
          if (isCurrent() && isNavigationCurrent() && delta !== null) {
            getViewportController(this.outerView)?.navigateBy({ top: delta });
          }
        }
      });
    });
    return true;
  }

  update(
    outerView: EditorView,
    block: LatexMathEditingBlock,
    mode: Exclude<LatexMathBlockMode, 'preview'>,
    searchReveal: LatexMathSearchReveal
  ): boolean {
    if (block.anchor !== this.block.anchor) {
      return false;
    }
    this.outerView = outerView;
    this.block = block;
    const currentText = this.innerView.state.doc.toString();
    if (currentText !== block.sourceText) {
      this.syncingFromOuter = true;
      this.innerView.dispatch({
        changes: { from: 0, to: currentText.length, insert: block.sourceText }
      });
      this.syncingFromOuter = false;
    }
    this.setMode(mode, false);
    this.setSearchReveal(searchReveal);
    if (mode === 'split') {
      this.renderPreview();
    }
    return true;
  }

  private setMode(mode: Exclude<LatexMathBlockMode, 'preview'>, initial: boolean): void {
    if (!initial && mode === this.mode) {
      return;
    }
    this.mode = mode;
    const decision = decideRenderedBlockModeShell({
      kind: 'latex',
      lineNumber: this.block.lineNumber,
      manualMode: mode,
      temporaryReveal: false,
      uiLanguage: this.outerView.state.facet(uiLanguageFacet)
    });
    this.root.className = `meo-latex-math-editing-block meo-rendered-block-mode-shell ${decision.modeClass}`;
    this.root.dataset.meoRenderedBlockMode = decision.effectiveMode;
    this.root.dataset.meoRenderedBlockLayout = decision.wideLayout;
    if (decision.previewLifecycle === 'deferred') {
      if (!this.previewShell) {
        this.previewShell = document.createElement('div');
        this.previewShell.className = 'meo-latex-math-preview-shell meo-rendered-block-preview-pane';
        this.previewHost = document.createElement('div');
        this.previewHost.className = 'meo-latex-math-preview-sticky';
        this.previewShell.appendChild(this.previewHost);
        this.root.appendChild(this.previewShell);
      }
      this.renderPreview();
    } else if (decision.previewLifecycle === 'destroyed' && this.previewShell) {
      this.previewViewport?.destroy();
      this.previewViewport = null;
      this.previewShell.remove();
      this.previewShell = null;
      this.previewHost = null;
    }
  }

  private setSearchReveal(searchReveal: LatexMathSearchReveal): void {
    if (!searchReveal) {
      this.innerView.dispatch({ effects: setInnerLatexMathSearchRangeEffect.of(null) });
      return;
    }
    const anchor = Math.max(0, Math.min(
      this.innerView.state.doc.length,
      searchReveal.from - this.block.contentFrom
    ));
    const head = Math.max(anchor, Math.min(
      this.innerView.state.doc.length,
      searchReveal.to - this.block.contentFrom
    ));
    const selection = this.innerView.state.selection.main;
    this.innerView.dispatch({
      selection: selection.anchor !== anchor || selection.head !== head ? { anchor, head } : undefined,
      effects: setInnerLatexMathSearchRangeEffect.of({ from: anchor, to: head })
    });
  }

  private renderPreview(): void {
    if (this.mode !== 'split' || !this.previewHost) {
      return;
    }
    const preview = document.createElement('div');
    preview.className = 'meo-md-math meo-md-math-display meo-md-math-fenced-display';
    preview.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button === 0) {
        event.preventDefault();
      }
    });
    const html = renderLatexMathToHtml(this.block.sourceText, 'display');
    if (html) {
      preview.innerHTML = html;
    } else {
      preview.classList.add('meo-latex-math-preview-error');
      preview.textContent = this.block.sourceText;
    }
    this.previewViewport?.destroy();
    this.previewHost.replaceChildren(preview);
    this.previewViewport = html
      ? attachLatexMathViewport(preview, {
          interactive: true,
          uiLanguage: this.outerView.state.facet(uiLanguageFacet)
        })
      : null;
  }

  destroy(): void {
    this.innerInteractionContinuity?.dispose();
    this.innerInteractionContinuity = null;
    this.previewViewport?.destroy();
    this.previewViewport = null;
    this.innerView.destroy();
    delete this.root.__meoLatexMathEditingController;
  }
}

export class LatexMathEditingWidget extends UiLanguageSensitiveWidget {
  constructor(
    readonly block: LatexMathEditingBlock,
    readonly mode: Exclude<LatexMathBlockMode, 'preview'>,
    readonly searchReveal: LatexMathSearchReveal
  ) {
    super();
  }

  get estimatedHeight(): number {
    return estimateBlockWidgetHeight({
      kind: 'rendered-block-editor',
      renderer: 'latex',
      mode: this.mode,
      source: this.block.sourceText
    });
  }

  eq(other: WidgetType): boolean {
    return other instanceof LatexMathEditingWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.block.anchor === this.block.anchor &&
      other.block.lineNumber === this.block.lineNumber &&
      other.block.sourceText === this.block.sourceText &&
      liveBlockIndentKey(other.block.indentColumns) === liveBlockIndentKey(this.block.indentColumns) &&
      other.mode === this.mode &&
      other.searchReveal?.from === this.searchReveal?.from &&
      other.searchReveal?.to === this.searchReveal?.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = new LatexMathEditingController(view, this.block, this.mode, this.searchReveal).dom;
    applyLiveBlockIndent(dom, this.block.indentColumns);
    return dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const controller = (dom as LatexMathEditingBlockElement).__meoLatexMathEditingController;
    const updated = controller?.update(view, this.block, this.mode, this.searchReveal) ?? false;
    if (updated) {
      dom.setAttribute('aria-label', decideRenderedBlockModeShell({
        kind: 'latex',
        lineNumber: this.block.lineNumber,
        manualMode: this.mode,
        temporaryReveal: false,
        uiLanguage: view.state.facet(uiLanguageFacet)
      }).editorLabel);
      applyLiveBlockIndent(dom, this.block.indentColumns);
    }
    return updated;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    (dom as LatexMathEditingBlockElement).__meoLatexMathEditingController?.destroy();
  }
}
