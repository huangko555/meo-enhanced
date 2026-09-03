import assert from 'node:assert/strict';
import { decodeInitMessage, decodeReadyMessage } from '../src/protocol/readyInit';
import { decodeDocumentSyncCommand, decodeDocumentSyncMessage } from '../src/protocol/documentSync';
import { decodeResolveImageSrcRequest, decodeResolvedImageSrcResponse } from '../src/protocol/imageResolution';
import { createImageResolutionTransport } from '../webview/src/adapters/imageResolutionTransport';
import { decodeResolveWikiLinksRequest, decodeResolvedWikiLinksResponse } from '../src/protocol/wikiLinkResolution';
import { createWikiLinkResolutionTransport } from '../webview/src/adapters/wikiLinkResolutionTransport';
import { decodeResolveLocalLinksRequest, decodeResolvedLocalLinksResponse } from '../src/protocol/localLinkResolution';
import { createLocalLinkResolutionTransport } from '../webview/src/adapters/localLinkResolutionTransport';
import { decodeSaveImageFromClipboardRequest, decodeSavedImagePathResponse } from '../src/protocol/clipboardImageSave';
import { createClipboardImageSaveTransport } from '../webview/src/adapters/clipboardImageSaveTransport';
import { decodePreviewRenderRequest, decodePreviewRenderResponse } from '../src/protocol/previewRender';
import { createPreviewRenderTransport } from '../webview/src/adapters/previewRenderTransport';
import { decodeExportSnapshotRequest, decodeExportSnapshotResponse } from '../src/protocol/exportSnapshot';
import { createExportSnapshotTransport } from '../src/host/exportSnapshotTransport';
import { createExportSnapshotResponder } from '../webview/src/adapters/exportSnapshotTransport';
import { decodeGitBaselineChangedEvent } from '../src/protocol/git';
import { decodeEditorCommand } from '../src/protocol/editorCommands';
import { decodeHostEditorEvent } from '../src/protocol/hostEditorEvents';
import { decodeHostConfigurationEvent } from '../src/protocol/hostConfigurationEvents';
import { decodeDiagnosticsChangedEvent } from '../src/protocol/diagnostics';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import { createDocumentSessionCoordinatorFromInit } from '../webview/src/adapters/documentSessionTransport';
import { MAX_PREVIEW_FONT_FAMILY_LENGTH, normalizePreviewFontFamily } from '../src/shared/preview';

const codeTheme = { name: 'VS Dark', type: 'dark' as const, colors: {}, tokenColors: [] };
const completeInit = {
  type: 'init' as const,
  documentId: 'file:///notes.md',
  text: '# title',
  version: 3,
  savedRevision: { version: null, text: '# saved title' },
  diagnostics: [],
  mode: 'live' as const,
  uiLanguage: 'en' as const,
  uiLanguagePreference: 'auto' as const,
  automaticUiLanguage: 'en' as const,
  sourceLineNumbers: 'on' as const,
  previewAppearance: 'dark' as const,
  previewFontFamily: '' as const,
  previewSourceColoring: true,
  editorAppearance: 'dark' as const,
  editorFontSizeMode: 'auto' as const,
  editorFontSize: 14,
  gitChangesGutter: true,
  gitDiffLineHighlights: true,
  gitDiffDetailsVisible: false,
  diffBaselineMode: 'git-head' as const,
  fixedBaselinePinned: false,
  fixedBaselineActive: false,
  fixedBaselineUpdatedAt: null,
  contentMaxWidthEnabled: true,
  findOptions: { wholeWord: false, caseSensitive: false },
  outlinePosition: 'right' as const,
  outlineVisible: true,
  outlineWidth: 260,
  vscodeTheme: codeTheme
};

assert.deepEqual(decodeReadyMessage({ type: 'ready', extra: true }), { type: 'ready' });
assert.equal(decodeReadyMessage(null), null);
assert.deepEqual(decodeReadyMessage({ type: 'ready', version: 1 }), { type: 'ready' });

const init = decodeInitMessage(completeInit);
assert.equal(init?.version, 3);
if (init === null) throw new Error('Expected decoded init');
const initializedSession = createDocumentSessionCoordinatorFromInit(init);
assert.deepEqual(initializedSession.handle({
  type: 'hostRevisionChanged', version: 3, text: '# title'
}), []);
assert.equal(decodeInitMessage({ ...completeInit, version: -1 }), null);
assert.equal(decodeInitMessage({ ...completeInit, previewSourceColoring: undefined }), null);
assert.equal(decodeInitMessage({ ...completeInit, editorFontSizeMode: 'invalid' }), null);
assert.equal(decodeInitMessage({ ...completeInit, editorFontSize: 9 }), null);
assert.equal(decodeInitMessage({ ...completeInit, editorFontSize: 14.5 }), null);
assert.equal(decodeInitMessage({ ...completeInit, gitDiffDetailsVisible: 'yes' }), null);
assert.deepEqual(
  decodeInitMessage({ ...completeInit, editorFontSizeMode: undefined, editorFontSize: undefined }),
  completeInit
);
assert.equal(decodeInitMessage({ ...completeInit, savedRevision: undefined }), null);
assert.equal(decodeInitMessage({ ...completeInit, savedRevision: { version: -1, text: '# saved' } }), null);
assert.equal(decodeInitMessage({ ...completeInit, savedRevision: { version: 4, text: '# future' } }), null);
assert.equal(decodeInitMessage({ ...completeInit, savedRevision: { version: 3, text: '# contradiction' } }), null);
assert.notEqual(decodeInitMessage({ ...completeInit, savedRevision: null }), null);
assert.equal(decodeInitMessage({ ...completeInit, mode: 'bad' }), null);
assert.equal(decodeInitMessage({ ...completeInit, previewAppearance: 'broken' }), null);
assert.equal(decodeInitMessage({ ...completeInit, previewFontFamily: '  MEO Synthetic Sans  ' })?.previewFontFamily, 'MEO Synthetic Sans');
for (const invalidFontFamily of [
  'MEO\nSynthetic',
  'MEO\u0000Synthetic',
  'MEO<Synthetic',
  'MEO>Synthetic',
  'x'.repeat(MAX_PREVIEW_FONT_FAMILY_LENGTH + 1)
]) {
  assert.equal(decodeInitMessage({ ...completeInit, previewFontFamily: invalidFontFamily }), null);
}
assert.equal(normalizePreviewFontFamily(undefined), null);
assert.equal(normalizePreviewFontFamily(null), null);
assert.equal(normalizePreviewFontFamily('  MEO Synthetic Sans  '), 'MEO Synthetic Sans');
assert.equal(normalizePreviewFontFamily('MEO\nSynthetic'), null);
assert.equal(normalizePreviewFontFamily('x'.repeat(MAX_PREVIEW_FONT_FAMILY_LENGTH + 1)), null);
for (const requiredKey of [
  'documentId', 'savedRevision', 'diagnostics', 'uiLanguage', 'sourceLineNumbers', 'previewAppearance', 'previewFontFamily', 'editorAppearance', 'gitChangesGutter',
  'gitDiffLineHighlights', 'gitDiffDetailsVisible', 'diffBaselineMode', 'fixedBaselinePinned',
  'fixedBaselineActive', 'contentMaxWidthEnabled',
  'findOptions', 'outlinePosition', 'outlineVisible',
  'outlineWidth', 'vscodeTheme'
]) {
  const incomplete = { ...completeInit } as Record<string, unknown>;
  delete incomplete[requiredKey];
  assert.equal(decodeInitMessage(incomplete), null, `Init without ${requiredKey} must be rejected`);
}
assert.equal(decodeInitMessage({ ...completeInit, uiLanguage: 'fr' }), null);
assert.equal(decodeInitMessage({ ...completeInit, uiLanguagePreference: 'fr' }), null);
assert.equal(decodeInitMessage({ ...completeInit, automaticUiLanguage: 'fr' }), null);
for (const mode of ['on', 'off', 'relative', 'interval'] as const) {
  assert.equal(decodeInitMessage({ ...completeInit, sourceLineNumbers: mode })?.sourceLineNumbers, mode);
}
assert.equal(decodeInitMessage({ ...completeInit, sourceLineNumbers: true }), null);
assert.equal(decodeInitMessage({ ...completeInit, sourceLineNumbers: 'visible' }), null);
for (const removedKey of ['theme', 'shikiCodeBlocks', 'codeTheme', 'lineNumbers', 'restoreTopLine', 'restoreTopLineOffset']) {
  assert.equal(
    decodeInitMessage({ ...completeInit, [removedKey]: removedKey === 'shikiCodeBlocks' ? true : {} }),
    null,
    `Init must reject removed ${removedKey} payloads`
  );
}
for (const removedFontKey of ['previewFontFamilyName', 'previewFontFamilyFallback', 'previewFontFamilies']) {
  assert.equal(decodeInitMessage({ ...completeInit, [removedFontKey]: 'MEO Synthetic Sans' }), null);
}
assert.deepEqual(decodeHostToWebviewMessage(completeInit), completeInit);
assert.deepEqual(decodeWebviewToHostMessage({ type: 'ready' }), { type: 'ready' });
assert.deepEqual(
  decodeWebviewToHostMessage({ type: 'setUiLanguagePreference', language: 'zh-CN' }),
  { type: 'setUiLanguagePreference', language: 'zh-CN' }
);
assert.deepEqual(
  decodeWebviewToHostMessage({ type: 'setSourceLineNumbers', mode: 'off' }),
  { type: 'setSourceLineNumbers', mode: 'off' }
);
assert.deepEqual(decodeDocumentSyncMessage({ type: 'docChanged', text: 'next', version: 4 }), {
  type: 'docChanged', text: 'next', version: 4
});
assert.deepEqual(decodeDocumentSyncMessage({ type: 'applied', version: 4 }), { type: 'applied', version: 4 });
assert.deepEqual(decodeDocumentSyncMessage({ type: 'documentReloadedFromDisk', reloadId: 2, text: 'base', version: 5 }), {
  type: 'documentReloadedFromDisk', reloadId: 2, text: 'base', version: 5, topLine: 1, topLineOffset: 0
});
assert.equal(decodeDocumentSyncMessage({ type: 'docChanged', text: 'bad', version: -1 }), null);
assert.deepEqual(
  decodeDocumentSyncCommand({ type: 'draftChanged', text: null, receiptVersion: 3 }),
  { type: 'draftChanged', text: null, receiptVersion: 3 }
);
assert.equal(
  decodeDocumentSyncCommand({ type: 'draftChanged', text: 'missing receipt' }),
  null
);
assert.deepEqual(decodeDocumentSyncCommand({
  type: 'documentReloadPresentationCompleted', reloadId: 2, presented: true, receiptVersion: 3
}), { type: 'documentReloadPresentationCompleted', reloadId: 2, presented: true, receiptVersion: 3 });
assert.equal(decodeDocumentSyncCommand({
  type: 'documentReloadPresentationCompleted', reloadId: 0, presented: true, receiptVersion: 3
}), null);
assert.equal(decodeDocumentSyncCommand({
  type: 'documentReloadPresentationCompleted', reloadId: 2, presented: true
}), null);
assert.deepEqual(decodeDocumentSyncCommand({
  type: 'applyChanges', baseVersion: 2, changes: [{ from: 0, to: 1, insert: 'x' }]
}), { type: 'applyChanges', baseVersion: 2, changes: [{ from: 0, to: 1, insert: 'x' }] });
assert.equal(decodeDocumentSyncCommand({ type: 'applyChanges', baseVersion: 2, changes: [{ from: 2, to: 1, insert: 'x' }] }), null);
assert.deepEqual(decodeResolveImageSrcRequest({ type: 'resolveImageSrc', requestId: 'img-1', url: 'images/a.png' }), {
  type: 'resolveImageSrc', requestId: 'img-1', url: 'images/a.png'
});
assert.equal(decodeResolveImageSrcRequest({ type: 'resolveImageSrc', requestId: '', url: 'images/a.png' }), null);
assert.deepEqual(decodeResolvedImageSrcResponse({ type: 'resolvedImageSrc', requestId: 'img-1', result: {
  ok: true, value: { resolvedUrl: 'vscode-webview://a' }
} }), {
  type: 'resolvedImageSrc', requestId: 'img-1',
  result: { ok: true, value: { resolvedUrl: 'vscode-webview://a' } }
});
assert.deepEqual(decodeResolvedImageSrcResponse({
  type: 'resolvedImageSrc', requestId: 'img-1',
  result: { ok: false, error: { code: 'operation-failed', message: 'unavailable' } }
}), {
  type: 'resolvedImageSrc', requestId: 'img-1',
  result: { ok: false, error: { code: 'operation-failed', message: 'unavailable' } }
});
assert.equal(decodeResolvedImageSrcResponse({
  type: 'resolvedImageSrc', requestId: 'img-1', result: { ok: true, value: { resolvedUrl: 1 } }
}), null);
let postedImageRequest: unknown;
let scheduledImageTimeout: (() => void) | null = null;
let canceledImageTimeouts = 0;
const imageTransport = createImageResolutionTransport((message) => { postedImageRequest = message; }, {
  scheduleTimeout(callback) {
    scheduledImageTimeout = callback;
    return 'image-timeout';
  },
  cancelTimeout(timeout) {
    assert.equal(timeout, 'image-timeout');
    canceledImageTimeouts += 1;
  }
});
const resolvedImage = imageTransport.resolve('images/b.png');
assert.deepEqual(postedImageRequest, { type: 'resolveImageSrc', requestId: 'img-0', url: 'images/b.png' });
assert.equal(imageTransport.accept({
  type: 'resolvedImageSrc', requestId: 'img-0',
  result: { ok: true, value: { resolvedUrl: 'vscode-webview://b' } }
}), true);
assert.deepEqual(await resolvedImage, { ok: true, value: { resolvedUrl: 'vscode-webview://b' } });
assert.equal(canceledImageTimeouts, 1);
const timedOutImageResolution = imageTransport.resolve('images/c.png');
const triggerImageTimeout = scheduledImageTimeout as (() => void) | null;
assert.notEqual(triggerImageTimeout, null);
triggerImageTimeout?.();
assert.deepEqual(await timedOutImageResolution, {
  ok: false,
  error: { code: 'timeout', message: 'Timed out while resolving image source' }
});
assert.equal(imageTransport.accept({
  type: 'resolvedImageSrc', requestId: 'img-1',
  result: { ok: true, value: { resolvedUrl: 'vscode-webview://c' } }
}), false);
const imageAbortController = new AbortController();
const imageAbortSignal = imageAbortController.signal;
const addAbortListener = imageAbortSignal.addEventListener.bind(imageAbortSignal);
const removeAbortListener = imageAbortSignal.removeEventListener.bind(imageAbortSignal);
let imageAbortListenersAdded = 0;
let imageAbortListenersRemoved = 0;
Object.defineProperty(imageAbortSignal, 'addEventListener', {
  configurable: true,
  value(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) {
    if (type === 'abort') imageAbortListenersAdded += 1;
    return addAbortListener(type, listener, options);
  }
});
Object.defineProperty(imageAbortSignal, 'removeEventListener', {
  configurable: true,
  value(type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) {
    if (type === 'abort') imageAbortListenersRemoved += 1;
    return removeAbortListener(type, listener, options);
  }
});
const canceledBeforeImageAbort = canceledImageTimeouts;
const abortedImageResolution = imageTransport.resolve('images/aborted.png', imageAbortSignal);
assert.deepEqual(postedImageRequest, {
  type: 'resolveImageSrc', requestId: 'img-2', url: 'images/aborted.png'
});
assert.equal(imageAbortListenersAdded, 1);
imageAbortController.abort();
assert.deepEqual(await abortedImageResolution, {
  ok: false,
  error: { code: 'operation-failed', message: 'Image source resolution was cancelled' }
});
assert.equal(canceledImageTimeouts, canceledBeforeImageAbort + 1, 'abort must cancel its timeout');
assert.equal(imageAbortListenersRemoved, 1, 'abort must remove its transport listener');
assert.equal(imageTransport.accept({
  type: 'resolvedImageSrc', requestId: 'img-2',
  result: { ok: true, value: { resolvedUrl: 'vscode-webview://late' } }
}), false, 'late response after abort must be rejected');
assert.deepEqual(decodeResolveWikiLinksRequest({ type: 'resolveWikiLinks', requestId: 'wiki-1', targets: ['One', 'Two'] }), {
  type: 'resolveWikiLinks', requestId: 'wiki-1', targets: ['One', 'Two']
});
assert.equal(decodeResolveWikiLinksRequest({ type: 'resolveWikiLinks', requestId: 'wiki-1', targets: [] }), null);
assert.deepEqual(decodeResolvedWikiLinksResponse({
  type: 'resolvedWikiLinks', requestId: 'wiki-1', result: { ok: true, value: { results: [{ target: 'One', exists: true }] } }
}), {
  type: 'resolvedWikiLinks', requestId: 'wiki-1', result: { ok: true, value: { results: [{ target: 'One', exists: true }] } }
});
assert.deepEqual(decodeResolvedWikiLinksResponse({
  type: 'resolvedWikiLinks', requestId: 'wiki-1', result: {
    ok: false, error: { code: 'operation-failed', message: 'unavailable' }
  }
}), {
  type: 'resolvedWikiLinks', requestId: 'wiki-1', result: {
    ok: false, error: { code: 'operation-failed', message: 'unavailable' }
  }
});
let postedWikiRequest: unknown;
let scheduledWikiTimeout: (() => void) | null = null;
let canceledWikiTimeouts = 0;
const wikiTransport = createWikiLinkResolutionTransport((message) => { postedWikiRequest = message; }, {
  scheduleTimeout(callback) {
    scheduledWikiTimeout = callback;
    return 'wiki-timeout';
  },
  cancelTimeout(timeout) {
    assert.equal(timeout, 'wiki-timeout');
    canceledWikiTimeouts += 1;
  }
});
const resolvedWiki = wikiTransport.resolve(['Three']);
assert.deepEqual(postedWikiRequest, { type: 'resolveWikiLinks', requestId: 'wiki-0', targets: ['Three'] });
assert.equal(wikiTransport.accept({
  type: 'resolvedWikiLinks', requestId: 'wiki-0', result: { ok: true, value: { results: [{ target: 'Three', exists: true }] } }
}), true);
assert.deepEqual(await resolvedWiki, { ok: true, value: { results: [{ target: 'Three', exists: true }] } });
assert.equal(canceledWikiTimeouts, 1);
const timedOutWiki = wikiTransport.resolve(['Four']);
const triggerWikiTimeout = scheduledWikiTimeout as (() => void) | null;
assert.notEqual(triggerWikiTimeout, null);
triggerWikiTimeout?.();
assert.deepEqual(await timedOutWiki, {
  ok: false,
  error: { code: 'timeout', message: 'Timed out while resolving Wiki Links' }
});
assert.equal(wikiTransport.accept({
  type: 'resolvedWikiLinks', requestId: 'wiki-1', result: { ok: true, value: { results: [] } }
}), false);
assert.deepEqual(decodeResolveLocalLinksRequest({ type: 'resolveLocalLinks', requestId: 'local-1', targets: ['docs/a.md'] }), {
  type: 'resolveLocalLinks', requestId: 'local-1', targets: ['docs/a.md']
});
assert.equal(decodeResolveLocalLinksRequest({ type: 'resolveLocalLinks', requestId: 'local-1', targets: [] }), null);
assert.deepEqual(decodeResolvedLocalLinksResponse({
  type: 'resolvedLocalLinks', requestId: 'local-1', result: { ok: true, value: { results: [{ target: 'docs/a.md', exists: false }] } }
}), {
  type: 'resolvedLocalLinks', requestId: 'local-1', result: { ok: true, value: { results: [{ target: 'docs/a.md', exists: false }] } }
});
assert.deepEqual(decodeResolvedLocalLinksResponse({
  type: 'resolvedLocalLinks', requestId: 'local-1', result: {
    ok: false, error: { code: 'operation-failed', message: 'unavailable' }
  }
}), {
  type: 'resolvedLocalLinks', requestId: 'local-1', result: {
    ok: false, error: { code: 'operation-failed', message: 'unavailable' }
  }
});
let postedLocalRequest: unknown;
let scheduledLocalTimeout: (() => void) | null = null;
let canceledLocalTimeouts = 0;
const localTransport = createLocalLinkResolutionTransport((message) => { postedLocalRequest = message; }, {
  scheduleTimeout(callback) {
    scheduledLocalTimeout = callback;
    return 'local-timeout';
  },
  cancelTimeout(timeout) {
    assert.equal(timeout, 'local-timeout');
    canceledLocalTimeouts += 1;
  }
});
const resolvedLocal = localTransport.resolve(['docs/b.md']);
assert.deepEqual(postedLocalRequest, { type: 'resolveLocalLinks', requestId: 'local-link-0', targets: ['docs/b.md'] });
assert.equal(localTransport.accept({
  type: 'resolvedLocalLinks', requestId: 'local-link-0', result: { ok: true, value: { results: [{ target: 'docs/b.md', exists: false }] } }
}), true);
assert.deepEqual(await resolvedLocal, { ok: true, value: { results: [{ target: 'docs/b.md', exists: false }] } });
assert.equal(canceledLocalTimeouts, 1);
const timedOutLocal = localTransport.resolve(['docs/c.md']);
const triggerLocalTimeout = scheduledLocalTimeout as (() => void) | null;
assert.notEqual(triggerLocalTimeout, null);
triggerLocalTimeout?.();
assert.deepEqual(await timedOutLocal, {
  ok: false,
  error: { code: 'timeout', message: 'Timed out while resolving local links' }
});
assert.equal(localTransport.accept({
  type: 'resolvedLocalLinks', requestId: 'local-link-1', result: { ok: true, value: { results: [] } }
}), false);
assert.deepEqual(decodeSaveImageFromClipboardRequest({
  type: 'saveImageFromClipboard', requestId: 'save-1', imageData: 'data:image/png;base64,AA==', fileName: 'a.png'
}), { type: 'saveImageFromClipboard', requestId: 'save-1', imageData: 'data:image/png;base64,AA==', fileName: 'a.png' });
assert.deepEqual(decodeSavedImagePathResponse({
  type: 'savedImagePath', requestId: 'save-1', result: { ok: true, value: { path: 'assets/a.png' } }
}), {
  type: 'savedImagePath', requestId: 'save-1', result: { ok: true, value: { path: 'assets/a.png' } }
});
assert.deepEqual(decodeSavedImagePathResponse({
  type: 'savedImagePath', requestId: 'save-1',
  result: { ok: false, error: { code: 'operation-failed', message: 'write failed' } }
}), {
  type: 'savedImagePath', requestId: 'save-1',
  result: { ok: false, error: { code: 'operation-failed', message: 'write failed' } }
});
assert.equal(decodeSavedImagePathResponse({
  type: 'savedImagePath', requestId: 'save-1', result: { ok: true, value: { path: '' } }
}), null);
assert.equal(decodeSavedImagePathResponse({
  type: 'savedImagePath', requestId: 'save-1',
  result: { ok: false, error: { code: 'unknown', message: 'write failed' } }
}), null);
let postedSaveRequest: unknown;
let scheduledSaveTimeout: (() => void) | null = null;
let canceledSaveTimeouts = 0;
const saveTransport = createClipboardImageSaveTransport((message) => { postedSaveRequest = message; }, {
  scheduleTimeout(callback) {
    scheduledSaveTimeout = callback;
    return 'save-timeout';
  },
  cancelTimeout(timeout) {
    assert.equal(timeout, 'save-timeout');
    canceledSaveTimeouts += 1;
  }
});
const savedImage = saveTransport.save({
  imageData: 'data:image/png;base64,AA==', fileName: 'b.png'
});
assert.deepEqual(postedSaveRequest, {
  type: 'saveImageFromClipboard', requestId: 'img-save-0', imageData: 'data:image/png;base64,AA==', fileName: 'b.png'
});
assert.equal(saveTransport.accept({
  type: 'savedImagePath', requestId: 'img-save-0', result: { ok: true, value: { path: 'assets/b.png' } }
}), true);
assert.deepEqual(await savedImage, { ok: true, value: { path: 'assets/b.png' } });
assert.equal(canceledSaveTimeouts, 1);

const timedOutImage = saveTransport.save({
  imageData: 'data:image/png;base64,AA==', fileName: 'c.png'
});
const triggerSaveTimeout = scheduledSaveTimeout as (() => void) | null;
assert.notEqual(triggerSaveTimeout, null);
triggerSaveTimeout?.();
assert.deepEqual(await timedOutImage, {
  ok: false,
  error: { code: 'timeout', message: 'Timed out while saving pasted image' }
});
assert.equal(saveTransport.accept({
  type: 'savedImagePath', requestId: 'img-save-1', result: { ok: true, value: { path: 'assets/c.png' } }
}), false);

assert.deepEqual(decodePreviewRenderRequest({
  type: 'requestPreviewRender', requestId: 'preview-1', text: '# Preview', uiLanguage: 'zh-CN',
  environment: { previewFontFamily: '  MEO Synthetic Sans  ', editorFontFamily: 'sans-serif', editorFontSizePx: 14, meoThemeColors: { base00: '#fff' } }
}), {
  type: 'requestPreviewRender', requestId: 'preview-1', text: '# Preview', uiLanguage: 'zh-CN',
  environment: { previewFontFamily: 'MEO Synthetic Sans', editorFontFamily: 'sans-serif', editorFontSizePx: 14, meoThemeColors: { base00: '#fff' } }
});
assert.equal(decodePreviewRenderRequest({
  type: 'requestPreviewRender', requestId: 'preview-1', text: '# Preview', uiLanguage: 'en',
  environment: { previewFontFamily: '', editorFontSizePx: '14' }
}), null);
assert.equal(decodePreviewRenderRequest({
  type: 'requestPreviewRender', requestId: 'preview-1', text: '# Preview', uiLanguage: 'en',
  environment: { editorFontFamily: 'sans-serif' }
}), null, 'Preview render environments without previewFontFamily must be rejected');
assert.equal(decodePreviewRenderRequest({
  type: 'requestPreviewRender', requestId: 'preview-1', text: '# Preview', uiLanguage: 'en'
}), null, 'Preview render requests without environment must be rejected');
assert.equal(decodePreviewRenderRequest({
  type: 'requestPreviewRender', requestId: 'preview-1', text: '# Preview', uiLanguage: 'en',
  environment: { previewFontFamily: 'MEO Synthetic Sans', previewFontFamilies: ['MEO Synthetic Sans'] }
}), null);
assert.deepEqual(decodePreviewRenderResponse({
  type: 'previewRenderResult', requestId: 'preview-1', result: {
    ok: true, value: { html: '<h1>Preview</h1>', hasMermaid: false, styles: { dark: 'dark', light: 'light' } }
  }
}), {
  type: 'previewRenderResult', requestId: 'preview-1', result: {
    ok: true, value: { html: '<h1>Preview</h1>', hasMermaid: false, styles: { dark: 'dark', light: 'light' } }
  }
});
assert.deepEqual(decodePreviewRenderResponse({
  type: 'previewRenderResult', requestId: 'preview-1', result: {
    ok: false, error: { code: 'operation-failed', message: 'render failed' }
  }
}), {
  type: 'previewRenderResult', requestId: 'preview-1', result: {
    ok: false, error: { code: 'operation-failed', message: 'render failed' }
  }
});
assert.equal(decodePreviewRenderResponse({
  type: 'previewRenderResult', requestId: 'preview-1', result: {
    ok: true, value: { html: '<p>x</p>', hasMermaid: false, styles: { dark: 'dark' } }
  }
}), null);
let postedPreviewRequest: unknown;
let scheduledPreviewTimeout: (() => void) | null = null;
let canceledPreviewTimeouts = 0;
const previewTransport = createPreviewRenderTransport((message) => { postedPreviewRequest = message; }, {
  scheduleTimeout(callback) {
    scheduledPreviewTimeout = callback;
    return 'preview-timeout';
  },
  cancelTimeout(timeout) {
    assert.equal(timeout, 'preview-timeout');
    canceledPreviewTimeouts += 1;
  }
});
assert.equal(decodePreviewRenderRequest({
  type: 'requestPreviewRender', requestId: 'preview-language', text: '# Preview',
  environment: { previewFontFamily: '' }
}), null, 'Preview render requests without uiLanguage must be rejected');
const renderedPreview = previewTransport.render({ text: '# Preview', uiLanguage: 'en', environment: { previewFontFamily: '' } });
const previewRequestId = (postedPreviewRequest as { requestId: string }).requestId;
assert.match(previewRequestId, /^preview-\d+-0$/);
assert.equal(previewTransport.accept({
  type: 'previewRenderResult', requestId: previewRequestId, result: {
    ok: true, value: { html: '<h1>Preview</h1>', hasMermaid: false, styles: { dark: 'dark', light: 'light' } }
  }
}), true);
assert.deepEqual(await renderedPreview, {
  ok: true, value: { html: '<h1>Preview</h1>', hasMermaid: false, styles: { dark: 'dark', light: 'light' } }
});
assert.equal(canceledPreviewTimeouts, 1);
const timedOutPreview = previewTransport.render({ text: '# Timeout', uiLanguage: 'en', environment: { previewFontFamily: '' } });
const timedOutPreviewRequestId = (postedPreviewRequest as { requestId: string }).requestId;
const triggerPreviewTimeout = scheduledPreviewTimeout as (() => void) | null;
assert.notEqual(triggerPreviewTimeout, null);
triggerPreviewTimeout?.();
assert.deepEqual(await timedOutPreview, {
  ok: false, error: { code: 'timeout', message: 'Timed out while rendering Preview' }
});
assert.equal(previewTransport.accept({
  type: 'previewRenderResult', requestId: timedOutPreviewRequestId, result: {
    ok: true, value: { html: '<p>late</p>', hasMermaid: false, styles: { dark: '', light: '' } }
  }
}), false);
const failedPreviewTransport = createPreviewRenderTransport(() => { throw new Error('transport unavailable'); });
assert.deepEqual(await failedPreviewTransport.render({ text: '# Failed', uiLanguage: 'en', environment: { previewFontFamily: '' } }), {
  ok: false, error: { code: 'operation-failed', message: 'transport unavailable' }
});
const canceledPreview = previewTransport.render({ text: '# Canceled', uiLanguage: 'en', environment: { previewFontFamily: '' } });
const canceledPreviewRequestId = (postedPreviewRequest as { requestId: string }).requestId;
previewTransport.cancelAll('Preview closed');
assert.deepEqual(await canceledPreview, {
  ok: false, error: { code: 'operation-failed', message: 'Preview closed' }
});
assert.equal(previewTransport.accept({
  type: 'previewRenderResult', requestId: canceledPreviewRequestId, result: {
    ok: true, value: { html: '<p>late</p>', hasMermaid: false, styles: { dark: '', light: '' } }
  }
}), false);

assert.deepEqual(decodeExportSnapshotRequest({ type: 'requestExportSnapshot', requestId: 'export-1' }), {
  type: 'requestExportSnapshot', requestId: 'export-1'
});
assert.equal(decodeExportSnapshotRequest({ type: 'requestExportSnapshot', requestId: '' }), null);
const protocolReadingSnapshot = {
  snapshotId: 'export-1',
  text: '# Export',
  appearance: 'dark' as const,
  uiLanguage: 'zh-CN' as const,
  environment: { previewFontFamily: '', editorFontFamily: 'sans-serif' }
};
assert.deepEqual(decodeExportSnapshotResponse({
  type: 'exportSnapshotResult', requestId: 'export-1', result: {
    ok: true, value: protocolReadingSnapshot
  }
}), {
  type: 'exportSnapshotResult', requestId: 'export-1', result: {
    ok: true, value: protocolReadingSnapshot
  }
});
assert.deepEqual(decodeExportSnapshotResponse({
  type: 'exportSnapshotResult', requestId: 'export-1', result: {
    ok: false, error: { code: 'operation-failed', message: 'sync failed' }
  }
}), {
  type: 'exportSnapshotResult', requestId: 'export-1', result: {
    ok: false, error: { code: 'operation-failed', message: 'sync failed' }
  }
});
assert.equal(decodeExportSnapshotResponse({
  type: 'exportSnapshotResult', requestId: 'export-1', result: {
    ok: true, value: { ...protocolReadingSnapshot, environment: { previewFontFamily: '', liveLineHeight: '1.5' } }
  }
}), null);
assert.equal(decodeExportSnapshotResponse({
  type: 'exportSnapshotResult', requestId: 'export-1', result: {
    ok: true, value: { ...protocolReadingSnapshot, environment: { editorFontFamily: 'sans-serif' } }
  }
}), null, 'Export snapshots without previewFontFamily must be rejected');
assert.equal(decodeExportSnapshotResponse({
  type: 'exportSnapshotResult', requestId: 'export-1', result: {
    ok: true, value: { ...protocolReadingSnapshot, uiLanguage: undefined }
  }
}), null, 'Export snapshots without uiLanguage must be rejected');
let postedExportRequest: unknown;
let scheduledExportTimeout: (() => void) | null = null;
let canceledExportTimeouts = 0;
const exportTransport = createExportSnapshotTransport(async (message) => {
  postedExportRequest = message;
  return true;
}, {
  scheduleTimeout(callback) {
    scheduledExportTimeout = callback;
    return 'export-timeout';
  },
  cancelTimeout(timeout) {
    assert.equal(timeout, 'export-timeout');
    canceledExportTimeouts += 1;
  }
});
const exportSnapshot = exportTransport.request();
await Promise.resolve();
const exportRequestId = (postedExportRequest as { requestId: string }).requestId;
assert.match(exportRequestId, /^export-\d+-0$/);
assert.equal(exportTransport.accept({
  type: 'exportSnapshotResult', requestId: exportRequestId,
  result: { ok: true, value: { ...protocolReadingSnapshot, snapshotId: exportRequestId } }
}), true);
assert.deepEqual(await exportSnapshot, {
  ok: true,
  value: { ...protocolReadingSnapshot, snapshotId: exportRequestId }
});
assert.equal(canceledExportTimeouts, 1);
const timedOutExport = exportTransport.request();
await Promise.resolve();
const timedOutExportRequestId = (postedExportRequest as { requestId: string }).requestId;
const triggerExportTimeout = scheduledExportTimeout as (() => void) | null;
assert.notEqual(triggerExportTimeout, null);
triggerExportTimeout?.();
assert.deepEqual(await timedOutExport, {
  ok: false, error: { code: 'timeout', message: 'Timed out waiting for export snapshot from the editor.' }
});
assert.equal(exportTransport.accept({
  type: 'exportSnapshotResult', requestId: timedOutExportRequestId,
  result: {
    ok: true,
    value: { ...protocolReadingSnapshot, snapshotId: timedOutExportRequestId, text: '# Late' }
  }
}), false);
const closedExport = exportTransport.request();
exportTransport.close('editor closed');
assert.deepEqual(await closedExport, {
  ok: false, error: { code: 'operation-failed', message: 'editor closed' }
});
const unavailableExportTransport = createExportSnapshotTransport(async () => false);
assert.deepEqual(await unavailableExportTransport.request(), {
  ok: false, error: { code: 'operation-failed', message: 'The editor webview is not ready to export.' }
});
let postedExportResponse: unknown;
createExportSnapshotResponder((message) => { postedExportResponse = message; }).respond('export-response-1', {
  ok: true,
  value: { ...protocolReadingSnapshot, snapshotId: 'export-response-1', text: '# Response' }
});
assert.deepEqual(postedExportResponse, {
  type: 'exportSnapshotResult', requestId: 'export-response-1',
  result: {
    ok: true,
    value: { ...protocolReadingSnapshot, snapshotId: 'export-response-1', text: '# Response' }
  }
});
assert.deepEqual(decodeGitBaselineChangedEvent({
  type: 'gitBaselineChanged', version: 4,
  payload: { available: true, tracked: true, generation: 2, mode: 'git-head', baseText: '# Base' }
}), {
  type: 'gitBaselineChanged', version: 4,
  payload: { available: true, tracked: true, generation: 2, mode: 'git-head', baseText: '# Base' }
});
assert.equal(decodeGitBaselineChangedEvent({
  type: 'gitBaselineChanged', version: 4, payload: { available: true, tracked: true, mode: 'unknown' }
}), null);
for (const command of [
  { type: 'setMode', mode: 'preview' },
  { type: 'setGitChangesGutter', enabled: false },
  { type: 'setGitDiffDetailsVisible', visible: true },
  { type: 'setDiffBaselineMode', mode: 'git-head' },
  { type: 'setFixedBaseline', enabled: true },
  { type: 'updateFixedBaseline' },
  { type: 'releaseFixedBaseline' },
  { type: 'setOutlineVisible', visible: false },
  { type: 'setOutlinePosition', position: 'right' },
  { type: 'setOutlineWidth', width: 240 },
  { type: 'setContentMaxWidth', enabled: true },
  { type: 'setFindOptions', findOptions: { wholeWord: true, caseSensitive: false } },
  { type: 'openLink', href: 'docs/readme.md', source: 'preview' },
  { type: 'openImageExternally', url: 'file:///image.png' },
  { type: 'reloadDocumentFromDisk', topLine: 1 },
{ type: 'exportDocument', format: 'pdf' },
{ type: 'setPreviewAppearance', appearance: 'auto' },
{ type: 'setPreviewFontFamily', fontFamily: 'MEO Synthetic Sans' },
{ type: 'setPreviewSourceColoring', enabled: false },
 { type: 'setEditorAppearance', appearance: 'auto' },
 { type: 'setEditorFontSize', mode: 'custom', value: 18 }
]) {
  assert.notEqual(decodeEditorCommand(command), null, `Editor command was rejected: ${command.type}`);
}
assert.equal(decodeEditorCommand({ type: 'setMode', mode: 'unknown' }), null);
assert.equal(decodeEditorCommand({ type: 'setGitDiffDetailsVisible', visible: 'yes' }), null);
assert.equal(decodeEditorCommand({ type: 'saveDocument' }), null);
assert.equal(decodeEditorCommand({ type: 'setLineNumbers', visible: true }), null);
assert.equal(decodeEditorCommand({ type: 'setLongCodeBlockFolding', enabled: false }), null);
assert.equal(decodeEditorCommand({ type: 'viewPositionChanged', topLine: 3 }), null);
assert.equal(decodeEditorCommand({ type: 'viewPositionChanged', topLine: 0 }), null);
assert.equal(decodeEditorCommand({ type: 'setOutlineWidth', width: Number.NaN }), null);
assert.equal(decodeEditorCommand({ type: 'setEditorFontSize', mode: 'custom', value: 9 }), null);
assert.equal(decodeEditorCommand({ type: 'setEditorFontSize', mode: 'custom', value: 18.5 }), null);
assert.equal(decodeEditorCommand({ type: 'setEditorFontSize', mode: 'invalid', value: 18 }), null);
assert.equal(decodeEditorCommand({ type: 'setPreviewFontFamily', fontFamily: 'MEO\nSynthetic' }), null);
assert.equal(decodeEditorCommand({ type: 'setPreviewFontFamily', fontFamily: 'MEO</style>Synthetic' }), null);
assert.equal(decodeEditorCommand({ type: 'setPreviewFontFamily', fontFamily: 'x'.repeat(MAX_PREVIEW_FONT_FAMILY_LENGTH + 1) }), null);
assert.equal(decodeEditorCommand({ type: 'setPreviewFontFamily', previewFontFamily: 'MEO Synthetic Sans' }), null);
for (const event of [
  { type: 'focusEditor' },
  { type: 'revealSelection', anchor: 0, head: 4, preserveViewport: true },
  { type: 'revealDocumentFragment', href: '#intro' },
  { type: 'outlinePositionChanged', position: 'left' },
  { type: 'outlineVisibilityChanged', visible: true },
  { type: 'gitChangesGutterChanged', enabled: false },
  { type: 'gitDiffLineHighlightsChanged', enabled: true },
  { type: 'diffBaselineModeChanged', mode: 'recent-save' },
  { type: 'fixedBaselineChanged', pinned: true, active: false, updatedAt: 2_000 },
  { type: 'contentMaxWidthChanged', enabled: true },
  { type: 'findOptionsChanged', findOptions: { wholeWord: false, caseSensitive: true } }
]) {
  assert.notEqual(decodeHostEditorEvent(event), null, `Host editor event was rejected: ${event.type}`);
}
assert.equal(decodeHostEditorEvent({ type: 'revealSelection', anchor: -1, head: 0 }), null);
assert.equal(decodeHostEditorEvent({ type: 'lineNumbersChanged', enabled: true }), null);
assert.equal(decodeHostEditorEvent({ type: 'longCodeBlockFoldingChanged', enabled: true }), null);
assert.equal(decodeHostEditorEvent({ type: 'fixedBaselineChanged', pinned: true, active: 'yes' }), null);
assert.equal(decodeHostEditorEvent({
  type: 'fixedBaselineChanged', pinned: true, active: false, updatedAt: 'recently'
}), null);
assert.equal(decodeHostEditorEvent({ type: 'previewAppearanceChanged', appearance: 'light' }), null);
assert.equal(decodeHostEditorEvent({ type: 'previewSourceColoringChanged', enabled: false }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'previewAppearanceChanged', appearance: 'light' }), null);
assert.equal(decodeHostToWebviewMessage({ type: 'previewSourceColoringChanged', enabled: false }), null);
const vscodeThemeEvent = { type: 'vscodeCodeThemeChanged', appearance: 'dark', vscodeTheme: codeTheme } as const;
assert.deepEqual(decodeHostConfigurationEvent(vscodeThemeEvent), vscodeThemeEvent);
assert.equal(decodeHostConfigurationEvent({ type: 'vscodeCodeThemeChanged', vscodeTheme: codeTheme }), null);
assert.equal(decodeHostConfigurationEvent({ type: 'themeChanged', theme: {}, codeTheme }), null);
assert.equal(decodeHostConfigurationEvent({ type: 'shikiCodeBlocksChanged', enabled: true, codeTheme }), null);
assert.deepEqual(decodeHostConfigurationEvent({ type: 'toggleMode' }), { type: 'toggleMode' });
assert.deepEqual(decodeDiagnosticsChangedEvent({
  type: 'diagnosticsChanged', diagnostics: [{ from: 1, to: 3, severity: 2, message: 'Typo', source: 'meo' }]
}), {
  type: 'diagnosticsChanged', diagnostics: [{ from: 1, to: 3, severity: 2, message: 'Typo', source: 'meo' }]
});
assert.equal(decodeDiagnosticsChangedEvent({
  type: 'diagnosticsChanged', diagnostics: [{ from: 4, to: 3, severity: 2, message: 'bad' }]
}), null);
console.log('Protocol ready/init tests passed');
