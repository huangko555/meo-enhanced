import {
  HistoryModePointerTransactionError,
  runHistoryModePointerTransaction,
  type HistoryModePointerCleanupOperation,
  type HistoryModePointerOperations,
  type HistoryModePointerPhysicalState,
  type HistoryModePointerStage,
} from "./history-mode-pointer-transaction";

type PrimaryFailure =
  | "acquire"
  | "prepareDown"
  | "down"
  | "identity"
  | "disposeSuperseded"
  | "prepareUp"
  | "up"
  | "label";
type FailurePoint = PrimaryFailure | HistoryModePointerCleanupOperation;
type Target = { readonly id: number; connected: boolean; position: number };
type SafeTarget = { readonly category: "safe" };

type Scenario = {
  readonly name: string;
  readonly primary?: PrimaryFailure;
  readonly cleanupFailures?: readonly HistoryModePointerCleanupOperation[];
  readonly moveSameNode?: boolean;
  readonly replaceBeforeDown?: boolean;
  readonly replaceAfterReacquire?: boolean;
  readonly failReacquire?: boolean;
  readonly replaceAfterDown?: boolean;
  readonly expectedPrimary?: PrimaryFailure;
  readonly expectedCleanupErrors?: readonly HistoryModePointerCleanupOperation[];
  readonly expectedStages: readonly HistoryModePointerStage[];
  readonly expectedPhysical: HistoryModePointerPhysicalState;
  readonly expectedCleanupAttempts: readonly [number, number, number, number, number];
  readonly expectedNormalUp: number;
  readonly expectedCancel: number;
  readonly expectedLabelCalls: number;
  readonly expectedUpPoint?: number;
  readonly expectedAcquireCalls?: number;
  readonly expectedSupersededDisposals?: number;
};

const normalStages = [
  "acquired",
  "downPrepared",
  "downTargetReacquired",
  "downDelivered",
  "upPrepared",
  "sameIdentityValidated",
  "upDelivered",
  "labelSettled",
] as const;
const cancelled = ["safeReleaseTargeted", "cancelReleased", "cleanupComplete"] as const;
const noCancel = [0, 0, 0, 1, 1] as const;
const withCancel = [1, 1, 1, 1, 1] as const;

const scenarios: readonly Scenario[] = [
  {
    name: "success",
    expectedStages: [...normalStages, "cleanupComplete"],
    expectedPhysical: "released",
    expectedCleanupAttempts: noCancel,
    expectedNormalUp: 1,
    expectedCancel: 0,
    expectedLabelCalls: 1,
    expectedUpPoint: 0,
    expectedAcquireCalls: 2,
    expectedSupersededDisposals: 1,
  },
  {
    name: "reacquire-failure-cleans-original-target",
    failReacquire: true,
    expectedPrimary: "acquire",
    expectedStages: ["acquired", "downPrepared", "cleanupComplete"],
    expectedPhysical: "notPressed",
    expectedCleanupAttempts: noCancel,
    expectedNormalUp: 0,
    expectedCancel: 0,
    expectedLabelCalls: 0,
    expectedAcquireCalls: 2,
    expectedSupersededDisposals: 0,
  },
  {
    name: "superseded-handle-disposal-failure-cleans-current-target",
    replaceBeforeDown: true,
    primary: "disposeSuperseded",
    expectedPrimary: "disposeSuperseded",
    expectedStages: ["acquired", "downPrepared", "cleanupComplete"],
    expectedPhysical: "notPressed",
    expectedCleanupAttempts: noCancel,
    expectedNormalUp: 0,
    expectedCancel: 0,
    expectedLabelCalls: 0,
    expectedAcquireCalls: 2,
    expectedSupersededDisposals: 1,
  },
  {
    name: "pre-down-replacement-reacquires-current-target",
    replaceBeforeDown: true,
    expectedStages: [...normalStages, "cleanupComplete"],
    expectedPhysical: "released",
    expectedCleanupAttempts: noCancel,
    expectedNormalUp: 1,
    expectedCancel: 0,
    expectedLabelCalls: 1,
    expectedUpPoint: 2,
    expectedAcquireCalls: 2,
    expectedSupersededDisposals: 1,
  },
  {
    name: "continuous-pre-down-replacement-fails-without-retry",
    replaceBeforeDown: true,
    replaceAfterReacquire: true,
    expectedPrimary: "identity",
    expectedStages: ["acquired", "downPrepared", "downTargetReacquired", "cleanupComplete"],
    expectedPhysical: "notPressed",
    expectedCleanupAttempts: noCancel,
    expectedNormalUp: 0,
    expectedCancel: 0,
    expectedLabelCalls: 0,
    expectedAcquireCalls: 2,
    expectedSupersededDisposals: 1,
  },
  {
    name: "acquire-primary",
    primary: "acquire",
    expectedPrimary: "acquire",
    expectedStages: ["cleanupComplete"],
    expectedPhysical: "notPressed",
    expectedCleanupAttempts: [0, 0, 0, 0, 0],
    expectedNormalUp: 0,
    expectedCancel: 0,
    expectedLabelCalls: 0,
  },
  {
    name: "prepare-down-primary",
    primary: "prepareDown",
    expectedPrimary: "prepareDown",
    expectedStages: ["acquired", "cleanupComplete"],
    expectedPhysical: "notPressed",
    expectedCleanupAttempts: noCancel,
    expectedNormalUp: 0,
    expectedCancel: 0,
    expectedLabelCalls: 0,
    expectedAcquireCalls: 1,
    expectedSupersededDisposals: 0,
  },
  {
    name: "deliver-down-unknown-cancelled",
    primary: "down",
    expectedPrimary: "down",
    expectedStages: ["acquired", "downPrepared", "downTargetReacquired", ...cancelled],
    expectedPhysical: "released",
    expectedCleanupAttempts: withCancel,
    expectedNormalUp: 0,
    expectedCancel: 1,
    expectedLabelCalls: 0,
  },
  {
    name: "prepare-up-pressed-cancelled",
    primary: "prepareUp",
    expectedPrimary: "prepareUp",
    expectedStages: ["acquired", "downPrepared", "downTargetReacquired", "downDelivered", ...cancelled],
    expectedPhysical: "released",
    expectedCleanupAttempts: withCancel,
    expectedNormalUp: 0,
    expectedCancel: 1,
    expectedLabelCalls: 0,
  },
  {
    name: "replacement-safe-cancel",
    replaceAfterDown: true,
    expectedPrimary: "identity",
    expectedStages: ["acquired", "downPrepared", "downTargetReacquired", "downDelivered", ...cancelled],
    expectedPhysical: "released",
    expectedCleanupAttempts: withCancel,
    expectedNormalUp: 0,
    expectedCancel: 1,
    expectedLabelCalls: 0,
  },
  {
    name: "deliver-up-unknown-safe-cancel",
    primary: "up",
    expectedPrimary: "up",
    expectedStages: [
      "acquired",
      "downPrepared",
      "downTargetReacquired",
      "downDelivered",
      "upPrepared",
      "sameIdentityValidated",
      ...cancelled,
    ],
    expectedPhysical: "released",
    expectedCleanupAttempts: withCancel,
    expectedNormalUp: 1,
    expectedCancel: 1,
    expectedLabelCalls: 0,
  },
  {
    name: "label-primary-after-release",
    primary: "label",
    expectedPrimary: "label",
    expectedStages: [...normalStages.slice(0, -1), "cleanupComplete"],
    expectedPhysical: "released",
    expectedCleanupAttempts: noCancel,
    expectedNormalUp: 1,
    expectedCancel: 0,
    expectedLabelCalls: 1,
  },
  {
    name: "safe-move-failure-preserves-pressed",
    replaceAfterDown: true,
    cleanupFailures: ["safeReleaseMove"],
    expectedPrimary: "identity",
    expectedCleanupErrors: ["safeReleaseMove"],
    expectedStages: ["acquired", "downPrepared", "downTargetReacquired", "downDelivered", "cleanupComplete"],
    expectedPhysical: "pressed",
    expectedCleanupAttempts: [1, 0, 1, 1, 1],
    expectedNormalUp: 0,
    expectedCancel: 0,
    expectedLabelCalls: 0,
  },
  {
    name: "cancel-failure-preserves-unknown",
    primary: "up",
    cleanupFailures: ["cancelRelease"],
    expectedPrimary: "up",
    expectedCleanupErrors: ["cancelRelease"],
    expectedStages: [
      "acquired",
      "downPrepared",
      "downTargetReacquired",
      "downDelivered",
      "upPrepared",
      "sameIdentityValidated",
      "safeReleaseTargeted",
      "cleanupComplete",
    ],
    expectedPhysical: "unknown",
    expectedCleanupAttempts: withCancel,
    expectedNormalUp: 1,
    expectedCancel: 1,
    expectedLabelCalls: 0,
  },
  {
    name: "ordered-primary-and-multiple-cleanup",
    primary: "up",
    cleanupFailures: ["cancelRelease", "safeTargetDispose", "animationCancel", "handleDispose"],
    expectedPrimary: "up",
    expectedCleanupErrors: ["cancelRelease", "safeTargetDispose", "animationCancel", "handleDispose"],
    expectedStages: [
      "acquired",
      "downPrepared",
      "downTargetReacquired",
      "downDelivered",
      "upPrepared",
      "sameIdentityValidated",
      "safeReleaseTargeted",
      "cleanupComplete",
    ],
    expectedPhysical: "unknown",
    expectedCleanupAttempts: withCancel,
    expectedNormalUp: 1,
    expectedCancel: 1,
    expectedLabelCalls: 0,
  },
  {
    name: "ordered-cleanup-without-primary",
    cleanupFailures: ["animationCancel", "handleDispose"],
    expectedCleanupErrors: ["animationCancel", "handleDispose"],
    expectedStages: [...normalStages, "cleanupComplete"],
    expectedPhysical: "released",
    expectedCleanupAttempts: noCancel,
    expectedNormalUp: 1,
    expectedCancel: 0,
    expectedLabelCalls: 1,
  },
  {
    name: "same-node-movement-settles-label",
    moveSameNode: true,
    expectedStages: [...normalStages, "cleanupComplete"],
    expectedPhysical: "released",
    expectedCleanupAttempts: noCancel,
    expectedNormalUp: 1,
    expectedCancel: 0,
    expectedLabelCalls: 1,
    expectedUpPoint: 1,
  },
];

const failure = (point: FailurePoint) => new Error(`synthetic ${point} failure`);

async function runScenario(scenario: Scenario) {
  const calls = {
    acquire: 0,
    label: 0,
    normalUp: 0,
    cancel: 0,
    upPoint: null as number | null,
    releaseTargets: [] as Array<"normal-target" | "safe">,
    supersededDisposals: 0,
    cleanup: {
      safeReleaseMove: 0,
      cancelRelease: 0,
      safeTargetDispose: 0,
      animationCancel: 0,
      handleDispose: 0,
    },
  };
  const originalTarget: Target = { id: 1, connected: true, position: 0 };
  let currentTarget = originalTarget;
  const fail = (point: FailurePoint) => {
    if (
      scenario.primary === point ||
      scenario.cleanupFailures?.includes(point as HistoryModePointerCleanupOperation)
    ) {
      throw failure(point);
    }
  };
  const operations: HistoryModePointerOperations<Target, number, SafeTarget> = {
    async acquire() {
      fail("acquire");
      calls.acquire += 1;
      if (calls.acquire === 2 && scenario.failReacquire) throw failure("acquire");
      const acquired = currentTarget;
      if (calls.acquire === 2 && scenario.replaceAfterReacquire) {
        acquired.connected = false;
        currentTarget = { id: 3, connected: true, position: 3 };
      }
      return acquired;
    },
    async validateSameIdentity(target, phase) {
      if (phase === "pointerup") fail("identity");
      if (!target.connected || target !== currentTarget) throw failure("identity");
      return target.position;
    },
    async prepareDown() {
      fail("prepareDown");
      if (scenario.replaceBeforeDown) {
        originalTarget.connected = false;
        currentTarget = { id: 2, connected: true, position: 2 };
      }
    },
    async disposeSupersededHandle() {
      calls.supersededDisposals += 1;
      fail("disposeSuperseded");
    },
    async deliverDown() {
      fail("down");
    },
    async afterDown() {
      if (scenario.moveSameNode) originalTarget.position = 1;
      if (scenario.replaceAfterDown) {
        originalTarget.connected = false;
        currentTarget = { id: 2, connected: true, position: 0 };
      }
    },
    async prepareUp() {
      fail("prepareUp");
    },
    async deliverUp(point) {
      calls.normalUp += 1;
      calls.upPoint = point;
      calls.releaseTargets.push("normal-target");
      fail("up");
    },
    async settleLabel() {
      calls.label += 1;
      fail("label");
    },
    async moveToSafeReleaseTarget() {
      calls.cleanup.safeReleaseMove += 1;
      fail("safeReleaseMove");
      return { category: "safe" };
    },
    async cancelRelease(target) {
      calls.cleanup.cancelRelease += 1;
      calls.cancel += 1;
      calls.releaseTargets.push(target.category);
      fail("cancelRelease");
    },
    async disposeSafeReleaseTarget() {
      calls.cleanup.safeTargetDispose += 1;
      fail("safeTargetDispose");
    },
    async cancelAnimation() {
      calls.cleanup.animationCancel += 1;
      fail("animationCancel");
    },
    async disposeHandle() {
      calls.cleanup.handleDispose += 1;
      fail("handleDispose");
    },
  };

  let state: Awaited<ReturnType<typeof runHistoryModePointerTransaction<Target, number, SafeTarget>>> | null = null;
  let thrown: HistoryModePointerTransactionError | null = null;
  try {
    state = await runHistoryModePointerTransaction(operations);
  } catch (error) {
    if (!(error instanceof HistoryModePointerTransactionError)) throw error;
    thrown = error;
  }
  const observed = state ?? thrown?.state;
  const expectedFailure = Boolean(scenario.expectedPrimary || scenario.expectedCleanupErrors?.length);
  if (Boolean(thrown) !== expectedFailure) throw new Error(`${scenario.name}: unexpected failure outcome`);
  if (JSON.stringify(observed?.stages) !== JSON.stringify(scenario.expectedStages)) {
    throw new Error(`${scenario.name}: unexpected stages ${JSON.stringify(observed?.stages)}`);
  }
  if (observed?.physicalPointer !== scenario.expectedPhysical) {
    throw new Error(`${scenario.name}: unexpected physical state ${observed?.physicalPointer}`);
  }
  const attempts = observed?.cleanupAttempts;
  const actualAttempts = [
    attempts?.safeReleaseMove,
    attempts?.cancelRelease,
    attempts?.safeTargetDispose,
    attempts?.animationCancel,
    attempts?.handleDispose,
  ];
  if (JSON.stringify(actualAttempts) !== JSON.stringify(scenario.expectedCleanupAttempts)) {
    throw new Error(`${scenario.name}: unexpected cleanup attempts ${JSON.stringify(actualAttempts)}`);
  }
  if (actualAttempts.some((count) => (count ?? 0) > 1)) {
    throw new Error(`${scenario.name}: cleanup was attempted more than once`);
  }
  if (JSON.stringify(Object.values(calls.cleanup)) !== JSON.stringify(scenario.expectedCleanupAttempts)) {
    throw new Error(`${scenario.name}: cleanup registry disagreed with state`);
  }
  if (calls.normalUp !== scenario.expectedNormalUp || calls.cancel !== scenario.expectedCancel) {
    throw new Error(`${scenario.name}: unexpected normal/cancel up counts ${calls.normalUp}/${calls.cancel}`);
  }
  if (calls.releaseTargets.includes("safe") !== (scenario.expectedCancel === 1)) {
    throw new Error(`${scenario.name}: cancellation was not isolated to the safe target`);
  }
  if (calls.label !== scenario.expectedLabelCalls) {
    throw new Error(`${scenario.name}: unexpected label calls ${calls.label}`);
  }
  if (scenario.expectedUpPoint !== undefined && calls.upPoint !== scenario.expectedUpPoint) {
    throw new Error(`${scenario.name}: unexpected up point ${calls.upPoint}`);
  }
  if (scenario.expectedAcquireCalls !== undefined && calls.acquire !== scenario.expectedAcquireCalls) {
    throw new Error(`${scenario.name}: unexpected acquire count ${calls.acquire}`);
  }
  if (
    scenario.expectedSupersededDisposals !== undefined
    && calls.supersededDisposals !== scenario.expectedSupersededDisposals
  ) {
    throw new Error(`${scenario.name}: unexpected superseded disposal count ${calls.supersededDisposals}`);
  }
  if (scenario.expectedPrimary) {
    if (!String(thrown?.primary).includes(`synthetic ${scenario.expectedPrimary} failure`)) {
      throw new Error(`${scenario.name}: primary failure was not preserved`);
    }
    if (!thrown?.hasPrimary || thrown.cause !== thrown.primary || thrown.errors[0] !== thrown.primary) {
      throw new Error(`${scenario.name}: primary failure was not the ordered first cause`);
    }
  } else if (thrown?.hasPrimary) {
    throw new Error(`${scenario.name}: unexpected primary failure`);
  } else if (thrown && (thrown.cause !== thrown.cleanupErrors[0] || thrown.errors[0] !== thrown.cleanupErrors[0])) {
    throw new Error(`${scenario.name}: first cleanup failure was not the aggregate cause`);
  }
  const cleanupErrors = thrown?.cleanupErrors ?? [];
  const cleanupErrorOrder = cleanupErrors.map((error) => error.operation);
  if (JSON.stringify(cleanupErrorOrder) !== JSON.stringify(scenario.expectedCleanupErrors ?? [])) {
    throw new Error(`${scenario.name}: unexpected cleanup error order ${JSON.stringify(cleanupErrorOrder)}`);
  }
  if (!cleanupErrors.every((error, index) => (
    error.message.includes(cleanupErrorOrder[index] ?? "") &&
    String(error.cause).includes(`synthetic ${cleanupErrorOrder[index]} failure`)
  ))) {
    throw new Error(`${scenario.name}: cleanup causes were not preserved in order`);
  }
}

const failures: string[] = [];
for (const scenario of scenarios) {
  try {
    await runScenario(scenario);
  } catch (error) {
    failures.push(`${scenario.name}: ${String(error)}`);
  }
}
if (failures.length > 0) throw new Error(`History mode pointer matrix failed:\n${failures.join("\n")}`);
console.log("history mode pointer transaction matrix checks passed");
