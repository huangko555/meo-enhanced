export type HistoryRenderedBlockKind = 'mermaid' | 'math';
export type HistoryRenderedBlockTargetMode = 'preview' | 'split' | 'source';

export type HistoryRenderedBlockInteraction = {
  readonly kind: HistoryRenderedBlockKind;
  readonly lineNumber: number;
  readonly targetMode: HistoryRenderedBlockTargetMode;
};

export type HistoryRenderedBlockInteractionResult = {
  readonly status: 'completed' | 'noop' | 'unsupported';
  readonly releasedSafely: boolean;
};

export type HistoryRenderedBlockObserver = {
  cleanup(): Promise<void>;
};

/**
 * Adapter mechanics for one rendered-block mode intent. The Module owns the
 * interaction order; adapters only locate semantic controls and perform I/O.
 */
export type HistoryRenderedBlockInteractionAdapter<Handle, Point = { x: number; y: number }> = {
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

  constructor(hasPrimary: boolean, primary: unknown, cleanup: readonly unknown[]) {
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
  let pointerNeedsRelease = false;
  let hasPrimary = false;
  let primary: unknown;
  const cleanup: unknown[] = [];

  const collectCleanup = async (operation: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      cleanup.push(new Error(`History rendered-block interaction cleanup failed during ${operation}`, { cause: error }));
    }
  };

  try {
    const scroll = await adapter.settleScroll(interaction);
    if (scroll === 'unsupported') return { status: 'unsupported', releasedSafely: false };
    if (await adapter.isTargetSettled(interaction)) return { status: 'noop', releasedSafely: false };
    observer = await adapter.openObserver?.(interaction);

    const supersededHandle = await adapter.acquireCurrentHandle(interaction);
    const initialPoint = await adapter.validateCurrentHandle(supersededHandle, 'pointerdown');
    await adapter.preparePointerDown(initialPoint);
    currentHandle = await adapter.acquireCurrentHandle(interaction);
    if (!Object.is(currentHandle, supersededHandle)) {
      await adapter.disposeSupersededHandle(supersededHandle);
    }

    const downPoint = await adapter.validateCurrentHandle(currentHandle, 'pointerdown');
    pointerNeedsRelease = true;
    await adapter.deliverPointerDown(downPoint);
    await adapter.afterPointerDown?.(currentHandle);

    await adapter.preparePointerUp(downPoint);
    const upPoint = await adapter.validateCurrentHandle(currentHandle, 'pointerup');
    await adapter.deliverPointerUp(upPoint);
    pointerNeedsRelease = false;
    await adapter.settleTarget(interaction);
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
    if (currentHandle !== undefined) {
      if (adapter.cancelAnimation) await collectCleanup('animationCancel', () => adapter.cancelAnimation!(currentHandle as Handle));
      await collectCleanup('handleDispose', () => adapter.disposeHandle(currentHandle as Handle));
    }
    if (observer) await collectCleanup('observerCleanup', () => observer!.cleanup());
  }

  if (hasPrimary || cleanup.length > 0) {
    throw new HistoryRenderedBlockInteractionError(hasPrimary, primary, cleanup);
  }
  return { status: 'completed', releasedSafely: false };
}
