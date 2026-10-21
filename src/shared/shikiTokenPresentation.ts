export type ShikiPresentationToken = Readonly<{
  content: string;
  color?: string;
  fontStyle?: number;
  isStringComment?: boolean;
}>;

export type ShikiPresentationRun = Readonly<{
  content: string;
  color?: string;
  fontStyle?: number;
}>;

export type ShikiBracketPalette = Readonly<{
  bracketColors: readonly string[];
  unexpectedBracket: string;
}>;

/** A requested band retains preceding bracket depth without allocating runs
 * for the preceding lines. Omitting it produces the complete export/Live view. */
export function projectShikiTokenLines(
  lines: readonly (readonly ShikiPresentationToken[])[],
  bracketPalette: ShikiBracketPalette,
  range?: Readonly<{ from: number; to: number }>
): ShikiPresentationRun[][] {
  let bracketDepth = 0;
  const result: ShikiPresentationRun[][] = [];
  for (let lineIndex = 0; lineIndex < (range?.to ?? lines.length); lineIndex++) {
    const line = lines[lineIndex]!;
    const emit = lineIndex >= (range?.from ?? 0);
    const runs: ShikiPresentationRun[] = [];
    for (const syntaxToken of line) {
      let runStart = 0;
      for (let index = 0; index < syntaxToken.content.length; index += 1) {
        const character = syntaxToken.content[index];
        const opening = character === '(' || character === '[' || character === '{';
        const closing = character === ')' || character === ']' || character === '}';
        if ((!opening && !closing) || syntaxToken.isStringComment) continue;
        if (emit && index > runStart) {
          runs.push({
            content: syntaxToken.content.slice(runStart, index),
            color: syntaxToken.color,
            fontStyle: syntaxToken.fontStyle
          });
        }
        let color = bracketPalette.unexpectedBracket;
        if (opening) {
          color = bracketPalette.bracketColors[bracketDepth % bracketPalette.bracketColors.length] ?? syntaxToken.color;
          bracketDepth += 1;
        } else if (bracketDepth > 0) {
          bracketDepth -= 1;
          color = bracketPalette.bracketColors[bracketDepth % bracketPalette.bracketColors.length] ?? syntaxToken.color;
        }
        if (emit) runs.push({ content: character, color, fontStyle: syntaxToken.fontStyle });
        runStart = index + 1;
      }
      if (emit && runStart < syntaxToken.content.length) {
        runs.push({
          content: syntaxToken.content.slice(runStart),
          color: syntaxToken.color,
          fontStyle: syntaxToken.fontStyle
        });
      }
    }
    if (emit) result.push(runs);
  }
  return result;
}
