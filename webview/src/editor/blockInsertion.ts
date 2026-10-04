import { matchInlineScript } from '../../../src/foundation/inlineScript';
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import { syntaxTree } from '@codemirror/language';
export type MarkdownInputContext = 'block' | 'inline' | 'heading' | 'excluded';

/** Literal comment markers in code cannot affect later prose comment operations. */
export function markdownCodeRanges(tree: Tree): { from: number; to: number }[] {
  const ranges: { from: number; to: number }[] = [];
  tree.iterate({ enter(node) {
    if (/^(?:FencedCode|CodeBlock|InlineCode)$/.test(node.name)) { ranges.push({ from: node.from, to: node.to }); return false; }
  } });
  return ranges;
}

/** Code/HTML/address contexts never execute prose commands, including while syntax is incomplete. */
export function markdownSyntaxContext(state: EditorState, position: number): MarkdownInputContext {
  if (state.readOnly) return 'excluded';
  const line = state.doc.lineAt(position), before = state.sliceDoc(line.from, position);
  if (/\]\([^)]*$|\]\[[^\]]*$|\[\[[^\]]*$|!\[[^\]]*$|<[^>]*$|(?:[a-z][a-z0-9+.-]*:\/+|www\.)[^\s]*$/i.test(before)) return 'excluded';
  let context: MarkdownInputContext = 'block';
  let node = syntaxTree(state).resolveInner(position, -1);
  for (;;) {
    if (/^(?:FencedCode|CodeBlock|CodeInfo|CodeText|HTMLBlock|HTMLTag|CommentBlock|ProcessingInstruction)$/.test(node.name)) return 'excluded';
    if (/^(?:InlineCode|Autolink|URL|LinkTitle|LinkLabel)$/.test(node.name) && position > node.from && position < node.to) return 'excluded';
    if (/^(?:Emphasis|StrongEmphasis|Strikethrough|Highlight|Link|Image|Table|TableCell)$/.test(node.name)) context = 'inline';
    if (/^(?:ATXHeading[1-6]|SetextHeading[12])$/.test(node.name)) context = 'heading';
    if (!node.parent) break;
    node = node.parent;
  }
  const offset = position - line.from;
  for (let index = 0; index < offset; index++) {
    if (line.text[index] !== '^' && line.text[index] !== '~') continue;
    const script = matchInlineScript(line.text, index);
    if (script && offset > index && offset < script.to) { context = 'inline'; break; }
    if (script) index = script.to - 1;
  }
  // Incomplete formulas still belong to their editor, rather than to the slash menu.
  if (/\$\$[^$]*$|(?<!\\)\$[^$\n]*$/.test(before)) return 'excluded';
  if (/^[ \t]*(?:>\s*)*\[[^\]]+\]:/.test(line.text)) return 'excluded';
  return context;
}

/** Replaces a query, or inserts after a preserved selection. The editor supplies the context at `from`. */
export function blockInsertion(state: EditorState, from: number, to: number, block: string, caret: number, context: MarkdownInputContext): { transaction: TransactionSpec; positionAt: (offset: number) => number } | null {
  if (state.selection.ranges.length !== 1 || context !== 'block') return null;
  const line = state.doc.lineAt(from);
  if (state.doc.lineAt(to).number !== line.number) return null;
  const rawPrefix = /^[ \t]*(?:>[ \t]*)*/.exec(line.text)?.[0] ?? '';
  const marker = /^(?:[-+*]|\d+[.)])[ \t]+(?:\[[ xX~\-]\][ \t]+)?/.exec(line.text.slice(rawPrefix.length))?.[0] ?? '';
  const insidePrefix = from < line.from + rawPrefix.length + marker.length;
  const firstPrefix = insidePrefix ? '' : rawPrefix + marker;
  const baseMarker = /^(?:[-+*]|\d+[.)])[ \t]+/.exec(marker)?.[0] ?? '';
  let continuation = insidePrefix ? '' : rawPrefix + ' '.repeat(baseMarker.length);
  // A continuation line already carries its list indentation; the syntax tree owns the hierarchy.
  let node = syntaxTree(state).resolveInner(from, -1);
  while (node.parent && node.name !== 'ListItem') node = node.parent;
  if (!insidePrefix && !marker && node.name === 'ListItem') {
    const opening = state.doc.lineAt(node.from).text;
    const quote = /^[ \t]*(?:>[ \t]*)*/.exec(opening)?.[0] ?? '';
    const list = /^(?:[-+*]|\d+[.)])[ \t]+/.exec(opening.slice(quote.length))?.[0] ?? '';
    if (list) continuation = quote + ' '.repeat(list.length);
  }
  const left = state.sliceDoc(line.from + firstPrefix.length, from);
  const right = state.sliceDoc(to, line.to);
  const emptyLeft = !left.trim();
  const lines = block.split('\n');
  // An empty task marker stays on its own line so it cannot become part of a table header.
  const emptyTask = emptyLeft && !insidePrefix && marker !== baseMarker;
  const prefix = emptyLeft && !emptyTask ? firstPrefix : continuation;
  const rendered = lines.map((text, index) => (index ? continuation : prefix) + text).join('\n');
  const before = emptyTask ? firstPrefix + '\n' + continuation + '\n' : emptyLeft ? (line.number > 1 && state.doc.line(line.number - 1).text.trim() ? continuation + '\n' : '') : '\n' + continuation + '\n';
  let after = right.trim() ? '\n' + continuation + '\n' + continuation : '';
  if (!after && line.to < state.doc.length) {
    const next = state.doc.line(line.number + 1);
    if (next.text.trim()) after = '\n' + continuation;
  }
  const changeFrom = emptyLeft ? line.from : from;
  const positionAt = (offset: number) => changeFrom + before.length + offset + prefix.length + (block.slice(0, offset).match(/\n/g)?.length ?? 0) * continuation.length;
  return { transaction: { changes: { from: changeFrom, to, insert: before + rendered + after }, selection: EditorSelection.cursor(positionAt(caret)) }, positionAt };
}
