import assert from 'node:assert/strict';
import { createPendingDraftRecovery } from '../src/application/pendingDraftRecovery';
import { createDraftRecoveryReceiver } from '../src/host/draftRecoveryReceiver';
import { createDocumentSessionWebviewAdapter } from '../webview/src/adapters/documentSessionWebviewAdapter';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import type { InitMessage } from '../src/protocol/readyInit';
import type { DraftRecoveryMessage } from '../src/protocol/documentSync';

const initial = 'base 😀\n'.repeat(40_000);
let recovered = '';
const recovery = createPendingDraftRecovery({
  readCurrentText: () => initial,
  applyDraft: async (_base, text) => { recovered = text; return true; }
});
let requested = 0;
const receiver = createDraftRecoveryReceiver(recovery, () => { requested += 1; });
const messages: DraftRecoveryMessage[] = [];
let dropPatch = false;
const adapter = createDocumentSessionWebviewAdapter({
  postMessage: raw => {
    const message = decodeWebviewToHostMessage(raw);
    assert.ok(message, 'production encoder output must pass the Protocol decoder');
    if (message.type === 'draftChanged' || message.type === 'draftPatched') {
      messages.push(message);
      if (!dropPatch || message.type !== 'draftPatched') receiver.accept(message);
    }
  },
  presentText: () => true,
  restoreReloadedView: () => undefined,
  showNotice: notice => { throw new Error(notice); },
  reportUnexpectedError: (_context, error) => { throw error; }
});
adapter.start({ type: 'init', documentId: 'file:///recovery.md', text: initial, version: 1,
  savedRevision: { version: 1, text: initial } } as InitMessage);
let latest = initial + 'one';
adapter.localDraftChanged(latest);
await adapter.whenIdle();
assert.equal(await recovery.recover(), true);
assert.equal(recovered, latest);
for (const suffix of ['😀', '😁', '\nsecond\n', '', 'replacement']) {
  latest = initial + suffix;
  adapter.localDraftChanged(latest);
  await adapter.whenIdle();
  assert.equal(await recovery.recover(), latest !== initial);
  if (latest !== initial) assert.equal(recovered, latest);
}
assert.ok(messages.some(message => message.type === 'draftPatched'));
adapter.accept({ type: 'applied', version: 2 });
await adapter.whenIdle();
assert.equal(await recovery.recover(), true, 'an acknowledgement of an older edit must retain the newer pending draft');
assert.equal(recovered, latest);

// A lost checkpoint must neither corrupt the surviving candidate nor advance
// its receipt. Repair comes through the real lifecycle Adapter, without a new
// Domain receipt or another document synchronizer.
dropPatch = true;
adapter.localDraftChanged(initial + 'lost checkpoint');
await adapter.whenIdle();
dropPatch = false;
latest = initial + 'latest after missing checkpoint 😀';
adapter.localDraftChanged(latest);
await adapter.whenIdle();
assert.equal(requested, 1);
assert.equal(await recovery.recover(), false);
const request = decodeHostToWebviewMessage({ type: 'requestDraftRecoverySnapshot' });
assert.ok(request);
assert.equal(adapter.accept(request), true);
await adapter.whenIdle();
assert.equal(messages.at(-1)?.type, 'draftChanged');
assert.equal(await recovery.recover(), true);
assert.equal(recovered, latest);
const latestReceipt = messages.at(-1)!.receiptVersion;
receiver.accept(messages[0]!);
assert.equal(await recovery.recover(), false, 'stale snapshots must not revive a recovered draft');

receiver.accept({ type: 'draftPatched', baseReceiptVersion: latestReceipt,
  receiptVersion: latestReceipt + 1, change: { from: 0, to: latest.length + 1, insert: 'bad' } });
await Promise.resolve();
assert.equal(requested, 2);
assert.equal(await recovery.recover(), false, 'out-of-bounds patches must never change recovery');
receiver.accept({ type: 'draftChanged', text: latest, receiptVersion: latestReceipt + 1 });
assert.equal(recovery.discardIfCurrent(latestReceipt), false);
assert.equal(recovery.discardIfCurrent(latestReceipt + 1), true);
assert.equal(await recovery.recover(), false);
receiver.accept({ type: 'draftPatched', baseReceiptVersion: latestReceipt + 1,
  receiptVersion: latestReceipt + 2, change: { from: latest.length, to: latest.length, insert: ' after discard' } });
assert.equal(await recovery.recover(), true, 'discarding recovery must not discard its transport checkpoint');
assert.equal(recovered, latest + ' after discard');

const valid = { type: 'draftPatched', baseReceiptVersion: 1, receiptVersion: 2,
  change: { from: 0, to: 1, insert: '😁' } } as const;
assert.deepEqual(decodeWebviewToHostMessage(valid), valid);
const batch = { type: 'draftPatched', baseReceiptVersion: latestReceipt + 2, receiptVersion: latestReceipt + 3,
  changes: [{ from: 0, to: 2, insert: '中文' }, { from: 10, to: 10, insert: '😀\n' }] } as const;
assert.deepEqual(decodeWebviewToHostMessage(batch), batch);
receiver.accept(batch);
assert.equal(await recovery.recover(), true);
const batchBase = latest + ' after discard';
assert.equal(recovered, '中文' + batchBase.slice(2, 10) + '😀\n' + batchBase.slice(10));
for (const changes of [
  [{ from: 2, to: 4, insert: '' }, { from: 3, to: 5, insert: '' }],
  [{ from: 4, to: 4, insert: '' }, { from: 1, to: 2, insert: '' }],
  [{ from: 0, to: 1, insert: null }]
]) assert.equal(decodeWebviewToHostMessage({ ...batch, changes }), null);
assert.equal(decodeWebviewToHostMessage({ ...batch, change: valid.change }), null);
for (const invalid of [
  { ...valid, baseReceiptVersion: -1 }, { ...valid, receiptVersion: 1 },
  { ...valid, receiptVersion: 1.5 }, { ...valid, change: { from: -1, to: 1, insert: '' } },
  { ...valid, change: { from: 2, to: 1, insert: '' } },
  { ...valid, change: { from: 0, to: 1, insert: null } }
]) assert.equal(decodeWebviewToHostMessage(invalid), null);
let failedRequests = 0;
const unreachable = createDraftRecoveryReceiver(recovery, () => { failedRequests += 1; return false; });
unreachable.accept(valid);
for (let index = 0; index < 5; index += 1) await Promise.resolve();
unreachable.accept(valid);
await Promise.resolve();
assert.equal(failedRequests, 2, 'a failed delivery must allow a later input to request repair again');
adapter.dispose();
console.log('Draft recovery checkpoint, loss repair, stale receipt, discard and Unicode checks passed');
