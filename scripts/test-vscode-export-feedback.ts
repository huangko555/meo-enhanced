import assert from 'node:assert/strict';
import { mock } from 'bun:test';

type FakeUri = { readonly fsPath: string; readonly scheme: 'file' };

const fileUri = (fsPath: string): FakeUri => ({ fsPath, scheme: 'file' });
const targetUri = fileUri('D:/exports/note.pdf');
const progressMessages: string[] = [];
const informationMessages: Array<{ message: string; actions: string[] }> = [];
const errorMessages: string[] = [];
const openedUris: FakeUri[] = [];
const systemOpenedPaths: string[] = [];
const revealedUris: FakeUri[] = [];
let selectedAction: string | undefined;
let saveDialogResult: FakeUri | undefined = targetUri;
let saveDialogOptions: Record<string, unknown> | undefined;
let saveDialogInvocationCount = 0;
let progressOptions: Record<string, unknown> | undefined;
let progressInvocationCount = 0;
let rejectReveal = false;
let notificationPainted = false;
let saveDialogBarrier: Promise<void> = Promise.resolve();
let progressCompletionBarrier: Promise<void> = Promise.resolve();
let saveDialogHandler: (() => Promise<FakeUri | undefined>) | undefined;
let informationMessageHandler: (() => Promise<string | undefined>) | undefined;

Object.defineProperty(process, 'platform', { value: 'win32' });

mock.module('open', () => ({
  default: async (target: string) => {
    systemOpenedPaths.push(target);
    return {};
  }
}));

mock.module('vscode', () => ({
  ProgressLocation: { Notification: 15 },
  Uri: { file: (fsPath: string): FakeUri => fileUri(fsPath) },
  window: {
    showSaveDialog: async (options: Record<string, unknown>) => {
      saveDialogInvocationCount += 1;
      saveDialogOptions = options;
      if (saveDialogHandler) return saveDialogHandler();
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
      if (informationMessageHandler) return informationMessageHandler();
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
await new Promise<void>((resolve) => setTimeout(resolve, 0));
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
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.equal(revealedUris.at(-1), targetUri);

progressMessages.length = 0;
const docxOutcome = await runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'docx',
  uiLanguage: 'zh-CN'
}, async ({ report }) => {
  report('writingDocx');
});
assert.equal(docxOutcome, 'completed');
assert.equal(saveDialogOptions?.saveLabel, '导出 DOCX');
assert.equal((saveDialogOptions?.defaultUri as FakeUri).fsPath.endsWith('note.docx'), true);
assert.deepEqual(saveDialogOptions?.filters, { Word: ['docx'] });
assert.deepEqual(progressMessages, [
  '等待选择保存位置…',
  '正在准备 DOCX 导出…',
  '正在生成 Word 文档…'
]);

selectedAction = '直接打开';
for (const [format, extension] of [['pdf', 'pdf'], ['docx', 'docx'], ['html', 'html']] as const) {
  const nonAsciiTarget = fileUri(`D:/海螺岛一期_PPTMaster模板/templates/design_specdeckhailuodao_phase1.${extension}`);
  saveDialogResult = nonAsciiTarget;
  const externalOpenCount = openedUris.length;
  const systemOpenCount = systemOpenedPaths.length;
  const outcome = await runVscodeExportWithFeedback({
    sourceDocumentUri,
    format,
    uiLanguage: 'zh-CN'
  }, async () => undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(outcome, 'completed');
  assert.equal(systemOpenedPaths.length, systemOpenCount + 1);
  assert.equal(systemOpenedPaths.at(-1), nonAsciiTarget.fsPath);
  assert.equal(openedUris.length, externalOpenCount, `${format} must bypass encoded URI opening on Windows`);
}

rejectReveal = true;
selectedAction = '打开所在文件夹';
saveDialogResult = targetUri;
await runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'zh-CN'
}, async () => undefined);
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.equal(openedUris.at(-1)?.fsPath.replaceAll('\\', '/'), 'D:/exports');

const nonAsciiFolderTarget = fileUri('D:/海螺岛一期_PPTMaster模板/templates/note.pdf');
saveDialogResult = nonAsciiFolderTarget;
const externalOpenCountBeforeFallback = openedUris.length;
await runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'zh-CN'
}, async () => undefined);
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.equal(systemOpenedPaths.at(-1)?.replaceAll('\\', '/'), 'D:/海螺岛一期_PPTMaster模板/templates');
assert.equal(openedUris.length, externalOpenCountBeforeFallback);

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

let releaseNativeCancellation: (() => void) | undefined;
const nativeCancellationBarrier = new Promise<void>((resolve) => { releaseNativeCancellation = resolve; });
let nativeDialogAttempt = 0;
saveDialogHandler = async () => {
  nativeDialogAttempt += 1;
  if (nativeDialogAttempt === 1) {
    await nativeCancellationBarrier;
    return undefined;
  }
  return targetUri;
};
const firstNativeOutcome = runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'en'
}, async () => {
  throw new Error('the visually cancelled export must not run');
});
await new Promise<void>((resolve) => setTimeout(resolve, 0));
let queuedRetryStarted = false;
const queuedNativeRetry = runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'en'
}, async () => {
  queuedRetryStarted = true;
});
await new Promise<void>((resolve) => setTimeout(resolve, 0));
const attemptsBeforeNativeCancellationSettled = nativeDialogAttempt;
const feedbackBeforeNativeCancellationSettled = progressMessages.at(-1);
releaseNativeCancellation?.();
assert.equal(await firstNativeOutcome, 'cancelled');
assert.equal(await queuedNativeRetry, 'completed');
assert.equal(
  attemptsBeforeNativeCancellationSettled,
  1,
  'a retry click must queue instead of opening a second save dialog while native cancellation is still settling'
);
assert.equal(
  feedbackBeforeNativeCancellationSettled,
  'Waiting for the previous save dialog to close…',
  'a queued cold-start retry must acknowledge the click before the native dialog finishes settling'
);
assert.equal(nativeDialogAttempt, 2);
assert.equal(queuedRetryStarted, true, 'the queued retry must open automatically after cancellation settles');

saveDialogHandler = undefined;
saveDialogResult = targetUri;
selectedAction = undefined;
informationMessageHandler = undefined;
let releaseActiveExport: (() => void) | undefined;
let noteActiveExportStarted: (() => void) | undefined;
const activeExportStarted = new Promise<void>((resolve) => {
  noteActiveExportStarted = resolve;
});
const activeExportBarrier = new Promise<void>((resolve) => {
  releaseActiveExport = resolve;
});
const activeExport = runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'zh-CN'
}, async () => {
  noteActiveExportStarted?.();
  await activeExportBarrier;
});
await activeExportStarted;
const dialogsBeforeBusyClick = saveDialogInvocationCount;
let busyTaskStarted = false;
const busyOutcome = await runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'html',
  uiLanguage: 'en'
}, async () => {
  busyTaskStarted = true;
});
assert.equal(busyOutcome, 'busy');
assert.equal(busyTaskStarted, false);
assert.equal(saveDialogInvocationCount, dialogsBeforeBusyClick);
assert.equal(progressMessages.at(-1), 'An export is already in progress. Please wait…');
releaseActiveExport?.();
assert.equal(await activeExport, 'completed');

saveDialogHandler = undefined;
const firstCompletedTarget = fileUri('D:/exports/first.pdf');
const secondCompletedTarget = fileUri('D:/exports/second.pdf');
const completionTargets = [firstCompletedTarget, secondCompletedTarget];
saveDialogHandler = async () => completionTargets.shift();
selectedAction = undefined;
let releaseCompletionNotification: (() => void) | undefined;
let noteCompletionNotificationShown: (() => void) | undefined;
const completionNotificationShown = new Promise<void>((resolve) => {
  noteCompletionNotificationShown = resolve;
});
const completionNotificationBarrier = new Promise<void>((resolve) => {
  releaseCompletionNotification = resolve;
});
informationMessageHandler = async () => {
  noteCompletionNotificationShown?.();
  await completionNotificationBarrier;
  return 'Open';
};
const exportWithPendingCompletion = runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'en'
}, async () => undefined);
await completionNotificationShown;
informationMessageHandler = undefined;
const dialogsBeforeCompletionRetry = saveDialogInvocationCount;
const completionRetry = runVscodeExportWithFeedback({
  sourceDocumentUri,
  format: 'pdf',
  uiLanguage: 'en'
}, async () => undefined);
await new Promise<void>((resolve) => setTimeout(resolve, 0));
const dialogsAfterCompletionRetry = saveDialogInvocationCount;
releaseCompletionNotification?.();
const completionOutcomes = await Promise.all([exportWithPendingCompletion, completionRetry]);
await new Promise<void>((resolve) => setTimeout(resolve, 0));
assert.equal(
  dialogsAfterCompletionRetry,
  dialogsBeforeCompletionRetry + 1,
  'a visible completion notification must not block the next export destination dialog'
);
assert.deepEqual(completionOutcomes, ['completed', 'completed']);
assert.equal(openedUris.at(-1), firstCompletedTarget);

console.log('VS Code export feedback checks passed');
