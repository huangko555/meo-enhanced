import { EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { getFencedCodeInfo } from './codeBlocks';
import { applyLiveBlockIndent, getLiveListBlockIndentColumns } from './blockIndent';
import {
  mapLiveInputDerivedDecorations,
  shouldDeferLiveInputDerivedWork
} from '../editor/liveInputDerivedWork';

const LONG_CODE_LINE_THRESHOLD = 18;
const LONG_CODE_VISIBLE_LINES = 10;
const COLLAPSE_LABEL = 'Show less';

type LongCodeBlockDescriptor = {
  anchor: number;
  start: number;
  end: number;
  endLineFrom: number;
  indentColumns: number;
  language: string;
  contentFrom: number;
  contentTo: number;
  collapsedFrom: number;
  lineCount: number;
  hiddenLineCount: number;
  isLong: boolean;
};

type LongCodeBlockRecord = LongCodeBlockDescriptor & {
  wasLong: boolean;
  manualCollapsed: boolean;
  temporaryTarget: boolean;
  collapsed: boolean;
};

type LongCodeBlockState = {
  blocks: LongCodeBlockRecord[];
  decorations: DecorationSet;
};

const setLongCodeBlockPointerInteractionEffect = StateEffect.define<{ position: number }>();
const toggleLongCodeBlockEffect = StateEffect.define<{ anchor: number; collapsed: boolean }>();
const viewportGeneration = new WeakMap<EditorView, number>();

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
      if (isMermaidLanguage(info)) {
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
        indentColumns: getLiveListBlockIndentColumns(state, node.from, node.node),
        language: info || 'Plain text',
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

function findBlockIntersectingHiddenRange(
  blocks: ReadonlyArray<LongCodeBlockRecord>,
  from: number,
  to: number
): LongCodeBlockRecord | null {
  const rangeFrom = Math.min(from, to);
  const rangeTo = Math.max(from, to);
  return blocks.find((block) => rangeFrom === rangeTo
    ? rangeFrom >= block.collapsedFrom && rangeFrom <= block.contentTo
    : rangeFrom < block.contentTo && rangeTo > block.collapsedFrom) ?? null;
}

function getCollapseSelectionPosition(view: EditorView, anchor: number): number {
  return collectLongCodeBlockDescriptors(view.state)
    .find((block) => block.anchor === anchor)?.collapsedFrom ?? anchor;
}

function ensureCollapsedBlockVisible(view: EditorView, anchor: number, generation: number): void {
  view.requestMeasure({
    read: (measuredView) => {
      if (viewportGeneration.get(measuredView) !== generation) return null;
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
      if (scrollTop !== null && viewportGeneration.get(view) === generation) {
        view.scrollDOM.scrollTop = scrollTop;
        // CodeMirror may apply its own selection anchoring after the measure write.
        requestAnimationFrame(() => {
          if (viewportGeneration.get(view) === generation && view.scrollDOM.scrollTop !== scrollTop) {
            view.scrollDOM.scrollTop = scrollTop;
          }
        });
      }
    }
  });
}

function setLongCodeBlockCollapsed(view: EditorView, anchor: number, collapsed: boolean): void {
  const generation = (viewportGeneration.get(view) ?? 0) + 1;
  viewportGeneration.set(view, generation);
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
  ensureCollapsedBlockVisible(view, anchor, generation);
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
    readonly language: string,
    readonly lineCount: number,
    readonly hiddenLineCount: number,
    readonly contentTo: number,
    readonly indentColumns: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof LongCodePlaceholderWidget &&
      other.anchor === this.anchor &&
      other.language === this.language &&
      other.lineCount === this.lineCount &&
      other.hiddenLineCount === this.hiddenLineCount &&
      other.contentTo === this.contentTo &&
      other.indentColumns === this.indentColumns;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'meo-md-long-code-placeholder';
    container.dataset.longCodeAnchor = String(this.anchor);
    const contentEndLineNumber = view.state.doc.lineAt(
      Math.min(this.contentTo, view.state.doc.length)
    ).number;
    container.dataset.meoRenderedBlockStartLine = String(contentEndLineNumber);
    container.dataset.meoRenderedBlockEndLine = String(contentEndLineNumber);
    applyLiveBlockIndent(container, this.indentColumns);
    const language = document.createElement('span');
    language.className = 'meo-long-code-language';
    language.textContent = this.language;
    const metadata = document.createElement('span');
    metadata.className = 'meo-long-code-line-count';
    metadata.textContent = `${this.lineCount} lines`;
    container.append(language, metadata);
    container.appendChild(makeActionButton(view, 'expand', this.anchor, this.hiddenLineCount));
    return container;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

class LongCodeFooterWidget extends WidgetType {
  constructor(
    readonly anchor: number,
    readonly language: string,
    readonly lineCount: number,
    readonly indentColumns: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof LongCodeFooterWidget &&
      other.anchor === this.anchor &&
      other.language === this.language &&
      other.lineCount === this.lineCount &&
      other.indentColumns === this.indentColumns;
  }

  toDOM(view: EditorView): HTMLElement {
    const container = document.createElement('div');
    container.className = 'meo-md-long-code-footer';
    container.dataset.longCodeAnchor = String(this.anchor);
    applyLiveBlockIndent(container, this.indentColumns);
    const language = document.createElement('span');
    language.className = 'meo-long-code-language';
    language.textContent = this.language;
    const metadata = document.createElement('span');
    metadata.className = 'meo-long-code-line-count';
    metadata.textContent = `${this.lineCount} lines`;
    container.append(language, metadata);
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
            widget: new LongCodePlaceholderWidget(
              block.anchor,
              block.language,
              block.lineCount,
              block.hiddenLineCount,
              block.contentTo,
              block.indentColumns
            ),
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
        widget: new LongCodeFooterWidget(
          block.anchor,
          block.language,
          block.lineCount,
          block.indentColumns
        ),
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
        manualCollapsed: descriptor.isLong,
        temporaryTarget: false,
        collapsed: descriptor.isLong
      };
    }

    const crossedThreshold = !old.wasLong && descriptor.isLong;
    const manualCollapsed = crossedThreshold ? false : old.manualCollapsed;
    const temporaryTarget = crossedThreshold ? false : old.temporaryTarget;
    return {
      ...descriptor,
      wasLong: old.wasLong || descriptor.isLong,
      manualCollapsed,
      temporaryTarget,
      collapsed: descriptor.isLong && manualCollapsed && !temporaryTarget
    };
  });

  const reduced = reduceLongCodeInteractions(blocks, transaction);

  return {
    blocks: reduced.blocks,
    decorations: buildLongCodeDecorations(reduced.blocks)
  };
}

function hasLongCodeImmediateEffect(transaction: Transaction): boolean {
  return transaction.effects.some((effect) => (
    effect.is(toggleLongCodeBlockEffect)
    || effect.is(setLongCodeBlockPointerInteractionEffect)
  ));
}

function applyTemporaryTarget(
  blocks: LongCodeBlockRecord[],
  target: LongCodeBlockRecord | null
): boolean {
  let changed = false;
  for (const block of blocks) {
    const temporaryTarget = block === target && block.manualCollapsed;
    if (block.temporaryTarget === temporaryTarget) continue;
    block.temporaryTarget = temporaryTarget;
    block.collapsed = block.isLong && block.manualCollapsed && !temporaryTarget;
    changed = true;
  }
  return changed;
}

/** One-shot effects and selection intent have one reducer regardless of descriptor source. */
function reduceLongCodeInteractions(
  sourceBlocks: LongCodeBlockRecord[],
  transaction: Transaction | null
): { blocks: LongCodeBlockRecord[]; presentationChanged: boolean } {
  if (!transaction) {
    return { blocks: sourceBlocks, presentationChanged: false };
  }
  let presentationChanged = false;
  const blocks = sourceBlocks;

  const searchClear = transaction.isUserEvent('select.search.clear');
  const searchReveal = !searchClear && transaction.isUserEvent('select.search');
  if (searchReveal || searchClear) {
    const selection = transaction.state.selection.main;
    const target = searchReveal
      ? findBlockIntersectingHiddenRange(blocks, selection.from, selection.to)
      : null;
    if (applyTemporaryTarget(blocks, target)) presentationChanged = true;
  }

  for (const effect of transaction.effects) {
    if (effect.is(toggleLongCodeBlockEffect)) {
      const target = blocks.find((block) => block.anchor === effect.value.anchor);
      if (target?.isLong) {
        target.manualCollapsed = effect.value.collapsed;
        target.temporaryTarget = false;
        target.collapsed = effect.value.collapsed;
        presentationChanged = true;
      }
    } else if (effect.is(setLongCodeBlockPointerInteractionEffect)) {
      const target = findBlockContainingPosition(blocks, effect.value.position);
      if (target?.isLong) {
        target.manualCollapsed = false;
        target.temporaryTarget = false;
        target.collapsed = false;
        presentationChanged = true;
      }
    }
  }

  const toggleEffectPresent = transaction.effects.some((effect) => effect.is(toggleLongCodeBlockEffect));
  if (transaction.selection && !searchReveal && !searchClear && !toggleEffectPresent) {
    const selection = transaction.state.selection.main;
    const target = findBlockIntersectingHiddenRange(blocks, selection.from, selection.to);
    if (applyTemporaryTarget(blocks, target)) presentationChanged = true;
  }
  return { blocks, presentationChanged };
}

function updateDeferredLongCodeState(
  value: LongCodeBlockState,
  transaction: Transaction
): LongCodeBlockState {
  const map = (position: number, assoc: -1 | 1 = 1) => transaction.changes.mapPos(position, assoc);
  const blocks = value.blocks.map((block) => transaction.docChanged
    ? {
        ...block,
        anchor: map(block.anchor),
        start: map(block.start),
        end: map(block.end, -1),
        endLineFrom: map(block.endLineFrom),
        contentFrom: map(block.contentFrom),
        contentTo: map(block.contentTo, -1),
        collapsedFrom: map(block.collapsedFrom)
      }
    : { ...block });

  const reduced = reduceLongCodeInteractions(blocks, transaction);

  return {
    blocks: reduced.blocks,
    decorations: hasLongCodeImmediateEffect(transaction)
      || reduced.presentationChanged
      || !transaction.docChanged
      ? buildLongCodeDecorations(reduced.blocks)
      : mapLiveInputDerivedDecorations(value.decorations, transaction)
  };
}

const longCodeBlockStateField = StateField.define<LongCodeBlockState>({
  create(state) {
    return buildLongCodeState(state);
  },
  update(value, transaction) {
    if (shouldDeferLiveInputDerivedWork(transaction)) {
      return updateDeferredLongCodeState(value, transaction);
    }
    return buildLongCodeState(transaction.state, value, transaction);
  },
  provide(field) {
    return EditorView.decorations.from(field, (value) => value.decorations);
  }
});

class LongCodeFloatingButtonPlugin {
  button: HTMLButtonElement;
  view: EditorView;
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
    if (update.transactions.some(shouldDeferLiveInputDerivedWork)
      && !update.transactions.some(hasLongCodeImmediateEffect)) return;
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.geometryChanged || update.transactions.some((transaction) => transaction.effects.length > 0)) {
      this.refresh();
    }
  }

  destroy(): void {
    viewportGeneration.set(this.view, (viewportGeneration.get(this.view) ?? 0) + 1);
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
        const contentCenter = content.left + content.width / 2;
        if (!state || scroller.width <= 0 || scroller.height <= 0) {
          return { visible: false, anchor: 0, left: 0, top: 0 };
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

        const visibleCodeLine = Array.from(
          view.dom.querySelectorAll<HTMLElement>('.cm-line.meo-md-code-block')
        ).map((line) => line.getBoundingClientRect())
          .find((rect) => rect.top <= probeY && rect.bottom >= probeY);
        const blockCenter = visibleCodeLine
          ? visibleCodeLine.left + visibleCodeLine.width / 2
          : contentCenter;

        return block
          ? {
              visible: true,
              anchor: block.anchor,
              left: blockCenter,
              top: scroller.bottom - 34
            }
          : { visible: false, anchor: 0, left: 0, top: 0 };
      },
      write: (measure) => {
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

export function longCodeBlockSessionUiExtension() {
  return [longCodeBlockStateField, longCodeBlockViewPlugin];
}
