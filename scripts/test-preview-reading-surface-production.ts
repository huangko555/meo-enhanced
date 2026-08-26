import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import exportRuntime from '../src/export/runtime';

const root = path.resolve(import.meta.dir, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-reading-surface-'));
const sourceDocumentPath = path.join(temp, 'preview-reading-surface.md');
const longToken = 'wrappable'.repeat(90);
const longKbdToken = 'K'.repeat(500);
const longLinkToken = 'linked'.repeat(80);
const codeSource = `/* comment\n${longToken}\ncontinues */\n`;
const mermaidFallbackSource = `invalid ${longToken}\n`;
const mermaidWideSource = 'flowchart LR\n  wide_fit_start --> wide_fit_end\n';
const mermaidTallSource = 'flowchart TD\n  tall_fit_start --> tall_fit_end\n';
const dataImage = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const safeHtmlWideImage = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="120" viewBox="0 0 1600 120"><rect width="1600" height="120" fill="#999"/></svg>',
  'utf8'
).toString('base64');
fs.writeFileSync(
  path.join(temp, 'landscape.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="400" viewBox="0 0 1600 400"><rect width="1600" height="400" fill="#567"/></svg>',
  'utf8'
);
fs.writeFileSync(
  path.join(temp, 'portrait.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="1200" viewBox="0 0 300 1200"><rect width="300" height="1200" fill="#678"/></svg>',
  'utf8'
);
fs.writeFileSync(
  path.join(temp, 'linked.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="600" viewBox="0 0 1200 600"><rect width="1200" height="600" fill="#789"/></svg>',
  'utf8'
);
const deterministicMermaidRuntimeSrc = `data:text/javascript;base64,${Buffer.from(`
  window.mermaid = {
    initialize() {},
    async render(_id, source) {
      if (source.includes('invalid')) throw new Error('invalid diagram');
      if (source.includes('wide_fit')) {
        return { svg: '<svg data-fit-diagram="wide" width="2400" height="600" viewBox="0 0 2400 600" preserveAspectRatio="xMidYMid meet" role="img" xmlns="http://www.w3.org/2000/svg"><title>Wide fit diagram</title><rect class="meo-fit-graphic" x="12" y="12" width="2376" height="576" fill="none" stroke="currentColor" stroke-width="12"/><path class="meo-fit-graphic" d="M220 294 H2180 V306 H220 Z" fill="currentColor"/><text class="meo-fit-graphic meo-fit-label" x="24" y="80">Wide start label</text><a href="https://example.com/wide"><text class="meo-fit-graphic meo-fit-label" x="2376" y="540" text-anchor="end">Wide end label</text></a><foreignObject class="meo-fit-graphic" x="1900" y="210" width="460" height="120"><div xmlns="http://www.w3.org/1999/xhtml" class="nodeLabel">Wide foreign label</div></foreignObject></svg>' };
      }
      return { svg: '<svg data-fit-diagram="tall" width="600" height="2400" viewBox="0 0 600 2400" preserveAspectRatio="xMidYMid meet" role="img" xmlns="http://www.w3.org/2000/svg"><title>Tall fit diagram</title><rect class="meo-fit-graphic" x="12" y="12" width="576" height="2376" fill="none" stroke="currentColor" stroke-width="12"/><path class="meo-fit-graphic" d="M294 220 H306 V2180 H294 Z" fill="currentColor"/><text class="meo-fit-graphic meo-fit-label" x="24" y="80">Tall start label</text><text class="meo-fit-graphic meo-fit-label" x="576" y="2340" text-anchor="end">Tall end label</text><foreignObject class="meo-fit-graphic" x="70" y="2080" width="460" height="120"><div xmlns="http://www.w3.org/1999/xhtml" class="nodeLabel">Tall foreign label</div></foreignObject></svg>' };
    }
  };
`, 'utf8').toString('base64')}`;
const markdown = [
  `![Data alt](data:image/png;base64,${dataImage} "Data title")`,
  '',
  '![Landscape alt](landscape.svg "Landscape title")',
  '',
  `Selection before [![Linked alt](linked.svg "Linked image title")](https://example.com/linked-image "Linked anchor title") selection after`,
  '',
  '![Portrait alt](portrait.svg "Portrait title")',
  '',
  '![Broken alt](data:image/png;base64,invalid "Broken title")',
  '',
  `<img alt="Safe HTML wide" width="1600" height="120" src="data:image/svg+xml;base64,${safeHtmlWideImage}">`,
  '',
  '```javascript',
  '/* comment',
  longToken,
  'continues */',
  '```',
  '',
  '```mermaid',
  mermaidWideSource.trimEnd(),
  '```',
  '',
  '```mermaid',
  mermaidTallSource.trimEnd(),
  '```',
  '',
  '```mermaid',
  `invalid ${longToken}`,
  '```',
  '',
  '| Key | Link | Code | Four | Five | Six | Seven | Eight |',
  '| --- | --- | --- | --- | --- | --- | --- | --- |',
  `| <kbd>${longKbdToken}</kbd> | [${longLinkToken}](https://example.com/table) | \`${longToken}\` | <ul><li>Apple</li><li>Banana</li></ul> | five | six | seven | eight |`,
  '| | | | | | | | |',
  '',
  `<table><thead><tr><th>Safe HTML</th><th>Value</th></tr></thead><tbody><tr><td><kbd>${longKbdToken}</kbd></td><td>reachable</td></tr></tbody></table>`,
  '',
  'Prose shortcut: <kbd>Ctrl+Shift+P</kbd>',
  '',
  '$$x^2 + y^2 = z^2$$'
].join('\n');

const initMessage = {
  type: 'init',
  documentId: 'file:///preview-reading-surface.md',
  text: markdown,
  version: 1,
  savedRevision: { version: 1, text: markdown },
  diagnostics: [],
  mode: 'preview',
  previewAppearance: 'light',
  previewSourceColoring: true,
  editorAppearance: 'light',
  gitChangesGutter: false,
  gitDiffLineHighlights: false,
  diffBaselineMode: 'current-edit',
  fixedBaselinePinned: false,
  fixedBaselineActive: false,
  contentMaxWidthEnabled: false,
  findOptions: { wholeWord: false, caseSensitive: false },
  outlinePosition: 'right',
  outlineVisible: false,
  outlineWidth: 260,
  vscodeTheme: null
} as const;

type PreviewOpenLink = { readonly type: 'openLink'; readonly href: string; readonly source: 'preview' };
type OpenLinkWaiterState = 'idle' | 'pending' | 'resolved' | 'rejected' | 'disposed';

function createOpenLinkWaiter(options: {
  readonly timeoutMs: number;
  readonly scheduleTimeout: (callback: () => void, timeoutMs: number) => unknown;
  readonly cancelTimeout: (handle: unknown) => void;
}) {
  let state: OpenLinkWaiterState = 'idle';
  let accept: ((message: PreviewOpenLink) => void) | null = null;
  let reject: ((error: Error) => void) | null = null;
  let timeoutHandle: unknown = null;

  const clearPending = () => {
    if (timeoutHandle !== null) options.cancelTimeout(timeoutHandle);
    timeoutHandle = null;
    accept = null;
    reject = null;
  };
  const settleResolved = (message: PreviewOpenLink) => {
    if (state !== 'pending' || !accept) return false;
    const acceptPending = accept;
    clearPending();
    state = 'resolved';
    acceptPending(message);
    return true;
  };
  const settleRejected = (error: Error, nextState: 'rejected' | 'disposed') => {
    if (state !== 'pending' || !reject) return false;
    const rejectPending = reject;
    clearPending();
    state = nextState;
    rejectPending(error);
    return true;
  };

  return {
    wait: () => {
      assert.notEqual(state, 'pending', 'Only one linked-image activation may be pending');
      assert.notEqual(state, 'disposed', 'Disposed linked-image activation waiter cannot be reused');
      state = 'pending';
      return new Promise<PreviewOpenLink>((resolve, rejectPromise) => {
        accept = resolve;
        reject = rejectPromise;
        timeoutHandle = options.scheduleTimeout(() => {
          settleRejected(
            new Error('Preview openLink was not delivered before the default browser-test timeout'),
            'rejected'
          );
        }, options.timeoutMs);
      });
    },
    resolve: (message: PreviewOpenLink) => settleResolved(message),
    reject: (error: Error) => settleRejected(error, 'rejected'),
    dispose: (error: Error) => {
      if (state === 'disposed') return;
      if (!settleRejected(error, 'disposed')) {
        clearPending();
        state = 'disposed';
      }
    },
    getState: () => state
  };
}

async function activateAndWaitForOpenLink(
  waiter: ReturnType<typeof createOpenLinkWaiter>,
  action: () => Promise<void>
): Promise<PreviewOpenLink> {
  const observedResult = waiter.wait().then(
    (value) => ({ status: 'fulfilled', value } as const),
    (error: unknown) => ({ status: 'rejected', error } as const)
  );
  try {
    await action();
  } catch (error) {
    const primaryError = error instanceof Error ? error : new Error(String(error));
    waiter.reject(primaryError);
    await observedResult;
    throw primaryError;
  }
  const outcome = await observedResult;
  if (outcome.status === 'rejected') throw outcome.error;
  return outcome.value;
}

async function assertOpenLinkWaiterLifecycle(defaultTimeoutMs: number): Promise<void> {
  let scheduled: { callback: () => void; timeoutMs: number } | null = null;
  let cancellationCount = 0;
  const createWaiter = () => createOpenLinkWaiter({
    timeoutMs: defaultTimeoutMs,
    scheduleTimeout: (callback, timeoutMs) => {
      assert.equal(scheduled, null, 'Waiter must own at most one timeout');
      scheduled = { callback, timeoutMs };
      return scheduled;
    },
    cancelTimeout: (handle) => {
      if (scheduled === handle) {
        cancellationCount += 1;
        scheduled = null;
      }
    }
  });
  const message: PreviewOpenLink = {
    type: 'openLink', href: 'https://example.com/linked-image', source: 'preview'
  };

  const success = createWaiter();
  assert.equal(success.getState(), 'idle');
  const successResult = success.wait();
  assert.equal(success.getState(), 'pending');
  assert.equal(success.resolve(message), true);
  assert.deepEqual(await successResult, message);
  assert.equal(success.getState(), 'resolved');
  assert.equal(scheduled, null);
  assert.equal(cancellationCount, 1);
  assert.equal(success.resolve(message), false);
  assert.equal(success.reject(new Error('duplicate settle must be ignored')), false);
  assert.equal(cancellationCount, 1);

  const missing = createWaiter();
  assert.equal(missing.getState(), 'idle');
  const missingResult = missing.wait();
  assert.equal(scheduled?.timeoutMs, defaultTimeoutMs);
  scheduled?.callback();
  await assert.rejects(missingResult, /default browser-test timeout/);
  assert.equal(missing.getState(), 'rejected');
  assert.equal(scheduled, null);
  assert.equal(cancellationCount, 2);
  assert.equal(missing.reject(new Error('duplicate rejection must be ignored')), false);
  assert.equal(cancellationCount, 2);

  const decoderError = createWaiter();
  assert.equal(decoderError.getState(), 'idle');
  const decoderResult = decoderError.wait();
  const primaryDecoderError = new Error('openLink Protocol decoding failed');
  assert.equal(decoderError.reject(primaryDecoderError), true);
  await assert.rejects(decoderResult, (error) => error === primaryDecoderError);
  assert.equal(decoderError.getState(), 'rejected');
  assert.equal(scheduled, null);
  assert.equal(cancellationCount, 3);

  const actionError = createWaiter();
  assert.equal(actionError.getState(), 'idle');
  const primaryActionError = new Error('Preview activation action failed');
  await assert.rejects(
    activateAndWaitForOpenLink(actionError, async () => { throw primaryActionError; }),
    (error) => error === primaryActionError
  );
  assert.equal(actionError.getState(), 'rejected');
  assert.equal(scheduled, null);
  assert.equal(cancellationCount, 4);

  const decoderFirst = createWaiter();
  assert.equal(decoderFirst.getState(), 'idle');
  let finishPendingAction: () => void = () => assert.fail('Pending action resolver was not installed');
  const decoderFirstResult = activateAndWaitForOpenLink(
    decoderFirst,
    () => new Promise<void>((resolve) => { finishPendingAction = resolve; })
  );
  assert.equal(decoderFirst.getState(), 'pending');
  const primaryEarlyDecoderError = new Error('openLink decoder failed while activation remained pending');
  assert.equal(decoderFirst.reject(primaryEarlyDecoderError), true);
  finishPendingAction();
  await assert.rejects(decoderFirstResult, (error) => error === primaryEarlyDecoderError);
  assert.equal(decoderFirst.getState(), 'rejected');
  assert.equal(scheduled, null);
  assert.equal(cancellationCount, 5);

  const disposed = createWaiter();
  assert.equal(disposed.getState(), 'idle');
  const disposedResult = disposed.wait();
  const primaryDisposeError = new Error('Preview page closed before openLink delivery');
  disposed.dispose(primaryDisposeError);
  await assert.rejects(disposedResult, (error) => error === primaryDisposeError);
  assert.equal(disposed.getState(), 'disposed');
  assert.equal(scheduled, null);
  assert.equal(cancellationCount, 6);
  disposed.dispose(new Error('duplicate dispose must be ignored'));
  assert.equal(disposed.getState(), 'disposed');
  assert.equal(cancellationCount, 6);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(root, 'scripts', 'test-preview-reading-surface-production-entry.ts')],
    outdir: temp,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  let openLinkWaiter: ReturnType<typeof createOpenLinkWaiter> | null = null;
  try {
    const page = await browser.newPage();
    await assertOpenLinkWaiterLifecycle(page.getDefaultTimeout());
    openLinkWaiter = createOpenLinkWaiter({
      timeoutMs: page.getDefaultTimeout(),
      scheduleTimeout: (callback, timeoutMs) => setTimeout(callback, timeoutMs),
      cancelTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
    });
    await browser.defaultBrowserContext().overridePermissions('http://localhost', ['clipboard-read', 'clipboard-write']);
    await page.exposeFunction('__deliverWebviewMessageToHost', (raw: unknown) => {
      let message;
      try {
        message = decodeWebviewToHostMessage(raw);
        assert.ok(message, 'Webview message failed Protocol decoding');
      } catch (error) {
        const primaryError = error instanceof Error ? error : new Error(String(error));
        openLinkWaiter?.reject(primaryError);
        throw primaryError;
      }
      if (message.type === 'openLink') {
        try {
          assert.equal(message.source, 'preview');
          assert.equal(openLinkWaiter?.resolve(message as PreviewOpenLink), true, 'Unexpected linked-image activation');
        } catch (error) {
          const primaryError = error instanceof Error ? error : new Error(String(error));
          openLinkWaiter?.reject(primaryError);
          throw primaryError;
        }
        return null;
      }
      if (message.type !== 'requestPreviewRender') return null;
      const rendered = exportRuntime.renderPreviewDocument({
        markdownText: message.text,
        sourceDocumentPath,
        styleEnvironment: message.environment
      });
      const response = decodeHostToWebviewMessage({
        type: 'previewRenderResult',
        requestId: message.requestId,
        result: { ok: true, value: rendered }
      });
      assert.equal(response?.type, 'previewRenderResult');
      return response;
    });
    await page.setRequestInterception(true);
    page.once('request', (request) => {
      void request.respond({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>'
      });
    });
    await page.goto('http://localhost');
    await page.setRequestInterception(false);
    await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ url: deterministicMermaidRuntimeSrc });
    await page.addScriptTag({ content: `
      window.acquireVsCodeApi=()=>(
        {
          postMessage(message) {
            window.__deliverWebviewMessageToHost(message).then((response) => {
              if (response) window.dispatchEvent(new MessageEvent('message', { data: response }));
            });
          },
          getState() { return undefined; },
          setState() {}
        }
      );
    ` });
    await page.addScriptTag({ path: path.join(temp, 'bundle.js') });
    await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), initMessage);
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
      return frame?.contentDocument?.body.textContent?.includes('continues */') === true;
    });
    const initialRows = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')
        ?.contentDocument?.querySelectorAll('.meo-export-code-line').length ?? 0
    ));
    assert.equal(initialRows, 3, 'Preview must expose one independent row per fenced source line');
    const currentFrame = await page.$('.preview-frame');
    assert.ok(currentFrame, 'Preview iframe must exist before Mermaid settlement');
    await page.waitForFunction((frame) => {
      if (!(frame instanceof HTMLIFrameElement) || !frame.isConnected) return false;
      const doc = frame.contentDocument;
      return doc?.querySelectorAll('.meo-export-mermaid.is-rendered svg[data-fit-diagram]').length === 2
        && doc.querySelectorAll('.meo-export-mermaid.is-rendered .meo-fit-graphic').length === 10
        && doc.querySelector('.meo-export-mermaid.is-error code') !== null;
    }, {}, currentFrame);

    const layoutCases = [1, 2].flatMap((deviceScaleFactor) => (
      [420, 1200].flatMap((width) => (
        [0.8, 1.25].map((zoom) => ({ deviceScaleFactor, width, zoom }))
      ))
    ));
    for (const { deviceScaleFactor, width, zoom } of layoutCases) {
      await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const kbd = doc.querySelector<HTMLElement>('table kbd')!;
        const link = doc.querySelector<HTMLAnchorElement>('table a')!;
        const selection = doc.defaultView!.getSelection()!;
        const range = doc.createRange();
        range.selectNodeContents(kbd);
        selection.removeAllRanges();
        selection.addRange(range);
        link.focus({ preventScroll: true });
      });
      await page.setViewport({ width, height: 700, deviceScaleFactor });
      await page.evaluate((value) => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        doc.documentElement.style.zoom = String(value);
      }, zoom);
      const adjacentInteraction = await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const table = doc.querySelector<HTMLTableElement>('table')!;
        return {
          selection: doc.defaultView!.getSelection()!.toString(),
          focused: doc.activeElement === table.querySelector('a')
        };
      });
      assert.deepEqual(adjacentInteraction, { selection: longKbdToken, focused: true });

      await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const image = doc.querySelector<HTMLImageElement>('img[alt="Linked alt"]');
        if (!image) throw new Error('Linked Markdown image missing from Preview DOM');
        image.closest('a')!.focus({ preventScroll: true });
      });
      await page.setViewport({ width, height: 701, deviceScaleFactor });
      await page.setViewport({ width, height: 700, deviceScaleFactor });
      await page.evaluate(({ probe, target }) => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        doc.documentElement.style.zoom = String(probe);
        doc.documentElement.style.zoom = String(target);
      }, { probe: zoom === 0.8 ? 0.81 : 1.24, target: zoom });
      const enterActivation = await activateAndWaitForOpenLink(
        openLinkWaiter,
        () => page.keyboard.press('Enter')
      );
      assert.deepEqual(enterActivation, {
        type: 'openLink', href: 'https://example.com/linked-image', source: 'preview'
      });
      const previewFrame = page.frames().find((candidate) => candidate !== page.mainFrame());
      assert.ok(previewFrame, 'Preview iframe must remain attached for linked-image activation');
      const linkedImageHandle = await previewFrame.$('img[alt="Linked alt"]');
      assert.ok(linkedImageHandle, 'Linked Markdown image must remain reachable in the Preview iframe');
      const clickActivation = await activateAndWaitForOpenLink(
        openLinkWaiter,
        () => linkedImageHandle.click()
      );
      assert.deepEqual(clickActivation, {
        type: 'openLink', href: 'https://example.com/linked-image', source: 'preview'
      });
      const result = await page.evaluate(async () => {
        const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
        const doc = frame.contentDocument!;
        const tables = Array.from(doc.querySelectorAll<HTMLTableElement>('table'));
        const tableContainers = tables.map((item) => item.closest<HTMLElement>('.meo-table-scroll') ?? item);
        const table = tables[0];
        const tableCells = tables.flatMap((item) => Array.from(item.querySelectorAll<HTMLElement>('th, td')));
        const tableKbds = tables.flatMap((item) => Array.from(item.querySelectorAll<HTMLElement>('kbd')));
        const emptyCells = Array.from(table.rows[2]?.cells ?? []);
        const tableList = table.querySelector<HTMLUListElement>('ul')!;
        const listCell = tableList.closest<HTMLTableCellElement>('td')!;
        const kbd = table.querySelector<HTMLElement>('kbd')!;
        const tableLink = table.querySelector<HTMLAnchorElement>('a')!;
        const proseKbd = Array.from(doc.querySelectorAll<HTMLElement>('kbd')).find((item) => !item.closest('table'))!;
        const pageRoot = doc.querySelector<HTMLElement>('.meo-export-doc')!;
        const rootRect = pageRoot.getBoundingClientRect();
        const linkedImage = doc.querySelector<HTMLImageElement>('img[alt="Linked alt"]')!;
        const linkedAnchor = linkedImage.closest<HTMLAnchorElement>('a')!;
        const linkedFocusPreserved = doc.activeElement === linkedAnchor;
        const loadedImages = [
          { image: doc.querySelector<HTMLImageElement>('img[alt="Data alt"]')!, width: 1, height: 1 },
          { image: doc.querySelector<HTMLImageElement>('img[alt="Landscape alt"]')!, width: 1600, height: 400 },
          { image: doc.querySelector<HTMLImageElement>('img[alt="Portrait alt"]')!, width: 300, height: 1200 },
          { image: linkedImage, width: 1200, height: 600 }
        ];
        const safeHtmlImage = doc.querySelector<HTMLImageElement>('img[alt="Safe HTML wide"]')!;
        const brokenImage = doc.querySelector<HTMLImageElement>('img[alt="Broken alt"]')!;
        const selectionParagraph = Array.from(doc.querySelectorAll<HTMLParagraphElement>('p'))
          .find((item) => item.textContent?.includes('Selection before'))!;
        const imageContainers = Array.from(new Set(
          [...loadedImages.map(({ image }) => image.parentElement!), safeHtmlImage.parentElement!]
        ));
        const clippingAncestors = [...loadedImages.map(({ image }) => image), safeHtmlImage].flatMap((image) => {
          const clipping: string[] = [];
          for (let current = image.parentElement; current && current !== pageRoot.parentElement; current = current.parentElement) {
            const style = getComputedStyle(current);
            if ([style.overflowX, style.overflowY].some((value) => value === 'hidden' || value === 'clip')) {
              clipping.push(`${image.alt}:${current.tagName.toLowerCase()}.${current.className}:${style.overflowX}/${style.overflowY}`);
            }
          }
          return clipping;
        });
        const imageSelection = doc.createRange();
        imageSelection.selectNodeContents(selectionParagraph);
        const imageSelectionOwner = doc.defaultView!.getSelection()!;
        imageSelectionOwner.removeAllRanges();
        imageSelectionOwner.addRange(imageSelection);
        const imageSelectionText = imageSelectionOwner.toString();
        const imageCopied = doc.execCommand('copy');
        const imageClipboardText = await doc.defaultView!.navigator.clipboard.readText();
        const normalizeText = (value: string | null) => (value ?? '').replace(/\s+/g, ' ').trim();
        const linkedFocusedAfterActivation = doc.activeElement === linkedAnchor;
        const code = doc.querySelector<HTMLElement>('pre.meo-export-code-block code')!;
        const pre = code.closest<HTMLElement>('pre')!;
        const rows = Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line'));
        const gutters = Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line-number'));
        const sources = Array.from(code.querySelectorAll<HTMLElement>('.meo-export-code-line-source'));
        const longRange = doc.createRange();
        longRange.selectNodeContents(sources[1]);
        const selection = doc.defaultView!.getSelection()!;
        const fullRange = doc.createRange();
        fullRange.selectNodeContents(code);
        selection.removeAllRanges();
        selection.addRange(fullRange);
        const selected = selection.toString();
        const copied = doc.execCommand('copy');
        const preRect = pre.getBoundingClientRect();
        const bodyRect = sources[1].getBoundingClientRect();
        const fragments = Array.from(longRange.getClientRects());
        const adjacent = Array.from(doc.querySelectorAll<HTMLElement>('.meo-table-scroll, .meo-export-math'));
        const kbdRange = doc.createRange();
        kbdRange.selectNodeContents(kbd);
        selection.removeAllRanges();
        selection.addRange(kbdRange);
        tableLink.focus({ preventScroll: true });
        const tableSelectionText = selection.toString();
        const tableCopied = doc.execCommand('copy');
        const tableClipboardText = await doc.defaultView!.navigator.clipboard.readText();
        const mermaidFallback = doc.querySelector<HTMLElement>('.meo-export-mermaid code')!;
        const mermaidRange = doc.createRange();
        mermaidRange.selectNodeContents(mermaidFallback);
        const mermaidStyle = getComputedStyle(mermaidFallback);
        const mermaidBlocks = Array.from(doc.querySelectorAll<HTMLElement>('.meo-export-mermaid.is-rendered'));
        const mermaidWrappers = mermaidBlocks.map((block) => block.querySelector<HTMLElement>('.meo-export-mermaid-svg')!);
        const mermaidSvgs = mermaidWrappers.map((wrapper) => wrapper.querySelector<SVGSVGElement>('svg[data-fit-diagram]')!);
        const mermaidGraphics = mermaidSvgs.flatMap((svg) => Array.from(svg.querySelectorAll<SVGGraphicsElement>('.meo-fit-graphic')));
        const mermaidHtmlClippingAncestors = mermaidGraphics.flatMap((graphic) => {
          const clipping: string[] = [];
          for (let current = graphic.parentElement; current && current !== pageRoot.parentElement; current = current.parentElement) {
            if (current.namespaceURI === 'http://www.w3.org/2000/svg') continue;
            const style = getComputedStyle(current);
            if ([style.overflowX, style.overflowY].some((value) => value === 'hidden' || value === 'clip')) {
              clipping.push(`${current.tagName.toLowerCase()}.${current.className}:${style.overflowX}/${style.overflowY}`);
            }
          }
          return clipping;
        });
        const mermaidSelection = doc.createRange();
        mermaidSelection.selectNodeContents(mermaidSvgs[0]);
        selection.removeAllRanges();
        selection.addRange(mermaidSelection);
        const mermaidSelectionText = normalizeText(selection.toString());
        const mermaidCopied = doc.execCommand('copy');
        const mermaidClipboardText = normalizeText(await doc.defaultView!.navigator.clipboard.readText());
        return {
          rows: rows.length,
          selected,
          copied,
          documentOverflow: doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
          bodyOverflow: doc.body.scrollWidth - doc.body.clientWidth,
          pageOverflow: pageRoot.scrollWidth - pageRoot.clientWidth,
          preOverflow: pre.scrollWidth - pre.clientWidth,
          preOverflowX: getComputedStyle(pre).overflowX,
          rootRect: { left: rootRect.left, right: rootRect.right, width: rootRect.width },
          preRect: { left: preRect.left, right: preRect.right },
          bodyLeft: bodyRect.left,
          fragmentCount: fragments.length,
          continuationLefts: fragments.slice(1).map((rect) => rect.left),
          gutterWidths: gutters.map((gutter) => gutter.getBoundingClientRect().width),
          gutterAlignments: gutters.map((gutter) => getComputedStyle(gutter).textAlign),
          gutterSelections: gutters.map((gutter) => getComputedStyle(gutter).userSelect),
          gutterAria: gutters.map((gutter) => gutter.getAttribute('aria-hidden')),
          gutterNumbers: gutters.map((gutter) => gutter.dataset.lineNumber),
          sourceLefts: sources.map((source) => source.getBoundingClientRect().left),
          adjacentWithinPage: adjacent.every((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1;
          }),
          adjacentKinds: {
            table: Boolean(doc.querySelector('.meo-table-scroll table')),
            math: Boolean(doc.querySelector('.meo-export-math'))
          },
          images: {
            semanticCount: doc.querySelectorAll('img').length,
            loaded: loadedImages.map(({ image, width: naturalWidth, height: naturalHeight }) => {
              const rect = image.getBoundingClientRect();
              return {
                alt: image.alt,
                title: image.title,
                complete: image.complete,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                expectedNaturalWidth: naturalWidth,
                expectedNaturalHeight: naturalHeight,
                renderedWidth: rect.width,
                renderedHeight: rect.height,
                rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom },
                pageRect: { left: rootRect.left, right: rootRect.right, top: rootRect.top, bottom: rootRect.bottom },
                withinPage: rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1
                  && rect.top >= rootRect.top - 1 && rect.bottom <= rootRect.bottom + 1,
                horizontalOverflow: image.scrollWidth - image.clientWidth
              };
            }),
            safeHtml: (() => {
              const rect = safeHtmlImage.getBoundingClientRect();
              return {
                complete: safeHtmlImage.complete,
                naturalWidth: safeHtmlImage.naturalWidth,
                naturalHeight: safeHtmlImage.naturalHeight,
                renderedWidth: rect.width,
                renderedHeight: rect.height,
                withinPage: rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1
                  && rect.top >= rootRect.top - 1 && rect.bottom <= rootRect.bottom + 1
              };
            })(),
            containersWithinPage: imageContainers.every((container) => {
              const rect = container.getBoundingClientRect();
              return rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1;
            }),
            containerOverflows: imageContainers.map((container) => container.scrollWidth - container.clientWidth),
            clippingAncestors,
            linked: {
              imageParent: linkedImage.parentElement?.tagName,
              anchorCount: selectionParagraph.querySelectorAll(':scope > a').length,
              anchorElementChildren: linkedAnchor.children.length,
              role: linkedAnchor.getAttribute('role'),
              tabIndex: linkedAnchor.tabIndex,
              href: linkedAnchor.dataset.meoPreviewHref,
              anchorTitle: linkedAnchor.title,
              imageTitle: linkedImage.title,
              focusPreserved: linkedFocusPreserved,
              focusedAfterActivation: linkedFocusedAfterActivation
            },
            selection: {
              domText: normalizeText(selectionParagraph.textContent),
              selectedText: normalizeText(imageSelectionText),
              copied: imageCopied,
              clipboardText: normalizeText(imageClipboardText)
            },
            broken: {
              complete: brokenImage.complete,
              naturalWidth: brokenImage.naturalWidth,
              naturalHeight: brokenImage.naturalHeight,
              alt: brokenImage.alt,
              title: brokenImage.title,
              rect: (() => {
                const rect = brokenImage.getBoundingClientRect();
                return { width: rect.width, height: rect.height, left: rect.left, right: rect.right };
              })()
            },
            customPresentationNodes: doc.querySelectorAll('.meo-image-wrapper, .meo-image-toolbar, figure, figcaption').length
          },
          table: {
            semanticCounts: {
              table: tables.length,
              thead: tables.reduce((count, item) => count + item.querySelectorAll('thead').length, 0),
              tbody: tables.reduce((count, item) => count + item.querySelectorAll('tbody').length, 0),
              tr: tables.reduce((count, item) => count + item.querySelectorAll('tr').length, 0),
              th: tables.reduce((count, item) => count + item.querySelectorAll('th').length, 0),
              td: tables.reduce((count, item) => count + item.querySelectorAll('td').length, 0)
            },
            resizeHandleCount: doc.querySelectorAll('.meo-md-html-table-column-resize-handle').length,
            listPadding: Number.parseFloat(getComputedStyle(tableList).paddingInlineStart),
            listCellPadding: Number.parseFloat(getComputedStyle(listCell).paddingInlineStart),
            emptyCellsWithoutOverflow: emptyCells.every((cell) => cell.scrollWidth <= cell.clientWidth + 1),
            documentOverflow: doc.documentElement.scrollWidth - doc.documentElement.clientWidth,
            bodyOverflow: doc.body.scrollWidth - doc.body.clientWidth,
            pageOverflow: pageRoot.scrollWidth - pageRoot.clientWidth,
            wrapperOverflows: tableContainers.map((container) => container.scrollWidth - container.clientWidth),
            tableOverflows: tables.map((item) => item.scrollWidth - item.clientWidth),
            wrapperOverflowX: tableContainers.map((container) => getComputedStyle(container).overflowX),
            clippingAncestors: [...tableContainers, ...tables, ...tableCells, ...tableKbds].flatMap((element) => {
              const clipping: string[] = [];
              for (let current: HTMLElement | null = element; current; current = current.parentElement) {
                const overflowX = getComputedStyle(current).overflowX;
                if (overflowX === 'hidden' || overflowX === 'clip') {
                  clipping.push(`${current.tagName.toLowerCase()}.${current.className}:${overflowX}`);
                }
              }
              return clipping;
            }),
            rectsWithinPage: [...tableContainers, ...tables, ...tableCells, ...tableKbds, tableLink].every((element) => {
              const rect = element.getBoundingClientRect();
              return rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1;
            }),
            kbdFragments: tableKbds.map((item) => {
              const range = doc.createRange();
              range.selectNodeContents(item);
              return range.getClientRects().length;
            }),
            selectionText: tableSelectionText,
            copied: tableCopied,
            clipboardText: tableClipboardText,
            focusedLink: doc.activeElement === tableLink,
            linkTabIndex: tableLink.tabIndex,
            proseKbdWhiteSpace: getComputedStyle(proseKbd).whiteSpace,
            proseKbdFragments: (() => {
              const range = doc.createRange();
              range.selectNodeContents(proseKbd);
              return range.getClientRects().length;
            })()
          },
          mermaidFallback: {
            source: mermaidFallback.textContent,
            fontSize: Number.parseFloat(mermaidStyle.fontSize),
            lineHeight: Number.parseFloat(mermaidStyle.lineHeight),
            fragments: mermaidRange.getClientRects().length
          },
          mermaidSuccess: {
            diagrams: mermaidSvgs.map((svg, index) => {
              const block = mermaidBlocks[index];
              const wrapper = mermaidWrappers[index];
              const svgRect = svg.getBoundingClientRect();
              const blockRect = block.getBoundingClientRect();
              const wrapperRect = wrapper.getBoundingClientRect();
              const viewBox = svg.viewBox.baseVal;
              return {
                kind: svg.dataset.fitDiagram,
                viewBox: { width: viewBox.width, height: viewBox.height },
                viewport: { width: svgRect.width, height: svgRect.height, left: svgRect.left, right: svgRect.right },
                withinPage: svgRect.left >= rootRect.left - 1 && svgRect.right <= rootRect.right + 1,
                blockWithinPage: blockRect.left >= rootRect.left - 1 && blockRect.right <= rootRect.right + 1,
                wrapperWithinPage: wrapperRect.left >= rootRect.left - 1 && wrapperRect.right <= rootRect.right + 1,
                horizontalOverflows: [
                  block.scrollWidth - block.clientWidth,
                  wrapper.scrollWidth - wrapper.clientWidth,
                  svg.scrollWidth - svg.clientWidth
                ],
                verticalOverflows: [
                  block.scrollHeight - block.clientHeight,
                  wrapper.scrollHeight - wrapper.clientHeight,
                  svg.scrollHeight - svg.clientHeight
                ],
                overflowModes: [block, wrapper].map((element) => {
                  const style = getComputedStyle(element);
                  return `${style.overflowX}/${style.overflowY}`;
                }),
                graphicsWithinViewport: Array.from(svg.querySelectorAll<SVGGraphicsElement>('.meo-fit-graphic')).every((graphic) => {
                  const rect = graphic.getBoundingClientRect();
                  return rect.width > 0 && rect.height > 0
                    && rect.left >= svgRect.left - 1 && rect.right <= svgRect.right + 1
                    && rect.top >= svgRect.top - 1 && rect.bottom <= svgRect.bottom + 1;
                }),
                graphicsWithinPage: Array.from(svg.querySelectorAll<SVGGraphicsElement>('.meo-fit-graphic')).every((graphic) => {
                  const rect = graphic.getBoundingClientRect();
                  return rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1
                    && rect.top >= rootRect.top - 1 && rect.bottom <= rootRect.bottom + 1;
                }),
                labelTexts: Array.from(svg.querySelectorAll('.meo-fit-label, .nodeLabel')).map((label) => normalizeText(label.textContent)),
                preserveAspectRatio: svg.preserveAspectRatio.baseVal.align,
                draggable: svg.getAttribute('draggable'),
                cursor: getComputedStyle(svg).cursor
              };
            }),
            htmlClippingAncestors: mermaidHtmlClippingAncestors,
            selectionText: mermaidSelectionText,
            copied: mermaidCopied,
            clipboardText: mermaidClipboardText,
            controls: {
              fullscreenButtons: Array.from(doc.querySelectorAll('button'))
                .filter((button) => button.getAttribute('aria-label')?.toLowerCase().includes('fullscreen')).length,
              liveControls: doc.querySelectorAll('.meo-mermaid-zoom-controls').length,
              fullscreenSurfaces: doc.querySelectorAll('.meo-mermaid-fullscreen-scrim').length,
              panSurfaces: doc.querySelectorAll('[data-mermaid-pan], .is-panning').length
            }
          }
        };
      });

      assert.equal(result.rows, 3);
      assert.equal(result.selected, codeSource);
      assert.equal(result.copied, true);
      assert.ok(result.documentOverflow <= 1 && result.bodyOverflow <= 1 && result.pageOverflow <= 1 && result.preOverflow <= 1, JSON.stringify(result));
      assert.notEqual(result.preOverflowX, 'auto');
      assert.notEqual(result.preOverflowX, 'scroll');
      assert.ok(
        result.rootRect.left >= -1 &&
        result.rootRect.right <= width + 1 &&
        result.rootRect.width <= (900 * zoom) + 1,
        JSON.stringify(result)
      );
      assert.ok(result.preRect.left >= result.rootRect.left - 1 && result.preRect.right <= result.rootRect.right + 1, JSON.stringify(result));
      assert.ok(result.fragmentCount > 1, JSON.stringify(result));
      assert.ok(result.continuationLefts.every((left) => Math.abs(left - result.bodyLeft) <= 1), JSON.stringify(result));
      assert.ok(result.gutterWidths.every((value) => Math.abs(value - result.gutterWidths[0]) <= 0.01));
      assert.deepEqual(result.gutterAlignments, ['right', 'right', 'right']);
      assert.deepEqual(result.gutterSelections, ['none', 'none', 'none']);
      assert.deepEqual(result.gutterAria, ['true', 'true', 'true']);
      assert.deepEqual(result.gutterNumbers, ['1', '2', '3']);
      assert.ok(result.sourceLefts.every((value) => Math.abs(value - result.sourceLefts[0]) <= 0.01));
      assert.equal(result.adjacentWithinPage, true);
      assert.deepEqual(result.adjacentKinds, { table: true, math: true });
      assert.equal(result.images.semanticCount, 6);
      assert.deepEqual(result.images.loaded.map((image) => ({
        alt: image.alt,
        title: image.title,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        expectedNaturalWidth: image.expectedNaturalWidth,
        expectedNaturalHeight: image.expectedNaturalHeight
      })), [
        { alt: 'Data alt', title: 'Data title', complete: true, naturalWidth: 1, naturalHeight: 1, expectedNaturalWidth: 1, expectedNaturalHeight: 1 },
        { alt: 'Landscape alt', title: 'Landscape title', complete: true, naturalWidth: 1600, naturalHeight: 400, expectedNaturalWidth: 1600, expectedNaturalHeight: 400 },
        { alt: 'Portrait alt', title: 'Portrait title', complete: true, naturalWidth: 300, naturalHeight: 1200, expectedNaturalWidth: 300, expectedNaturalHeight: 1200 },
        { alt: 'Linked alt', title: 'Linked image title', complete: true, naturalWidth: 1200, naturalHeight: 600, expectedNaturalWidth: 1200, expectedNaturalHeight: 600 }
      ]);
      assert.ok(result.images.loaded.every((image) => (
        image.renderedWidth > 0 && image.renderedHeight > 0 && image.withinPage && image.horizontalOverflow <= 1
        && Math.abs((image.renderedWidth / image.renderedHeight) - (image.naturalWidth / image.naturalHeight)) <= 0.01
      )), JSON.stringify({ width, zoom, deviceScaleFactor, images: result.images }));
      assert.ok(
        result.images.safeHtml.complete &&
        result.images.safeHtml.naturalWidth === 1600 &&
        result.images.safeHtml.naturalHeight === 120 &&
        result.images.safeHtml.withinPage &&
        Math.abs((result.images.safeHtml.renderedWidth / result.images.safeHtml.renderedHeight) - (1600 / 120)) <= 0.01,
        JSON.stringify({ width, zoom, deviceScaleFactor, safeHtml: result.images.safeHtml })
      );
      assert.equal(result.images.containersWithinPage, true, JSON.stringify(result.images));
      assert.ok(result.images.containerOverflows.every((overflow) => overflow <= 1), JSON.stringify(result.images));
      assert.deepEqual(result.images.clippingAncestors, []);
      assert.deepEqual(result.images.linked, {
        imageParent: 'A',
        anchorCount: 1,
        anchorElementChildren: 1,
        role: 'link',
        tabIndex: 0,
        href: 'https://example.com/linked-image',
        anchorTitle: 'Linked anchor title',
        imageTitle: 'Linked image title',
        focusPreserved: true,
        focusedAfterActivation: true
      });
      assert.deepEqual(result.images.selection, {
        domText: 'Selection before selection after',
        selectedText: 'Selection before selection after',
        copied: true,
        clipboardText: 'Selection before Linked alt selection after'
      });
      assert.deepEqual({
        complete: result.images.broken.complete,
        naturalWidth: result.images.broken.naturalWidth,
        naturalHeight: result.images.broken.naturalHeight,
        alt: result.images.broken.alt,
        title: result.images.broken.title
      }, { complete: true, naturalWidth: 0, naturalHeight: 0, alt: 'Broken alt', title: 'Broken title' });
      assert.equal(result.images.customPresentationNodes, 0);
      assert.equal(result.mermaidFallback.source, mermaidFallbackSource);
      assert.ok(result.mermaidFallback.fontSize > 0 && result.mermaidFallback.lineHeight > 0, JSON.stringify(result));
      assert.ok(result.mermaidFallback.fragments > 1, JSON.stringify(result));
      assert.deepEqual(result.mermaidSuccess.htmlClippingAncestors, []);
      assert.deepEqual(result.mermaidSuccess.controls, {
        fullscreenButtons: 0,
        liveControls: 0,
        fullscreenSurfaces: 0,
        panSurfaces: 0
      });
      assert.equal(result.mermaidSuccess.selectionText, 'Wide start label Wide end label Wide foreign label');
      assert.equal(result.mermaidSuccess.copied, true);
      assert.equal(result.mermaidSuccess.clipboardText, result.mermaidSuccess.selectionText);
      assert.deepEqual(result.mermaidSuccess.diagrams.map((diagram) => diagram.kind), ['wide', 'tall']);
      assert.deepEqual(result.mermaidSuccess.diagrams.map((diagram) => diagram.labelTexts), [
        ['Wide start label', 'Wide end label', 'Wide foreign label'],
        ['Tall start label', 'Tall end label', 'Tall foreign label']
      ]);
      assert.ok(result.mermaidSuccess.diagrams.every((diagram) => (
        diagram.viewport.width > 0 && diagram.viewport.height > 0
        && Math.abs((diagram.viewport.width / diagram.viewport.height) - (diagram.viewBox.width / diagram.viewBox.height)) <= 0.01
        && diagram.withinPage && diagram.blockWithinPage && diagram.wrapperWithinPage
        && diagram.horizontalOverflows.every((value) => value <= 1)
        && diagram.verticalOverflows.every((value) => value <= 1)
        && diagram.overflowModes.every((value) => !/(auto|scroll)/.test(value))
        && diagram.graphicsWithinViewport && diagram.graphicsWithinPage
        && diagram.preserveAspectRatio !== 0
        && diagram.draggable === null
        && diagram.cursor !== 'grab' && diagram.cursor !== 'grabbing'
      )), JSON.stringify({ width, zoom, deviceScaleFactor, mermaidSuccess: result.mermaidSuccess }));
      assert.deepEqual(result.table.semanticCounts, { table: 2, thead: 2, tbody: 2, tr: 5, th: 10, td: 18 });
      assert.equal(result.table.resizeHandleCount, 0);
      assert.ok(result.table.listPadding >= 24 && result.table.listCellPadding >= 12, JSON.stringify(result.table));
      assert.equal(result.table.emptyCellsWithoutOverflow, true);
      assert.ok(
        result.table.documentOverflow <= 1 &&
        result.table.bodyOverflow <= 1 &&
        result.table.pageOverflow <= 1 &&
        result.table.wrapperOverflows.every((value) => value <= 1) &&
        result.table.tableOverflows.every((value) => value <= 1),
        JSON.stringify({ width, zoom, deviceScaleFactor, table: result.table })
      );
      assert.ok(result.table.wrapperOverflowX.every((value) => value !== 'auto' && value !== 'scroll'));
      assert.deepEqual(result.table.clippingAncestors, []);
      assert.equal(result.table.rectsWithinPage, true, JSON.stringify({ width, zoom, deviceScaleFactor, table: result.table }));
      assert.ok(result.table.kbdFragments.every((count) => count > 1), JSON.stringify({ width, zoom, deviceScaleFactor, table: result.table }));
      assert.equal(result.table.selectionText, longKbdToken);
      assert.equal(result.table.copied, true);
      assert.equal(result.table.clipboardText, longKbdToken);
      assert.equal(result.table.focusedLink, true);
      assert.equal(result.table.linkTabIndex, 0);
      assert.equal(result.table.proseKbdWhiteSpace, 'nowrap');
      assert.equal(result.table.proseKbdFragments, 1);
    }

    const exportedFallback = exportRuntime.renderExportHtmlDocument({
      readingSnapshot: {
        snapshotId: 'g2a-mermaid-fallback',
        text: `\`\`\`mermaid\n${mermaidFallbackSource}\`\`\``,
        appearance: 'light',
        environment: {}
      },
      sourceDocumentPath: 'C:/preview-reading-surface.md',
      outputFilePath: 'C:/preview-reading-surface.html',
      target: 'html',
      mermaidRuntimeSrc: deterministicMermaidRuntimeSrc,
      baseHref: 'file:///C:/',
      title: 'G2a Mermaid fallback'
    });
    const exportPage = await browser.newPage();
    try {
      await exportPage.setViewport({ width: 420, height: 700, deviceScaleFactor: 1 });
      await exportPage.setContent(exportedFallback.htmlDocument, { waitUntil: 'domcontentloaded' });
      await exportPage.waitForFunction(() => (window as typeof window & { __MEO_EXPORT_READY__?: boolean }).__MEO_EXPORT_READY__ === true);
      const exportFallback = await exportPage.evaluate(() => {
        const code = document.querySelector<HTMLElement>('.meo-export-mermaid.is-error code')!;
        const style = getComputedStyle(code);
        const range = document.createRange();
        range.selectNodeContents(code);
        return {
          source: code.textContent,
          fontSize: Number.parseFloat(style.fontSize),
          lineHeight: Number.parseFloat(style.lineHeight),
          fragments: range.getClientRects().length
        };
      });
      assert.equal(exportFallback.source, mermaidFallbackSource);
      assert.ok(exportFallback.fontSize > 0 && exportFallback.lineHeight > 0, JSON.stringify(exportFallback));
      assert.ok(exportFallback.fragments > 1, JSON.stringify(exportFallback));
    } finally {
      await exportPage.close();
    }
  } finally {
    openLinkWaiter?.dispose(new Error('Preview test ended before openLink delivery'));
    await browser.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('Preview reading surface production checks passed');
}

await main();
