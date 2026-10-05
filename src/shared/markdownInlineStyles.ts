// Default dark emphasis adds brightness; optional semantic coloring owns its separate palette.
export const darkDefaultStrongForeground = 'color-mix(in srgb, currentColor 88%, #fff 12%)';

/** Shared content styles. Surface adapters supply selectors, never independent style values. */
export const markdownInlineStyles = {
  emphasis: { fontStyle: 'italic' },
  strong: { fontWeight: '700' },
  strikethrough: { textDecoration: 'line-through !important' },
  subscript: { fontSize: '0.75em', lineHeight: '0', verticalAlign: 'sub' },
  superscript: { fontSize: '0.75em', lineHeight: '0', verticalAlign: 'super' }
} as const;

type InlineStyleSelectors = Readonly<Record<keyof typeof markdownInlineStyles, string>>;

export function buildMarkdownInlineStyleCss(selectors: InlineStyleSelectors): string {
  return (Object.keys(markdownInlineStyles) as Array<keyof typeof markdownInlineStyles>).map((kind) => {
    const declarations = Object.entries(markdownInlineStyles[kind]).map(([property, value]) => (
      `${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}: ${value};`
    )).join(' ');
    return `${selectors[kind]} { ${declarations} }`;
  }).join('\n');
}
