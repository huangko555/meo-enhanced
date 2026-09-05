import assert from 'node:assert/strict';
import { mock } from 'bun:test';

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
};

type FakePlan = {
  readonly init?: Deferred<void>;
  readonly languageLoad?: Deferred<void>;
  loadFailures?: number;
};

type FakeHighlighter = {
  readonly id: number;
  readonly color: string;
  readonly loadedLanguages: Set<string>;
  loadCalls: number;
  tokenizeCalls: number;
  disposeCalls: number;
  loadLanguage(grammar: { readonly name: string }): Promise<void>;
  codeToTokens(code: string, options: { readonly lang: string }): {
    readonly tokens: Array<Array<{
      readonly offset: number;
      readonly content: string;
      readonly color: string;
      readonly fontStyle: number;
    }>>;
  };
  dispose(): void;
};

const plannedHighlighters: FakePlan[] = [];
const highlighters: FakeHighlighter[] = [];

const planHighlighter = (plan: FakePlan = {}): void => {
  plannedHighlighters.push(plan);
};

const createFakeHighlighter = (color: string, plan: FakePlan): FakeHighlighter => {
  const loadedLanguages = new Set<string>();
  const id = highlighters.length + 1;
  return {
    id,
    color,
    loadedLanguages,
    loadCalls: 0,
    tokenizeCalls: 0,
    disposeCalls: 0,
    async loadLanguage(grammar) {
      this.loadCalls += 1;
      if (plan.languageLoad) await plan.languageLoad.promise;
      if ((plan.loadFailures ?? 0) > 0) {
        plan.loadFailures = (plan.loadFailures ?? 0) - 1;
        throw new Error(`H${id} planned grammar failure`);
      }
      loadedLanguages.add(grammar.name);
    },
    codeToTokens(code, options) {
      this.tokenizeCalls += 1;
      if (!loadedLanguages.has(options.lang)) {
        throw new Error(`H${id} tokenized ${options.lang} without its grammar`);
      }
      return {
        tokens: [[{
          offset: 0,
          content: code,
          color,
          fontStyle: 0
        }]]
      };
    },
    dispose() {
      this.disposeCalls += 1;
    }
  };
};

mock.module('shiki/engine/oniguruma', () => ({
  createOnigurumaEngine: async () => ({})
}));
mock.module('shiki/wasm', () => ({ default: {} }));
mock.module('@shikijs/langs/typescript', () => ({
  default: { name: 'typescript' }
}));
mock.module('shiki/core', () => ({
  createHighlighterCore(options: { readonly themes?: Array<{ readonly fg?: string }> }) {
    const plan = plannedHighlighters.shift() ?? {};
    const highlighter = createFakeHighlighter(options.themes?.[0]?.fg ?? '#000000', plan);
    highlighters.push(highlighter);
    return plan.init ? plan.init.promise.then(() => highlighter) : highlighter;
  }
}));

const shiki = await import('../webview/src/helpers/shikiHighlighter');

const theme = (name: string, type: 'light' | 'dark') => ({
  name,
  type,
  colors: {
    'editor.foreground': type === 'light' ? '#101010' : '#f0f0f0',
    'editor.background': type === 'light' ? '#ffffff' : '#101010'
  },
  tokenColors: []
});

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const drain = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

async function sourceWithoutConsumerDoesNoHeavyWork(): Promise<void> {
  const initializations = highlighters.length;
  shiki.setShikiTheme(theme('source', 'dark'));
  shiki.requestShikiTokens('typescript', 'const source = true;');
  await drain();
  assert.equal(highlighters.length, initializations, 'theme readiness without a Live consumer must not initialize Shiki');
  shiki.setShikiTheme(null);
}

async function consumersShareOneInstanceUntilTheLastRelease(): Promise<void> {
  planHighlighter();
  shiki.setShikiTheme(theme('shared', 'dark'));
  const releaseFirst = shiki.activateShikiCodeHighlighting();
  const releaseSecond = shiki.activateShikiCodeHighlighting();
  const initializations = highlighters.length;

  shiki.requestShikiTokens('typescript', 'const first = 1;');
  await waitFor(
    () => shiki.getShikiTokens('typescript', 'const first = 1;') !== null,
    'shared H1 tokens'
  );
  const shared = highlighters[initializations];
  assert.equal(highlighters.length, initializations + 1);
  assert.equal(shared.loadCalls, 1);
  assert.equal(shared.tokenizeCalls, 1);

  releaseFirst();
  releaseFirst();
  shiki.requestShikiTokens('typescript', 'const second = 2;');
  await waitFor(
    () => shiki.getShikiTokens('typescript', 'const second = 2;') !== null,
    'remaining consumer tokens'
  );
  assert.equal(highlighters.length, initializations + 1, '2→1 consumers must retain the same HighlighterCore');
  assert.equal(shared.loadCalls, 1, 'one instance should reuse its loaded grammar');
  assert.equal(shared.tokenizeCalls, 2);
  assert.equal(shared.disposeCalls, 0, '2→1 and repeated release must not dispose the shared HighlighterCore');

  releaseSecond();
  await waitFor(() => shared.disposeCalls === 1, 'last-consumer disposal');
  assert.equal(
    shiki.getShikiTokens('typescript', 'const first = 1;'),
    null,
    'last-consumer release must clear the instance token cache'
  );

  planHighlighter();
  const releaseReplacement = shiki.activateShikiCodeHighlighting();
  shiki.requestShikiTokens('typescript', 'const first = 1;');
  await waitFor(() => highlighters.length === initializations + 2, 'replacement HighlighterCore');
  const replacement = highlighters[initializations + 1];
  await waitFor(() => replacement.tokenizeCalls === 1, 'replacement tokens');
  assert.equal(replacement.loadCalls, 1, 'replacement instance must own and reload its grammar registry');
  releaseReplacement();
  releaseReplacement();
  await waitFor(() => replacement.disposeCalls === 1, 'replacement disposal');
  assert.equal(replacement.disposeCalls, 1, 'repeated release must be idempotent');
  shiki.setShikiTheme(null);
}

async function pendingInitializationDisposesWithoutPublishing(): Promise<void> {
  const initialization = deferred<void>();
  planHighlighter({ init: initialization });
  shiki.setShikiTheme(theme('pending-init', 'dark'));
  const refreshes: string[] = [];
  const unsubscribe = shiki.subscribeShikiRefresh(() => refreshes.push('refresh'));
  const release = shiki.activateShikiCodeHighlighting();
  const initializations = highlighters.length;
  const refreshBaseline = refreshes.length;
  shiki.requestShikiTokens('typescript', 'const pending = true;');
  await waitFor(() => highlighters.length === initializations + 1, 'pending HighlighterCore initialization');
  const pending = highlighters[initializations];

  release();
  release();
  initialization.resolve();
  await waitFor(() => pending.disposeCalls === 1, 'pending initialization disposal');
  await drain();
  assert.equal(pending.loadCalls, 0);
  assert.equal(pending.tokenizeCalls, 0);
  assert.equal(shiki.getShikiTokens('typescript', 'const pending = true;'), null);
  assert.equal(refreshes.length, refreshBaseline, 'stale pending initialization must not publish a refresh');
  unsubscribe();
  shiki.setShikiTheme(null);
}

async function oldLanguageCompletionCannotPolluteReplacementTheme(): Promise<void> {
  const oldLanguageLoad = deferred<void>();
  const replacementInitialization = deferred<void>();
  planHighlighter({ languageLoad: oldLanguageLoad });
  planHighlighter({ init: replacementInitialization });

  const refreshes: string[] = [];
  const unsubscribe = shiki.subscribeShikiRefresh(() => refreshes.push('refresh'));
  shiki.setShikiTheme(theme('old-dark', 'dark'));
  const release = shiki.activateShikiCodeHighlighting();
  const initializations = highlighters.length;
  shiki.requestShikiTokens('typescript', 'const stale = 1;');
  await waitFor(() => highlighters[initializations]?.loadCalls === 1, 'old grammar load');
  const oldHighlighter = highlighters[initializations];

  shiki.setShikiTheme(theme('latest-light', 'light'));
  shiki.requestShikiTokens('typescript', 'const latest = 2;');
  await waitFor(() => highlighters.length === initializations + 2, 'replacement initialization');
  const replacement = highlighters[initializations + 1];
  const replacementRefreshBaseline = refreshes.length;

  oldLanguageLoad.resolve();
  await drain();
  assert.equal(oldHighlighter.tokenizeCalls, 0, 'old grammar completion must not tokenize after theme replacement');
  assert.equal(refreshes.length, replacementRefreshBaseline, 'old grammar completion must not publish a refresh');

  replacementInitialization.resolve();
  await waitFor(() => replacement.loadCalls === 1, 'replacement grammar load');
  await waitFor(
    () => shiki.getShikiTokens('typescript', 'const latest = 2;') !== null,
    'replacement theme tokens'
  );
  assert.equal(
    shiki.getShikiTokens('typescript', 'const latest = 2;')?.[0]?.[0]?.color,
    '#101010',
    'the latest theme must publish the final token color'
  );
  assert.equal(replacement.tokenizeCalls, 1);
  await waitFor(() => refreshes.length > replacementRefreshBaseline, 'current batch refresh');
  assert.equal(refreshes.length, replacementRefreshBaseline + 1, 'only the current completion may refresh consumers');

  release();
  await waitFor(() => replacement.disposeCalls === 1, 'replacement theme disposal');
  unsubscribe();
  shiki.setShikiTheme(null);
}

async function languageFailureCanRetryOnTheSameInstance(): Promise<void> {
  planHighlighter({ loadFailures: 1 });
  shiki.setShikiTheme(theme('retry', 'dark'));
  const release = shiki.activateShikiCodeHighlighting();
  const initializations = highlighters.length;
  const originalConsoleError = console.error;
  let reportedFailures = 0;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes('Shiki tokenization failed')) reportedFailures += 1;
    else originalConsoleError(...args);
  };
  try {
    shiki.requestShikiTokens('typescript', 'const retry = true;');
    await waitFor(() => reportedFailures === 1, 'reported grammar failure');
    const retrying = highlighters[initializations];
    assert.equal(shiki.getShikiTokens('typescript', 'const retry = true;'), null);
    shiki.requestShikiTokens('typescript', 'const retry = true;');
    await waitFor(
      () => shiki.getShikiTokens('typescript', 'const retry = true;') !== null,
      'retry tokens'
    );
    assert.equal(highlighters.length, initializations + 1, 'language recovery should retain the current HighlighterCore');
    assert.equal(retrying.loadCalls, 2);
    assert.equal(retrying.tokenizeCalls, 1);
  } finally {
    console.error = originalConsoleError;
    release();
    shiki.setShikiTheme(null);
  }
}

assert.equal(shiki.resolveShikiLang('TS'), 'typescript');
assert.equal(shiki.resolveShikiLang('ruby'), 'ruby');
assert.equal(shiki.resolveShikiLang('rb'), 'ruby');
assert.equal(shiki.resolveShikiLang('php'), 'php');
assert.equal(shiki.resolveShikiLang('plaintext'), null, 'plain-text aliases must not receive syntax colors');
assert.equal(shiki.resolveShikiLang('unknown-language'), null, 'unknown languages must keep the plain-text fallback');
async function completedBatchRefreshesOnce(): Promise<void> {
  shiki.setShikiTheme(theme('batch', 'dark'));
  const release = shiki.activateShikiCodeHighlighting();
  let refreshes = 0;
  const unsubscribe = shiki.subscribeShikiRefresh(() => { refreshes += 1; });
  for (let i = 0; i < 30; i += 1) shiki.requestShikiTokens('typescript', `const batch = ${i};`);
  await waitFor(() => shiki.getShikiTokens('typescript', 'const batch = 29;') !== null, 'batch tokens');
  await drain();
  assert.equal(refreshes, 1, 'A completed token batch must not rebuild every consumer once per code block');
  unsubscribe();
  release();
  shiki.setShikiTheme(null);
}

await completedBatchRefreshesOnce();
await sourceWithoutConsumerDoesNoHeavyWork();
await consumersShareOneInstanceUntilTheLastRelease();
await pendingInitializationDisposesWithoutPublishing();
await oldLanguageCompletionCannotPolluteReplacementTheme();
await languageFailureCanRetryOnTheSameInstance();
assert.equal(plannedHighlighters.length, 0, 'every planned external HighlighterCore should be consumed');

console.log('Shiki highlighter instance lifecycle checks passed');
