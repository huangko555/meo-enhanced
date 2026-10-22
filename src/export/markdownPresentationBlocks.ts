import type MarkdownIt from 'markdown-it';
import { Parser } from 'htmlparser2';
import type { PreviewDocumentBlock } from '../foundation/previewDocument';

type MarkdownNode = ReturnType<MarkdownIt['parse']>[number];

export type MarkdownPresentationBlock = PreviewDocumentBlock;

export type MarkdownTokenBlock = MarkdownPresentationBlock & Readonly<{ from: number; to: number }>;

/** Partition parsed roots, preserving raw HTML containers that span Markdown roots. */
export function markdownPresentationBlocks(tokens: readonly MarkdownNode[], sourceLines: readonly number[],
  prepareInline?: (index: number) => void
): MarkdownTokenBlock[] {
  const blocks: MarkdownTokenBlock[] = [];
  let from = 0, depth = 0, htmlDepth = 0, htmlCharacters = 0, htmlEnd = -1;
  const settled = () => { htmlEnd = html.endIndex; };
  const html = new Parser({
    onopentag: () => { htmlDepth += 1; settled(); },
    onclosetag: (_name, implied) => { htmlDepth -= 1; if (!implied) settled(); },
    ontext: settled, oncommentend: settled, onprocessinginstruction: settled, oncdataend: settled
  });
  const writeHtml = (source: string) => { htmlCharacters += source.length; html.write(source); };
  const add = (to: number) => {
    let sourceLine = Infinity, sourceEndLine = 0, sourceCharacters = 0;
    for (let index = from; index < to; index += 1) {
      const node = tokens[index]!;
      if (node.map) {
        sourceLine = Math.min(sourceLine, sourceLines[node.map[0]] ?? node.map[0] + 1);
        sourceEndLine = Math.max(sourceEndLine, sourceLines[Math.max(node.map[0], node.map[1] - 1)] ?? node.map[1]);
      }
      sourceCharacters += node.content.length;
    }
    blocks.push({ index: blocks.length, from, to, kind: tokens[from]?.type ?? 'empty',
      sourceLine: Number.isFinite(sourceLine) ? sourceLine : 1,
      sourceEndLine: Math.max(Number.isFinite(sourceLine) ? sourceLine : 1, sourceEndLine), sourceCharacters });
    from = to;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const node = tokens[index]!;
    depth += node.nesting;
    if (node.type === 'html_block') writeHtml(node.content);
    // Even a generated balanced link can complete an earlier unfinished HTML
    // attribute. Ask the existing lazy inline owner for children while this
    // parser owns an open container or incomplete token; no second HTML parser.
    if (node.type === 'inline' && node.content.includes('<') && (htmlDepth !== 0 || htmlEnd + 1 < htmlCharacters)) prepareInline?.(index);
    if (node.type === 'inline') for (const child of node.children ?? []) {
      if (child.type === 'html_inline' && !child.meta?.meoTrustedHtml) writeHtml(child.content);
    }
    if (depth === 0 && htmlDepth === 0) add(index + 1);
  }
  if (from < tokens.length) add(tokens.length);
  html.end();
  return blocks;
}
