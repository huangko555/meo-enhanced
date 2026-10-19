import assert from 'node:assert/strict';
import { createDocumentSessionWebviewAdapter } from '../webview/src/adapters/documentSessionWebviewAdapter';
import type { InitMessage } from '../src/protocol/readyInit';
import type { WebviewToHostMessage } from '../src/protocol/messages';

const initial = 'paragraph 😀\n'.repeat(65_536);
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
