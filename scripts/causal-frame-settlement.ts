export type CausalSettlementPhase = 'scheduling' | 'awaitingAcceptance' | 'accepted' | 'complete' | 'disposed';

type FrameEnvironment = {
  requestAnimationFrame: typeof requestAnimationFrame;
  cancelAnimationFrame: typeof cancelAnimationFrame;
  queueMicrotask: typeof queueMicrotask;
};

type CausalFrameRecord = {
  readonly callback: FrameRequestCallback;
  nativeHandle: number | null;
  state: 'queued' | 'executing' | 'cancelled' | 'complete';
};

export type CausalSettlementDiagnostics = {
  readonly phase: CausalSettlementPhase;
  readonly rootReturned: boolean;
  readonly acceptances: number;
  readonly pendingMicrotasks: number;
  readonly pendingFrames: number;
  readonly failure: string | null;
};

export type CausalFrameSettlement<T> = {
  runRoot(root: () => void): void;
  beginEventRoot(): void;
  beginExternalRoot(): () => void;
  accept(): void;
  reject(message: string): void;
  trace(): readonly T[];
  diagnostics(): CausalSettlementDiagnostics;
  dispose(): void;
};

/**
 * Test-only causal scheduler for a public input transaction. Native timer work is
 * intentionally outside this identity model: a public acceptance callback moves an
 * otherwise-empty root from awaitingAcceptance to accepted, then captures only the
 * synchronous/microtask/RAF work causally following that acceptance.
 */
export function installCausalFrameSettlement<T>(
  environment: FrameEnvironment,
  sample: () => T
): CausalFrameSettlement<T> {
  const originalRequestAnimationFrame = environment.requestAnimationFrame.bind(environment);
  const originalCancelAnimationFrame = environment.cancelAnimationFrame.bind(environment);
  const originalQueueMicrotask = environment.queueMicrotask.bind(environment);
  const callbacks = new Map<object, CausalFrameRecord>();
  const ownedHandles = new Set<object>();
  const frames: T[] = [];
  let causalDepth = 0;
  let roots = 0;
  let rootReturned = false;
  let accepted = false;
  let acceptances = 0;
  let pendingMicrotasks = 0;
  let disposed = false;
  let failure: string | null = null;

  const phase = (): CausalSettlementPhase => {
    if (disposed) return 'disposed';
    if (accepted && rootReturned && pendingMicrotasks === 0 && callbacks.size === 0) return 'complete';
    if (accepted) return 'accepted';
    return rootReturned ? 'awaitingAcceptance' : 'scheduling';
  };
  const capture = () => { if (accepted) frames.push(sample()); };
  const runCausal = (callback: () => void) => {
    causalDepth += 1;
    try {
      callback();
    } finally {
      causalDepth -= 1;
    }
  };
  const completeRoot = () => {
    roots -= 1;
    if (roots === 0) {
      rootReturned = true;
      capture();
    }
  };
  const beginExternalRoot = (): (() => void) => {
    if (disposed) throw new Error('Cannot start a disposed causal settlement');
    roots += 1;
    rootReturned = false;
    causalDepth += 1;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      causalDepth -= 1;
      completeRoot();
    };
  };

  environment.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    if (causalDepth === 0) return originalRequestAnimationFrame(callback);
    // CodeMirror compares its scheduled handle to -1, so the opaque object must
    // remain positive when coerced while identity routing stays non-numeric.
    const handle = Object.freeze({ valueOf: () => 1 });
    const record: CausalFrameRecord = { callback, nativeHandle: null, state: 'queued' };
    callbacks.set(handle, record);
    ownedHandles.add(handle);
    record.nativeHandle = originalRequestAnimationFrame((timestamp) => {
      const current = callbacks.get(handle);
      if (!current || current.state === 'cancelled') return;
      current.state = 'executing';
      try {
        runCausal(() => current.callback(timestamp));
      } finally {
        if (current.state === 'executing') current.state = 'complete';
        callbacks.delete(handle);
        capture();
      }
    });
    return handle as unknown as number;
  }) as typeof requestAnimationFrame;

  environment.cancelAnimationFrame = ((handle: number) => {
    const opaqueHandle = handle as unknown as object;
    const record = callbacks.get(opaqueHandle);
    if (!record) {
      if (ownedHandles.has(opaqueHandle)) return;
      originalCancelAnimationFrame(handle);
      return;
    }
    if (record.state === 'queued') {
      record.state = 'cancelled';
      callbacks.delete(opaqueHandle);
      if (record.nativeHandle !== null) originalCancelAnimationFrame(record.nativeHandle);
      capture();
      return;
    }
    if (record.state === 'executing') record.state = 'cancelled';
  }) as typeof cancelAnimationFrame;

  environment.queueMicrotask = ((callback: VoidFunction) => {
    if (causalDepth === 0) {
      originalQueueMicrotask(callback);
      return;
    }
    pendingMicrotasks += 1;
    originalQueueMicrotask(() => {
      try {
        runCausal(callback);
      } finally {
        pendingMicrotasks -= 1;
        capture();
      }
    });
  }) as typeof queueMicrotask;

  return {
    runRoot(root) {
      const endRoot = beginExternalRoot();
      try {
        root();
      } finally {
        endRoot();
      }
    },
    beginExternalRoot,
    beginEventRoot() {
      const endRoot = beginExternalRoot();
      // The native completion microtask follows event propagation. Production
      // microtasks queued during propagation retain causal wrapping above.
      originalQueueMicrotask(endRoot);
    },
    accept() {
      if (disposed) throw new Error('Cannot accept a disposed causal settlement');
      if (accepted) throw new Error('Public input published more than once');
      accepted = true;
      acceptances += 1;
      // The callback is public; retain causal ownership through the rest of its
      // current task, then begin post-acceptance sampling after that task returns.
      causalDepth += 1;
      pendingMicrotasks += 1;
      capture();
      originalQueueMicrotask(() => {
        causalDepth -= 1;
        pendingMicrotasks -= 1;
        capture();
      });
    },
    reject(message) {
      if (failure === null) failure = message;
    },
    trace() { return [...frames]; },
    diagnostics() {
      return {
        phase: phase(),
        rootReturned,
        acceptances,
        pendingMicrotasks,
        pendingFrames: callbacks.size,
        failure
      };
    },
    dispose() {
      if (disposed) return;
      const cleanupErrors: unknown[] = [];
      for (const [handle, record] of callbacks) {
        if (record.state === 'queued' && record.nativeHandle !== null) {
          try {
            originalCancelAnimationFrame(record.nativeHandle);
          } catch (error) {
            cleanupErrors.push(error);
          }
        }
        record.state = 'cancelled';
        callbacks.delete(handle);
      }
      ownedHandles.clear();
      environment.requestAnimationFrame = originalRequestAnimationFrame as typeof requestAnimationFrame;
      environment.cancelAnimationFrame = originalCancelAnimationFrame as typeof cancelAnimationFrame;
      environment.queueMicrotask = originalQueueMicrotask as typeof queueMicrotask;
      disposed = true;
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'Causal settlement cleanup failed');
    }
  };
}
