import { Facet, StateEffect, StateField, type EditorState } from '@codemirror/state';
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { editorViewportBounds } from './editorViewportBounds';
import { uiLanguageFacet } from './uiLanguage';
import { getUiStrings } from '../application/uiLanguage';
import { isLivePointerSelectionActive, setLivePointerSelectionActiveEffect } from './livePointerSelection';

export type BlockReadingFocus = {
  kind: 'math' | 'html' | 'code' | 'mermaid';
  from: number;
  to: number;
  summaryFrom?: number;
};

export type CaretRetentionReference = { position: number; top: number; geometry?: 'line-block' };

/** The editor supplies its existing viewport owner; blocks do not create one. */
interface BlockViewport {
  beginNavigationReveal(): () => boolean;
  revealPositionUntilStable(position: number, options: { y: 'nearest'; yMargin: number }, isCurrent: () => boolean): void;
  retainPositionTop(position: number, top: number, isCurrent: () => boolean, measured: boolean,
    options: { keepVisible: boolean; reference?: CaretRetentionReference }): void;
  retainElementTopWhileMutation(element: HTMLElement | null, resolve: () => HTMLElement | null, mutate: () => void,
    isCurrent: () => boolean, target: { position: number; top: number }): void;
}
const blockViewport = Facet.define<() => BlockViewport, (() => BlockViewport) | null>({ combine: values => values.at(-1) ?? null });
const viewportFor = (view: EditorView) => view.state.facet(blockViewport)?.();

const setReadingFocus = StateEffect.define<BlockReadingFocus | null>();

/** Presentation consumers classify focus changes without owning this state. */
export function isBlockInteractionEffect(effect: StateEffect<unknown>): boolean { return effect.is(setReadingFocus); }

const readingFocus = StateField.define<{ block: BlockReadingFocus; pointerPending: boolean } | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setReadingFocus))
      return effect.value ? { block: effect.value, pointerPending: false } : null;
    if (!value || transaction.isUserEvent('undo') || transaction.isUserEvent('redo')) return null;
    if (transaction.docChanged) {
      if (transaction.isUserEvent('input')) return null;
      let replaced = false;
      transaction.changes.iterChangedRanges((from, to) => { if (from <= value!.block.from && to >= value!.block.to) replaced = true; });
      if (replaced) return null;
      const from = transaction.changes.mapPos(value.block.from, 1), to = transaction.changes.mapPos(value.block.to, -1);
      const summaryFrom = value.block.summaryFrom === undefined ? undefined : transaction.changes.mapPos(value.block.summaryFrom, 1);
      if (from !== value.block.from || to !== value.block.to || summaryFrom !== value.block.summaryFrom)
        value = { ...value, block: { ...value.block, from, to, summaryFrom } };
    }
    if (transaction.selection) return isLivePointerSelectionActive(transaction.state) ? { ...value, pointerPending: true } : null;
    const released = transaction.effects.some(effect => effect.is(setLivePointerSelectionActiveEffect) && !effect.value.active);
    return released && value.pointerPending ? null : value;
  }
});

export function blockReadingFocusAt(state: EditorState): BlockReadingFocus | null {
  return state.field(readingFocus, false)?.block ?? null;
}

export function clearBlockReadingFocus(view: EditorView): void {
  if (blockReadingFocusAt(view.state)) view.dispatch({ effects: setReadingFocus.of(null) });
}

export function isBlockReading(state: EditorState, from: number, to: number): boolean {
  const focus = blockReadingFocusAt(state);
  return !!focus && focus.from >= from && focus.from <= to;
}

/** A transient caret target, shared by keyboard boundaries and pointer release. */
export function retainBlockCaret(view: EditorView, top: number | null, mutate: (isCurrent: () => boolean) => void,
  reference?: CaretRetentionReference): void {
  const controller = viewportFor(view);
  const isCurrent = controller?.beginNavigationReveal() ?? (() => true);
  mutate(isCurrent);
  const position = view.state.selection.main.head;
  if (top === null) controller?.revealPositionUntilStable(position, { y: 'nearest', yMargin: 8 }, isCurrent);
  else controller?.retainPositionTop(position, top, isCurrent, false, { keepVisible: true, reference });
}

export function moveAcrossBlockBoundary(view: EditorView, forward: boolean, outside: number | null,
  mutate: (isCurrent: () => boolean) => void): boolean {
  const caret = view.coordsAtPos(view.state.selection.main.head);
  const reference = outside === null ? null : view.coordsAtPos(outside);
  const bounds = editorViewportBounds(view);
  retainBlockCaret(view, caret ? caret.top + (forward ? 1 : -1) * view.defaultLineHeight : null, mutate,
    reference && reference.top >= bounds.top && reference.bottom <= bounds.bottom
      ? { position: outside!, top: reference.top } : undefined);
  return true;
}

function blockFocusElement(view: EditorView, block: BlockReadingFocus): HTMLElement | null {
  if (block.kind === 'mermaid') return view.dom.querySelector(
    `.meo-mermaid-toolbar[data-meo-block-from="${block.from}"]:not([data-meo-floating])`);
  if (block.kind === 'math' && isBlockReading(view.state, block.from, block.to))
    return view.dom.querySelector(`.meo-md-math-fenced-display[data-meo-math-anchor="${block.from}"]`);
  if (block.kind === 'html' && isBlockReading(view.state, block.from, block.to))
    return view.dom.querySelector(`.meo-md-html-block[data-meo-rendered-block-start-line="${view.state.doc.lineAt(block.from).number}"]`);
  if (block.summaryFrom !== undefined) {
    for (const selector of ['.meo-md-long-code-placeholder', '.meo-md-long-code-footer']) {
      const summary = Array.from(view.dom.querySelectorAll<HTMLElement>(selector)).find(element => {
        const position = view.posAtDOM(element);
        return position >= block.from && position <= block.to;
      });
      if (summary) return summary;
    }
  }
  const dom = view.domAtPos(block.from);
  const node = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node.childNodes[dom.offset] ?? dom.node;
  const element = (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.cm-line, .meo-md-html-block, .meo-md-math-fenced-display') ?? null;
  return block.kind === 'code' ? element?.querySelector<HTMLElement>('.meo-code-language-label') ?? element : element;
}

function blockHeaderElement(view: EditorView, block: BlockReadingFocus): HTMLElement | null {
  const element = blockFocusElement(view, block);
  if (block.summaryFrom !== undefined && !element?.classList.contains('meo-md-long-code-placeholder')) {
    const dom = view.domAtPos(block.summaryFrom);
    const node = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node.childNodes[dom.offset] ?? dom.node;
    return (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.cm-line') ?? element;
  }
  return block.kind === 'code' && block.summaryFrom === undefined ? element?.closest<HTMLElement>('.cm-line') ?? element : element;
}

/** Rendered content has no exact character hit; retain its head when the source target fits. */
export function enterBlockSource(view: EditorView, block: BlockReadingFocus, top: number | null, mutate: () => void): void {
  // Keep the preceding document row, rather than a font-dependent glyph or
  // padding edge inside the replacement. At document start its block top is 0.
  const position = view.state.doc.line(Math.max(1, view.state.doc.lineAt(block.from).number - 1)).from;
  retainBlockCaret(view, top, mutate, { position, geometry: 'line-block',
    top: view.documentTop + view.lineBlockAt(position).top });
}

/** Explicit completion keeps the block visible without inventing outside text. */
export function focusBlockReading(view: EditorView, block: BlockReadingFocus, effects: readonly StateEffect<unknown>[] = []): void {
  const controller = viewportFor(view);
  const isCurrent = controller?.beginNavigationReveal() ?? (() => true);
  const resolve = () => blockHeaderElement(view, block);
  const element = resolve(), rect = element?.getBoundingClientRect(), bounds = view.scrollDOM.getBoundingClientRect();
  const top = rect && rect.height > 0 && rect.top >= bounds.top
    && rect.top + Math.min(rect.height, view.defaultLineHeight) <= bounds.bottom ? rect.top : bounds.top + 8;
  // Code keeps its source visible. Leave the fence inactive so its stable
  // language widget can own reading focus rather than a replaceable text row.
  const position = block.kind === 'code'
    ? view.state.doc.line(Math.min(view.state.doc.lineAt(block.from).number + 1, view.state.doc.lines)).from : block.from;
  const mutate = () => view.dispatch({ selection: { anchor: position }, effects: [...effects, setReadingFocus.of(block)] });
  if (controller) controller.retainElementTopWhileMutation(element, resolve, mutate, isCurrent, { position: block.from, top });
  else mutate();
}

export function blockInteractionExtensions(enter: (view: EditorView, block: BlockReadingFocus) => void, viewport: () => BlockViewport) {
  return [readingFocus, blockViewport.of(viewport), EditorView.editorAttributes.of(view => blockReadingFocusAt(view.state) ? { class: 'meo-block-reading' } : null),
    ViewPlugin.fromClass(class {
      private target: HTMLElement | null = null;
      private needsFocus = false;
      private releaseTarget() {
        if (this.target?.classList.contains('meo-code-language-label')) this.target.setAttribute('aria-hidden', 'true');
        this.target?.classList.remove('meo-block-reading-target');
        this.target = null;
      }
      constructor(readonly view: EditorView) {
        view.dom.addEventListener('keydown', this.onKeyDown, true);
        view.dom.addEventListener('focusin', this.onFocusIn);
        view.dom.addEventListener('pointerdown', this.onPointerDown, true);
      }
      private onPointerDown = (event: PointerEvent) => {
        const block = blockReadingFocusAt(this.view.state), target = event.target instanceof Element ? event.target : null;
        if (event.button === 0 && block?.kind === 'code' && target?.closest('.cm-line')
          && !target.closest('.meo-code-block-actions, .meo-code-language-label'))
          this.view.dispatch({ effects: setReadingFocus.of(null) });
      };
      private onFocusIn = (event: FocusEvent) => {
        if (event.target === this.view.contentDOM && blockReadingFocusAt(this.view.state)
          && !isLivePointerSelectionActive(this.view.state) && this.target?.isConnected) {
          if (event.relatedTarget === this.target) enter(this.view, blockReadingFocusAt(this.view.state)!);
          else this.target.focus({ preventScroll: true });
        }
      };
      private onKeyDown = (event: KeyboardEvent) => {
        const block = blockReadingFocusAt(this.view.state);
        if (!block || event.target !== this.target || event.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
          this.view.dispatch({ selection: { anchor: 0, head: this.view.state.doc.length } });
          this.view.focus(); event.preventDefault(); event.stopPropagation(); return;
        }
        if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
        if (event.key === 'Enter') enter(this.view, block);
        else if (event.key.startsWith('Arrow')) {
          const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
          const line = this.view.state.doc.lineAt(forward ? Math.max(block.from, block.to - 1) : block.from);
          const next = line.number + (forward ? 1 : -1);
          if (next > 0 && next <= this.view.state.doc.lines) {
            const outside = this.view.state.doc.line(next);
            moveAcrossBlockBoundary(this.view, forward, forward ? outside.from : outside.to, () => {
              this.view.dispatch({ selection: { anchor: forward ? outside.from : outside.to }, userEvent: 'select' });
              this.view.focus();
            });
          }
        } else return;
        event.preventDefault(); event.stopPropagation();
      };
      update(update: ViewUpdate) {
        const block = blockReadingFocusAt(update.state);
        if (block !== blockReadingFocusAt(update.startState)) {
          const ownedFocus = this.target === this.view.dom.ownerDocument.activeElement;
          this.needsFocus = !!block && (ownedFocus || update.transactions.some(transaction => transaction.effects.some(effect => effect.is(setReadingFocus))));
          if (!block) this.releaseTarget();
        }
        if (!block) return;
        this.view.requestMeasure({ key: this, read: () => blockFocusElement(this.view, block), write: target => {
          if (!target || blockReadingFocusAt(this.view.state) !== block) return;
          if (this.target !== target) {
            this.releaseTarget();
            this.target = target;
            target.classList.add('meo-block-reading-target');
          }
          if (target.getAttribute('tabindex') !== '-1') target.tabIndex = -1;
          if (target.classList.contains('meo-code-language-label') && target.hasAttribute('aria-hidden')) target.removeAttribute('aria-hidden');
          const label = getUiStrings(this.view.state.facet(uiLanguageFacet)).blockReadingArea;
          if (target.getAttribute('aria-label') !== label) target.setAttribute('aria-label', label);
          if (this.needsFocus) { this.needsFocus = false; target.focus({ preventScroll: true }); }
        } });
      }
      destroy() {
        this.releaseTarget();
        this.view.dom.removeEventListener('keydown', this.onKeyDown, true);
        this.view.dom.removeEventListener('focusin', this.onFocusIn);
        this.view.dom.removeEventListener('pointerdown', this.onPointerDown, true);
      }
    })];
}
