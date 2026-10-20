import { ChangeSet, Text } from '@codemirror/state';
import { DocInput } from '@codemirror/language';
import { TreeFragment, type Tree } from '@lezer/common';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { MarkdownParser } from '@lezer/markdown';
import { inlineMarkdownExtensions } from './helpers/inlineMarkdownParser';
import { createMarkdownTreeEncoder } from './editor/markdownTreeTransfer';
import type { MarkdownParseRequest, MarkdownParseResponse } from './editor/markdownParseProtocol';
import { prepareMarkdownDocumentContext } from './markdownDocumentContext';
import { projectMarkdownDocumentContext } from './markdownContextProjection';
import type { MarkdownSourceContext } from './editor/markdownSourceContext';
import { encodeMarkdownLanguageHosts } from './editor/markdownLanguageHosts';

// Bootstrap the existing shared grammar exactly as the editing surface does.
// Node IDs are verified on receipt; palette props remain surface-owned.
const markdownStructureGrammar = (markdownLanguage.parser as MarkdownParser).configure([
  ...inlineMarkdownExtensions, { remove: ['Emoji'] }
]);
const markdownStructureGrammarIdentity = markdownStructureGrammar.nodeSet.types.map(type => type.name).join('\0');

let doc: Text | undefined, revision = 0, busy = false;
let completed: Tree | undefined;
let sourceContext: MarkdownSourceContext | undefined;
let fragments: readonly TreeFragment[] = [];
const encoder = createMarkdownTreeEncoder();

self.onmessage = async ({ data: request }: MessageEvent<MarkdownParseRequest>) => {
  if (busy) {
    self.postMessage({ id: request.id, error: 'Markdown parser received overlapping requests' } satisfies MarkdownParseResponse);
    return;
  }
  busy = true;
  try {
    let update: ChangeSet | undefined;
    if (!Number.isSafeInteger(request.id) || request.id <= revision || request.base !== revision) throw new Error('Markdown parser revision mismatch');
    if (!Number.isSafeInteger(request.tabSize) || request.tabSize <= 0 || typeof request.blocks !== 'boolean') throw new Error('Invalid Markdown context request');
    if (request.text !== undefined) {
      if (doc) throw new Error('Markdown parser already has a document');
      doc = Text.of(request.text.split('\n'));
      completed = undefined;
    } else {
      if (!doc) throw new Error('Markdown parser needs its initial document');
      const changes = ChangeSet.fromJSON(request.changes), ranges: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = [];
      update = changes;
      changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
      if (!changes.empty) {
        doc = changes.apply(doc); completed = undefined;
        fragments = TreeFragment.applyChanges(fragments, ranges);
      }
    }
    if (!completed) {
      const parse = markdownStructureGrammar.startParse(new DocInput(doc), fragments);
      let tree: Tree | null, deadline = performance.now() + 8;
      while (!(tree = parse.advance())) {
        if (performance.now() >= deadline) {
          await new Promise(resolve => setTimeout(resolve, 0));
          deadline = performance.now() + 8;
        }
      }
      completed = tree;
    }
    const tree = completed;
    if (tree.length !== doc.length || tree.type.name !== 'Document') throw new Error('Markdown parser produced incomplete structure');
    fragments = TreeFragment.addTree(tree, fragments); revision = request.id;
    const projected = sourceContext && update && projectMarkdownDocumentContext(sourceContext, doc, tree, request.tabSize, update);
    const prepared = projected ? undefined : prepareMarkdownDocumentContext(doc, tree, request.tabSize);
    const context: MarkdownSourceContext = projected ?? { doc, tree, tabSize: request.tabSize, footnotes: prepared!.footnotes, code: prepared!.code };
    const encoded = encoder.encode(tree);
    const languageHosts = encodeMarkdownLanguageHosts(tree);
    self.postMessage({ id: request.id, kind: 'syntax', grammar: markdownStructureGrammarIdentity, length: doc.length,
      tree: encoded.value, languageHosts, tabSize: request.tabSize, ...(projected ? { projectedFrom: request.base }
        : { footnotes: context.footnotes, code: context.code }) } satisfies MarkdownParseResponse,
      { transfer: [...encoded.transfers, languageHosts.buffer] });
    if (request.blocks) {
      const projectedBlocks = !!projected?.blocks;
      context.blocks ??= (prepared ?? prepareMarkdownDocumentContext(doc, tree, request.tabSize, context)).blocks();
      self.postMessage({ id: request.id, kind: 'blocks', tabSize: request.tabSize,
        ...(projectedBlocks ? { projectedFrom: request.base } : { value: context.blocks }) } satisfies MarkdownParseResponse);
    }
    sourceContext = context;
  } catch (error) {
    sourceContext = undefined;
    encoder.clear();
    self.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies MarkdownParseResponse);
  } finally { busy = false; }
};
