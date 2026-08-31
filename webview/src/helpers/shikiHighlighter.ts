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
  offset: number;
  content: string;
  color?: string;
  fontStyle?: number;
  isStringComment?: boolean;
  scopeNames?: readonly string[];
};

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
};

type ShikiRuntimeState = {
  rawTheme: RawVscodeTheme | null;
  themeMeta: ShikiThemeMeta;
  themeVersion: number;
  highlighterRecord: HighlighterRecord | null;
  tokenCache: Map<string, ShikiToken[][]>;
  pending: Map<string, number>;
  refreshListeners: Set<() => void>;
  activeHighlightConsumers: number;
  workGeneration: number;
};

function createRuntimeState(): ShikiRuntimeState {
  return {
    rawTheme: null,
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
    workGeneration: 0
  };
}

// Editor and Preview share language loaders, but not theme generations or
// token caches. Their appearance preferences can intentionally disagree.
const runtimeStates: Record<ShikiSurface, ShikiRuntimeState> = {
  editor: createRuntimeState(),
  preview: createRuntimeState()
};

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
      state.workGeneration += 1;
      state.pending.clear();
      state.tokenCache.clear();
      discardHighlighter(state);
    }
  };
}

function notifyRefresh(state: ShikiRuntimeState): void {
  for (const listener of state.refreshListeners) {
    listener();
  }
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
): ShikiToken[][] | null {
  const state = getRuntimeState(surface);
  return state.tokenCache.get(cacheKey(state, lang, code)) ?? null;
}

export function requestShikiTokens(
  lang: string,
  code: string,
  surface: ShikiSurface = 'editor'
): void {
  const state = getRuntimeState(surface);
  if (!state.rawTheme || state.activeHighlightConsumers === 0) {
    return;
  }
  const key = cacheKey(state, lang, code);
  if (state.tokenCache.has(key) || state.pending.has(key)) {
    return;
  }
  const generation = state.workGeneration;
  state.pending.set(key, generation);
  void tokenizeAndCache(state, key, lang, code, generation);
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

function getHighlighter(state: ShikiRuntimeState): HighlighterRecord | null {
  if (!state.rawTheme) {
    return null;
  }
  if (!state.highlighterRecord) {
    state.highlighterRecord = {
      generation: state.workGeneration,
      promise: createHighlighter(state.rawTheme),
      loadedLangs: new Set<string>()
    };
  }
  return state.highlighterRecord;
}

async function ensureLang(
  record: HighlighterRecord,
  highlighter: HighlighterCore,
  lang: string
): Promise<boolean> {
  if (record.loadedLangs.has(lang)) {
    return true;
  }
  const loader = LANG_LOADERS[lang];
  if (!loader) {
    return false;
  }
  const grammar = (await loader()).default;
  await highlighter.loadLanguage(grammar as any);
  record.loadedLangs.add(lang);
  return true;
}

async function tokenizeAndCache(
  state: ShikiRuntimeState,
  key: string,
  lang: string,
  code: string,
  generation: number
): Promise<void> {
  const isCurrent = (): boolean => (
    generation === state.workGeneration &&
    state.activeHighlightConsumers > 0 &&
    cacheKey(state, lang, code) === key
  );
  const finish = (): void => {
    if (state.pending.get(key) === generation) state.pending.delete(key);
  };
  try {
    const record = getHighlighter(state);
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
    if (!state.tokenCache.has(key)) {
      const { tokens } = highlighter.codeToTokens(code, {
        lang,
        theme: THEME_NAME,
        includeExplanation: 'scopeName'
      });
      const mapped: ShikiToken[][] = tokens.map((line) => line.map((syntaxToken) => {
        const scopeNames = tokenScopeNames(syntaxToken as any);
        return {
          offset: syntaxToken.offset,
          content: syntaxToken.content,
          color: syntaxToken.color,
          fontStyle: syntaxToken.fontStyle,
          isStringComment: tokenIsStringComment(scopeNames),
          scopeNames
        };
      }));
      if (state.tokenCache.size >= CACHE_LIMIT) {
        const oldest = state.tokenCache.keys().next().value;
        if (oldest !== undefined) {
          state.tokenCache.delete(oldest);
        }
      }
      state.tokenCache.set(key, mapped);
    }
    finish();
    notifyRefresh(state);
  } catch (error) {
    finish();
    if (isCurrent()) console.error('[MEO webview] Shiki tokenization failed', error);
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
    state.themeVersion += 1;
    state.workGeneration += 1;
    discardHighlighter(state);
    state.tokenCache.clear();
    state.pending.clear();
    notifyRefresh(state);
    return;
  }
  state.rawTheme = theme;
  state.themeMeta = computeThemeMeta(theme);
  state.themeVersion += 1;
  state.workGeneration += 1;
  discardHighlighter(state);
  state.tokenCache.clear();
  state.pending.clear();
  notifyRefresh(state);
}
