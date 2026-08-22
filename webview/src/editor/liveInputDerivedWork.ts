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
const settleLiveInputDerivedWorkEffect = StateEffect.define<true>();
const cancelLiveInputDerivedWorkEffect = StateEffect.define<true>();
const supersedeLiveInputDerivedWorkEffect = StateEffect.define<true>();
const beginLiveInputCompositionEffect = StateEffect.define<true>();
const changeLiveInputCompositionEffect = StateEffect.define<true>();
const completeLiveInputCompositionEffect = StateEffect.define<true>();

type LiveInputDerivedWorkPhase =
  | 'idle'
  | 'pending-input'
  | 'composing-with-pending'
  | 'composing-without-pending'
  | 'committed-refresh'
  | 'superseded'
  // Runtime destruction owns this terminal phase because a destroyed View
  // cannot safely dispatch another transaction into its StateField.
  | 'disposed';
type LiveInputDerivedWorkPhaseState = {
  readonly phase: LiveInputDerivedWorkPhase;
};

const idleLiveInputDerivedWorkPhase: LiveInputDerivedWorkPhaseState = Object.freeze({
  phase: 'idle'
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
      ) {
        next = { phase: 'committed-refresh' };
      } else if (effect.is(settleLiveInputDerivedWorkEffect)) {
        next = idleLiveInputDerivedWorkPhase;
      } else if (effect.is(cancelLiveInputDerivedWorkEffect)
        || effect.is(supersedeLiveInputDerivedWorkEffect)) {
        next = { phase: 'superseded' };
      } else if (effect.is(beginLiveInputCompositionEffect)) {
        next = {
          phase: next.phase === 'pending-input' || next.phase === 'composing-with-pending'
            ? 'composing-with-pending'
            : 'composing-without-pending'
        };
      } else if (effect.is(changeLiveInputCompositionEffect)) {
        next = { phase: 'composing-with-pending' };
      } else if (effect.is(completeLiveInputCompositionEffect)) {
        next = next.phase === 'composing-with-pending'
          ? { phase: 'pending-input' }
          : idleLiveInputDerivedWorkPhase;
      } else if (effect.is(deferLiveInputDerivedWorkEffect)) {
        next = {
          phase: next.phase === 'composing-with-pending' || next.phase === 'composing-without-pending'
            ? 'composing-with-pending'
            : 'pending-input'
        };
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
  return phase === 'pending-input'
    || phase === 'composing-with-pending'
    || phase === 'composing-without-pending';
}

function isLiveInputDerivedWorkPending(state: EditorState): boolean {
  const phase = state.field(liveInputDerivedWorkPhaseField, false)?.phase;
  return phase === 'pending-input'
    || phase === 'composing-with-pending'
    || phase === 'composing-without-pending';
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
  type ConsumerRecordState = 'queued' | 'running' | 'settled' | 'cancelled';
  type ConsumerRecord = {
    operation: () => void;
    state: ConsumerRecordState;
  };
  type ConsumerGeneration = {
    id: number;
    state: 'accepting' | 'flushing' | 'settled' | 'cancelled';
    records: Map<object, ConsumerRecord>;
  };

  let nextConsumerGeneration = 0;
  let consumerGeneration: ConsumerGeneration | null = null;
  let settleGenerationToken = 0;
  const immediateConsumers = new Set<object>();
  let disposed = false;
  const reportError = (error: unknown): void => {
    console.error('[MEO live input] derived refresh failed', error);
  };
  const run = (operation: () => void): void => {
    try {
      operation();
    } catch (error) {
      reportError(error);
    }
  };
  const cancelConsumerGeneration = (): void => {
    settleGenerationToken += 1;
    const generation = consumerGeneration;
    if (!generation || generation.state === 'cancelled') return;
    generation.state = 'cancelled';
    for (const record of generation.records.values()) record.state = 'cancelled';
    generation.records.clear();
  };
  const startConsumerGeneration = (): ConsumerGeneration => {
    cancelConsumerGeneration();
    consumerGeneration = {
      id: nextConsumerGeneration += 1,
      state: 'accepting',
      records: new Map()
    };
    return consumerGeneration;
  };
  const currentConsumerGeneration = (): ConsumerGeneration => {
    if (!consumerGeneration || consumerGeneration.state === 'cancelled'
      || consumerGeneration.state === 'settled') {
      return startConsumerGeneration();
    }
    return consumerGeneration;
  };
  const queueConsumer = (
    generation: ConsumerGeneration,
    key: object,
    operation: () => void
  ): void => {
    const existing = generation.records.get(key);
    if (!existing) {
      generation.records.set(key, { operation, state: 'queued' });
      return;
    }
    if (existing.state === 'queued') existing.operation = operation;
    // A stable key already running or settled represents this generation's
    // invalidation. Recursive requests cannot create a retained ghost record.
  };
  const drainConsumerGeneration = (generation: ConsumerGeneration): void => {
    generation.state = 'flushing';
    // Consumer keys are stable, caller-owned identities. Draining queued
    // records dynamically includes cross-key requests while each key can run
    // at most once, so same-key recursion cannot produce an infinite drain.
    while (generation === consumerGeneration && generation.state === 'flushing') {
      const next = [...generation.records.values()].find((record) => record.state === 'queued');
      if (!next) break;
      next.state = 'running';
      run(next.operation);
      if (generation === consumerGeneration && next.state === 'running') {
        next.state = 'settled';
      }
    }
  };
  const isCurrentConsumerGeneration = (generation: ConsumerGeneration): boolean => (
    generation === consumerGeneration && generation.state !== 'cancelled'
  );
  const settleConsumers = (generation: ConsumerGeneration | null): void => {
    const settleToken = settleGenerationToken += 1;
    // Mutation/Resize observers caused by a leaf are delivered at the same
    // microtask checkpoint. Keep committed-refresh open through that delivery
    // so a settled key absorbs its own DOM echo and cross-key work is drained.
    queueMicrotask(() => {
      if (settleToken !== settleGenerationToken
        || disposed || isLiveInputDerivedWorkPending(view.state)
        || generation !== consumerGeneration || generation?.state === 'cancelled') return;
      if (generation) {
        drainConsumerGeneration(generation);
        if (!isCurrentConsumerGeneration(generation)) return;
        if ([...generation.records.values()].some((record) => record.state === 'queued')) {
          settleConsumers(generation);
          return;
        }
        generation.state = 'settled';
      }
      if (view.state.field(liveInputDerivedWorkPhaseField, false)?.phase !== 'committed-refresh') return;
      try {
        view.dispatch({
          effects: settleLiveInputDerivedWorkEffect.of(true),
          annotations: Transaction.addToHistory.of(false)
        });
      } catch (error) {
        reportError(error);
      }
    });
  };
  const flushConsumers = (): void => {
    if (disposed || isLiveInputDerivedWorkPending(view.state)) return;
    const generation = consumerGeneration;
    if (generation && generation.state !== 'cancelled') drainConsumerGeneration(generation);
    settleConsumers(generation);
  };
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
    reportError
  });
  return {
    request(key: object, operation: () => void) {
      if (disposed) return;
      const phase = view.state.field(liveInputDerivedWorkPhaseField, false)?.phase;
      if (isLiveInputDerivedWorkPending(view.state) || phase === 'committed-refresh') {
        queueConsumer(currentConsumerGeneration(), key, operation);
        return;
      }
      if (immediateConsumers.has(key)) return;
      immediateConsumers.add(key);
      try {
        run(operation);
      } finally {
        immediateConsumers.delete(key);
      }
    },
    update(update: { transactions: readonly Transaction[] }) {
      for (const transaction of update.transactions) {
        if (transaction.effects.some((effect) => effect.is(beginLiveInputCompositionEffect)
          || effect.is(changeLiveInputCompositionEffect))) {
          scheduler.cancelPending();
        }
        if (transaction.effects.some((effect) => effect.is(supersedeLiveInputDerivedWorkEffect))) {
          scheduler.cancelPending();
          cancelConsumerGeneration();
        }
        if (transaction.effects.some((effect) => effect.is(cancelLiveInputDerivedWorkEffect))) {
          scheduler.cancelPending();
          cancelConsumerGeneration();
        }
        if (transaction.effects.some((effect) => effect.is(completeLiveInputCompositionEffect))
          && transaction.state.field(liveInputDerivedWorkPhaseField, false)?.phase === 'pending-input') {
          scheduler.documentChanged();
        }
        if (transaction.effects.some((effect) => effect.is(deferLiveInputDerivedWorkEffect))) {
          startConsumerGeneration();
          if (transaction.state.field(liveInputDerivedWorkPhaseField, false)?.phase === 'pending-input') {
            scheduler.documentChanged();
          }
        }
        if (transaction.effects.some((effect) => effect.is(changeLiveInputCompositionEffect))) {
          startConsumerGeneration();
        }
        if (transaction.effects.some((effect) => effect.is(refreshLiveInputDerivedWorkEffect))) {
          queueMicrotask(flushConsumers);
        }
      }
    },
    destroy() {
      disposed = true;
      scheduler.dispose();
      cancelConsumerGeneration();
      immediateConsumers.clear();
    }
  };
}

const codeMirrorLiveInputDerivedWorkPlugin = ViewPlugin.define(
  createCodeMirrorLiveInputDerivedWorkPlugin
);

export function beginLiveInputComposition(view: EditorView): void {
  if (!view.plugin(codeMirrorLiveInputDerivedWorkPlugin)) return;
  view.dispatch({
    effects: beginLiveInputCompositionEffect.of(true),
    annotations: Transaction.addToHistory.of(false)
  });
}

/**
 * The sole asynchronous derived-work entry for an Editor. A stable consumer key
 * coalesces repeated requests while the primary text frame owns presentation.
 */
export function requestLiveInputDerivedWork(
  view: EditorView,
  consumerKey: object,
  operation: () => void
): void {
  const plugin = view.plugin(codeMirrorLiveInputDerivedWorkPlugin);
  if (plugin) plugin.request(consumerKey, operation);
  else operation();
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
      if (phase === 'composing-with-pending' || phase === 'composing-without-pending') {
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
