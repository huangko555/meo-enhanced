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
}>;

export type FinalCodePalette = Readonly<{
  theme: RawCodeTheme | null | undefined;
  sourceTokens: Readonly<Record<string, string>>;
  preview: PreviewCodePalette;
}>;

type TokenColorRule = {
  readonly scope?: string | readonly string[];
  readonly settings?: { readonly foreground?: string };
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
  link: ['markup.underline.link', 'string.other.link'],
  url: ['markup.underline.link', 'string.other.link'],
  processingInstruction: ['meta.preprocessor']
});

function isTokenColorRule(value: unknown): value is TokenColorRule {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as TokenColorRule;
  return typeof candidate.settings?.foreground === 'string';
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

export function resolveFinalCodePalette(
  currentVscodeTheme: RawCodeTheme | null | undefined,
  fallbackTheme: RawCodeTheme,
  appearance: 'light' | 'dark'
): FinalCodePalette {
  const theme = currentVscodeTheme?.type === appearance
    ? currentVscodeTheme
    : fallbackTheme;
  const foreground = theme?.colors['editor.foreground'] ?? (appearance === 'light' ? '#24292f' : '#d4d4d4');
  const sourceTokens = Object.fromEntries(Object.entries(SOURCE_TOKEN_SCOPES).map(([id, scopes]) => (
    [id, resolveTokenColor(theme, scopes, foreground)]
  )));
  return Object.freeze({
    theme,
    sourceTokens: Object.freeze(sourceTokens),
    preview: Object.freeze({
      foreground,
      comment: resolveTokenColor(theme, ['comment'], foreground),
      keyword: resolveTokenColor(theme, ['keyword', 'storage'], foreground),
      string: resolveTokenColor(theme, ['string'], foreground),
      number: resolveTokenColor(theme, ['constant.numeric'], foreground),
      type: resolveTokenColor(theme, ['entity.name.type', 'entity.name.class', 'support.type'], foreground),
      property: resolveTokenColor(theme, ['variable.other.property', 'entity.other.attribute-name'], foreground),
      operator: sourceTokens.operator,
      punctuation: sourceTokens.punctuation,
      function: sourceTokens.functionName,
      variable: sourceTokens.variableName,
      link: resolveTokenColor(theme, ['markup.underline.link', 'string.other.link'], foreground)
    })
  });
}
