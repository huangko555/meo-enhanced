import type { HighlighterCore } from 'shiki/core';
import { bundledLanguages, bundledLanguagesInfo } from 'shiki/langs';

export type RawVscodeTheme = {
  name: string;
  type: 'light' | 'dark';
  colors: Record<string, string>;
  tokenColors: unknown[];
};

const THEME_NAME = 'meo-code-theme';
const CACHE_LIMIT = 300;

type LanguageLoader = () => Promise<{ default: unknown }>;

// Shiki's bundled registry is the single language capability source for every
// fenced-code surface. Keeping a hand-maintained subset here made valid VS Code
// languages silently fall through to Markdown's inline-code color.
const LANG_LOADERS = bundledLanguages as unknown as Readonly<Record<string, LanguageLoader>>;
const LANGUAGE_IDS = new Map<string, string>();
for (const language of bundledLanguagesInfo) {
  LANGUAGE_IDS.set(language.id.toLowerCase(), language.id);
  for (const alias of language.aliases ?? []) {
    LANGUAGE_IDS.set(alias.toLowerCase(), language.id);
  }
}

const PLAIN_TEXT_LANGUAGE_IDS = new Set(['text', 'plaintext', 'plain', 'txt']);

export function resolveShikiLang(info: string | null | undefined): string | null {
  if (!info) {
    return null;
  }
  const requested = info.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (!requested || PLAIN_TEXT_LANGUAGE_IDS.has(requested)) {
    return null;
  }
  return LANGUAGE_IDS.get(requested) ?? null;
}

export type ShikiToken = {
  readonly offset: number;
  readonly content: string;
  readonly color?: string;
  readonly fontStyle?: number;
  readonly isStringComment?: boolean;
  readonly scopeNames?: readonly string[];
};

type ShikiTokenLines = readonly (readonly ShikiToken[])[];

export type ShikiThemeMeta = {
  bracketColors: string[];
  unexpectedBracket: string;
};

export type ShikiSurface = 'editor' | 'preview';

const DEFAULT_BRACKET_COLORS_DARK = ['#FFD700', '#DA70D6', '#179FFF'];
const DEFAULT_BRACKET_COLORS_LIGHT = ['#0431FA', '#319331', '#7B3814'];

const isTransparent = (value: string): boolean => /^#[0-9a-fA-F]{6}00$/.test(value) || value === '#00000000';

function computeThemeMeta(theme: RawVscodeTheme): ShikiThemeMeta {
  const colors = theme.colors ?? {};
  let bracketColors = [1, 2, 3, 4, 5, 6]
    .map((i) => colors[`editorBracketHighlight.foreground${i}`])
    .filter((value): value is string => typeof value === 'string' && !isTransparent(value));
  if (!bracketColors.length) {
    bracketColors = theme.type === 'light' ? DEFAULT_BRACKET_COLORS_LIGHT : DEFAULT_BRACKET_COLORS_DARK;
  }
  return {
    bracketColors,
    unexpectedBracket: colors['editorBracketHighlight.unexpectedBracket.foreground'] || '#FF1212'
  };
}

type HighlighterRecord = {
  readonly generation: number;
  readonly promise: Promise<HighlighterCore>;
  readonly loadedLangs: Set<string>;
  reuseLanguage: string | null;
  grammarVersion: number;
};

type PendingHighlight = {
  readonly generation: number;
  readonly consumers: Set<() => boolean>;
};

const alwaysNeeded = () => true;

type ShikiRuntimeState = {
  rawTheme: RawVscodeTheme | null;
  tokenThemeKey: string | null;
  themeMeta: ShikiThemeMeta;
  themeVersion: number;
  highlighterRecord: HighlighterRecord | null;
  tokenCache: Map<string, ShikiTokenLines>;
  pending: Map<string, PendingHighlight>;
  refreshListeners: Set<() => void>;
  activeHighlightConsumers: number;
  workGeneration: number;
  refreshTimer: ReturnType<typeof setTimeout> | null;
};

function createRuntimeState(): ShikiRuntimeState {
  return {
    rawTheme: null,
    tokenThemeKey: null,
    themeMeta: {
      bracketColors: DEFAULT_BRACKET_COLORS_DARK,
      unexpectedBracket: '#FF1212'
    },
    themeVersion: 0,
    highlighterRecord: null,
    tokenCache: new Map(),
    pending: new Map(),
    refreshListeners: new Set(),
    activeHighlightConsumers: 0,
    workGeneration: 0,
    refreshTimer: null
  };
}

// Each surface owns its lifetime and theme generation. Completed, read-only
// tokens may be reused only when the full Shiki theme input also matches.
const runtimeStates: Record<ShikiSurface, ShikiRuntimeState> = {
  editor: createRuntimeState(),
  preview: createRuntimeState()
};

// Only ready token calculations share execution order. Initialization, grammar
// ownership and cancellation remain local to each surface and caller.
let activeTokenBatch: Promise<void> | null = null;

function getRuntimeState(surface: ShikiSurface): ShikiRuntimeState {
  return runtimeStates[surface];
}

export function getShikiThemeMeta(surface: ShikiSurface = 'editor'): ShikiThemeMeta {
  return getRuntimeState(surface).themeMeta;
}

/** Identifies the active token palette generation for DOM projection caches. */
export function getShikiThemeVersion(surface: ShikiSurface = 'editor'): number {
  return getRuntimeState(surface).themeVersion;
}

function discardHighlighter(state: ShikiRuntimeState): void {
  const discarded = state.highlighterRecord;
  state.highlighterRecord = null;
  if (discarded) {
    discarded.loadedLangs.clear();
    void discarded.promise.then((highlighter) => highlighter.dispose()).catch(() => undefined);
  }
}

export function activateShikiCodeHighlighting(surface: ShikiSurface = 'editor'): () => void {
  const state = getRuntimeState(surface);
  state.activeHighlightConsumers += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    state.activeHighlightConsumers = Math.max(0, state.activeHighlightConsumers - 1);
    if (state.activeHighlightConsumers === 0) {
      cancelRefresh(state);
      state.workGeneration += 1;
      state.pending.clear();
      state.tokenCache.clear();
      discardHighlighter(state);
    }
  };
}

function cancelRefresh(state: ShikiRuntimeState): void {
  if (state.refreshTimer !== null) clearTimeout(state.refreshTimer);
  state.refreshTimer = null;
}

function notifyRefresh(state: ShikiRuntimeState): void {
  cancelRefresh(state);
  for (const listener of state.refreshListeners) {
    listener();
  }
}

function scheduleTokenRefresh(state: ShikiRuntimeState): void {
  if (state.refreshTimer !== null) return;
  // Each consumer rebuilds its decorations on refresh. Publish a completed
  // batch together instead of rebuilding the document once per code block.
  state.refreshTimer = setTimeout(() => notifyRefresh(state), 0);
}

export function subscribeShikiRefresh(
  listener: () => void,
  surface: ShikiSurface = 'editor'
): () => void {
  const state = getRuntimeState(surface);
  state.refreshListeners.add(listener);
  return () => state.refreshListeners.delete(listener);
}

export function isShikiThemeReady(surface: ShikiSurface = 'editor'): boolean {
  return getRuntimeState(surface).rawTheme !== null;
}

function cacheKey(state: ShikiRuntimeState, lang: string, code: string): string {
  return `${state.themeVersion} ${lang} ${code}`;
}

export function getShikiTokens(
  lang: string,
  code: string,
  surface: ShikiSurface = 'editor'
): ShikiTokenLines | null {
  const state = getRuntimeState(surface);
  return state.tokenCache.get(cacheKey(state, lang, code)) ?? null;
}

/**
 * isNeeded is a cheap synchronous check of the caller's current document/lifetime.
 * Identical requests share work while at least one caller still needs the result.
 */
export function requestShikiTokens(
  lang: string,
  code: string,
  surface: ShikiSurface = 'editor',
  isNeeded: () => boolean = alwaysNeeded
): void {
  const state = getRuntimeState(surface);
  if (!state.rawTheme || state.activeHighlightConsumers === 0) {
    return;
  }
  const key = cacheKey(state, lang, code);
  if (state.tokenCache.has(key)) return;
  const pending = state.pending.get(key);
  if (pending) {
    pending.consumers.add(isNeeded);
    return;
  }
  const request: PendingHighlight = {
    generation: state.workGeneration,
    consumers: new Set([isNeeded])
  };
  state.pending.set(key, request);
  void tokenizeAndCache(state, key, lang, code, request);
}

function toShikiTheme(theme: RawVscodeTheme) {
  return {
    name: THEME_NAME,
    type: theme.type,
    colors: theme.colors ?? {},
    settings: (theme.tokenColors as any[]) ?? [],
    fg: theme.colors?.['editor.foreground'],
    bg: theme.colors?.['editor.background']
  };
}

async function createHighlighter(theme: RawVscodeTheme): Promise<HighlighterCore> {
  const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/oniguruma')
  ]);
  return createHighlighterCore({
    themes: [toShikiTheme(theme) as any],
    langs: [],
    engine: await createOnigurumaEngine(import('shiki/wasm'))
  });
}

function tokenScopeNames(syntaxToken: { explanation?: { scopes?: { scopeName?: string }[] }[] }): string[] {
  const names = new Set<string>();
  for (const part of syntaxToken.explanation ?? []) {
    for (const scope of part.scopes ?? []) {
      const name = scope.scopeName ?? '';
      if (name) names.add(name);
    }
  }
  return [...names];
}

function tokenIsStringComment(scopeNames: readonly string[]): boolean {
  return scopeNames.some((name) => name.startsWith('string') || name.startsWith('comment'));
}

function getHighlighter(state: ShikiRuntimeState, lang: string): HighlighterRecord | null {
  if (!state.rawTheme) {
    return null;
  }
  if (!state.highlighterRecord) {
    state.highlighterRecord = {
      generation: state.workGeneration,
      promise: createHighlighter(state.rawTheme),
      loadedLangs: new Set<string>(),
      reuseLanguage: lang,
      grammarVersion: 0
    };
  }
  return state.highlighterRecord;
}

async function ensureLang(
  record: HighlighterRecord,
  highlighter: HighlighterCore,
  lang: string
): Promise<boolean> {
  // Loading another bundle can change lazy embeddings and grammar injections.
  // Once mixed, keep this instance ineligible even if a language load fails.
  if (record.reuseLanguage !== lang) record.reuseLanguage = null;
  if (record.loadedLangs.has(lang)) {
    return true;
  }
  const loader = LANG_LOADERS[lang];
  if (!loader) {
    return false;
  }
  const grammar = (await loader()).default;
  record.grammarVersion += 1;
  await highlighter.loadLanguage(grammar as any);
  record.loadedLangs.add(lang);
  return true;
}

function getMatchingSurfaceTokens(
  state: ShikiRuntimeState,
  lang: string,
  code: string
): ShikiTokenLines | null {
  const other = state === runtimeStates.editor ? runtimeStates.preview : runtimeStates.editor;
  if (
    state.tokenThemeKey === null || state.tokenThemeKey !== other.tokenThemeKey
    || state.highlighterRecord?.reuseLanguage !== lang
    || other.highlighterRecord?.reuseLanguage !== lang
  ) return null;
  return other.tokenCache.get(cacheKey(other, lang, code)) ?? null;
}

function tokenizeInBatches(
  record: HighlighterRecord,
  highlighter: HighlighterCore,
  lang: string,
  code: string,
  isCurrent: () => boolean
): ShikiTokenLines | null | Promise<ShikiTokenLines | null> {
  const lines = /\r?\n/g;
  let start = 0;
  let grammarVersion = record.grammarVersion;
  let grammarState: ReturnType<HighlighterCore['codeToTokens']>['grammarState'];
  let mapped: ShikiToken[][] = [];
  const runBatch = (): ShikiTokenLines | null | Promise<ShikiTokenLines | null> => {
    if (!isCurrent()) return null;
    if (grammarVersion !== record.grammarVersion) {
      // A language loaded while we yielded may alter injections or embeddings.
      // Restart against that grammar registry instead of combining two histories.
      grammarVersion = record.grammarVersion;
      grammarState = undefined;
      mapped = [];
      start = lines.lastIndex = 0;
    }
    let boundary: RegExpExecArray | null = null;
    for (let line = 0; line < 128; line += 1) {
      boundary = lines.exec(code);
      if (!boundary) break;
    }
    const end = boundary ? boundary.index : code.length;
    const next = lines.lastIndex;
    const result = highlighter.codeToTokens(code.slice(start, end), {
      lang,
      theme: THEME_NAME,
      includeExplanation: 'scopeName',
      grammarState
    });
    grammarState = result.grammarState;
    for (const line of result.tokens) {
      mapped.push(line.map((syntaxToken) => {
        const scopeNames = tokenScopeNames(syntaxToken as any);
        return {
          offset: start + syntaxToken.offset,
          content: syntaxToken.content,
          color: syntaxToken.color,
          fontStyle: syntaxToken.fontStyle,
          isStringComment: tokenIsStringComment(scopeNames),
          scopeNames
        };
      }));
    }
    if (!boundary) return mapped;
    start = next;
    // Keep publication atomic while letting input run between full-line batches.
    // Microtasks alone would still block the browser for the entire code block.
    return new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
        channel.port1.close();
        channel.port2.close();
        resolve();
      };
      channel.port2.postMessage(null);
    }).then(runBatch);
  };
  return runBatch();
}

async function tokenizeAndCache(
  state: ShikiRuntimeState,
  key: string,
  lang: string,
  code: string,
  request: PendingHighlight
): Promise<void> {
  const { generation } = request;
  const finish = (): void => {
    if (state.pending.get(key) === request) state.pending.delete(key);
  };
  const isCurrent = (): boolean => {
    if (generation !== state.workGeneration || state.activeHighlightConsumers === 0
      || state.pending.get(key) !== request) return false;
    let needed = false;
    for (const consumer of request.consumers) {
      if (consumer()) needed = true;
      else request.consumers.delete(consumer);
    }
    return needed;
  };
  const continueBatch = (): boolean => {
    if (isCurrent()) return true;
    // Retire synchronously: a new request for this key can arrive before the
    // aborted promise settles and must not join work that already stopped.
    finish();
    return false;
  };
  try {
    const record = getHighlighter(state, lang);
    if (!record) {
      finish();
      return;
    }
    const highlighter = await record.promise;
    if (record.generation !== generation || !isCurrent()) {
      finish();
      return;
    }
    const ok = await ensureLang(record, highlighter, lang);
    if (!ok || !isCurrent()) {
      finish();
      return;
    }
    // Yielded work must finish (or retire) before another ready block starts.
    // Otherwise matching surfaces duplicate the calculation before either can
    // publish the complete tokens that the other surface is allowed to reuse.
    while (activeTokenBatch) {
      await activeTokenBatch;
      if (!isCurrent()) {
        finish();
        return;
      }
    }
    let mapped = getMatchingSurfaceTokens(state, lang, code);
    if (!mapped) {
      const tokenization = tokenizeInBatches(record, highlighter, lang, code, continueBatch);
      if (tokenization instanceof Promise) {
        const completion = tokenization.then(() => undefined, () => undefined);
        activeTokenBatch = completion;
        try {
          mapped = await tokenization;
        } finally {
          if (activeTokenBatch === completion) activeTokenBatch = null;
        }
      } else {
        mapped = tokenization;
      }
    }
    if (!mapped || !isCurrent()) {
      finish();
      return;
    }
    if (state.tokenCache.size >= CACHE_LIMIT) {
      const oldest = state.tokenCache.keys().next().value;
      if (oldest !== undefined) state.tokenCache.delete(oldest);
    }
    state.tokenCache.set(key, mapped);
    finish();
    scheduleTokenRefresh(state);
  } catch (error) {
    const current = isCurrent();
    finish();
    if (current) console.error('[MEO webview] Shiki tokenization failed', error);
  }
}

export function setShikiTheme(
  theme: RawVscodeTheme | null | undefined,
  surface: ShikiSurface = 'editor'
): void {
  const state = getRuntimeState(surface);
  if (!theme) {
    if (
      !state.rawTheme &&
      !state.highlighterRecord &&
      state.tokenCache.size === 0 &&
      state.pending.size === 0
    ) {
      return;
    }
    state.rawTheme = null;
    state.tokenThemeKey = null;
    state.themeVersion += 1;
    state.workGeneration += 1;
    discardHighlighter(state);
    state.tokenCache.clear();
    state.pending.clear();
    notifyRefresh(state);
    return;
  }
  state.rawTheme = theme;
  state.tokenThemeKey = JSON.stringify(toShikiTheme(theme));
  state.themeMeta = computeThemeMeta(theme);
  state.themeVersion += 1;
  state.workGeneration += 1;
  discardHighlighter(state);
  state.tokenCache.clear();
  state.pending.clear();
  notifyRefresh(state);
}
