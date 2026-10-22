import { DomUtils, Parser, parseDocument } from 'htmlparser2';
import { isTag, isText, type ChildNode } from 'domhandler';
import { preparePreviewDocument, type PreviewDocumentOptions } from './runtime';
import type { PreviewDocumentChunk, PreviewDocumentManifest, PreviewDocumentOperation,
  PreviewDocumentResult, PreviewDocumentMatch } from '../foundation/previewDocument';
import { previewBlockAtLine } from '../foundation/previewDocument';
import { getPreviewPreset } from '../foundation/previewPresets';
import { joinPreviewTableBands } from './markdownTableBands';

type TextPart = { text: string; lower: string; line: number; offset: number; fixedLine?: boolean };

/** Same text-node and source-line semantics as the complete-DOM Preview search. */
function previewTextParts(html: string): TextPart[] {
  type Mapping = { line: number; lines: number; pre: boolean; row?: boolean };
  const stack: { mapping: Mapping; excluded: boolean }[] = [];
  const fallback: Mapping = { line: 1, lines: 0, pre: false };
  let pending = '', offset = 0;
  const parts: TextPart[] = [];
  const flush = () => {
    if (!pending) return;
    const mapping = stack.at(-1)?.mapping ?? fallback;
    parts.push({ text: pending, lower: pending.toLocaleLowerCase(), offset,
      line: mapping.line + (mapping.row ? 0 : mapping.lines) + (mapping.pre ? 1 : 0), fixedLine: mapping.row });
    if (mapping !== fallback) mapping.lines += (pending.match(/\n/g) ?? []).length;
    offset += pending.length;
    pending = '';
  };
  new Parser({
    onopentag(name, attributes) {
      flush();
      const parent = stack.at(-1);
      const line = Number(attributes['data-source-line']);
      stack.push({ mapping: Number.isFinite(line) && line > 0
        ? { line, lines: 0, row: name === 'tr', pre: name === 'pre' && !(attributes.class ?? '').includes('meo-export-frontmatter-source') }
        : parent?.mapping ?? fallback,
      excluded: parent?.excluded === true || ['script', 'style', 'noscript', 'svg'].includes(name) });
    },
    onclosetag() { flush(); stack.pop(); },
    ontext(text) { if (!stack.at(-1)?.excluded) pending += text; }
  }).end(html);
  flush();
  return parts;
}

function slicePreviewHtml(html: string, from: number, to: number): { html: string; text: string } {
  const document = parseDocument(html);
  let offset = 0;
  const slice = (node: ChildNode, excluded = false): ChildNode | null => {
    const skip = excluded || isTag(node) && ['script', 'style', 'noscript', 'svg'].includes(node.name);
    if (isText(node)) {
      if (skip) return null;
      const start = offset;
      offset += node.data.length;
      const text = node.data.slice(Math.max(0, from - start), Math.min(node.data.length, to - start));
      if (!text || offset <= from || start >= to) return null;
      const cloned = node.cloneNode(false);
      cloned.data = text;
      return cloned;
    }
    if (!isTag(node)) return null;
    if (skip) return offset >= from && offset < to ? node.cloneNode(true) : null;
    const start = offset;
    const children = node.children.flatMap(child => { const selected = slice(child, skip); return selected ? [selected] : []; });
    if (children.length === 0 && !(node.children.length === 0 && start >= from && start < to)) return null;
    const cloned = node.cloneNode(false);
    cloned.children = children;
    for (const child of children) child.parent = cloned;
    return cloned;
  };
  const children = document.children.flatMap(child => { const selected = slice(child); return selected ? [selected] : []; });
  return { html: DomUtils.getOuterHTML(children), text: DomUtils.textContent(children) };
}

/** A disposable parsed document, with bounded HTML/text caches and no browser DOM. */
export function createPreviewDocument(id: string, options: PreviewDocumentOptions) {
  const prepared = preparePreviewDocument(options, true);
  const cache = new Map<number, { chunk: PreviewDocumentChunk; parts: TextPart[]; bytes: number }>();
  let cacheBytes = 0, disposed = false, searchGeneration = 0;
  const read = (index: number) => {
    if (disposed) throw new Error('Preview document was released');
    if (!Number.isInteger(index) || index < 0 || index >= prepared.blocks.length) throw new RangeError('Unknown Preview block');
    const cached = cache.get(index);
    if (cached) { cache.delete(index); cache.set(index, cached); return cached; }
    const rendered = prepared.renderBlock(index);
    const parts = previewTextParts(rendered.html);
    const entry = { chunk: { index, html: rendered.html, hasMermaid: rendered.hasMermaid }, parts,
      bytes: rendered.html.length * 2 + parts.reduce((sum, part) => sum + part.text.length * 4 + 64, 0) };
    if (entry.bytes <= 16 * 1024 * 1024) {
      cache.set(index, entry); cacheBytes += entry.bytes;
      while (cacheBytes > 16 * 1024 * 1024 && cache.size > 1) {
        const oldest = cache.keys().next().value!;
        cacheBytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
      }
    }
    return entry;
  };
  const atLine = (line: number): number | null => {
    return previewBlockAtLine(prepared.blocks, line);
  };
  const yieldWork = () => new Promise<void>(resolve => setImmediate(resolve));
  return {
    open(anchorLine: number) {
      const index = atLine(anchorLine) ?? 0;
      const chunks = prepared.blocks.slice(Math.max(0, index - 3), index + 9).map(block => read(block.index).chunk);
      const document: PreviewDocumentManifest = { id, anchorLine, blocks: prepared.blocks, headings: prepared.headings, chunks };
      return { html: '', hasMermaid: prepared.hasMermaid, styles: prepared.styles,
        preset: prepared.preset, presetRevision: prepared.presetRevision, document };
    },
    async run(operation: PreviewDocumentOperation): Promise<PreviewDocumentResult> {
      if (disposed) throw new Error('Preview document was released');
      if (operation.kind === 'blocks') return { kind: 'blocks', chunks: [...new Set(operation.indices)].map(index => read(index).chunk) };
      if (operation.kind === 'locate' && operation.anchor === undefined) return { kind: 'locate', block: atLine(operation.sourceLine ?? 1) };
      const search = operation.kind === 'search' ? ++searchGeneration : 0;
      let deadline = performance.now() + 8;
      const checkpoint = async () => {
        if (performance.now() >= deadline) { await yieldWork(); deadline = performance.now() + 8; }
        if (disposed) throw new Error('Preview document was released');
        if (search !== 0 && search !== searchGeneration) throw new Error('Preview operation superseded');
      };
      if (operation.kind === 'locate') {
        const heading = prepared.headings.find(heading => heading.id === operation.anchor);
        if (heading) return { kind: 'locate', block: atLine(heading.line) };
        for (const block of prepared.blocks) {
          await checkpoint();
          const root = parseDocument(read(block.index).chunk.html);
          const github = (options.presetDefinition ?? getPreviewPreset(options.preset)).renderer === 'github-readme';
          if (DomUtils.findOne(element => element.attribs.id === operation.anchor || element.attribs.name === operation.anchor
            || github && (element.attribs.id === `user-content-${operation.anchor}` || element.attribs.name === `user-content-${operation.anchor}`), root.children)) {
            return { kind: 'locate', block: block.index };
          }
        }
        return { kind: 'locate', block: null };
      }
      if (operation.kind === 'copy') {
        const [from, to] = operation.from.block < operation.to.block
          || operation.from.block === operation.to.block && operation.from.offset <= operation.to.offset
          ? [operation.from, operation.to] : [operation.to, operation.from];
        if (from.block < 0 || to.block >= prepared.blocks.length) throw new RangeError('Unknown Preview selection');
        const html: string[] = [], text: string[] = [];
        for (let index = from.block; index <= to.block; index += 1) {
          await checkpoint();
          const entry = read(index);
          const start = index === from.block ? from.offset : 0;
          const end = index === to.block ? to.offset : Number.MAX_SAFE_INTEGER;
          const selected = start === 0 && end === Number.MAX_SAFE_INTEGER
            ? { html: entry.chunk.html, text: entry.parts.map(part => part.text).join('') }
            : slicePreviewHtml(entry.chunk.html, start, end);
          html.push(selected.html); text.push(selected.text);
        }
        return { kind: 'copy', html: joinPreviewTableBands(html.join('')), text: text.join('') };
      }
      let total = 0;
      let active: PreviewDocumentMatch | null = null;
      const counts: [number, number][] = [];
      const occurrences = new Map<number, number>();
      const query = operation.caseSensitive ? operation.query : operation.query.toLocaleLowerCase();
      if (!query) return { kind: 'search', total, active, blocks: counts };
      for (const block of prepared.blocks) {
        await checkpoint();
        let count = 0;
        for (const part of read(block.index).parts) {
          const text = operation.caseSensitive ? part.text : part.lower;
          let offset = 0, cursor = 0, line = part.line;
          while ((offset = text.indexOf(query, offset)) >= 0) {
            const start = offset;
            const end = offset + query.length;
            offset = Math.max(end, start + 1);
            if (operation.wholeWord && (/[\p{L}\p{N}_]/u.test(part.text[start - 1] ?? '')
              || /[\p{L}\p{N}_]/u.test(part.text[end] ?? ''))) continue;
            if (!part.fixedLine) line += (part.text.slice(cursor, start).match(/\n/g) ?? []).length;
            const occurrence = occurrences.get(line) ?? 0;
            occurrences.set(line, occurrence + 1);
            if (total === operation.selectIndex || operation.selectIndex === undefined && operation.anchor
              && (active === null || Math.abs(line - operation.anchor.line) < Math.abs(active.line - operation.anchor.line)
                || line === operation.anchor.line && occurrence === operation.anchor.occurrence)) {
              if (!(active && operation.anchor && active.line === operation.anchor.line
                && active.occurrence === operation.anchor.occurrence && operation.selectIndex === undefined)) {
                active = { block: block.index, offset: part.offset + start, end: part.offset + end, line, occurrence, index: total };
              }
            }
            if (!part.fixedLine) line += (part.text.slice(start, end).match(/\n/g) ?? []).length;
            cursor = end;
            total += 1; count += 1;
          }
        }
        if (count) counts.push([block.index, count]);
      }
      return { kind: 'search', total, active, blocks: counts };
    },
    dispose() { disposed = true; cache.clear(); cacheBytes = 0; }
  };
}
