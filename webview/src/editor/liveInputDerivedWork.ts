import { Annotation, EditorState, Facet, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet } from '@codemirror/view';

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
} & ({
  requestDeferred(callback: () => void, timeoutMs: number): number;
  cancelDeferred(taskId: number): void;
} | {
  requestDeferred?: never;
  cancelDeferred?: never;
});

const LARGE_DOCUMENT_DERIVED_WORK_DEADLINE_MS = 500;
// requestIdleCallback can run between operating-system key-repeat events. Give
// large documents a real quiet window first, otherwise one full decoration
// rebuild blocks later key events and makes characters arrive in batches.
const LARGE_DOCUMENT_INPUT_QUIET_MS = 120;

/**
 * Coalesces derived presentation behind one observable primary-text frame.
 * Generation is private so stale frame callbacks cannot become a second owner.
 */
export function createLiveInputDerivedWorkScheduler(
  options: LiveInputDerivedWorkSchedulerOptions
): LiveInputDerivedWorkScheduler {
  let generation = 0;
  let frameId: number | null = null;
  let deferredId: number | null = null;
  let disposed = false;

  const cancelPendingFrame = (): void => {
    if (frameId === null) return;
    options.cancelFrame(frameId);
    frameId = null;
  };

  const cancelPendingDeferred = (): void => {
    if (deferredId === null) return;
    options.cancelDeferred?.(deferredId);
    deferredId = null;
  };

  const applyCurrentGeneration = (currentGeneration: number): void => {
    if (disposed || currentGeneration !== generation) return;
    try {
      options.apply();
    } catch (error) {
      options.reportError(error);
    }
  };

  const scheduleDerivedFrame = (currentGeneration: number): void => {
    frameId = options.requestFrame(() => {
      frameId = null;
      if (disposed || currentGeneration !== generation) return;
      if (options.requestDeferred) {
        // Let the accepted text produce two consecutive painted frames before
        // an unbounded full-document refresh is allowed to enter browser idle.
        frameId = options.requestFrame(() => {
          frameId = null;
          if (disposed || currentGeneration !== generation) return;
          deferredId = options.requestDeferred(() => {
            deferredId = null;
            applyCurrentGeneration(currentGeneration);
          }, LARGE_DOCUMENT_DERIVED_WORK_DEADLINE_MS);
        });
        return;
      }
      applyCurrentGeneration(currentGeneration);
    });
  };

  return {
    documentChanged() {
      if (disposed) return;
      generation += 1;
      const currentGeneration = generation;
      cancelPendingFrame();
      cancelPendingDeferred();
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
      cancelPendingDeferred();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation += 1;
      cancelPendingFrame();
      cancelPendingDeferred();
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
const resumeLiveInputAcceptedWorkEffect = StateEffect.define<true>();

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
export const replaceLiveInputNestedDecorationEffect = StateEffect.define<{
  from: number;
  to: number;
  decoration: Decoration;
}>();
const liveInputDerivedWorkLargeDocumentFacet = Facet.define<boolean, boolean>({
  combine: (values) => values.some(Boolean)
});

export function usesLargeDocumentDerivedWorkBudget(state: EditorState): boolean {
  return state.facet(liveInputDerivedWorkLargeDocumentFacet);
}

export function markLiveInputDerivedWorkFollowUp(): Annotation<LiveInputDerivedWorkProvenance> {
  return liveInputDerivedWorkProvenance.of('automatic-normalization');
}

export function markLiveInputNestedProjection(): Annotation<LiveInputDerivedWorkProvenance> {
  return liveInputDerivedWorkProvenance.of('nested-input-projection');
}

export function replaceLiveInputNestedDecoration(
  from: number,
  to: number,
  decoration: Decoration
): StateEffect<unknown> {
  return replaceLiveInputNestedDecorationEffect.of({ from, to, decoration });
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
        if (next.phase === 'composing-with-pending') {
          next = { phase: 'pending-input' };
        } else if (next.phase === 'composing-without-pending') {
          next = idleLiveInputDerivedWorkPhase;
        }
      } else if (effect.is(resumeLiveInputAcceptedWorkEffect)) {
        next = { phase: 'pending-input' };
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

/** Maps stable presentation while dropping only widgets that cover edited text. */
export function mapLiveInputDerivedDecorations(
  decorations: DecorationSet,
  transaction: Transaction
): DecorationSet {
  let mapped = decorations.map(transaction.changes);
  const affected: Array<{ from: number; to: number }> = [];
  transaction.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    affected.push({ from: fromB, to: toB });
  });
  for (const range of affected) {
    const doc = transaction.newDoc;
    const filterFrom = doc.lineAt(Math.min(range.from, doc.length)).from;
    const filterTo = doc.lineAt(Math.min(range.to, doc.length)).to;
    mapped = mapped.update({
      filterFrom,
      filterTo,
      filter: (from, to, decoration) => {
        if (!decoration.spec.widget) return true;
        return range.from === range.to
          ? range.from < from || range.from > to
          : range.to <= from || range.from >= to;
      }
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
    state: 'accepting' | 'flushing' | 'settled' | 'cancelled';
    records: Map<object, ConsumerRecord>;
  };
  type FrameConsumerRecordState = 'scheduled-frame' | 'accepted-generation' | 'running';
  type FrameConsumerRecord = {
    operation: () => void;
    frameId: number | null;
    state: FrameConsumerRecordState;
  };

  let consumerGeneration: ConsumerGeneration | null = null;
  let settleGenerationToken = 0;
  const immediateConsumers = new Set<object>();
  const runningFrameConsumers = new Set<object>();
  const frameConsumers = new Map<object, FrameConsumerRecord>();
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
  const cancelFrameConsumers = (): void => {
    for (const record of frameConsumers.values()) {
      if (record.frameId !== null) window.cancelAnimationFrame(record.frameId);
    }
    frameConsumers.clear();
    runningFrameConsumers.clear();
  };
  const closeConsumerGenerationAfterTransactionFailure = (error: unknown): unknown => {
    let failure = error;
    try {
      view.dispatch({
        effects: cancelLiveInputDerivedWorkEffect.of(true),
        annotations: Transaction.addToHistory.of(false)
      });
    } catch (cleanupError) {
      failure = new AggregateError(
        [error, cleanupError],
        'Live derived transaction and cleanup failed'
      );
    } finally {
      // The cancel transaction normally reaches the plugin update above. Keep
      // local closure unconditional so a second StateField failure cannot
      // retain records or a late observer checkpoint.
      cancelConsumerGeneration();
      cancelFrameConsumers();
    }
    return failure;
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
  const consumeFrameConsumer = (key: object, record: FrameConsumerRecord): void => {
    if (frameConsumers.get(key) !== record) return;
    frameConsumers.delete(key);
    record.state = 'running';
    runningFrameConsumers.add(key);
    try {
      record.operation();
    } finally {
      runningFrameConsumers.delete(key);
    }
  };
  const queueFrameConsumer = (
    generation: ConsumerGeneration,
    key: object,
    record: FrameConsumerRecord
  ): void => {
    if (record.frameId !== null) {
      window.cancelAnimationFrame(record.frameId);
      record.frameId = null;
    }
    record.state = 'accepted-generation';
    queueConsumer(generation, key, () => consumeFrameConsumer(key, record));
  };
  const adoptFrameConsumers = (): void => {
    if (frameConsumers.size === 0) return;
    const generation = currentConsumerGeneration();
    for (const [key, record] of frameConsumers) {
      queueFrameConsumer(generation, key, record);
    }
  };
  const startConsumerGeneration = (): ConsumerGeneration => {
    cancelConsumerGeneration();
    consumerGeneration = {
      state: 'accepting',
      records: new Map()
    };
    for (const [key, record] of frameConsumers) {
      queueFrameConsumer(consumerGeneration, key, record);
    }
    return consumerGeneration;
  };
  const currentConsumerGeneration = (): ConsumerGeneration => {
    if (!consumerGeneration || consumerGeneration.state === 'cancelled'
      || consumerGeneration.state === 'settled') {
      return startConsumerGeneration();
    }
    return consumerGeneration;
  };
  const drainConsumerGeneration = (generation: ConsumerGeneration): number => {
    let ran = 0;
    generation.state = 'flushing';
    // Consumer keys are stable, caller-owned identities. Draining queued
    // records dynamically includes cross-key requests while each key can run
    // at most once, so same-key recursion cannot produce an infinite drain.
    while (generation === consumerGeneration && generation.state === 'flushing') {
      const next = [...generation.records.values()].find((record) => record.state === 'queued');
      if (!next) break;
      next.state = 'running';
      ran += 1;
      run(next.operation);
      if (generation === consumerGeneration && next.state === 'running') {
        next.state = 'settled';
      }
    }
    return ran;
  };
  const isCurrentConsumerGeneration = (generation: ConsumerGeneration): boolean => (
    generation === consumerGeneration && generation.state !== 'cancelled'
  );
  const scheduleConsumerCheckpoint = (
    generation: ConsumerGeneration,
    quietCandidate: boolean
  ): void => {
    const settleToken = settleGenerationToken += 1;
    // Each callback runs after observer delivery for the preceding drain.
    // A zero-work round becomes a quiet candidate and must survive one more
    // checkpoint before committed-refresh may settle.
    queueMicrotask(() => {
      if (settleToken !== settleGenerationToken
        || disposed || isLiveInputDerivedWorkPending(view.state)
        || !isCurrentConsumerGeneration(generation)) return;
      const ran = drainConsumerGeneration(generation);
      if (!isCurrentConsumerGeneration(generation)) return;
      if (ran > 0) {
        scheduleConsumerCheckpoint(generation, false);
        return;
      }
      if (!quietCandidate) {
        scheduleConsumerCheckpoint(generation, true);
        return;
      }
      generation.state = 'settled';
      if (view.state.field(liveInputDerivedWorkPhaseField, false)?.phase !== 'committed-refresh') return;
      try {
        view.dispatch({
          effects: settleLiveInputDerivedWorkEffect.of(true),
          annotations: Transaction.addToHistory.of(false)
        });
        scheduleOutstandingFrameConsumers();
      } catch (error) {
        reportError(closeConsumerGenerationAfterTransactionFailure(error));
      }
    });
  };
  const flushConsumers = (): void => {
    if (disposed || isLiveInputDerivedWorkPending(view.state)) return;
    const generation = currentConsumerGeneration();
    const ran = drainConsumerGeneration(generation);
    scheduleConsumerCheckpoint(generation, ran === 0);
  };
  const requestConsumer = (key: object, operation: () => void): void => {
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
  };
  const getDesiredFrameConsumer = (key: object, operation: () => void): FrameConsumerRecord => {
    const existing = frameConsumers.get(key);
    if (existing) {
      existing.operation = operation;
      return existing;
    }
    const record: FrameConsumerRecord = { operation, frameId: null, state: 'scheduled-frame' };
    frameConsumers.set(key, record);
    return record;
  };
  const scheduleFrameConsumer = (key: object, record: FrameConsumerRecord): void => {
    if (record.frameId !== null || disposed || frameConsumers.get(key) !== record) return;
    record.state = 'scheduled-frame';
    const frameId = window.requestAnimationFrame(() => {
      if (frameConsumers.get(key) !== record || record.frameId !== frameId) return;
      record.frameId = null;
      requestConsumer(key, () => consumeFrameConsumer(key, record));
    });
    record.frameId = frameId;
  };
  function scheduleOutstandingFrameConsumers(): void {
    if (disposed || isLiveInputDerivedWorkPending(view.state)
      || view.state.field(liveInputDerivedWorkPhaseField, false)?.phase === 'committed-refresh') return;
    for (const [key, record] of frameConsumers) scheduleFrameConsumer(key, record);
  }
  const requestConsumerOnFrame = (key: object, operation: () => void): void => {
    if (disposed || immediateConsumers.has(key) || runningFrameConsumers.has(key)) return;
    const record = getDesiredFrameConsumer(key, operation);
    const phase = view.state.field(liveInputDerivedWorkPhaseField, false)?.phase;
    if (isLiveInputDerivedWorkPending(view.state) || phase === 'committed-refresh') {
      queueFrameConsumer(currentConsumerGeneration(), key, record);
      return;
    }
    scheduleFrameConsumer(key, record);
  };
  const hasAcceptedConsumerWork = (): boolean => {
    const generation = consumerGeneration;
    return Boolean(generation && generation.state !== 'cancelled'
      && [...generation.records.values()].some((record) => record.state === 'queued'));
  };
  const hasAcceptedFrameDesired = (): boolean => (
    [...frameConsumers.values()].some((record) => record.state === 'accepted-generation')
  );
  const largeDocument = view.state.facet(liveInputDerivedWorkLargeDocumentFacet);
  const canRequestIdle = largeDocument && typeof window.requestIdleCallback === 'function';
  let nextDeferredTaskId = 1;
  const deferredTasks = new Map<number, {
    idleId: number | null;
    quietTimerId: number | null;
  }>();
  const requestLargeDocumentDeferred = (
    callback: () => void,
    timeoutMs: number
  ): number => {
    const taskId = nextDeferredTaskId++;
    const task = { idleId: null as number | null, quietTimerId: null as number | null };
    deferredTasks.set(taskId, task);
    task.quietTimerId = window.setTimeout(() => {
      task.quietTimerId = null;
      if (!deferredTasks.has(taskId)) return;
      const run = () => {
        if (!deferredTasks.delete(taskId)) return;
        callback();
      };
      task.idleId = canRequestIdle
        ? window.requestIdleCallback(run, { timeout: timeoutMs })
        : window.requestAnimationFrame(run);
    }, LARGE_DOCUMENT_INPUT_QUIET_MS);
    return taskId;
  };
  const cancelLargeDocumentDeferred = (taskId: number): void => {
    const task = deferredTasks.get(taskId);
    if (!task) return;
    deferredTasks.delete(taskId);
    if (task.quietTimerId !== null) window.clearTimeout(task.quietTimerId);
    if (task.idleId !== null) {
      if (canRequestIdle) window.cancelIdleCallback(task.idleId);
      else window.cancelAnimationFrame(task.idleId);
    }
  };
  const schedulerOptions = {
    requestFrame: (callback: () => void) => window.requestAnimationFrame(() => callback()),
    cancelFrame: (frameId: number) => window.cancelAnimationFrame(frameId),
    apply() {
      try {
        view.dispatch({ effects: refreshLiveInputDerivedWorkEffect.of(true) });
      } catch (error) {
        throw closeConsumerGenerationAfterTransactionFailure(error);
      }
    },
    reportError
  };
  const scheduler = largeDocument
    ? createLiveInputDerivedWorkScheduler({
      ...schedulerOptions,
      requestDeferred: requestLargeDocumentDeferred,
      cancelDeferred: cancelLargeDocumentDeferred
    })
    : createLiveInputDerivedWorkScheduler(schedulerOptions);
  return {
    request(key: object, operation: () => void) {
      requestConsumer(key, operation);
    },
    requestOnFrame(key: object, operation: () => void) {
      requestConsumerOnFrame(key, operation);
    },
    completeComposition() {
      const phase = view.state.field(liveInputDerivedWorkPhaseField, false)?.phase;
      if (phase !== 'composing-with-pending' && phase !== 'composing-without-pending') return;
      adoptFrameConsumers();
      const resumeAcceptedWork = phase === 'composing-without-pending'
        && (hasAcceptedConsumerWork() || hasAcceptedFrameDesired());
      view.dispatch({
        effects: [
          completeLiveInputCompositionEffect.of(true),
          ...(resumeAcceptedWork ? [resumeLiveInputAcceptedWorkEffect.of(true)] : [])
        ],
        annotations: Transaction.addToHistory.of(false)
      });
    },
    update(update: { transactions: readonly Transaction[] }) {
      for (const transaction of update.transactions) {
        const beginsComposition = transaction.effects.some((effect) => effect.is(beginLiveInputCompositionEffect));
        const changesComposition = transaction.effects.some((effect) => effect.is(changeLiveInputCompositionEffect));
        const completesComposition = transaction.effects.some((effect) => effect.is(completeLiveInputCompositionEffect));
        const defersInput = transaction.effects.some((effect) => effect.is(deferLiveInputDerivedWorkEffect));
        const resumesAcceptedWork = transaction.effects.some((effect) => effect.is(resumeLiveInputAcceptedWorkEffect));
        const supersedes = transaction.effects.some((effect) => effect.is(supersedeLiveInputDerivedWorkEffect));
        const cancels = transaction.effects.some((effect) => effect.is(cancelLiveInputDerivedWorkEffect));
        const refreshes = transaction.effects.some((effect) => effect.is(refreshLiveInputDerivedWorkEffect));

        if (beginsComposition || changesComposition) {
          scheduler.cancelPending();
        }
        if (supersedes || cancels) {
          scheduler.cancelPending();
          cancelConsumerGeneration();
          cancelFrameConsumers();
          continue;
        }
        if (changesComposition || defersInput) {
          startConsumerGeneration();
        } else if (beginsComposition) {
          adoptFrameConsumers();
        }
        if ((completesComposition || defersInput || resumesAcceptedWork)
          && transaction.state.field(liveInputDerivedWorkPhaseField, false)?.phase === 'pending-input') {
          scheduler.documentChanged();
        }
        if (refreshes) {
          queueMicrotask(flushConsumers);
        }
      }
    },
    destroy() {
      disposed = true;
      scheduler.dispose();
      for (const taskId of [...deferredTasks.keys()]) cancelLargeDocumentDeferred(taskId);
      cancelConsumerGeneration();
      cancelFrameConsumers();
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

export function completeLiveInputComposition(view: EditorView): void {
  view.plugin(codeMirrorLiveInputDerivedWorkPlugin)?.completeComposition();
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

/**
 * Coalesces a stable consumer's latest invalidation through the Editor's frame
 * and input-generation currentness. Callers do not own a frame or generation.
 */
export function requestLiveInputDerivedWorkOnFrame(
  view: EditorView,
  consumerKey: object,
  operation: () => void
): void {
  const plugin = view.plugin(codeMirrorLiveInputDerivedWorkPlugin);
  if (plugin) plugin.requestOnFrame(consumerKey, operation);
  else window.requestAnimationFrame(operation);
}

function isHistoryTransaction(transaction: Transaction): boolean {
  const userEvent = transaction.annotation(Transaction.userEvent);
  return typeof userEvent === 'string'
    && (userEvent === 'undo' || userEvent === 'redo'
      || userEvent.startsWith('undo.') || userEvent.startsWith('redo.'));
}

export function liveInputDerivedWorkExtensions(options: { readonly largeDocument?: boolean } = {}): Extension[] {
  return [
    liveInputDerivedWorkLargeDocumentFacet.of(options.largeDocument === true),
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
