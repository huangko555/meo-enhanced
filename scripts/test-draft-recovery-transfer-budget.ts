import assert from 'node:assert/strict';
import { createDocumentSessionWebviewAdapter } from '../webview/src/adapters/documentSessionWebviewAdapter';
import type { InitMessage } from '../src/protocol/readyInit';
import type { WebviewToHostMessage } from '../src/protocol/messages';
import { createDocumentTextReplacement } from '../src/foundation/documentText';
import { ChangeSet, Text } from '@codemirror/state';
import { documentEdit } from '../webview/src/adapters/documentSnapshot';

const initial = 'paragraph 😀\n'.repeat(65_536);
{
  const before = Text.of(['😀😁😃']);
  const changes = ChangeSet.of([
    { from: 1, to: 2, insert: '\uDE02' }, { from: 3, to: 4, insert: '\uDE04' }
  ], before.length);
  const after = changes.apply(before);
  const edit = documentEdit(changes, before, after);
  let actual = before.toString();
  for (const change of [...edit.changes].reverse()) {
    assert.equal(change.insert.isWellFormed(), true);
    actual = actual.slice(0, change.from) + change.insert + actual.slice(change.to);
  }
  assert.equal(actual, after.toString(), 'adjacent surrogate expansions must compose without overlapping');
}
{
  const original = String.prototype.charCodeAt;
  let scalarReads = 0;
  String.prototype.charCodeAt = function (index: number) {
    scalarReads += 1;
    return original.call(this, index);
  };
  try {
    const next = initial.slice(0, 450_000) + 'x' + initial.slice(450_000);
    const change = createDocumentTextReplacement(initial, next);
    assert.equal(initial.slice(0, change.from) + change.insert + initial.slice(change.to), next);
    assert.ok(scalarReads <= 16_400,
      `a one-character edit performed ${scalarReads} scalar UTF-16 reads across the entire document`);
  } finally { String.prototype.charCodeAt = original; }
}
// Exercise both chunk boundaries and surrogate-pair boundaries, including
// replacements that share only the high surrogate of a changed character.
for (let index = 0; index < 250; index += 1) {
  const before = ('abc😀\n'.repeat(1400)).slice(0, 4000 + index * 7) + '😁end';
  const from = (index * 97) % before.length;
  const to = Math.min(before.length, from + index % 17);
  const next = before.slice(0, from) + ['😁', '', '\nnew\n', 'plain'][index % 4] + before.slice(to);
  const change = createDocumentTextReplacement(before, next);
  assert.equal(before.slice(0, change.from) + change.insert + before.slice(change.to), next);
  const splitsPair = (text: string, offset: number) => /[\uD800-\uDBFF]/.test(text[offset - 1] ?? '')
    && /[\uDC00-\uDFFF]/.test(text[offset] ?? '');
  assert.equal(splitsPair(before, change.from) || splitsPair(before, change.to), false);
}
const messages: WebviewToHostMessage[] = [];
const adapter = createDocumentSessionWebviewAdapter({
  postMessage: message => { messages.push(message); },
  presentText: () => true,
  restoreReloadedView: () => undefined,
  showNotice: notice => { throw new Error(notice); },
  reportUnexpectedError: (_context, error) => { throw error; }
});
adapter.start({
  type: 'init', documentId: 'file:///transfer-budget.md', text: initial, version: 1,
  savedRevision: { version: 1, text: initial }
} as InitMessage);
let text = initial;
for (let index = 0; index < 32; index += 1) {
  text = text.slice(0, 450_000) + String.fromCharCode(97 + index % 26) + text.slice(450_000);
  adapter.localDraftChanged(text);
  await adapter.whenIdle();
  // Include the normal receipt/clear cycle; a clear must not force the next
  // keystroke to retransmit the same megabyte checkpoint.
  adapter.accept({ type: 'applied', version: index + 2 });
  await adapter.whenIdle();
}
const encodedCharacters = messages.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
assert.ok(encodedCharacters < initial.length * 2,
  `32 single-character edits serialized ${encodedCharacters} characters for a ${initial.length}-character document`);
adapter.dispose();
console.log(`Draft recovery transfer budget passed (${encodedCharacters} serialized characters)`);

// The production transaction seam must preserve edits through delayed Host ACKs,
// IME-sized batches and disjoint multi-cursor changes without reading full text.
{
  let value = Text.of(initial.split('\n'));
  const emitted: WebviewToHostMessage[] = [];
  const session = createDocumentSessionWebviewAdapter({
    postMessage: message => { emitted.push(message); }, presentText: () => true,
    restoreReloadedView: () => undefined, showNotice: notice => { throw new Error(notice); },
    reportUnexpectedError: (_context, error) => { throw error; }
  });
  session.start({ type: 'init', documentId: 'file:///transaction-budget.md', text: initial,
    version: 1, savedRevision: { version: 1, text: initial } } as InitMessage);
  let fullReads = 0;
  const edit = async (spec: Parameters<typeof ChangeSet.of>[0], allowCheckpoint = false) => {
    const changes = ChangeSet.of(spec, value.length);
    const next = changes.apply(value);
    const transaction = documentEdit(changes, value, next);
    const read = transaction.after.toString.bind(transaction.after);
    transaction.after.toString = () => { if (!allowCheckpoint) fullReads += 1; return read(); };
    value = next;
    session.localDraftChanged(transaction);
    await session.whenIdle();
  };
  await edit({ from: 450_000, insert: 'a' }, true);
  // Keep several local transactions ahead of the platform document.
  for (let index = 0; index < 24; index += 1) {
    await edit([{ from: 12, insert: 'x' }, { from: value.length - 12, insert: 'y' }]);
  }
  session.accept({ type: 'applied', version: 2 });
  await session.whenIdle();
  await edit({ from: 200, to: 202, insert: '中文' });
  session.accept({ type: 'applied', version: 3 });
  await session.whenIdle();
  session.accept({ type: 'applied', version: 4 });
  await session.whenIdle();
  assert.equal(fullReads, 0, 'ordinary transactions and ACKs must not materialize full document snapshots');
  let hostText = initial;
  let hostVersion = 1;
  for (const message of emitted) {
    if (message.type !== 'applyChanges') continue;
    assert.equal(message.baseVersion, hostVersion++);
    for (const change of [...message.changes].reverse()) {
      hostText = hostText.slice(0, change.from) + change.insert + hostText.slice(change.to);
    }
  }
  assert.equal(hostText, value.toString(), 'queued edits must compose against the acknowledged Host base');
  const size = emitted.reduce((sum, message) => sum + JSON.stringify(message).length, 0);
  assert.ok(size < initial.length * 1.1, `incremental transactions serialized ${size} characters`);
  session.dispose();
  console.log(`Transaction snapshot budget passed (${fullReads} full reads, ${size} serialized characters)`);
}
