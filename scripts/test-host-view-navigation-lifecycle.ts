import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createHostViewNavigationLifecycle,
  type RememberedViewport,
  type ViewNavigationReveal
} from '../src/application/hostViewNavigationLifecycle';

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
};

let lineCount = 200;
let remembered: RememberedViewport | null = null;
let persistFailure = false;
const persisted: Array<RememberedViewport | null> = [];
const reveals: ViewNavigationReveal[] = [];
let acceptReveal = true;

const createLifecycle = (initial?: {
  selection?: { anchor: number; head: number };
  fragment?: string;
}) => createHostViewNavigationLifecycle({
  readLineCount: () => lineCount,
  readMinimumRememberedLines: () => 20,
  initialSelection: initial?.selection ?? null,
  initialFragment: initial?.fragment ?? null,
  persistence: {
    read: () => remembered,
    write: async (value) => {
      if (persistFailure) throw new Error('persist failed');
      remembered = value;
      persisted.push(value);
    }
  },
  output: {
    reveal: async (reveal) => {
      reveals.push(reveal);
      return acceptReveal;
    }
  },
  reportFailure: () => undefined,
  now: () => 100
});

const empty = createLifecycle();
assert.equal(empty.getInitialRestore(), null, 'missing remembered state must not invent a restore');
empty.dispose();

remembered = { line: 45, lineOffset: 0.25, updatedAt: 1 };
const selectionWins = createLifecycle({ selection: { anchor: 7, head: 9 }, fragment: '#later' });
assert.equal(selectionWins.getInitialRestore(), null, 'an initial Selection must suppress remembered viewport');
await selectionWins.ready();
assert.deepEqual(reveals.splice(0), [
  { kind: 'selection', anchor: 7, head: 9, focus: undefined, preserveViewport: false },
  { kind: 'fragment', href: '#later' }
], 'ready must flush Selection before fragment so fragment keeps final priority');
selectionWins.dispose();

const fragmentAfterRestore = createLifecycle({ fragment: '#heading' });
assert.deepEqual(fragmentAfterRestore.getInitialRestore(), { line: 45, lineOffset: 0.25 });
await fragmentAfterRestore.ready();
assert.deepEqual(reveals.splice(0), [{ kind: 'fragment', href: '#heading' }]);
fragmentAfterRestore.dispose();

remembered = { line: 999, lineOffset: 0.7, updatedAt: 2 };
lineCount = 100;
const eof = createLifecycle();
assert.deepEqual(eof.getInitialRestore(), { line: 90, lineOffset: 0 }, 'EOF restore must back off from the unstable tail');
await flushMicrotasks();
assert.deepEqual(persisted.at(-1), { line: 90, lineOffset: 0, updatedAt: 100 }, 'EOF correction must refresh persistence recency');
eof.dispose();

let rejectLatePersistence!: (error: Error) => void;
let latePersistenceReports = 0;
const latePersistence = createHostViewNavigationLifecycle({
  readLineCount: () => 100,
  readMinimumRememberedLines: () => 20,
  initialSelection: null,
  initialFragment: null,
  persistence: {
    read: () => ({ line: 100, lineOffset: 0, updatedAt: 1 }),
    write: () => new Promise((_resolve, reject) => { rejectLatePersistence = reject; })
  },
  output: { reveal: async () => true },
  reportFailure: () => { latePersistenceReports += 1; }
});
latePersistence.dispose();
rejectLatePersistence(new Error('late persistence'));
await flushMicrotasks();
assert.equal(latePersistenceReports, 0, 'dispose must suppress a late background persistence failure');

let acceptSelection = false;
const independentFailureReveals: ViewNavigationReveal[] = [];
const independentFailure = createHostViewNavigationLifecycle({
  readLineCount: () => 200,
  readMinimumRememberedLines: () => 20,
  initialSelection: { anchor: 5, head: 5 },
  initialFragment: '#still-reveal',
  persistence: { read: () => null, write: async () => undefined },
  output: {
    reveal: async (reveal) => {
      independentFailureReveals.push(reveal);
      return reveal.kind === 'fragment' || acceptSelection;
    }
  },
  reportFailure: () => undefined
});
await independentFailure.ready();
assert.deepEqual(independentFailureReveals.map((reveal) => reveal.kind), ['selection', 'fragment'], 'a failed Selection must not block the pending fragment');
acceptSelection = true;
await independentFailure.flush();
assert.deepEqual(independentFailureReveals.map((reveal) => reveal.kind), ['selection', 'fragment', 'selection']);
independentFailure.dispose();

let resolveFailedSelection!: (value: boolean) => void;
let lateAttempt = 0;
const supersedingReveals: ViewNavigationReveal[] = [];
const superseding = createHostViewNavigationLifecycle({
  readLineCount: () => 200,
  readMinimumRememberedLines: () => 20,
  initialSelection: { anchor: 1, head: 1 },
  initialFragment: null,
  persistence: { read: () => null, write: async () => undefined },
  output: {
    reveal: (reveal) => {
      supersedingReveals.push(reveal);
      lateAttempt += 1;
      return lateAttempt === 1
        ? new Promise((resolve) => { resolveFailedSelection = resolve; })
        : Promise.resolve(true);
    }
  },
  reportFailure: () => undefined
});
const supersedingReady = superseding.ready();
await Promise.resolve();
const supersedingRequest = superseding.revealSelection({ anchor: 2, head: 2 });
resolveFailedSelection(false);
await Promise.all([supersedingReady, supersedingRequest]);
assert.deepEqual(
  supersedingReveals.filter((reveal) => reveal.kind === 'selection').map((reveal) => reveal.anchor),
  [1, 2],
  'a request arriving during a failed output must flush without another external trigger'
);
superseding.dispose();

remembered = null;
lineCount = 200;
const pending = createLifecycle();
await pending.revealSelection({ anchor: 1, head: 1 });
await pending.revealSelection({ anchor: 2, head: 3 });
await pending.revealFragment('#first');
await pending.revealFragment('#latest');
assert.equal(reveals.length, 0, 'ready-gated actions must remain pending');
await pending.ready();
assert.deepEqual(reveals.splice(0), [
  { kind: 'selection', anchor: 2, head: 3, focus: undefined, preserveViewport: false },
  { kind: 'fragment', href: '#latest' }
], 'pending requests must use latest-wins within each kind');
await pending.revealSelection({ anchor: 2, head: 3 });
assert.equal(reveals.length, 0, 'the last successfully sent Selection must be deduplicated');
await pending.revealSelection({ anchor: 4, head: 4 });
assert.deepEqual(reveals.splice(0), [
  { kind: 'selection', anchor: 4, head: 4, focus: false, preserveViewport: true }
]);

acceptReveal = false;
await pending.revealFragment('#retry');
acceptReveal = true;
await pending.flush();
assert.deepEqual(reveals.splice(0), [
  { kind: 'fragment', href: '#retry' },
  { kind: 'fragment', href: '#retry' }
], 'failed output must remain pending for the next flush');

await pending.rememberViewport(33, 0.126);
assert.deepEqual(remembered, { line: 33, lineOffset: 0.13, updatedAt: 100 });
const successfulWrites = persisted.length;
await pending.rememberViewport(33, 0.13);
assert.equal(persisted.length, successfulWrites, 'equal remembered viewport must not be written twice');
persistFailure = true;
await assert.rejects(() => pending.rememberViewport(34, 0), /persist failed/);
persistFailure = false;
await pending.rememberViewport(34, 0);
assert.equal(persisted.at(-1)?.line, 34, 'failed persistence must remain retryable');

lineCount = 10;
await pending.rememberViewport(4, 0);
assert.equal(remembered, null, 'short documents must clear persisted viewport state');
pending.dispose();

let resolveLate!: (value: boolean) => void;
const lateReveals: ViewNavigationReveal[] = [];
const late = createHostViewNavigationLifecycle({
  readLineCount: () => 200,
  readMinimumRememberedLines: () => 20,
  initialSelection: null,
  initialFragment: null,
  persistence: { read: () => null, write: async () => undefined },
  output: {
    reveal: (reveal) => {
      lateReveals.push(reveal);
      return new Promise((resolve) => { resolveLate = resolve; });
    }
  },
  reportFailure: () => undefined
});
await late.ready();
const lateAction = late.revealSelection({ anchor: 8, head: 8 });
await Promise.resolve();
late.dispose();
resolveLate(true);
await lateAction;
await late.revealFragment('#ignored');
assert.equal(lateReveals.length, 1, 'dispose must ignore late completion and later actions');

const panelSessionSource = readFileSync(new URL('../src/extension/panelSession.ts', import.meta.url), 'utf8');
const extensionSource = readFileSync(new URL('../src/extension.ts', import.meta.url), 'utf8');
for (const legacyPattern of [
  /pendingRevealSelection/,
  /pendingRevealDocumentFragment/,
  /lastSentRevealSelectionKey/,
  /hasDeliveredInitialRevealSelection/,
  /pendingRestoreTopLine/,
  /lastSavedRememberedLine/,
  /saveRememberedViewPosition/,
  /resolveRememberedTopLineForInit/,
  /parseRevealOffsetFromUriFragment/
]) {
  assert.doesNotMatch(panelSessionSource, legacyPattern, `panelSession must not retain ${legacyPattern.source}`);
}
assert.equal(
  extensionSource.match(/createVscodeViewNavigationAdapter\(/g)?.length,
  1,
  'Host Bootstrap must create exactly one view navigation adapter'
);
assert.match(panelSessionSource, /viewNavigation\.dispose\(\)/);

console.log('Host view navigation lifecycle checks passed');
