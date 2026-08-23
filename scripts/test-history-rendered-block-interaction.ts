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
  openObserver: async () => ({ cleanup: async () => { calls.push('observer-cleanup'); } })
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

type Failure = 'scroll' | 'prepare-down' | 'down' | 'prepare-up' | 'up' | 'settle' | 'validate-down' | 'validate-up';
type FixtureOptions = {
  readonly replacement?: 0 | 1 | 2;
  readonly noOp?: boolean;
  readonly unsupported?: boolean;
  readonly failure?: Failure;
  readonly cleanupFailure?: unknown;
  readonly sameNodeMoves?: boolean;
  readonly scroll?: Promise<'settled' | 'unsupported'>;
};

function fixture(options: FixtureOptions = {}) {
  const trace: string[] = [];
  const observed = { old: 0, replacement: 0, document: 0, registries: 0, cleanup: 0 };
  const first = { id: 1 };
  const replacement = { id: 2 };
  const modeCalls: Array<'preview' | 'split' | 'source'> = [];
  const fail = (at: Failure) => {
    if (options.failure === at) throw new Error(`synthetic ${at}`);
  };
  const adapter: HistoryRenderedBlockInteractionAdapter<typeof first> = {
    settleScroll: async () => {
      trace.push('scroll');
      if (options.failure === 'scroll') throw new Error('synthetic scroll');
      return options.scroll ? await options.scroll : options.unsupported ? 'unsupported' : 'settled';
    },
    isTargetSettled: async () => Boolean(options.noOp),
    acquireCurrentHandle: async () => {
      trace.push('acquire');
      return trace.filter((entry) => entry === 'acquire').length === 1 || options.replacement === 0 ? first : replacement;
    },
    validateCurrentHandle: async (handle, phase) => {
      trace.push(`validate:${handle.id}:${phase}`);
      if (phase === 'pointerdown' && handle.id === 2 && options.replacement === 2) {
        throw new Error('synthetic continuous replacement');
      }
      fail(phase === 'pointerup' ? 'validate-up' : 'validate-down');
      return phase === 'pointerup' && options.sameNodeMoves ? { x: 20, y: 20 } : { x: 10, y: 10 };
    },
    preparePointerDown: async () => { trace.push('prepare-down'); fail('prepare-down'); },
    deliverPointerDown: async () => { trace.push('down'); fail('down'); },
    preparePointerUp: async () => { trace.push('prepare-up'); fail('prepare-up'); },
    deliverPointerUp: async () => { trace.push('up'); fail('up'); },
    settleTarget: async (interaction) => { trace.push(`settle:${interaction.targetMode}`); modeCalls.push(interaction.targetMode); fail('settle'); },
    disposeSupersededHandle: async (handle) => { trace.push(`dispose-superseded:${handle.id}`); },
    disposeHandle: async (handle) => { trace.push(`dispose-handle:${handle.id}`); },
    moveToSafeReleaseTarget: async () => { trace.push('safe-target'); },
    cancelPointer: async () => { trace.push('cancel-pointer'); },
    disposeSafeReleaseTarget: async () => { trace.push('dispose-safe-target'); },
    openObserver: async () => {
      observed.registries += 1;
      observed.old += 1;
      observed.replacement += 1;
      observed.document += 1;
      return {
        cleanup: async () => {
          observed.cleanup += 1;
          observed.registries -= 1;
          if (Object.hasOwn(options, 'cleanupFailure')) throw options.cleanupFailure;
        }
      };
    }
  };
  return { adapter, trace, observed, modeCalls };
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

const matrix: Array<[string, () => Promise<void>]> = [
  ['0 replacement keeps one current handle', async () => {
    const subject = fixture({ replacement: 0 });
    const result = await runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 1, targetMode: 'preview' }, subject.adapter);
    check(result.status === 'completed', 'zero replacement did not complete');
    check(!subject.trace.some((entry) => entry.startsWith('dispose-superseded')), 'same handle was disposed as superseded');
    check(subject.observed.registries === 0 && subject.observed.cleanup === 1, 'observer registry leaked');
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
    check(subject.observed.registries === 0, 'continuous replacement leaked observer');
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
    const failed = fixture({ failure: 'scroll' });
    const error = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 8, targetMode: 'split' }, failed.adapter));
    check(error instanceof Error && String(error).includes('synthetic scroll'), 'scroll error was changed');
  }],
  ['prepare down up and region failures safe-release exactly once', async () => {
    for (const failure of ['prepare-down', 'down', 'prepare-up', 'up', 'settle'] as const) {
      const subject = fixture({ failure });
      await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'mermaid', lineNumber: 9, targetMode: 'preview' }, subject.adapter));
      const released = subject.trace.filter((entry) => entry === 'cancel-pointer').length;
      const shouldRelease = failure === 'down' || failure === 'prepare-up' || failure === 'up';
      check(released === (shouldRelease ? 1 : 0), `${failure} safe release count differs`);
      check(subject.observed.registries === 0 && subject.observed.cleanup === 1, `${failure} cleanup leaked registry`);
    }
  }],
  ['primary-first and falsy observer cleanup failures survive', async () => {
    for (const falsy of [undefined, null, 0, false, ''] as const) {
      const subject = fixture({ failure: 'up', cleanupFailure: falsy });
      const error = await expectInteractionFailure(() => runHistoryRenderedBlockInteraction({ kind: 'math', lineNumber: 10, targetMode: 'source' }, subject.adapter));
      check(error instanceof AggregateError && error.errors.length === 2, `falsy cleanup ${String(falsy)} was swallowed`);
      check(String(error.errors[0]).includes('synthetic up'), 'primary failure was not first');
      check(subject.observed.cleanup === 1 && subject.observed.registries === 0, 'duplicate or missing observer cleanup');
    }
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
