import assert from 'node:assert/strict';
import { markdownLanguage } from '@codemirror/lang-markdown';
import { ChangeSet, Text } from '@codemirror/state';
import { DocInput } from '@codemirror/language';
import { NodeProp, Tree, TreeFragment } from '@lezer/common';
import { inlineMarkdownExtensions } from '../webview/src/helpers/inlineMarkdownParser';
import { createMarkdownTreeEncoder, createMarkdownTreeReceiver } from '../webview/src/editor/markdownTreeTransfer';

const parser = markdownLanguage.parser.configure([...inlineMarkdownExtensions, { remove: ['Emoji'] }]);
const encoder = createMarkdownTreeEncoder(), receiver = createMarkdownTreeReceiver(parser.nodeSet);
let doc = Text.of(('# Heading\n\nParagraph **bold** and [a link](https://example.test).\n\n'
  + '> - quoted item[^note]\n\n| A | B |\n| --- | --- |\n| one | two |\n\n'
  + '```javascript\nconst value = 1;\n```\n\n').repeat(1_000).split('\n'));
let tree = parser.parse(new DocInput(doc)), fragments = TreeFragment.addTree(tree);
const initial = encoder.encode(tree), copy = structuredClone(initial.value, { transfer: initial.transfers });
assert.equal(receiver.receive(copy).toString(), tree.toString());
const count = encoder.retainedNodes;
assert.equal(count, receiver.retainedNodes);
assert.equal(encoder.encode(tree).value.records.length, 0, 'identical revisions send no syntax objects');
// Receiving every revision includes stale presentations; graph ownership stays
// synchronized even when a caller only presents the last one.
let maxPatch = 0;
for (let index = 0; index < 40; index++) {
  const changes = ChangeSet.of({ from: 20, insert: index % 3 ? 'x' : '\n' }, doc.length);
  const ranges: Array<{ fromA: number; toA: number; fromB: number; toB: number }> = [];
  changes.iterChangedRanges((fromA, toA, fromB, toB) => ranges.push({ fromA, toA, fromB, toB }));
  fragments = TreeFragment.applyChanges(fragments, ranges);
  doc = changes.apply(doc); tree = parser.parse(new DocInput(doc), fragments);
  fragments = TreeFragment.addTree(tree, fragments);
  const patch = encoder.encode(tree); maxPatch = Math.max(maxPatch, patch.value.records.length);
  const received = receiver.receive(structuredClone(patch.value, { transfer: patch.transfers }));
  assert.equal(received.toString(), tree.toString(), `incremental transfer ${index} preserves every node and offset`);
  assert.equal(encoder.retainedNodes, receiver.retainedNodes);
  assert.ok(receiver.retainedNodes < count * 1.2, 'obsolete revisions must retire instead of accumulating');
}
assert.ok(maxPatch < count / 4, `local edits must retain shared branches: ${maxPatch} / ${count}`);

const first = parser.parse('one **bold**'), second = parser.parse('two *emphasis*');
for (const root of [first, second, first]) {
  const patch = encoder.encode(root);
  assert.equal(receiver.receive(structuredClone(patch.value, { transfer: patch.transfers })).toString(), root.toString(),
    'an externally retained old tree can return after its wire nodes were retired');
}
assert.ok(receiver.retainedNodes < 20, 'changing to a tiny document retires the prior large graph');
const marked = new Tree(first.type, first.children, first.positions, first.length,
  [[NodeProp.contextHash, 123], [NodeProp.lookAhead, 5]]);
const markedPatch = encoder.encode(marked);
const markedCopy = receiver.receive(structuredClone(markedPatch.value, { transfer: markedPatch.transfers }));
assert.equal(markedCopy.prop(NodeProp.contextHash), 123);
assert.equal(markedCopy.prop(NodeProp.lookAhead), 5);
assert.throws(() => receiver.receive({ root: 999_999, records: [] }), /Unknown Markdown syntax root/);
assert.equal(receiver.retainedNodes, 0, 'a corrupt response retires the graph before the worker is reset');
encoder.clear(); receiver.clear();
assert.equal(encoder.retainedNodes, 0);
console.log(`Markdown tree transfer: ${count} initial objects, at most ${maxPatch} per edit; exact structure, shared identity and revision retirement passed`);
