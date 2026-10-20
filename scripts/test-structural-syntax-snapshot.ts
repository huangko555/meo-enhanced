import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import * as language from '@codemirror/language';
import { ChangeSet, EditorState, StateEffect, Text } from '@codemirror/state';
import { Tree } from '@lezer/common';
import { markdownLanguage } from '@codemirror/lang-markdown';
import type { MarkdownParser } from '@lezer/markdown';
import { markdownStructureIdentity } from '../webview/src/editor/markdownStructure';
import { hasSameLiveMarkdownSyntax } from '../webview/src/helpers/livePresentationSyntax';
import { collectDocumentMathRanges } from '../webview/src/helpers/displayMathBlocks';
import { collectMarkdownLiteralRanges } from '../webview/src/helpers/markdownLiteralRanges';
import { readCodeFenceSource } from '../webview/src/helpers/codeFenceSource';
import { projectMarkdownDocumentContext, type MarkdownSourceContext } from '../webview/src/markdownContextProjection';

const ensure = language.ensureSyntaxTree;
let ensureCalls = 0;
mock.module('@codemirror/language', () => ({ ...language,
  ensureSyntaxTree: (...args: Parameters<typeof ensure>) => { ensureCalls++; return ensure(...args); }
}));
const { editorMarkdownLanguage } = await import('../webview/src/liveMode');
const { longCodeBlockSessionUiExtension } = await import('../webview/src/helpers/longCodeBlocks');
const { getLiveRenderedBlocks } = await import('../webview/src/helpers/liveRenderedBlocks');
const { parseFootnotes, projectUnchangedFootnotes } = await import('../webview/src/helpers/footnotes');
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
const projectionSource = [
  '# Heading', '', 'Editable intro.', '', '**Formatted** word with a [link](https://example.invalid).', '', '> Quoted body.', '', '- List body.', '',
  'Note[^n] and `literal`.', '', '[^n]: Definition', '', '    continuation', '',
  '    ```math', '    x^2', '    ```', '', '```javascript', 'const sample = 1;', '```', '',
  '<details>', '<summary>Title</summary>', '', 'Inside details.', '', '</details>', '',
  '| A | B |', '| --- | --- |', '| one | two |', '', '$$', 'y^2', '$$', '',
  '<code>Literal HTML</code>', '', '$$', '', 'Plain display body.', '', '$$', '', 'Tail prose.'
].join('\n');
function sourceContext(source: string, tabSize: number): MarkdownSourceContext {
  const doc = Text.of(source.split('\n')), tree = outerParser.parse(source);
  const prepared = prepareMarkdownDocumentContext(doc, tree, tabSize);
  return { doc, tree, tabSize, footnotes: prepared.footnotes, code: prepared.code, blocks: prepared.blocks() };
}
const facts = ({ footnotes, code, blocks }: MarkdownSourceContext) => ({ footnotes, code, blocks });
for (const tabSize of [2, 4, 8]) {
  const previous = sourceContext(projectionSource, tabSize), original = structuredClone(facts(previous));
  for (const text of ['Editable intro.', '**Formatted** word with a [link](https://example.invalid).', 'Quoted body.', 'List body.', 'Inside details.', 'Tail prose.']) {
    for (const edit of [{ from: projectionSource.indexOf(text), insert: 'New ' },
      { from: projectionSource.indexOf(text) + text.length, insert: '中文，。!? ' },
      { from: projectionSource.indexOf(text) + (text.startsWith('**') ? 4 : 2),
        to: projectionSource.indexOf(text) + (text.startsWith('**') ? 6 : 4), insert: '' }]) {
      const changes = ChangeSet.of(edit, previous.doc.length), doc = changes.apply(previous.doc), tree = outerParser.parse(doc.toString());
      const projected = projectMarkdownDocumentContext(previous, doc, tree, tabSize, changes);
      assert.ok(projected, `ordinary prose must project at ${text}, tabs ${tabSize}`);
      assert.deepEqual(facts(projected), facts(sourceContext(doc.toString(), tabSize)), 'projected facts match fresh complete discovery');
      assert.deepEqual(facts(previous), original, 'source projection cannot mutate the preceding revision');
      for (const reference of projected.footnotes.references) if (reference.definition) {
        assert.ok(projected.footnotes.definitions.includes(reference.definition), 'mapped references retain their mapped definition object');
      }
      const undo = changes.invert(previous.doc), restoredDoc = undo.apply(doc), restoredTree = outerParser.parse(restoredDoc.toString());
      const restored = projectMarkdownDocumentContext(projected, restoredDoc, restoredTree, tabSize, undo);
      assert.ok(restored); assert.deepEqual(facts(restored), original, 'plain-prose undo restores complete source facts');
    }
  }
  for (const edit of [{ from: projectionSource.indexOf('Editable') + 2, insert: '*' },
    { from: projectionSource.indexOf('Editable') + 2, insert: '\n' },
    { from: projectionSource.indexOf('Definition') + 2, insert: 'x' },
    { from: projectionSource.indexOf('literal') + 2, insert: 'x' },
    { from: projectionSource.indexOf('sample') + 2, insert: 'x' },
    { from: projectionSource.indexOf('Plain display body.') + 2, insert: 'x' },
    { from: projectionSource.indexOf('example.invalid') + 2, insert: 'x' },
    { from: projectionSource.indexOf('one') + 2, insert: 'x' }]) {
    const changes = ChangeSet.of(edit, previous.doc.length), doc = changes.apply(previous.doc), tree = outerParser.parse(doc.toString());
    assert.equal(projectMarkdownDocumentContext(previous, doc, tree, tabSize, changes), undefined,
      'syntax, definitions, literals, code and table edits keep authoritative discovery');
  }
  const first = ChangeSet.of({ from: projectionSource.indexOf('Editable') + 3, insert: 'a' }, previous.doc.length);
  const changes = first.compose(ChangeSet.of({ from: projectionSource.indexOf('Editable') + 4, insert: '文' }, first.newLength));
  const doc = changes.apply(previous.doc), tree = outerParser.parse(doc.toString());
  const projected = projectMarkdownDocumentContext(previous, doc, tree, tabSize, changes);
  assert.ok(projected); assert.deepEqual(facts(projected), facts(sourceContext(doc.toString(), tabSize)), 'coalesced worker edits remain exact');
  assert.equal(projectMarkdownDocumentContext(previous, doc, tree, tabSize + 1, changes), undefined, 'tab changes invalidate projection');
  assert.equal(projectMarkdownDocumentContext(previous, doc, new Tree(tree.type, [], [], tree.length), tabSize, changes), undefined,
    'a same-length placeholder cannot supply an outside-structure proof');
  const mathEdit = ChangeSet.of({ from: projectionSource.indexOf('Plain display body.') + 3, insert: 'word' }, previous.doc.length);
  const mathDoc = mathEdit.apply(previous.doc), mathTree = outerParser.parse(mathDoc.toString());
  const primaryOnly = projectMarkdownDocumentContext({ ...previous, blocks: undefined }, mathDoc, mathTree, tabSize, mathEdit);
  assert.ok(primaryOnly, 'Source may retain primary facts before its first rich-context request');
  const lazyRich = prepareMarkdownDocumentContext(mathDoc, mathTree, tabSize, primaryOnly).blocks();
  assert.deepEqual(lazyRich, sourceContext(mathDoc.toString(), tabSize).blocks,
    'entering Live after Source edits must compute current rich content rather than revive an obsolete formula');
}
let grammarProjections = 0;
for (const sample of [
  '**bold** and *italic* with ~~strike~~, ~sub~ and ^super^.',
  'A [label](https://example.invalid/path) and `code`.',
  '[display][target]\n\n[target]: https://example.invalid\n',
  '[display][targe]\n\n[target]: https://example.invalid\n',
  '$x^2$ and normal text.\n\n$$\n\nplain formula body\n\n$$',
  '<code>\n\nplain literal body\n\n</code>',
  '<details>\n<summary>Title</summary>\n\nplain body\n\n</details>',
  'Reference[^n].\n\n[^n]: body\n\n  legacy continuation\n',
  '> - [x] Task\n>\n>   continued words\n>\n>   ```math\n>   x^2\n>   ```'
]) {
  const before = sourceContext(sample, 4);
  for (let position = 0; position <= sample.length; position += 3) for (const insert of ['a', '.', ' ']) {
    const changes = ChangeSet.of({ from: position, insert }, before.doc.length), doc = changes.apply(before.doc);
    const tree = outerParser.parse(doc.toString()), projected = projectMarkdownDocumentContext(before, doc, tree, 4, changes);
    if (!projected) continue;
    grammarProjections++;
    assert.deepEqual(facts(projected), facts(sourceContext(doc.toString(), 4)),
      `accepted grammar-boundary projection remains identical to full discovery at ${position}: ${sample}`);
  }
}
assert.ok(grammarProjections > 20, 'ordinary words with inline formatting must use projection, not always fall back');
const crlf = projectionSource.replaceAll('\n', '\r\n'), crlfBefore = sourceContext(crlf, 4);
const crlfChanges = ChangeSet.of({ from: crlf.indexOf('Editable') + 3, insert: '中文' }, crlfBefore.doc.length);
const crlfDoc = crlfChanges.apply(crlfBefore.doc), crlfTree = outerParser.parse(crlfDoc.toString());
const crlfProjected = projectMarkdownDocumentContext(crlfBefore, crlfDoc, crlfTree, 4, crlfChanges);
assert.ok(crlfProjected); assert.deepEqual(facts(crlfProjected), facts(sourceContext(crlfDoc.toString(), 4)), 'source facts retain physical CRLF offsets');

for (const kind of ['prefix', 'suffix', 'definition'] as const) {
  const text = '> Reference[^n].\n\n[^n]: Definition body\n\n    continuation\n';
  let before = EditorState.create({ doc: text, extensions: editorMarkdownLanguage });
  ensure(before, before.doc.length, 2_000); before = before.update({}).state;
  const parsed = parseFootnotes(before), reference = parsed.references[0]!;
  const edit = kind === 'definition' ? text.indexOf('body') : kind === 'prefix' ? reference.containerFrom : reference.containerTo;
  let after = before.update({ changes: { from: edit, insert: 'word' } }).state;
  ensure(after, after.doc.length, 2_000); after = after.update({}).state;
  const changes = ChangeSet.of({ from: edit, insert: 'word' }, before.doc.length);
  let fresh = EditorState.create({ doc: after.doc, extensions: editorMarkdownLanguage });
  ensure(fresh, fresh.doc.length, 2_000); fresh = fresh.update({}).state;
  const expected = parseFootnotes(fresh);
  assert.ok(projectUnchangedFootnotes(before, after, changes, kind === 'definition' ? { editedDefinition: parsed.definitions[0] }
    : { container: { before: { from: reference.containerFrom, to: reference.containerTo },
      after: { from: expected.references[0]!.containerFrom, to: expected.references[0]!.containerTo } } }));
  const projected = parseFootnotes(after);
  assert.deepEqual(projected, expected, 'surface footnote projection keeps actual paragraph edges and edited definition metadata');
  assert.equal(projected.references[0]!.definition, projected.definitions[0]);
  assert.equal(projected.referencesByContainerKey.values().next().value![0], projected.references[0]);
}
console.log('Structural snapshots and ordinary-prose source-context projection match full discovery, including undo and rejected structural edits');
