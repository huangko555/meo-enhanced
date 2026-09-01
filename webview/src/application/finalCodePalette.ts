export type RawCodeTheme = Readonly<{
  name: string;
  type: 'light' | 'dark';
  colors: Record<string, string>;
  tokenColors: unknown[];
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

function resolveHeadingFontWeight(theme: RawCodeTheme | null | undefined): '400' | '700' {
  let resolved: '400' | '700' = '400';
  for (const value of theme?.tokenColors ?? []) {
    if (!isTokenColorRule(value) || typeof value.settings?.fontStyle !== 'string') continue;
    if (!ruleScopes(value).some((scope) => matchesScope(scope, 'markup.heading'))) continue;
    resolved = value.settings.fontStyle.split(/\s+/).includes('bold') ? '700' : '400';
  }
  return resolved;
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
  const sourceTokens = {
    foreground: sourceForeground,
    ...Object.fromEntries(Object.entries(SOURCE_TOKEN_SCOPES).map(([id, scopes]) => (
      [id, resolveTokenColor(sourceTheme, scopes, sourceForeground)]
    )))
  };
  const previewBracketFallbacks = appearance === 'light'
    ? ['#0431fa', '#319331', '#7b3814']
    : ['#ffd700', '#da70d6', '#179fff'];
  const previewThemeColors = theme?.colors ?? {};
  return Object.freeze({
    theme,
    sourceTheme,
    sourceTokens: Object.freeze(sourceTokens),
    sourceHeadingFontWeight: resolveHeadingFontWeight(sourceTheme),
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
