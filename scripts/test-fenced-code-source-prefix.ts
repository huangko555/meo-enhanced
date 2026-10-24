import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { resolvedSyntaxTree } from '../webview/src/helpers/markdownSyntax';
import { footnoteMarkdownExtension } from '../webview/src/helpers/footnotes';
import { getCodeBlockSourceLines } from '../webview/src/helpers/blockIndent';
import { getFencedCodeContent } from '../webview/src/helpers/mermaidDiagram';
import { applySourceLinePrefix, outerOffsetToSourceOffset, sourceOffsetToOuterOffset } from '../webview/src/helpers/sourceLinePrefix';
import { mathFenceBodyRange } from '../src/shared/mathFence';

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
    const rows = getCodeBlockSourceLines(state, node.node).filter(row => !row.isFence);
    assert.deepEqual(rows.map(row => state.doc.sliceString(row.prefixTo, row.to)), payload, `${name}: ordinary code and Mermaid must agree on source indentation`);
    for (const row of rows) assert.deepEqual(getCodeBlockSourceLines(state, node.node, state.doc.lineAt(row.from).number), [row],
      `${name}: command input must read the same prefix without enumerating the block`);
  } });
  assert.ok(checked, `${name}: fenced code fixture must parse`);
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
