import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { resolvedSyntaxTree } from '../webview/src/helpers/markdownSyntax';
import { footnoteMarkdownExtension } from '../webview/src/helpers/footnotes';
import { getCodeBlockSourceLines } from '../webview/src/helpers/blockIndent';
import { getFencedCodeContent } from '../webview/src/helpers/mermaidDiagram';
import { applySourceLinePrefix, outerOffsetToSourceOffset, sourceOffsetToOuterOffset } from '../webview/src/helpers/sourceLinePrefix';
import { mathFenceBodyRange } from '../src/shared/mathFence';
import { boundedMermaidEditingSource, mermaidSourceForAnchor } from '../webview/src/helpers/mermaidSource';
import { boundedDisplayMathRange, collectDocumentMathRanges, getDisplayMathCopySource, getDisplayMathSource } from '../webview/src/helpers/displayMathBlocks';
import { latexDelimitersFacet } from '../webview/src/editor/mathSyntaxPreference';

for (const fence of ['```', '~~~', '````', '~~~~']) {
  for (const [suffix, expected] of [
    ['', ''], ['\n', ''], ['\nflowchart LR', 'flowchart LR'],
    ['\nflowchart LR\nA --> B', 'flowchart LR\nA --> B'],
    ['\nflowchart LR\n\n' + fence, 'flowchart LR\n'],
    ['\nflowchart LR\nA --> B\n' + fence + fence[0], 'flowchart LR\nA --> B']
  ]) {
    const state = EditorState.create({ doc: fence + 'mermaid' + suffix, extensions: [markdown()] });
    let checked = false;
    resolvedSyntaxTree(state).iterate({ enter(node) {
      if (node.name !== 'FencedCode') return;
      checked = true;
      assert.equal(getFencedCodeContent(state, node), expected, `${fence}: actual fence rows delimit payload; unfinished final lines remain content`);
    } });
    assert.ok(checked);
  }
}

for (const [source, expected] of [
  ['  x^2  \n', '  x^2  \n'], ['$x^2$', 'x^2'], ['$$ x^2 $$', ' x^2 '],
  ['\n $$\n\n  x^2  \n\n$$ \n', '\n  x^2  \n'], ['$$\r\n\r\n  x^2  \r\n\r\n$$', '\r\n  x^2  \r\n'],
  ['$$\n$$', ''], ['$$x^2', '$$x^2'], ['\\$x^2$', '\\$x^2$'],
  ['$x$ + $y$', '$x$ + $y$'], ['$$$x$$$', '$$$x$$$']
]) {
  const body = mathFenceBodyRange(source!);
  assert.equal(source!.slice(body.from, body.to), expected, 'Math copy keeps whitespace and incomplete/literal wrappers');
}

for (const prefix of ['', '  ', '> ', '    ', '> > ']) {
  const source = 'x = 1\n  + y\n\n  ';
  const projected = applySourceLinePrefix(source, prefix);
  assert.equal(projected, source.split('\n').map(line => prefix + line).join('\n'));
  for (let offset = 0; offset <= source.length; offset++) {
    assert.equal(outerOffsetToSourceOffset(source, prefix, sourceOffsetToOuterOffset(source, prefix, offset)), offset,
      `${JSON.stringify(prefix)}: source selection round trip at ${offset}`);
  }
}

for (const { name, parent, prefix } of [
  { name: 'plain', parent: 'Paragraph', prefix: '' },
  { name: 'list', parent: '- Item', prefix: '  ' },
  { name: 'nested-list', parent: '- Parent\n  - Child', prefix: '    ' },
  { name: 'quote', parent: '> Paragraph', prefix: '> ' },
  { name: 'quote-list', parent: '> - Item', prefix: '>   ' },
  { name: 'footnote', parent: '[^note]: Definition', prefix: '    ' }
]) {
  const payload = ['flowchart LR', '  A --> B', '  ', '    ', '', '  C --> D'];
  const text = [parent, prefix.trimEnd(), prefix + '```mermaid', ...payload.map(line => prefix + line), prefix + '```'].join('\n');
  const state = EditorState.create({ doc: text, extensions: [markdown({ extensions: [footnoteMarkdownExtension] })] });
  let checked = false;
  resolvedSyntaxTree(state).iterate({ enter(node) {
    if (node.name !== 'FencedCode') return;
    checked = true;
    assert.equal(getFencedCodeContent(state, node), payload.join('\n'), `${name}: rendering must preserve payload spaces and remove the container prefix on blank lines`);
    const opening = state.doc.lineAt(node.from), closing = state.doc.lineAt(node.to - 1);
    assert.equal(boundedMermaidEditingSource(state, opening.from, closing.to)?.source, payload.join('\n'),
      `${name}: the editing preview must read the same bounded payload without a completed document tree`);
    const rows = getCodeBlockSourceLines(state, node.node).filter(row => !row.isFence);
    assert.deepEqual(rows.map(row => state.doc.sliceString(row.prefixTo, row.to)), payload, `${name}: ordinary code and Mermaid must agree on source indentation`);
    for (const row of rows) assert.deepEqual(getCodeBlockSourceLines(state, node.node, state.doc.lineAt(row.from).number), [row],
      `${name}: command input must read the same prefix without enumerating the block`);
  } });
  assert.ok(checked, `${name}: fenced code fixture must parse`);
}
for (const doc of ['```mermaid\nA --> B', '```mermaid\nA --> B\n```\nAfter',
  '```mermaid\nA --> B\n```\n```mermaid\nC --> D\n```', '> ```mermaid\nA --> B\n> ```',
  '```mermaid\n' + 'A'.repeat(32_768) + '\n```']) {
  const state = EditorState.create({ doc });
  assert.equal(boundedMermaidEditingSource(state, 0, state.doc.length), null,
    'unclosed, escaped, multiple and oversized fences must retain authoritative document parsing');
}
for (const indentation of ['', ' ', '  ', '   ']) for (const openingGap of [' ', '\t', ' \t']) for (const bodyGap of [' ', '\t', ' \t']) {
  const prefix = indentation + '>', doc = `${prefix}${openingGap}\`\`\`mermaid\n${prefix}${bodyGap}flowchart LR\n${prefix}${bodyGap}A --> B\n${prefix}${openingGap}\`\`\``;
  const state = EditorState.create({ doc, extensions: markdown() });
  resolvedSyntaxTree(state).iterate({ enter(node) {
    if (node.name !== 'FencedCode') return;
    const opening = state.doc.lineAt(node.from), closing = state.doc.lineAt(node.to - 1);
    const source = boundedMermaidEditingSource(state, opening.from, closing.to);
    if (source) assert.equal(source.source, mermaidSourceForAnchor(state, opening.from)?.source,
      `bounded reading must retain physical tab stops: ${JSON.stringify({ indentation, openingGap, bodyGap })}`);
  } });
}
{
  const block = '> ```mermaid\n> flowchart LR\n> A --> B\n> ```';
  const prefix = 'Background paragraph.\n\n'.repeat(2000);
  // No language tree is installed: the document Worker has not caught up yet.
  const state = EditorState.create({ doc: prefix + block + '\n\n' + prefix });
  const read = state.doc.sliceString.bind(state.doc);
  Object.defineProperty(state.doc, 'sliceString', { configurable: true, value(from: number, to: number) {
    assert.ok(to - from <= 32_768, 'an active preview must not read the surrounding document');
    return read(from, to);
  } });
  try {
    assert.equal(boundedMermaidEditingSource(state, prefix.length, prefix.length + block.length)?.source,
      'flowchart LR\nA --> B', 'an owned closed block must update before global syntax publication');
  } finally { delete (state.doc as any).sliceString; }
}
for (const [doc, kind, line] of [
  ['> ```ts\n' + '> value\n'.repeat(12000) + '> ```', 'FencedCode', 2],
  ['- Item\n\n      code\n' + '      \n'.repeat(12000), 'CodeBlock', 3]
] as const) {
  const state = EditorState.create({ doc, extensions: [markdown()] });
  let block: any;
  resolvedSyntaxTree(state).iterate({ enter(node) { if (!block && node.name === kind) block = node.node; } });
  assert.ok(block, `${kind}: work-budget fixture must parse`);
  const readLine = state.doc.line.bind(state.doc);
  let lineReads = 0;
  Object.defineProperty(state.doc, 'line', { configurable: true, value(number: number) { lineReads++; return readLine(number); } });
  try {
    const rows = getCodeBlockSourceLines(state, block, line);
    assert.equal(rows.length, 1, `${kind}: input must project just the requested row`);
    assert.ok(lineReads <= 4, `${kind}: a single-line input scanned ${lineReads} rows`);
  } finally { delete (state.doc as any).line; }
}
console.log('Fenced code container-prefix round trips passed');

for (const language of ['math', 'latex', 'tex', 'katex']) for (const latex of [false, true]) {
  for (const { parent, prefix } of [
    { parent: 'Paragraph', prefix: '' }, { parent: '- Item', prefix: '  ' },
    { parent: '- Parent\n  - Child', prefix: '    ' }, { parent: '> Paragraph', prefix: '> ' },
    { parent: '> - Item', prefix: '>   ' }, { parent: '[^note]: Definition', prefix: '    ' }
  ]) {
    const payload = ['\\[', '  x = 1', '', '  + y', '\\]'];
    const text = [parent, prefix.trimEnd(), prefix + '```' + language, ...payload.map(line => prefix + line), prefix + '```'].join('\n');
    const state = EditorState.create({ doc: text, extensions: [markdown({ extensions: [footnoteMarkdownExtension] }), latexDelimitersFacet.of(latex)] });
    const ranges = collectDocumentMathRanges(state).filter(range => range.fenceSource);
    assert.equal(ranges.length, 1);
    const authoritative = ranges[0]!, anchor = state.doc.lineAt(authoritative.from).from;
    const owned = boundedDisplayMathRange(state, anchor, authoritative.to);
    assert.ok(owned, `${language}/${JSON.stringify(prefix)}: closed owned formula remains locally readable`);
    assert.equal(owned.content, authoritative.content, 'Owned formulas retain delimiter settings');
    assert.deepEqual(getDisplayMathSource(state, owned), getDisplayMathSource(state, authoritative), 'Owned source retains container prefixes and positions');
    assert.deepEqual(getDisplayMathCopySource(state, owned), getDisplayMathCopySource(state, authoritative), 'Copy/select boundaries match authoritative formulas');
  }
}
for (const doc of ['```math\nx=1', '```math\nx=1\n```\nAfter', '```js\nx=1\n```', '```math\n' + 'x'.repeat(32_768) + '\n```']) {
  const state = EditorState.create({ doc });
  assert.equal(boundedDisplayMathRange(state, 0, state.doc.length), null, 'Unknown, changed, open or oversized formula bounds stay with authoritative parsing');
}
console.log('Owned formula projections match authoritative aliases, settings, containers and source operations');
