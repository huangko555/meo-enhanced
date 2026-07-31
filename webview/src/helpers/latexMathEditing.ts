import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, indentLess, indentMore, redo, undo } from '@codemirror/commands';
import { createElement, Code2, Eye, Pencil } from 'lucide';
import { createCopyCodeButton, createSelectAllCodeButton } from './codeBlockControls';
import { renderLatexMathToHtml } from './math';
import { getViewportController } from './viewportController';
import { applyLiveBlockIndent } from './blockIndent';
import { attachLatexMathViewport, type LatexMathViewportController } from './latexMathViewport';

export type LatexMathBlockMode = 'preview' | 'split' | 'source';

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
  contentFrom: number;
  contentTo: number;
  sourceText: string;
  indentColumns: number;
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

const latexMathOpeningLineRegex = /^[ \t]*\$\$\s*$/;

function isLatexMathAnchor(state: EditorState, anchor: number): boolean {
  if (anchor < 0 || anchor > state.doc.length) {
    return false;
  }
  const line = state.doc.lineAt(anchor);
  return line.from === anchor && latexMathOpeningLineRegex.test(line.text);
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
): { effective: LatexMathBlockMode; searchReveal: LatexMathSearchReveal } {
  const editingState = state.field(latexMathEditingStateField, false);
  const manual = editingState?.modes.get(anchor) ?? 'preview';
  const searchReveal = editingState?.searchReveal ?? null;
  const searchInside = Boolean(
    searchReveal &&
    searchReveal.from < contentTo &&
    searchReveal.to > contentFrom
  );
  return {
    effective: manual === 'preview' && searchInside ? 'split' : manual,
    searchReveal: searchInside ? searchReveal : null
  };
}

function nextLatexMathMode(mode: LatexMathBlockMode): LatexMathBlockMode {
  if (mode === 'preview') return 'split';
  if (mode === 'split') return 'source';
  return 'preview';
}

function preserveAnchorWhileDispatching(view: EditorView, anchor: number, effect: StateEffect<unknown>): void {
  const controller = getViewportController(view);
  if (!controller) {
    view.dispatch({ effects: effect });
    return;
  }
  controller.preservePositionWhileMutation(anchor, () => view.dispatch({ effects: effect }));
}

class LatexMathToolbarWidget extends WidgetType {
  constructor(
    readonly anchor: number,
    readonly mode: LatexMathBlockMode,
    readonly sourceText: string,
    readonly blockTo: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof LatexMathToolbarWidget &&
      other.anchor === this.anchor &&
      other.mode === this.mode &&
      other.sourceText === this.sourceText &&
      other.blockTo === this.blockTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const toolbar = document.createElement('span');
    toolbar.className = 'meo-latex-math-toolbar';
    toolbar.dataset.meoBlockFrom = String(this.anchor);
    toolbar.dataset.meoBlockTo = String(this.blockTo);

    const modeButton = document.createElement('button');
    modeButton.type = 'button';
    modeButton.className = 'meo-latex-math-mode-btn';
    const nextMode = nextLatexMathMode(this.mode);
    const modeConfig = this.mode === 'preview'
      ? { icon: Pencil, label: 'Edit formula in split view' }
      : this.mode === 'split'
        ? { icon: Code2, label: 'Show formula source only' }
        : { icon: Eye, label: 'Show formula preview' };
    modeButton.appendChild(createElement(modeConfig.icon, { width: 15, height: 15 }));
    modeButton.setAttribute('aria-label', modeConfig.label);
    modeButton.title = modeConfig.label;
    modeButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      preserveAnchorWhileDispatching(
        view,
        this.anchor,
        setLatexMathBlockModeEffect.of({ anchor: this.anchor, mode: nextMode })
      );
      requestAnimationFrame(() => {
        if (nextMode === 'preview') {
          view.focus();
          return;
        }
        const editingBlock = view.dom.querySelector<HTMLElement>(
          `.meo-latex-math-editing-block[data-meo-latex-math-anchor="${this.anchor}"]`
        );
        (editingBlock as LatexMathEditingBlockElement | null)?.__meoLatexMathEditingController?.focus();
      });
    });

    const selectAllButton = createSelectAllCodeButton(() => {
      preserveAnchorWhileDispatching(
        view,
        this.anchor,
        setLatexMathBlockModeEffect.of({ anchor: this.anchor, mode: 'source' })
      );
      requestAnimationFrame(() => {
        const editingBlock = view.dom.querySelector<HTMLElement>(
          `.meo-latex-math-editing-block[data-meo-latex-math-anchor="${this.anchor}"]`
        );
        (editingBlock as LatexMathEditingBlockElement | null)?.__meoLatexMathEditingController?.selectAll();
      });
    });

    toolbar.append(modeButton, selectAllButton, createCopyCodeButton(this.sourceText));
    return toolbar;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function addLatexMathToolbar(
  builder: any[],
  lineEnd: number,
  anchor: number,
  mode: LatexMathBlockMode,
  sourceText: string,
  blockTo: number
): void {
  builder.push(
    Decoration.widget({
      widget: new LatexMathToolbarWidget(anchor, mode, sourceText, blockTo),
      side: 1
    }).range(lineEnd)
  );
}

type LatexMathEditingBlockElement = HTMLElement & {
  __meoLatexMathEditingController?: LatexMathEditingController;
};

export function focusLatexMathEditingOffset(view: EditorView, anchor: number, offset: number): boolean {
  const editingBlock = view.dom.querySelector<HTMLElement>(
    `.meo-latex-math-editing-block[data-meo-latex-math-anchor="${anchor}"]`
  ) as LatexMathEditingBlockElement | null;
  if (!editingBlock?.__meoLatexMathEditingController) {
    return false;
  }
  editingBlock.__meoLatexMathEditingController.focusOffset(offset);
  return true;
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
  private previewTimer: number | null = null;
  private syncingFromOuter = false;

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
    this.root.className = 'meo-latex-math-editing-block';
    this.root.dataset.meoLatexMathAnchor = String(block.anchor);

    const sourcePane = document.createElement('div');
    sourcePane.className = 'meo-latex-math-source-pane';
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
          innerLatexMathSearchField,
          EditorView.lineWrapping,
          keymap.of([
            { key: 'Mod-z', run: () => undo(this.outerView) },
            { key: 'Mod-y', run: () => redo(this.outerView) },
            { key: 'Mod-Shift-z', run: () => redo(this.outerView) },
            { key: 'Tab', run: indentMore, shift: indentLess },
            ...defaultKeymap
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged || this.syncingFromOuter) {
              return;
            }
            const sourceText = update.state.doc.toString();
            const { contentFrom, contentTo } = this.block;
            if (this.outerView.state.doc.sliceString(contentFrom, contentTo) === sourceText) {
              return;
            }
            this.block = { ...this.block, contentTo: contentFrom + sourceText.length, sourceText };
            this.outerView.dispatch({
              changes: { from: contentFrom, to: contentTo, insert: sourceText },
              annotations: Transaction.userEvent.of('input')
            });
            this.schedulePreviewRender();
          })
        ]
      }),
      parent: this.sourceHost
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

  focusOffset(offset: number): void {
    const position = Math.max(0, Math.min(offset, this.innerView.state.doc.length));
    this.innerView.dispatch({
      selection: { anchor: position },
      scrollIntoView: true
    });
    this.innerView.focus();
    this.innerView.requestMeasure({
      read: (innerView) => {
        const coords = innerView.coordsAtPos(position);
        const viewport = this.outerView.scrollDOM.getBoundingClientRect();
        if (!coords || (coords.top >= viewport.top && coords.bottom <= viewport.bottom)) {
          return null;
        }
        return coords.top - viewport.top - viewport.height * 0.3;
      },
      write: (delta) => {
        if (delta !== null) {
          getViewportController(this.outerView)?.navigateBy({ top: delta });
        }
      }
    });
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
      this.schedulePreviewRender();
    }
    return true;
  }

  private setMode(mode: Exclude<LatexMathBlockMode, 'preview'>, initial: boolean): void {
    if (!initial && mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.root.classList.toggle('is-split', mode === 'split');
    this.root.classList.toggle('is-source', mode === 'source');
    if (mode === 'split') {
      if (!this.previewShell) {
        this.previewShell = document.createElement('div');
        this.previewShell.className = 'meo-latex-math-preview-shell';
        this.previewHost = document.createElement('div');
        this.previewHost.className = 'meo-latex-math-preview-sticky';
        this.previewShell.appendChild(this.previewHost);
        this.root.appendChild(this.previewShell);
      }
      this.renderPreview();
    } else if (this.previewShell) {
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

  private schedulePreviewRender(): void {
    if (this.mode !== 'split') {
      return;
    }
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.renderPreview();
    }, 100);
  }

  private renderPreview(): void {
    if (!this.previewHost) {
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
      ? attachLatexMathViewport(preview, { interactive: true })
      : null;
  }

  destroy(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
    }
    this.previewViewport?.destroy();
    this.previewViewport = null;
    this.innerView.destroy();
    delete this.root.__meoLatexMathEditingController;
  }
}

export class LatexMathEditingWidget extends WidgetType {
  constructor(
    readonly block: LatexMathEditingBlock,
    readonly mode: Exclude<LatexMathBlockMode, 'preview'>,
    readonly searchReveal: LatexMathSearchReveal
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof LatexMathEditingWidget &&
      other.block.anchor === this.block.anchor &&
      other.block.sourceText === this.block.sourceText &&
      other.block.indentColumns === this.block.indentColumns &&
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
