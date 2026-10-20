import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import * as language from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { Tree } from '@lezer/common';
import { markdownStructureIdentity } from '../webview/src/editor/markdownStructure';
import { hasSameLiveMarkdownSyntax } from '../webview/src/helpers/livePresentationSyntax';
import { collectDocumentMathRanges } from '../webview/src/helpers/displayMathBlocks';
import { collectMarkdownLiteralRanges } from '../webview/src/helpers/markdownLiteralRanges';

const ensure = language.ensureSyntaxTree;
let ensureCalls = 0;
mock.module('@codemirror/language', () => ({ ...language,
  ensureSyntaxTree: (...args: Parameters<typeof ensure>) => { ensureCalls++; return ensure(...args); }
}));
const { editorMarkdownLanguage } = await import('../webview/src/liveMode');
const { longCodeBlockSessionUiExtension } = await import('../webview/src/helpers/longCodeBlocks');
const { getLiveRenderedBlocks } = await import('../webview/src/helpers/liveRenderedBlocks');
const { parseFootnotes } = await import('../webview/src/helpers/footnotes');

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
const iterate = Tree.prototype.iterate;
let traversals = 0;
Tree.prototype.iterate = function (...args) { traversals++; return iterate.apply(this, args); };
try {
  assert.deepEqual(getLiveRenderedBlocks(state, { tree: republished }), blocks);
  assert.deepEqual(collectDocumentMathRanges(state, republished), math);
  assert.equal(collectMarkdownLiteralRanges(state, republished), literals);
  assert.equal(traversals, 0, 'publishing code tokens must reuse structural discovery, math and literal indexes');
} finally { Tree.prototype.iterate = iterate; }
console.log('Structural readers share a stable syntax snapshot across code, table and footnote discovery');
