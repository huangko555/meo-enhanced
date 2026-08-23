export type HistoryModePointerStage =
  | "acquired"
  | "downPrepared"
  | "downTargetReacquired"
  | "downDelivered"
  | "upPrepared"
  | "sameIdentityValidated"
  | "upDelivered"
  | "labelSettled"
  | "safeReleaseTargeted"
  | "cancelReleased"
  | "cleanupComplete";

export type HistoryModePointerPhysicalState =
  | "notPressed"
  | "pressed"
  | "released"
  | "unknown";

export type HistoryModePointerCleanupOperation =
  | "safeReleaseMove"
  | "cancelRelease"
  | "safeTargetDispose"
  | "animationCancel"
  | "handleDispose";

export interface HistoryModePointerState {
  stages: HistoryModePointerStage[];
  physicalPointer: HistoryModePointerPhysicalState;
  cleanupAttempts: Record<HistoryModePointerCleanupOperation, number>;
}

export interface HistoryModePointerOperations<Target, Point, SafeTarget> {
  acquire(): Promise<Target>;
  validateSameIdentity(
    target: Target,
    phase: "pointerdown" | "pointerup",
  ): Promise<Point>;
  prepareDown(point: Point): Promise<void>;
  disposeSupersededHandle(target: Target): Promise<void>;
  deliverDown(point: Point): Promise<void>;
  afterDown?(target: Target): Promise<void>;
  prepareUp(point: Point): Promise<void>;
  deliverUp(point: Point): Promise<void>;
  settleLabel(): Promise<void>;
  moveToSafeReleaseTarget(): Promise<SafeTarget>;
  cancelRelease(target: SafeTarget): Promise<void>;
  disposeSafeReleaseTarget(): Promise<void>;
  cancelAnimation(target: Target): Promise<void>;
  disposeHandle(target: Target): Promise<void>;
}

const cleanupOrder: HistoryModePointerCleanupOperation[] = [
  "safeReleaseMove",
  "cancelRelease",
  "safeTargetDispose",
  "animationCancel",
  "handleDispose",
];

export class HistoryModePointerCleanupError extends Error {
  readonly operation: HistoryModePointerCleanupOperation;

  constructor(operation: HistoryModePointerCleanupOperation, cause: unknown) {
    super(`History mode pointer cleanup failed during ${operation}`, { cause });
    this.name = "HistoryModePointerCleanupError";
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
    state: HistoryModePointerState,
  ) {
    super(
      hasPrimary ? [primary, ...cleanupErrors] : cleanupErrors,
      hasPrimary
        ? `History mode pointer transaction failed: ${String(primary)}`
        : "History mode pointer cleanup failed",
      { cause: hasPrimary ? primary : cleanupErrors[0] },
    );
    this.name = "HistoryModePointerTransactionError";
    this.hasPrimary = hasPrimary;
    this.primary = primary;
    this.cleanupErrors = cleanupErrors;
    this.state = state;
  }
}

export async function runHistoryModePointerTransaction<Target, Point, SafeTarget>(
  operations: HistoryModePointerOperations<Target, Point, SafeTarget>,
): Promise<HistoryModePointerState> {
  const state: HistoryModePointerState = {
    stages: [],
    physicalPointer: "notPressed",
    cleanupAttempts: {
      safeReleaseMove: 0,
      cancelRelease: 0,
      safeTargetDispose: 0,
      animationCancel: 0,
      handleDispose: 0,
    },
  };
  let target: Target | undefined;
  let acquired = false;
  let primaryError: unknown;
  let hasPrimaryError = false;
  const cleanupErrors: HistoryModePointerCleanupError[] = [];

  try {
    target = await operations.acquire();
    acquired = true;
    state.stages.push("acquired");

    let point = await operations.validateSameIdentity(target, "pointerdown");
    await operations.prepareDown(point);
    state.stages.push("downPrepared");
    const previousTarget = target;
    target = await operations.acquire();
    await operations.disposeSupersededHandle(previousTarget);
    state.stages.push("downTargetReacquired");
    point = await operations.validateSameIdentity(target, "pointerdown");
    try {
      await operations.deliverDown(point);
    } catch (error) {
      state.physicalPointer = "unknown";
      throw error;
    }
    state.physicalPointer = "pressed";
    state.stages.push("downDelivered");

    await operations.afterDown?.(target);
    point = await operations.validateSameIdentity(target, "pointerup");
    await operations.prepareUp(point);
    state.stages.push("upPrepared");
    point = await operations.validateSameIdentity(target, "pointerup");
    state.stages.push("sameIdentityValidated");
    try {
      await operations.deliverUp(point);
    } catch (error) {
      state.physicalPointer = "unknown";
      throw error;
    }
    state.physicalPointer = "released";
    state.stages.push("upDelivered");

    await operations.settleLabel();
    state.stages.push("labelSettled");
  } catch (error) {
    hasPrimaryError = true;
    primaryError = error;
  } finally {
    const needsCancellation =
      state.physicalPointer === "pressed" || state.physicalPointer === "unknown";
    if (needsCancellation) {
      let safeTarget!: SafeTarget;
      let safeTargeted = false;
      state.cleanupAttempts.safeReleaseMove += 1;
      try {
        safeTarget = await operations.moveToSafeReleaseTarget();
        safeTargeted = true;
        state.stages.push("safeReleaseTargeted");
      } catch (error) {
        cleanupErrors.push(new HistoryModePointerCleanupError("safeReleaseMove", error));
      }

      if (safeTargeted) {
        state.cleanupAttempts.cancelRelease += 1;
        try {
          await operations.cancelRelease(safeTarget);
          state.physicalPointer = "released";
          state.stages.push("cancelReleased");
        } catch (error) {
          state.physicalPointer = "unknown";
          cleanupErrors.push(new HistoryModePointerCleanupError("cancelRelease", error));
        }
      }

      state.cleanupAttempts.safeTargetDispose += 1;
      try {
        await operations.disposeSafeReleaseTarget();
      } catch (error) {
        cleanupErrors.push(new HistoryModePointerCleanupError("safeTargetDispose", error));
      }
    }

    if (acquired) {
      state.cleanupAttempts.animationCancel += 1;
      try {
        await operations.cancelAnimation(target as Target);
      } catch (error) {
        cleanupErrors.push(new HistoryModePointerCleanupError("animationCancel", error));
      }

      state.cleanupAttempts.handleDispose += 1;
      try {
        await operations.disposeHandle(target as Target);
      } catch (error) {
        cleanupErrors.push(new HistoryModePointerCleanupError("handleDispose", error));
      }
    }
    state.stages.push("cleanupComplete");
  }

  if (hasPrimaryError || cleanupErrors.length > 0) {
    throw new HistoryModePointerTransactionError(
      hasPrimaryError,
      primaryError,
      cleanupErrors,
      state,
    );
  }

  for (const operation of cleanupOrder) {
    if (state.cleanupAttempts[operation] > 1) {
      throw new Error(`History mode pointer ${operation} cleanup ran more than once`);
    }
  }
  return state;
}
