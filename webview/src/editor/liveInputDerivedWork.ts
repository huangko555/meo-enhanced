import { EditorState, StateEffect, StateField, type Extension, type Transaction } from '@codemirror/state';
import { ViewPlugin, type DecorationSet, type EditorView } from '@codemirror/view';

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

const deferLiveInputDerivedWorkEffect = StateEffect.define<void>();
const refreshLiveInputDerivedWorkEffect = StateEffect.define<void>();
const cancelLiveInputDerivedWorkEffect = StateEffect.define<void>();
const supersedeLiveInputDerivedWorkEffect = StateEffect.define<void>();

const liveInputDerivedWorkPendingField = StateField.define<boolean>({
  create: () => false,
  update(pending, transaction) {
    if (transaction.effects.some((effect) => effect.is(refreshLiveInputDerivedWorkEffect)
      || effect.is(cancelLiveInputDerivedWorkEffect)
      || effect.is(supersedeLiveInputDerivedWorkEffect))) {
      return false;
    }
    if (transaction.effects.some((effect) => effect.is(deferLiveInputDerivedWorkEffect))) {
      return true;
    }
    return pending;
  }
});

export function isLiveInputDerivedWorkRefresh(transaction: Transaction): boolean {
  return transaction.effects.some((effect) => effect.is(refreshLiveInputDerivedWorkEffect));
}

export function shouldDeferLiveInputDerivedWork(transaction: Transaction): boolean {
  if (isLiveInputDerivedWorkRefresh(transaction)) return false;
  if (transaction.effects.some((effect) => effect.is(cancelLiveInputDerivedWorkEffect))) return true;
  return transaction.effects.some((effect) => effect.is(deferLiveInputDerivedWorkEffect))
    || transaction.state.field(liveInputDerivedWorkPendingField, false) === true;
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
        view.dispatch({ effects: refreshLiveInputDerivedWorkEffect.of(undefined) });
      } catch (error) {
        try {
          view.dispatch({ effects: cancelLiveInputDerivedWorkEffect.of(undefined) });
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
    update(update: { transactions: readonly Transaction[] }) {
      for (const transaction of update.transactions) {
        if (transaction.effects.some((effect) => effect.is(supersedeLiveInputDerivedWorkEffect))) {
          scheduler.cancelPending();
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

export function liveInputDerivedWorkExtensions(): Extension[] {
  return [
    EditorState.transactionExtender.of((transaction) => (
      transaction.docChanged && transaction.isUserEvent('input')
        ? { effects: deferLiveInputDerivedWorkEffect.of(undefined) }
        : transaction.docChanged && transaction.startState.field(liveInputDerivedWorkPendingField, false)
          ? { effects: supersedeLiveInputDerivedWorkEffect.of(undefined) }
          : null
    )),
    liveInputDerivedWorkPendingField,
    codeMirrorLiveInputDerivedWorkPlugin
  ];
}
