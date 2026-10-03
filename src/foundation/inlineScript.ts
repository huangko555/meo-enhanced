export type InlineScriptKind = 'subscript' | 'superscript';

export type InlineScriptMatch = Readonly<{
  kind: InlineScriptKind;
  to: number;
  content: string;
  escapes: ReadonlyArray<Readonly<{ from: number; to: number }>>;
}>;

/** Pandoc-style single-marker scripts: whitespace must be escaped; content is literal text. */
export function matchInlineScript(text: string, from: number, end = text.length): InlineScriptMatch | null {
  const marker = text[from];
  if ((marker !== '~' && marker !== '^') || text[from + 1] === marker) return null;
  const escapes: Array<{ from: number; to: number }> = [];
  for (let index = from + 1; index < end; index += 1) {
    const char = text[index];
    if (char === marker) {
      return {
        kind: marker === '~' ? 'subscript' : 'superscript',
        to: index + 1,
        content: text.slice(from + 1, index).replace(/\\([\s\S])/g, '$1'),
        escapes
      };
    }
    // An unresolved [^reference] must not pair its caret with the next reference.
    if (marker === '^' && text[from - 1] === '[' && char === ']') return null;
    if (char === '\\') {
      escapes.push({ from: index, to: index + 2 });
      index += 1;
    } else if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      return null;
    }
  }
  return null;
}
