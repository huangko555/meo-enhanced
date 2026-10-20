import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import * as language from '@codemirror/language';
import { EditorState, StateEffect } from '@codemirror/state';
import { Tree } from '@lezer/common';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { MarkdownParser } from '@lezer/markdown';
import { markdownStructureIdentity } from '../webview/src/editor/markdownStructure';
import { hasSameLiveMarkdownSyntax } from '../webview/src/helpers/livePresentationSyntax';
import { collectDocumentMathRanges } from '../webview/src/helpers/displayMathBlocks';
import { collectMarkdownLiteralRanges } from '../webview/src/helpers/markdownLiteralRanges';
import { readCodeFenceSource } from '../webview/src/helpers/codeFenceSource';

const ensure = language.ensureSyntaxTree;
let ensureCalls = 0;
mock.module('@codemirror/language', () => ({ ...language,
  ensureSyntaxTree: (...args: Parameters<typeof ensure>) => { ensureCalls++; return ensure(...args); }
}));
const { editorMarkdownLanguage } = await import('../webview/src/liveMode');
const { longCodeBlockSessionUiExtension } = await import('../webview/src/helpers/longCodeBlocks');
const { getLiveRenderedBlocks } = await import('../webview/src/helpers/liveRenderedBlocks');
const { parseFootnotes } = await import('../webview/src/helpers/footnotes');
const { prepareMarkdownDocumentContext, adoptMarkdownDocumentContext } = await import('../webview/src/markdownDocumentContext');
const { inlineMarkdownExtensions } = await import('../webview/src/helpers/inlineMarkdownParser');
const { htmlEditingRangeField, setHtmlEditingRangeEffect } = await import('../webview/src/helpers/htmlContent');
const { extractDetailsBlocks } = await import('../webview/src/helpers/markdownSyntax');

const text = 'Reference[^note].\n\n[^note]: Definition\n\n' + Array.from({ length: 80 }, (_, i) =>
  `## Block ${i}\n\n\u0060\u0060\u0060javascript\nconst value = ${i};\n\u0060\u0060\u0060\n\n| A | B |\n| --- | --- |\n| one | two |\n\n`).join('');
let state = EditorState.create({ doc: text, extensions: [editorMarkdownLanguage] });
ensure(state, state.doc.length, 10_000);
state = state.update({}).state;
ensureCalls = 0;
state = state.update({ effects: (await import('@codemirror/state')).StateEffect.appendConfig.of(longCodeBlockSessionUiExtension()) }).state;
assert.equal(ensureCalls, 0, 'code descriptors must read one published syntax snapshot without advancing parsers for each indent');
assert.equal(parseFootnotes(state).references[0]?.number, 1, 'shared footnote numbering remains available');
ensureCalls = 0;
const blocks = getLiveRenderedBlocks(state);
assert.equal(blocks.filter(block => block.kind === 'table').length, 80);
assert.ok(ensureCalls <= 1, `one structural discovery must resolve at most one syntax snapshot; got ${ensureCalls}`);
const tree = language.syntaxTree(state);
const republished = new Tree(tree.type, tree.children, tree.positions, tree.length, tree.propValues);
assert.notEqual(republished, tree);
assert.equal(markdownStructureIdentity(republished), markdownStructureIdentity(tree));
assert.ok(hasSameLiveMarkdownSyntax(tree, republished));
const math = collectDocumentMathRanges(state, tree);
const literals = collectMarkdownLiteralRanges(state, tree);
const fences = readCodeFenceSource(state, tree);
const iterate = Tree.prototype.iterate;
let traversals = 0;
Tree.prototype.iterate = function (...args) { traversals++; return iterate.apply(this, args); };
try {
  assert.deepEqual(getLiveRenderedBlocks(state, { tree: republished }), blocks);
  assert.deepEqual(collectDocumentMathRanges(state, republished), math);
  assert.equal(collectMarkdownLiteralRanges(state, republished), literals);
  assert.equal(readCodeFenceSource(state, republished), fences);
  assert.equal(traversals, 0, 'publishing code tokens must reuse structural discovery, math and literal indexes');
} finally { Tree.prototype.iterate = iterate; }

const outerParser = (markdownLanguage.parser as MarkdownParser).configure([...inlineMarkdownExtensions, { remove: ['Emoji'] }]);
for (const sample of [
  'Reference[^n], literal `[^unused]`.\n\n[^n]: **Definition**\n\n    continued\n\n    ```\n    literal[^unused]\n    ```\n\n[^unused]: Unused\n',
  'Formula[^n].\n\n[^n]: Definition\n\n    ```math\n    x^2\n    ```\n\n    $$\n    y^2\n    $$\n',
  '> | A | B |\n> | --- | --- |\n> | one | two |\n\n```mermaid\ngraph TD; A-->B\n```\n\n$$\nx^2\n$$\n\n<div>HTML</div>\n',
  '<details>\n<summary>Section</summary>\n\n**Body** and $x^2$.\n\n</details>\n\n```markdown\n<details>\n<summary>Literal</summary>\n\nLiteral body\n\n</details>\n```\n',
  '---\ntitle: "[^hidden]"\n---\n\n# Heading\n\n- item[^n]\n\n[^n]: definition\n\n\tcontinued\n\n    | A | B |\n    | --- | --- |\n    | one | two |\n',
  '> - [x] task\n>\n>   ```JavaScript\n>   const nested = 1;\n>   ```\n\n- item\n\n\t```\n\tcode\n\t```\n\n```mermaid\ngraph TD; A-->B\n```\n',
  '```empty\n```\n\n```\n\n```\n\n~~~unclosed\nfirst\nsecond\n'
]) for (const tabSize of [2, 4, 8]) {
  let surface = EditorState.create({ doc: sample, selection: { anchor: sample.indexOf('x^2') < 0 ? 0 : sample.indexOf('x^2') },
    extensions: [editorMarkdownLanguage, EditorState.tabSize.of(tabSize), htmlEditingRangeField] });
  ensure(surface, surface.doc.length, 2_000);
  surface = surface.update({}).state;
  const expectedNotes = parseFootnotes(surface);
  const expectedBlocks = getLiveRenderedBlocks(surface);
  const expectedMath = collectDocumentMathRanges(surface);
  const expectedLiterals = collectMarkdownLiteralRanges(surface, language.syntaxTree(surface));
  const expectedDetails = extractDetailsBlocks(surface);
  const expectedCode = readCodeFenceSource(surface);
  if (sample.includes('<summary>Literal')) assert.deepEqual(expectedDetails.map(block => block.summaryText), ['Section'],
    'a literal details element inside Markdown code is never an editable document fold');
  const workerDoc = EditorState.create({ doc: sample }).doc;
  const outer = outerParser.parse(sample);
  const prepared = prepareMarkdownDocumentContext(workerDoc, outer, tabSize);
  const notes = structuredClone(prepared.footnotes), code = structuredClone(prepared.code),
    presentation = structuredClone(prepared.blocks()), discovered = presentation.blocks;
  assert.deepEqual(notes, expectedNotes, 'worker outer syntax must preserve mixed-parser global footnotes');
  assert.deepEqual(presentation.math, expectedMath, 'formula source facts match the surface parser');
  assert.deepEqual(presentation.literals, expectedLiterals, 'literal exclusions remain identical after embedded language publication');
  assert.deepEqual(presentation.details, expectedDetails, 'details remain outer source context, including literal Markdown fences');
  assert.deepEqual(code, expectedCode, 'code bounds, container indentation and normalized languages survive worker transfer');
  adoptMarkdownDocumentContext(surface.doc, language.syntaxTree(surface), tabSize, { kind: 'footnotes', value: notes }, editorMarkdownLanguage.language.parser);
  adoptMarkdownDocumentContext(surface.doc, language.syntaxTree(surface), tabSize, { kind: 'blocks', value: presentation }, editorMarkdownLanguage.language.parser);
  adoptMarkdownDocumentContext(surface.doc, language.syntaxTree(surface), tabSize, { kind: 'code', value: code }, editorMarkdownLanguage.language.parser);
  assert.equal(readCodeFenceSource(surface), code, 'surface code folding consumes the transferred index directly');
  for (const fence of code) {
    assert.equal(surface.doc.line(fence.contentStartLine).from, fence.contentFrom);
    assert.equal(surface.doc.line(fence.contentStartLine + fence.lineCount - 1).to, fence.contentTo);
  }
  assert.equal(parseFootnotes(surface), notes, 'a transferred verified context must be reused directly');
  assert.deepEqual(getLiveRenderedBlocks(surface.update({}).state), expectedBlocks,
    'worker facts retain surface selection filtering for math and nested tables');
  assert.deepEqual(getLiveRenderedBlocks(surface, { includeSelectedMath: true }),
    discovered.map(({ block }) => block), 'transport preserves all source blocks before dynamic selection filtering');
  const html = discovered.find(item => item.block.kind === 'html');
  if (html) {
    const editing = surface.update({ effects: setHtmlEditingRangeEffect.of({ from: html.htmlFrom!, to: surface.doc.line(html.block.endLine).to }) }).state;
    assert.equal(getLiveRenderedBlocks(editing, { includeSelectedMath: true }).filter(block => block.kind === 'html').length,
      discovered.filter(item => item.block.kind === 'html').length - 1, 'HTML editing remains a surface filter over adopted source facts');
  }
  if (notes.references.length) {
    const changedGrammar = surface.update({ effects: StateEffect.reconfigure.of([markdownLanguage, EditorState.tabSize.of(tabSize)]) }).state;
    assert.notEqual(parseFootnotes(changedGrammar), notes, 'a different grammar cannot reuse a verified worker context');
    const changedTabs = surface.update({ effects: StateEffect.reconfigure.of([editorMarkdownLanguage, EditorState.tabSize.of(tabSize === 4 ? 8 : 4)]) }).state;
    assert.notEqual(parseFootnotes(changedTabs), notes, 'tab size participates in context identity');
  }
}
console.log('Structural readers share a stable syntax snapshot across code, table and footnote discovery');
