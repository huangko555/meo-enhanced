import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { getFencedCodeInfo } from './codeBlocks';

const LONG_CODE_LINE_THRESHOLD = 18;
const LONG_CODE_VISIBLE_LINES = 10;
const COLLAPSE_LABEL = 'Show less';

type LongCodeBlockDescriptor = {
  anchor: number;
  start: number;
  end: number;
  endLineFrom: number;
  contentFrom: number;
  contentTo: number;
  collapsedFrom: number;
  lineCount: number;
  hiddenLineCount: number;
  isLong: boolean;
};

type LongCodeBlockRecord = LongCodeBlockDescriptor & {
  wasLong: boolean;
  collapsed: boolean;
  userExpanded: boolean;
  searchTemporary: boolean;
};

type LongCodeBlockState = {
  blocks: LongCodeBlockRecord[];
  decorations: DecorationSet;
};

export const setLongCodeBlockSearchRevealEffect = StateEffect.define<{ from: number; to: number } | null>();
const setLongCodeBlockPointerInteractionEffect = StateEffect.define<{ position: number }>();
const toggleLongCodeBlockEffect = StateEffect.define<{ anchor: number; collapsed: boolean }>();

function isMermaidLanguage(info: string | null): boolean {
  return info === 'mermaid';
}

function collectLongCodeBlockDescriptors(state: EditorState): LongCodeBlockDescriptor[] {
  const descriptors: LongCodeBlockDescriptor[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      if (node.name !== 'FencedCode') {
        return;
      }

      const info = getFencedCodeInfo(state, node);
      if (!info || isMermaidLanguage(info)) {
        return false;
      }

      const startLine = state.doc.lineAt(node.from);
      const endLine = state.doc.lineAt(Math.max(node.to - 1, node.from));
      const contentStartLine = state.doc.line(startLine.number + 1);
      const lastChild = node.node.lastChild;
      const hasClosingFence = lastChild?.name === 'CodeMark' &&
        state.doc.lineAt(lastChild.from).number === endLine.number;
      const contentEndLineNumber = endLine.number - (hasClosingFence ? 1 : 0);

      if (contentStartLine.number > contentEndLineNumber) {
        return false;
      }

      const contentEndLine = state.doc.line(contentEndLineNumber);
      const lineCount = contentEndLine.number - contentStartLine.number + 1;
      const isLong = lineCount > LONG_CODE_LINE_THRESHOLD;
      const collapsedFrom = isLong
        ? state.doc.line(contentStartLine.number + LONG_CODE_VISIBLE_LINES).from
        : contentEndLine.to;
      descriptors.push({
        anchor: node.from,
        start: startLine.from,
        end: endLine.to,
        endLineFrom: endLine.from,
        contentFrom: contentStartLine.from,
        contentTo: contentEndLine.to,
        collapsedFrom,
        lineCount,
        hiddenLineCount: Math.max(0, lineCount - LONG_CODE_VISIBLE_LINES),
        isLong
      });
      return false;
    }
  });
  return descriptors;
}

function findBlockContainingPosition(
  blocks: ReadonlyArray<LongCodeBlockRecord>,
  from: number,
  to = from
): LongCodeBlockRecord | null {
  return blocks.find((block) => from >= block.contentFrom && to <= block.contentTo) ?? null;
}

function getCollapseSelectionPosition(view: EditorView, anchor: number): number {
  return collectLongCodeBlockDescriptors(view.state)
    .find((block) => block.anchor === anchor)?.collapsedFrom ?? anchor;
}

function ensureCollapsedBlockVisible(view: EditorView, anchor: number): void {
  view.requestMeasure({
    read: (measuredView) => {
      const descriptor = collectLongCodeBlockDescriptors(measuredView.state)
        .find((block) => block.anchor === anchor);
      const scroller = measuredView.scrollDOM.getBoundingClientRect();
      if (!descriptor || scroller.height <= 0) {
        return null;
      }

      const start = measuredView.coordsAtPos(descriptor.start);
      const placeholder = measuredView.dom.querySelector<HTMLElement>(
        `.meo-md-long-code-placeholder[data-long-code-anchor="${anchor}"]`
      )?.getBoundingClientRect() ?? null;
      const startVisible = Boolean(start && start.bottom >= scroller.top && start.top <= scroller.bottom);
      const placeholderVisible = Boolean(
        placeholder && placeholder.bottom >= scroller.top && placeholder.top <= scroller.bottom
      );
      if (startVisible || placeholderVisible) {
        return null;
      }
      if (placeholder) {
        return measuredView.scrollDOM.scrollTop + placeholder.top - scroller.top - 8;
      }
      return null;
    },
    write: (scrollTop) => {
      if (scrollTop !== null) {
        view.scrollDOM.scrollTop = scrollTop;
        // CodeMirror may apply its own selection anchoring after the measure write.
        requestAnimationFrame(() => {
          if (view.scrollDOM.scrollTop !== scrollTop) {
            view.scrollDOM.scrollTop = scrollTop;
          }
        });
      }
    }
  });
}

function setLongCodeBlockCollapsed(view: EditorView, anchor: number, collapsed: boolean): void {
  const previousScrollTop = view.scrollDOM.scrollTop;
  view.dispatch({
    selection: { anchor: collapsed ? getCollapseSelectionPosition(view, anchor) : anchor },
    effects: toggleLongCodeBlockEffect.of({ anchor, collapsed })
  });
  view.focus();
  if (!collapsed) {
    return;
  }

  view.scrollDOM.scrollTop = previousScrollTop;
  ensureCollapsedBlockVisible(view, anchor);
}

function makeActionButton(
  view: EditorView,
  action: 'expand' | 'collapse',
  anchor: number,
  hiddenLineCount = 0
): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'meo-long-code-action';
  button.setAttribute('aria-expanded', action === 'collapse' ? 'true' : 'false');
  button.setAttribute('aria-label', action === 'expand'
    ? `Show ${hiddenLineCount} more lines of code`
    : 'Show less code');
  button.textContent = action === 'expand'
    ? `Show ${hiddenLineCount} more lines`
    : COLLAPSE_LABEL;
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setLongCodeBlockCollapsed(view, anchor, action === 'collapse');
  });
  return button;
}

class LongCodePlaceholderWidget extends WidgetType {
  constructor(
    readonly anchor: number,
    readonly hiddenLineCount: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof LongCodePlaceholderWidget &&
      other.anchor === this.anchor &&
      other.hiddenLineCount === this.hiddenLineCount;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'meo-md-long-code-placeholder';
    container.dataset.longCodeAnchor = String(this.anchor);
    container.appendChild(makeActionButton(view, 'expand', this.anchor, this.hiddenLineCount));
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class LongCodeFooterWidget extends WidgetType {
  constructor(readonly anchor: number) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof LongCodeFooterWidget && other.anchor === this.anchor;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'meo-md-long-code-footer';
    container.dataset.longCodeAnchor = String(this.anchor);
    container.appendChild(makeActionButton(view, 'collapse', this.anchor));
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

function buildLongCodeDecorations(
  blocks: ReadonlyArray<LongCodeBlockRecord>
): DecorationSet {
  const ranges: Array<{ from: number; to: number; decoration: Decoration }> = [];
  for (const block of blocks) {
    if (!block.isLong) {
      continue;
    }
    if (block.collapsed) {
      if (block.collapsedFrom < block.end) {
        ranges.push({
          from: block.collapsedFrom,
          to: block.end,
          decoration: Decoration.replace({
            widget: new LongCodePlaceholderWidget(block.anchor, block.hiddenLineCount),
            block: true
          })
        });
      }
      continue;
    }
    ranges.push({
      from: block.end,
      to: block.end,
      decoration: Decoration.widget({
        widget: new LongCodeFooterWidget(block.anchor),
        block: true,
        side: 1
      })
    });
    ranges.push({
      from: block.endLineFrom,
      to: block.endLineFrom,
      decoration: Decoration.line({ class: 'meo-md-code-block-before-footer' })
    });
  }
  return Decoration.set(ranges.map((range) => range.decoration.range(range.from, range.to)), true);
}

function buildLongCodeState(
  state: EditorState,
  previous: LongCodeBlockState | null = null,
  transaction: Transaction | null = null
): LongCodeBlockState {
  const descriptors = collectLongCodeBlockDescriptors(state);
  const previousByAnchor = new Map<number, LongCodeBlockRecord>();
  for (const block of previous?.blocks ?? []) {
    const mappedAnchor = transaction ? transaction.changes.mapPos(block.anchor, 1) : block.anchor;
    previousByAnchor.set(mappedAnchor, block);
  }

  const blocks = descriptors.map((descriptor) => {
    const old = previousByAnchor.get(descriptor.anchor);
    if (!old) {
      return {
        ...descriptor,
        wasLong: descriptor.isLong,
        collapsed: descriptor.isLong,
        userExpanded: false,
        searchTemporary: false
      };
    }

    const crossedThreshold = !old.wasLong && descriptor.isLong;
    return {
      ...descriptor,
      wasLong: old.wasLong || descriptor.isLong,
      collapsed: crossedThreshold ? false : old.collapsed,
      userExpanded: crossedThreshold ? true : old.userExpanded,
      searchTemporary: old.searchTemporary
    };
  });

  let searchReveal: { from: number; to: number } | null | undefined;
  for (const effect of transaction?.effects ?? []) {
    if (effect.is(setLongCodeBlockSearchRevealEffect)) {
      searchReveal = effect.value;
    }
  }

  if (searchReveal !== undefined) {
    const target = searchReveal
      ? findBlockContainingPosition(blocks, searchReveal.from, searchReveal.to)
      : null;
    for (const block of blocks) {
      if (block.searchTemporary && !block.userExpanded && block !== target) {
        block.collapsed = true;
        block.searchTemporary = false;
      }
    }
    if (target?.isLong && target.collapsed) {
      target.collapsed = false;
      target.searchTemporary = true;
    }
  }

  for (const effect of transaction?.effects ?? []) {
    if (effect.is(toggleLongCodeBlockEffect)) {
      const target = blocks.find((block) => block.anchor === effect.value.anchor);
      if (target?.isLong) {
        target.collapsed = effect.value.collapsed;
        target.userExpanded = !effect.value.collapsed;
        target.searchTemporary = false;
      }
    }
    if (effect.is(setLongCodeBlockPointerInteractionEffect)) {
      const target = findBlockContainingPosition(blocks, effect.value.position);
      if (target?.isLong) {
        target.collapsed = false;
        target.userExpanded = true;
        target.searchTemporary = false;
      }
    }
  }

  const searchEffectPresent = (transaction?.effects ?? []).some((effect) => effect.is(setLongCodeBlockSearchRevealEffect));
  const toggleEffectPresent = (transaction?.effects ?? []).some((effect) => effect.is(toggleLongCodeBlockEffect));
  if (transaction?.selection && !searchEffectPresent && !toggleEffectPresent) {
    const selection = transaction.state.selection.main;
    const target = findBlockContainingPosition(blocks, selection.from, selection.to);
    if (target?.isLong) {
      target.collapsed = false;
      target.userExpanded = true;
      target.searchTemporary = false;
    }
  }

  return {
    blocks,
    decorations: buildLongCodeDecorations(blocks)
  };
}

const longCodeBlockStateField = StateField.define<LongCodeBlockState>({
  create(state) {
    return buildLongCodeState(state);
  },
  update(value, transaction) {
    return buildLongCodeState(transaction.state, value, transaction);
  },
  provide(field) {
    return EditorView.decorations.from(field, (value) => value.decorations);
  }
});

class LongCodeFloatingButtonPlugin {
  button: HTMLButtonElement;
  view: EditorView;
  private horizontalOffset = 0;
  private readonly onScroll = (): void => this.refresh();
  private readonly onPointerDown = (event: PointerEvent): void => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('.meo-long-code-action, .meo-code-block-actions, .meo-code-language-label, .meo-md-long-code-placeholder, .meo-md-long-code-footer')) {
      return;
    }
    const position = this.view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (position === null) {
      return;
    }
    const state = this.view.state.field(longCodeBlockStateField, false);
    if (!state) {
      return;
    }
    const block = findBlockContainingPosition(state.blocks, position);
    if (block?.collapsed) {
      this.view.dispatch({ effects: setLongCodeBlockPointerInteractionEffect.of({ position }) });
    }
  };

  constructor(view: EditorView) {
    this.view = view;
    this.button = document.createElement('button');
    this.button.type = 'button';
    this.button.className = 'meo-long-code-floating-action';
    this.button.textContent = COLLAPSE_LABEL;
    this.button.setAttribute('aria-label', 'Show less code');
    this.button.hidden = true;
    this.button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const anchor = Number(this.button.dataset.anchor);
      if (!Number.isFinite(anchor)) {
        return;
      }
      setLongCodeBlockCollapsed(view, anchor, true);
    });
    view.dom.appendChild(this.button);
    view.dom.addEventListener('pointerdown', this.onPointerDown, true);
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true });
    this.refresh();
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.geometryChanged || update.transactions.some((transaction) => transaction.effects.length > 0)) {
      this.refresh();
    }
  }

  destroy(): void {
    this.view.dom.removeEventListener('pointerdown', this.onPointerDown, true);
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll);
    this.button.remove();
  }

  private refresh(): void {
    this.view.requestMeasure({
      read: (view) => {
        const state = view.state.field(longCodeBlockStateField, false);
        const scroller = view.scrollDOM.getBoundingClientRect();
        const content = view.contentDOM.getBoundingClientRect();
        const staticContainer = view.dom.querySelector<HTMLElement>(
          '.meo-md-long-code-placeholder, .meo-md-long-code-footer'
        );
        const staticRect = staticContainer?.getBoundingClientRect() ?? null;
        const contentCenter = content.left + content.width / 2;
        const horizontalOffset = staticRect
          ? staticRect.left + staticRect.width / 2 - contentCenter
          : this.horizontalOffset;
        if (!state || scroller.width <= 0 || scroller.height <= 0) {
          return { visible: false, anchor: 0, left: 0, top: 0, horizontalOffset };
        }

        const probeY = scroller.bottom - 8;
        const block = state.blocks
          .filter((candidate) => {
            if (!candidate.isLong || candidate.collapsed) {
              return false;
            }
            const start = view.lineBlockAt(candidate.start);
            const end = view.lineBlockAt(Math.max(candidate.end - 1, candidate.start));
            const startTop = scroller.top + start.top - view.scrollDOM.scrollTop;
            const endBottom = scroller.top + end.bottom - view.scrollDOM.scrollTop;
            return startTop <= probeY && endBottom > scroller.bottom;
          })
          .filter((candidate) => {
            const footer = view.dom.querySelector<HTMLElement>(
              `.meo-md-long-code-footer[data-long-code-anchor="${candidate.anchor}"]`
            );
            if (!footer) {
              return true;
            }
            const rect = footer.getBoundingClientRect();
            return rect.bottom < scroller.top || rect.top > scroller.bottom;
          })
          .sort((left, right) => right.start - left.start)[0];

        return block
          ? {
              visible: true,
              anchor: block.anchor,
              left: contentCenter + horizontalOffset,
              top: scroller.bottom - 34,
              horizontalOffset
            }
          : { visible: false, anchor: 0, left: 0, top: 0, horizontalOffset };
      },
      write: (measure) => {
        this.horizontalOffset = measure.horizontalOffset;
        if (!measure.visible) {
          this.button.hidden = true;
          return;
        }
        this.button.dataset.anchor = String(measure.anchor);
        this.button.hidden = false;
        this.button.style.left = `${measure.left}px`;
        this.button.style.top = `${measure.top}px`;
      }
    });
  }
}

const longCodeBlockViewPlugin = ViewPlugin.fromClass(LongCodeFloatingButtonPlugin);

export function longCodeBlockExtensions() {
  return [longCodeBlockStateField, longCodeBlockViewPlugin];
}
