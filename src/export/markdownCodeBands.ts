import { createHash } from 'node:crypto';
import type MarkdownIt from 'markdown-it';
import { DomUtils, parseDocument } from 'htmlparser2';
import { isTag, type Element } from 'domhandler';
import type { MarkdownTokenBlock } from './markdownPresentationBlocks';
import type { PreviewCodeSource } from '../foundation/previewDocument';

type SyntaxToken = ReturnType<MarkdownIt['parse']>[number];
export type CodeBand = { id: string; offset: number; digits: number; first: boolean; last: boolean; content: string; lines: number[] };
type Block = MarkdownTokenBlock & { code: CodeBand };
export const isMarkdownCodeBand = (block: MarkdownTokenBlock): block is Block => 'code' in block;

/** Independent top-level fences share one grammar context and bounded DOM bands. */
export function splitMarkdownCodeBands(tokens: readonly SyntaxToken[], blocks: readonly MarkdownTokenBlock[], sourceLines: readonly number[], language: (syntaxToken: SyntaxToken) => string | null) {
  const result: MarkdownTokenBlock[] = [], sources = new Map<string, PreviewCodeSource>();
  for (const block of blocks) {
    const syntaxToken = tokens[block.from]!, lang = block.to === block.from + 1 && syntaxToken.type === 'fence' ? language(syntaxToken) : null;
    const rows = lang !== null ? syntaxToken.content.replace(/\n$/, '').split('\n') : [];
    if (rows.length < 512) { result.push({ ...block, index: result.length }); continue; }
    const source = rows.join('\n');
    const id = createHash('sha256').update(lang! + '\0' + source).digest('hex');
    sources.set(id, { id, language: lang!, source });
    for (let offset = 0; offset < rows.length; offset += 32) {
      const part = rows.slice(offset, offset + 32), first = offset === 0, last = offset + part.length === rows.length;
      const lines = part.map((_, index) => sourceLines[syntaxToken.map![0] + 1 + offset + index] ?? block.sourceLine + 1 + offset + index);
      result.push({ ...block, index: result.length, kind: 'code_band',
        sourceLine: first ? block.sourceLine : lines[0]!, sourceEndLine: last ? block.sourceEndLine : lines.at(-1)!,
        sourceCharacters: part.join('\n').length,
        code: { id, offset, digits: Math.max(3, String(rows.length).length), first, last, content: part.join('\n') + (last && !syntaxToken.content.endsWith('\n') ? '' : '\n'), lines }
      } as Block);
    }
  }
  return { blocks: result, sources: [...sources.values()] };
}

export function renderCodeBandToken(tokens: readonly SyntaxToken[], block: Block): SyntaxToken[] {
  const original = tokens[block.from]!;
  const syntaxToken = Object.assign(Object.create(Object.getPrototypeOf(original)), original) as SyntaxToken;
  syntaxToken.attrs = original.attrs?.map(([key, value]) => [key, value]) ?? [];
  syntaxToken.attrSet('data-source-line', String(block.sourceLine));
  syntaxToken.attrSet('data-source-end-line', String(block.sourceEndLine));
  syntaxToken.content = block.code.content;
  syntaxToken.meta = { ...original.meta, meoCodeBand: block.code };
  return [syntaxToken];
}

/** Restore one semantic code block when a logical selection crosses DOM gaps. */
export function joinPreviewCodeBands(html: string): string {
  const document = parseDocument(html);
  let previous: { root: Element; code: Element; id: string } | undefined;
  for (const node of [...document.children]) {
    const id = isTag(node) ? node.attribs['data-meo-code-id'] : undefined;
    const code = id && isTag(node) ? DomUtils.findOne(child => child.name === 'code', node.children) : null;
    if (!id || !code || !isTag(node)) { previous = undefined; continue; }
    if (previous?.id === id && node.attribs['data-meo-code-part'] !== 'start') {
      for (const child of [...code.children]) DomUtils.appendChild(previous.code, child);
      DomUtils.removeElement(node);
    } else previous = { root: node, code, id };
    for (const name of ['data-meo-code-id', 'data-meo-code-offset', 'data-meo-code-part', 'data-meo-code-digits']) delete node.attribs[name];
  }
  return DomUtils.getOuterHTML(document.children);
}
