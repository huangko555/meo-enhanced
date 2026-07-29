import { RangeSetBuilder, StateField } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import { collectColorRangesFromText } from './colorSwatches';

const markdownTagDeco = Decoration.mark({ class: 'meo-md-tag' });
const markdownTagRegex = /(^|[^\p{L}\p{N}_/-])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu;
const blockedTagAncestorNames = new Set([
  'FencedCode',
  'CodeBlock',
  'CodeText',
  'InlineCode',
  'URL',
  'Autolink',
  'HTMLBlock',
  'HTMLTag',
  'TableDelimiter'
]);

function hasBlockedTagAncestor(state: any, position: number): boolean {
  let node = syntaxTree(state).resolveInner(position, 1);
  while (node) {
    if (blockedTagAncestorNames.has(node.name)) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

function isInsideMarkdownLinkDestination(text: string, position: number): boolean {
  let depth = 1;
  for (let index = position - 1; index >= 0; index -= 1) {
    if (text[index] === '\\') {
      index -= 1;
      continue;
    }
    if (text[index] === ')') {
      depth += 1;
      continue;
    }
    if (text[index] !== '(') {
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      return index > 0 && text[index - 1] === ']';
    }
  }
  return false;
}

function buildMarkdownTagDecorations(state: any): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    const text = line.text;
    const colorRanges = collectColorRangesFromText(text, line.from);
    markdownTagRegex.lastIndex = 0;
    for (const match of text.matchAll(markdownTagRegex)) {
      const prefixLength = match[1]?.length ?? 0;
      const rawIndex = match.index ?? 0;
      const from = line.from + rawIndex + prefixLength;
      const to = from + 1 + (match[2]?.length ?? 0);
      const linePosition = from - line.from;
      const isColor = colorRanges.some((range) => range.from === from && range.to === to);
      if (
        to <= from + 1 ||
        isColor ||
        isInsideMarkdownLinkDestination(text, linePosition) ||
        hasBlockedTagAncestor(state, from)
      ) {
        continue;
      }
      builder.add(from, to, markdownTagDeco);
    }
  }
  return builder.finish();
}

export const markdownTagField = StateField.define<DecorationSet>({
  create(state) {
    return buildMarkdownTagDecorations(state);
  },
  update(value, transaction) {
    if (!transaction.docChanged) {
      return value;
    }
    return buildMarkdownTagDecorations(transaction.state);
  },
  provide(field) {
    return EditorView.outerDecorations.from(field);
  }
});
