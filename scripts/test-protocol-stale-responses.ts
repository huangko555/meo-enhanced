import assert from 'node:assert/strict';
import {
  getWikiLinkStatus,
  handleResolvedWikiLinks,
  initializeWikiLinkHandling,
  requestWikiLinkStatuses
} from '../webview/src/helpers/wikiLinks';
import {
  getLocalLinkStatus,
  handleResolvedLocalLinks,
  initializeLocalLinkHandling,
  requestLocalLinkStatuses
} from '../webview/src/helpers/localLinks';

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const wikiMessages: Array<{ type: string; requestId: string; targets: string[] }> = [];
initializeWikiLinkHandling({ postMessage: (message: typeof wikiMessages[number]) => wikiMessages.push(message) });
requestWikiLinkStatuses('[[Old]]');
const clearedWikiRequest = wikiMessages.at(-1)!;
requestWikiLinkStatuses('no wiki links');
assert.equal(handleResolvedWikiLinks({
  type: 'resolvedWikiLinks',
  requestId: clearedWikiRequest.requestId,
  result: { ok: true, value: { results: [{ target: 'Old', exists: true }] } }
}), true);
await flushPromises();
assert.equal(getWikiLinkStatus('Old'), null, 'A response invalidated by clearing Wiki Links must stay ignored');

requestWikiLinkStatuses('[[Older]]');
const olderWikiRequest = wikiMessages.at(-1)!;
requestWikiLinkStatuses('[[Latest]]');
const latestWikiRequest = wikiMessages.at(-1)!;
assert.equal(handleResolvedWikiLinks({
  type: 'resolvedWikiLinks',
  requestId: latestWikiRequest.requestId,
  result: { ok: true, value: { results: [{ target: 'Latest', exists: true }] } }
}), true);
assert.equal(handleResolvedWikiLinks({
  type: 'resolvedWikiLinks',
  requestId: olderWikiRequest.requestId,
  result: { ok: true, value: { results: [{ target: 'Older', exists: true }] } }
}), true);
assert.equal(handleResolvedWikiLinks({
  type: 'resolvedWikiLinks',
  requestId: olderWikiRequest.requestId,
  result: { ok: true, value: { results: [{ target: 'Older', exists: true }] } }
}), false, 'A duplicate Wiki Link response must not settle twice');
await flushPromises();
assert.equal(getWikiLinkStatus('Latest'), true);
assert.equal(getWikiLinkStatus('Older'), null, 'An out-of-order Wiki Link response must not replace the latest result');

const localMessages: Array<{ type: string; requestId: string; targets: string[] }> = [];
initializeLocalLinkHandling({ postMessage: (message: typeof localMessages[number]) => localMessages.push(message) });
requestLocalLinkStatuses('[Old](old.md)');
const clearedLocalRequest = localMessages.at(-1)!;
requestLocalLinkStatuses('no local links');
assert.equal(handleResolvedLocalLinks({
  type: 'resolvedLocalLinks',
  requestId: clearedLocalRequest.requestId,
  result: { ok: true, value: { results: [{ target: 'old.md', exists: true }] } }
}), true);
await flushPromises();
assert.equal(getLocalLinkStatus('old.md'), null, 'A response invalidated by clearing local links must stay ignored');

requestLocalLinkStatuses('[Older](older.md)');
const olderLocalRequest = localMessages.at(-1)!;
requestLocalLinkStatuses('[Latest](latest.md)');
const latestLocalRequest = localMessages.at(-1)!;
assert.equal(handleResolvedLocalLinks({
  type: 'resolvedLocalLinks',
  requestId: latestLocalRequest.requestId,
  result: { ok: true, value: { results: [{ target: 'latest.md', exists: true }] } }
}), true);
assert.equal(handleResolvedLocalLinks({
  type: 'resolvedLocalLinks',
  requestId: olderLocalRequest.requestId,
  result: { ok: true, value: { results: [{ target: 'older.md', exists: true }] } }
}), true);
assert.equal(handleResolvedLocalLinks({
  type: 'resolvedLocalLinks',
  requestId: olderLocalRequest.requestId,
  result: { ok: true, value: { results: [{ target: 'older.md', exists: true }] } }
}), false, 'A duplicate local-link response must not settle twice');
await flushPromises();
assert.equal(getLocalLinkStatus('latest.md'), true);
assert.equal(getLocalLinkStatus('older.md'), null, 'An out-of-order local-link response must not replace the latest result');

console.log('Protocol stale-response checks passed');
