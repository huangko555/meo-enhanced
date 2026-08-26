import assert from 'node:assert/strict';
import { installCausalFrameSettlement } from './causal-frame-settlement';

function createFakeEnvironment({
  throwOnCancel = false,
  cancelErrors = [] as readonly unknown[]
}: { throwOnCancel?: boolean; cancelErrors?: readonly unknown[] } = {}) {
  let nextHandle = 1;
  const frames = new Map<number, FrameRequestCallback>();
  const microtasks: VoidFunction[] = [];
  let nativeCancels = 0;
  let cancellationErrorIndex = 0;
  const environment = {
    requestAnimationFrame(callback: FrameRequestCallback) {
      const handle = nextHandle++;
      frames.set(handle, callback);
      return handle;
    },
    cancelAnimationFrame(handle: number) {
      nativeCancels += 1;
      if (cancellationErrorIndex < cancelErrors.length) {
        throw cancelErrors[cancellationErrorIndex++];
      }
      if (throwOnCancel) throw new Error(`native cancel ${handle} failed`);
      frames.delete(handle);
    },
    queueMicrotask(callback: VoidFunction) { microtasks.push(callback); }
  } as unknown as Window;
  const drain = () => {
    while (microtasks.length || frames.size) {
      while (microtasks.length) microtasks.shift()?.();
      const batch = [...frames.values()];
      frames.clear();
      for (const callback of batch) callback(0);
    }
  };
  return { environment, drain, nativeCancels: () => nativeCancels };
}

const thrown = (callback: () => void): unknown => {
  try {
    callback();
  } catch (error) {
    return error;
  }
  throw new Error('Expected callback to throw');
};
const captured = (callback: () => void): { threw: boolean; error?: unknown } => {
  try {
    callback();
    return { threw: false };
  } catch (error) {
    return { threw: true, error };
  }
};

const complete = (settlement: ReturnType<typeof installCausalFrameSettlement>) => {
  assert.deepEqual(settlement.diagnostics(), {
    phase: 'complete', rootReturned: true, acceptances: 1, pendingMicrotasks: 0, pendingFrames: 0, failure: null
  });
};
const stable = (values: readonly number[]) => {
  for (const value of values) assert.equal(value, values[0], `late causal rollback escaped the trace: ${JSON.stringify(values)}`);
};

{
  const fake = createFakeEnvironment();
  let value = 1;
  const settlement = installCausalFrameSettlement(fake.environment, () => value);
  settlement.runRoot(() => {});
  assert.equal(settlement.diagnostics().phase, 'awaitingAcceptance', 'an empty root must not complete before public acceptance');
  assert.equal(settlement.trace().length, 0, 'pre-acceptance snapshots must not masquerade as a settled trace');
  settlement.accept();
  fake.drain();
  complete(settlement);
  assert.equal(settlement.trace().length, 2, 'acceptance with zero RAFs must still sample callback return and microtask boundary');
  settlement.dispose();
}

{
  const fake = createFakeEnvironment();
  let first = 0;
  let second = 0;
  const settlement = installCausalFrameSettlement(fake.environment, () => first + second);
  settlement.runRoot(() => {});
  settlement.accept();
  fake.environment.queueMicrotask(() => { first += 1; });
  fake.environment.queueMicrotask(() => { second += 1; });
  settlement.dispose();
  fake.drain();
  assert.deepEqual([first, second], [0, 0], 'dispose must invalidate every queued causal microtask, not only the first');
  assert.equal(settlement.diagnostics().pendingMicrotasks, 0);
}

{
  const fake = createFakeEnvironment();
  let executing = 0;
  let chainedMicrotasks = 0;
  let chainedRafs = 0;
  const settlement = installCausalFrameSettlement(fake.environment, () => executing + chainedMicrotasks + chainedRafs);
  settlement.runRoot(() => {});
  settlement.accept();
  const cancelledDuringDispose = fake.environment.requestAnimationFrame(() => {});
  let traceAtExecutingDispose: readonly number[] = [];
  fake.environment.queueMicrotask(() => {
    executing += 1;
    traceAtExecutingDispose = settlement.trace();
    settlement.dispose();
    fake.environment.cancelAnimationFrame(cancelledDuringDispose);
    fake.environment.queueMicrotask(() => { chainedMicrotasks += 1; });
    fake.environment.requestAnimationFrame(() => { chainedRafs += 1; });
  });
  fake.drain();
  assert.deepEqual([executing, chainedMicrotasks, chainedRafs], [1, 0, 0], 'executing disposal may finish current work but must reject all successors');
  assert.equal(fake.nativeCancels(), 1, 'post-dispose cancellation of an owned opaque handle must not reach native routing');
  assert.deepEqual(settlement.trace(), traceAtExecutingDispose, 'executing disposal must not append a late capture');
  assert.deepEqual(
    settlement.diagnostics(),
    { phase: 'disposed', rootReturned: true, acceptances: 1, pendingMicrotasks: 0, pendingFrames: 0, failure: null }
  );
}

{
  const fake = createFakeEnvironment({ throwOnCancel: true });
  const settlement = installCausalFrameSettlement(fake.environment, () => 0);
  settlement.runRoot(() => {});
  settlement.accept();
  fake.environment.requestAnimationFrame(() => {});
  fake.environment.queueMicrotask(() => {
    try {
      throw new Error('primary microtask failure');
    } finally {
      settlement.dispose();
    }
  });
  let observed: unknown = null;
  try {
    fake.drain();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof AggregateError, 'cleanup failure must preserve the executing callback primary error');
  assert.equal((observed as AggregateError).errors[0] instanceof Error && (observed as AggregateError).errors[0].message, 'primary microtask failure');
  assert.equal((observed as AggregateError).errors[1] instanceof Error && (observed as AggregateError).errors[1].message, 'native cancel 1 failed');
  assert.equal(settlement.diagnostics().phase, 'disposed');
}

for (const primary of [null, undefined, 0, false, ''] as const) {
  const fake = createFakeEnvironment({ throwOnCancel: true });
  const settlement = installCausalFrameSettlement(fake.environment, () => 0);
  settlement.runRoot(() => {});
  settlement.accept();
  fake.environment.requestAnimationFrame(() => {});
  fake.environment.queueMicrotask(() => {
    try {
      throw primary;
    } finally {
      settlement.dispose();
    }
  });
  const observed = thrown(fake.drain);
  assert.ok(observed instanceof AggregateError, `falsy primary ${String(primary)} must remain the first completion error`);
  assert.deepEqual(
    (observed as AggregateError).errors,
    [primary, new Error('native cancel 1 failed')],
    `falsy primary ${String(primary)} must survive cleanup aggregation`
  );
}

{
  const fake = createFakeEnvironment({ throwOnCancel: true });
  const settlement = installCausalFrameSettlement(fake.environment, () => 0);
  const endRoot = settlement.beginExternalRoot();
  fake.environment.requestAnimationFrame(() => {});
  settlement.dispose();
  const observed = thrown(endRoot);
  assert.ok(observed instanceof Error);
  assert.equal(observed.message, 'native cancel 1 failed', 'external-root completion must flush deferred cleanup failures');
  endRoot();
}

for (const cleanup of [null, undefined, 0, false, ''] as const) {
  const fake = createFakeEnvironment({ cancelErrors: [cleanup] });
  const settlement = installCausalFrameSettlement(fake.environment, () => 0);
  const endRoot = settlement.beginExternalRoot();
  fake.environment.requestAnimationFrame(() => {});
  settlement.dispose();
  assert.equal(
    thrown(endRoot),
    cleanup,
    `cleanup value ${String(cleanup)} must remain observable when it is the only completion failure`
  );
}

{
  const primary = new Error('root primary');
  const firstCleanup = new Error('first cleanup');
  const secondCleanup = new Error('second cleanup');
  const fake = createFakeEnvironment({ cancelErrors: [firstCleanup, secondCleanup] });
  const settlement = installCausalFrameSettlement(fake.environment, () => 0);
  const observed = thrown(() => settlement.runRoot(() => {
    fake.environment.requestAnimationFrame(() => {});
    fake.environment.requestAnimationFrame(() => {});
    try {
      throw primary;
    } finally {
      settlement.dispose();
    }
  }));
  assert.ok(observed instanceof AggregateError, 'root primary and cleanup failures must be reported together');
  assert.deepEqual((observed as AggregateError).errors, [primary, firstCleanup, secondCleanup]);
}

{
  const firstCleanup = new Error('cleanup one');
  const secondCleanup = new Error('cleanup two');
  const fake = createFakeEnvironment({ cancelErrors: [firstCleanup, secondCleanup] });
  const settlement = installCausalFrameSettlement(fake.environment, () => 0);
  const endRoot = settlement.beginExternalRoot();
  fake.environment.requestAnimationFrame(() => {});
  fake.environment.requestAnimationFrame(() => {});
  settlement.dispose();
  const observed = thrown(endRoot);
  assert.ok(observed instanceof AggregateError, 'multiple cleanup-only failures must remain grouped');
  assert.deepEqual((observed as AggregateError).errors, [firstCleanup, secondCleanup]);
}

{
  const cleanup = new Error('nested external cleanup');
  const fake = createFakeEnvironment({ cancelErrors: [cleanup] });
  const settlement = installCausalFrameSettlement(fake.environment, () => 0);
  const endOuterRoot = settlement.beginExternalRoot();
  const endInnerRoot = settlement.beginExternalRoot();
  fake.environment.requestAnimationFrame(() => {});
  settlement.dispose();
  endInnerRoot();
  assert.equal(settlement.diagnostics().rootReturned, false, 'inner external completion must retain outer ownership');
  assert.equal(thrown(endOuterRoot), cleanup, 'depth reaching zero must flush deferred cleanup exactly once');
  endOuterRoot();
}

{
  const primary = new Error('already reported primary');
  const lateCleanup = new Error('late disposal cleanup');
  const fake = createFakeEnvironment({ cancelErrors: [lateCleanup] });
  const settlement = installCausalFrameSettlement(fake.environment, () => 0);
  const primaryOutcome = captured(() => settlement.runRoot(() => {
    fake.environment.requestAnimationFrame(() => {});
    throw primary;
  }));
  assert.deepEqual(primaryOutcome, { threw: true, error: primary }, 'primary completion must remain a standalone first failure');
  assert.deepEqual(
    captured(() => settlement.dispose()),
    { threw: true, error: lateCleanup },
    'cleanup after an already-reported primary must surface as an explicit late cleanup failure'
  );
  assert.deepEqual(captured(() => settlement.dispose()), { threw: false }, 'repeated finalization must not rethrow the same late cleanup');
}

{
  const fake = createFakeEnvironment();
  let value = 0;
  const settlement = installCausalFrameSettlement(fake.environment, () => value);
  settlement.runRoot(() => { value = 1; });
  settlement.accept();
  fake.environment.requestAnimationFrame(() => { value = 2; });
  fake.drain();
  complete(settlement);
  assert.deepEqual(settlement.trace(), [1, 1, 2], 'synchronous post-acceptance RAF must remain in the trace');
  settlement.dispose();
}

{
  const fake = createFakeEnvironment();
  let callbackRuns = 0;
  let successorRafs = 0;
  const settlement = installCausalFrameSettlement(fake.environment, () => callbackRuns + successorRafs);
  settlement.runRoot(() => {});
  settlement.accept();
  fake.environment.queueMicrotask(() => {
    callbackRuns += 1;
    fake.environment.requestAnimationFrame(() => { successorRafs += 1; });
  });
  const traceBeforeDispose = settlement.trace();
  settlement.dispose();
  fake.drain();
  assert.equal(callbackRuns, 0, 'disposed queued causal microtask must not execute its callback');
  assert.equal(successorRafs, 0, 'disposed queued causal microtask must not schedule successor RAF');
  assert.deepEqual(settlement.trace(), traceBeforeDispose, 'dispose must freeze the acceptance trace');
  assert.deepEqual(
    settlement.diagnostics(),
    { phase: 'disposed', rootReturned: true, acceptances: 1, pendingMicrotasks: 0, pendingFrames: 0, failure: null }
  );
  settlement.dispose();
}

{
  const fake = createFakeEnvironment();
  let value = 0;
  const settlement = installCausalFrameSettlement(fake.environment, () => value);
  settlement.runRoot(() => {});
  settlement.accept();
  fake.environment.queueMicrotask(() => {
    value = 1;
    fake.environment.requestAnimationFrame(() => { value = 2; });
  });
  fake.drain();
  complete(settlement);
  assert.deepEqual(settlement.trace(), [0, 0, 1, 2], 'post-acceptance microtask continuation must retain its RAF successor');
  settlement.dispose();
}

{
  const fake = createFakeEnvironment();
  const settlement = installCausalFrameSettlement(fake.environment, () => 0);
  settlement.runRoot(() => {});
  settlement.accept();
  assert.throws(() => settlement.accept(), /published more than once/);
  fake.drain();
  complete(settlement);
  settlement.dispose();
}

{
  const fake = createFakeEnvironment();
  let value = 7;
  const settlement = installCausalFrameSettlement(fake.environment, () => value);
  settlement.runRoot(() => {});
  settlement.accept();
  const replaced = fake.environment.requestAnimationFrame(() => { value = -1; });
  fake.environment.requestAnimationFrame(() => { value = 8; });
  fake.environment.cancelAnimationFrame(replaced);
  fake.drain();
  complete(settlement);
  assert.deepEqual(settlement.trace(), [7, 7, 7, 8], 'cancelled work must not transfer to a replacement callback');
  settlement.dispose();
}

{
  const fake = createFakeEnvironment();
  let value = 9;
  const unrelatedNativeHandle = fake.environment.requestAnimationFrame(() => {});
  const settlement = installCausalFrameSettlement(fake.environment, () => value);
  let self: number;
  settlement.runRoot(() => {});
  settlement.accept();
  self = fake.environment.requestAnimationFrame(() => fake.environment.cancelAnimationFrame(self));
  fake.drain();
  complete(settlement);
  assert.equal(fake.nativeCancels(), 0, 'self-cancel must not route opaque handle to colliding native handle');
  fake.environment.cancelAnimationFrame(unrelatedNativeHandle);
  assert.equal(fake.nativeCancels(), 1, 'native cancellation must remain identity-isolated');
  settlement.dispose();
}

{
  const fake = createFakeEnvironment();
  let value = 120;
  const settlement = installCausalFrameSettlement(fake.environment, () => value);
  settlement.runRoot(() => {});
  settlement.accept();
  fake.environment.requestAnimationFrame(() => {
    value = 116;
    fake.environment.requestAnimationFrame(() => { value = 120; });
  });
  assert.throws(
    () => assert.equal(settlement.diagnostics().phase, 'complete', 'legacy first-acceptance stop must not complete with queued RAF'),
    /legacy first-acceptance/
  );
  fake.drain();
  complete(settlement);
  assert.throws(() => stable(settlement.trace()), /late causal rollback/);
  settlement.dispose();
}

{
  const fake = createFakeEnvironment();
  let value = 0;
  const settlement = installCausalFrameSettlement(fake.environment, () => value);
  settlement.runRoot(() => {});
  settlement.accept();
  const schedule = (frame: number) => fake.environment.requestAnimationFrame(() => {
    value = frame;
    if (frame < 10) schedule(frame + 1);
  });
  schedule(1);
  fake.drain();
  complete(settlement);
  assert.equal(settlement.trace().at(-1), 10, 'more-than-eight causal RAFs must drain fully');
  assert.equal(settlement.trace().length, 12);
  settlement.dispose();
}

{
  const fake = createFakeEnvironment();
  let invoked = false;
  const settlement = installCausalFrameSettlement(fake.environment, () => invoked);
  assert.throws(() => settlement.runRoot(() => {
    fake.environment.requestAnimationFrame(() => { invoked = true; });
    throw new Error('root failure');
  }), /root failure/);
  assert.equal(settlement.diagnostics().phase, 'awaitingAcceptance', 'root exceptions must leave explicit pre-acceptance state');
  settlement.dispose();
  fake.drain();
  assert.equal(invoked, false, 'dispose before acceptance must cancel queued causal work');
}

{
  const fake = createFakeEnvironment({ throwOnCancel: true });
  const settlement = installCausalFrameSettlement(fake.environment, () => 0);
  settlement.runRoot(() => { fake.environment.requestAnimationFrame(() => {}); });
  assert.throws(() => settlement.dispose(), /native cancel 1 failed/);
  assert.equal(settlement.diagnostics().phase, 'disposed', 'cleanup error must still restore an explicit disposed state');
}

console.log('causal frame settlement matrix checks passed');
