import assert from 'node:assert/strict';
import {
  createHostViewNavigationLifecycle,
  type ViewNavigationReveal
} from '../src/application/hostViewNavigationLifecycle';

const reveals: ViewNavigationReveal[] = [];
let acceptReveal = true;

const createLifecycle = (initial?: {
  selection?: { anchor: number; head: number };
  fragment?: string;
}) => createHostViewNavigationLifecycle({
  initialSelection: initial?.selection ?? null,
  initialFragment: initial?.fragment ?? null,
  output: {
    reveal: async (reveal) => {
      reveals.push(reveal);
      return acceptReveal;
    }
  }
});

const initial = createLifecycle({ selection: { anchor: 7, head: 9 }, fragment: '#later' });
await initial.ready();
assert.deepEqual(reveals.splice(0), [
  { kind: 'selection', anchor: 7, head: 9, focus: undefined, preserveViewport: false },
  { kind: 'fragment', href: '#later' }
], 'ready must flush Selection before fragment so fragment keeps final priority');
initial.dispose();

let acceptSelection = false;
const independentFailureReveals: ViewNavigationReveal[] = [];
const independentFailure = createHostViewNavigationLifecycle({
  initialSelection: { anchor: 5, head: 5 },
  initialFragment: '#still-reveal',
  output: {
    reveal: async (reveal) => {
      independentFailureReveals.push(reveal);
      return reveal.kind === 'fragment' || acceptSelection;
    }
  }
});
await independentFailure.ready();
assert.deepEqual(
  independentFailureReveals.map((reveal) => reveal.kind),
  ['selection', 'fragment'],
  'a failed Selection must not block the pending fragment'
);
acceptSelection = true;
await independentFailure.flush();
assert.deepEqual(independentFailureReveals.map((reveal) => reveal.kind), ['selection', 'fragment', 'selection']);
independentFailure.dispose();

let resolveFailedSelection!: (value: boolean) => void;
let lateAttempt = 0;
const supersedingReveals: ViewNavigationReveal[] = [];
const superseding = createHostViewNavigationLifecycle({
  initialSelection: { anchor: 1, head: 1 },
  initialFragment: null,
  output: {
    reveal: (reveal) => {
      supersedingReveals.push(reveal);
      lateAttempt += 1;
      return lateAttempt === 1
        ? new Promise((resolve) => { resolveFailedSelection = resolve; })
        : Promise.resolve(true);
    }
  }
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
pending.dispose();

let resolveLate!: (value: boolean) => void;
const lateReveals: ViewNavigationReveal[] = [];
const late = createHostViewNavigationLifecycle({
  initialSelection: null,
  initialFragment: null,
  output: {
    reveal: (reveal) => {
      lateReveals.push(reveal);
      return new Promise((resolve) => { resolveLate = resolve; });
    }
  }
});
await late.ready();
const lateAction = late.revealSelection({ anchor: 8, head: 8 });
await Promise.resolve();
late.dispose();
resolveLate(true);
await lateAction;
await late.revealFragment('#ignored');
assert.equal(lateReveals.length, 1, 'dispose must ignore late completion and later actions');

console.log('Host view navigation lifecycle checks passed');
