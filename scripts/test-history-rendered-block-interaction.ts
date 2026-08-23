import {
  runHistoryRenderedBlockInteraction,
  type HistoryRenderedBlockInteractionAdapter
} from './history-rendered-block-interaction';

type Handle = { readonly id: number };

const calls: string[] = [];
const adapter: HistoryRenderedBlockInteractionAdapter<Handle> = {
  settleScroll: async () => 'settled',
  isTargetSettled: async () => false,
  acquireCurrentHandle: async () => {
    calls.push('acquire');
    return { id: calls.filter((call) => call === 'acquire').length };
  },
  validateCurrentHandle: async (handle) => {
    calls.push(`validate:${handle.id}`);
    return { x: handle.id, y: handle.id };
  },
  preparePointerDown: async () => { calls.push('prepare-down'); },
  deliverPointerDown: async () => { calls.push('down'); },
  preparePointerUp: async () => { calls.push('prepare-up'); },
  deliverPointerUp: async () => { calls.push('up'); },
  settleTarget: async () => { calls.push('settle-target'); },
  disposeSupersededHandle: async () => { calls.push('dispose-superseded'); },
  disposeHandle: async () => { calls.push('dispose-handle'); },
  moveToSafeReleaseTarget: async () => { calls.push('safe-target'); },
  cancelPointer: async () => { calls.push('cancel-pointer'); },
  disposeSafeReleaseTarget: async () => { calls.push('dispose-safe-target'); },
  openObserver: async () => ({
    cleanup: async () => { calls.push('observer-cleanup'); },
    snapshot: async () => ({ events: [], registrations: 0, cleaned: true, sentinelRejected: true }),
    verifySentinel: async () => true
  })
};

const result = await runHistoryRenderedBlockInteraction({
  kind: 'mermaid',
  lineNumber: 9,
  targetMode: 'split'
}, adapter);

if (result.status !== 'completed') throw new Error(`Expected completed interaction, got ${result.status}`);
const expected = [
  'acquire', 'validate:1', 'prepare-down', 'acquire', 'dispose-superseded',
  'validate:2', 'down', 'prepare-up', 'validate:2', 'up', 'settle-target',
  'dispose-handle', 'observer-cleanup'
];
if (JSON.stringify(calls) !== JSON.stringify(expected)) {
  throw new Error(`Unexpected interaction ordering: ${JSON.stringify(calls)}`);
}
console.log('history rendered-block interaction module first tracer passed');

type PrimaryStage =
  | 'acquire1'
  | 'initialValidate'
  | 'prepareDown'
  | 'reacquire2'
  | 'downValidate'
  | 'deliverDown'
  | 'prepareUp'
  | 'upValidate'
  | 'deliverUp'
  | 'settleTarget'
  | 'success';
type CleanupOp =
  | 'safeReleaseMove'
  | 'cancelPointer'
  | 'safeTargetDispose'
  | 'animationCancel'
  | 'supersededHandleDispose'
  | 'initialHandleDispose'
  | 'currentHandleDispose'
  | 'observerCleanup'
  | 'observerSentinel'
  | 'observerSnapshot';
type FixtureOptions = {
  readonly replacement?: 0 | 1 | 2;
  readonly noOp?: boolean;
  readonly unsupported?: boolean;
  readonly primaryFailure?: Exclude<PrimaryStage, 'success'> | 'scroll';
  readonly cleanupFailures?: readonly CleanupOp[];
  readonly cleanupValues?: Readonly<Partial<Record<CleanupOp, unknown>>>;
  readonly sameNodeMoves?: boolean;
  readonly scroll?: Promise<'settled' | 'unsupported'>;
};

/** The deterministic Adapter records the Module's public effects by identity. */
function fixture(options: FixtureOptions = {}) {
  const trace: string[] = [];
  const stageTrace: PrimaryStage[] = [];
  const cleanupCounts = new Map<CleanupOp, number>();
  const disposeCounts = new Map<number, number>();
  const observed = { old: 0, replacement: 0, document: 0, registries: 0, cleanup: 0 };
  const first = { id: 1 };
  const replacement = { id: 2 };
  const modeCalls: Array<'preview' | 'split' | 'source'> = [];
  let acquires = 0;
  let secondAcquireCompleted = false;
  const failPrimary = (stage: Exclude<PrimaryStage, 'success'>) => {
    stageTrace.push(stage);
    if (options.primaryFailure === stage) throw new Error(`synthetic ${stage}`);
  };
  const failCleanup = (operation: CleanupOp) => {
    cleanupCounts.set(operation, (cleanupCounts.get(operation) ?? 0) + 1);
    trace.push(`cleanup:${operation}`);
    if (Object.hasOwn(options.cleanupValues ?? {}, operation)) throw options.cleanupValues![operation];
    if (options.cleanupFailures?.includes(operation)) throw new Error(`synthetic cleanup ${operation}`);
  };
  const adapter: HistoryRenderedBlockInteractionAdapter<typeof first> = {
    settleScroll: async () => {
      trace.push('scroll');
      if (options.primaryFailure === 'scroll') throw new Error('synthetic scroll');
      return options.scroll ? await options.scroll : options.unsupported ? 'unsupported' : 'settled';
    },
    isTargetSettled: async () => Boolean(options.noOp),
    acquireCurrentHandle: async () => {
      trace.push('acquire');
      const stage = acquires++ === 0 ? 'acquire1' : 'reacquire2';
      failPrimary(stage);
      if (stage === 'reacquire2') secondAcquireCompleted = true;
      return stage === 'acquire1' || options.replacement === 0 ? first : replacement;
    },
    validateCurrentHandle: async (handle, phase) => {
      trace.push(`validate:${handle.id}:${phase}`);
      if (phase === 'pointerdown' && handle.id === 2 && options.replacement === 2) {
        throw new Error('synthetic continuous replacement');
      }
      const stage = phase === 'pointerup'
        ? 'upValidate'
        : secondAcquireCompleted ? 'downValidate' : 'initialValidate';
      failPrimary(stage);
      return phase === 'pointerup' && options.sameNodeMoves ? { x: 20, y: 20 } : { x: 10, y: 10 };
    },
    preparePointerDown: async () => { trace.push('prepare-down'); failPrimary('prepareDown'); },
    deliverPointerDown: async () => { trace.push('down'); failPrimary('deliverDown'); },
    preparePointerUp: async () => { trace.push('prepare-up'); failPrimary('prepareUp'); },
    deliverPointerUp: async () => { trace.push('up'); failPrimary('deliverUp'); },
    settleTarget: async (interaction) => { trace.push(`settle:${interaction.targetMode}`); modeCalls.push(interaction.targetMode); failPrimary('settleTarget'); },
    disposeSupersededHandle: async (handle) => {
      trace.push(`dispose-superseded:${handle.id}`);
      disposeCounts.set(handle.id, (disposeCounts.get(handle.id) ?? 0) + 1);
      failCleanup('supersededHandleDispose');
    },
    disposeHandle: async (handle) => {
      trace.push(`dispose-handle:${handle.id}`);
      disposeCounts.set(handle.id, (disposeCounts.get(handle.id) ?? 0) + 1);
      failCleanup(secondAcquireCompleted ? 'currentHandleDispose' : 'initialHandleDispose');
    },
    moveToSafeReleaseTarget: async () => { trace.push('safe-target'); failCleanup('safeReleaseMove'); },
    cancelPointer: async () => { trace.push('cancel-pointer'); failCleanup('cancelPointer'); },
    disposeSafeReleaseTarget: async () => { trace.push('dispose-safe-target'); failCleanup('safeTargetDispose'); },
    cancelAnimation: async () => { failCleanup('animationCancel'); },
    openObserver: async () => {
      observed.registries += 1;
      observed.old += 1;
      observed.replacement += 1;
      observed.document += 1;
      return {
        cleanup: async () => {
          observed.cleanup += 1;
          observed.registries -= 1;
          failCleanup('observerCleanup');
        },
        snapshot: async () => {
          failCleanup('observerSnapshot');
          return {
            events: ['old:pointerdown', 'replacement:pointerup', 'document:click'],
            registrations: observed.registries,
            cleaned: observed.cleanup > 0,
            sentinelRejected: observed.cleanup > 0
          };
        },
        verifySentinel: async () => {
          failCleanup('observerSentinel');
          return observed.cleanup > 0;
        }
      };
    }
  };
  return { adapter, trace, stageTrace, cleanupCounts, disposeCounts, observed, modeCalls };
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function expectInteractionFailure(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error('expected interaction failure');
}

function cleanupCount(subject: ReturnType<typeof fixture>, operation: CleanupOp) {
  return subject.cleanupCounts.get(operation) ?? 0;
}

function assertClosed(subject: ReturnType<typeof fixture>) {
  check(subject.observed.registries === 0 && subject.observed.cleanup === 1, 'observer registry did not close exactly once');
  for (const [handle, count] of subject.disposeCounts) {
    check(count <= 1, `handle ${handle} was disposed more than once`);
  }
}

const matrix: Array<[string, () => Promise<void>]> = [
  ['0 replacement keeps one current handle', async () => {
    const subject = fixture({ replacement: 0 });
    const result = await runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 1, targetMode: 'preview' }, subject.adapter);
    check(result.status === 'completed', 'zero replacement did not complete');
    check(!subject.trace.some((entry) => entry.startsWith('dispose-superseded')), 'same handle was disposed as superseded');
    assertClosed(subject);
  }],
  ['one replacement reacquires before down', async () => {
    const subject = fixture({ replacement: 1 });
    await runHistoryRenderedBlockInteraction({ kind: 'mermaid', lineNumber: 2, targetMode: 'split' }, subject.adapter);
    check(subject.trace.indexOf('dispose-superseded:1') < subject.trace.indexOf('down'), 'old handle survived to pointerdown');
    check(subject.trace.includes('validate:2:pointerdown'), 'replacement was not current before pointerdown');
  }],
  ['continuous replacement rejects without retry', async () => {
    const subject = fixture({ replacement: 2 });
    const error = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 3, targetMode: 'source' }, subject.adapter));
    check(error instanceof Error && String(error).includes('continuous replacement'), 'continuous replacement was not primary');
    check(subject.trace.filter((entry) => entry === 'acquire').length === 2, 'replacement retried acquisition');
    assertClosed(subject);
  }],
  ['second acquire failure disposes the first handle exactly once', async () => {
    const subject = fixture({ primaryFailure: 'reacquire2' });
    const error = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 3, targetMode: 'source' }, subject.adapter));
    check(String(error).includes('synthetic reacquire2'), 'second acquire failure was not primary');
    check(subject.trace.filter((entry) => entry === 'dispose-handle:1').length === 1, 'first handle leaked or was double-disposed after second acquire failure');
    assertClosed(subject);
  }],
  ['same-node movement recomputes pointerup hit target', async () => {
    const subject = fixture({ replacement: 0, sameNodeMoves: true });
    await runHistoryRenderedBlockInteraction({ kind: 'mermaid', lineNumber: 4, targetMode: 'source' }, subject.adapter);
    check(subject.trace.includes('validate:1:pointerup'), 'same node was not checked at pointerup');
  }],
  ['every explicit target mode settles from every initial mode', async () => {
    for (const initial of ['preview', 'split', 'source'] as const) {
      for (const targetMode of ['preview', 'split', 'source'] as const) {
        const subject = fixture();
        await runHistoryRenderedBlockInteraction({ kind: initial === 'preview' ? 'mermaid' : 'math', lineNumber: 5, targetMode }, subject.adapter);
        check(subject.modeCalls[0] === targetMode, `${initial} -> ${targetMode} did not use exact target mode`);
      }
    }
  }],
  ['no-op and unsupported scroll do not acquire a control', async () => {
    for (const options of [{ noOp: true }, { unsupported: true }]) {
      const subject = fixture(options);
      const result = await runHistoryRenderedBlockInteraction({ kind: 'mermaid', lineNumber: 6, targetMode: 'preview' }, subject.adapter);
      check(result.status === (options.noOp ? 'noop' : 'unsupported'), 'no-op status changed');
      check(!subject.trace.includes('acquire'), 'no-op acquired a pointer target');
    }
  }],
  ['pending scroll blocks acquisition and scroll errors preserve cleanup order', async () => {
    let release!: (value: 'settled') => void;
    const subject = fixture({ scroll: new Promise<'settled'>((resolve) => { release = resolve; }) });
    const pending = runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 7, targetMode: 'split' }, subject.adapter);
    await Promise.resolve();
    check(!subject.trace.includes('acquire'), 'pending scroll acquired before settlement');
    release('settled');
    await pending;
    const failed = fixture({ primaryFailure: 'scroll' });
    const error = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 8, targetMode: 'split' }, failed.adapter));
    check(error instanceof Error && String(error).includes('synthetic scroll'), 'scroll error was changed');
  }],
  ['table-driven primary stages preserve ownership and physical pointer safety', async () => {
    const releaseStages = new Set<PrimaryStage>(['deliverDown', 'prepareUp', 'upValidate', 'deliverUp']);
    const stages: readonly Exclude<PrimaryStage, 'success'>[] = [
      'acquire1', 'initialValidate', 'prepareDown', 'reacquire2', 'downValidate',
      'deliverDown', 'prepareUp', 'upValidate', 'deliverUp', 'settleTarget'
    ];
    for (const primaryFailure of stages) {
      const subject = fixture({ primaryFailure, replacement: 1 });
      const error = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'mermaid', lineNumber: 9, targetMode: 'preview' }, subject.adapter));
      check(String(error).includes(`synthetic ${primaryFailure}`), `${primaryFailure} did not remain primary`);
      check(subject.stageTrace.includes(primaryFailure), `${primaryFailure} was not hit by the table`);
      const expectedRelease = releaseStages.has(primaryFailure) ? 1 : 0;
      check(cleanupCount(subject, 'cancelPointer') === expectedRelease, `${primaryFailure} safe cancel state differs`);
      check(cleanupCount(subject, 'safeTargetDispose') === expectedRelease, `${primaryFailure} safe target disposal differs`);
      assertClosed(subject);
    }
  }],
  ['every cleanup operation remains ordered and observable under a single fault', async () => {
    const releaseOps: readonly CleanupOp[] = ['safeReleaseMove', 'cancelPointer', 'safeTargetDispose'];
    const currentOps: readonly CleanupOp[] = ['animationCancel', 'supersededHandleDispose', 'currentHandleDispose', 'observerCleanup', 'observerSentinel', 'observerSnapshot'];
    for (const operation of [...releaseOps, ...currentOps]) {
      const subject = fixture({ primaryFailure: 'upValidate', replacement: 1, cleanupFailures: [operation] });
      const error = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 10, targetMode: 'source' }, subject.adapter));
      check(error instanceof AggregateError && error.hasPrimary, `${operation} changed cleanup-only fault into another result`);
      check(String(error.errors[0]).includes('synthetic upValidate'), `${operation} masked the primary failure`);
      check(cleanupCount(subject, operation) === 1, `${operation} was not attempted exactly once`);
      assertClosed(subject);
    }
    const initial = fixture({ primaryFailure: 'reacquire2', cleanupFailures: ['initialHandleDispose'] });
    const initialError = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 11, targetMode: 'source' }, initial.adapter));
    check(initialError instanceof AggregateError && String(initialError.errors[0]).includes('synthetic reacquire2'), 'initial disposal masked its primary');
    check(cleanupCount(initial, 'initialHandleDispose') === 1, 'initial handle disposal was not attempted exactly once');
    assertClosed(initial);
  }],
  ['multiple and falsy cleanup faults preserve primary-first and continue later cleanup', async () => {
    const subject = fixture({
      primaryFailure: 'upValidate',
      replacement: 1,
      cleanupFailures: ['safeReleaseMove', 'safeTargetDispose', 'currentHandleDispose', 'observerCleanup', 'observerSentinel'],
      cleanupValues: { observerSnapshot: undefined }
    });
    const error = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 12, targetMode: 'source' }, subject.adapter));
    check(error instanceof AggregateError && error.hasPrimary, 'combined cleanup faults lost the primary state');
    check(String(error.errors[0]).includes('synthetic upValidate'), 'primary failure was not first in aggregate');
    for (const operation of ['safeReleaseMove', 'safeTargetDispose', 'currentHandleDispose', 'observerCleanup', 'observerSentinel', 'observerSnapshot'] as const) {
      check(cleanupCount(subject, operation) === 1, `${operation} was skipped after an earlier cleanup fault`);
    }
    assertClosed(subject);
    for (const falsy of [undefined, null, 0, false, ''] as const) {
      const falsySubject = fixture({ primaryFailure: 'upValidate', cleanupValues: { currentHandleDispose: falsy } });
      const falsyError = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 13, targetMode: 'source' }, falsySubject.adapter));
      check(falsyError instanceof AggregateError && falsyError.errors.length === 2, `falsy cleanup ${String(falsy)} was swallowed`);
      check(String(falsyError.errors[0]).includes('synthetic upValidate'), 'falsy cleanup displaced primary');
      assertClosed(falsySubject);
    }
  }],
  ['cleanup-only aggregate retains all later cleanup work without a primary', async () => {
    const subject = fixture({
      replacement: 1,
      cleanupFailures: ['supersededHandleDispose', 'currentHandleDispose', 'observerCleanup', 'observerSentinel', 'observerSnapshot']
    });
    const error = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'mermaid', lineNumber: 14, targetMode: 'split' }, subject.adapter));
    check(error instanceof AggregateError && !error.hasPrimary, 'cleanup-only aggregate incorrectly has a primary');
    for (const operation of ['supersededHandleDispose', 'currentHandleDispose', 'observerCleanup', 'observerSentinel', 'observerSnapshot'] as const) {
      check(cleanupCount(subject, operation) === 1, `${operation} did not run after another cleanup fault`);
    }
    assertClosed(subject);
  }],
  ['mutation guards require safe cancel after pointerup validation and primary-first disposal errors', async () => {
    const safeCancel = fixture({ primaryFailure: 'upValidate' });
    await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 15, targetMode: 'preview' }, safeCancel.adapter));
    check(cleanupCount(safeCancel, 'cancelPointer') === 1, 'removing safe cancel after validate-up would stay green');
    const primaryFirst = fixture({ primaryFailure: 'upValidate', cleanupFailures: ['currentHandleDispose'] });
    const error = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 16, targetMode: 'preview' }, primaryFirst.adapter));
    check(error instanceof AggregateError && String(error.errors[0]).includes('synthetic upValidate'), 'removing primary-first aggregation would stay green');
    assertClosed(primaryFirst);
  }]
];

const failures: string[] = [];
for (const [name, test] of matrix) {
  try {
    await test();
  } catch (error) {
    failures.push(`${name}: ${String(error)}`);
  }
}
if (failures.length) throw new Error(`history rendered-block interaction matrix failed:\n${failures.join('\n')}`);
console.log('history rendered-block interaction deterministic matrix passed');
