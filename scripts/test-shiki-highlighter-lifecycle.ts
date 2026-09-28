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
  tokenFailures?: number;
  colorByGrammar?: boolean;
  onTokenize?(highlighter: FakeHighlighter): void;
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
      if (this.disposeCalls) throw new Error('Tokenized a disposed highlighter');
      plan.onTokenize?.(this);
      if ((plan.tokenFailures ?? 0) > 0) {
        plan.tokenFailures = (plan.tokenFailures ?? 0) - 1;
        throw new Error('Planned token failure');
      }
      if (!loadedLanguages.has(options.lang)) {
        throw new Error(`H${id} tokenized ${options.lang} without its grammar`);
      }
      let offset = 0;
      return {
        tokens: code.split(/(\r?\n)/).flatMap((part, index) => {
          const start = offset;
          offset += part.length;
          return index % 2 ? [] : [[{ offset: start, content: part, color,
            fontStyle: plan.colorByGrammar ? loadedLanguages.size : 0 }]];
        })
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
mock.module('@shikijs/langs/sql', () => ({ default: { name: 'sql' } }));
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

async function matchingSurfacesReuseCompletedTokens(first: 'editor' | 'preview'): Promise<void> {
  const code = 'const sharedAcrossSurfaces = 42;';
  const matchingTheme = theme('same-palette', 'dark');
  shiki.setShikiTheme(matchingTheme, 'editor');
  shiki.setShikiTheme(structuredClone(matchingTheme), 'preview');
  const releaseEditor = shiki.activateShikiCodeHighlighting('editor');
  const releasePreview = shiki.activateShikiCodeHighlighting('preview');
  const before = highlighters.reduce((sum, item) => sum + item.tokenizeCalls, 0);
  try {
    shiki.requestShikiTokens('typescript', code, first);
    shiki.requestShikiTokens('typescript', code, first === 'editor' ? 'preview' : 'editor');
    await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'editor')
      && !!shiki.getShikiTokens('typescript', code, 'preview'), 'both matching surfaces');
    assert.deepEqual(shiki.getShikiTokens('typescript', code, 'editor'),
      shiki.getShikiTokens('typescript', code, 'preview'));
    assert.equal(highlighters.reduce((sum, item) => sum + item.tokenizeCalls, 0) - before, 1,
      'matching active surfaces must tokenize identical source only once');
  } finally {
    releaseEditor();
    releasePreview();
    shiki.setShikiTheme(null, 'editor');
    shiki.setShikiTheme(null, 'preview');
    await drain();
  }
}

const tokenizeCount = (): number => highlighters.reduce((sum, item) => sum + item.tokenizeCalls, 0);

async function completedReuseKeepsIndependentLifetimes(): Promise<void> {
  const palette = theme('lifetime', 'dark');
  const code = 'const retained = 1;';
  shiki.setShikiTheme(palette, 'editor');
  shiki.setShikiTheme(structuredClone(palette), 'preview');
  const releaseEditor = shiki.activateShikiCodeHighlighting('editor');
  const releasePreview = shiki.activateShikiCodeHighlighting('preview');
  shiki.requestShikiTokens('typescript', code, 'editor');
  await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'editor'), 'donor tokens');
  const before = highlighters.length;
  const calls = tokenizeCount();
  let refreshes = 0;
  const unsubscribe = shiki.subscribeShikiRefresh(() => { refreshes += 1; }, 'preview');
  shiki.requestShikiTokens('typescript', code, 'preview');
  await waitFor(() => refreshes === 1, 'borrower refresh');
  assert.equal(highlighters.length, before + 1, 'reuse must preserve recipient grammar ownership');
  assert.equal(highlighters[before].loadCalls, 1);
  assert.equal(tokenizeCount(), calls);
  const expected = structuredClone(shiki.getShikiTokens('typescript', code, 'preview'));
  releaseEditor();
  releaseEditor();
  assert.equal(shiki.getShikiTokens('typescript', code, 'editor'), null);
  assert.deepEqual(shiki.getShikiTokens('typescript', code, 'preview'), expected,
    'donor release must not invalidate recipient output');
  releasePreview();
  releasePreview();
  assert.equal(shiki.getShikiTokens('typescript', code, 'preview'), null);
  shiki.requestShikiTokens('typescript', code, 'preview');
  await drain();
  assert.equal(tokenizeCount(), calls, 'inactive recipients must do no work');
  const releaseReplacement = shiki.activateShikiCodeHighlighting('preview');
  shiki.requestShikiTokens('typescript', code, 'preview');
  await waitFor(() => tokenizeCount() === calls + 1, 'new lifetime tokens');
  releaseReplacement();
  unsubscribe();
  shiki.setShikiTheme(null, 'editor');
  shiki.setShikiTheme(null, 'preview');
  await drain();
}

async function reuseRequiresEveryTokenInputToMatch(): Promise<void> {
  const palette = theme('input-isolation', 'dark');
  const code = 'const exact = 1;';
  shiki.setShikiTheme(palette, 'editor');
  const releaseEditor = shiki.activateShikiCodeHighlighting('editor');
  const releasePreview = shiki.activateShikiCodeHighlighting('preview');
  shiki.requestShikiTokens('typescript', code, 'editor');
  await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'editor'), 'input donor');
  const mismatches = [
    { ...palette, type: 'light' as const },
    { ...palette, colors: { ...palette.colors, 'editor.foreground': '#123456' } },
    { ...palette, colors: { ...palette.colors, 'editor.background': '#123456' } },
    { ...palette, tokenColors: [{ scope: 'keyword', settings: { foreground: '#123456' } }] }
  ];
  for (const changed of mismatches) {
    shiki.setShikiTheme(changed, 'preview');
    const before = tokenizeCount();
    shiki.requestShikiTokens('typescript', code, 'preview');
    await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'preview'), 'different theme');
    assert.equal(tokenizeCount(), before + 1, 'different theme inputs must tokenize independently');
  }
  shiki.setShikiTheme(palette, 'preview');
  for (const [language, source] of [['sql', code], ['typescript', code + '\n']]) {
    const before = tokenizeCount();
    shiki.requestShikiTokens(language, source, 'preview');
    await waitFor(() => !!shiki.getShikiTokens(language, source, 'preview'), 'different source/language');
    assert.equal(tokenizeCount(), before + 1);
    assert.equal(shiki.getShikiTokens(language, source, 'preview')?.map(line => line.map(syntaxToken => syntaxToken.content).join('')).join('\n'), source);
  }
  shiki.setShikiTheme(null, 'preview');
  const before = tokenizeCount();
  shiki.requestShikiTokens('typescript', code, 'preview');
  await drain();
  assert.equal(shiki.getShikiTokens('typescript', code, 'preview'), null);
  assert.equal(tokenizeCount(), before, 'missing theme cannot borrow another surface palette');
  releaseEditor();
  releasePreview();
  shiki.setShikiTheme(null, 'editor');
  await drain();
}

async function pendingSurfacesRetireIndependently(): Promise<void> {
  const palette = theme('pending-surfaces', 'dark');
  const code = 'const pendingSurface = 1;';
  for (const retire of ['release', 'theme'] as const) {
    const heldLoad = deferred<void>();
    planHighlighter({ languageLoad: heldLoad });
    shiki.setShikiTheme(palette, 'editor');
    shiki.setShikiTheme(palette, 'preview');
    const releaseEditor = shiki.activateShikiCodeHighlighting('editor');
    const releasePreview = shiki.activateShikiCodeHighlighting('preview');
    const first = highlighters.length;
    shiki.requestShikiTokens('typescript', code, 'editor');
    await waitFor(() => highlighters[first]?.loadCalls === 1, 'held surface grammar');
    shiki.requestShikiTokens('typescript', code, 'preview');
    await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'preview'), 'independent completion');
    if (retire === 'release') releaseEditor();
    else shiki.setShikiTheme(theme('replacement', 'light'), 'editor');
    let staleRefreshes = 0;
    const unsubscribe = shiki.subscribeShikiRefresh(() => { staleRefreshes += 1; }, 'editor');
    heldLoad.resolve();
    await drain();
    assert.equal(staleRefreshes, 0, 'retired pending work must not publish borrowed tokens');
    assert.equal(shiki.getShikiTokens('typescript', code, 'editor'), null);
    assert.equal(highlighters[first].tokenizeCalls, 0);
    if (retire === 'theme') {
      shiki.requestShikiTokens('typescript', code, 'editor');
      await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'editor'), 'replacement surface');
      assert.equal(shiki.getShikiTokens('typescript', code, 'editor')?.[0]?.[0]?.color, '#101010');
      assert.equal(shiki.getShikiTokens('typescript', code, 'preview')?.[0]?.[0]?.color, '#f0f0f0');
    }
    unsubscribe();
    releaseEditor();
    releasePreview();
    shiki.setShikiTheme(null, 'editor');
    shiki.setShikiTheme(null, 'preview');
    await drain();
  }
}

async function reusedEntriesRemainBounded(): Promise<void> {
  const palette = theme('bounded-reuse', 'dark');
  shiki.setShikiTheme(palette, 'editor');
  shiki.setShikiTheme(palette, 'preview');
  const releaseEditor = shiki.activateShikiCodeHighlighting('editor');
  const releasePreview = shiki.activateShikiCodeHighlighting('preview');
  const before = tokenizeCount();
  for (let i = 0; i <= 300; i++) {
    const code = `const bounded = ${i};`;
    shiki.requestShikiTokens('typescript', code, 'editor');
    await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'editor'), 'bounded donor');
    shiki.requestShikiTokens('typescript', code, 'preview');
    await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'preview'), 'bounded recipient');
  }
  assert.equal(tokenizeCount(), before + 301);
  for (const surface of ['editor', 'preview'] as const) {
    assert.equal(shiki.getShikiTokens('typescript', 'const bounded = 0;', surface), null,
      'reuse must preserve the existing per-surface entry limit');
    assert.ok(shiki.getShikiTokens('typescript', 'const bounded = 300;', surface));
  }
  releaseEditor();
  releasePreview();
  shiki.setShikiTheme(null, 'editor');
  shiki.setShikiTheme(null, 'preview');
  await drain();
}

async function mixedGrammarInstancesDoNotReuse(): Promise<void> {
  const palette = theme('mixed-grammar', 'dark');
  const code = 'const mixed = 1;';
  for (const mixedSurface of ['editor', 'preview'] as const) {
    shiki.setShikiTheme(palette, 'editor');
    shiki.setShikiTheme(palette, 'preview');
    const releaseEditor = shiki.activateShikiCodeHighlighting('editor');
    const releasePreview = shiki.activateShikiCodeHighlighting('preview');
    shiki.requestShikiTokens('sql', 'SELECT 1;', mixedSurface);
    await waitFor(() => !!shiki.getShikiTokens('sql', 'SELECT 1;', mixedSurface), 'mixed grammar');
    const before = tokenizeCount();
    shiki.requestShikiTokens('typescript', code, 'editor');
    await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'editor'), 'mixed donor');
    shiki.requestShikiTokens('typescript', code, 'preview');
    await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'preview'), 'mixed recipient');
    assert.equal(tokenizeCount(), before + 2, 'mixed grammar histories must remain independent');
    releaseEditor();
    releasePreview();
    shiki.setShikiTheme(null, 'editor');
    shiki.setShikiTheme(null, 'preview');
    await drain();
  }
}

async function failedSurfaceCanRetryWithoutBlockingItsPeer(): Promise<void> {
  const palette = theme('cross-surface-retry', 'dark');
  const code = 'const retrySurface = 1;';
  shiki.setShikiTheme(palette, 'editor');
  shiki.setShikiTheme(palette, 'preview');
  const releaseEditor = shiki.activateShikiCodeHighlighting('editor');
  const releasePreview = shiki.activateShikiCodeHighlighting('preview');
  planHighlighter({ loadFailures: 1 });
  const before = tokenizeCount();
  let failures = 0;
  const original = console.error;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes('Shiki tokenization failed')) failures++;
    else original(...args);
  };
  try {
    shiki.requestShikiTokens('typescript', code, 'editor');
    await waitFor(() => failures === 1, 'independent failure');
    shiki.requestShikiTokens('typescript', code, 'preview');
    await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'preview'), 'unblocked peer');
    shiki.requestShikiTokens('typescript', code, 'editor');
    await waitFor(() => !!shiki.getShikiTokens('typescript', code, 'editor'), 'retry with completed peer');
    assert.equal(tokenizeCount(), before + 1, 'a recovered grammar may reuse completed peer output');
    assert.equal(failures, 1);
  } finally {
    console.error = original;
    releaseEditor();
    releasePreview();
    shiki.setShikiTheme(null, 'editor');
    shiki.setShikiTheme(null, 'preview');
    await drain();
  }
}


const longCode = Array.from({ length: 410 }, (_, index) => 'const item' + index + ' = true;').join('\r\n');

async function batchesPublishAtomicallyAndYield(): Promise<void> {
  for (const surface of ['editor', 'preview'] as const) {
    let observedPending = false;
    planHighlighter({ onTokenize(instance) {
      if (instance.tokenizeCalls === 1) queueMicrotask(() => {
        observedPending = shiki.getShikiTokens('typescript', longCode, surface) === null;
      });
    } });
    shiki.setShikiTheme(theme('atomic-batches', 'dark'), surface);
    const release = shiki.activateShikiCodeHighlighting(surface);
    shiki.requestShikiTokens('typescript', longCode, surface);
    await waitFor(() => !!shiki.getShikiTokens('typescript', longCode, surface), 'atomic long block');
    assert.ok(observedPending, 'other queued work must run before the complete block is published');
    const lines = shiki.getShikiTokens('typescript', longCode, surface)!;
    assert.equal(lines.length, 410);
    for (const line of lines) {
      for (const syntaxToken of line) assert.equal(longCode.slice(syntaxToken.offset, syntaxToken.offset + syntaxToken.content.length), syntaxToken.content);
    }
    release();
    shiki.setShikiTheme(null, surface);
    await drain();
  }
}

async function suspendedBatchesCannotOutliveTheirGeneration(): Promise<void> {
  for (const surface of ['editor', 'preview'] as const) {
    for (const replacement of ['theme', 'release'] as const) {
      let old!: FakeHighlighter;
      let release!: () => void;
      planHighlighter({ onTokenize(instance) {
        old = instance;
        if (instance.tokenizeCalls === 1) queueMicrotask(() => {
          planHighlighter();
          if (replacement === 'theme') shiki.setShikiTheme(theme('new', 'light'), surface);
          else { release(); release(); release = shiki.activateShikiCodeHighlighting(surface); }
          shiki.requestShikiTokens('typescript', longCode, surface);
        });
      } });
      shiki.setShikiTheme(theme('old', 'dark'), surface);
      release = shiki.activateShikiCodeHighlighting(surface);
      shiki.requestShikiTokens('typescript', longCode, surface);
      await waitFor(() => !!shiki.getShikiTokens('typescript', longCode, surface), 'replacement long block');
      assert.equal(old.tokenizeCalls, 1, 'retired grammar must never resume a suspended batch');
      assert.equal(old.disposeCalls, 1);
      const expected = replacement === 'theme' ? '#101010' : '#f0f0f0';
      assert.ok(shiki.getShikiTokens('typescript', longCode, surface)!.every(line => line.every(t => t.color === expected)));
      release();
      shiki.setShikiTheme(null, surface);
      await drain();
    }
  }
}

async function suspendedBatchesRestartAfterGrammarChanges(): Promise<void> {
  let firstPasses = 0;
  let loaded = false;
  planHighlighter({ colorByGrammar: true, onTokenize(instance) {
    if (instance.tokenizeCalls === 1) queueMicrotask(() => {
      shiki.requestShikiTokens('sql', 'SELECT 1;');
      loaded = true;
    });
    if (instance.loadedLanguages.size === 1) firstPasses++;
  } });
  shiki.setShikiTheme(theme('mixed-batches', 'dark'));
  const release = shiki.activateShikiCodeHighlighting();
  shiki.requestShikiTokens('typescript', longCode);
  await waitFor(() => !!shiki.getShikiTokens('typescript', longCode), 'mixed grammar completed block');
  assert.ok(loaded && firstPasses > 0);
  assert.ok(shiki.getShikiTokens('typescript', longCode)!.every(line => line.every(t => t.fontStyle === 2)),
    'one completed block must not mix the grammar histories before and after a language load');
  release();
  shiki.setShikiTheme(null);
  await drain();
}

async function failedBatchCanRetry(): Promise<void> {
  const plan: FakePlan = { onTokenize(instance) {
    if (instance.tokenizeCalls === 1) queueMicrotask(() => { plan.tokenFailures = 1; });
  } };
  planHighlighter(plan);
  shiki.setShikiTheme(theme('batch-retry', 'dark'));
  const release = shiki.activateShikiCodeHighlighting();
  const original = console.error;
  let failures = 0;
  console.error = () => { failures++; };
  try {
    shiki.requestShikiTokens('typescript', longCode);
    await waitFor(() => failures === 1, 'failed later batch');
    assert.equal(shiki.getShikiTokens('typescript', longCode), null);
    shiki.requestShikiTokens('typescript', longCode);
    await waitFor(() => !!shiki.getShikiTokens('typescript', longCode), 'retry completed block');
    assert.equal(failures, 1);
  } finally {
    console.error = original;
    release();
    shiki.setShikiTheme(null);
    await drain();
  }
}


async function documentDemandControlsSuspendedWork(): Promise<void> {
  for (const surface of ['editor', 'preview'] as const) {
    for (const keepPeer of [false, true]) {
      let firstCurrent = true;
      let observedCancellation = false;
      let secondCurrent = keepPeer;
      let instance!: FakeHighlighter;
      planHighlighter({ onTokenize(current) {
        instance = current;
        if (current.tokenizeCalls === 1) queueMicrotask(() => { firstCurrent = false; });
      } });
      shiki.setShikiTheme(theme('request-demand', 'dark'), surface);
      const release = shiki.activateShikiCodeHighlighting(surface);
      shiki.requestShikiTokens('typescript', longCode, surface, () => { if (!firstCurrent) observedCancellation = true; return firstCurrent; });
      shiki.requestShikiTokens('typescript', longCode, surface, () => secondCurrent);
      await waitFor(() => !!instance, 'first requested batch');
      if (keepPeer) {
        await waitFor(() => !!shiki.getShikiTokens('typescript', longCode, surface), 'remaining current owner');
        assert.ok(instance.tokenizeCalls > 1, 'one retired owner must not cancel another owner of identical code');
      } else {
        await waitFor(() => observedCancellation, 'retired document demand');
        assert.equal(instance.tokenizeCalls, 1, 'an old document must stop before the next batch');
        assert.equal(shiki.getShikiTokens('typescript', longCode, surface), null);
        secondCurrent = true;
        shiki.requestShikiTokens('typescript', longCode, surface, () => secondCurrent);
        await waitFor(() => !!shiki.getShikiTokens('typescript', longCode, surface), 'same-key request after cancellation');
      }
      release();
      shiki.setShikiTheme(null, surface);
      await drain();
    }
  }
}


async function abortedCompletionCannotRemoveANewRequest(): Promise<void> {
  let current = true;
  let replacementQueued = false;
  planHighlighter({ onTokenize(instance) {
    if (instance.tokenizeCalls === 1) queueMicrotask(() => { current = false; });
  } });
  shiki.setShikiTheme(theme('same-key-handoff', 'dark'));
  const release = shiki.activateShikiCodeHighlighting();
  shiki.requestShikiTokens('typescript', longCode, 'editor', () => {
    if (!current && !replacementQueued) {
      replacementQueued = true;
      queueMicrotask(() => shiki.requestShikiTokens('typescript', longCode));
    }
    return current;
  });
  await waitFor(() => !!shiki.getShikiTokens('typescript', longCode), 'new same-key request before abort settlement');
  assert.ok(replacementQueued);
  release();
  shiki.setShikiTheme(null);
  await drain();
}


async function matchingLongSurfacesComputeOnce(): Promise<void> {
  for (const first of ['editor', 'preview'] as const) {
    const palette = theme('matching-long', 'dark');
    shiki.setShikiTheme(palette, 'editor');
    shiki.setShikiTheme(palette, 'preview');
    const releases = [shiki.activateShikiCodeHighlighting('editor'), shiki.activateShikiCodeHighlighting('preview')];
    const before = highlighters.length;
    shiki.requestShikiTokens('typescript', longCode, first);
    shiki.requestShikiTokens('typescript', longCode, first === 'editor' ? 'preview' : 'editor');
    await waitFor(() => !!shiki.getShikiTokens('typescript', longCode, 'editor')
      && !!shiki.getShikiTokens('typescript', longCode, 'preview'), 'matching long surfaces');
    assert.equal(highlighters.slice(before).filter(instance => instance.tokenizeCalls > 0).length, 1,
      'yielding must not duplicate a block previously shared by matching surfaces');
    assert.deepEqual(shiki.getShikiTokens('typescript', longCode, 'editor'), shiki.getShikiTokens('typescript', longCode, 'preview'));
    releases.forEach(release => release());
    shiki.setShikiTheme(null, 'editor');
    shiki.setShikiTheme(null, 'preview');
    await drain();
  }
}


async function readyQueueSurvivesDonorRetirementAndFailure(): Promise<void> {
  for (const first of ['editor', 'preview'] as const) {
    for (const outcome of ['release', 'theme', 'error'] as const) {
      const second = first === 'editor' ? 'preview' : 'editor';
      const palette = theme('queued-surfaces', 'dark');
      shiki.setShikiTheme(palette, first);
      shiki.setShikiTheme(palette, second);
      const releaseFirst = shiki.activateShikiCodeHighlighting(first);
      const releaseSecond = shiki.activateShikiCodeHighlighting(second);
      const plan: FakePlan = { onTokenize(instance) {
        if (instance.tokenizeCalls !== 1) return;
        queueMicrotask(() => {
          if (outcome === 'release') releaseFirst();
          else if (outcome === 'theme') shiki.setShikiTheme(theme('replacement', 'light'), first);
          else plan.tokenFailures = 1;
        });
      } };
      planHighlighter(plan);
      planHighlighter();
      const original = console.error;
      let errors = 0;
      console.error = () => { errors++; };
      try {
        shiki.requestShikiTokens('typescript', longCode, first);
        shiki.requestShikiTokens('typescript', longCode, second);
        await waitFor(() => !!shiki.getShikiTokens('typescript', longCode, second), 'queued independent recipient');
        assert.equal(shiki.getShikiTokens('typescript', longCode, first), null);
        assert.equal(errors, outcome === 'error' ? 1 : 0);
      } finally {
        console.error = original;
        releaseFirst();
        releaseSecond();
        shiki.setShikiTheme(null, first);
        shiki.setShikiTheme(null, second);
        await drain();
      }
    }
  }
}

await readyQueueSurvivesDonorRetirementAndFailure();
await matchingLongSurfacesComputeOnce();
await abortedCompletionCannotRemoveANewRequest();
await documentDemandControlsSuspendedWork();
await batchesPublishAtomicallyAndYield();
await suspendedBatchesCannotOutliveTheirGeneration();
await suspendedBatchesRestartAfterGrammarChanges();
await failedBatchCanRetry();

await failedSurfaceCanRetryWithoutBlockingItsPeer();await mixedGrammarInstancesDoNotReuse();await matchingSurfacesReuseCompletedTokens('editor');
await matchingSurfacesReuseCompletedTokens('preview');
await completedReuseKeepsIndependentLifetimes();
await reuseRequiresEveryTokenInputToMatch();
await pendingSurfacesRetireIndependently();
await reusedEntriesRemainBounded();
await completedBatchRefreshesOnce();
await sourceWithoutConsumerDoesNoHeavyWork();
await consumersShareOneInstanceUntilTheLastRelease();
await pendingInitializationDisposesWithoutPublishing();
await oldLanguageCompletionCannotPolluteReplacementTheme();
await languageFailureCanRetryOnTheSameInstance();
assert.equal(plannedHighlighters.length, 0, 'every planned external HighlighterCore should be consumed');

console.log('Shiki highlighter instance lifecycle checks passed');
