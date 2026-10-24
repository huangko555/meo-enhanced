export type RawCodeTheme = Readonly<{
  name: string;
  type: 'light' | 'dark';
  colors: Record<string, string>;
  tokenColors: unknown[];
  sourceColors?: Record<string, string>;
  sourceTokenColors?: unknown[];
}>;

export type PreviewCodePalette = Readonly<{
  foreground: string;
  comment: string;
  keyword: string;
  string: string;
  number: string;
  type: string;
  property: string;
  operator: string;
  punctuation: string;
  function: string;
  variable: string;
  link: string;
  bracket1?: string;
  bracket2?: string;
  bracket3?: string;
  unexpectedBracket?: string;
}>;

export type FinalCodePalette = Readonly<{
  theme: RawCodeTheme | null | undefined;
  sourceTheme: RawCodeTheme;
  sourceDocumentTheme?: RawCodeTheme;
  sourceTokens: Readonly<Record<string, string>>;
  sourceHeadingFontWeight: '400' | '700';
  preview: PreviewCodePalette;
}>;

type TokenColorRule = {
  readonly scope?: string | readonly string[];
  readonly settings?: { readonly foreground?: string; readonly fontStyle?: string };
};

const SOURCE_TOKEN_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  keyword: ['keyword', 'storage'],
  identifier: ['variable', 'identifier'],
  macroName: ['entity.name.function.preprocessor', 'support.function'],
  variableName: ['variable'],
  propertyName: ['variable.other.property', 'meta.object-literal.key', 'entity.other.attribute-name'],
  typeName: ['entity.name.type', 'support.type'],
  className: ['entity.name.class', 'support.class'],
  namespace: ['entity.name.namespace'],
  operator: ['keyword.operator'],
  operatorKeyword: ['keyword.operator', 'keyword'],
  punctuation: ['punctuation'],
  functionName: ['entity.name.function', 'support.function'],
  labelName: ['entity.name.label'],
  definitionFunction: ['entity.name.function'],
  definedVariable: ['variable.other.definition', 'variable'],
  number: ['constant.numeric'],
  changed: ['markup.changed'],
  annotation: ['storage.type.annotation', 'punctuation.definition.annotation'],
  modifier: ['storage.modifier'],
  self: ['variable.language.this', 'variable.language.self'],
  color: ['constant.other.color'],
  constant: ['constant'],
  atom: ['constant.language'],
  bool: ['constant.language.boolean'],
  specialVariable: ['variable.language'],
  specialString: ['string.other'],
  regexp: ['string.regexp'],
  string: ['string'],
  typeDefinition: ['entity.name.type', 'entity.name.class'],
  meta: ['meta'],
  comment: ['comment'],
  tagName: ['entity.name.tag'],
  attributeName: ['entity.other.attribute-name'],
  invalid: ['invalid'],
  deleted: ['markup.deleted'],
  monospace: ['markup.inline.raw'],
  heading: ['markup.heading'],
  emphasis: ['markup.italic'],
  strong: ['markup.bold'],
  strikethrough: ['markup.strikethrough'],
  quote: ['markup.quote'],
  contentSeparator: ['meta.separator', 'markup.separator'],
  listMarker: ['punctuation.definition.list.begin.markdown', 'markup.list'],
  taskMarker: ['meta.other.valid-bracket.markdown'],
  yamlListMarker: ['punctuation.definition.sequence.item.yaml'],
  link: ['markup.underline.link', 'string.other.link'],
  url: ['markup.underline.link', 'string.other.link'],
  processingInstruction: ['meta.preprocessor']
});

function isTokenColorRule(value: unknown): value is TokenColorRule {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as TokenColorRule;
  return typeof candidate.settings?.foreground === 'string'
    || typeof candidate.settings?.fontStyle === 'string';
}

function ruleScopes(rule: TokenColorRule): readonly string[] {
  const scopes = typeof rule.scope === 'string' ? [rule.scope] : rule.scope ?? [];
  return scopes.flatMap((scope) => scope.split(',').map((part) => part.trim()).filter(Boolean));
}

function matchesScope(ruleScope: string, requestedScope: string): boolean {
  return ruleScope === requestedScope
    || ruleScope.startsWith(`${requestedScope}.`)
    || requestedScope.startsWith(`${ruleScope}.`);
}

function resolveTokenColor(
  theme: RawCodeTheme | null | undefined,
  requestedScopes: readonly string[],
  fallback: string
): string {
  let resolved = fallback;
  for (const value of theme?.tokenColors ?? []) {
    if (!isTokenColorRule(value)) continue;
    if (ruleScopes(value).some((scope) => requestedScopes.some((requested) => matchesScope(scope, requested)))) {
      resolved = value.settings?.foreground ?? resolved;
    }
  }
  return resolved;
}

type MarkdownTokenStyle = { foreground: string; fontStyle: string };
const markdownScope = 'text.html.markdown';
const headingScopes = (level: number, mark = false) => [markdownScope, 'markup.heading.markdown',
  `heading.${level}.markdown`, mark ? 'punctuation.definition.heading.markdown' : 'entity.name.section.markdown'];

/** Match actual TextMate scope stacks rather than treating descendant rules as
 * interchangeable categories. Each inner scope inherits its parent's style;
 * specificity wins within that scope, with later rules breaking equal ties. */
function resolveMarkdownTokenStyle(theme: RawCodeTheme, stack: readonly string[], fallback = ''): MarkdownTokenStyle {
  const style: MarkdownTokenStyle = { foreground: fallback, fontStyle: '' };
  const containsScope = (scope: string, selector: string) => scope === selector || scope.startsWith(selector + '.');
  for (let index = 0; index < stack.length; index++) {
    const matches: { specificity: number[]; settings: NonNullable<TokenColorRule['settings']> }[] = [];
    for (const value of theme.tokenColors) {
      if (!isTokenColorRule(value)) continue;
      for (const selector of ruleScopes(value)) {
        const parts = selector.split(/\s+/).reverse();
        const leaf = parts.shift()!;
        if (!containsScope(stack[index]!, leaf)) continue;
        let ancestor = index - 1, matchesParents = true;
        for (let parent = 0; parent < parts.length; parent++) {
          const direct = parts[parent] === '>';
          const required = parts[direct ? ++parent : parent];
          if (!required) { matchesParents = false; break; }
          while (ancestor >= 0 && !containsScope(stack[ancestor]!, required) && !direct) ancestor--;
          if (ancestor < 0 || !containsScope(stack[ancestor]!, required)) { matchesParents = false; break; }
          ancestor--;
        }
        if (matchesParents) matches.push({ specificity: [leaf.split('.').length,
          ...parts.filter(part => part !== '>').map(part => part.length), parts.length], settings: value.settings! });
      }
    }
    matches.sort((a, b) => {
      for (let i = 0; i < Math.max(a.specificity.length, b.specificity.length); i++) {
        const difference = (a.specificity[i] ?? 0) - (b.specificity[i] ?? 0);
        if (difference) return difference;
      }
      return 0;
    });
    for (const { settings } of matches) {
      if (typeof settings.foreground === 'string') style.foreground = settings.foreground;
      if (typeof settings.fontStyle === 'string') style.fontStyle = settings.fontStyle;
    }
  }
  return style;
}

/** Fixed Markdown roles keep large Source documents on their viewport renderer.
 * This only projects the theme; it never tokenizes or scans document contents. */
export function resolveMarkdownStyles(theme: RawCodeTheme): Readonly<Record<string, MarkdownTokenStyle>> {
  const foreground = theme.colors['editor.foreground'] ?? (theme.type === 'light' ? '#000000' : '#d4d4d4');
  const linkScopes = [markdownScope, 'meta.paragraph.markdown', 'meta.link.inline.markdown'];
  return {
    heading: resolveMarkdownTokenStyle(theme, headingScopes(1), foreground),
    'heading-mark': resolveMarkdownTokenStyle(theme, headingScopes(1, true), foreground),
    setext: resolveMarkdownTokenStyle(theme, [markdownScope, 'meta.paragraph.markdown', 'markup.heading.setext.1.markdown'], foreground),
    link: resolveMarkdownTokenStyle(theme, [...linkScopes, 'string.other.link.title.markdown'], foreground),
    url: resolveMarkdownTokenStyle(theme, [...linkScopes, 'markup.underline.link.markdown'], foreground)
  };
}

/** Reading accents reuse the Source document rules, including user token overrides. */
export function resolveMarkdownContentColors(theme: RawCodeTheme): { heading: string; link: string } {
  return {
    heading: resolveMarkdownTokenStyle(theme, headingScopes(1)).foreground,
    link: resolveMarkdownTokenStyle(theme, [markdownScope, 'meta.paragraph.markdown', 'meta.link.inline.markdown', 'string.other.link.title.markdown']).foreground
      || resolveMarkdownTokenStyle(theme, [markdownScope, 'meta.paragraph.markdown', 'meta.link.inline.markdown', 'markup.underline.link.markdown']).foreground
  };
}

function hasUsableTokenPalette(
  theme: RawCodeTheme | null | undefined,
  appearance: 'light' | 'dark'
): theme is RawCodeTheme {
  return theme?.type === appearance && theme.tokenColors.length > 0;
}

export function resolveFinalCodePalette(
  currentVscodeTheme: RawCodeTheme | null | undefined,
  fallbackTheme: RawCodeTheme,
  appearance: 'light' | 'dark',
  sourceFallbackTheme: RawCodeTheme = fallbackTheme
): FinalCodePalette {
  // The host deliberately sends an empty theme when the active VS Code theme
  // cannot be resolved. Treating that shell as a real palette flattens every
  // code token to editor.foreground, so use the native bundled fallback instead.
  const theme = hasUsableTokenPalette(currentVscodeTheme, appearance)
    ? currentVscodeTheme
    : fallbackTheme;
  const sourceTheme = hasUsableTokenPalette(currentVscodeTheme, appearance)
    ? currentVscodeTheme
    : sourceFallbackTheme;
  const foreground = theme?.colors['editor.foreground'] ?? (appearance === 'light' ? '#24292f' : '#d4d4d4');
  const sourceForeground = sourceTheme?.colors['editor.foreground']
    ?? (appearance === 'light' ? '#24292f' : '#d4d4d4');
  const sourceHeading = resolveMarkdownTokenStyle(sourceTheme, headingScopes(1), sourceForeground);
  const sourceTokens = {
    foreground: sourceForeground,
    ...Object.fromEntries(Object.entries(SOURCE_TOKEN_SCOPES).map(([id, scopes]) => (
      [id, resolveTokenColor(sourceTheme, scopes, sourceForeground)]
    ))),
    heading: sourceHeading.foreground
  };
  const previewBracketFallbacks = appearance === 'light'
    ? ['#0431fa', '#319331', '#7b3814']
    : ['#ffd700', '#da70d6', '#179fff'];
  const previewThemeColors = theme?.colors ?? {};
  return Object.freeze({
    theme,
    sourceTheme,
    sourceTokens: Object.freeze(sourceTokens),
    sourceHeadingFontWeight: sourceHeading.fontStyle.split(/\s+/).includes('bold') ? '700' : '400',
    preview: Object.freeze({
      foreground,
      comment: resolveTokenColor(theme, ['comment'], foreground),
      keyword: resolveTokenColor(theme, ['keyword', 'storage'], foreground),
      string: resolveTokenColor(theme, ['string'], foreground),
      number: resolveTokenColor(theme, ['constant.numeric'], foreground),
      type: resolveTokenColor(theme, ['entity.name.type', 'entity.name.class', 'support.type'], foreground),
      property: resolveTokenColor(theme, ['variable.other.property', 'entity.other.attribute-name'], foreground),
      operator: resolveTokenColor(theme, ['keyword.operator'], foreground),
      punctuation: resolveTokenColor(theme, ['punctuation'], foreground),
      function: resolveTokenColor(theme, ['entity.name.function', 'support.function'], foreground),
      variable: resolveTokenColor(theme, ['variable'], foreground),
      link: resolveTokenColor(theme, ['markup.underline.link', 'string.other.link'], foreground),
      bracket1: previewThemeColors['editorBracketHighlight.foreground1'] ?? previewBracketFallbacks[0],
      bracket2: previewThemeColors['editorBracketHighlight.foreground2'] ?? previewBracketFallbacks[1],
      bracket3: previewThemeColors['editorBracketHighlight.foreground3'] ?? previewBracketFallbacks[2],
      unexpectedBracket: previewThemeColors['editorBracketHighlight.unexpectedBracket.foreground'] ?? '#ff1212'
    })
  });
}
