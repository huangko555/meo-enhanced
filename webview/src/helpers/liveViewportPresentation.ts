import { StateEffect, StateField, type EditorState, type Range, type Transaction } from '@codemirror/state';
import { Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { mapLiveWidgetPositions, liveWidgetPositionsIndependent } from '../editor/liveWidgetPositions';
import { renderedBlockPreviewHeight, renderedBlockPreview } from './renderedBlockPreview';
import { isLiveInputDerivedWorkPending } from '../editor/liveInputDerivedWork';

type Band = { from: number; to: number };
const overscanLines = 80;
const setPresentationBand = StateEffect.define<Band>();
const presentationBand = StateField.define<Band>({
  create(state) {
    const line = state.doc.lineAt(state.selection.main.head).number;
    return { from: state.doc.line(Math.max(1, line - overscanLines)).from,
      to: state.doc.line(Math.min(state.doc.lines, line + overscanLines)).to };
  },
  update(band, transaction) {
    const replacement = transaction.effects.find(effect => effect.is(setPresentationBand));
    if (replacement) return replacement.value;
    return transaction.docChanged ? { from: transaction.changes.mapPos(band.from, -1), to: transaction.changes.mapPos(band.to, 1) } : band;
  }
});

export const isLiveViewportPresentationEffect = (effect: StateEffect<unknown>) => effect.is(setPresentationBand);
export const getLivePresentationBand = (state: EditorState): Band | undefined => state.field(presentationBand, false);

/** Offscreen presentation owns height and source coverage, with no mutable UI
 * or embedded absolute source positions. CodeMirror maps these ranges itself. */
class ViewportWidgetPlaceholder extends WidgetType {
  readonly [liveWidgetPositionsIndependent] = true;
  readonly [renderedBlockPreviewHeight]: unknown;
  readonly [renderedBlockPreview]: unknown;
  private readonly height: number;
  private readonly breaks: number;
  get estimatedHeight() { return this.height; }
  get lineBreaks() { return this.breaks; }
  constructor(widget: WidgetType, readonly block: boolean) {
    super();
    this.height = widget.estimatedHeight;
    this.breaks = widget.lineBreaks;
    this[renderedBlockPreviewHeight] = (widget as any)[renderedBlockPreviewHeight];
    this[renderedBlockPreview] = (widget as any)[renderedBlockPreview];
  }
  [mapLiveWidgetPositions]() { return this; }
  eq(other: WidgetType) {
    return other instanceof ViewportWidgetPlaceholder && other.block === this.block
      && other.estimatedHeight === this.estimatedHeight && other.lineBreaks === this.lineBreaks;
  }
  toDOM() {
    const element = document.createElement(this.block ? 'div' : 'span');
    element.className = 'meo-live-viewport-placeholder';
    element.setAttribute('aria-hidden', 'true');
    if (this.estimatedHeight > 0) {
      element.style.height = `${this.estimatedHeight}px`;
      if (!this.block) element.style.display = 'inline-block';
    }
    return element;
  }
  ignoreEvent() { return true; }
}

/** Called by the canonical full and local renderer before ranges are stored.
 * Complete text/marks remain present; only offscreen UI instances are omitted. */
export function restrictLiveWidgetPresentation(ranges: Range<Decoration>[], state: EditorState): void {
  const band = getLivePresentationBand(state);
  if (!band) return;
  for (let index = 0; index < ranges.length; index++) {
    const range = ranges[index], widget = range.value.spec.widget as WidgetType | undefined;
    if (!widget || range.to >= band.from && range.from <= band.to) continue;
    const spec = { ...range.value.spec, widget: new ViewportWidgetPlaceholder(widget, !!range.value.spec.block) };
    ranges[index] = (range.from === range.to ? Decoration.widget(spec) : Decoration.replace(spec)).range(range.from, range.to);
  }
}

export function liveViewportPresentationExtensions() {
  return [presentationBand, ViewPlugin.define(view => {
    let disposed = false, queued = false;
    let compositionFrame: number | null = null;
    const schedule = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        if (disposed) return;
        // Input owns the current DOM until its generation settles. Publishing a
        // new band while composition is pending could leave it unapplied.
        if (view.composing) {
          if (compositionFrame === null) compositionFrame = window.requestAnimationFrame(() => {
            compositionFrame = null; schedule();
          });
          return;
        }
        if (isLiveInputDerivedWorkPending(view.state)) return;
        const band = getLivePresentationBand(view.state)!;
        const { from, to } = view.viewport;
        const first = view.state.doc.lineAt(from).number, last = view.state.doc.lineAt(to).number;
        const innerFrom = view.state.doc.line(Math.max(1, first - 20)).from;
        const innerTo = view.state.doc.line(Math.min(view.state.doc.lines, last + 20)).to;
        if (innerFrom >= band.from && innerTo <= band.to) return;
        view.dispatch({ effects: setPresentationBand.of({
          from: view.state.doc.line(Math.max(1, first - overscanLines)).from,
          to: view.state.doc.line(Math.min(view.state.doc.lines, last + overscanLines)).to
        }) });
      });
    };
    schedule();
    return { update(update) {
      if (update.viewportChanged || update.docChanged
        || isLiveInputDerivedWorkPending(update.startState) && !isLiveInputDerivedWorkPending(update.state)) schedule();
    },
      destroy() {
        disposed = true;
        if (compositionFrame !== null) window.cancelAnimationFrame(compositionFrame);
        compositionFrame = null;
      } };
  })];
}

export function livePresentationBandChanged(transaction: Transaction): boolean {
  return getLivePresentationBand(transaction.startState) !== getLivePresentationBand(transaction.state);
}
