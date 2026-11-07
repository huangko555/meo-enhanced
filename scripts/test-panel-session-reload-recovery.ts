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
const pageId = 'page_panel_reload';
const document = createPanelSessionTestDocument(documentUri, 'accepted');

let diskText = 'disk version';

class FakeRange {
  constructor(readonly start: { offset: number }, readonly end: { offset: number }) {}
}
class FakeWorkspaceEdit {
  replace(_uri: PanelSessionTestUri, range: { start: { offset: number }; end: { offset: number } }, text: string): void {
    document.text = document.text.slice(0, range.start.offset) + text + document.text.slice(range.end.offset);
    document.version += 1;
    document.isDirty = true;
  }
}

mock.module('vscode', () => createPanelSessionVscodeMock(document, {
  Range: FakeRange as never,
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
  const recoveryCopies: string[] = [];
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
    readCurrentRevision: () => ({ version: document.version, text: document.text }),
    applyDraft: async (_expected, draftText) => {
      document.text = draftText;
      document.version += 1;
      document.isDirty = true;
      return true;
    },
    preserveConflict: async (copyText) => {
      recoveryCopies.push(copyText);
      return true;
    }
  });
  let baselinePublishCount = 0;
  const controller = createPanelSessionController(createPanelSessionControllerParams({
    panel,
    document,
    pendingDraftRecovery,
    readDiskText: () => diskText,
    overrides: {
      diffBaselineOutput: {
        hash: () => 'baseline',
        publish: async () => {
          baselinePublishCount += 1;
          return true;
        },
        publishFixedState: async () => undefined
      }
    }
  }) as never);
  return {
    controller,
    postedToWebview,
    getReceiveMessage: () => receiveMessage,
    getBaselinePublishCount: () => baselinePublishCount,
    getRecoveryCopies: () => recoveryCopies
  };
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
await controller.handleMessage({ type: 'ready', pageId });

let finishPresentation!: (presented: boolean) => void;
const presentation = new Promise<boolean>((resolve) => { finishPresentation = resolve; });
let webviewDisposed = false;
const hostMessages: unknown[] = [];
const webview = createDocumentSessionWebviewAdapter({
  pageId,
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
  showNotice: () => undefined,
  reportUnexpectedError: (context, error) => {
    throw new Error(`${context}: ${String(error)}`);
  }
});

webview.start({
  type: 'init', pageId,
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
  await fixture.controller.handleMessage({ type: 'ready', pageId });
  const recoveryEffects: Array<{ text: string | null; receiptVersion: number; terminal?: true }> = [];
  let closed = false;
  const appliedBeforeEdit = createDocumentSessionWebviewAdapter({
    pageId,
    postMessage: (message) => {
      if (message.type === 'draftChanged') {
        recoveryEffects.push({
          text: message.text,
          receiptVersion: message.receiptVersion,
          ...(message.terminal === true ? { terminal: true as const } : {})
        });
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
    showNotice: () => undefined,
    reportUnexpectedError: (context, error) => {
      throw new Error(`${context}: ${String(error)}`);
    }
  });

  appliedBeforeEdit.start({
    type: 'init', pageId,
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
      { text: 'Draft after Host ack', receiptVersion: 3 },
      { text: 'Draft after Host ack', receiptVersion: 3, terminal: true }
    ],
    recoveredText: 'Draft after Host ack'
  }, 'one ordered receipt owner must preserve a Draft queued after a Host acknowledgement');
}

{
  const fixture = createHostFixture();
  await fixture.controller.handleMessage({ type: 'ready', pageId });
  await fixture.controller.handleMessage({ type: 'draftChanged', pageId, text: 'discard after success', baseVersion: document.version, receiptVersion: 1 });
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
  const fixture = createHostFixture('disk version', 'disk version');
  await fixture.controller.handleMessage({ type: 'ready', pageId });
  await flushMicrotasks();
  const baselinePostsBeforeReload = fixture.getBaselinePublishCount();
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted',
    reloadId: reloadIdFrom(fixture.postedToWebview),
    presented: true,
    receiptVersion: 0
  });
  await flushMicrotasks();
  assert.ok(
    fixture.getBaselinePublishCount() > baselinePostsBeforeReload,
    'a successful disk reload must republish an unchanged baseline so a timed-out comparison retries'
  );
  fixture.controller.dispose();
}

{
  const fixture = createHostFixture('disk version', 'disk version');
  await fixture.controller.handleMessage({ type: 'ready', pageId });
  await flushMicrotasks();
  await fixture.controller.handleMessage({
    type: 'saveDocumentRevision',
    requestId: 'prime-save-checkpoint',
    revision: { version: document.version, text: document.text }
  });
  await flushMicrotasks();
  const baselinePostsAfterPrimeSave = fixture.getBaselinePublishCount();
  await fixture.controller.handleMessage({
    type: 'saveDocumentRevision',
    requestId: 'retry-comparison-save',
    revision: { version: document.version, text: document.text }
  });
  await flushMicrotasks();
  assert.ok(
    fixture.getBaselinePublishCount() > baselinePostsAfterPrimeSave,
    'a successful unchanged save must republish the baseline so a timed-out comparison retries'
  );
  fixture.controller.dispose();
}

{
  const fixture = createHostFixture();
  await fixture.controller.handleMessage({ type: 'ready', pageId });
  await fixture.controller.handleMessage({ type: 'draftChanged', pageId, text: 'retain after failure', baseVersion: document.version, receiptVersion: 1 });
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted',
    reloadId: reloadIdFrom(fixture.postedToWebview),
    presented: false,
    receiptVersion: 1
  });
  assert.equal(await closeAndReadRecoveredText(fixture.controller), 'disk version', 'a failed presentation acknowledgement must not overwrite the disk revision');
  assert.match(fixture.getRecoveryCopies()[0] ?? '', /retain after failure/, 'failure retains local recovery in an untitled conflict copy');
}

{
  const fixture = createHostFixture();
  await fixture.controller.handleMessage({ type: 'ready', pageId });
  await fixture.controller.handleMessage({ type: 'draftChanged', pageId, text: 'retain after stale receipt', baseVersion: document.version, receiptVersion: 1 });
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted',
    reloadId: 999,
    presented: true,
    receiptVersion: 1
  });
  assert.equal(await closeAndReadRecoveredText(fixture.controller), 'disk version', 'a stale acknowledgement must not overwrite the disk revision');
  assert.match(fixture.getRecoveryCopies()[0] ?? '', /retain after stale receipt/, 'stale receipt retains local recovery in an untitled conflict copy');
}

{
  const fixture = createHostFixture();
  await fixture.controller.handleMessage({ type: 'ready', pageId });
  await fixture.controller.handleMessage({ type: 'draftChanged', pageId, text: 'first Draft', baseVersion: document.version, receiptVersion: 1 });
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  const reloadId = reloadIdFrom(fixture.postedToWebview);
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted', reloadId, presented: true, receiptVersion: 1
  });
  await fixture.controller.handleMessage({ type: 'draftChanged', pageId, text: 'Draft after first receipt', baseVersion: document.version, receiptVersion: 2 });
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
  await fixture.controller.handleMessage({ type: 'ready', pageId });
  await fixture.controller.handleMessage({ type: 'draftChanged', pageId, text: 'older Draft', baseVersion: document.version, receiptVersion: 1 });
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  const reloadId = reloadIdFrom(fixture.postedToWebview);
  await fixture.controller.handleMessage({ type: 'draftChanged', pageId, text: 'newer Draft', baseVersion: document.version, receiptVersion: 2 });
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted', reloadId, presented: true, receiptVersion: 2
  });
  assert.equal(await closeAndReadRecoveredText(fixture.controller), 'newer Draft', 'newer Draft retains recovery');
}

{
  const closing = createHostFixture();
  await closing.controller.handleMessage({ type: 'ready', pageId });
  await closing.controller.handleMessage({ type: 'draftChanged', pageId, text: 'Draft recovered on reopen', baseVersion: document.version, receiptVersion: 1 });
  assert.equal(
    await closeAndReadRecoveredText(closing.controller),
    'Draft recovered on reopen',
    'panel close retains and applies recovery'
  );
  const reopened = createHostFixture(document.text);
  await reopened.controller.handleMessage({ type: 'ready', pageId });
  const init = reopened.postedToWebview.find((message) => message.type === 'init');
  assert.equal(init?.text, 'Draft recovered on reopen', 'reopened panel presents the recovered Draft');
  assert.equal(init?.uiLanguage, 'en', 'new panels receive one resolved UI language value');
  reopened.controller.dispose();
  await flushMicrotasks();
}

// Developer: Reload Webviews replaces only the iframe. The prior page's
// recovery must be settled before the new Init, then the new page is allowed
// to restart receipts at one. A late unseen prior-page final receipt is kept
// as an untitled copy and never overwrites the new page's current Host text.
{
  const firstPageId = 'page_generation_first';
  const secondPageId = 'page_generation_second';
  const thirdPageId = 'page_generation_third';
  const fixture = createHostFixture('Host text', 'Host text');
  await fixture.controller.handleMessage({ type: 'ready', pageId: firstPageId });
  await fixture.controller.handleMessage({
    type: 'draftChanged', pageId: firstPageId, text: 'pending reload page one',
    baseVersion: document.version, receiptVersion: 1
  });
  await fixture.controller.handleMessage({ type: 'ready', pageId: secondPageId });
  const secondInit = fixture.postedToWebview.filter(message => message.type === 'init').at(-1);
  assert.deepEqual({ pageId: secondInit?.pageId, text: secondInit?.text }, {
    pageId: secondPageId, text: 'pending reload page one'
  }, 'a new page initializes from safely settled predecessor recovery, not stale native text');
  await fixture.controller.handleMessage({
    type: 'draftChanged', pageId: secondPageId, text: 'pending close page two',
    baseVersion: document.version, receiptVersion: 1
  });
  await fixture.controller.handleMessage({ type: 'ready', pageId: thirdPageId });
  const thirdInit = fixture.postedToWebview.filter(message => message.type === 'init').at(-1);
  assert.deepEqual({ pageId: thirdInit?.pageId, text: thirdInit?.text }, {
    pageId: thirdPageId, text: 'pending close page two'
  }, 'the next replacement also settles the page-two receipt-one candidate');
  await fixture.controller.handleMessage({
    type: 'draftChanged', pageId: firstPageId, text: 'late page one final',
    baseVersion: 1, terminal: true, receiptVersion: 3
  });
  await fixture.controller.handleMessage({
    type: 'draftChanged', pageId: firstPageId, text: 'late page one final',
    baseVersion: 1, terminal: true, receiptVersion: 3
  });
  await fixture.controller.handleMessage({
    type: 'draftChanged', pageId: thirdPageId, text: 'pending close page three',
    baseVersion: document.version, receiptVersion: 1
  });
  await flushMicrotasks();
  fixture.controller.dispose();
  await flushMicrotasks();
  assert.equal(document.text, 'pending close page three',
    'each new-page receipt one survives to the next real close and is not rejected by prior high-water marks');
  assert.match(fixture.getRecoveryCopies().at(-1) ?? '', /late page one final/,
    'a late unseen predecessor receipt is retained non-destructively rather than dropped or applied');
  assert.equal(fixture.getRecoveryCopies().filter(copy => copy.includes('late page one final')).length, 1,
    'a duplicate terminal packet is bounded by page/receipt de-duplication');
}

{
  const firstPageId = 'page_reload_ack_first';
  const secondPageId = 'page_reload_ack_second';
  const fixture = createHostFixture('Host text', 'disk text');
  await fixture.controller.handleMessage({ type: 'ready', pageId: firstPageId });
  await fixture.controller.handleMessage({
    type: 'draftChanged', pageId: firstPageId, text: 'first page pending',
    baseVersion: document.version, receiptVersion: 1
  });
  await fixture.controller.handleMessage({ type: 'reloadDocumentFromDisk', topLine: 1, topLineOffset: 0 });
  const oldReloadId = reloadIdFrom(fixture.postedToWebview);
  await fixture.controller.handleMessage({ type: 'ready', pageId: secondPageId });
  await fixture.controller.handleMessage({
    type: 'draftChanged', pageId: secondPageId, text: 'second page pending',
    baseVersion: document.version, receiptVersion: 1
  });
  await fixture.controller.handleMessage({
    type: 'documentReloadPresentationCompleted', reloadId: oldReloadId, presented: true, receiptVersion: 1
  });
  fixture.controller.dispose();
  await flushMicrotasks();
  assert.equal(document.text, 'second page pending',
    'a late old-page disk-reload acknowledgement cannot discard a same-number new-page receipt');
}

console.log('Panel Session reload recovery checks passed');
