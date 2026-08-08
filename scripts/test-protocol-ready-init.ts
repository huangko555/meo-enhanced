import assert from 'node:assert/strict';
import { decodeInitMessage, decodeReadyMessage } from '../src/protocol/readyInit';
import { decodeDocumentSyncCommand, decodeDocumentSyncMessage } from '../src/protocol/documentSync';
import { decodeResolveImageSrcRequest, decodeResolvedImageSrcResponse } from '../src/protocol/imageResolution';
import { createImageResolutionTransport } from '../webview/src/adapters/imageResolutionTransport';
import { decodeResolveWikiLinksRequest, decodeResolvedWikiLinksResponse } from '../src/protocol/wikiLinkResolution';
import { createWikiLinkResolutionTransport } from '../webview/src/adapters/wikiLinkResolutionTransport';
import { decodeResolveLocalLinksRequest, decodeResolvedLocalLinksResponse } from '../src/protocol/localLinkResolution';
import { createLocalLinkResolutionTransport } from '../webview/src/adapters/localLinkResolutionTransport';
import { decodeDiagnosticSuggestionsRequest, decodeDiagnosticSuggestionsResult } from '../src/protocol/diagnosticSuggestions';
import { createDiagnosticSuggestionsTransport } from '../webview/src/adapters/diagnosticSuggestionsTransport';
import { decodeSaveImageFromClipboardRequest, decodeSavedImagePathResponse } from '../src/protocol/clipboardImageSave';
import { createClipboardImageSaveTransport } from '../webview/src/adapters/clipboardImageSaveTransport';
import { decodePreviewRenderRequest, decodePreviewRenderResponse } from '../src/protocol/previewRender';
import { createPreviewRenderTransport } from '../webview/src/adapters/previewRenderTransport';
import { decodeExportSnapshotRequest, decodeExportSnapshotResponse } from '../src/protocol/exportSnapshot';
import { createExportSnapshotTransport } from '../src/host/exportSnapshotTransport';
import { createExportSnapshotResponder } from '../webview/src/adapters/exportSnapshotTransport';
import { decodeGitBaselineChangedEvent, decodeGitBlameRequest, decodeGitBlameResponse, decodeGitNavigationCommand } from '../src/protocol/git';
import { createGitBlameTransport } from '../webview/src/adapters/gitBlameTransport';
import { decodeEditorCommand } from '../src/protocol/editorCommands';
import { decodeHostEditorEvent } from '../src/protocol/hostEditorEvents';
import { decodeHostConfigurationEvent } from '../src/protocol/hostConfigurationEvents';
import { decodeDiagnosticsChangedEvent } from '../src/protocol/diagnostics';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import { createDocumentSessionCoordinatorFromInit } from '../webview/src/adapters/documentSessionTransport';

const theme = {
  id: 'dark',
  name: 'Dark',
  backgroundColor: '#111',
  colors: { base01: '#fff' },
  semanticColors: { foreground: '#fff' },
  syntaxTokens: { keyword: '#f00' },
  fonts: {
    liveFont: '', sourceFont: '', liveFontWeight: '', sourceFontWeight: '',
    liveFontSize: null, sourceFontSize: null,
    h1FontSize: 1.6, h2FontSize: 1.5, h3FontSize: 1.3,
    h4FontSize: 1.2, h5FontSize: 1.1, h6FontSize: 1,
    h1FontWeight: '400', h2FontWeight: '400', h3FontWeight: '400',
    h4FontWeight: '400', h5FontWeight: '400', h6FontWeight: '400',
    liveLineHeight: 1.5, sourceLineHeight: 1.5
  }
};
const codeTheme = { name: 'VS Dark', type: 'dark' as const, colors: {}, tokenColors: [] };
const completeInit = {
  type: 'init' as const,
  documentId: 'file:///notes.md',
  text: '# title',
  version: 3,
  savedRevision: { version: null, text: '# saved title' },
  diagnostics: [],
  mode: 'live' as const,
  previewAppearance: 'dark' as const,
  editorAppearance: 'dark' as const,
  lineNumbers: true,
  gitChangesGutter: true,
  gitBlameEnabled: false,
  gitDiffLineHighlights: true,
  diffBaselineMode: 'git-head' as const,
  fixedBaselinePinned: false,
  fixedBaselineActive: false,
  spellCheckEnabled: true,
  contentMaxWidthEnabled: true,
  longCodeBlockFoldingEnabled: true,
  vimMode: false,
  vimKeybindings: [],
  vimLeader: ' ',
  findOptions: { wholeWord: false, caseSensitive: false },
  outlinePosition: 'right' as const,
  outlineVisible: true,
  outlineWidth: 260,
  theme,
  shikiCodeBlocks: true,
  codeTheme
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
assert.equal(decodeInitMessage({ ...completeInit, savedRevision: undefined }), null);
assert.equal(decodeInitMessage({ ...completeInit, savedRevision: { version: -1, text: '# saved' } }), null);
assert.equal(decodeInitMessage({ ...completeInit, savedRevision: { version: 4, text: '# future' } }), null);
assert.equal(decodeInitMessage({ ...completeInit, savedRevision: { version: 3, text: '# contradiction' } }), null);
assert.notEqual(decodeInitMessage({ ...completeInit, savedRevision: null }), null);
assert.equal(decodeInitMessage({ ...completeInit, mode: 'bad' }), null);
assert.equal(decodeInitMessage({ ...completeInit, previewAppearance: 'broken' }), null);
for (const requiredKey of [
  'documentId', 'savedRevision', 'diagnostics', 'previewAppearance', 'editorAppearance', 'lineNumbers', 'gitChangesGutter',
  'gitBlameEnabled', 'gitDiffLineHighlights', 'diffBaselineMode', 'fixedBaselinePinned',
  'fixedBaselineActive', 'spellCheckEnabled', 'contentMaxWidthEnabled', 'longCodeBlockFoldingEnabled',
  'vimMode', 'vimKeybindings', 'vimLeader', 'findOptions', 'outlinePosition', 'outlineVisible',
  'outlineWidth', 'theme', 'shikiCodeBlocks', 'codeTheme'
]) {
  const incomplete = { ...completeInit } as Record<string, unknown>;
  delete incomplete[requiredKey];
  assert.equal(decodeInitMessage(incomplete), null, `Init without ${requiredKey} must be rejected`);
}
assert.deepEqual(decodeHostToWebviewMessage(completeInit), completeInit);
assert.deepEqual(decodeWebviewToHostMessage({ type: 'ready' }), { type: 'ready' });
assert.deepEqual(decodeDocumentSyncMessage({ type: 'docChanged', text: 'next', version: 4 }), {
  type: 'docChanged', text: 'next', version: 4
});
assert.deepEqual(decodeDocumentSyncMessage({ type: 'applied', version: 4 }), { type: 'applied', version: 4 });
assert.deepEqual(decodeDocumentSyncMessage({ type: 'discardedChanges', text: 'base', version: 5 }), {
  type: 'discardedChanges', text: 'base', version: 5, topLine: 1, topLineOffset: 0
});
assert.equal(decodeDocumentSyncMessage({ type: 'docChanged', text: 'bad', version: -1 }), null);
assert.deepEqual(decodeDocumentSyncCommand({ type: 'draftChanged', text: null }), { type: 'draftChanged', text: null });
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
assert.deepEqual(decodeDiagnosticSuggestionsRequest({
  type: 'requestDiagnosticSuggestions', requestId: 'diag-1', from: 2, to: 4, message: 'Unknown name'
}), { type: 'requestDiagnosticSuggestions', requestId: 'diag-1', from: 2, to: 4, message: 'Unknown name' });
assert.equal(decodeDiagnosticSuggestionsRequest({
  type: 'requestDiagnosticSuggestions', requestId: 'diag-1', from: 5, to: 4, message: 'bad'
}), null);
assert.deepEqual(decodeDiagnosticSuggestionsResult({
  type: 'diagnosticSuggestionsResult', requestId: 'diag-1', from: 2, to: 4,
  result: { ok: true, value: { suggestions: ['Fix'] } }
}), {
  type: 'diagnosticSuggestionsResult', requestId: 'diag-1', from: 2, to: 4,
  result: { ok: true, value: { suggestions: ['Fix'] } }
});
assert.deepEqual(decodeDiagnosticSuggestionsResult({
  type: 'diagnosticSuggestionsResult', requestId: 'diag-1', from: 2, to: 4,
  result: { ok: false, error: { code: 'operation-failed', message: 'unavailable' } }
}), {
  type: 'diagnosticSuggestionsResult', requestId: 'diag-1', from: 2, to: 4,
  result: { ok: false, error: { code: 'operation-failed', message: 'unavailable' } }
});
let postedDiagnosticRequest: unknown;
const diagnosticResults: unknown[] = [];
let scheduledDiagnosticTimeout: (() => void) | null = null;
let canceledDiagnosticTimeouts = 0;
const diagnosticTransport = createDiagnosticSuggestionsTransport(
  (message) => { postedDiagnosticRequest = message; },
  (message) => { diagnosticResults.push(message); },
  {
    scheduleTimeout(callback) {
      scheduledDiagnosticTimeout = callback;
      return 'diagnostic-timeout';
    },
    cancelTimeout(timeout) {
      assert.equal(timeout, 'diagnostic-timeout');
      canceledDiagnosticTimeouts += 1;
    }
  }
);
const diagnosticRequestId = diagnosticTransport.request({
  from: 0, to: 1, message: 'Missing', code: 'x'
});
assert.match(diagnosticRequestId, /^diagnostic-suggestions-\d+-0$/);
assert.deepEqual(postedDiagnosticRequest, {
  type: 'requestDiagnosticSuggestions', requestId: diagnosticRequestId, from: 0, to: 1, message: 'Missing', code: 'x'
});
assert.equal(diagnosticTransport.accept({
  type: 'diagnosticSuggestionsResult', requestId: diagnosticRequestId, from: 0, to: 1,
  result: { ok: true, value: { suggestions: ['Fixed'] } }
}), true);
assert.deepEqual(diagnosticResults.at(-1), {
  type: 'diagnosticSuggestionsResult', requestId: diagnosticRequestId, from: 0, to: 1,
  result: { ok: true, value: { suggestions: ['Fixed'] } }
});
assert.equal(canceledDiagnosticTimeouts, 1);
const timedOutDiagnosticId = diagnosticTransport.request({ from: 2, to: 3, message: 'Missing' });
const triggerDiagnosticTimeout = scheduledDiagnosticTimeout as (() => void) | null;
assert.notEqual(triggerDiagnosticTimeout, null);
triggerDiagnosticTimeout?.();
assert.deepEqual(diagnosticResults.at(-1), {
  type: 'diagnosticSuggestionsResult', requestId: timedOutDiagnosticId, from: 2, to: 3,
  result: { ok: false, error: { code: 'timeout', message: 'Timed out while resolving diagnostic suggestions' } }
});
assert.equal(diagnosticTransport.accept({
  type: 'diagnosticSuggestionsResult', requestId: timedOutDiagnosticId, from: 2, to: 3,
  result: { ok: true, value: { suggestions: [] } }
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
  type: 'requestPreviewRender', requestId: 'preview-1', text: '# Preview',
  environment: { editorFontFamily: 'sans-serif', editorFontSizePx: 14, meoThemeColors: { base00: '#fff' } }
}), {
  type: 'requestPreviewRender', requestId: 'preview-1', text: '# Preview',
  environment: { editorFontFamily: 'sans-serif', editorFontSizePx: 14, meoThemeColors: { base00: '#fff' } }
});
assert.equal(decodePreviewRenderRequest({
  type: 'requestPreviewRender', requestId: 'preview-1', text: '# Preview', environment: { editorFontSizePx: '14' }
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
const renderedPreview = previewTransport.render({ text: '# Preview' });
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
const timedOutPreview = previewTransport.render({ text: '# Timeout' });
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
assert.deepEqual(await failedPreviewTransport.render({ text: '# Failed' }), {
  ok: false, error: { code: 'operation-failed', message: 'transport unavailable' }
});

assert.deepEqual(decodeExportSnapshotRequest({ type: 'requestExportSnapshot', requestId: 'export-1' }), {
  type: 'requestExportSnapshot', requestId: 'export-1'
});
assert.equal(decodeExportSnapshotRequest({ type: 'requestExportSnapshot', requestId: '' }), null);
assert.deepEqual(decodeExportSnapshotResponse({
  type: 'exportSnapshotResult', requestId: 'export-1', result: {
    ok: true, value: { text: '# Export', environment: { editorFontFamily: 'sans-serif' } }
  }
}), {
  type: 'exportSnapshotResult', requestId: 'export-1', result: {
    ok: true, value: { text: '# Export', environment: { editorFontFamily: 'sans-serif' } }
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
    ok: true, value: { text: '# Export', environment: { liveLineHeight: '1.5' } }
  }
}), null);
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
  result: { ok: true, value: { text: '# Export' } }
}), true);
assert.deepEqual(await exportSnapshot, { ok: true, value: { text: '# Export' } });
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
  result: { ok: true, value: { text: '# Late' } }
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
  ok: true, value: { text: '# Response' }
});
assert.deepEqual(postedExportResponse, {
  type: 'exportSnapshotResult', requestId: 'export-response-1',
  result: { ok: true, value: { text: '# Response' } }
});
assert.deepEqual(decodeGitBlameRequest({
  type: 'requestGitBlame', requestId: 'blame-1', lineNumber: 2, localEditGeneration: 3, text: 'draft'
}), {
  type: 'requestGitBlame', requestId: 'blame-1', lineNumber: 2, localEditGeneration: 3, text: 'draft'
});
assert.equal(decodeGitBlameRequest({
  type: 'requestGitBlame', requestId: 'blame-1', lineNumber: 0, localEditGeneration: 3
}), null);
const gitCommit = {
  kind: 'commit' as const,
  commit: '1234567890abcdef', shortCommit: '12345678', author: 'Example Author',
  authorTimeUnix: 1_700_000_000, summary: 'Example commit'
};
assert.deepEqual(decodeGitBlameResponse({
  type: 'gitBlameResult', requestId: 'blame-1', lineNumber: 2, localEditGeneration: 3,
  result: { ok: true, value: gitCommit }
}), {
  type: 'gitBlameResult', requestId: 'blame-1', lineNumber: 2, localEditGeneration: 3,
  result: { ok: true, value: gitCommit }
});
assert.equal(decodeGitBlameResponse({
  type: 'gitBlameResult', requestId: 'blame-1', lineNumber: 2, localEditGeneration: 3,
  result: { ok: true, value: { ...gitCommit, authorTimeUnix: 'today' } }
}), null);
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
let postedBlameRequest: unknown;
let scheduledBlameTimeout: (() => void) | null = null;
let canceledBlameTimeouts = 0;
const blameTransport = createGitBlameTransport((message) => { postedBlameRequest = message; }, {
  scheduleTimeout(callback) {
    scheduledBlameTimeout = callback;
    return 'blame-timeout';
  },
  cancelTimeout(timeout) {
    assert.equal(timeout, 'blame-timeout');
    canceledBlameTimeouts += 1;
  }
});
const blamedLine = blameTransport.request({ lineNumber: 2, localEditGeneration: 3 });
assert.deepEqual(postedBlameRequest, {
  type: 'requestGitBlame', requestId: 'blame-0', lineNumber: 2, localEditGeneration: 3
});
assert.equal(blameTransport.accept({
  type: 'gitBlameResult', requestId: 'blame-0', lineNumber: 2, localEditGeneration: 3,
  result: { ok: true, value: gitCommit }
}), true);
assert.deepEqual(await blamedLine, { ok: true, value: gitCommit });
assert.equal(canceledBlameTimeouts, 1);
const timedOutBlame = blameTransport.request({ lineNumber: 3, localEditGeneration: 3 });
const triggerBlameTimeout = scheduledBlameTimeout as (() => void) | null;
assert.notEqual(triggerBlameTimeout, null);
triggerBlameTimeout?.();
assert.deepEqual(await timedOutBlame, {
  ok: false, error: { code: 'timeout', message: 'Timed out while resolving Git blame' }
});
assert.equal(blameTransport.accept({
  type: 'gitBlameResult', requestId: 'blame-1', lineNumber: 3, localEditGeneration: 3,
  result: { ok: true, value: { kind: 'uncommitted' } }
}), false);
const canceledBlame = blameTransport.request({ lineNumber: 4, localEditGeneration: 3 });
blameTransport.cancelAll();
assert.deepEqual(await canceledBlame, {
  ok: false, error: { code: 'operation-failed', message: 'Git blame request superseded' }
});
for (const command of [
  { type: 'setMode', mode: 'preview' },
  { type: 'setLineNumbers', visible: true },
  { type: 'setGitChangesGutter', enabled: false },
  { type: 'setGitBlame', enabled: true },
  { type: 'setDiffBaselineMode', mode: 'git-head' },
  { type: 'setFixedBaseline', enabled: true },
  { type: 'releaseFixedBaseline' },
  { type: 'setSpellCheck', enabled: true },
  { type: 'setOutlineVisible', visible: false },
  { type: 'setOutlinePosition', position: 'right' },
  { type: 'setOutlineWidth', width: 240 },
  { type: 'setContentMaxWidth', enabled: true },
  { type: 'setLongCodeBlockFolding', enabled: false },
  { type: 'setFindOptions', findOptions: { wholeWord: true, caseSensitive: false } },
  { type: 'viewPositionChanged', topLine: 3, topLineOffset: 0.5 },
  { type: 'openLink', href: 'docs/readme.md', source: 'preview' },
  { type: 'openImageExternally', url: 'file:///image.png' },
  { type: 'discardChanges', topLine: 1 },
  { type: 'exportDocument', format: 'pdf', appearance: 'dark' },
  { type: 'setPreviewAppearance', appearance: 'light' },
  { type: 'setEditorAppearance', appearance: 'dark' }
]) {
  assert.notEqual(decodeEditorCommand(command), null, `Editor command was rejected: ${command.type}`);
}
assert.equal(decodeEditorCommand({ type: 'setMode', mode: 'unknown' }), null);
assert.equal(decodeEditorCommand({ type: 'saveDocument' }), null);
assert.equal(decodeEditorCommand({ type: 'viewPositionChanged', topLine: 0 }), null);
assert.equal(decodeEditorCommand({ type: 'setOutlineWidth', width: Number.NaN }), null);
for (const event of [
  { type: 'focusEditor' },
  { type: 'revealSelection', anchor: 0, head: 4, preserveViewport: true },
  { type: 'revealDocumentFragment', href: '#intro' },
  { type: 'previewAppearanceChanged', appearance: 'light' },
  { type: 'outlinePositionChanged', position: 'left' },
  { type: 'outlineVisibilityChanged', visible: true },
  { type: 'lineNumbersChanged', enabled: true },
  { type: 'gitChangesGutterChanged', enabled: false },
  { type: 'gitBlameChanged', enabled: true },
  { type: 'gitDiffLineHighlightsChanged', enabled: true },
  { type: 'diffBaselineModeChanged', mode: 'recent-save' },
  { type: 'fixedBaselineChanged', pinned: true, active: false },
  { type: 'spellCheckChanged', enabled: true },
  { type: 'contentMaxWidthChanged', enabled: true },
  { type: 'longCodeBlockFoldingChanged', enabled: true },
  { type: 'findOptionsChanged', findOptions: { wholeWord: false, caseSensitive: true } }
]) {
  assert.notEqual(decodeHostEditorEvent(event), null, `Host editor event was rejected: ${event.type}`);
}
assert.equal(decodeHostEditorEvent({ type: 'revealSelection', anchor: -1, head: 0 }), null);
assert.equal(decodeHostEditorEvent({ type: 'fixedBaselineChanged', pinned: true, active: 'yes' }), null);
assert.deepEqual(decodeGitNavigationCommand({
  type: 'openGitRevisionForLine', lineNumber: 4, text: 'draft'
}), { type: 'openGitRevisionForLine', lineNumber: 4, text: 'draft' });
assert.deepEqual(decodeGitNavigationCommand({
  type: 'openGitWorktreeForLine', lineNumber: 4
}), { type: 'openGitWorktreeForLine', lineNumber: 4 });
assert.equal(decodeGitNavigationCommand({ type: 'openGitRevisionForLine', lineNumber: 0 }), null);
const themeEvent = {
  type: 'themeChanged',
  theme,
  codeTheme
};
assert.deepEqual(decodeHostConfigurationEvent(themeEvent), themeEvent);
assert.deepEqual(decodeHostConfigurationEvent({ type: 'toggleMode' }), { type: 'toggleMode' });
assert.deepEqual(decodeHostConfigurationEvent({ type: 'vimModeChanged', enabled: true }), {
  type: 'vimModeChanged', enabled: true
});
assert.deepEqual(decodeHostConfigurationEvent({
  type: 'vimKeybindingsChanged', leaderKey: ' ',
  keybindings: [{ before: 'j', after: 'gj', mode: 'normal', recursive: false }]
}), {
  type: 'vimKeybindingsChanged', leaderKey: ' ',
  keybindings: [{ before: 'j', after: 'gj', mode: 'normal', recursive: false }]
});
assert.equal(decodeHostConfigurationEvent({ type: 'vimModeChanged', enabled: 'yes' }), null);
assert.deepEqual(decodeDiagnosticsChangedEvent({
  type: 'diagnosticsChanged', diagnostics: [{ from: 1, to: 3, severity: 2, message: 'Typo', source: 'meo' }]
}), {
  type: 'diagnosticsChanged', diagnostics: [{ from: 1, to: 3, severity: 2, message: 'Typo', source: 'meo' }]
});
assert.equal(decodeDiagnosticsChangedEvent({
  type: 'diagnosticsChanged', diagnostics: [{ from: 4, to: 3, severity: 2, message: 'bad' }]
}), null);
console.log('Protocol ready/init tests passed');
