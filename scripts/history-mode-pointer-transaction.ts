export type HistoryModePointerStage =
  | 'acquired'
  | 'downDelivered'
  | 'sameIdentityValidated'
  | 'upDelivered'
  | 'labelSettled'
  | 'cleanupComplete';

export type HistoryModePointerState = {
  readonly stages: readonly HistoryModePointerStage[];
  readonly mouseDown: boolean;
  readonly cleanupAttempts: Readonly<Record<'mouseRelease' | 'animationCancel' | 'handleDispose', number>>;
};

export type HistoryModePointerOperations<Target, Point> = {
  acquire(): Promise<Target>;
  validate(target: Target, phase: 'pointerdown' | 'pointerup'): Promise<Point>;
  prepareDown?(point: Point): Promise<void>;
  deliverDown(point: Point): Promise<void>;
  afterDown?(target: Target): Promise<void>;
  prepareUp?(point: Point): Promise<void>;
  deliverUp(point: Point): Promise<void>;
  settleLabel(): Promise<void>;
  releaseMouse(): Promise<void>;
  cancelAnimation(target: Target): Promise<void>;
  disposeHandle(target: Target): Promise<void>;
};

export type HistoryModePointerCleanupOperation = 'mouseRelease' | 'animationCancel' | 'handleDispose';

export class HistoryModePointerCleanupError extends Error {
  readonly operation: HistoryModePointerCleanupOperation;

  constructor(operation: HistoryModePointerCleanupOperation, cause: unknown) {
    super(`History mode pointer cleanup failed during ${operation}`, { cause });
    this.name = 'HistoryModePointerCleanupError';
    this.operation = operation;
  }
}

export class HistoryModePointerTransactionError extends AggregateError {
  readonly hasPrimary: boolean;
  readonly primary: unknown;
  readonly cleanupErrors: readonly HistoryModePointerCleanupError[];
  readonly state: HistoryModePointerState;

  constructor(
    hasPrimary: boolean,
    primary: unknown,
    cleanupErrors: readonly HistoryModePointerCleanupError[],
    state: HistoryModePointerState
  ) {
    super(
      hasPrimary ? [primary, ...cleanupErrors] : cleanupErrors,
      hasPrimary
        ? `History mode pointer transaction failed: ${String(primary)}`
        : 'History mode pointer cleanup failed',
      { cause: hasPrimary ? primary : cleanupErrors[0] }
    );
    this.name = 'HistoryModePointerTransactionError';
    this.hasPrimary = hasPrimary;
    this.primary = primary;
    this.cleanupErrors = cleanupErrors;
    this.state = state;
  }
}

export async function runHistoryModePointerTransaction<Target, Point>(
  operations: HistoryModePointerOperations<Target, Point>
): Promise<HistoryModePointerState> {
  const stages: HistoryModePointerStage[] = [];
  const cleanupAttempts = { mouseRelease: 0, animationCancel: 0, handleDispose: 0 };
  let target!: Target;
  let acquired = false;
  let mouseDown = false;
  let upAttempted = false;
  let hasPrimary = false;
  let primary: unknown;
  const cleanupErrors: HistoryModePointerCleanupError[] = [];
  const attemptCleanup = async (
    operation: HistoryModePointerCleanupOperation,
    run: () => Promise<void>
  ) => {
    cleanupAttempts[operation] += 1;
    try {
      await run();
    } catch (error) {
      cleanupErrors.push(new HistoryModePointerCleanupError(operation, error));
    }
  };
  try {
    target = await operations.acquire();
    acquired = true;
    stages.push('acquired');
    let downPoint = await operations.validate(target, 'pointerdown');
    await operations.prepareDown?.(downPoint);
    downPoint = await operations.validate(target, 'pointerdown');
    mouseDown = true;
    await operations.deliverDown(downPoint);
    stages.push('downDelivered');
    await operations.afterDown?.(target);
    let upPoint = await operations.validate(target, 'pointerup');
    await operations.prepareUp?.(upPoint);
    upPoint = await operations.validate(target, 'pointerup');
    stages.push('sameIdentityValidated');
    upAttempted = true;
    try {
      await operations.deliverUp(upPoint);
    } finally {
      mouseDown = false;
    }
    stages.push('upDelivered');
    await operations.settleLabel();
    stages.push('labelSettled');
  } catch (error) {
    hasPrimary = true;
    primary = error;
  } finally {
    if (mouseDown && !upAttempted) {
      try {
        await attemptCleanup('mouseRelease', operations.releaseMouse);
      } finally {
        mouseDown = false;
      }
    }
    if (acquired) {
      await attemptCleanup('animationCancel', () => operations.cancelAnimation(target));
      await attemptCleanup('handleDispose', () => operations.disposeHandle(target));
    }
    stages.push('cleanupComplete');
  }
  const state = { stages, mouseDown, cleanupAttempts };
  if (hasPrimary || cleanupErrors.length > 0) {
    throw new HistoryModePointerTransactionError(hasPrimary, primary, cleanupErrors, state);
  }
  return state;
}
