import assert from 'node:assert/strict';
import { mock } from 'bun:test';
import {
  createPanelSessionControllerParams,
  createPanelSessionTestDocument,
  createPanelSessionTestUri,
  createPanelSessionVscodeMock,
  panelSessionDisposable,
  type PanelSessionTestDocument,
  type PanelSessionTestUri
} from './panel-session-test-helper';

type Message = Record<string, unknown>;

const documentUri = createPanelSessionTestUri('C:/native-save-flush.md');
const document = createPanelSessionTestDocument(
  documentUri,
  'outer Draft\n\n| old |\n| --- |',
  2
);

let diskText = 'accepted\n\n| old |\n| --- |';
type WillSaveEvent = {
  readonly document: PanelSessionTestDocument;
  readonly reason: number;
  waitUntil(thenable: PromiseLike<unknown>): void;
};

const willSaveListeners: Array<(event: WillSaveEvent) => void> = [];
const didSaveListeners: Array<(savedDocument: PanelSessionTestDocument) => void> = [];
const changeListeners: Array<(event: {
  readonly document: PanelSessionTestDocument;
  readonly contentChanges: readonly { readonly text: string }[];
}) => void> = [];
const warnings: string[] = [];

class FakeRange {
  constructor(
    readonly start: { readonly offset: number },
    readonly end: { readonly offset: number }
  ) {}
}

class FakeWorkspaceEdit {
  replacement: { readonly text: string } | null = null;
  replace(_uri: PanelSessionTestUri, _range: FakeRange, text: string): void {
    this.replacement = { text };
  }
}

let priorParticipantText: string | null = null;
let failNextWorkspaceApply = false;
let delayNextWorkspaceApply = true;
let releaseDelayedWorkspaceApply: () => void = () => undefined;
let noteDelayedWorkspaceApplyStarted: () => void = () => undefined;
const delayedWorkspaceApply = new Promise<void>((resolve) => {
  releaseDelayedWorkspaceApply = resolve;
});
const delayedWorkspaceApplyStarted = new Promise<void>((resolve) => {
  noteDelayedWorkspaceApplyStarted = resolve;
});

const applyWorkspaceEdit = async (edit: FakeWorkspaceEdit): Promise<boolean> => {
  if (!edit.replacement) return false;
  if (delayNextWorkspaceApply) {
    delayNextWorkspaceApply = false;
    noteDelayedWorkspaceApplyStarted();
    await delayedWorkspaceApply;
  }
  if (failNextWorkspaceApply) {
    failNextWorkspaceApply = false;
    return false;
  }
  document.text = edit.replacement.text;
  document.version += 1;
  document.isDirty = true;
  for (const listener of changeListeners) {
    listener({ document, contentChanges: [{ text: document.text }] });
  }
  return true;
};

willSaveListeners.push(() => {
  if (priorParticipantText === null) return;
  const edit = new FakeWorkspaceEdit();
  edit.replace(document.uri, new FakeRange(document.positionAt(0), document.positionAt(document.text.length)), priorParticipantText);
  priorParticipantText = null;
  void applyWorkspaceEdit(edit);
});

mock.module('vscode', () => createPanelSessionVscodeMock(document, {
  Range: FakeRange,
  WorkspaceEdit: FakeWorkspaceEdit,
  onWillSaveTextDocument: (listener) => {
    willSaveListeners.push(listener as (event: WillSaveEvent) => void);
    return panelSessionDisposable();
  },
  onDidChangeTextDocument: (listener) => {
    changeListeners.push(listener as (typeof changeListeners)[number]);
    return panelSessionDisposable();
  },
  onDidSaveTextDocument: (listener) => {
    didSaveListeners.push(listener as (typeof didSaveListeners)[number]);
    return panelSessionDisposable();
  },
  applyEdit: (edit) => applyWorkspaceEdit(edit as FakeWorkspaceEdit),
  showWarningMessage: async (message) => { warnings.push(message); }
}));

const [{ createPanelSessionController }, { createPendingDraftRecovery }] = await Promise.all([
  import('../src/extension/panelSession'),
  import('../src/application/pendingDraftRecovery')
]);

const postedToWebview: Message[] = [];
let receiveMessage: ((message: unknown) => void) | null = null;
let pendingTableCellText = 'outer Draft\n\n| pending cell |\n| --- |';
let completedNativeSaveWaiters = 0;

const panel = {
  active: true,
  webview: {
    postMessage: async (message: Message) => {
      postedToWebview.push(message);
      if (message.type === 'flushDocumentEdits') {
        const nextText = pendingTableCellText || document.text;
        pendingTableCellText = '';
        queueMicrotask(() => {
          receiveMessage?.({
            type: 'draftChanged',
            text: nextText,
            receiptVersion: 1
          });
          receiveMessage?.({
            type: 'applyChanges',
            baseVersion: document.version,
            changes: [{ from: 0, to: document.text.length, insert: nextText }]
          });
          receiveMessage?.({
            type: 'flushDocumentEditsResult',
            requestId: message.requestId,
            result: { ok: true, value: { text: nextText } }
          });
        });
      }
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

async function nativeSave(reason = 2): Promise<boolean> {
  const waiters: Promise<unknown>[] = [];
  const event: WillSaveEvent = {
    document,
    reason,
    waitUntil(thenable) {
      waiters.push(Promise.resolve(thenable));
    }
  };
  for (const listener of willSaveListeners) listener(event);
  await Promise.allSettled(waiters);
  completedNativeSaveWaiters += 1;
  diskText = document.text;
  document.isDirty = false;
  for (const listener of didSaveListeners) listener(document);
  return true;
}

const controller = createPanelSessionController(createPanelSessionControllerParams({
  panel,
  document,
  pendingDraftRecovery,
  readDiskText: () => diskText,
  overrides: { saveDocument: () => nativeSave(1) }
}) as never);

const initialNativeSave = nativeSave();
await delayedWorkspaceApplyStarted;
try {
  assert.equal(
    completedNativeSaveWaiters,
    0,
    'will-save must remain pending until the corresponding Host applyEdit completes'
  );
  assert.deepEqual(warnings, [], 'the flush response must not validate against the pre-apply TextDocument');
  assert.equal(document.text, 'outer Draft\n\n| old |\n| --- |');
  assert.equal(diskText, 'accepted\n\n| old |\n| --- |');
} finally {
  releaseDelayedWorkspaceApply();
  await initialNativeSave;
}

assert.equal(
  diskText,
  'outer Draft\n\n| pending cell |\n| --- |',
  'VS Code auto/native save must flush a pending table cell through Document Session before disk write'
);
assert.deepEqual(warnings, [], 'successful flush must not emit a mismatch warning');
assert.equal(
  postedToWebview.some((message) => message.type === 'flushDocumentEdits'),
  true,
  'Host save lifecycle must request the production Webview transient-edit flush seam'
);

const nativeFlushCount = postedToWebview.filter((message) => message.type === 'flushDocumentEdits').length;
await controller.handleMessage({
  type: 'saveDocumentRevision',
  requestId: 'manual-save',
  revision: { version: document.version, text: document.text }
});
assert.equal(
  postedToWebview.filter((message) => message.type === 'flushDocumentEdits').length,
  nativeFlushCount,
  'MEO manual save must not re-enter the native flush handshake after Document Session prepared the exact Revision'
);

const participantExpected = document.text;
const participantText = participantExpected.replace('pending cell', 'participant formatted');
priorParticipantText = participantText;
const flushCountBeforeParticipant = postedToWebview.filter(
  (message) => message.type === 'flushDocumentEdits'
).length;
const participantSaveStartedAt = performance.now();
await controller.handleMessage({
  type: 'saveDocumentRevision',
  requestId: 'manual-save-with-prior-participant',
  revision: { version: document.version, text: participantExpected }
});
const participantSaveElapsedMs = performance.now() - participantSaveStartedAt;
const participantResponse = postedToWebview.find(
  (message) => message.type === 'saveDocumentRevisionResult'
    && message.requestId === 'manual-save-with-prior-participant'
);
assert.equal(
  postedToWebview.filter((message) => message.type === 'flushDocumentEdits').length,
  flushCountBeforeParticipant,
  'the concrete manual will-save event must consume its one-shot bypass even after a prior participant edits the model'
);
assert.ok(participantSaveElapsedMs < 250, `manual save must not wait for the 1s flush timeout (${participantSaveElapsedMs}ms)`);
assert.equal(diskText, participantText, 'VS Code may still save the participant-modified model');
assert.deepEqual(participantResponse, {
  type: 'saveDocumentRevisionResult',
  requestId: 'manual-save-with-prior-participant',
  result: {
    ok: false,
    error: { code: 'operation-failed', message: 'Saved text differs from the requested Revision' }
  }
});

const textBeforeFailedApply = document.text;
const warningsBeforeFailedApply = warnings.length;
pendingTableCellText = textBeforeFailedApply.replace('participant formatted', 'failed apply');
failNextWorkspaceApply = true;
await nativeSave();
assert.equal(document.text, textBeforeFailedApply, 'a rejected workspace edit must not advance the TextDocument');
assert.equal(diskText, textBeforeFailedApply, 'VS Code may only save the unchanged model after applyEdit rejects');
assert.equal(
  warnings.length,
  warningsBeforeFailedApply + 1,
  'a flush whose Host applyEdit failed must remain a failed native-save participant'
);
assert.match(warnings.at(-1) ?? '', /did not reach the editor Revision/);

controller.dispose();
console.log('Panel Session native save flush checks passed');
