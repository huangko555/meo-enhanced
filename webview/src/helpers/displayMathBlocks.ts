import { readDocumentTextProjection } from '../application/documentTextProjection';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { isMathFenceLanguage, mathFenceBodyRange, mathFenceContent } from '../../../src/shared/mathFence';
import { getCodeBlockSourceLines, parseBlockLinePrefix } from './blockIndent';
import { collectLatexMathRanges } from './math';
import { collectMarkdownLiteralRanges } from './markdownLiteralRanges';
import { getFencedCodeInfo, resolvedSyntaxTree } from './markdownSyntax';
import { markdownStructureIdentity } from '../editor/markdownStructure';
import type { MarkdownMathRange } from '../../../src/foundation/markdownDocumentContext';

export type DocumentMathRange = MarkdownMathRange;
const fullRangeCache = new Map<EditorState['doc'], { tree: Tree; tabSize: number; ranges: readonly DocumentMathRange[]; bytes: number }>();
let fullRangeBytes = 0;
const copyRanges = (ranges: readonly DocumentMathRange[]) => ranges.map(range => ({ ...range,
  ...(range.fenceSource ? { fenceSource: { ...range.fenceSource } } : {}) }));

export function adoptDocumentMathRanges(doc: EditorState['doc'], tree: Tree, tabSize: number,
  ranges: readonly DocumentMathRange[]): void {
  const old = fullRangeCache.get(doc);
  if (old) fullRangeBytes -= old.bytes;
  fullRangeCache.delete(doc);
  const bytes = doc.length * 2 + ranges.reduce((sum, range) => sum
    + (range.content.length + range.raw.length + (range.fenceSource?.text.length ?? 0)) * 2 + 128, 0);
  fullRangeCache.set(doc, { tree, tabSize, ranges: copyRanges(ranges), bytes }); fullRangeBytes += bytes;
  while ((fullRangeBytes > 4 * 1024 * 1024 || fullRangeCache.size > 4) && fullRangeCache.size > 1) {
    const oldest = fullRangeCache.keys().next().value!;
    fullRangeBytes -= fullRangeCache.get(oldest)!.bytes; fullRangeCache.delete(oldest);
  }
}

/** Delimiter scanning and parsed TeX fences feed the same display component.
 * Ordinary code remains literal, and an unclosed fence stays editable source. */
export function collectDocumentMathRanges(
  state: EditorState,
  tree: Tree = resolvedSyntaxTree(state),
  excludedRanges: readonly { from: number; to: number }[] = [],
  scope?: { from: number; to: number }
): DocumentMathRange[] {
  const cacheable = !scope && excludedRanges.length === 0;
  const cached = cacheable ? fullRangeCache.get(state.doc) : undefined;
  if (cached && markdownStructureIdentity(cached.tree) === markdownStructureIdentity(tree) && cached.tabSize === state.tabSize) {
    fullRangeCache.delete(state.doc); fullRangeCache.set(state.doc, cached);
    return copyRanges(cached.ranges);
  }
  const literalRanges = collectMarkdownLiteralRanges(state, tree, scope);
  const baseOffset = scope?.from ?? 0;
  const exclusions = [...literalRanges.filter(range => !range.script), ...excludedRanges];
  const candidates: DocumentMathRange[] = collectLatexMathRanges(scope ? state.doc.sliceString(scope.from, scope.to) : readDocumentTextProjection(state.doc), {
    baseOffset,
    excludedRanges: exclusions.filter(range => !scope || range.to > scope.from && range.from < scope.to)
      .map(range => ({ from: Math.max(0, range.from - baseOffset), to: range.to - baseOffset })),
    includeEmptyDisplay: true
  });
  const scripts = literalRanges.filter(range => range.script
    && !candidates.some(math => range.from >= math.from && range.from < math.to));
  const ranges = candidates.filter(math => !scripts.some(script => math.from >= script.from && math.from < script.to));
  tree.iterate({ ...scope, enter(node) {
    if (node.name !== 'FencedCode') return;
    if (!isMathFenceLanguage(getFencedCodeInfo(state, node))) return false;
    const opening = state.doc.lineAt(node.from);
    const closing = state.doc.lineAt(Math.max(node.from, node.to - 1));
    const last = node.node.lastChild;
    if (closing.number <= opening.number || last?.name !== 'CodeMark'
      || state.doc.lineAt(last.from).number !== closing.number
      || excludedRanges.some(range => node.from < range.to && node.to > range.from)) return false;
    const lines = getCodeBlockSourceLines(state, node.node).filter(line => !line.isFence);
    const text = lines.map(line => state.doc.sliceString(line.prefixTo, line.to)).join('\n');
    const firstContent = lines.find(line => line.prefixTo < line.to);
    ranges.push({ from: node.from, to: node.to, mode: 'display', fencedDisplay: true,
      content: mathFenceContent(text), raw: state.doc.sliceString(node.from, node.to),
      fenceSource: { text, from: lines[0]?.prefixTo ?? closing.from,
        prefix: firstContent ? state.doc.sliceString(firstContent.from, firstContent.prefixTo)
          : parseBlockLinePrefix(closing.text, state.tabSize).prefix } });
    return false;
  } });
  ranges.sort((left, right) => left.from - right.from);
  if (cacheable) adoptDocumentMathRanges(state.doc, tree, state.tabSize, ranges);
  return ranges;
}

/** Source/copy boundaries belong to document lines, regardless of delimiter length. */
export function getDisplayMathSource(state: EditorState, range: DocumentMathRange) {
  const firstNumber = state.doc.lineAt(range.from).number + 1;
  const closing = state.doc.lineAt(range.to - 1);
  if (firstNumber >= closing.number) return null;
  const first = state.doc.line(firstNumber);
  const last = state.doc.line(closing.number - 1);
  const prefix = range.fenceSource?.prefix ?? parseBlockLinePrefix(closing.text, state.tabSize).prefix;
  const text = range.fenceSource?.text ?? state.doc.sliceString(first.from, last.to).split('\n')
    .map(line => line.startsWith(prefix) ? line.slice(prefix.length) : line === prefix.trimEnd() ? '' : line).join('\n');
  return { first, last, prefix, text, from: range.fenceSource?.from ?? Math.min(first.to, first.from + prefix.length) };
}

export function getDisplayMathCopySource(state: EditorState, range: DocumentMathRange) {
  const source = getDisplayMathSource(state, range);
  if (!source) return null;
  const body = range.fenceSource ? mathFenceBodyRange(source.text) : { from: 0, to: source.text.length };
  const lines = source.text.split('\n');
  const position = (offset: number) => {
    const before = source.text.slice(0, offset).split('\n');
    const index = before.length - 1;
    const line = state.doc.line(source.first.number + index);
    // Container prefixes can differ on blank lines; map through each actual line.
    return line.to - lines[index]!.length + before[index]!.length;
  };
  return { text: source.text.slice(body.from, body.to), from: position(body.from), to: position(body.to) };
}
