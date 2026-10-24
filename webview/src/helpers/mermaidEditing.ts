import { editorScrollIntoView } from '../editor/scrollEffects';
import { mapLiveWidgetPositions, liveWidgetPositionsIndependent } from '../editor/liveWidgetPositions';
import { EditorSelection, MapMode, StateEffect, StateField, type ChangeDesc, type EditorState } from '@codemirror/state';
import { BlockType, Decoration, EditorView, ViewPlugin, WidgetType, type ViewUpdate } from '@codemirror/view';
import { createElement, Check, Pencil, Columns2, Rows2 } from 'lucide';
import { getUiStrings, type UiLanguage } from '../application/uiLanguage';
import {
  chooseMermaidEditingLayout,
  MERMAID_SIDE_MIN_WIDTH,
  type MermaidEditingLayout
} from '../editor/mermaidEditingLayout';
import { getMermaidDiagramPresentationFactory } from '../editor/mermaidDiagramPresentation';
import { UiLanguageSensitiveWidget, uiLanguageFacet } from '../editor/uiLanguage';
import { setLivePointerSelectionActiveEffect, sourcePresentationSelection } from '../editor/livePointerSelection';
import { supersedeLiveInputDerivedWork } from '../editor/liveInputDerivedWork';
import {
  MermaidDiagramWidget,
  createMermaidViewportState,
  type MermaidViewportState
} from './mermaidDiagram';
import { createCopyCodeButton, createSelectAllCodeButton } from './codeBlockControls';
import { createRenderedBlockImageButton } from './renderedBlockImage';
import {
  applyLiveBlockIndent,
  liveBlockIndentKey,
  parseBlockLinePrefix,
  type LiveBlockIndentValue
} from './blockIndent';
import { getViewportController } from './viewportController';
import { mermaidSourceAt, mermaidSourceForAnchor, selectMermaidSource } from './mermaidSource';
import { retainRenderedBlockModePointerFocus } from './renderedBlockModeControls';
import { focusRenderedBlockAction } from './renderedBlockActionFocus';
import { focusBlockReading, isBlockReading } from '../editor/blockInteraction';

export type MermaidBlockMode = 'preview' | 'edit';
type MermaidSearchReveal = { from: number; to: number } | null;
type MermaidEditingState = {
  activeAnchor: number | null;
  layouts: Map<number, MermaidEditingLayout>;
  searchReveal: MermaidSearchReveal;
  viewports: Map<number, MermaidViewportState>;
  narrow: boolean;
  sideSpace: number;
};
export const setMermaidLayoutEffect = StateEffect.define<{ anchor: number; layout: MermaidEditingLayout }>();
export const setMermaidSearchRevealEffect = StateEffect.define<MermaidSearchReveal>();
const setMermaidNarrowEffect = StateEffect.define<boolean>();
const setMermaidSideSpaceEffect = StateEffect.define<{ anchor: number; height: number }>();

/** Includes adaptive layout receipts without exposing their state mutation API. */
export function isMermaidPresentationEffect(effect: StateEffect<unknown>): boolean {
  return effect.is(setMermaidLayoutEffect) || effect.is(setMermaidSearchRevealEffect)
    || effect.is(setMermaidNarrowEffect) || effect.is(setMermaidSideSpaceEffect);
}


const mermaidOpeningLineRegex = /^[ \t]{0,3}(?:`{3,}|~{3,})\s*mermaid\b/i;
export function isMermaidOpeningLine(lineText: string): boolean {
  return mermaidOpeningLineRegex.test(lineText);
}
function isMermaidAnchor(state: EditorState, anchor: number): boolean {
  if (!Number.isFinite(anchor) || anchor < 0 || anchor > state.doc.length) return false;
  const line = state.doc.lineAt(anchor);
  return (
    line.from === anchor &&
    /^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(?:`{3,}|~{3,})\s*mermaid\b/i.test(
      parseBlockLinePrefix(line.text, state.tabSize).content
    )
  );
}

export const mermaidEditingStateField = StateField.define<MermaidEditingState>({
  create: () => ({
    activeAnchor: null,
    layouts: new Map(),
    searchReveal: null,
    viewports: new Map(),
    narrow: false,
    sideSpace: 0
  }),
  update(value, transaction) {
    const pointerPresentationChanged = transaction.effects.some(effect => effect.is(setLivePointerSelectionActiveEffect));
    if (!transaction.docChanged && !transaction.selection && !transaction.reconfigured
      && !pointerPresentationChanged && !transaction.effects.some(isMermaidPresentationEffect)) return value;
    const layouts = new Map<number, MermaidEditingLayout>(),
      viewports = new Map<number, MermaidViewportState>();
    const mapped = (anchor: number): number | null => {
      if (!transaction.docChanged) return anchor;
      const line = transaction.startState.doc.lineAt(anchor),
        fence = anchor + line.text.search(/`{3,}|~{3,}/);
      const position = transaction.changes.mapPos(fence, 1, MapMode.TrackAfter);
      if (position === null) return null;
      const next = transaction.state.doc.lineAt(position).from;
      return isMermaidAnchor(transaction.state, next) ? next : null;
    };
    for (const [anchor, layout] of value.layouts) {
      const next = mapped(anchor);
      if (next !== null) layouts.set(next, layout);
    }
    for (const [anchor, viewport] of value.viewports) {
      const next = mapped(anchor);
      if (next !== null) viewports.set(next, viewport);
    }
    let searchReveal = value.searchReveal,
      narrow = value.narrow;
    if (searchReveal && transaction.docChanged)
      searchReveal = {
        from: transaction.changes.mapPos(searchReveal.from, 1),
        to: transaction.changes.mapPos(searchReveal.to, -1)
      };
    let revealing = false;
    for (const effect of transaction.effects) {
      if (effect.is(setMermaidLayoutEffect)) layouts.set(effect.value.anchor, effect.value.layout);
      if (effect.is(setMermaidNarrowEffect)) narrow = effect.value;
      if (effect.is(setMermaidSearchRevealEffect)) {
        searchReveal = effect.value;
        revealing = true;
      }
    }
    if (transaction.selection && !revealing) searchReveal = null;
    let activeAnchor = value.activeAnchor === null ? null : mapped(value.activeAnchor);
    const previousActive = activeAnchor;
    if (transaction.selection || transaction.docChanged || pointerPresentationChanged) {
      // The source/canvas layout follows the same held selection as its
      // decorations. Native hit testing may already point below the block.
      const selection = sourcePresentationSelection(transaction.state).main;
      const touches = (source: ReturnType<typeof mermaidSourceAt>) =>
        source &&
        (selection.empty
          ? selection.head >= source.opening.from && selection.head <= source.closing.to
          : selection.from <= source.closing.to && selection.to >= source.opening.from);
      const active = activeAnchor === null ? null : mermaidSourceForAnchor(transaction.state, activeAnchor);
      // A drag may cross other blocks or end outside the fence. Keep the chart
      // that owned this edit session while its source remains in the selection.
      if (!touches(active)) {
        const candidate =
          mermaidSourceAt(transaction.state, selection.head) ??
          (!selection.empty ? mermaidSourceAt(transaction.state, selection.anchor) : null);
        activeAnchor = touches(candidate) ? candidate!.anchor : null;
      }
    }
    let sideSpace = activeAnchor === previousActive ? value.sideSpace : 0;
    for (const effect of transaction.effects) {
      if (effect.is(setMermaidSideSpaceEffect) && effect.value.anchor === activeAnchor)
        sideSpace = effect.value.height;
    }
    return { activeAnchor, layouts, viewports, searchReveal, narrow, sideSpace };
  }
});

export function getMermaidBlockViewport(state: EditorState, anchor: number): MermaidViewportState {
  const viewports = state.field(mermaidEditingStateField, false)?.viewports;
  let viewport = viewports?.get(anchor);
  if (!viewport) {
    viewport = createMermaidViewportState();
    viewports?.set(anchor, viewport);
  }
  return viewport;
}
export function getMermaidBlockMode(
  state: EditorState,
  anchor: number,
  blockTo: number
) {
  const value = state.field(mermaidEditingStateField, false),
    searchReveal = value?.searchReveal;
  const editing = !isBlockReading(state, anchor, blockTo) && (
    sourcePresentationSelection(state).ranges.some((range) =>
      range.empty
        ? range.head >= anchor && range.head <= blockTo
        : range.from <= blockTo && range.to >= anchor
    ) || Boolean(searchReveal && searchReveal.from <= blockTo && searchReveal.to >= anchor));
  const mode: MermaidBlockMode = editing ? 'edit' : 'preview';
  const ownsSide = value?.activeAnchor === anchor;
  const layout: MermaidEditingLayout =
    !value?.narrow && ownsSide ? (value?.layouts.get(anchor) ?? 'stacked') : 'stacked';
  return {
    manual: mode,
    decision: { effectiveMode: mode },
    layout,
    searchReveal: searchReveal ?? null,
    sideSpace: ownsSide ? (value?.sideSpace ?? 0) : 0
  };
}
function activeMermaidSource(state: EditorState) {
  const anchor = state.field(mermaidEditingStateField, false)?.activeAnchor;
  return anchor == null ? null : mermaidSourceForAnchor(state, anchor);
}
function blockMode(view: EditorView, anchor: number) {
  const source = mermaidSourceForAnchor(view.state, anchor);
  return source ? getMermaidBlockMode(view.state, anchor, source.closing.to) : null;
}
function chartFor(view: EditorView, anchor: number): HTMLElement | null {
  const line = view.state.doc.lineAt(anchor).number;
  return view.dom.querySelector<HTMLElement>(
    `.meo-rendered-block-preview[data-meo-rendered-block-start-line="${line}"] .meo-mermaid-block, ` +
      `.meo-mermaid-editing-preview[data-meo-mermaid-anchor="${anchor}"] .meo-mermaid-block`
  );
}
function initialLayout(view: EditorView, anchor: number): MermaidEditingLayout {
  const source = mermaidSourceForAnchor(view.state, anchor);
  if (!source) return 'stacked';
  const width = view.dom.clientWidth,
    height = view.scrollDOM.clientHeight;
  const box = chartFor(view, anchor)?.querySelector<SVGSVGElement>('svg')?.viewBox.baseVal;
  const diagram = box && box.width > 0 && box.height > 0 ? { width: box.width, height: box.height } : null;
  const lineHeight = parseFloat(getComputedStyle(view.contentDOM).lineHeight) || 22;
  const columns = Math.max(20, Math.floor((width - 80) / (lineHeight * 0.45)));
  const sourceRows = source.source
    .split('\n')
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(line.length / columns)), 0);
  return chooseMermaidEditingLayout({ width, height, diagram, sourceRows, lineHeight });
}
export function focusMermaidEditingOffset(
  view: EditorView,
  anchor: number,
  offset: number,
  isCurrent = () => true
): boolean {
  if (!isCurrent()) return false;
  const source = mermaidSourceForAnchor(view.state, anchor);
  if (!source) return false;
  const layouts = view.state.field(mermaidEditingStateField).layouts;
  const effects = layouts.has(anchor)
    ? []
    : [setMermaidLayoutEffect.of({ anchor, layout: initialLayout(view, anchor) })];
  const position = Math.max(source.opening.from, Math.min(source.closing.to, source.lines[0]!.from + offset));
  view.dispatch({
    selection: EditorSelection.cursor(position),
    effects: [...effects, supersedeLiveInputDerivedWork()]
  });
  view.focus();
  return true;
}
function setMermaidEditingMode(view: EditorView, anchor: number, editing: boolean, isCurrent: () => boolean): void {
  const source = mermaidSourceForAnchor(view.state, anchor);
  if (!source || !isCurrent()) return;
  if (!editing) {
    focusBlockReading(view, { kind: 'mermaid', from: source.opening.from, to: source.closing.to },
      [setMermaidSearchRevealEffect.of(null), supersedeLiveInputDerivedWork()]);
    return;
  }
  const controller = getViewportController(view);
  const resolveToolbar = () => view.dom.querySelector<HTMLElement>(
    `.meo-mermaid-toolbar[data-meo-block-from="${anchor}"]:not([data-meo-floating])`
  );
  const toolbar = resolveToolbar(), rect = toolbar?.getBoundingClientRect();
  // Caret scroll margins reserve room for a future sticky header even while
  // this original header is visible. Block-head visibility uses painted bounds.
  const bounds = view.scrollDOM.getBoundingClientRect();
  const mutate = () => focusMermaidEditingOffset(view, anchor, 0, isCurrent);
  // Both directions use the original header, never the caret or sticky copy.
  // Fix the target before changing mode so layout settlement cannot re-decide it.
  const visible = rect && rect.height > 0 && rect.top >= bounds.top && rect.bottom <= bounds.bottom;
  const top = visible ? rect.top : bounds.top + 8;
  if (controller) {
    controller.retainElementTopWhileMutation(toolbar, resolveToolbar, mutate, isCurrent, { position: anchor, top });
    return;
  }
  mutate();
  if (!visible && isCurrent()) {
    view.dispatch({ effects: editorScrollIntoView(anchor, { y: 'start', yMargin: 8 }) });
  }
}
export function finishMermaidEditing(view: EditorView): boolean {
  if (!view.dom.classList.contains('meo-mode-live') || view.composing || view.state.selection.ranges.length !== 1) return false;
  const source = activeMermaidSource(view.state) ?? mermaidSourceAt(view.state);
  if (!source || blockMode(view, source.anchor)?.manual !== 'edit') return false;
  const selection = view.state.selection.main;
  if (selection.from < source.opening.from || selection.to > source.closing.to) return false;
  const isCurrent = getViewportController(view)?.beginNavigationReveal() ?? (() => true);
  setMermaidEditingMode(view, source.anchor, false, isCurrent);
  return true;
}
function toggleLayout(view: EditorView, anchor: number): void {
  const current = blockMode(view, anchor);
  if (!current) return;
  const controller = getViewportController(view);
  const mutate = () =>
    view.dispatch({
      effects: setMermaidLayoutEffect.of({
        anchor,
        layout: current.layout === 'stacked' ? 'side-by-side' : 'stacked'
      })
    });
  if (controller) controller.preservePositionWhileMutation(anchor, mutate);
  else mutate();
}

function updateMermaidLayoutButton(button: HTMLButtonElement, view: EditorView, narrow: boolean): void {
  const anchor = Number(button.closest<HTMLElement>('[data-meo-mermaid-anchor]')?.dataset.meoMermaidAnchor);
  const strings = getUiStrings(view.state.facet(uiLanguageFacet));
  const side = blockMode(view, anchor)?.layout === 'side-by-side';
  const caption = side ? strings.mermaidStackedAction : strings.mermaidSideBySideAction;
  if (button.textContent !== caption) {
    const label = button.ownerDocument.createElement('span');
    label.className = 'meo-mermaid-layout-caption';
    label.textContent = caption;
    button.replaceChildren(
      createElement(side ? Rows2 : Columns2, { width: 15, height: 15, 'aria-hidden': 'true' }),
      label
    );
  }
  const label = narrow ? strings.mermaidNarrowLayout : side ? strings.mermaidStacked : strings.mermaidSideBySide;
  button.disabled = narrow;
  button.setAttribute('aria-label', label);
  button.dataset.tooltip = label;
  button.dataset.tooltipLiveUpdate = 'true';
}

class MermaidToolbarWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc, state: EditorState): WidgetType {
    const anchor = changes.mapPos(this.anchor, 1), blockTo = changes.mapPos(this.blockTo, -1);
    const line = state.doc.lineAt(anchor).number;
    return anchor === this.anchor && blockTo === this.blockTo && line === this.lineNumber ? this
      : new MermaidToolbarWidget(anchor, line, this.mode, this.codeContent, blockTo, this.floating, this.language);
  }
  constructor(
    readonly anchor: number,
    readonly lineNumber: number,
    readonly mode: MermaidBlockMode,
    readonly codeContent: string,
    readonly blockTo: number,
    readonly floating = false,
    readonly language: UiLanguage = 'en'
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof MermaidToolbarWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.anchor === this.anchor &&
      other.mode === this.mode &&
      other.language === this.language &&
      other.codeContent === this.codeContent &&
      other.blockTo === this.blockTo
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const toolbar = view.dom.ownerDocument.createElement('span');
    toolbar.className = 'meo-mermaid-toolbar';
    toolbar.dataset.meoBlockFrom = String(this.anchor);
    if (this.floating) toolbar.dataset.meoFloating = 'true';
    toolbar.setAttribute('role', 'group');
    toolbar.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
    });
    const anchor = () => {
      const current = Number(toolbar.dataset.meoBlockFrom);
      return isMermaidAnchor(view.state, current) ? current : null;
    };
    const language = view.state.facet(uiLanguageFacet);
    const mode = document.createElement('button');
    mode.type = 'button';
    mode.className = 'meo-mermaid-mode-btn';
    retainRenderedBlockModePointerFocus(mode);
    mode.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = anchor();
      if (current === null) return;
      const isCurrent = getViewportController(view)?.beginNavigationReveal() ?? (() => true);
      const closing = blockMode(view, current)?.manual === 'edit';
      setMermaidEditingMode(view, current, !closing, isCurrent);
    });
    const select = createSelectAllCodeButton(() => {
      const current = anchor();
      if (current !== null) selectMermaidSource(view, current);
    }, language);
    const image = createRenderedBlockImageButton(
      () => {
        const current = anchor();
        if (current === null) return null;
        const chart = chartFor(view, current);
        return chart &&
          !chart.closest('[data-meo-mermaid-rendering="true"]') &&
          !chart.querySelector('.meo-mermaid-error-badge') &&
          chart.querySelector('svg')
          ? chart
          : null;
      },
      language,
      toolbar.ownerDocument
    );
    image.classList.add('meo-code-block-pill');
    const copy = createCopyCodeButton(() => {
      const current = anchor();
      return current === null ? '' : (mermaidSourceForAnchor(view.state, current)?.source ?? '');
    }, language);
    toolbar.append(mode, select, image, copy);
    this.updateDOM(toolbar, view);
    return toolbar;
  }
  updateDOM(toolbar: HTMLElement, view: EditorView): boolean {
    if (toolbar.dataset.meoUiLanguage && toolbar.dataset.meoUiLanguage !== view.state.facet(uiLanguageFacet))
      return false;
    const strings = getUiStrings(view.state.facet(uiLanguageFacet));
    toolbar.dataset.meoBlockFrom = String(this.anchor);
    toolbar.dataset.meoBlockTo = String(this.blockTo);
    toolbar.dataset.meoMermaidMode = this.mode;
    toolbar.dataset.meoUiLanguage = view.state.facet(uiLanguageFacet);
    toolbar.setAttribute('aria-label', strings.mermaidBlockControls(this.lineNumber));
    const editing = this.mode === 'edit',
      mode = toolbar.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')!;
    const label = editing ? strings.hideMermaidSource : strings.editMermaidSource;
    if (mode.getAttribute('aria-label') !== label) {
      mode.replaceChildren(createElement(editing ? Check : Pencil, { width: 15, height: 15, 'aria-hidden': 'true' }));
      mode.setAttribute('aria-label', label);
      mode.dataset.tooltip = label;
      mode.dataset.tooltipLiveUpdate = 'true';
    }
    toolbar.querySelector<HTMLElement>('.meo-select-all-code-btn')!.hidden = !editing;
    return true;
  }
  ignoreEvent(): boolean {
    return true;
  }
}
export function createMermaidToolbarWidget(
  anchor: number,
  lineNumber: number,
  mode: MermaidBlockMode,
  codeContent: string,
  blockTo: number,
  language: UiLanguage = 'en'
): WidgetType {
  return new MermaidToolbarWidget(anchor, lineNumber, mode, codeContent, blockTo, false, language);
}
export function createFloatingMermaidToolbarWidget(
  anchor: number,
  lineNumber: number,
  mode: MermaidBlockMode,
  codeContent: string,
  blockTo: number,
  language: UiLanguage = 'en'
): WidgetType {
  return new MermaidToolbarWidget(anchor, lineNumber, mode, codeContent, blockTo, true, language);
}
export function addMermaidToolbar(
  builder: any[],
  position: number,
  anchor: number,
  line: number,
  mode: MermaidBlockMode,
  source: string,
  to: number,
  language: UiLanguage
): void {
  builder.push(
    Decoration.widget({
      widget: createMermaidToolbarWidget(anchor, line, mode, source, to, language),
      side: 1
    }).range(position)
  );
}

type PreviewElement = HTMLElement & {
  mermaidPreview?: { widget: MermaidDiagramWidget; timer?: number; source: string; viewport: MermaidViewportState };
};
/** The same preview action is used in document flow and opaque floating chrome. */
export function createMermaidPreviewHeading(view: EditorView, anchor: number): HTMLElement {
  const label = document.createElement('div');
  label.className = 'meo-native-source-preview-label';
  label.dataset.meoMermaidAnchor = String(anchor);
  const title = document.createElement('span');
  title.textContent = getUiStrings(view.state.facet(uiLanguageFacet)).preview;
  const layout = document.createElement('button');
  layout.type = 'button';
  layout.className = 'meo-mermaid-layout-btn';
  layout.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  layout.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const current = Number(label.dataset.meoMermaidAnchor);
    if (!isMermaidAnchor(view.state, current) || layout.disabled) return;
    toggleLayout(view, current);
    if (event.detail === 0) {
      const focusNext = () => {
        const floating = blockMode(view, current)?.layout === 'side-by-side'
          ? view.dom.querySelector<HTMLButtonElement>('.meo-block-sticky-header:not([hidden]) .meo-mermaid-layout-btn') : null;
        const next = floating ?? view.dom.querySelector<HTMLButtonElement>(
          `.meo-mermaid-editing-preview[data-meo-mermaid-anchor="${current}"] .meo-mermaid-layout-btn`
        );
        if (next) focusRenderedBlockAction(next, false);
        return !!next;
      };
      requestAnimationFrame(() => {
        if (focusNext() || blockMode(view, current)?.manual !== 'edit') return;
        // Long stacked source can leave its new preview virtualized below the viewport.
        const source = mermaidSourceForAnchor(view.state, current);
        if (!source) return;
        const controller = getViewportController(view);
        if (controller) {
          const isCurrent = controller.beginNavigationReveal();
          controller.revealPosition(source.closing.from, { y: 'start', yMargin: 40 }, isCurrent);
          void controller.whenPresentationSettled(1000, isCurrent).then(() => {
            if (isCurrent()) focusNext();
          });
        } else {
          view.dispatch({ effects: editorScrollIntoView(source.closing.from, { y: 'start', yMargin: 40 }) });
          requestAnimationFrame(focusNext);
        }
      });
    }
  });
  label.append(title, layout);
  updateMermaidLayoutButton(layout, view,
    view.state.field(mermaidEditingStateField).narrow || view.dom.clientWidth < MERMAID_SIDE_MIN_WIDTH);
  return label;
}

export class MermaidSourcePreviewWidget extends UiLanguageSensitiveWidget {
  [mapLiveWidgetPositions](changes: ChangeDesc, state: EditorState): WidgetType {
    const anchor = changes.mapPos(this.anchor, 1), startLine = state.doc.lineAt(anchor).number;
    return anchor === this.anchor && startLine === this.startLine ? this
      : new MermaidSourcePreviewWidget(anchor, this.source, startLine, this.endLine + startLine - this.startLine,
        this.indent, this.language, this.viewport);
  }
  constructor(
    readonly anchor: number,
    readonly source: string,
    readonly startLine: number,
    readonly endLine: number,
    readonly indent: LiveBlockIndentValue,
    readonly language: UiLanguage,
    readonly viewport: MermaidViewportState
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof MermaidSourcePreviewWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      this.anchor === other.anchor &&
      this.source === other.source &&
      this.viewport === other.viewport &&
      this.language === other.language &&
      liveBlockIndentKey(this.indent) === liveBlockIndentKey(other.indent)
    );
  }
  toDOM(view: EditorView): HTMLElement {
    const root = document.createElement('div') as PreviewElement;
    root.className = 'meo-mermaid-editing-preview';
    root.contentEditable = 'false';
    root.dataset.meoMermaidAnchor = String(this.anchor);
    root.dataset.meoUiLanguage = view.state.facet(uiLanguageFacet);
    applyLiveBlockIndent(root, this.indent);
    const label = createMermaidPreviewHeading(view, this.anchor);
    const widget = new MermaidDiagramWidget(this.source, this.startLine, this.endLine, {
      presentationFactory: getMermaidDiagramPresentationFactory(view.state),
      viewportState: this.viewport,
      cachePreviewHeight: false,
      uiLanguage: view.state.facet(uiLanguageFacet)
    });
    root.append(label, widget.toDOM(view));
    root.mermaidPreview = { widget, source: this.source, viewport: this.viewport };
    return root;
  }
  updateDOM(root: PreviewElement, view: EditorView): boolean {
    if (root.dataset.meoUiLanguage !== view.state.facet(uiLanguageFacet)) return false;
    const preview = root.mermaidPreview;
    // Replacing the entire fenced block creates a new camera, even at the same position.
    if (!preview || preview.viewport !== this.viewport) return false;
    root.dataset.meoMermaidAnchor = String(this.anchor);
    root.querySelector<HTMLElement>('.meo-native-source-preview-label')!.dataset.meoMermaidAnchor = String(this.anchor);
    updateMermaidLayoutButton(root.querySelector<HTMLButtonElement>('.meo-mermaid-layout-btn')!, view,
      view.state.field(mermaidEditingStateField).narrow || view.dom.clientWidth < MERMAID_SIDE_MIN_WIDTH);
    if (preview.source === this.source) {
      preview.widget.updateSource(this.source, this.startLine, this.endLine);
      return true;
    }
    preview.source = this.source;
    root.dataset.meoMermaidRendering = 'true';
    clearTimeout(preview.timer);
    preview.timer = window.setTimeout(() => {
      preview.timer = undefined;
      preview.widget.updateSource(preview.source, this.startLine, this.endLine);
      delete root.dataset.meoMermaidRendering;
    }, 80);
    return true;
  }
  destroy(root: PreviewElement): void {
    clearTimeout(root.mermaidPreview?.timer);
    root.mermaidPreview?.widget.destroy();
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Only reserves the height missing below short source; it never owns input. */
export class MermaidSideSpaceWidget extends WidgetType {
  readonly [liveWidgetPositionsIndependent] = true;
  [mapLiveWidgetPositions](): WidgetType { return this; }
  constructor(
    readonly height: number,
    readonly indent: LiveBlockIndentValue
  ) {
    super();
  }
  eq(other: WidgetType): boolean {
    return (
      other instanceof MermaidSideSpaceWidget &&
      other.height === this.height &&
      liveBlockIndentKey(other.indent) === liveBlockIndentKey(this.indent)
    );
  }
  get estimatedHeight(): number {
    return this.height;
  }
  toDOM(): HTMLElement {
    const root = document.createElement('div');
    root.className = 'meo-mermaid-side-space';
    root.style.height = this.height + 'px';
    root.contentEditable = 'false';
    applyLiveBlockIndent(root, this.indent);
    return root;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function mermaidTextBlockAt(view: EditorView, position: number) {
  const line = view.lineBlockAt(position),
    parts = line.type;
  return typeof parts === 'number'
    ? line
    : (parts.find((part) => part.type === BlockType.Text && part.from <= position && part.to >= position) ??
        line);
}

/** The native source stays in document flow. Only its derived canvas is placed beside it. */
class MermaidInlinePreview {
  private panel: HTMLElement | null = null;
  private preview: PreviewElement | null = null;
  private presenter: MermaidSourcePreviewWidget | null = null;
  private sourceShare = 40;
  private minimumPreviewWidth = 280;
  private bounds = { left: 0, width: 1, minShare: 30, maxShare: 65 };
  private disposed = false;
  constructor(private readonly view: EditorView) {
    this.schedule();
  }
  update(update: ViewUpdate): void {
    if (
      update.docChanged ||
      update.selectionSet ||
      update.viewportChanged ||
      update.geometryChanged ||
      update.transactions.some((transaction) => transaction.effects.length)
    )
      this.schedule();
  }
  private schedule(): void {
    if (this.disposed) return;
    this.view.requestMeasure({
      key: this,
      read: () => this.measure(),
      write: (result) => {
        if (!this.disposed) this.draw(result);
      }
    });
  }
  private measure() {
    const view = this.view;
    const source = activeMermaidSource(view.state),
      mode = source && blockMode(view, source.anchor);
    const position = source && Math.max(source.opening.from, Math.min(source.closing.to, view.state.selection.main.head));
    const node = position == null ? null : view.domAtPos(position).node;
    const row = view.dom.querySelector<HTMLElement>('.meo-mermaid-inline-source,.meo-mermaid-side-space')
      ?? (node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.cm-line');
    const block = row?.getBoundingClientRect();
    const blockWidth = block ? block.width / view.scaleX : 0;
    const heading = source && view.dom.querySelector<HTMLElement>(
      `.meo-mermaid-editing-preview[data-meo-mermaid-anchor="${source.anchor}"] .meo-native-source-preview-label`
    );
    const toolbar = source && view.dom.querySelector<HTMLElement>(`.meo-mermaid-toolbar[data-meo-block-from="${source.anchor}"]`);
    const actionsWidth = toolbar ? toolbar.getBoundingClientRect().width / view.scaleX : 100;
    if (heading) {
      const [title, action] = Array.from(heading.children);
      if (title && action) this.minimumPreviewWidth = Math.ceil(
        (title.getBoundingClientRect().width + action.getBoundingClientRect().width) / view.scaleX
        + actionsWidth + 40
      );
    }
    const narrow = view.dom.clientWidth < MERMAID_SIDE_MIN_WIDTH
      || !!blockWidth && blockWidth < this.minimumPreviewWidth + 200;
    if (!source || mode?.manual !== 'edit' || mode.layout !== 'side-by-side' || narrow)
      return { narrow, source: null, geometry: null };
    if (!block) return { narrow, source, geometry: null };
    const minShare = Math.max(30, 200 / blockWidth * 100);
    const maxShare = Math.min(65, (1 - this.minimumPreviewWidth / blockWidth) * 100);
    const sourceShare = Math.max(minShare, Math.min(maxShare, this.sourceShare));
    const first = mermaidTextBlockAt(view, source.opening.from);
    const last = mermaidTextBlockAt(view, source.closing.from);
    const sourceHeight = Math.max(view.defaultLineHeight, last.bottom - first.top);
    // The scroller already excludes editor chrome; the canvas includes its own heading.
    const viewportHeight = Math.max(160, view.scrollDOM.clientHeight);
    const space = Math.ceil(Math.max(0, Math.min(480, viewportHeight) - sourceHeight));
    const scroller = view.scrollDOM.getBoundingClientRect();
    // DOM rectangles include CSS scaling; CodeMirror block heights use editor pixels.
    const width = blockWidth * (1 - sourceShare / 100);
    return {
      narrow,
      source,
      geometry: {
        top: (view.documentTop - scroller.top) / view.scaleY + first.top + view.scrollDOM.scrollTop,
        left: (block.right - scroller.left) / view.scaleX + view.scrollDOM.scrollLeft - width,
        width,
        height: sourceHeight + space,
        canvasHeight: Math.min(sourceHeight + space, viewportHeight),
        space,
        blockLeft: block.left,
        blockWidth: block.width,
        minShare, maxShare, sourceShare, actionsWidth
      }
    };
  }
  private draw({ narrow, source, geometry }: ReturnType<MermaidInlinePreview['measure']>): void {
    const view = this.view,
      strings = getUiStrings(view.state.facet(uiLanguageFacet));
    for (const button of view.dom.querySelectorAll<HTMLButtonElement>('.meo-mermaid-layout-btn')) {
      updateMermaidLayoutButton(button, view, narrow);
    }
    if (narrow !== view.state.field(mermaidEditingStateField).narrow) {
      queueMicrotask(() => {
        if (!this.disposed) view.dispatch({ effects: setMermaidNarrowEffect.of(narrow) });
      });
      return;
    }
    if (!source) {
      this.clear();
      return;
    }
    if (!geometry) {
      if (this.panel) this.panel.hidden = true;
      return;
    }
    const next = new MermaidSourcePreviewWidget(
      source.anchor,
      source.source,
      source.opening.number,
      source.closing.number,
      0,
      view.state.facet(uiLanguageFacet),
      getMermaidBlockViewport(view.state, source.anchor)
    );
    let replacing = false;
    if (
      !this.panel ||
      this.panel.dataset.meoMermaidAnchor !== String(source.anchor) ||
      !this.preview ||
      !next.updateDOM(this.preview, view)
    ) {
      replacing = true;
      this.clear();
      this.panel = document.createElement('aside');
      this.panel.className = 'meo-mermaid-inline-preview';
      this.panel.setAttribute('aria-label', strings.mermaidCurrentPreview);
      this.panel.dataset.meoMermaidAnchor = String(source.anchor);
      this.preview = next.toDOM(view) as PreviewElement;
      const separator = document.createElement('div');
      separator.className = 'meo-mermaid-inline-separator';
      separator.tabIndex = 0;
      separator.setAttribute('role', 'separator');
      separator.setAttribute('aria-orientation', 'vertical');
      separator.setAttribute('aria-label', strings.mermaidResizePreview);
      separator.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        separator.setPointerCapture(event.pointerId);
      });
      separator.addEventListener('pointermove', (event) => {
        if (separator.hasPointerCapture(event.pointerId))
          this.setShare(((event.clientX - this.bounds.left) / this.bounds.width) * 100);
      });
      separator.addEventListener('pointerup', (event) => {
        if (separator.hasPointerCapture(event.pointerId)) separator.releasePointerCapture(event.pointerId);
      });
      separator.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        event.stopPropagation();
        const visibleShare = Math.max(this.bounds.minShare, Math.min(this.bounds.maxShare, this.sourceShare));
        this.setShare(visibleShare + (event.key === 'ArrowLeft' ? -5 : 5));
      });
      this.panel.append(this.preview, separator);
      view.scrollDOM.append(this.panel);
    }
    this.presenter = next;
    this.panel.hidden = false;
    this.bounds = { left: geometry.blockLeft, width: geometry.blockWidth, minShare: geometry.minShare, maxShare: geometry.maxShare };
    const separator = this.panel.querySelector('[role="separator"]')!;
    separator.setAttribute('aria-valuemin', String(Math.round(geometry.minShare)));
    separator.setAttribute('aria-valuemax', String(Math.round(geometry.maxShare)));
    separator.setAttribute('aria-valuenow', String(Math.round(geometry.sourceShare)));
    view.dom.style.setProperty('--meo-mermaid-preview-share', String(1 - geometry.sourceShare / 100));
    this.panel.style.setProperty('--meo-mermaid-actions-width', geometry.actionsWidth + 'px');
    const { top, left, width, height, canvasHeight, space } = geometry;
    Object.assign(this.panel.style, {
      top: top + 'px',
      left: left + 'px',
      width: width + 'px',
      height: height + 'px'
    });
    this.preview!.style.height = canvasHeight + 'px';
    if (replacing) this.schedule();
    if (view.state.field(mermaidEditingStateField).sideSpace !== space)
      queueMicrotask(() => {
        if (!this.disposed)
          view.dispatch({
            effects: setMermaidSideSpaceEffect.of({ anchor: source.anchor, height: space })
          });
      });
  }
  private setShare(share: number): void {
    this.sourceShare = Math.max(this.bounds.minShare, Math.min(this.bounds.maxShare, share));
    this.schedule();
  }
  private clear(): void {
    if (!this.panel) return;
    if (this.preview) this.presenter?.destroy(this.preview);
    this.panel.remove();
    this.panel = this.preview = null;
    this.presenter = null;
    this.view.requestMeasure();
  }
  destroy(): void {
    this.disposed = true;
    this.clear();
    this.view.dom.style.removeProperty('--meo-mermaid-preview-share');
  }
}
export const mermaidInlinePreviewExtension = ViewPlugin.fromClass(MermaidInlinePreview);
