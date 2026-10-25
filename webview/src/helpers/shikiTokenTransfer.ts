import type { ShikiToken, ShikiTokenLines, ShikiTokenTransfer } from './shikiTypes';

/** Transfer numeric ranges without cloning an object tree with repeated scopes. */
type SyntaxToken = ShikiToken & { explanation?: readonly { scopes: readonly { scopeName: string }[] }[] };
export function packShikiTokens(lines: readonly (readonly SyntaxToken[])[]): ShikiTokenTransfer {
  const rows = new Uint32Array(lines.length + 1);
  const tokens = new Uint32Array(lines.reduce((count, line) => count + line.length, 0) * 4);
  const colors: string[] = [], palette = new Map<string, number>();
  let cursor = 0;
  lines.forEach((line, index) => {
    rows[index] = cursor;
    for (const syntaxToken of line) {
      let color = 0;
      if (syntaxToken.color !== undefined) {
        color = palette.get(syntaxToken.color) ?? colors.push(syntaxToken.color);
        palette.set(syntaxToken.color, color);
      }
      const stringComment = syntaxToken.isStringComment ?? syntaxToken.explanation?.some(part =>
        part.scopes.some(scope => /^(string|comment)/.test(scope.scopeName))) ?? false;
      tokens[cursor++] = syntaxToken.offset;
      tokens[cursor++] = syntaxToken.content.length;
      tokens[cursor++] = color;
      tokens[cursor++] = ((syntaxToken.fontStyle ?? 0) & 15) | (stringComment ? 16 : 0);
    }
  });
  rows[lines.length] = cursor;
  return { rows, tokens, colors };
}

/** Keep reconstruction interruptible, including a single exceptionally long line. */
export async function unpackShikiTokens(data: ShikiTokenTransfer, code: string, isNeeded: () => boolean): Promise<ShikiTokenLines | null> {
  const lines: ShikiToken[][] = [];
  let deadline = performance.now() + 4;
  for (let row = 0; row + 1 < data.rows.length; row++) {
    const line: ShikiToken[] = [];
    lines.push(line);
    for (let cursor = data.rows[row]!; cursor < data.rows[row + 1]!; cursor += 4) {
      if ((cursor & 1023) === 0 && performance.now() >= deadline) {
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (!isNeeded()) return null;
        deadline = performance.now() + 4;
      }
      const offset = data.tokens[cursor]!, flags = data.tokens[cursor + 3]!;
      line.push({ offset, content: code.slice(offset, offset + data.tokens[cursor + 1]!),
        color: data.colors[data.tokens[cursor + 2]! - 1], fontStyle: flags & 15, isStringComment: !!(flags & 16) });
    }
  }
  return isNeeded() ? lines : null;
}
