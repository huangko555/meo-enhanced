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

export function projectShikiTokenLines(
  lines: readonly (readonly ShikiPresentationToken[])[],
  bracketPalette: ShikiBracketPalette
): ShikiPresentationRun[][] {
  let bracketDepth = 0;
  return lines.map((line) => {
    const runs: ShikiPresentationRun[] = [];
    for (const syntaxToken of line) {
      let runStart = 0;
      for (let index = 0; index < syntaxToken.content.length; index += 1) {
        const character = syntaxToken.content[index];
        const opening = character === '(' || character === '[' || character === '{';
        const closing = character === ')' || character === ']' || character === '}';
        if ((!opening && !closing) || syntaxToken.isStringComment) continue;
        if (index > runStart) {
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
        runs.push({ content: character, color, fontStyle: syntaxToken.fontStyle });
        runStart = index + 1;
      }
      if (runStart < syntaxToken.content.length) {
        runs.push({
          content: syntaxToken.content.slice(runStart),
          color: syntaxToken.color,
          fontStyle: syntaxToken.fontStyle
        });
      }
    }
    return runs;
  });
}
