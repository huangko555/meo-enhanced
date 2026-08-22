import { Annotation, EditorState, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';

export type LiveInputDerivedWorkScheduler = {
  documentChanged(): void;
  cancelPending(): void;
  dispose(): void;
};

type LiveInputDerivedWorkSchedulerOptions = {
  requestFrame(callback: () => void): number;
  cancelFrame(frameId: number): void;
  apply(): void;
  reportError(error: unknown): void;
};

/**
 * Coalesces derived presentation behind one observable primary-text frame.
 * Generation is private so stale frame callbacks cannot become a second owner.
 */
export function createLiveInputDerivedWorkScheduler(
  options: LiveInputDerivedWorkSchedulerOptions
): LiveInputDerivedWorkScheduler {
  let generation = 0;
  let frameId: number | null = null;
  let disposed = false;

  const cancelPendingFrame = (): void => {
    if (frameId === null) return;
    options.cancelFrame(frameId);
    frameId = null;
  };

  const scheduleDerivedFrame = (currentGeneration: number): void => {
    frameId = options.requestFrame(() => {
      frameId = null;
      if (disposed || currentGeneration !== generation) return;
      try {
        options.apply();
      } catch (error) {
        options.reportError(error);
      }
    });
  };

  return {
    documentChanged() {
      if (disposed) return;
      generation += 1;
      const currentGeneration = generation;
      cancelPendingFrame();
      frameId = options.requestFrame(() => {
        frameId = null;
        if (disposed || currentGeneration !== generation) return;
        scheduleDerivedFrame(currentGeneration);
      });
    },
    cancelPending() {
      if (disposed) return;
      generation += 1;
      cancelPendingFrame();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      cancelPendingFrame();
    }
  };
}

// `undefined` is CodeMirror's signal to remove a StateEffect. A literal true
// is the domain sentinel that keeps phase transitions present in transactions.
const deferLiveInputDerivedWorkEffect = StateEffect.define<true>();
const refreshLiveInputDerivedWorkEffect = StateEffect.define<true>();
const cancelLiveInputDerivedWorkEffect = StateEffect.define<true>();
const supersedeLiveInputDerivedWorkEffect = StateEffect.define<true>();
const changeLiveInputCompositionEffect = StateEffect.define<true>();
const completeLiveInputCompositionEffect = StateEffect.define<true>();

type LiveInputDerivedWorkPhase = 'idle' | 'composing' | 'pending-input';
type LiveInputDerivedWorkPhaseState = {
  readonly phase: LiveInputDerivedWorkPhase;
  readonly compositionChanged: boolean;
};

const idleLiveInputDerivedWorkPhase: LiveInputDerivedWorkPhaseState = Object.freeze({
  phase: 'idle',
  compositionChanged: false
});
type LiveInputDerivedWorkProvenance = 'automatic-normalization' | 'nested-input-projection';
const liveInputDerivedWorkProvenance = Annotation.define<LiveInputDerivedWorkProvenance>();

export function markLiveInputDerivedWorkFollowUp(): Annotation<LiveInputDerivedWorkProvenance> {
  return liveInputDerivedWorkProvenance.of('automatic-normalization');
}

export function markLiveInputNestedProjection(): Annotation<LiveInputDerivedWorkProvenance> {
  return liveInputDerivedWorkProvenance.of('nested-input-projection');
}

export function isLiveInputNestedProjection(transaction: Transaction): boolean {
  return transaction.annotation(liveInputDerivedWorkProvenance) === 'nested-input-projection';
}

export function supersedeLiveInputDerivedWork(): StateEffect<true> {
  return supersedeLiveInputDerivedWorkEffect.of(true);
}

const liveInputDerivedWorkPhaseField = StateField.define<LiveInputDerivedWorkPhaseState>({
  create: () => idleLiveInputDerivedWorkPhase,
  update(previous, transaction) {
    let next = previous;
    for (const effect of transaction.effects) {
      if (effect.is(refreshLiveInputDerivedWorkEffect)
        || effect.is(cancelLiveInputDerivedWorkEffect)
        || effect.is(supersedeLiveInputDerivedWorkEffect)) {
        next = idleLiveInputDerivedWorkPhase;
      } else if (effect.is(changeLiveInputCompositionEffect)) {
        next = { phase: 'composing', compositionChanged: true };
      } else if (effect.is(completeLiveInputCompositionEffect)) {
        next = next.compositionChanged
          ? { phase: 'pending-input', compositionChanged: false }
          : idleLiveInputDerivedWorkPhase;
      } else if (effect.is(deferLiveInputDerivedWorkEffect)) {
        next = { phase: 'pending-input', compositionChanged: false };
      }
    }
    return next;
  }
});

export function isLiveInputDerivedWorkRefresh(transaction: Transaction): boolean {
  return transaction.effects.some((effect) => effect.is(refreshLiveInputDerivedWorkEffect));
}

export function shouldDeferLiveInputDerivedWork(transaction: Transaction): boolean {
  if (isLiveInputDerivedWorkRefresh(transaction)) return false;
  if (transaction.effects.some((effect) => effect.is(cancelLiveInputDerivedWorkEffect))) return true;
  if (transaction.effects.some((effect) => effect.is(supersedeLiveInputDerivedWorkEffect))) return false;
  const phase = transaction.state.field(liveInputDerivedWorkPhaseField, false)?.phase;
  return phase !== undefined && phase !== 'idle';
}

export function isLiveInputDerivedWorkPending(state: EditorState): boolean {
  const phase = state.field(liveInputDerivedWorkPhaseField, false)?.phase;
  return phase !== undefined && phase !== 'idle';
}

export function completeLiveInputComposition(view: EditorView): void {
  if (view.state.field(liveInputDerivedWorkPhaseField, false)?.phase === 'idle') return;
  view.dispatch({
    effects: completeLiveInputCompositionEffect.of(true),
    annotations: Transaction.addToHistory.of(false)
  });
}

/**
 * Maps unaffected presentation while exposing the edited line and its neighbors.
 * This keeps accepted text visible even when an old replace/widget decoration
 * covered the Markdown around the change.
 */
export function mapLiveInputDerivedDecorations(
  decorations: DecorationSet,
  transaction: Transaction
): DecorationSet {
  let mapped = decorations.map(transaction.changes);
  const affected: Array<{ from: number; to: number }> = [];
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    const doc = transaction.newDoc;
    const startLine = doc.lineAt(Math.min(fromB, doc.length)).number;
    const endLine = doc.lineAt(Math.min(toB, doc.length)).number;
    affected.push({
      from: doc.line(Math.max(1, startLine - 1)).from,
      to: doc.line(Math.min(doc.lines, endLine + 1)).to
    });
  });
  for (const range of affected) {
    mapped = mapped.update({
      filterFrom: range.from,
      filterTo: range.to,
      filter: () => false
    });
  }
  return mapped;
}

function createCodeMirrorLiveInputDerivedWorkPlugin(view: EditorView) {
  const scheduler = createLiveInputDerivedWorkScheduler({
    requestFrame: (callback) => window.requestAnimationFrame(() => callback()),
    cancelFrame: (frameId) => window.cancelAnimationFrame(frameId),
    apply() {
      try {
        view.dispatch({ effects: refreshLiveInputDerivedWorkEffect.of(true) });
      } catch (error) {
        try {
          view.dispatch({ effects: cancelLiveInputDerivedWorkEffect.of(true) });
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Live derived refresh and cleanup failed');
        }
        throw error;
      }
    },
    reportError(error) {
      console.error('[MEO live input] derived refresh failed', error);
    }
  });
  return {
    compositionStarted() {
      scheduler.cancelPending();
    },
    update(update: { transactions: readonly Transaction[] }) {
      for (const transaction of update.transactions) {
        if (transaction.effects.some((effect) => effect.is(changeLiveInputCompositionEffect))) {
          scheduler.cancelPending();
        }
        if (transaction.effects.some((effect) => effect.is(supersedeLiveInputDerivedWorkEffect))) {
          scheduler.cancelPending();
        }
        if (transaction.effects.some((effect) => effect.is(completeLiveInputCompositionEffect))
          && transaction.state.field(liveInputDerivedWorkPhaseField, false)?.phase === 'pending-input') {
          scheduler.documentChanged();
        }
        if (transaction.effects.some((effect) => effect.is(deferLiveInputDerivedWorkEffect))) {
          scheduler.documentChanged();
        }
      }
    },
    destroy() {
      scheduler.dispose();
    }
  };
}

const codeMirrorLiveInputDerivedWorkPlugin = ViewPlugin.define(
  createCodeMirrorLiveInputDerivedWorkPlugin
);

export function beginLiveInputComposition(view: EditorView): void {
  view.plugin(codeMirrorLiveInputDerivedWorkPlugin)?.compositionStarted();
}

function isHistoryTransaction(transaction: Transaction): boolean {
  const userEvent = transaction.annotation(Transaction.userEvent);
  return typeof userEvent === 'string'
    && (userEvent === 'undo' || userEvent === 'redo'
      || userEvent.startsWith('undo.') || userEvent.startsWith('redo.'));
}

export function liveInputDerivedWorkExtensions(): Extension[] {
  return [
    EditorState.transactionExtender.of((transaction) => {
      if (!transaction.docChanged) return null;
      const phase = transaction.startState.field(liveInputDerivedWorkPhaseField, false)?.phase ?? 'idle';
      const provenance = transaction.annotation(liveInputDerivedWorkProvenance);
      if (transaction.effects.some((effect) => effect.is(supersedeLiveInputDerivedWorkEffect))) {
        return null;
      }
      if (isHistoryTransaction(transaction) && phase !== 'idle') {
        return { effects: supersedeLiveInputDerivedWorkEffect.of(true) };
      }
      if (transaction.isUserEvent('input.type.compose')) {
        return { effects: changeLiveInputCompositionEffect.of(true) };
      }
      if (provenance !== undefined) {
        return { effects: deferLiveInputDerivedWorkEffect.of(true) };
      }
      if (phase === 'composing') {
        return { effects: changeLiveInputCompositionEffect.of(true) };
      }
      if (transaction.isUserEvent('input')) {
        return { effects: deferLiveInputDerivedWorkEffect.of(true) };
      }
      if (phase === 'pending-input') {
        return { effects: supersedeLiveInputDerivedWorkEffect.of(true) };
      }
      return null;
    }),
    liveInputDerivedWorkPhaseField,
    codeMirrorLiveInputDerivedWorkPlugin
  ];
}
