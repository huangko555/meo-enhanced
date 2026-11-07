export type DraftRecoveryCandidate =
  | { readonly type: 'draft'; readonly baseVersion: number; readonly text: string }
  | { readonly type: 'conflict'; readonly baseVersion: number; readonly baseText: string; readonly text: string };

/** Opaque handoff identity supplied by the panel; Application never interprets it as a page. */
export type DraftRecoveryOrigin = { readonly ownerId: string; readonly receiptVersion: number };

export type PendingDraftRecovery = {
  /** Internal receipts order active input; public origin receipts are comparable only within their owner. */
  remember(candidate: DraftRecoveryCandidate | null, receiptVersion: number, origin?: DraftRecoveryOrigin): number;
  discardIfCurrent(receiptVersion: number): boolean;
  /** Includes failed retired input awaiting a later explicit recovery attempt. */
  hasPending(): boolean;
  recover(): Promise<boolean>;
  settleForTermination(): Promise<boolean>;
  /** Retired text never writes Host. Supply origin for replay protection; unscoped calls are independent. */
  preserveRetired(candidate: DraftRecoveryCandidate, origin?: DraftRecoveryOrigin): Promise<boolean>;
  /**
   * Capture unsettled text as complete, non-destructive recovery documents for
   * a process shutdown. The caller persists the returned strings; this owner
   * never writes storage while the user is typing.
   */
  captureForRestart(): readonly string[];
  /** Notifies the shutdown owner when this recovery can gain or lose a capture. */
  onDidChangePending(listener: () => void): { dispose(): void };
};

type DraftRecoveryArtifact = { readonly replace: (copyText: string) => Promise<boolean> };
type CurrentRecoveryRevision = { readonly version: number; readonly text: string } | null;

export type PendingDraftRecoveryDependencies = {
  readonly readCurrentRevision: () => CurrentRecoveryRevision;
  /** Must reject a closed/replaced document or a changed revision before mutating Host text. */
  readonly applyDraft: (expected: { readonly version: number; readonly text: string }, draftText: string) => Promise<boolean>;
  /** Creates one recovery artifact; replacement must reject user-modified/closed artifacts. */
  readonly preserveConflict: (copyText: string) => Promise<false | DraftRecoveryArtifact>;
};

type ActiveCandidate = { readonly candidate: DraftRecoveryCandidate; readonly internalReceipt: number; readonly origin?: DraftRecoveryOrigin };
type ScopeState = { readonly scope: string; settledReceipt: number; artifact: DraftRecoveryArtifact | null };
type RetiredWaiter = {
  readonly resolve: (result: boolean) => void;
  readonly reject: (error: unknown) => void;
};
type RetiredJob = {
  readonly candidate: DraftRecoveryCandidate;
  readonly scope: string;
  readonly receipt: number;
  readonly waiters: RetiredWaiter[];
  retryForActiveRequest: boolean;
};
type PendingRetired = Omit<RetiredJob, 'waiters' | 'retryForActiveRequest'>;
type ActiveRequest = {
  terminal: boolean;
  handled: boolean;
  readonly promise: Promise<boolean>;
  readonly resolve: (result: boolean) => void;
  readonly reject: (error: unknown) => void;
};

// This bounds completed metadata/capabilities; unsettled input is retained as
// pending work and coalesced per origin rather than evicted as cached history.
const MAX_HANDOFF_SCOPES = 16;
const normalizeLineEndings = (text: string): string => text.replace(/\r\n/g, '\n');
const candidateEqual = (left: DraftRecoveryCandidate, right: DraftRecoveryCandidate): boolean =>
  left.type === right.type && left.baseVersion === right.baseVersion && left.text === right.text
    && (left.type !== 'conflict' || right.type !== 'conflict' || left.baseText === right.baseText);
const scopeFor = (origin: DraftRecoveryOrigin | undefined): string => origin ? `owner:${origin.ownerId}` : 'active';
const receiptFor = (origin: DraftRecoveryOrigin | undefined, fallbackReceipt: number): number => origin?.receiptVersion ?? fallbackReceipt;

function formatConflictCopy(candidate: DraftRecoveryCandidate, current: CurrentRecoveryRevision): string {
  const base = candidate.type === 'conflict' ? `\n||||||| MEO base\n${candidate.baseText}` : '';
  const host = current === null ? '[Host document unavailable: the original document was closed before recovery.]' : current.text;
  const hostLabel = current === null ? 'Host current document unavailable' : `Host current revision ${current.version}`;
  return [`<<<<<<< MEO local recovery (base revision ${candidate.baseVersion})`, candidate.text, base,
    `=======\n${host}`, `>>>>>>> ${hostLabel}`].join('\n');
}

/** Owns one serial settlement queue for active and retired recovery candidates. */
export function createPendingDraftRecovery(dependencies: PendingDraftRecoveryDependencies): PendingDraftRecovery {
  let active: ActiveCandidate | null = null;
  let nextInternalReceipt = 0;
  let activeRequest: ActiveRequest | null = null;
  let draining: Promise<void> | null = null;
  let unscopedRetiredSequence = 0;
  const retiredJobs: RetiredJob[] = [];
  const linkedRetiredJobs: RetiredJob[] = [];
  const inFlightRetiredJobs = new Set<RetiredJob>();
  // Unsettled input is not an evictable history cache. Keep only the latest
  // failed full snapshot per admitted origin until an explicit retry settles it.
  const failedRetired = new Map<string, PendingRetired>();
  const scopes: ScopeState[] = [];
  const pinnedScopes = new Set<string>();
  const pendingListeners = new Set<() => void>();
  const notifyPendingChanged = (): void => {
    for (const listener of pendingListeners) listener();
  };

  const findScope = (scope: string): ScopeState | null => scopes.find(entry => entry.scope === scope) ?? null;
  const scopeState = (scope: string): ScopeState => {
    const existingIndex = scopes.findIndex(entry => entry.scope === scope);
    if (existingIndex >= 0) {
      const [existing] = scopes.splice(existingIndex, 1);
      scopes.push(existing);
      return existing;
    }
    const created: ScopeState = { scope, settledReceipt: -1, artifact: null };
    scopes.push(created);
    if (scopes.length > MAX_HANDOFF_SCOPES) {
      const evict = scopes.findIndex(entry => entry !== created && entry.settledReceipt >= 0 && !pinnedScopes.has(entry.scope));
      if (evict >= 0) scopes.splice(evict, 1);
    }
    return created;
  };
  const isSettled = (scope: string, receipt: number): boolean => (findScope(scope)?.settledReceipt ?? -1) >= receipt;
  const settleCoveredLinked = (): void => {
    for (let index = linkedRetiredJobs.length - 1; index >= 0; index--) {
      const job = linkedRetiredJobs[index];
      if (!isSettled(job.scope, job.receipt)) continue;
      linkedRetiredJobs.splice(index, 1);
      for (const waiter of job.waiters) waiter.resolve(true);
    }
  };
  const markSettled = (scope: string, receipt: number): void => {
    const state = scopeState(scope);
    state.settledReceipt = Math.max(state.settledReceipt, receipt);
    const failed = failedRetired.get(scope);
    if (failed && failed.receipt <= state.settledReceipt) failedRetired.delete(scope);
    settleCoveredLinked();
    notifyPendingChanged();
  };
  const finishLinked = (failure?: { readonly error: unknown }): void => {
    settleCoveredLinked();
    for (const job of linkedRetiredJobs.splice(0)) {
      for (const waiter of job.waiters) {
        if (failure) waiter.reject(failure.error);
        else waiter.resolve(false);
      }
    }
  };
  const settleRetired = (job: RetiredJob, result: boolean): void => {
    for (const waiter of job.waiters) waiter.resolve(result);
  };
  const rejectRetired = (job: RetiredJob, error: unknown): void => {
    for (const waiter of job.waiters) waiter.reject(error);
  };
  const retainRetired = (job: RetiredJob): void => {
    const previous = failedRetired.get(job.scope);
    if (!previous || previous.receipt <= job.receipt) {
      failedRetired.set(job.scope, { candidate: job.candidate, scope: job.scope, receipt: job.receipt });
    }
  };
  const enqueueRetired = (job: RetiredJob): void => {
    const retained = failedRetired.get(job.scope);
    const selected = retained && retained.receipt > job.receipt
      ? { ...retained, waiters: job.waiters, retryForActiveRequest: job.retryForActiveRequest } : job;
    const newer = retiredJobs.find(queued => queued.scope === selected.scope && queued.receipt > selected.receipt);
    if (newer) {
      newer.waiters.push(...selected.waiters);
      newer.retryForActiveRequest ||= selected.retryForActiveRequest;
      notifyPendingChanged();
      return;
    }
    for (let index = retiredJobs.length - 1; index >= 0; index--) {
      if (retiredJobs[index].scope !== selected.scope) continue;
      const previous = retiredJobs.splice(index, 1)[0];
      selected.waiters.push(...previous.waiters);
      selected.retryForActiveRequest ||= previous.retryForActiveRequest;
    }
    retiredJobs.push(selected);
    notifyPendingChanged();
  };
  const discardUnsettledScope = (state: ScopeState): void => {
    if (state.settledReceipt >= 0 || state.artifact !== null) return;
    const index = scopes.indexOf(state);
    if (index >= 0) scopes.splice(index, 1);
  };

  const preserve = async (candidate: DraftRecoveryCandidate, scope: string, current: CurrentRecoveryRevision): Promise<boolean> => {
    const state = scopeState(scope);
    try {
      const copyText = formatConflictCopy(candidate, current);
      if (state.artifact !== null) {
        try {
          if (await state.artifact.replace(copyText)) return true;
        } catch {
          // User ownership, closure, and adapter faults all release this capability.
        }
        state.artifact = null;
      }
      const created = await dependencies.preserveConflict(copyText);
      if (created === false) {
        discardUnsettledScope(state);
        return false;
      }
      state.artifact = created;
      return true;
    } catch (error) {
      discardUnsettledScope(state);
      throw error;
    }
  };

  const processRetired = async (job: RetiredJob): Promise<boolean> => {
    const { scope, receipt } = job;
    pinnedScopes.add(scope);
    try {
      if (isSettled(scope, receipt)) return true;
      const current = dependencies.readCurrentRevision();
      if (current !== null && normalizeLineEndings(current.text) === normalizeLineEndings(job.candidate.text)) {
        markSettled(scope, receipt);
        return true;
      }
      const handled = await preserve(job.candidate, scope, current);
      if (handled) markSettled(scope, receipt);
      return handled;
    } finally { pinnedScopes.delete(scope); notifyPendingChanged(); }
  };

  const processActive = async (request: ActiveRequest): Promise<'handled' | 'cleared' | 'retry'> => {
    const snapshot = active;
    if (snapshot === null) return 'cleared';
    const scope = scopeFor(snapshot.origin);
    const receipt = receiptFor(snapshot.origin, snapshot.internalReceipt);
    pinnedScopes.add(scope);
    try {
      if (isSettled(scope, receipt)) {
        if (active === snapshot) {
          active = null;
          notifyPendingChanged();
        }
        return 'cleared';
      }
      const current = dependencies.readCurrentRevision();
      if (current !== null && normalizeLineEndings(current.text) === normalizeLineEndings(snapshot.candidate.text)) {
        if (active === snapshot) {
          active = null;
          notifyPendingChanged();
        }
        markSettled(scope, receipt);
        return 'cleared';
      }
      let handled = false;
      if (current !== null && snapshot.candidate.type === 'draft' && current.version === snapshot.candidate.baseVersion) {
        try {
          // Final ownership check before the sole Host-writing port.
          if (active !== snapshot || isSettled(scope, receipt)) return 'cleared';
          handled = await dependencies.applyDraft(current, snapshot.candidate.text);
        } catch (error) {
          if (!request.terminal) throw error;
        }
        if (!handled && request.terminal) handled = await preserve(snapshot.candidate, scope, dependencies.readCurrentRevision());
      } else {
        handled = await preserve(snapshot.candidate, scope, current);
      }
      if (!handled) return 'retry';
      if (active === snapshot) {
        active = null;
        notifyPendingChanged();
      }
      markSettled(scope, receipt);
      return 'handled';
    } finally { pinnedScopes.delete(scope); notifyPendingChanged(); }
  };

  const runDrain = async (): Promise<void> => {
    for (;;) {
      // Same-turn terminal packets join this owner before any Host write/copy operation.
      await Promise.resolve();
      const activeSnapshot = active;
      if (retiredJobs.length > 0) {
        const job = retiredJobs.shift()!;
        const sameActive = activeSnapshot !== null && activeRequest !== null
          && scopeFor(activeSnapshot.origin) === job.scope
          && receiptFor(activeSnapshot.origin, activeSnapshot.internalReceipt) === job.receipt
          && candidateEqual(activeSnapshot.candidate, job.candidate);
        if (sameActive) {
          activeRequest!.terminal = true;
          linkedRetiredJobs.push(job);
          continue;
        }
        inFlightRetiredJobs.add(job);
        notifyPendingChanged();
        try {
          const settled = await processRetired(job) || isSettled(job.scope, job.receipt);
          if (!settled) retainRetired(job);
          else if (job.retryForActiveRequest && activeRequest !== null) activeRequest.handled = true;
          settleRetired(job, settled);
        } catch (error) {
          if (isSettled(job.scope, job.receipt)) settleRetired(job, true);
          else { retainRetired(job); rejectRetired(job, error); }
        } finally {
          inFlightRetiredJobs.delete(job);
          notifyPendingChanged();
        }
        continue;
      }
      const request = activeRequest;
      if (request === null) return;
      if (active === null) {
        activeRequest = null;
        request.resolve(request.handled);
        finishLinked();
        continue;
      }
      try {
        const outcome = await processActive(request);
        if (outcome === 'retry') {
          activeRequest = null;
          request.resolve(request.handled);
          finishLinked();
          continue;
        }
        if (outcome === 'handled') request.handled = true;
      } catch (error) {
        activeRequest = null;
        request.reject(error);
        finishLinked({ error });
      }
    }
  };
  const ensureDrain = (): void => {
    if (draining !== null) return;
    const work = runDrain();
    const record = work.finally(() => {
      if (draining !== record) return;
      draining = null;
      // A caller may have enqueued between runDrain observing no work and this
      // finalizer. Re-check after releasing the latch so it cannot lose wakeup.
      if (activeRequest !== null || retiredJobs.length > 0) ensureDrain();
    });
    draining = record;
  };
  const startActive = (terminal: boolean): Promise<boolean> => {
    if (activeRequest !== null) {
      if (terminal) activeRequest.terminal = true;
      return activeRequest.promise;
    }
    let resolve!: (result: boolean) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
    activeRequest = { terminal, handled: false, promise, resolve, reject };
    // Retry each retained origin once per explicit settlement request. Failure
    // remains pending work, but never re-enqueues itself in this drain.
    for (const job of failedRetired.values()) enqueueRetired({ ...job, waiters: [], retryForActiveRequest: true });
    ensureDrain();
    return promise;
  };

  return {
    remember(candidate, receiptVersion, origin) {
      if (receiptVersion <= nextInternalReceipt) return nextInternalReceipt;
      nextInternalReceipt = receiptVersion;
      active = candidate === null ? null : { candidate, internalReceipt: receiptVersion, origin };
      if (candidate === null) markSettled(scopeFor(origin), receiptFor(origin, receiptVersion));
      notifyPendingChanged();
      return nextInternalReceipt;
    },
    discardIfCurrent(receiptVersion) {
      const snapshot = active;
      if (nextInternalReceipt !== receiptVersion) return false;
      active = null;
      if (snapshot !== null) markSettled(scopeFor(snapshot.origin), receiptFor(snapshot.origin, receiptVersion));
      notifyPendingChanged();
      return true;
    },
    hasPending() {
      return active !== null || failedRetired.size > 0 || retiredJobs.length > 0
        || linkedRetiredJobs.length > 0 || inFlightRetiredJobs.size > 0 || pinnedScopes.size > 0;
    },
    recover() { return startActive(false); },
    settleForTermination() { return startActive(true); },
    preserveRetired(candidate, origin) {
      // Without an origin there is no public receipt identity to deduplicate.
      // Give each call an independent identity without retaining document text
      // in metadata or colliding with the namespace of explicit owner IDs.
      const scope = origin ? scopeFor(origin) : `retired:${++unscopedRetiredSequence}`;
      const receipt = receiptFor(origin, 0);
      if (isSettled(scope, receipt)) return Promise.resolve(true);
      let resolve!: (result: boolean) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<boolean>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
      enqueueRetired({ candidate, scope, receipt, waiters: [{ resolve, reject }], retryForActiveRequest: false });
      ensureDrain();
      return promise;
    },
    captureForRestart() {
      const current = dependencies.readCurrentRevision();
      const candidates = new Map<string, { readonly candidate: DraftRecoveryCandidate; readonly receipt: number }>();
      const retain = (scope: string, receipt: number, candidate: DraftRecoveryCandidate): void => {
        if (isSettled(scope, receipt)
          || (current !== null && normalizeLineEndings(current.text) === normalizeLineEndings(candidate.text))) return;
        const previous = candidates.get(scope);
        if (!previous || previous.receipt <= receipt) candidates.set(scope, { candidate, receipt });
      };
      if (active !== null) retain(scopeFor(active.origin), receiptFor(active.origin, active.internalReceipt), active.candidate);
      for (const job of retiredJobs) retain(job.scope, job.receipt, job.candidate);
      for (const job of linkedRetiredJobs) retain(job.scope, job.receipt, job.candidate);
      for (const job of inFlightRetiredJobs) retain(job.scope, job.receipt, job.candidate);
      for (const job of failedRetired.values()) retain(job.scope, job.receipt, job.candidate);
      return Array.from(new Set(Array.from(candidates.values(), entry => formatConflictCopy(entry.candidate, current))));
    },
    onDidChangePending(listener) {
      pendingListeners.add(listener);
      return { dispose: () => { pendingListeners.delete(listener); } };
    }
  };
}
