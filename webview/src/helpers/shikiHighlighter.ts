import type { HighlighterCore } from 'shiki/core';

export type RawVscodeTheme = {
  name: string;
  type: 'light' | 'dark';
  colors: Record<string, string>;
  tokenColors: unknown[];
};

const THEME_NAME = 'meo-code-theme';
const CACHE_LIMIT = 300;

const LANG_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  javascript: () => import('@shikijs/langs/javascript'),
  jsx: () => import('@shikijs/langs/jsx'),
  typescript: () => import('@shikijs/langs/typescript'),
  tsx: () => import('@shikijs/langs/tsx'),
  python: () => import('@shikijs/langs/python'),
  css: () => import('@shikijs/langs/css'),
  html: () => import('@shikijs/langs/html'),
  json: () => import('@shikijs/langs/json'),
  markdown: () => import('@shikijs/langs/markdown'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  sql: () => import('@shikijs/langs/sql'),
  csharp: () => import('@shikijs/langs/csharp'),
  cpp: () => import('@shikijs/langs/cpp'),
  c: () => import('@shikijs/langs/c'),
  swift: () => import('@shikijs/langs/swift'),
  bash: () => import('@shikijs/langs/bash'),
  powerquery: () => import('@shikijs/langs/powerquery'),
  yaml: () => import('@shikijs/langs/yaml')
};

const MEO_TO_SHIKI_LANG: Record<string, string> = {
  javascript: 'javascript', js: 'javascript',
  jsx: 'jsx',
  typescript: 'typescript', ts: 'typescript',
  tsx: 'tsx',
  python: 'python', py: 'python',
  css: 'css',
  html: 'html', htm: 'html',
  json: 'json',
  markdown: 'markdown', md: 'markdown',
  rust: 'rust', rs: 'rust',
  go: 'go', golang: 'go',
  java: 'java',
  sql: 'sql',
  csharp: 'csharp', cs: 'csharp', 'c#': 'csharp',
  cpp: 'cpp', 'c++': 'cpp',
  c: 'c',
  swift: 'swift',
  bash: 'bash', sh: 'bash', shell: 'bash', zsh: 'bash',
  powerquery: 'powerquery', pq: 'powerquery', m: 'powerquery',
  yaml: 'yaml', yml: 'yaml'
};

export function resolveShikiLang(info: string | null | undefined): string | null {
  if (!info) {
    return null;
  }
  return MEO_TO_SHIKI_LANG[info.toLowerCase().trim()] ?? null;
}

export type ShikiToken = {
  offset: number;
  content: string;
  color?: string;
  fontStyle?: number;
  isStringComment?: boolean;
};

export type ShikiThemeMeta = {
  bracketColors: string[];
  unexpectedBracket: string;
};

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

let themeMeta: ShikiThemeMeta = {
  bracketColors: DEFAULT_BRACKET_COLORS_DARK,
  unexpectedBracket: '#FF1212'
};

export function getShikiThemeMeta(): ShikiThemeMeta {
  return themeMeta;
}

let rawTheme: RawVscodeTheme | null = null;
let themeVersion = 0;
type HighlighterRecord = {
  readonly generation: number;
  readonly promise: Promise<HighlighterCore>;
  readonly loadedLangs: Set<string>;
};

let highlighterRecord: HighlighterRecord | null = null;
const tokenCache = new Map<string, ShikiToken[][]>();
const pending = new Map<string, number>();
const refreshListeners = new Set<() => void>();
let activeHighlightConsumers = 0;
let workGeneration = 0;

function discardHighlighter(): void {
  const discarded = highlighterRecord;
  highlighterRecord = null;
  if (discarded) {
    discarded.loadedLangs.clear();
    void discarded.promise.then((highlighter) => highlighter.dispose()).catch(() => undefined);
  }
}

export function activateShikiCodeHighlighting(): () => void {
  activeHighlightConsumers += 1;
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    activeHighlightConsumers = Math.max(0, activeHighlightConsumers - 1);
    if (activeHighlightConsumers === 0) {
      workGeneration += 1;
      pending.clear();
      tokenCache.clear();
      discardHighlighter();
    }
  };
}

function notifyRefresh(): void {
  for (const listener of refreshListeners) {
    listener();
  }
}

export function subscribeShikiRefresh(listener: () => void): () => void {
  refreshListeners.add(listener);
  return () => refreshListeners.delete(listener);
}

export function isShikiThemeReady(): boolean {
  return rawTheme !== null;
}

function cacheKey(lang: string, code: string): string {
  return `${themeVersion} ${lang} ${code}`;
}

export function getShikiTokens(lang: string, code: string): ShikiToken[][] | null {
  return tokenCache.get(cacheKey(lang, code)) ?? null;
}

export function requestShikiTokens(lang: string, code: string): void {
  if (!rawTheme || activeHighlightConsumers === 0) {
    return;
  }
  const key = cacheKey(lang, code);
  if (tokenCache.has(key) || pending.has(key)) {
    return;
  }
  const generation = workGeneration;
  pending.set(key, generation);
  void tokenizeAndCache(key, lang, code, generation);
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

function tokenIsStringComment(token: { explanation?: { scopes?: { scopeName?: string }[] }[] }): boolean {
  if (!token.explanation) {
    return false;
  }
  for (const part of token.explanation) {
    for (const scope of part.scopes ?? []) {
      const name = scope.scopeName ?? '';
      if (name.startsWith('string') || name.startsWith('comment')) {
        return true;
      }
    }
  }
  return false;
}

function getHighlighter(): HighlighterRecord | null {
  if (!rawTheme) {
    return null;
  }
  if (!highlighterRecord) {
    highlighterRecord = {
      generation: workGeneration,
      promise: createHighlighter(rawTheme),
      loadedLangs: new Set<string>()
    };
  }
  return highlighterRecord;
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
  key: string,
  lang: string,
  code: string,
  generation: number
): Promise<void> {
  const isCurrent = (): boolean => (
    generation === workGeneration && activeHighlightConsumers > 0 && cacheKey(lang, code) === key
  );
  const finish = (): void => {
    if (pending.get(key) === generation) pending.delete(key);
  };
  try {
    const record = getHighlighter();
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
    if (!tokenCache.has(key)) {
      const { tokens } = highlighter.codeToTokens(code, {
        lang,
        theme: THEME_NAME,
        includeExplanation: 'scopeName'
      });
      const mapped: ShikiToken[][] = tokens.map((line) =>
        line.map((token) => ({
          offset: token.offset,
          content: token.content,
          color: token.color,
          fontStyle: token.fontStyle,
          isStringComment: tokenIsStringComment(token as any)
        }))
      );
      if (tokenCache.size >= CACHE_LIMIT) {
        const oldest = tokenCache.keys().next().value;
        if (oldest !== undefined) {
          tokenCache.delete(oldest);
        }
      }
      tokenCache.set(key, mapped);
    }
    finish();
    notifyRefresh();
  } catch (error) {
    finish();
    if (isCurrent()) console.error('[MEO webview] Shiki tokenization failed', error);
  }
}

export function setShikiTheme(theme: RawVscodeTheme | null | undefined): void {
  if (!theme) {
    if (!rawTheme && !highlighterRecord && tokenCache.size === 0 && pending.size === 0) {
      return;
    }
    rawTheme = null;
    themeVersion += 1;
    workGeneration += 1;
    discardHighlighter();
    tokenCache.clear();
    pending.clear();
    notifyRefresh();
    return;
  }
  rawTheme = theme;
  themeMeta = computeThemeMeta(theme);
  themeVersion += 1;
  workGeneration += 1;
  discardHighlighter();
  tokenCache.clear();
  pending.clear();
  notifyRefresh();
}
