import assert from 'node:assert/strict';
import { createExportSnapshotTransport } from '../src/host/exportSnapshotTransport';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import type { ReadingSnapshot } from '../src/protocol/exportSnapshot';
import exportRuntime from '../src/export/runtime';
import { createExportWebviewAdapter } from '../webview/src/adapters/exportWebviewAdapter';

type Deferred = {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
};

const createDeferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};

const createHarness = (initialText: string, initialAppearance: 'light' | 'dark', initialFontFamily: string) => {
  let text = initialText;
  let appearance = initialAppearance;
  let environment = {
    editorBackgroundColor: initialAppearance === 'dark' ? '#111111' : '#ffffff',
    previewFontFamily: initialFontFamily
  };
  let idle = createDeferred();
  let adapter!: ReturnType<typeof createExportWebviewAdapter>;
  const hostTransport = createExportSnapshotTransport(async (message) => {
    const decoded = decodeHostToWebviewMessage(message);
    return decoded !== null && adapter.accept(decoded);
  }, {
    scheduleTimeout: () => Symbol('export-timeout'),
    cancelTimeout: () => undefined
  });
  adapter = createExportWebviewAdapter({
    postMessage(message) {
      const decoded = decodeWebviewToHostMessage(message);
      if (decoded?.type === 'exportSnapshotResult') hostTransport.accept(decoded);
    },
    getCurrentText: () => text,
    whenDocumentIdle: () => idle.promise,
    getPreviewAppearance: () => appearance,
    getUiLanguage: () => 'zh-CN',
    getStyleEnvironment: () => environment
  });
  return {
    request: () => hostTransport.request(),
    replaceState(next: {
      readonly text: string;
      readonly appearance: 'light' | 'dark';
      readonly background: string;
      readonly fontFamily?: string;
    }) {
      text = next.text;
      appearance = next.appearance;
      environment = {
        editorBackgroundColor: next.background,
        previewFontFamily: next.fontFamily ?? environment.previewFontFamily
      };
    },
    resolveIdle: () => idle.resolve(),
    nextIdle: () => { idle = createDeferred(); },
    dispose: () => {
      adapter.dispose();
      hostTransport.close('panel closed');
    }
  };
};

const first = createHarness('# editor one old', 'light', 'MEO Synthetic Sans');
const second = createHarness('# editor two', 'light', 'MEO Synthetic Serif');
const firstPending = first.request();
const secondPending = second.request();
first.replaceState({ text: '# editor one current', appearance: 'dark', background: '#101010' });
first.resolveIdle();
second.resolveIdle();
const [firstResult, secondResult] = await Promise.all([firstPending, secondPending]);
assert.equal(firstResult.ok, true);
assert.equal(secondResult.ok, true);
if (!firstResult.ok || !secondResult.ok) throw new Error('ReadingSnapshot capture failed');

const firstSnapshot: ReadingSnapshot = firstResult.value;
assert.deepEqual(firstSnapshot, {
  snapshotId: firstSnapshot.snapshotId,
  text: '# editor one current',
  appearance: 'dark',
  uiLanguage: 'zh-CN',
  environment: { editorBackgroundColor: '#101010', previewFontFamily: 'MEO Synthetic Sans' }
});
assert.equal(secondResult.value.text, '# editor two', 'two Editor/panel transports must remain isolated');
assert.equal(secondResult.value.environment.previewFontFamily, 'MEO Synthetic Serif');
assert.notEqual(firstSnapshot.snapshotId.length, 0);
assert.notEqual(secondResult.value.snapshotId.length, 0);

first.replaceState({
  text: '# later edit', appearance: 'light', background: '#eeeeee', fontFamily: 'MEO Synthetic Serif'
});
const commonOutput = {
  sourceDocumentPath: 'C:/notes/input.md',
  outputFilePath: 'C:/notes/output.html',
  mermaidRuntimeSrc: 'file:///mermaid.js',
  katexStylesHref: 'file:///katex.css',
  baseHref: 'file:///C:/notes/',
  title: 'output'
};
for (const target of ['html', 'pdf'] as const) {
  const rendered = exportRuntime.renderExportHtmlDocument({
    readingSnapshot: firstSnapshot,
    target,
    ...commonOutput
  });
  assert.match(rendered.htmlDocument, /editor one current/);
  assert.doesNotMatch(rendered.htmlDocument, /later edit/);
  assert.match(rendered.htmlDocument, /#101010/);
  assert.match(rendered.htmlDocument, /MEO Synthetic Sans/);
  assert.doesNotMatch(rendered.htmlDocument, /MEO Synthetic Serif/);
}

assert.equal(decodeWebviewToHostMessage({ type: 'exportDocument', format: 'html', appearance: 'light' }), null);
assert.equal(decodeWebviewToHostMessage({ type: 'exportDocument', format: 'html' })?.type, 'exportDocument');
for (const invalid of [
  { text: '# split', appearance: 'dark', uiLanguage: 'en', environment: { previewFontFamily: '' } },
  { snapshotId: 'request-1', text: '# split', appearance: 'dark', environment: { previewFontFamily: '' } },
  { snapshotId: 'request-1', text: '# split', appearance: 'dark', uiLanguage: 'en' }
]) {
  assert.equal(decodeWebviewToHostMessage({
    type: 'exportSnapshotResult',
    requestId: 'request-1',
    result: { ok: true, value: invalid }
  }), null);
}
assert.equal(decodeWebviewToHostMessage({
  type: 'exportSnapshotResult',
  requestId: 'request-2',
  result: { ok: true, value: { ...firstSnapshot, snapshotId: 'request-1' } }
}), null, 'Protocol must preserve the single request/snapshot identity');

first.dispose();
second.dispose();
console.log('ReadingSnapshot production checks passed');
