import assert from 'node:assert/strict';
import { mock } from 'bun:test';

type FakeUri = { readonly fsPath: string };

const targetUri: FakeUri = { fsPath: 'D:/exports/note.pdf' };
const progressMessages: string[] = [];
const informationMessages: Array<{ message: string; actions: string[] }> = [];
const errorMessages: string[] = [];
const openedUris: FakeUri[] = [];
const revealedUris: FakeUri[] = [];
let selectedAction: string | undefined;
let saveDialogResult: FakeUri | undefined = targetUri;
let saveDialogOptions: Record<string, unknown> | undefined;
let progressOptions: Record<string, unknown> | undefined;
let progressInvocationCount = 0;
let rejectReveal = false;
let notificationPainted = false;
let saveDialogBarrier: Promise<void> = Promise.resolve();
let progressCompletionBarrier: Promise<void> = Promise.resolve();

mock.module('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  Uri: { file: (fsPath: string): FakeUri => ({ fsPath }) },
  window: {
    showSaveDialog: async (options: Record<string, unknown>) => {
      saveDialogOptions = options;
      await saveDialogBarrier;
      return saveDialogResult;
    },
    withProgress: async (
      options: Record<string, unknown>,
      task: (progress: { report(value: { message: string }): void }) => Promise<void>
    ) => {
      progressInvocationCount += 1;
      progressOptions = options;
      const result = await task({ report: ({ message }) => {
        progressMessages.push(message);
        setTimeout(() => { notificationPainted = true; }, 0);
      } });
      await progressCompletionBarrier;
      return result;
    },
    showInformationMessage: async (message: string, ...actions: string[]) => {
      informationMessages.push({ message, actions });
      return selectedAction;
    },
    showErrorMessage: async (message: string) => {
      errorMessages.push(message);
      return undefined;
    }
  },
  env: {
    openExternal: async (uri: FakeUri) => {
      openedUris.push(uri);
      return true;
    }
  },
  commands: {
    executeCommand: async (command: string, uri: FakeUri) => {
      assert.equal(command, 'revealFileInOS');
      if (rejectReveal) throw new Error('reveal unavailable');
      revealedUris.push(uri);
    }
  }
}));

const { runVscodeExportWithFeedback } = await import('../src/host/vscodeExportFeedback');
const sourceDocumentUri = { fsPath: 'D:/docs/note.md' } as never;

selectedAction = '直接打开';
let releaseSaveDialog: (() => void) | undefined;
saveDialogBarrier = new Promise<void>((resolve) => { releaseSaveDialog = resolve; });
let exportTaskStarted = false;
const zhOutcomePromise = runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'zh-CN'
}, async ({ targetUri: selectedUri, report }) => {
  exportTaskStarted = true;
  assert.equal(selectedUri, targetUri);
  assert.equal(notificationPainted, true, 'export work must start after the first progress notification can paint');
  report('renderingPdf');
});
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.deepEqual(progressMessages, ['等待选择保存位置…']);
assert.equal(exportTaskStarted, false);
releaseSaveDialog?.();
const zhOutcome = await zhOutcomePromise;
saveDialogBarrier = Promise.resolve();

assert.equal(zhOutcome, 'completed');
assert.equal(saveDialogOptions?.saveLabel, '导出 PDF');
assert.equal((saveDialogOptions?.defaultUri as FakeUri).fsPath.endsWith('note.pdf'), true);
assert.deepEqual(progressOptions, {
  location: 15,
  cancellable: false,
  title: '正在导出 Markdown 为 PDF'
});
assert.deepEqual(progressMessages, [
  '等待选择保存位置…',
  '正在准备 PDF 导出…',
  '正在生成 PDF…'
]);
assert.deepEqual(informationMessages.at(-1), {
  message: 'PDF 导出完成。',
  actions: ['直接打开', '打开所在文件夹']
});
assert.deepEqual(openedUris, [targetUri]);

selectedAction = 'Show in Folder';
progressMessages.length = 0;
const enOutcome = await runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'html',
  uiLanguage: 'en'
}, async ({ report }) => {
  report('writingHtml');
});
assert.equal(enOutcome, 'completed');
assert.equal(saveDialogOptions?.saveLabel, 'Export HTML');
assert.equal(progressOptions?.title, 'Exporting Markdown to HTML');
assert.deepEqual(progressMessages, [
  'Waiting for an output location…',
  'Preparing HTML export…',
  'Writing HTML…'
]);
assert.deepEqual(informationMessages.at(-1), {
  message: 'HTML export completed.',
  actions: ['Open', 'Show in Folder']
});
assert.equal(revealedUris.at(-1), targetUri);

rejectReveal = true;
selectedAction = '打开所在文件夹';
await runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'zh-CN'
}, async () => undefined);
assert.equal(openedUris.at(-1)?.fsPath.replaceAll('\\', '/'), 'D:/exports');

const failedOutcome = await runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'zh-CN'
}, async () => {
  throw new Error('browser unavailable');
});
assert.equal(failedOutcome, 'failed');
assert.equal(errorMessages.at(-1), 'PDF 导出失败：browser unavailable');

saveDialogResult = undefined;
const progressCountBeforeCancellation = progressInvocationCount;
let releaseCancelledProgress: (() => void) | undefined;
progressCompletionBarrier = new Promise<void>((resolve) => { releaseCancelledProgress = resolve; });
const cancelledOutcome = await runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'en'
}, async () => {
  throw new Error('cancelled export must not run');
});
assert.equal(cancelledOutcome, 'cancelled');
assert.equal(
  progressInvocationCount,
  progressCountBeforeCancellation + 1,
  'destination selection must retain the immediate progress notification'
);

saveDialogResult = targetUri;
selectedAction = undefined;
progressCompletionBarrier = Promise.resolve();
let immediateRetryStarted = false;
const immediateRetryOutcome = await runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'en'
}, async () => {
  immediateRetryStarted = true;
});
assert.equal(immediateRetryOutcome, 'completed');
assert.equal(immediateRetryStarted, true, 'export must be immediately retryable after destination cancellation');
releaseCancelledProgress?.();

console.log('VS Code export feedback checks passed');
