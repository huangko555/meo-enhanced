import MarkdownIt from 'markdown-it';
import type { CodeThemeDto } from '../protocol/hostConfigurationEvents';
import {
  projectShikiTokenLines,
  type ShikiBracketPalette,
  type ShikiPresentationToken
} from '../shared/shikiTokenPresentation';
import { normalizeFenceLanguage } from './fenceLanguage';

const THEME_NAME = 'meo-export-code-theme';
const MATH_FENCE_LANGUAGES = new Set(['latex', 'tex', 'math', 'katex']);
const PLAIN_TEXT_LANGUAGE_IDS = new Set(['text', 'plaintext', 'plain', 'txt']);
const DEFAULT_BRACKET_COLORS_DARK = ['#FFD700', '#DA70D6', '#179FFF'];
const DEFAULT_BRACKET_COLORS_LIGHT = ['#0431FA', '#319331', '#7B3814'];
const FONT_STYLE_ITALIC = 1;
const FONT_STYLE_BOLD = 2;
const FONT_STYLE_UNDERLINE = 4;

type LanguageLoader = () => Promise<{ default: unknown }>;
type LanguageRegistry = Readonly<{
  loaders: Readonly<Record<string, LanguageLoader>>;
  ids: ReadonlyMap<string, string>;
}>;

export type ExportCodeHighlighter = Readonly<{
  highlight(source: string, language: string): string;
  dispose(): void;
}>;

function resolveShikiLanguage(language: string, registry: LanguageRegistry): string | null {
  const normalized = normalizeFenceLanguage(language);
  if (!normalized || PLAIN_TEXT_LANGUAGE_IDS.has(normalized)) return null;
  return registry.ids.get(normalized) ?? null;
}

function collectLanguages(markdownText: string, registry: LanguageRegistry): string[] {
  const parser = new MarkdownIt();
  const languages = new Set<string>();
  for (const token of parser.parse(markdownText, {})) {
    if (token.type !== 'fence') continue;
    const language = normalizeFenceLanguage(token.info);
    if (language === 'mermaid' || MATH_FENCE_LANGUAGES.has(language)) continue;
    const resolved = resolveShikiLanguage(language, registry);
    if (resolved) languages.add(resolved);
  }
  return [...languages];
}

function toShikiTheme(theme: CodeThemeDto) {
  return {
    name: THEME_NAME,
    type: theme.type,
    colors: theme.colors ?? {},
    settings: theme.tokenColors as any[],
    fg: theme.colors?.['editor.foreground'],
    bg: theme.colors?.['editor.background']
  };
}

function bracketPalette(theme: CodeThemeDto): ShikiBracketPalette {
  const isTransparent = (value: string): boolean => /^#[0-9a-f]{6}00$/i.test(value) || value === '#00000000';
  let bracketColors = [1, 2, 3, 4, 5, 6]
    .map((index) => theme.colors[`editorBracketHighlight.foreground${index}`])
    .filter((value): value is string => typeof value === 'string' && !isTransparent(value));
  if (bracketColors.length === 0) {
    bracketColors = theme.type === 'light' ? DEFAULT_BRACKET_COLORS_LIGHT : DEFAULT_BRACKET_COLORS_DARK;
  }
  return {
    bracketColors,
    unexpectedBracket: theme.colors['editorBracketHighlight.unexpectedBracket.foreground'] || '#FF1212'
  };
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function safeTokenColor(value: string | undefined): string | undefined {
  return typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : undefined;
}

function renderRuns(lines: ReturnType<typeof projectShikiTokenLines>): string {
  return lines.map((line) => line.map((run) => {
    const styles: string[] = [];
    const color = safeTokenColor(run.color);
    if (color) styles.push(`color:${color}`);
    const fontStyle = run.fontStyle ?? 0;
    if (fontStyle & FONT_STYLE_ITALIC) styles.push('font-style:italic');
    if (fontStyle & FONT_STYLE_BOLD) styles.push('font-weight:bold');
    if (fontStyle & FONT_STYLE_UNDERLINE) styles.push('text-decoration:underline');
    const content = escapeHtml(run.content);
    return styles.length > 0 ? `<span style="${styles.join(';')}">${content}</span>` : content;
  }).join('')).join('\n');
}

export async function createExportCodeHighlighter(
  markdownText: string,
  theme: CodeThemeDto
): Promise<ExportCodeHighlighter> {
  const [{ createHighlighterCore }, { createOnigurumaEngine }, languages] = await Promise.all([
    import('shiki/core'),
    import('shiki/engine/oniguruma'),
    import('shiki/langs')
  ]);
  const languageIds = new Map<string, string>();
  for (const language of languages.bundledLanguagesInfo) {
    languageIds.set(language.id.toLowerCase(), language.id);
    for (const alias of language.aliases ?? []) languageIds.set(alias.toLowerCase(), language.id);
  }
  const registry: LanguageRegistry = {
    loaders: languages.bundledLanguages as unknown as Readonly<Record<string, LanguageLoader>>,
    ids: languageIds
  };
  const highlighter = await createHighlighterCore({
    themes: [toShikiTheme(theme) as any],
    langs: [],
    engine: await createOnigurumaEngine(import('shiki/wasm'))
  });
  for (const language of collectLanguages(markdownText, registry)) {
    const loader = registry.loaders[language];
    if (!loader) continue;
    await highlighter.loadLanguage((await loader()).default as any);
  }
  const brackets = bracketPalette(theme);

  return {
    highlight(source, language) {
      const resolvedLanguage = resolveShikiLanguage(language, registry);
      if (!resolvedLanguage || !highlighter.getLoadedLanguages().includes(resolvedLanguage)) {
        return escapeHtml(source);
      }
      const { tokens } = highlighter.codeToTokens(source, {
        lang: resolvedLanguage,
        theme: THEME_NAME,
        includeExplanation: 'scopeName'
      });
      const mapped: ShikiPresentationToken[][] = tokens.map((line) => line.map((syntaxToken) => {
        const scopeNames = tokenScopeNames(syntaxToken as any);
        return {
          content: syntaxToken.content,
          color: syntaxToken.color,
          fontStyle: syntaxToken.fontStyle,
          isStringComment: tokenIsStringComment(scopeNames)
        };
      }));
      return renderRuns(projectShikiTokenLines(mapped, brackets));
    },
    dispose() {
      highlighter.dispose();
    }
  };
}
