import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import {
  createPanelSessionControllerParams,
  createPanelSessionTestDocument,
  createPanelSessionTestUri,
  createPanelSessionVscodeMock,
  panelSessionDisposable,
  type PanelSessionTestUri
} from './panel-session-test-helper';

const documentUri = createPanelSessionTestUri('C:/reload-recovery.md');
const document = createPanelSessionTestDocument(documentUri, 'accepted');

let diskText = 'disk version';

class FakeWorkspaceEdit {
  replace(_uri: PanelSessionTestUri, _range: unknown, text: string): void {
    document.text = text;
    document.version += 1;
    document.isDirty = true;
  }
}

mock.module('vscode', () => createPanelSessionVscodeMock(document, {
  WorkspaceEdit: FakeWorkspaceEdit,
  executeCommand: async (command) => {
    if (command === 'workbench.action.files.revert') {
      document.text = diskText;
      document.version += 1;
      document.isDirty = false;
    }
    return undefined;
  }
}));

const [{ createPanelSessionController }, { createPendingDraftRecovery }, {
  createDocumentSessionWebviewAdapter
}] = await Promise.all([
  import('../src/extension/panelSession'),
  import('../src/application/pendingDraftRecovery'),
  import('../webview/src/adapters/documentSessionWebviewAdapter')
]);

const flushMicrotasks = async (): Promise<void> => {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
};

const createHostFixture = (initialText = 'accepted', nextDiskText = 'disk version') => {
  document.text = initialText;
  document.version = 1;
  document.isDirty = true;
  diskText = nextDiskText;
  const postedToWebview: Array<Record<string, unknown>> = [];
  let receiveMessage: ((message: unknown) => void) | null = null;
  const panel = {
    active: true,
    webview: {
      postMessage: async (message: Record<string, unknown>) => {
        postedToWebview.push(message);
        return true;
      },
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        receiveMessage = listener;
        return panelSessionDisposable();
      }
    },
    onDidChangeViewState: () => panelSessionDisposable(),
    onDidDispose: () => panelSessionDisposable()
  };
  const pendingDraftRecovery = createPendingDraftRecovery({
    readCurrentText: () => document.text,
    applyDraft: async (_expectedCurrentText, draftText) => {
      document.text = draftText;
      document.version += 1;
      document.isDirty = true;
      return true;
    }
  });
  const controller = createPanelSessionController(createPanelSessionControllerParams({
    panel,
    document,
    pendingDraftRecovery,
    readDiskText: () => diskText
  }) as never);
  return { controller, postedToWebview, getReceiveMessage: () => receiveMessage };
};

const reloadIdFrom = (messages: readonly Record<string, unknown>[]): number => {
  const reload = messages.find((message) => message.type === 'documentReloadedFromDisk');
  assert.ok(reload, 'Host must post the disk Revision through the controller Interface');
  assert.equal(typeof reload.reloadId, 'number');
  return reload.reloadId as number;
};

const closeAndReadRecoveredText = async (
  controller: ReturnType<typeof createHostFixture>['controller']
): Promise<string> => {
  controller.dispose();
  await flushMicrotasks();
  return document.text;
};

const immediateCloseFixture = createHostFixture();
const { controller, postedToWebview } = immediateCloseFixture;

let finishPresentation!: (presented: boolean) => void;
const presentation = new Promise<boolean>((resolve) => { finishPresentation = resolve; });
let webviewDisposed = false;
const hostMessages: unknown[] = [];
const webview = createDocumentSessionWebviewAdapter({
  postMessage: (message) => {
    hostMessages.push(message);
    void controller.handleMessage(message);
    if (message.type === 'documentReloadPresentationCompleted') {
      webview.dispose();
      webviewDisposed = true;
    }
  },
  presentText: () => presentation,
  restoreReloadedView: () => undefined,
  showFailureNotice: () => undefined,
  reportUnexpectedError: (context, error) => {
    throw new Error(`${context}: ${String(error)}`);
  }
});

webview.start({
  type: 'init',
  documentId: documentUri.toString(),
  text: 'accepted',
  version: 1,
  savedRevision: { version: 1, text: 'accepted' }
} as never);
webview.localDraftChanged('last Host-confirmed Draft');
await webview.whenIdle();

await controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
const reloadMessage = postedToWebview.find((message) => message.type === 'documentReloadedFromDisk');
assert.ok(reloadMessage, 'Host must post the disk Revision through the controller Interface');
assert.equal(webview.accept(reloadMessage as never), true);
await flushMicrotasks();

webview.localDraftChanged('newer local Draft queued behind presentation');
finishPresentation(true);
await webview.whenIdle();
assert.equal(webviewDisposed, true, 'fixture must close immediately after the presentation receipt');

controller.dispose();
await flushMicrotasks();
assert.equal(
  document.text,
  'newer local Draft queued behind presentation',
  'the reload receipt must wait until Host has confirmed the newer queued Draft'
);

assert.equal(typeof immediateCloseFixture.getReceiveMessage(), 'function');

{
  const fixture = createHostFixture();
  const recoveryEffects: Array<{ text: string | null; receiptVersion: number }> = [];
  let closed = false;
  const appliedBeforeEdit = createDocumentSessionWebviewAdapter({
    postMessage: (message) => {
      if (message.type === 'draftChanged') {
        recoveryEffects.push({ text: message.text, receiptVersion: message.receiptVersion });
      }
      void fixture.controller.handleMessage(message);
      if (message.type === 'draftChanged' && message.text === 'Draft after Host ack') {
        appliedBeforeEdit.dispose();
        fixture.controller.dispose();
        closed = true;
      }
    },
    presentText: () => true,
    restoreReloadedView: () => undefined,
    showFailureNotice: () => undefined,
    reportUnexpectedError: (context, error) => {
      throw new Error(`${context}: ${String(error)}`);
    }
  });

  appliedBeforeEdit.start({
    type: 'init',
    documentId: documentUri.toString(),
    text: 'accepted',
    version: 1,
    savedRevision: { version: 1, text: 'accepted' }
  } as never);
  appliedBeforeEdit.localDraftChanged('Draft before Host ack');
  await appliedBeforeEdit.whenIdle();
  await flushMicrotasks();
  const applied = fixture.postedToWebview.find((message) => message.type === 'applied');
  assert.ok(applied, 'Host must acknowledge the first Change through panel.webview.postMessage');

  assert.equal(appliedBeforeEdit.accept(applied as never), true);
  appliedBeforeEdit.localDraftChanged('Draft after Host ack');
  await appliedBeforeEdit.whenIdle();
  await flushMicrotasks();

  assert.deepEqual({
    closed,
    recoveryEffects,
    recoveredText: document.text
  }, {
    closed: true,
    recoveryEffects: [
      { text: 'Draft before Host ack', receiptVersion: 1 },
      { text: null, receiptVersion: 2 },
      { text: 'Draft after Host ack', receiptVersion: 3 }
    ],
    recoveredText: 'Draft after Host ack'
  }, 'one ordered receipt owner must preserve a Draft queued after a Host acknowledgement');
}

{
  const fixture = createHostFixture();
  await fixture.controller.handleMessage({ type: 'draftChanged', text: 'discard after success', receiptVersion: 1 });
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted',
    reloadId: reloadIdFrom(fixture.postedToWebview),
    presented: true,
    receiptVersion: 1
  });
  assert.equal(await closeAndReadRecoveredText(fixture.controller), 'disk version', 'success clears recovery');
}

{
  const fixture = createHostFixture();
  await fixture.controller.handleMessage({ type: 'draftChanged', text: 'retain after failure', receiptVersion: 1 });
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted',
    reloadId: reloadIdFrom(fixture.postedToWebview),
    presented: false,
    receiptVersion: 1
  });
  assert.equal(await closeAndReadRecoveredText(fixture.controller), 'retain after failure', 'failure retains recovery');
}

{
  const fixture = createHostFixture();
  await fixture.controller.handleMessage({ type: 'draftChanged', text: 'retain after stale receipt', receiptVersion: 1 });
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted',
    reloadId: 999,
    presented: true,
    receiptVersion: 1
  });
  assert.equal(await closeAndReadRecoveredText(fixture.controller), 'retain after stale receipt', 'stale receipt retains recovery');
}

{
  const fixture = createHostFixture();
  await fixture.controller.handleMessage({ type: 'draftChanged', text: 'first Draft', receiptVersion: 1 });
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  const reloadId = reloadIdFrom(fixture.postedToWebview);
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted', reloadId, presented: true, receiptVersion: 1
  });
  await fixture.controller.handleMessage({ type: 'draftChanged', text: 'Draft after first receipt', receiptVersion: 2 });
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted', reloadId, presented: true, receiptVersion: 1
  });
  assert.equal(
    await closeAndReadRecoveredText(fixture.controller),
    'Draft after first receipt',
    'duplicate receipt retains the newer recovery candidate'
  );
}

{
  const fixture = createHostFixture();
  await fixture.controller.handleMessage({ type: 'draftChanged', text: 'older Draft', receiptVersion: 1 });
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  const reloadId = reloadIdFrom(fixture.postedToWebview);
  await fixture.controller.handleMessage({ type: 'draftChanged', text: 'newer Draft', receiptVersion: 2 });
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted', reloadId, presented: true, receiptVersion: 2
  });
  assert.equal(await closeAndReadRecoveredText(fixture.controller), 'newer Draft', 'newer Draft retains recovery');
}

{
  const closing = createHostFixture();
  await closing.controller.handleMessage({ type: 'draftChanged', text: 'Draft recovered on reopen', receiptVersion: 1 });
  assert.equal(
    await closeAndReadRecoveredText(closing.controller),
    'Draft recovered on reopen',
    'panel close retains and applies recovery'
  );
  const reopened = createHostFixture(document.text);
  await reopened.controller.handleMessage({ type: 'ready' });
  const init = reopened.postedToWebview.find((message) => message.type === 'init');
  assert.equal(init?.text, 'Draft recovered on reopen', 'reopened panel presents the recovered Draft');
  reopened.controller.dispose();
  await flushMicrotasks();
}

console.log('Panel Session reload recovery checks passed');
