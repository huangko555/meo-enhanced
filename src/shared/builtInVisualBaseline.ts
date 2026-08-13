import { tags as t, type Tag } from '@lezer/highlight';

export const themeColorKeys = [
  'base01',
  'base02',
  'base03',
  'base04',
  'base05',
  'base06',
  'base07',
  'base08',
  'base09'
] as const;

export type ThemeColorKey = (typeof themeColorKeys)[number];
export type ThemeColors = Record<ThemeColorKey, string>;

export const semanticColorKeys = [
  'foreground',
  'mutedForeground',
  'background',
  'surfaceBackground',
  'insetBackground',
  'selectionBackground',
  'activeLineBackground',
  'caret',
  'codeBlockBackground',
  'codeBlockActiveLineBackground',
  'codeLanguageLabelForeground',
  'codeLanguageLabelBackground',
  'codeCopyForeground',
  'codeCopyBackground',
  'codeCopyHoverForeground',
  'codeCopyHoverBackground',
  'inlineCodeBackground',
  'markdownSyntax',
  'tagForeground',
  'tagBackground',
  'tagBorder',
  'headingForeground',
  'orderedListMarker',
  'unorderedListMarker',
  'listPrefix',
  'listGuide',
  'taskCheckboxBackground',
  'taskCheckboxBorder',
  'taskCheckboxBorderHover',
  'taskCheckboxCheck',
  'taskCheckboxDoneBackground',
  'taskCheckboxDoneBorder',
  'taskCheckboxDoneCheck',
  'taskCompleteForeground',
  'taskDroppedForeground',
  'blockquoteBorder',
  'blockquoteForeground',
  'horizontalRule',
  'tableBorder',
  'tableHeaderBackground',
  'tableSelectionBorder',
  'tableDelimiterForeground',
  'imageBackground',
  'imageBorder',
  'imageFallbackForeground',
  'linkForeground',
  'wikiLinkForeground',
  'footnoteForeground',
  'footnoteBackground',
  'kbdBackground',
  'kbdBorder',
  'frontmatterKey',
  'frontmatterValue',
  'frontmatterPillBackground',
  'searchMatchForeground',
  'searchMatchBackground',
  'searchMatchBorder',
  'searchMatchActiveForeground',
  'searchMatchActiveBackground',
  'searchMatchActiveBorder',
  'scrollbarThumb',
  'scrollbarThumbHover',
  'scrollbarThumbActive',
  'alertNoteForeground',
  'alertNoteBackground',
  'alertNoteBorder',
  'alertTipForeground',
  'alertTipBackground',
  'alertTipBorder',
  'alertImportantForeground',
  'alertImportantBackground',
  'alertImportantBorder',
  'alertWarningForeground',
  'alertWarningBackground',
  'alertWarningBorder',
  'alertCautionForeground',
  'alertCautionBackground',
  'alertCautionBorder'
] as const;

export type SemanticColorKey = (typeof semanticColorKeys)[number];
export type SemanticColors = Record<SemanticColorKey, string>;

export const defaultThemeLineHeight = 1.5;

export type ThemeFonts = {
  liveFont: string;
  sourceFont: string;
  liveFontWeight: string;
  sourceFontWeight: string;
  liveFontSize: number | null;
  sourceFontSize: number | null;
  h1FontSize: number | null;
  h2FontSize: number | null;
  h3FontSize: number | null;
  h4FontSize: number | null;
  h5FontSize: number | null;
  h6FontSize: number | null;
  h1FontWeight: string;
  h2FontWeight: string;
  h3FontWeight: string;
  h4FontWeight: string;
  h5FontWeight: string;
  h6FontWeight: string;
  liveLineHeight: number;
  sourceLineHeight: number;
};

export type SyntaxTokenStyleSpec = {
  id: string;
  tags: Tag | readonly Tag[];
  paletteKey: ThemeColorKey;
  style: {
    fontWeight?: 'normal' | 'bold' | 'bolder' | 'lighter' | string;
    fontStyle?: 'normal' | 'italic' | 'oblique' | string;
    textDecoration?: string;
    borderBottom?: string;
  };
};

export const SYNTAX_TAG_SPECS: readonly SyntaxTokenStyleSpec[] = [
  {
    id: 'keyword',
    tags: [t.keyword, t.controlKeyword, t.moduleKeyword],
    paletteKey: 'base04',
    style: { fontWeight: 'bold' }
  },
  {
    id: 'identifier',
    tags: [t.name, t.deleted, t.character],
    paletteKey: 'base05',
    style: {}
  },
  {
    id: 'macroName',
    tags: t.macroName,
    paletteKey: 'base06',
    style: { fontStyle: 'italic' }
  },
  {
    id: 'variableName',
    tags: t.variableName,
    paletteKey: 'base01',
    style: {}
  },
  {
    id: 'propertyName',
    tags: t.propertyName,
    paletteKey: 'base09',
    style: { fontStyle: 'normal' }
  },
  {
    id: 'typeName',
    tags: t.typeName,
    paletteKey: 'base06',
    style: {}
  },
  {
    id: 'className',
    tags: t.className,
    paletteKey: 'base09',
    style: {}
  },
  {
    id: 'namespace',
    tags: t.namespace,
    paletteKey: 'base05',
    style: {}
  },
  {
    id: 'operator',
    tags: t.operator,
    paletteKey: 'base01',
    style: {}
  },
  {
    id: 'operatorKeyword',
    tags: t.operatorKeyword,
    paletteKey: 'base04',
    style: {}
  },
  {
    id: 'punctuation',
    tags: [t.bracket, t.brace, t.punctuation, t.squareBracket, t.angleBracket],
    paletteKey: 'base01',
    style: {}
  },
  {
    id: 'functionName',
    tags: t.function(t.variableName),
    paletteKey: 'base06',
    style: {}
  },
  {
    id: 'labelName',
    tags: t.labelName,
    paletteKey: 'base02',
    style: {}
  },
  {
    id: 'definitionFunction',
    tags: t.definition(t.function(t.variableName)),
    paletteKey: 'base06',
    style: {}
  },
  {
    id: 'definedVariable',
    tags: t.definition(t.variableName),
    paletteKey: 'base05',
    style: {}
  },
  {
    id: 'number',
    tags: t.number,
    paletteKey: 'base08',
    style: {}
  },
  {
    id: 'changed',
    tags: t.changed,
    paletteKey: 'base08',
    style: {}
  },
  {
    id: 'annotation',
    tags: t.annotation,
    paletteKey: 'base04',
    style: { fontStyle: 'italic' }
  },
  {
    id: 'modifier',
    tags: t.modifier,
    paletteKey: 'base04',
    style: { fontStyle: 'italic' }
  },
  {
    id: 'self',
    tags: t.self,
    paletteKey: 'base04',
    style: { fontStyle: 'italic' }
  },
  {
    id: 'color',
    tags: t.color,
    paletteKey: 'base08',
    style: {}
  },
  {
    id: 'constant',
    tags: [t.constant(t.name), t.standard(t.name)],
    paletteKey: 'base08',
    style: {}
  },
  {
    id: 'atom',
    tags: t.atom,
    paletteKey: 'base05',
    style: {}
  },
  {
    id: 'bool',
    tags: t.bool,
    paletteKey: 'base08',
    style: {}
  },
  {
    id: 'specialVariable',
    tags: t.special(t.variableName),
    paletteKey: 'base08',
    style: {}
  },
  {
    id: 'specialString',
    tags: t.special(t.string),
    paletteKey: 'base07',
    style: {}
  },
  {
    id: 'regexp',
    tags: t.regexp,
    paletteKey: 'base07',
    style: {}
  },
  {
    id: 'string',
    tags: t.string,
    paletteKey: 'base07',
    style: {}
  },
  {
    id: 'typeDefinition',
    tags: t.definition(t.typeName),
    paletteKey: 'base06',
    style: { fontWeight: 'bold' }
  },
  {
    id: 'meta',
    tags: t.meta,
    paletteKey: 'base02',
    style: {}
  },
  {
    id: 'comment',
    tags: [t.comment, t.docComment],
    paletteKey: 'base02',
    style: { fontStyle: 'italic' }
  },
  {
    id: 'tagName',
    tags: t.tagName,
    paletteKey: 'base04',
    style: {}
  },
  {
    id: 'attributeName',
    tags: t.attributeName,
    paletteKey: 'base09',
    style: {}
  },
  {
    id: 'invalid',
    tags: t.invalid,
    paletteKey: 'base01',
    style: { textDecoration: 'underline wavy', borderBottom: '1px wavy #e06c75' }
  },
  {
    id: 'deleted',
    tags: t.deleted,
    paletteKey: 'base04',
    style: {}
  },
  {
    id: 'monospace',
    tags: t.monospace,
    paletteKey: 'base07',
    style: {}
  },
  {
    id: 'heading',
    tags: t.heading,
    paletteKey: 'base04',
    style: { fontWeight: '600' }
  },
  {
    id: 'emphasis',
    tags: t.emphasis,
    paletteKey: 'base01',
    style: { fontStyle: 'italic' }
  },
  {
    id: 'strong',
    tags: t.strong,
    paletteKey: 'base07',
    style: { fontWeight: '600' }
  },
  {
    id: 'strikethrough',
    tags: t.strikethrough,
    paletteKey: 'base01',
    style: { textDecoration: 'line-through' }
  },
  {
    id: 'quote',
    tags: t.quote,
    paletteKey: 'base07',
    style: {}
  },
  {
    id: 'contentSeparator',
    tags: t.contentSeparator,
    paletteKey: 'base02',
    style: {}
  },
  {
    id: 'link',
    tags: t.link,
    paletteKey: 'base05',
    style: {}
  },
  {
    id: 'url',
    tags: t.url,
    paletteKey: 'base05',
    style: {}
  },
  {
    id: 'processingInstruction',
    tags: t.processingInstruction,
    paletteKey: 'base02',
    style: {}
  }
] as const;

export type ThemeSyntaxTokenKey = (typeof SYNTAX_TAG_SPECS)[number]['id'];
export type ThemeSyntaxTokens = Record<ThemeSyntaxTokenKey, string>;
type ThemeSyntaxTokenPalette = Record<ThemeSyntaxTokenKey, ThemeColorKey>;

export type BuiltInVisualBaseline = {
  id: string;
  name: string;
  backgroundColor: string;
  colors: ThemeColors;
  semanticColors: SemanticColors;
  syntaxTokens: ThemeSyntaxTokens;
  fonts: ThemeFonts;
};

export const defaultThemeColors: ThemeColors = {
  base01: 'var(--vscode-editor-foreground)',
  base02: '#676f7d',
  base03: '#3e444d',
  base04: '#e06c75',
  base05: '#61afef',
  base06: '#66d9ef',
  base07: '#e5c07b',
  base08: '#c678dd',
  base09: '#98c379'
};

export const defaultThemeBackgroundColor = 'var(--vscode-editor-background)';
export const defaultCodeBlockBackgroundColor = '#1b1f23';

export const defaultSemanticColors: SemanticColors = {
  foreground: defaultThemeColors.base01,
  mutedForeground: defaultThemeColors.base02,
  background: defaultThemeBackgroundColor,
  surfaceBackground: 'color-mix(in srgb, var(--meo-background) 86%, var(--meo-color-base03) 14%)',
  insetBackground: 'color-mix(in srgb, var(--meo-background) 80%, var(--meo-color-base03) 20%)',
  selectionBackground: 'color-mix(in srgb, var(--meo-color-base05) 28%, transparent 72%)',
  activeLineBackground: 'color-mix(in srgb, var(--meo-color-base03) 35%, transparent 65%)',
  caret: defaultThemeColors.base01,
  codeBlockBackground: defaultCodeBlockBackgroundColor,
  codeBlockActiveLineBackground: 'color-mix(in srgb, var(--meo-background) 88%, var(--meo-color-base03) 12%)',
  codeLanguageLabelForeground: defaultThemeColors.base02,
  codeLanguageLabelBackground: 'transparent',
  codeCopyForeground: '#79b8ff',
  codeCopyBackground: 'transparent',
  codeCopyHoverForeground: '#79b8ff',
  codeCopyHoverBackground: 'var(--vscode-toolbar-hoverBackground)',
  inlineCodeBackground: '#2a3a52',
  markdownSyntax: '#8e999e',
  tagForeground: defaultThemeColors.base05,
  tagBackground: 'color-mix(in srgb, var(--meo-color-base05) 14%, transparent 86%)',
  tagBorder: 'color-mix(in srgb, var(--meo-color-base05) 38%, transparent 62%)',
  headingForeground: '#79b8ff',
  orderedListMarker: '#79b8ff',
  unorderedListMarker: '#79b8ff',
  listPrefix: defaultThemeColors.base02,
  listGuide: defaultThemeColors.base03,
  taskCheckboxBackground: 'var(--meo-surface-background)',
  taskCheckboxBorder: '#b4bbc0',
  taskCheckboxBorderHover: '#b4bbc0',
  taskCheckboxCheck: defaultThemeColors.base01,
  taskCheckboxDoneBackground: '#505862',
  taskCheckboxDoneBorder: '#505862',
  taskCheckboxDoneCheck: 'var(--meo-background)',
  taskCompleteForeground: defaultThemeColors.base02,
  taskDroppedForeground: defaultThemeColors.base02,
  blockquoteBorder: '#b4bbc0',
  blockquoteForeground: '#b4bbc0',
  horizontalRule: '#3e4246',
  tableBorder: '#474b50',
  tableHeaderBackground: 'var(--meo-inset-background)',
  tableSelectionBorder: defaultThemeColors.base05,
  tableDelimiterForeground: '#3e4246',
  imageBackground: 'var(--meo-code-background)',
  imageBorder: defaultThemeColors.base03,
  imageFallbackForeground: defaultThemeColors.base02,
  linkForeground: defaultThemeColors.base05,
  wikiLinkForeground: defaultThemeColors.base05,
  footnoteForeground: defaultThemeColors.base05,
  footnoteBackground: 'color-mix(in srgb, var(--meo-color-base05) 12%, transparent 88%)',
  kbdBackground: 'var(--meo-inset-background)',
  kbdBorder: defaultThemeColors.base03,
  frontmatterKey: defaultThemeColors.base07,
  frontmatterValue: defaultThemeColors.base01,
  frontmatterPillBackground: defaultThemeColors.base03,
  searchMatchForeground: 'var(--meo-background)',
  searchMatchBackground: '#ffe600',
  searchMatchBorder: '#ffe600',
  searchMatchActiveForeground: 'var(--meo-background)',
  searchMatchActiveBackground: '#ff8c00',
  searchMatchActiveBorder: '#ff8c00',
  scrollbarThumb: 'color-mix(in srgb, var(--meo-foreground) 38%, transparent)',
  scrollbarThumbHover: 'color-mix(in srgb, var(--meo-foreground) 50%, transparent)',
  scrollbarThumbActive: 'color-mix(in srgb, var(--meo-foreground) 62%, transparent)',
  alertNoteForeground: defaultThemeColors.base05,
  alertNoteBackground: 'color-mix(in srgb, var(--meo-semantic-alertNoteForeground) 8%, transparent)',
  alertNoteBorder: defaultThemeColors.base05,
  alertTipForeground: defaultThemeColors.base09,
  alertTipBackground: 'color-mix(in srgb, var(--meo-semantic-alertTipForeground) 8%, transparent)',
  alertTipBorder: defaultThemeColors.base09,
  alertImportantForeground: defaultThemeColors.base08,
  alertImportantBackground: 'color-mix(in srgb, var(--meo-semantic-alertImportantForeground) 8%, transparent)',
  alertImportantBorder: defaultThemeColors.base08,
  alertWarningForeground: defaultThemeColors.base07,
  alertWarningBackground: 'color-mix(in srgb, var(--meo-semantic-alertWarningForeground) 8%, transparent)',
  alertWarningBorder: defaultThemeColors.base07,
  alertCautionForeground: defaultThemeColors.base04,
  alertCautionBackground: 'color-mix(in srgb, var(--meo-semantic-alertCautionForeground) 8%, transparent)',
  alertCautionBorder: defaultThemeColors.base04
};

export const defaultThemeFonts: ThemeFonts = {
  liveFont: '',
  sourceFont: '',
  liveFontWeight: '',
  sourceFontWeight: '',
  liveFontSize: null,
  sourceFontSize: null,
  h1FontSize: 1.6,
  h2FontSize: 1.5,
  h3FontSize: 1.3,
  h4FontSize: 1.2,
  h5FontSize: 1.1,
  h6FontSize: 1,
  h1FontWeight: '400',
  h2FontWeight: '400',
  h3FontWeight: '400',
  h4FontWeight: '400',
  h5FontWeight: '400',
  h6FontWeight: '400',
  liveLineHeight: defaultThemeLineHeight,
  sourceLineHeight: defaultThemeLineHeight
};

const defaultSyntaxTokenPalette = SYNTAX_TAG_SPECS.reduce((acc, spec) => {
  acc[spec.id as ThemeSyntaxTokenKey] = spec.paletteKey;
  return acc;
}, {} as ThemeSyntaxTokenPalette);

const buildSyntaxTokenColors = (
  colors: ThemeColors,
  paletteOverrides: Partial<ThemeSyntaxTokenPalette> = {}
): ThemeSyntaxTokens => {
  const tokens = {} as ThemeSyntaxTokens;

  for (const tokenId of Object.keys(defaultSyntaxTokenPalette) as ThemeSyntaxTokenKey[]) {
    const paletteKey = paletteOverrides[tokenId] ?? defaultSyntaxTokenPalette[tokenId];
    tokens[tokenId] = colors[paletteKey];
  }

  return tokens;
};

const createThemeFromColors = (params: {
  id: string;
  name: string;
  backgroundColor?: string;
  colors?: Partial<ThemeColors>;
  syntaxTokenPaletteOverrides?: Partial<ThemeSyntaxTokenPalette>;
  syntaxTokenOverrides?: Partial<ThemeSyntaxTokens>;
  semanticColorOverrides?: Partial<SemanticColors>;
  fonts?: Partial<ThemeFonts>;
}): BuiltInVisualBaseline => {
  const colors = { ...defaultThemeColors, ...params.colors };

  return {
    id: params.id,
    name: params.name,
    backgroundColor: params.backgroundColor ?? defaultThemeBackgroundColor,
    colors,
    semanticColors: {
      ...defaultSemanticColors,
      foreground: colors.base01,
      mutedForeground: colors.base02,
      background: params.backgroundColor ?? defaultThemeBackgroundColor,
      caret: colors.base01,
      tagForeground: colors.base05,
      markdownSyntax: '#8e999e',
      headingForeground: '#79b8ff',
      codeLanguageLabelForeground: colors.base02,
      codeCopyForeground: '#79b8ff',
      codeCopyHoverForeground: '#79b8ff',
      codeBlockBackground: defaultCodeBlockBackgroundColor,
      inlineCodeBackground: '#2a3a52',
      orderedListMarker: '#79b8ff',
      unorderedListMarker: '#79b8ff',
      listPrefix: colors.base02,
      listGuide: colors.base03,
      taskCheckboxBorder: '#b4bbc0',
      taskCheckboxBorderHover: '#b4bbc0',
      taskCheckboxCheck: colors.base01,
      taskCheckboxDoneBackground: '#505862',
      taskCheckboxDoneBorder: '#505862',
      taskCheckboxDoneCheck: 'var(--meo-background)',
      taskCompleteForeground: colors.base02,
      taskDroppedForeground: colors.base02,
      blockquoteBorder: '#b4bbc0',
      blockquoteForeground: '#b4bbc0',
      horizontalRule: '#3e4246',
      tableBorder: '#474b50',
      tableDelimiterForeground: '#3e4246',
      tableSelectionBorder: colors.base05,
      imageBorder: colors.base03,
      imageFallbackForeground: colors.base02,
      linkForeground: colors.base05,
      wikiLinkForeground: colors.base05,
      footnoteForeground: colors.base05,
      kbdBorder: colors.base03,
      frontmatterKey: colors.base07,
      frontmatterValue: colors.base01,
      frontmatterPillBackground: colors.base03,
      alertNoteForeground: colors.base05,
      alertNoteBorder: colors.base05,
      alertTipForeground: colors.base09,
      alertTipBorder: colors.base09,
      alertImportantForeground: colors.base08,
      alertImportantBorder: colors.base08,
      alertWarningForeground: colors.base07,
      alertWarningBorder: colors.base07,
      alertCautionForeground: colors.base04,
      alertCautionBorder: colors.base04,
      ...(params.semanticColorOverrides ?? {})
    },
    syntaxTokens: {
      ...buildSyntaxTokenColors(colors, params.syntaxTokenPaletteOverrides),
      ...(params.syntaxTokenOverrides ?? {})
    } as ThemeSyntaxTokens,
    fonts: { ...defaultThemeFonts, ...(params.fonts ?? {}) }
  };
};

export const defaultBuiltInVisualBaseline: BuiltInVisualBaseline = createThemeFromColors({
    id: 'hkk',
    name: 'HKK (default)',
  });

export const lightBuiltInVisualBaseline: BuiltInVisualBaseline = createThemeFromColors({
    id: 'github-light',
    name: 'GitHub Light',
    backgroundColor: '#ffffff',
    colors: {
      base01: '#24292f',
      base02: '#57606a',
      base03: '#d0d7de',
      base04: '#cf222e',
      base05: '#0969da',
      base06: '#1a7f37',
      base07: '#9a6700',
      base08: '#8250df',
      base09: '#116329'
    },
    syntaxTokenPaletteOverrides: {
      string: 'base09',
      comment: 'base02',
      quote: 'base02'
    },
    semanticColorOverrides: {
      codeBlockBackground: '#f6f8fa',
      codeBlockActiveLineBackground: '#eef1f4',
      codeLanguageLabelForeground: '#57606a',
      codeCopyForeground: '#0969da',
      codeCopyHoverForeground: '#0969da',
      inlineCodeBackground: '#eff1f3',
      markdownSyntax: '#57606a',
      headingForeground: '#0969da',
      orderedListMarker: '#0969da',
      unorderedListMarker: '#0969da',
      taskCheckboxBorder: '#8c959f',
      taskCheckboxBorderHover: '#57606a',
      taskCheckboxDoneBackground: '#8c959f',
      taskCheckboxDoneBorder: '#8c959f',
      taskCheckboxDoneCheck: '#ffffff',
      blockquoteBorder: '#8c959f',
      blockquoteForeground: '#57606a',
      horizontalRule: '#d0d7de',
      tableBorder: '#d0d7de',
      tableDelimiterForeground: '#8c959f',
      imageBorder: '#d0d7de',
      imageFallbackForeground: '#57606a',
      kbdBorder: '#d0d7de',
      frontmatterPillBackground: '#d0d7de'
    }
  });
