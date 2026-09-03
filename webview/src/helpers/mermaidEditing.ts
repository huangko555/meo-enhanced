import { EditorSelection, EditorState, StateEffect, StateField, Transaction } from '@codemirror/state';
import { EditorView, Decoration, WidgetType, keymap, lineNumbers, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, indentLess, indentMore } from '@codemirror/commands';
import {
  getCachedMermaidPreviewHeight,
  MermaidDiagramWidget
} from './mermaidDiagram';
import {
  getMermaidDiagramPresentationFactory,
  type MermaidDiagramPresentationConsumer
} from '../editor/mermaidDiagramPresentation';
import { createCopyCodeButton, createSelectAllCodeButton } from './codeBlockControls';
import { getViewportController, visualLineContextMargin } from './viewportController';
import { applyLiveBlockIndent } from './blockIndent';
import { consumeEditorHistoryCommand } from './historyCommands';
import {
  markLiveInputNestedProjection,
  replaceLiveInputNestedDecoration,
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
import { shikiDocumentHighlight } from './shikiDecorations';

export type MermaidBlockMode = RenderedBlockMode;

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
  sourceLinePrefix: string;
  startLine: number;
  endLine: number;
  indentColumns: number;
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

const mermaidOpeningLineRegex = /^[ \t]{0,3}(?:`{3,}|~{3,})\s*mermaid\b/i;

export function isMermaidOpeningLine(lineText: string): boolean {
  return mermaidOpeningLineRegex.test(lineText);
}

function isMermaidAnchor(state: EditorState, anchor: number): boolean {
  if (anchor < 0 || anchor > state.doc.length) {
    return false;
  }
  const line = state.doc.lineAt(anchor);
  return line.from === anchor && isMermaidOpeningLine(line.text);
}

function resolveMermaidAnchorAtLine(state: EditorState, lineNumber: number): number | null {
  if (!Number.isInteger(lineNumber) || lineNumber < 1 || lineNumber > state.doc.lines) {
    return null;
  }
  const anchor = state.doc.line(lineNumber).from;
  return isMermaidAnchor(state, anchor) ? anchor : null;
}

function resolveMermaidToolbarAnchor(
  view: EditorView,
  toolbar: HTMLElement,
  fallbackLineNumber: number
): number | null {
  const declaredAnchor = Number.parseInt(toolbar.dataset.meoBlockFrom ?? '', 10);
  if (Number.isFinite(declaredAnchor) && isMermaidAnchor(view.state, declaredAnchor)) {
    return declaredAnchor;
  }
  try {
    const position = view.posAtDOM(toolbar);
    const line = view.state.doc.lineAt(Math.max(0, Math.min(position, view.state.doc.length)));
    if (isMermaidAnchor(view.state, line.from)) return line.from;
  } catch {
    // A detached toolbar cannot provide a current DOM position. The line
    // fallback still supports retained widgets whose block did not move.
  }
  return resolveMermaidAnchorAtLine(view.state, fallbackLineNumber);
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
): {
  manual: MermaidBlockMode;
  decision: RenderedBlockModeShellDecision;
  searchReveal: MermaidSearchReveal;
} {
  const editingState = state.field(mermaidEditingStateField, false);
  const manual = editingState?.modes.get(anchor) ?? 'preview';
  const searchReveal = editingState?.searchReveal ?? null;
  const searchInside = Boolean(
    searchReveal &&
    searchReveal.from < contentTo &&
    searchReveal.to > contentFrom
  );
  const decision = decideRenderedBlockModeShell({
    kind: 'mermaid',
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

const mermaidToolbarCodeContent = Symbol('mermaidToolbarCodeContent');
type MermaidToolbarElement = HTMLSpanElement & {
  [mermaidToolbarCodeContent]: string;
};

function updateMermaidModeButton(
  button: HTMLButtonElement,
  mode: MermaidBlockMode,
  lineNumber: number,
  uiLanguage: UiLanguage
): void {
  const decision = decideRenderedBlockModeShell({
    kind: 'mermaid',
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
      `.meo-mermaid-toolbar[data-meo-block-from="${anchor}"]`
    ),
    () => view.dispatch({ effects }),
    'immediate'
  );
}

class MermaidToolbarWidget extends UiLanguageSensitiveWidget {
  constructor(
    readonly anchor: number,
    readonly lineNumber: number,
    readonly mode: MermaidBlockMode,
    readonly codeContent: string,
    readonly blockTo: number
  ) {
    super();
  }

  eq(other: WidgetType): boolean {
    return other instanceof MermaidToolbarWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.anchor === this.anchor &&
      other.lineNumber === this.lineNumber &&
      other.mode === this.mode &&
      other.codeContent === this.codeContent &&
      other.blockTo === this.blockTo;
  }

  toDOM(view: EditorView): HTMLElement {
    const uiLanguage = view.state.facet(uiLanguageFacet);
    const decision = decideRenderedBlockModeShell({
      kind: 'mermaid',
      lineNumber: this.lineNumber,
      manualMode: this.mode,
      temporaryReveal: false,
      uiLanguage
    });
    const toolbar = document.createElement('span') as MermaidToolbarElement;
    toolbar.className = 'meo-mermaid-toolbar';
    toolbar.setAttribute('role', 'group');
    toolbar.setAttribute('aria-label', decision.controlsLabel);
    toolbar.dataset.meoBlockFrom = String(this.anchor);
    toolbar.dataset.meoBlockTo = String(this.blockTo);
    toolbar.dataset.meoMermaidMode = this.mode;
    toolbar.dataset.meoUiLanguage = uiLanguage;
    toolbar[mermaidToolbarCodeContent] = this.codeContent;
    toolbar.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
    });

    const modeButton = document.createElement('button');
    modeButton.type = 'button';
    modeButton.className = 'meo-mermaid-mode-btn';
    retainRenderedBlockModePointerFocus(modeButton);
    updateMermaidModeButton(modeButton, this.mode, this.lineNumber, uiLanguage);

    const changeMode = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      const currentAnchor = resolveMermaidToolbarAnchor(view, toolbar, this.lineNumber);
      if (currentAnchor === null) return;
      const currentMode = toolbar.dataset.meoMermaidMode as MermaidBlockMode;
      const nextMode = decideRenderedBlockModeShell({
        kind: 'mermaid',
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
          setMermaidBlockModeEffect.of({ anchor: currentAnchor, mode: nextMode })
        ]
      );
      requestAnimationFrame(() => {
        if (!isRevealCurrent()) return;
        if (nextMode === 'preview') {
          // The opening line owns the toolbar in every mode. Restore focus
          // without asking the unrelated outer selection to reveal itself.
          const currentModeButton = view.dom.querySelector<HTMLButtonElement>(
            `.meo-mermaid-toolbar[data-meo-block-from="${currentAnchor}"] .meo-mermaid-mode-btn`
          );
          currentModeButton?.focus({ preventScroll: true });
          return;
        }
        const editingBlock = view.dom.querySelector<HTMLElement>(
          `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${currentAnchor}"]`
        );
        (editingBlock as MermaidEditingBlockElement | null)?.__meoMermaidEditingController?.focus();
      });
    };
    modeButton.addEventListener('click', changeMode);

    const selectAllButton = createSelectAllCodeButton(() => {
      const currentAnchor = resolveMermaidToolbarAnchor(view, toolbar, this.lineNumber);
      if (currentAnchor === null) return;
      const isRevealCurrent = getViewportController(view)?.beginNavigationReveal() ?? (() => true);
      const scrollTop = view.scrollDOM.scrollTop;
      preserveToolbarWhileDispatching(
        view,
        toolbar,
        currentAnchor,
        [
          supersedeLiveInputDerivedWork(),
          setMermaidBlockModeEffect.of({ anchor: currentAnchor, mode: 'source' })
        ]
      );
      requestAnimationFrame(() => {
        if (!isRevealCurrent()) return;
        const editingBlock = view.dom.querySelector<HTMLElement>(
          `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${currentAnchor}"]`
        );
        (editingBlock as MermaidEditingBlockElement | null)?.__meoMermaidEditingController?.selectAll();
        getViewportController(view)?.lockScrollTop(scrollTop, isRevealCurrent);
      });
    }, uiLanguage);
    const copyButton = createCopyCodeButton(() => toolbar[mermaidToolbarCodeContent] ?? '', uiLanguage);

    toolbar.append(modeButton, selectAllButton, copyButton);
    return toolbar;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const toolbar = dom as MermaidToolbarElement;
    const uiLanguage = view.state.facet(uiLanguageFacet);
    if (
      !toolbar.classList.contains('meo-mermaid-toolbar') ||
      toolbar.dataset.meoBlockFrom !== String(this.anchor) ||
      toolbar.dataset.meoUiLanguage !== uiLanguage
    ) return false;
    const modeButton = toolbar.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn');
    if (!modeButton) return false;
    toolbar.dataset.meoBlockTo = String(this.blockTo);
    toolbar.dataset.meoMermaidMode = this.mode;
    toolbar.dataset.meoUiLanguage = uiLanguage;
    toolbar[mermaidToolbarCodeContent] = this.codeContent;
    updateMermaidModeButton(
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

export function addMermaidToolbar(
  builder: any[],
  position: number,
  anchor: number,
  lineNumber: number,
  mode: MermaidBlockMode,
  codeContent: string,
  blockTo: number,
  side = 1
): void {
  builder.push(
    Decoration.widget({
      widget: createMermaidToolbarWidget(anchor, lineNumber, mode, codeContent, blockTo),
      side
    }).range(position)
  );
}

export function createMermaidToolbarWidget(
  anchor: number,
  lineNumber: number,
  mode: MermaidBlockMode,
  codeContent: string,
  blockTo: number
): WidgetType {
  return new MermaidToolbarWidget(anchor, lineNumber, mode, codeContent, blockTo);
}

type MermaidEditingBlockElement = HTMLElement & {
  __meoMermaidEditingController?: MermaidEditingController;
};

export function focusMermaidEditingOffset(
  view: EditorView,
  anchor: number,
  offset: number,
  isCurrent: () => boolean = () => true
): boolean {
  if (!isCurrent()) return false;
  const editingBlock = view.dom.querySelector<HTMLElement>(
    `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${anchor}"]`
  ) as MermaidEditingBlockElement | null;
  if (!editingBlock?.__meoMermaidEditingController) {
    return false;
  }
  return editingBlock.__meoMermaidEditingController.focusOuterOffset(offset, isCurrent);
}

function applyMermaidSourceLinePrefix(sourceText: string, prefix: string): string {
  if (!prefix) return sourceText;
  return sourceText.split('\n').map((line) => `${prefix}${line}`).join('\n');
}

function resolveMermaidSourceProjection(
  contentFrom: number,
  currentText: string,
  nextText: string
): { from: number; to: number; insert: string } {
  let unchangedPrefix = 0;
  const prefixLimit = Math.min(currentText.length, nextText.length);
  while (
    unchangedPrefix < prefixLimit &&
    currentText.charCodeAt(unchangedPrefix) === nextText.charCodeAt(unchangedPrefix)
  ) {
    unchangedPrefix += 1;
  }

  let unchangedSuffix = 0;
  const suffixLimit = prefixLimit - unchangedPrefix;
  while (
    unchangedSuffix < suffixLimit &&
    currentText.charCodeAt(currentText.length - unchangedSuffix - 1) ===
      nextText.charCodeAt(nextText.length - unchangedSuffix - 1)
  ) {
    unchangedSuffix += 1;
  }

  // A zero-width change exactly on the inclusive boundary of the replacing
  // decoration makes CodeMirror replace the widget that owns this editor.
  // Carry one unchanged code unit through the projection so the transaction
  // stays inside the current source range and preserves its lifecycle.
  if (unchangedPrefix + unchangedSuffix === currentText.length) {
    if (unchangedPrefix > 0) {
      unchangedPrefix -= 1;
    } else if (unchangedSuffix > 0) {
      unchangedSuffix -= 1;
    }
  }

  return {
    from: contentFrom + unchangedPrefix,
    to: contentFrom + currentText.length - unchangedSuffix,
    insert: nextText.slice(unchangedPrefix, nextText.length - unchangedSuffix)
  };
}

function mermaidOuterOffsetToEditorOffset(sourceText: string, prefix: string, offset: number): number {
  if (!prefix) return Math.max(0, Math.min(offset, sourceText.length));
  const target = Math.max(0, offset);
  const lines = sourceText.split('\n');
  let outerPosition = 0;
  let editorPosition = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const outerLineEnd = outerPosition + prefix.length + line.length;
    if (target <= outerLineEnd) {
      return editorPosition + Math.max(0, Math.min(line.length, target - outerPosition - prefix.length));
    }
    outerPosition = outerLineEnd;
    editorPosition += line.length;
    if (index < lines.length - 1) {
      outerPosition += 1;
      editorPosition += 1;
    }
  }
  return sourceText.length;
}

function mermaidEditorOffsetToOuterOffset(sourceText: string, prefix: string, offset: number): number {
  if (!prefix) return Math.max(0, Math.min(offset, sourceText.length));
  const target = Math.max(0, Math.min(offset, sourceText.length));
  const lines = sourceText.split('\n');
  let outerPosition = 0;
  let editorPosition = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const editorLineEnd = editorPosition + line.length;
    if (target <= editorLineEnd) {
      return outerPosition + prefix.length + target - editorPosition;
    }
    outerPosition += prefix.length + line.length;
    editorPosition = editorLineEnd;
    if (index < lines.length - 1) {
      outerPosition += 1;
      editorPosition += 1;
    }
  }
  return outerPosition;
}

type MermaidSourceProjectionLock = {
  scrollTop: number;
  releaseFrame: number | null;
  releaseOnInteraction: () => void;
  previousSelection: EditorSelection;
  pinnedSelection: EditorSelection | null;
  isExplicitNavigationCurrent: () => boolean;
};

const mermaidSourceProjectionLocks = new WeakMap<
  EditorView,
  Map<number, MermaidSourceProjectionLock>
>();

function releaseMermaidSourceProjectionLock(
  outerView: EditorView,
  anchor: number,
  lock: MermaidSourceProjectionLock,
  preserveScroll = false
): void {
  const locks = mermaidSourceProjectionLocks.get(outerView);
  if (locks?.get(anchor) !== lock) return;
  if (lock.releaseFrame !== null) {
    window.cancelAnimationFrame(lock.releaseFrame);
    lock.releaseFrame = null;
  }
  outerView.scrollDOM.removeEventListener('pointerdown', lock.releaseOnInteraction);
  outerView.scrollDOM.removeEventListener('touchstart', lock.releaseOnInteraction);
  outerView.scrollDOM.removeEventListener('wheel', lock.releaseOnInteraction);
  locks.delete(anchor);
  if (locks.size === 0) mermaidSourceProjectionLocks.delete(outerView);
  if (
    outerView.dom.isConnected &&
    lock.pinnedSelection &&
    outerView.state.selection.eq(lock.pinnedSelection)
  ) {
    outerView.dispatch({
      selection: lock.previousSelection,
      annotations: Transaction.addToHistory.of(false)
    });
  }
  if (preserveScroll && outerView.dom.isConnected) {
    getViewportController(outerView)?.lockScrollTop(
      lock.scrollTop,
      lock.isExplicitNavigationCurrent
    );
  }
}

function acquireMermaidSourceProjectionLock(
  outerView: EditorView,
  anchor: number
): MermaidSourceProjectionLock {
  let locks = mermaidSourceProjectionLocks.get(outerView);
  if (!locks) {
    locks = new Map();
    mermaidSourceProjectionLocks.set(outerView, locks);
  }
  let lock = locks.get(anchor);
  if (!lock) {
    const releaseOnInteraction = () => {
      const currentLocks = mermaidSourceProjectionLocks.get(outerView);
      const currentLock = currentLocks?.get(anchor);
      if (!currentLock) return;
      releaseMermaidSourceProjectionLock(outerView, anchor, currentLock);
    };
    lock = {
      scrollTop: outerView.scrollDOM.scrollTop,
      releaseFrame: null,
      releaseOnInteraction,
      previousSelection: outerView.state.selection,
      pinnedSelection: null,
      isExplicitNavigationCurrent: getViewportController(outerView)
        ?.captureExplicitNavigationCurrentness() ?? (() => true)
    };
    locks.set(anchor, lock);
    outerView.scrollDOM.addEventListener('pointerdown', releaseOnInteraction, { passive: true });
    outerView.scrollDOM.addEventListener('touchstart', releaseOnInteraction, { passive: true });
    outerView.scrollDOM.addEventListener('wheel', releaseOnInteraction, { passive: true });
  }
  if (lock.releaseFrame !== null) {
    window.cancelAnimationFrame(lock.releaseFrame);
    lock.releaseFrame = null;
  }
  return lock;
}

function releaseMermaidSourceProjectionLockAfterFrame(
  outerView: EditorView,
  anchor: number,
  lock: MermaidSourceProjectionLock
): void {
  lock.releaseFrame = window.requestAnimationFrame(() => {
    lock.releaseFrame = null;
    const locks = mermaidSourceProjectionLocks.get(outerView);
    if (locks?.get(anchor) !== lock) return;
    releaseMermaidSourceProjectionLock(outerView, anchor, lock, true);
  });
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
  private unsubscribeThemeRefresh: () => void;
  private presentationFactory: MermaidDiagramPresentationConsumer;
  private syncingFromOuter = false;
  private searchReveal: MermaidSearchReveal;
  private innerInteractionContinuity: EditorInteractionContinuity | null = null;

  constructor(
    outerView: EditorView,
    block: MermaidEditingBlock,
    mode: Exclude<MermaidBlockMode, 'preview'>,
    searchReveal: MermaidSearchReveal
  ) {
    this.outerView = outerView;
    this.block = block;
    if (mermaidSourceProjectionLocks.get(outerView)?.has(block.anchor)) {
      acquireMermaidSourceProjectionLock(outerView, block.anchor);
    }
    this.presentationFactory = getMermaidDiagramPresentationFactory(outerView.state);
    this.mode = mode;
    this.searchReveal = searchReveal;
    this.root = document.createElement('div') as MermaidEditingBlockElement;
    this.root.className = 'meo-mermaid-editing-block meo-rendered-block-mode-shell';
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', decideRenderedBlockModeShell({
      kind: 'mermaid',
      lineNumber: block.startLine,
      manualMode: mode,
      temporaryReveal: false,
      uiLanguage: outerView.state.facet(uiLanguageFacet)
    }).editorLabel);
    this.root.dataset.meoMermaidAnchor = String(block.anchor);
    this.sourcePane = document.createElement('div');
    this.sourcePane.className = 'meo-mermaid-source-pane meo-rendered-block-source-pane';
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
          shikiDocumentHighlight('mermaid'),
          innerMermaidSearchField,
          EditorView.lineWrapping,
          EditorView.domEventHandlers({
            beforeinput: () => {
              acquireMermaidSourceProjectionLock(this.outerView, this.block.anchor);
              return false;
            },
            blur: () => {
              const projectionLock = mermaidSourceProjectionLocks
                .get(this.outerView)
                ?.get(this.block.anchor);
              if (projectionLock) {
                releaseMermaidSourceProjectionLockAfterFrame(
                  this.outerView,
                  this.block.anchor,
                  projectionLock
                );
              }
              return false;
            }
          }),
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
            const nextText = update.state.doc.toString();
            const { contentFrom, contentTo } = this.block;
            const outerSourceText = applyMermaidSourceLinePrefix(nextText, this.block.sourceLinePrefix);
            const currentOuterSourceText = this.outerView.state.doc.sliceString(contentFrom, contentTo);
            if (currentOuterSourceText === outerSourceText) {
              return;
            }
            const userEvent = update.transactions.reduce<string | undefined>(
              (current, transaction) => transaction.annotation(Transaction.userEvent) ?? current,
              undefined
            ) ?? 'input';
            const change = resolveMermaidSourceProjection(
              contentFrom,
              currentOuterSourceText,
              outerSourceText
            );
            const nextBlock = {
              ...this.block,
              contentTo: contentFrom + outerSourceText.length,
              diagramText: nextText
            };
            this.block = nextBlock;
            const viewportController = getViewportController(this.outerView);
            const projectionLock = acquireMermaidSourceProjectionLock(
              this.outerView,
              this.block.anchor
            );
            const scrollTop = projectionLock.scrollTop;
            viewportController?.markInteraction();
            // A replacement widget taller than CodeMirror's viewport can be
            // virtualized around the hidden outer selection even while its
            // nested editor owns DOM focus. Only that exceptional geometry
            // needs a temporary outer selection pin; normal blocks retain the
            // user's unrelated outer command target.
            const needsOuterSelectionKeepAlive = (
              this.root.getBoundingClientRect().height > this.outerView.scrollDOM.clientHeight
            );
            const projection = this.outerView.state.update({
              changes: change,
              selection: needsOuterSelectionKeepAlive
                ? {
                    anchor: nextBlock.contentFrom + mermaidEditorOffsetToOuterOffset(
                      nextText,
                      nextBlock.sourceLinePrefix,
                      update.state.selection.main.head
                    )
                  }
                : undefined,
              effects: replaceLiveInputNestedDecoration(
                nextBlock.contentFrom,
                nextBlock.contentTo,
                Decoration.replace({
                  widget: new MermaidEditingWidget(nextBlock, this.mode, this.searchReveal),
                  block: true,
                  inclusive: true
                })
              ),
              annotations: [
                Transaction.userEvent.of(userEvent),
                markLiveInputNestedProjection()
              ]
            });
            projectionLock.previousSelection = projectionLock.previousSelection.map(projection.changes);
            projectionLock.pinnedSelection = projection.newSelection;
            const retainInnerFocus = this.root.contains(document.activeElement);
            const innerSelection = update.state.selection.main;
            this.outerView.dispatch(projection);
            // Mapping the replaced outer range can briefly transfer DOM focus
            // back to CodeMirror even when updateDOM retains this controller.
            // Keep rapid key sequences owned by the embedded source editor.
            if (retainInnerFocus) {
              const currentBlock = this.outerView.dom.querySelector<MermaidEditingBlockElement>(
                `.meo-mermaid-editing-block[data-meo-mermaid-anchor="${nextBlock.anchor}"]`
              );
              const currentController = currentBlock?.__meoMermaidEditingController;
              if (currentController && !currentController.innerView.hasFocus) {
                const head = Math.min(innerSelection.head, currentController.innerView.state.doc.length);
                currentController.innerView.dispatch({ selection: { anchor: head } });
                currentController.innerView.contentDOM.focus({ preventScroll: true });
              }
            }
            viewportController?.lockScrollTop(scrollTop, projectionLock.isExplicitNavigationCurrent);
            const outerView = this.outerView;
            queueMicrotask(() => {
              const lockIsCurrent = mermaidSourceProjectionLocks
                .get(outerView)
                ?.get(this.block.anchor) === projectionLock;
              if (outerView.dom.isConnected && lockIsCurrent) {
                viewportController?.lockScrollTop(scrollTop, projectionLock.isExplicitNavigationCurrent);
              }
            });
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

    this.unsubscribeThemeRefresh = this.presentationFactory.subscribeThemeRefresh(() => {
      if (this.mode === 'split') {
        this.renderPreview();
      }
    });
    this.setMode(mode, true);
    this.setSearchReveal(searchReveal);
    this.root.__meoMermaidEditingController = this;
  }

  get dom(): HTMLElement {
    return this.root;
  }

  focus(): void {
    this.innerView.contentDOM.focus({ preventScroll: true });
  }

  selectAll(): void {
    this.innerView.dispatch({
      selection: { anchor: 0, head: this.innerView.state.doc.length }
    });
    this.innerView.contentDOM.focus({ preventScroll: true });
  }

  focusOffset(offset: number, isCurrent: () => boolean = () => true): boolean {
    if (!isCurrent()) return false;
    const position = Math.max(0, Math.min(offset, this.innerView.state.doc.length));
    this.innerView.dispatch({
      selection: { anchor: position }
    });
    if (!isCurrent()) return false;
    this.innerView.contentDOM.focus({ preventScroll: true });
    if (!isCurrent()) return false;
    this.innerView.requestMeasure({
      read: (innerView) => {
        if (!isCurrent()) return null;
        const coords = innerView.coordsAtPos(position);
        const viewport = this.outerView.scrollDOM.getBoundingClientRect();
        if (!coords || (coords.top >= viewport.top && coords.bottom <= viewport.bottom)) {
          return null;
        }
        return coords.top - viewport.top - viewport.height * 0.3;
      },
      write: (delta) => {
        if (isCurrent() && delta !== null) {
          getViewportController(this.outerView)?.navigateBy({ top: delta });
        }
      }
    });
    return true;
  }

  focusOuterOffset(offset: number, isCurrent: () => boolean = () => true): boolean {
    return this.focusOffset(mermaidOuterOffsetToEditorOffset(
      this.block.diagramText,
      this.block.sourceLinePrefix,
      offset
    ), isCurrent);
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
    const decision = decideRenderedBlockModeShell({
      kind: 'mermaid',
      lineNumber: this.block.startLine,
      manualMode: mode,
      temporaryReveal: false,
      uiLanguage: this.outerView.state.facet(uiLanguageFacet)
    });
    this.root.className = `meo-mermaid-editing-block meo-rendered-block-mode-shell ${decision.modeClass}`;
    this.root.dataset.meoRenderedBlockMode = decision.effectiveMode;
    this.root.dataset.meoRenderedBlockLayout = decision.wideLayout;
    if (decision.previewLifecycle === 'deferred') {
      const preferredHeight = getCachedMermaidPreviewHeight(
        this.presentationFactory,
        this.outerView,
        this.block.diagramText,
        this.block.startLine
      );
      if (preferredHeight) {
        this.root.style.setProperty('--meo-mermaid-preview-preferred-height', `${preferredHeight}px`);
      }
      if (!this.previewShell) {
        this.previewShell = document.createElement('div');
        this.previewShell.className = 'meo-mermaid-preview-shell meo-rendered-block-preview-pane';
        this.previewSticky = document.createElement('div');
        this.previewSticky.className = 'meo-mermaid-preview-sticky';
        this.previewShell.appendChild(this.previewSticky);
        this.root.appendChild(this.previewShell);
      }
      this.renderPreview();
    } else if (decision.previewLifecycle === 'destroyed' && this.previewShell) {
      this.root.style.removeProperty('--meo-mermaid-preview-preferred-height');
      this.destroyPreview();
      this.previewShell.remove();
      this.previewShell = null;
      this.previewSticky = null;
    }
  }

  private setSearchReveal(searchReveal: MermaidSearchReveal): void {
    this.searchReveal = searchReveal;
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
    const apply = () => {
      this.destroyPreview();
      this.previewWidget = new MermaidDiagramWidget(
        this.block.diagramText,
        this.block.startLine,
        this.block.endLine,
        {
          presentationFactory: this.presentationFactory,
          cachePreviewHeight: false,
          uiLanguage: this.outerView.state.facet(uiLanguageFacet)
        }
      );
      // The split preview is outside CodeMirror's own document measurement.
      // Pass the outer view so both the immediate loading shell and the later
      // diagram presentation participate in the shared viewport settlement.
      this.previewSticky?.replaceChildren(this.previewWidget.toDOM(this.outerView));
    };
    const viewportController = getViewportController(this.outerView);
    if (!viewportController || !this.root.isConnected) {
      apply();
      return;
    }
    const startLine = this.outerView.state.doc.line(Math.min(
      this.block.startLine,
      this.outerView.state.doc.lines
    ));
    const endLine = this.outerView.state.doc.line(Math.min(
      this.block.endLine,
      this.outerView.state.doc.lines
    ));
    viewportController.preserveLayoutChange({
      element: this.root,
      from: startLine.from,
      to: endLine.to
    }, apply);
  }

  private destroyPreview(): void {
    this.previewWidget?.destroy();
    this.previewWidget = null;
    this.previewSticky?.replaceChildren();
  }

  destroy(): void {
    this.innerInteractionContinuity?.dispose();
    this.innerInteractionContinuity = null;
    this.unsubscribeThemeRefresh();
    const projectionLock = mermaidSourceProjectionLocks.get(this.outerView)?.get(this.block.anchor);
    if (projectionLock) {
      releaseMermaidSourceProjectionLockAfterFrame(
        this.outerView,
        this.block.anchor,
        projectionLock
      );
    }
    if (this.previewTimer !== null) {
      window.clearTimeout(this.previewTimer);
      this.previewTimer = null;
    }
    this.destroyPreview();
    this.innerView.destroy();
    delete this.root.__meoMermaidEditingController;
  }
}

export class MermaidEditingWidget extends UiLanguageSensitiveWidget {
  constructor(
    readonly block: MermaidEditingBlock,
    readonly mode: Exclude<MermaidBlockMode, 'preview'>,
    readonly searchReveal: MermaidSearchReveal
  ) {
    super();
  }

  get estimatedHeight(): number {
    return estimateBlockWidgetHeight({
      kind: 'rendered-block-editor',
      renderer: 'mermaid',
      mode: this.mode,
      source: this.block.diagramText
    });
  }

  eq(other: WidgetType): boolean {
    return other instanceof MermaidEditingWidget &&
      this.hasSameUiLanguageEpoch(other) &&
      other.block.anchor === this.block.anchor &&
      other.block.startLine === this.block.startLine &&
      other.block.diagramText === this.block.diagramText &&
      other.block.sourceLinePrefix === this.block.sourceLinePrefix &&
      other.block.indentColumns === this.block.indentColumns &&
      other.mode === this.mode &&
      other.searchReveal?.from === this.searchReveal?.from &&
      other.searchReveal?.to === this.searchReveal?.to;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = new MermaidEditingController(view, this.block, this.mode, this.searchReveal).dom;
    applyLiveBlockIndent(dom, this.block.indentColumns);
    return dom;
  }

  updateDOM(dom: HTMLElement, view: EditorView): boolean {
    const controller = (dom as MermaidEditingBlockElement).__meoMermaidEditingController;
    const updated = controller?.update(view, this.block, this.mode, this.searchReveal) ?? false;
    if (updated) {
      dom.setAttribute('aria-label', decideRenderedBlockModeShell({
        kind: 'mermaid',
        lineNumber: this.block.startLine,
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
    (dom as MermaidEditingBlockElement).__meoMermaidEditingController?.destroy();
  }
}
