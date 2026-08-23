import {
  HistoryModePointerTransactionError,
  runHistoryModePointerTransaction,
  type HistoryModePointerCleanupOperation,
  type HistoryModePointerOperations,
  type HistoryModePointerStage
} from './history-mode-pointer-transaction';

type PrimaryFailure = 'acquire' | 'down' | 'identity' | 'up' | 'label';
type FailurePoint = PrimaryFailure | HistoryModePointerCleanupOperation;
type Target = { readonly id: number; connected: boolean; position: number };

type Scenario = {
  readonly name: string;
  readonly primary?: PrimaryFailure;
  readonly cleanupFailures?: readonly HistoryModePointerCleanupOperation[];
  readonly moveSameNode?: boolean;
  readonly replaceAfterDown?: boolean;
  readonly expectedPrimary?: PrimaryFailure | 'replacement';
  readonly expectedCleanupErrors?: readonly HistoryModePointerCleanupOperation[];
  readonly expectedStages: readonly HistoryModePointerStage[];
  readonly expectedCleanupAttempts: readonly [number, number, number];
  readonly expectedLabelCalls: number;
  readonly expectedUpPoint?: number;
};

const acquired = ['acquired'] as const;
const downDelivered = [...acquired, 'downDelivered'] as const;
const identityValidated = [...downDelivered, 'sameIdentityValidated'] as const;
const upDelivered = [...identityValidated, 'upDelivered'] as const;
const labelSettled = [...upDelivered, 'labelSettled'] as const;
const complete = [...labelSettled, 'cleanupComplete'] as const;

const scenarios: readonly Scenario[] = [
  {
    name: 'success', expectedStages: complete, expectedCleanupAttempts: [0, 1, 1],
    expectedLabelCalls: 1, expectedUpPoint: 0
  },
  {
    name: 'acquire-primary', primary: 'acquire', expectedPrimary: 'acquire',
    expectedStages: ['cleanupComplete'], expectedCleanupAttempts: [0, 0, 0], expectedLabelCalls: 0
  },
  {
    name: 'down-primary', primary: 'down', expectedPrimary: 'down',
    expectedStages: [...acquired, 'cleanupComplete'], expectedCleanupAttempts: [1, 1, 1], expectedLabelCalls: 0
  },
  {
    name: 'identity-primary', primary: 'identity', expectedPrimary: 'identity',
    expectedStages: [...downDelivered, 'cleanupComplete'], expectedCleanupAttempts: [1, 1, 1], expectedLabelCalls: 0
  },
  {
    name: 'up-primary', primary: 'up', expectedPrimary: 'up',
    expectedStages: [...identityValidated, 'cleanupComplete'], expectedCleanupAttempts: [0, 1, 1], expectedLabelCalls: 0
  },
  {
    name: 'label-primary', primary: 'label', expectedPrimary: 'label',
    expectedStages: [...upDelivered, 'cleanupComplete'], expectedCleanupAttempts: [0, 1, 1], expectedLabelCalls: 1
  },
  {
    name: 'mouse-release-cleanup', primary: 'identity', expectedPrimary: 'identity',
    cleanupFailures: ['mouseRelease'], expectedCleanupErrors: ['mouseRelease'],
    expectedStages: [...downDelivered, 'cleanupComplete'], expectedCleanupAttempts: [1, 1, 1], expectedLabelCalls: 0
  },
  {
    name: 'animation-cleanup', cleanupFailures: ['animationCancel'], expectedCleanupErrors: ['animationCancel'],
    expectedStages: complete, expectedCleanupAttempts: [0, 1, 1], expectedLabelCalls: 1, expectedUpPoint: 0
  },
  {
    name: 'handle-cleanup', cleanupFailures: ['handleDispose'], expectedCleanupErrors: ['handleDispose'],
    expectedStages: complete, expectedCleanupAttempts: [0, 1, 1], expectedLabelCalls: 1, expectedUpPoint: 0
  },
  {
    name: 'primary-survives-all-cleanup-failures', primary: 'identity', expectedPrimary: 'identity',
    cleanupFailures: ['mouseRelease', 'animationCancel', 'handleDispose'],
    expectedCleanupErrors: ['mouseRelease', 'animationCancel', 'handleDispose'],
    expectedStages: [...downDelivered, 'cleanupComplete'], expectedCleanupAttempts: [1, 1, 1], expectedLabelCalls: 0
  },
  {
    name: 'multiple-cleanup-without-primary', cleanupFailures: ['animationCancel', 'handleDispose'],
    expectedCleanupErrors: ['animationCancel', 'handleDispose'], expectedStages: complete,
    expectedCleanupAttempts: [0, 1, 1], expectedLabelCalls: 1, expectedUpPoint: 0
  },
  {
    name: 'replacement-before-up', replaceAfterDown: true, expectedPrimary: 'replacement',
    expectedStages: [...downDelivered, 'cleanupComplete'], expectedCleanupAttempts: [1, 1, 1], expectedLabelCalls: 0
  },
  {
    name: 'same-node-movement-settles-label', moveSameNode: true,
    expectedStages: complete, expectedCleanupAttempts: [0, 1, 1], expectedLabelCalls: 1, expectedUpPoint: 1
  }
];

const failure = (point: FailurePoint) => new Error(`synthetic ${point} failure`);

async function runScenario(scenario: Scenario) {
  const calls = {
    label: 0,
    upPoint: null as number | null,
    mouseRelease: 0,
    animationCancel: 0,
    handleDispose: 0
  };
  const originalTarget: Target = { id: 1, connected: true, position: 0 };
  let currentTarget = originalTarget;
  const fail = (point: FailurePoint) => {
    if (scenario.primary === point || scenario.cleanupFailures?.includes(point as HistoryModePointerCleanupOperation)) {
      throw failure(point);
    }
  };
  const operations: HistoryModePointerOperations<Target, number> = {
    async acquire() {
      fail('acquire');
      return originalTarget;
    },
    async validate(target, phase) {
      if (phase === 'pointerup') fail('identity');
      if (!target.connected || target !== currentTarget) throw failure('identity');
      return target.position;
    },
    async deliverDown() {
      fail('down');
    },
    async afterDown() {
      if (scenario.moveSameNode) originalTarget.position = 1;
      if (scenario.replaceAfterDown) {
        originalTarget.connected = false;
        currentTarget = { id: 2, connected: true, position: 0 };
      }
    },
    async deliverUp(point) {
      calls.upPoint = point;
      fail('up');
    },
    async settleLabel() {
      calls.label += 1;
      fail('label');
    },
    async releaseMouse() {
      calls.mouseRelease += 1;
      fail('mouseRelease');
    },
    async cancelAnimation() {
      calls.animationCancel += 1;
      fail('animationCancel');
    },
    async disposeHandle() {
      calls.handleDispose += 1;
      fail('handleDispose');
    }
  };

  let state: Awaited<ReturnType<typeof runHistoryModePointerTransaction<Target, number>>> | null = null;
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
  if (observed?.mouseDown !== false) throw new Error(`${scenario.name}: mouse state was not reset`);
  const attempts = observed?.cleanupAttempts;
  const actualAttempts = [attempts?.mouseRelease, attempts?.animationCancel, attempts?.handleDispose];
  if (JSON.stringify(actualAttempts) !== JSON.stringify(scenario.expectedCleanupAttempts)) {
    throw new Error(`${scenario.name}: unexpected cleanup attempts ${JSON.stringify(actualAttempts)}`);
  }
  if (actualAttempts.some((count) => (count ?? 0) > 1)) {
    throw new Error(`${scenario.name}: cleanup was attempted more than once`);
  }
  const actualCleanupCalls = [calls.mouseRelease, calls.animationCancel, calls.handleDispose];
  if (JSON.stringify(actualCleanupCalls) !== JSON.stringify(scenario.expectedCleanupAttempts)) {
    throw new Error(`${scenario.name}: cleanup call registry disagreed with transaction state`);
  }
  if (calls.label !== scenario.expectedLabelCalls) {
    throw new Error(`${scenario.name}: expected ${scenario.expectedLabelCalls} label calls, received ${calls.label}`);
  }
  if (scenario.expectedUpPoint !== undefined && calls.upPoint !== scenario.expectedUpPoint) {
    throw new Error(`${scenario.name}: expected up point ${scenario.expectedUpPoint}, received ${calls.upPoint}`);
  }
  if (scenario.expectedPrimary) {
    const expected = scenario.expectedPrimary === 'replacement' ? 'identity' : scenario.expectedPrimary;
    if (!String(thrown?.primary).includes(`synthetic ${expected} failure`)) {
      throw new Error(`${scenario.name}: primary failure was not preserved`);
    }
    if (!thrown?.hasPrimary || thrown.cause !== thrown.primary || thrown.errors[0] !== thrown.primary) {
      throw new Error(`${scenario.name}: primary failure was not the ordered first cause`);
    }
  } else if (thrown?.hasPrimary) {
    throw new Error(`${scenario.name}: unexpected primary failure`);
  } else if (thrown && (
    thrown.cause !== thrown.cleanupErrors[0]
    || thrown.errors[0] !== thrown.cleanupErrors[0]
  )) {
    throw new Error(`${scenario.name}: first cleanup failure was not the aggregate cause`);
  }
  const cleanupOrder = thrown?.cleanupErrors.map((error) => error.operation) ?? [];
  if (JSON.stringify(cleanupOrder) !== JSON.stringify(scenario.expectedCleanupErrors ?? [])) {
    throw new Error(`${scenario.name}: unexpected cleanup error order ${JSON.stringify(cleanupOrder)}`);
  }
  const aggregateCleanup = thrown?.errors.slice(thrown.hasPrimary ? 1 : 0) ?? [];
  if (!aggregateCleanup.every((error, index) => (
    error instanceof Error
    && error.message.includes(cleanupOrder[index] ?? '')
    && String(error.cause).includes(`synthetic ${cleanupOrder[index]} failure`)
  ))) {
    throw new Error(`${scenario.name}: cleanup failures were not attached in order`);
  }
}

for (const scenario of scenarios) await runScenario(scenario);
console.log('history mode pointer transaction matrix checks passed');
