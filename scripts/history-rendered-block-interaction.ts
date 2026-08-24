export type HistoryRenderedBlockKind = 'mermaid' | 'math';
export type HistoryRenderedBlockTargetMode = 'preview' | 'split' | 'source';

export type HistoryRenderedBlockInteraction = {
  readonly kind: HistoryRenderedBlockKind;
  readonly lineNumber: number;
  readonly targetMode: HistoryRenderedBlockTargetMode;
};

export type HistoryRenderedBlockInteractionResult = {
  readonly status: 'completed' | 'noop' | 'unsupported';
  readonly evidence: HistoryRenderedBlockObserverEvidence | null;
};

export type HistoryRenderedBlockObserverEvidence = {
  readonly events: readonly string[];
  readonly registrations: number;
  readonly cleaned: boolean;
  readonly sentinelRejected: boolean;
};

export type HistoryRenderedBlockObserver = {
  cleanup(): Promise<void>;
  snapshot(): Promise<HistoryRenderedBlockObserverEvidence>;
  verifySentinel(): Promise<boolean>;
};

/**
 * Adapter mechanics for one rendered-block mode intent. The Module owns the
 * interaction order; adapters only locate semantic controls and perform I/O.
 */
export type HistoryRenderedBlockInteractionAdapter<Handle, Point = { x: number; y: number }> = {
  /**
   * Returns whether the caller generation still owns this interaction. The
   * Module checks it after every awaited foreground stage; cleanup still runs
   * when ownership was lost so a pressed pointer cannot leak into a successor.
   */
  isCurrent(interaction: HistoryRenderedBlockInteraction): Promise<boolean>;
  settleScroll(interaction: HistoryRenderedBlockInteraction): Promise<'settled' | 'unsupported'>;
  isTargetSettled(interaction: HistoryRenderedBlockInteraction): Promise<boolean>;
  acquireCurrentHandle(interaction: HistoryRenderedBlockInteraction): Promise<Handle>;
  validateCurrentHandle(handle: Handle, phase: 'pointerdown' | 'pointerup'): Promise<Point>;
  preparePointerDown(point: Point): Promise<void>;
  deliverPointerDown(point: Point): Promise<void>;
  afterPointerDown?(handle: Handle): Promise<void>;
  preparePointerUp(point: Point): Promise<void>;
  deliverPointerUp(point: Point): Promise<void>;
  settleTarget(interaction: HistoryRenderedBlockInteraction): Promise<void>;
  disposeSupersededHandle(handle: Handle): Promise<void>;
  disposeHandle(handle: Handle): Promise<void>;
  moveToSafeReleaseTarget(): Promise<void>;
  cancelPointer(): Promise<void>;
  disposeSafeReleaseTarget(): Promise<void>;
  cancelAnimation?(handle: Handle): Promise<void>;
  openObserver?(interaction: HistoryRenderedBlockInteraction): Promise<HistoryRenderedBlockObserver>;
};

export class HistoryRenderedBlockInteractionError extends AggregateError {
  readonly hasPrimary: boolean;
  readonly primary: unknown;
  readonly evidence: HistoryRenderedBlockObserverEvidence | null;

  constructor(hasPrimary: boolean, primary: unknown, cleanup: readonly unknown[], evidence: HistoryRenderedBlockObserverEvidence | null) {
    super(
      hasPrimary ? [primary, ...cleanup] : cleanup,
      hasPrimary
        ? `History rendered-block interaction failed: ${String(primary)}`
        : 'History rendered-block interaction cleanup failed',
      { cause: hasPrimary ? primary : cleanup[0] }
    );
    this.name = 'HistoryRenderedBlockInteractionError';
    this.hasPrimary = hasPrimary;
    this.primary = primary;
    this.evidence = evidence;
  }
}

/**
 * Executes one exact rendered-block mode transition. It performs no retry:
 * a single pre-down reacquire is the bounded replacement boundary, and an
 * invalid handle before down/up becomes the primary failure.
 */
export async function runHistoryRenderedBlockInteraction<Handle, Point>(
  interaction: HistoryRenderedBlockInteraction,
  adapter: HistoryRenderedBlockInteractionAdapter<Handle, Point>
): Promise<HistoryRenderedBlockInteractionResult> {
  let observer: HistoryRenderedBlockObserver | undefined;
  let currentHandle: Handle | undefined;
  const acquiredHandles = new Map<Handle, 'owned'>();
  const disposedHandles = new Set<Handle>();
  let pointerNeedsRelease = false;
  let hasPrimary = false;
  let primary: unknown;
  const cleanup: unknown[] = [];
  let evidence: HistoryRenderedBlockObserverEvidence | null = null;

  const assertCurrent = async (stage: string) => {
    if (!await adapter.isCurrent(interaction)) {
      throw new Error(`History rendered-block interaction was disposed before ${stage}`);
    }
  };

  const collectCleanup = async (operation: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      cleanup.push(new Error(`History rendered-block interaction cleanup failed during ${operation}`, { cause: error }));
    }
  };
  const disposeOnce = async (handle: Handle, operation: 'supersededHandleDispose' | 'handleDispose') => {
    if (disposedHandles.has(handle)) return;
    disposedHandles.add(handle);
    acquiredHandles.delete(handle);
    await collectCleanup(operation, () => (
      operation === 'supersededHandleDispose'
        ? adapter.disposeSupersededHandle(handle)
        : adapter.disposeHandle(handle)
    ));
  };

  try {
    await assertCurrent('scroll settlement');
    const scroll = await adapter.settleScroll(interaction);
    await assertCurrent('scroll settlement');
    if (scroll === 'unsupported') return { status: 'unsupported', evidence: null };
    if (await adapter.isTargetSettled(interaction)) return { status: 'noop', evidence: null };
    await assertCurrent('target inspection');
    observer = await adapter.openObserver?.(interaction);
    await assertCurrent('observer opening');

    const supersededHandle = await adapter.acquireCurrentHandle(interaction);
    acquiredHandles.set(supersededHandle, 'owned');
    const initialPoint = await adapter.validateCurrentHandle(supersededHandle, 'pointerdown');
    await adapter.preparePointerDown(initialPoint);
    await assertCurrent('pointerdown preparation');
    currentHandle = await adapter.acquireCurrentHandle(interaction);
    acquiredHandles.set(currentHandle, 'owned');
    if (!Object.is(currentHandle, supersededHandle)) {
      await disposeOnce(supersededHandle, 'supersededHandleDispose');
    }

    const downPoint = await adapter.validateCurrentHandle(currentHandle, 'pointerdown');
    await assertCurrent('pointerdown validation');
    pointerNeedsRelease = true;
    await adapter.deliverPointerDown(downPoint);
    await assertCurrent('pointerdown delivery');
    await adapter.afterPointerDown?.(currentHandle);
    await assertCurrent('post-pointerdown transition');

    await adapter.preparePointerUp(downPoint);
    await assertCurrent('pointerup preparation');
    const upPoint = await adapter.validateCurrentHandle(currentHandle, 'pointerup');
    await assertCurrent('pointerup validation');
    await adapter.deliverPointerUp(upPoint);
    pointerNeedsRelease = false;
    await assertCurrent('pointerup delivery');
    await adapter.settleTarget(interaction);
    await assertCurrent('target settlement');
  } catch (error) {
    hasPrimary = true;
    primary = error;
  } finally {
    if (pointerNeedsRelease) {
      let safeTargeted = false;
      await collectCleanup('safeReleaseMove', async () => {
        await adapter.moveToSafeReleaseTarget();
        safeTargeted = true;
      });
      if (safeTargeted) await collectCleanup('cancelRelease', async () => {
        await adapter.cancelPointer();
        pointerNeedsRelease = false;
      });
      await collectCleanup('safeTargetDispose', () => adapter.disposeSafeReleaseTarget());
    }
    for (const handle of [...acquiredHandles.keys()]) {
      if (adapter.cancelAnimation) await collectCleanup('animationCancel', () => adapter.cancelAnimation!(handle));
      await disposeOnce(handle, 'handleDispose');
    }
    if (observer) {
      await collectCleanup('observerCleanup', () => observer!.cleanup());
      await collectCleanup('observerSentinel', async () => {
        if (!await observer!.verifySentinel()) throw new Error('History rendered-block observer accepted a late event');
      });
      try {
        evidence = await observer.snapshot();
        if (evidence.registrations !== 0 || !evidence.cleaned || !evidence.sentinelRejected) {
          cleanup.push(new Error('History rendered-block observer evidence did not close its registry'));
        }
      } catch (error) {
        cleanup.push(new Error('History rendered-block interaction cleanup failed during observerEvidence', { cause: error }));
      }
    }
  }

  if (hasPrimary || cleanup.length > 0) {
    throw new HistoryRenderedBlockInteractionError(hasPrimary, primary, cleanup, evidence);
  }
  return { status: 'completed', evidence };
}
