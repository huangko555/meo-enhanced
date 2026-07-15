import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, indentLess, indentMore, redo, undo } from '@codemirror/commands';
import { createElement, Code2, Eye, Pencil } from 'lucide';
import { getCachedMermaidPreviewHeight, MermaidDiagramWidget } from './mermaidDiagram';
import { createCopyCodeButton, createSelectAllCodeButton } from './codeBlockControls';
import { getViewportController } from './viewportController';

export type MermaidBlockMode = 'preview' | 'split' | 'source';

type MermaidModeChange = {
  anchor: number;
  mode: MermaidBlockMode;
};

type MermaidSearchReveal = {
  from: number;
  to: number;
} | null;

type MermaidEditingState = {
  modes: Map<number, MermaidBlockMode>;
  searchReveal: MermaidSearchReveal;
};

type MermaidEditingBlock = {
  anchor: number;
  contentFrom: number;
  contentTo: number;
  diagramText: string;
  startLine: number;
  endLine: number;
};

export const setMermaidBlockModeEffect = StateEffect.define<MermaidModeChange>();
export const setMermaidSearchRevealEffect = StateEffect.define<MermaidSearchReveal>();
const setInnerMermaidSearchRangeEffect = StateEffect.define<MermaidSearchReveal>();

const innerMermaidSearchMark = Decoration.mark({
  class: 'meo-search-match meo-search-match-active'
});

const innerMermaidSearchField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(decorations, transaction) {
    let next = decorations.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (effect.is(setInnerMermaidSearchRangeEffect)) {
        next = effect.value
          ? Decoration.set([innerMermaidSearchMark.range(effect.value.from, effect.value.to)])
          : Decoration.none;
      }
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const mermaidOpeningLineRegex = /^[ \t]{0,3}(?:`{3,}|~{3,})\s*mermaid\b|^[ \t]{0,3}:{3,}\s*mermaid\s*$/i;

function isMermaidAnchor(state: EditorState, anchor: number): boolean {
  if (anchor < 0 || anchor > state.doc.length) {
    return false;
  }
  const line = state.doc.lineAt(anchor);
  return line.from === anchor && mermaidOpeningLineRegex.test(line.text);
}

export const mermaidEditingStateField = StateField.define<MermaidEditingState>({
  create() {
    return { modes: new Map(), searchReveal: null };
  },
  update(value, transaction) {
    const modes = new Map<number, MermaidBlockMode>();
    for (const [anchor, mode] of value.modes) {
      const mappedAnchor = transaction.changes.mapPos(anchor, 1);
      if (isMermaidAnchor(transaction.state, mappedAnchor)) {
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
      if (effect.is(setMermaidBlockModeEffect)) {
        searchReveal = null;
        if (effect.value.mode === 'preview') {
          modes.delete(effect.value.anchor);
        } else {
          modes.set(effect.value.anchor, effect.value.mode);
        }
      } else if (effect.is(setMermaidSearchRevealEffect)) {
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

export function getMermaidBlockMode(
  state: EditorState,
  anchor: number,
  contentFrom: number,
  contentTo: number
): { manual: MermaidBlockMode; effective: MermaidBlockMode; searchReveal: MermaidSearchReveal } {
  const editingState = state.field(mermaidEditingStateField, false);
  const manual = editingState?.modes.get(anchor) ?? 'preview';
  const searchReveal = editingState?.searchReveal ?? null;
  const searchInside = Boolean(
    searchReveal &&
    searchReveal.from < contentTo &&
    searchReveal.to > contentFrom
  );
  return {
    manual,
    effective: manual === 'preview' && searchInside ? 'split' : manual,
    searchReveal: searchInside ? searchReveal : null
  };
}

function nextMermaidMode(mode: MermaidBlockMode): MermaidBlockMode {
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

class MermaidToolbarWidget extends WidgetType {
  constructor(
    readonly anchor: number,
    readonly mode: MermaidBlockMode,
    readonly codeContent: string
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof MermaidToolbarWidget &&
      other.anchor === this.anchor &&
      other.mode === this.mode &&
      other.codeContent === this.codeContent;
  }

  toDOM(view: EditorView): HTMLElement {
    const toolbar = document.createElement('span');
    toolbar.className = 'meo-mermaid-toolbar';

    const modeButton = document.createElement('button');
    modeButton.type = 'button';
    modeButton.className = 'meo-mermaid-mode-btn';
    const nextMode = nextMermaidMode(this.mode);
    const modeConfig = this.mode === 'preview'
      ? { icon: Pencil, label: 'Edit Mermaid in split view' }
      : this.mode === 'split'
        ? { icon: Code2, label: 'Show Mermaid code only' }
        : { icon: Eye, label: 'Show Mermaid preview' };
    modeButton.appendChild(createElement(modeConfig.icon, { width: 15, height: 15 }));
    modeButton.setAttribute('aria-label', modeConfig.label);
    modeButton.title = modeConfig.label;

    const changeMode = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      preserveAnchorWhileDispatching(
        view,
        this.anchor,
        setMermaidBlockModeEffect.of({ anchor: this.anchor, mode: nextMode })
      );
      requestAnimationFrame(() => {
        if (nextMode === 'preview') {
          view.focus();
          return;
        }
        const editingBlock = view.dom.querySelector<HTMLElement>(
          `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${this.anchor}"]`
        );
        (editingBlock as MermaidEditingBlockElement | null)?.__meoMermaidEditingController?.focus();
      });
    };
    modeButton.addEventListener('click', changeMode);

    const selectAllButton = createSelectAllCodeButton(() => {
      preserveAnchorWhileDispatching(
        view,
        this.anchor,
        setMermaidBlockModeEffect.of({ anchor: this.anchor, mode: 'source' })
      );
      requestAnimationFrame(() => {
        const editingBlock = view.dom.querySelector<HTMLElement>(
          `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${this.anchor}"]`
        );
        (editingBlock as MermaidEditingBlockElement | null)?.__meoMermaidEditingController?.selectAll();
      });
    });
    const copyButton = createCopyCodeButton(this.codeContent);

    toolbar.append(modeButton, selectAllButton, copyButton);
    return toolbar;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

export function addMermaidToolbar(
  builder: any[],
  lineEnd: number,
  anchor: number,
  mode: MermaidBlockMode,
  codeContent: string
): void {
  builder.push(
    Decoration.widget({
      widget: new MermaidToolbarWidget(anchor, mode, codeContent),
      side: 1
    }).range(lineEnd)
  );
}

type MermaidEditingBlockElement = HTMLElement & {
  __meoMermaidEditingController?: MermaidEditingController;
};

export function focusMermaidEditingOffset(view: EditorView, anchor: number, offset: number): boolean {
  const editingBlock = view.dom.querySelector<HTMLElement>(
    `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${anchor}"]`
  ) as MermaidEditingBlockElement | null;
  if (!editingBlock?.__meoMermaidEditingController) {
    return false;
  }
  editingBlock.__meoMermaidEditingController.focusOffset(offset);
  return true;
}

class MermaidEditingController {
  private outerView: EditorView;
  private block: MermaidEditingBlock;
  private mode: Exclude<MermaidBlockMode, 'preview'>;
  private root: MermaidEditingBlockElement;
  private sourcePane: HTMLElement;
  private sourceSticky: HTMLElement;
  private sourceHost: HTMLElement;
  private innerView: EditorView;
  private previewShell: HTMLElement | null = null;
  private previewSticky: HTMLElement | null = null;
  private previewWidget: MermaidDiagramWidget | null = null;
  private previewTimer: number | null = null;
  private syncingFromOuter = false;

  constructor(
    outerView: EditorView,
    block: MermaidEditingBlock,
    mode: Exclude<MermaidBlockMode, 'preview'>,
    searchReveal: MermaidSearchReveal
  ) {
    this.outerView = outerView;
    this.block = block;
    this.mode = mode;
    this.root = document.createElement('div') as MermaidEditingBlockElement;
    this.root.className = 'meo-mermaid-editing-block';
    this.root.dataset.meoMermaidAnchor = String(block.anchor);
    this.sourcePane = document.createElement('div');
    this.sourcePane.className = 'meo-mermaid-source-pane';
    this.sourceSticky = document.createElement('div');
    this.sourceSticky.className = 'meo-mermaid-source-sticky';
    this.sourceHost = document.createElement('div');
    this.sourceHost.className = 'meo-mermaid-source-editor';
    this.sourceSticky.appendChild(this.sourceHost);
    this.sourcePane.appendChild(this.sourceSticky);
    this.root.appendChild(this.sourcePane);

    this.innerView = new EditorView({
      state: EditorState.create({
        doc: block.diagramText,
        extensions: [
          lineNumbers(),
          innerMermaidSearchField,
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
            const nextText = update.state.doc.toString();
            const { contentFrom, contentTo } = this.block;
            if (this.outerView.state.doc.sliceString(contentFrom, contentTo) === nextText) {
              return;
            }
            this.block = {
              ...this.block,
              contentTo: contentFrom + nextText.length,
              diagramText: nextText
            };
            this.outerView.dispatch({
              changes: { from: contentFrom, to: contentTo, insert: nextText },
              annotations: Transaction.userEvent.of('input')
            });
          })
        ]
      }),
      parent: this.sourceHost
    });

    this.setMode(mode, true);
    this.setSearchReveal(searchReveal);
    this.root.__meoMermaidEditingController = this;
  }

  get dom(): HTMLElement {
    return this.root;
  }

  focus(): void {
    this.innerView.focus();
  }

  selectAll(): void {
    this.innerView.dispatch({
      selection: { anchor: 0, head: this.innerView.state.doc.length },
      scrollIntoView: true
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
    block: MermaidEditingBlock,
    mode: Exclude<MermaidBlockMode, 'preview'>,
    searchReveal: MermaidSearchReveal
  ): boolean {
    if (block.anchor !== this.block.anchor) {
      return false;
    }
    this.outerView = outerView;
    this.block = block;
    const currentText = this.innerView.state.doc.toString();
    if (currentText !== block.diagramText) {
      this.syncingFromOuter = true;
      this.innerView.dispatch({
        changes: { from: 0, to: currentText.length, insert: block.diagramText }
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

  private setMode(mode: Exclude<MermaidBlockMode, 'preview'>, initial: boolean): void {
    if (!initial && mode === this.mode) {
      return;
    }
    this.mode = mode;
    this.root.classList.toggle('is-split', mode === 'split');
    this.root.classList.toggle('is-source', mode === 'source');
    if (mode === 'split') {
      const preferredHeight = getCachedMermaidPreviewHeight(
        this.outerView,
        this.block.diagramText,
        this.block.startLine
      );
      if (preferredHeight) {
        this.root.style.setProperty('--meo-mermaid-preview-preferred-height', `${preferredHeight}px`);
      }
      if (!this.previewShell) {
        this.previewShell = document.createElement('div');
        this.previewShell.className = 'meo-mermaid-preview-shell';
        this.previewSticky = document.createElement('div');
        this.previewSticky.className = 'meo-mermaid-preview-sticky';
        this.previewShell.appendChild(this.previewSticky);
        this.root.appendChild(this.previewShell);
      }
      this.renderPreview();
    } else if (this.previewShell) {
      this.root.style.removeProperty('--meo-mermaid-preview-preferred-height');
      this.destroyPreview();
      this.previewShell.remove();
      this.previewShell = null;
      this.previewSticky = null;
    }
  }

  private setSearchReveal(searchReveal: MermaidSearchReveal): void {
    if (!searchReveal) {
      this.innerView.dispatch({ effects: setInnerMermaidSearchRangeEffect.of(null) });
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
    const selectionSpec = selection.anchor !== anchor || selection.head !== head
      ? { anchor, head }
      : undefined;
    this.innerView.dispatch({
      selection: selectionSpec,
      effects: setInnerMermaidSearchRangeEffect.of({ from: anchor, to: head })
    });
  }

  private schedulePreviewRender(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
    }
    this.previewTimer = window.setTimeout(() => {
      this.previewTimer = null;
      this.renderPreview();
    }, 200);
  }

  private renderPreview(): void {
    if (!this.previewSticky) {
      return;
    }
    this.destroyPreview();
    this.previewWidget = new MermaidDiagramWidget(
      this.block.diagramText,
      this.block.startLine,
      this.block.endLine,
      { cachePreviewHeight: false }
    );
    this.previewSticky.replaceChildren(this.previewWidget.toDOM());
  }

  private destroyPreview(): void {
    this.previewWidget?.destroy();
    this.previewWidget = null;
    this.previewSticky?.replaceChildren();
  }

  destroy(): void {
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.destroyPreview();
    this.innerView.destroy();
    delete this.root.__meoMermaidEditingController;
  }
}

export class MermaidEditingWidget extends WidgetType {
  constructor(
    readonly block: MermaidEditingBlock,
    readonly mode: Exclude<MermaidBlockMode, 'preview'>,
    readonly searchReveal: MermaidSearchReveal
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof MermaidEditingWidget &&
      other.block.anchor === this.block.anchor &&
      other.block.diagramText === this.block.diagramText &&
      other.mode === this.mode &&
      other.searchReveal?.from === this.searchReveal?.from &&
      other.searchReveal?.to === this.searchReveal?.to;
  }

  toDOM(view: EditorView): HTMLElement {
    return new MermaidEditingController(view, this.block, this.mode, this.searchReveal).dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const controller = (dom as MermaidEditingBlockElement).__meoMermaidEditingController;
    return controller?.update(view, this.block, this.mode, this.searchReveal) ?? false;
  }

  ignoreEvent(): boolean {
    return true;
  }

  destroy(dom: HTMLElement): void {
    (dom as MermaidEditingBlockElement).__meoMermaidEditingController?.destroy();
  }
}
