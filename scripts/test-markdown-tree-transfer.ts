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
assert.ok(initial.transfers.length <= 2, 'initial syntax must use bounded binary transfers rather than one handle per packed node');
const receivedInitial = receiver.receive(copy);
assert.equal(receivedInitial.toString(), tree.toString());
const cooperative = createMarkdownTreeReceiver(parser.nodeSet);
const cooperativeEncoder = createMarkdownTreeEncoder();
let opportunities = 0;
const cooperativelyReceived = await cooperative.receiveAsync(cooperativeEncoder.encode(tree).value, async () => {
  opportunities++;
  await new Promise<void>(resolve => setTimeout(resolve, 0));
});
assert.equal(cooperativelyReceived.toString(), tree.toString(), 'cooperative reception preserves every node and position');
assert.ok(opportunities > 1, 'a large response must give input/paint multiple task opportunities before publication');
assert.equal(cooperative.retainedNodes, receiver.retainedNodes);
const tinyPacket = cooperativeEncoder.encode(parser.parse('tiny'));
opportunities = 0;
await cooperative.receiveAsync(tinyPacket.value, async () => { opportunities++; });
assert.ok(opportunities > 1, 'retiring a large previous revision must also yield');
assert.ok(cooperative.retainedNodes < 10);
const cancelled = createMarkdownTreeReceiver(parser.nodeSet);
await assert.rejects(cancelled.receiveAsync(copy, async () => { cancelled.clear(); }), /cancelled/);
assert.equal(cancelled.retainedNodes, 0, 'disposal during reception must not recreate retired graph entries');
const afterCancel = createMarkdownTreeEncoder().encode(parser.parse('after cancellation'));
assert.equal((await cancelled.receiveAsync(afterCancel.value, async () => {})).toString(), parser.parse('after cancellation').toString());
cooperative.clear(); cancelled.clear();
copy.buffers.fill(0);
assert.equal(receivedInitial.toString(), tree.toString(), 'retained branches own their bytes independently of the aggregate wire buffer');
const count = encoder.retainedNodes;
assert.equal(count, receiver.retainedNodes);
assert.equal(encoder.encode(tree).value.count, 0, 'identical revisions send no syntax objects');
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
  const patch = encoder.encode(tree); maxPatch = Math.max(maxPatch, patch.value.count);
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
const sparseRoot = 2 ** 40;
const sparse = createMarkdownTreeEncoder().encode(new Tree(first.type, [], [], 4,
  [[NodeProp.contextHash, -123], [NodeProp.lookAhead, 5]])).value;
sparse.records[0] = sparseRoot;
const sparseReceiver = createMarkdownTreeReceiver(parser.nodeSet);
const sparseTree = sparseReceiver.receive({ ...sparse, root: sparseRoot });
assert.equal(sparseTree.length, 4);
assert.equal(sparseTree.prop(NodeProp.contextHash), -123, 'binary metadata preserves signed context hashes and safe IDs above 32 bits');
sparseReceiver.clear();

const cleanPacket = () => createMarkdownTreeEncoder().encode(parser.parse('one **bold** and *emphasis*')).value;
for (const corrupt of [
  (value: ReturnType<typeof cleanPacket>) => ({ ...value, count: value.count + 1 }),
  (value: ReturnType<typeof cleanPacket>) => ({ ...value, records: value.records.slice(0, -1) }),
  (value: ReturnType<typeof cleanPacket>) => ({ ...value, buffers: value.buffers.slice(0, -1) }),
  (value: ReturnType<typeof cleanPacket>) => ({ ...value, buffers: new Uint16Array(value.buffers.length + 4) }),
  (value: ReturnType<typeof cleanPacket>) => { value.records[0] = NaN; return value; },
  (value: ReturnType<typeof cleanPacket>) => { value.records[2] = parser.nodeSet.types.length + 1; return value; }
]) {
  const invalid = createMarkdownTreeReceiver(parser.nodeSet);
  assert.throws(() => invalid.receive(corrupt(cleanPacket())), /Markdown syntax/);
  assert.equal(invalid.retainedNodes, 0, 'malformed binary packets retire every partially received branch');
  await assert.rejects(invalid.receiveAsync(corrupt(cleanPacket()), async () => {}), /Markdown syntax/);
  assert.equal(invalid.retainedNodes, 0, 'cooperative reception retains the same malformed-packet validation');
}
const invalidProps = { ...sparse, root: sparseRoot, records: sparse.records.slice() };
invalidProps.records[4] = Infinity;
assert.throws(() => createMarkdownTreeReceiver(parser.nodeSet).receive(invalidProps), /Invalid Markdown syntax properties/);
assert.throws(() => receiver.receive({ root: 999_999, count: 0, records: new Float64Array(), buffers: new Uint16Array() }), /Unknown Markdown syntax root/);
assert.equal(receiver.retainedNodes, 0, 'a corrupt response retires the graph before the worker is reset');
encoder.clear(); receiver.clear();
assert.equal(encoder.retainedNodes, 0);
console.log(`Markdown tree transfer: ${count} initial nodes in two buffers, at most ${maxPatch} per edit; exact structure, byte ownership, malformed packets and revision retirement passed`);
