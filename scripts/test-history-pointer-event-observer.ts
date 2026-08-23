import {
  createHistoryPointerEventObserverRegistry,
  HistoryPointerEventObserverLifecycleError,
  historyPointerEventTypes,
  runHistoryPointerEventObserverLifecycle,
  type HistoryPointerEventType
} from "./history-pointer-event-observer";
import { HistoryModePointerTransactionError } from "./history-mode-pointer-transaction";
import { historyPointerObserverPrimary } from "./history-pointer-observer-failure";

type Listener = EventListenerOrEventListenerObject;
type Registration = { type: string; listener: Listener; options?: AddEventListenerOptions | boolean };

class FakeTarget extends EventTarget {
  readonly addCalls: string[] = [];
  readonly removeCalls: string[] = [];
  readonly registrations: Registration[] = [];
  readonly failAddAt: number | null;
  readonly failRemoveTypes: readonly string[];

  constructor(options: { failAddAt?: number; failRemoveTypes?: readonly string[] } = {}) {
    super();
    this.failAddAt = options.failAddAt ?? null;
    this.failRemoveTypes = options.failRemoveTypes ?? [];
  }

  override addEventListener(type: string, listener: Listener, options?: AddEventListenerOptions | boolean) {
    this.addCalls.push(type);
    if (this.failAddAt === this.addCalls.length) throw new Error(`synthetic add ${type}`);
    this.registrations.push({ type, listener, options });
    super.addEventListener(type, listener, options);
  }

  override removeEventListener(type: string, listener: Listener, options?: EventListenerOptions | boolean) {
    this.removeCalls.push(type);
    super.removeEventListener(type, listener, options);
    if (this.failRemoveTypes.includes(type)) throw new Error(`synthetic remove ${type}`);
  }

  emit(type: HistoryPointerEventType) {
    this.dispatchEvent(new Event(type));
  }
}

const types = historyPointerEventTypes;
const empty = { pointerdown: 0, pointerup: 0, click: 0 };
const transactionPrimary = (identity: Error) => new HistoryModePointerTransactionError(
  true,
  identity,
  [],
  {
    stages: ["acquired", "cleanupComplete"],
    physicalPointer: "notPressed",
    cleanupAttempts: { safeReleaseMove: 0, cancelRelease: 0, safeTargetDispose: 0, animationCancel: 0, handleDispose: 0 }
  }
);

function createFixture(options: { old?: ConstructorParameters<typeof FakeTarget>[0]; replacement?: ConstructorParameters<typeof FakeTarget>[0] } = {}) {
  const evidence = { dataset: {} as Record<string, string | undefined> };
  const old = new FakeTarget(options.old);
  const replacement = new FakeTarget(options.replacement);
  const documentTarget = new FakeTarget();
  const registry = createHistoryPointerEventObserverRegistry(evidence);
  const setup = () => {
    registry.setReplacement(replacement as unknown as Element);
    registry.observe("old", old);
    registry.observe("replacement", replacement);
    registry.observe("document", documentTarget);
  };
  return { evidence, old, replacement, documentTarget, registry, setup };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertSentinelDoesNotWrite(fixture: ReturnType<typeof createFixture>) {
  const before = fixture.evidence.dataset.historyPointerObserver;
  for (const type of types) {
    fixture.old.emit(type);
    fixture.replacement.emit(type);
    fixture.documentTarget.emit(type);
  }
  assert(fixture.evidence.dataset.historyPointerObserver === before, "sentinel event wrote after cleanup");
  assert(fixture.registry.snapshot().registrations === 0, "registry retained a sentinel listener");
  assert(fixture.registry.verifySentinel(), "registry sentinel verification failed");
  assert(fixture.registry.snapshot().sentinelVerified, "sentinel verification was not recorded");
}

async function expectFailure(action: () => Promise<void>) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new Error("expected lifecycle failure");
}

async function captureOutcome(action: () => Promise<void>) {
  try {
    await action();
    return { threw: false as const };
  } catch (error) {
    return { threw: true as const, error };
  }
}

const tests: Array<[string, () => Promise<void>]> = [
  ["zero-event success", async () => {
    const fixture = createFixture();
    await runHistoryPointerEventObserverLifecycle({ setup: async () => fixture.setup(), execute: async () => {}, cleanup: async () => fixture.registry.cleanup() });
    const state = fixture.registry.snapshot();
    assert(JSON.stringify(state.direct.old) === JSON.stringify(empty), "old count changed without events");
    assert(JSON.stringify(state.direct.replacement) === JSON.stringify(empty), "replacement count changed without events");
    assert(state.cleaned && state.registrations === 0, "zero-event cleanup did not close registry");
    assertSentinelDoesNotWrite(fixture);
  }],
  ["normal replacement three events", async () => {
    const fixture = createFixture();
    await runHistoryPointerEventObserverLifecycle({
      setup: async () => fixture.setup(),
      execute: async () => {
        for (const type of types) {
          fixture.replacement.emit(type);
          fixture.documentTarget.emit(type);
        }
      },
      cleanup: async () => fixture.registry.cleanup()
    });
    const state = fixture.registry.snapshot();
    assert(JSON.stringify(state.direct.old) === JSON.stringify(empty), "old node received normal replacement event");
    assert(JSON.stringify(state.direct.replacement) === JSON.stringify({ pointerdown: 1, pointerup: 1, click: 1 }), "replacement counts differ");
    assert(state.documentEvents.length === 3, "document event sequence differs");
    assertSentinelDoesNotWrite(fixture);
  }],
  ["malicious detached old events", async () => {
    const fixture = createFixture();
    await runHistoryPointerEventObserverLifecycle({
      setup: async () => fixture.setup(),
      execute: async () => { for (const type of types) fixture.old.emit(type); },
      cleanup: async () => fixture.registry.cleanup()
    });
    assert(JSON.stringify(fixture.registry.snapshot().direct.old) === JSON.stringify({ pointerdown: 1, pointerup: 1, click: 1 }), "old-node oracle missed detached events");
    assertSentinelDoesNotWrite(fixture);
  }],
  ["setup failure cleans partial registrations", async () => {
    const fixture = createFixture({ old: { failAddAt: 2 } });
    const error = await expectFailure(() => runHistoryPointerEventObserverLifecycle({ setup: async () => fixture.setup(), execute: async () => {}, cleanup: async () => fixture.registry.cleanup() }));
    assert(String(error).includes("synthetic add"), "setup primary was not preserved");
    assert(fixture.registry.snapshot().registrations === 0, "setup failure leaked registration");
    assertSentinelDoesNotWrite(fixture);
  }],
  ["primary failure cleans", async () => {
    const fixture = createFixture();
    const error = await expectFailure(() => runHistoryPointerEventObserverLifecycle({ setup: async () => fixture.setup(), execute: async () => { throw new Error("synthetic primary"); }, cleanup: async () => fixture.registry.cleanup() }));
    assert(String(error).includes("synthetic primary"), "primary failure was not preserved");
    assertSentinelDoesNotWrite(fixture);
  }],
  ["single cleanup failure", async () => {
    const fixture = createFixture({ old: { failRemoveTypes: ["pointerdown"] } });
    const error = await expectFailure(() => runHistoryPointerEventObserverLifecycle({ setup: async () => fixture.setup(), execute: async () => {}, cleanup: async () => fixture.registry.cleanup() }));
    assert(error instanceof AggregateError && error.errors.length === 1, "single cleanup error was not aggregated");
    assert(String(error.errors[0]).includes("old:pointerdown"), "cleanup operation identity was lost");
    assertSentinelDoesNotWrite(fixture);
  }],
  ["primary plus ordered cleanup failures", async () => {
    const fixture = createFixture({ old: { failRemoveTypes: ["pointerdown", "pointerup"] } });
    const error = await expectFailure(() => runHistoryPointerEventObserverLifecycle({ setup: async () => fixture.setup(), execute: async () => { throw new Error("synthetic primary"); }, cleanup: async () => fixture.registry.cleanup() }));
    assert(error instanceof AggregateError, "primary plus cleanup was not aggregated");
    assert(String(error.errors[0]).includes("synthetic primary"), "primary was not first");
    assert(String(error.errors[1]).includes("old:pointerdown") && String(error.errors[2]).includes("old:pointerup"), "cleanup order changed");
    assert(error.cause === error.errors[0], "aggregate cause was not primary");
    assertSentinelDoesNotWrite(fixture);
  }],
  ["falsy setup execute and cleanup failures survive", async () => {
    const values: Array<[string, unknown]> = [["undefined", undefined], ["null", null], ["zero", 0], ["false", false], ["empty", ""]];
    for (const [name, value] of values) {
      for (const phase of ["setup", "execute", "cleanup"] as const) {
        const outcome = await captureOutcome(() => runHistoryPointerEventObserverLifecycle({
          setup: async () => { if (phase === "setup") throw value; },
          execute: async () => { if (phase === "execute") throw value; },
          cleanup: async () => { if (phase === "cleanup") throw value; }
        }));
        assert(outcome.threw && Object.is(outcome.error, value), `${phase} ${name} failure was swallowed`);
      }
    }
  }],
  ["undefined primary remains first with falsy cleanup", async () => {
    const outcome = await captureOutcome(() => runHistoryPointerEventObserverLifecycle({
      setup: async () => { throw undefined; },
      execute: async () => {},
      cleanup: async () => { throw false; }
    }));
    assert(outcome.threw && outcome.error instanceof AggregateError, "falsy primary plus cleanup was not aggregated");
    assert(outcome.error.errors[0] === undefined && outcome.error.errors[1] === false, "falsy aggregate order changed");
    assert(outcome.error.cause === undefined, "falsy aggregate cause changed");
  }],
  ["observer primary classification preserves transaction error", async () => {
    const identity = new Error("synthetic identity");
    const direct = transactionPrimary(identity);
    const cleanup = new Error("synthetic cleanup");
    const lifecycle = new HistoryPointerEventObserverLifecycleError(direct, [cleanup]);
    const ordinary = new Error("ordinary");
    const cleanupOnly = new AggregateError([new Error("cleanup")], "History pointer observer cleanup failed");
    assert(historyPointerObserverPrimary(direct) === direct, "direct transaction primary was unwrapped");
    assert(historyPointerObserverPrimary(lifecycle) === direct, "lifecycle transaction primary was lost");
    assert(historyPointerObserverPrimary(lifecycle) instanceof HistoryModePointerTransactionError, "transaction public state was not retained");
    assert(direct.cause === identity && lifecycle.cause === direct && lifecycle.errors[1] === cleanup, "identity or cleanup cause was lost");
    assert(historyPointerObserverPrimary(ordinary) === ordinary, "ordinary error was guessed as lifecycle error");
    assert(historyPointerObserverPrimary(cleanupOnly) === cleanupOnly, "cleanup-only error was guessed as primary");
  }],
  ["duplicate cleanup", async () => {
    const fixture = createFixture();
    fixture.setup();
    fixture.registry.cleanup();
    fixture.registry.cleanup();
    const state = fixture.registry.snapshot();
    assert(state.cleanupCalls === 2 && state.registrations === 0 && state.cleaned, "duplicate cleanup was not idempotent");
    assert(fixture.old.removeCalls.length === 3 && fixture.replacement.removeCalls.length === 3 && fixture.documentTarget.removeCalls.length === 3, "duplicate cleanup retried listener removal");
    assertSentinelDoesNotWrite(fixture);
  }]
];

const failures: string[] = [];
for (const [name, test] of tests) {
  try {
    await test();
  } catch (error) {
    failures.push(`${name}: ${String(error)}`);
  }
}
if (failures.length > 0) throw new Error(`History pointer observer matrix failed:\n${failures.join("\n")}`);
console.log("history pointer observer lifecycle matrix checks passed");
