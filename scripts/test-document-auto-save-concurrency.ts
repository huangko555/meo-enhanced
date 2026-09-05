import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import type { InitMessage } from '../src/protocol/readyInit';
import { createDocumentSessionWebviewAdapter } from '../webview/src/adapters/documentSessionWebviewAdapter';
import { createDocumentSaveFlushWebviewAdapter } from '../webview/src/adapters/documentSaveFlushWebviewAdapter';

type WillSaveEvent = { document: unknown; reason: number; waitUntil(value: Promise<void>): void };
let willSave: (event: WillSaveEvent) => void = () => undefined;
mock.module('vscode', () => ({
  TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
  workspace: { onWillSaveTextDocument(listener: typeof willSave) {
    willSave = listener;
    return { dispose() {} };
  } }
}));
const { createVscodeDocumentSaveLifecycleAdapter } = await import('../src/host/vscodeDocumentSaveLifecycleAdapter');

// Exercise the production session and both flush endpoints. Only VS Code I/O
// and transport scheduling are substituted to make the race windows exact.
for (const timing of ['idle', 'snapshot', 'transport'] as const) {
  for (const reason of [1, 2, 3]) {
    let editorText = 'first edit';
    let diskText = 'initial';
    const document = {
      uri: { toString: () => 'file:///auto-save-concurrency.md' },
      text: editorText,
      version: 2,
      getText() { return this.text; }
    };
    const failures: string[] = [];
    const errors: unknown[] = [];
    let requests = 0;
    let edited = false;
    const session = createDocumentSessionWebviewAdapter({
      postMessage(message) {
        if (message.type !== 'applyChanges') return;
        assert.equal(message.baseVersion, document.version);
        for (const change of [...message.changes].reverse()) {
          document.text = document.text.slice(0, change.from) + change.insert + document.text.slice(change.to);
        }
        document.version++;
        session.accept({ type: 'applied', version: document.version });
      },
      presentText() { errors.push('Unexpected external presentation'); },
      restoreReloadedView() {},
      showFailureNotice(message) { failures.push(message); },
      reportUnexpectedError(_context, error) { errors.push(error); }
    });
    const typeNextEdit = () => {
      edited = true;
      editorText = 'second edit';
      session.localDraftChanged(editorText);
    };
    const flush = createDocumentSaveFlushWebviewAdapter({
      commitTransientEdits() {},
      getCurrentText: () => {
        if (timing === 'snapshot' && !edited) typeNextEdit();
        return editorText;
      },
      whenDocumentIdle: () => session.whenIdle(),
      postMessage(message) {
        if (message.type !== 'flushDocumentEditsResult') return;
        if (timing === 'transport' && !edited) {
          typeNextEdit();
          void session.whenIdle().then(() => lifecycle.accept(message));
        } else lifecycle.accept(message);
      }
    });
    const lifecycle = createVscodeDocumentSaveLifecycleAdapter({
      document: document as never,
      async postMessage(message) {
        requests++;
        flush.accept(message);
        if (timing === 'idle' && !edited) typeNextEdit();
        return true;
      },
      showFailure(message) { failures.push(message); }
    });
    session.start({
      type: 'init', documentId: document.uri.toString(), text: document.text,
      version: document.version, savedRevision: { version: 1, text: diskText }
    } as InitMessage);
    await session.whenIdle();
    const waiters: Promise<void>[] = [];
    willSave({ document, reason, waitUntil(value) { waiters.push(value); } });
    await Promise.all(waiters);
    diskText = document.text;
    assert.equal(diskText, editorText, `${timing}/${reason}: final accepted input must reach disk`);
    assert.deepEqual(failures, [], `${timing}/${reason}: accepted concurrent input must not cause a save warning`);
    assert.deepEqual(errors, []);
    assert.equal(requests, timing === 'transport' ? 2 : 1);
    lifecycle.dispose();
    flush.dispose();
    session.dispose();
  }
}

console.log('Document auto-save concurrency checks passed');
