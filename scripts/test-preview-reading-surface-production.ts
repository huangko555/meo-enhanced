import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import { decodeHostToWebviewMessage, decodeWebviewToHostMessage } from '../src/protocol/messages';
import type { PreviewRenderRequest } from '../src/protocol/previewRender';
import exportRuntime from '../src/export/runtime';
import { buildExportHtmlDocument } from '../src/export/exportHtmlTemplate';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-reading-surface-'));
const sourceDocumentPath = path.join(temp, 'preview-reading-surface.md');
const longToken = 'wrappable'.repeat(90);
const longKbdToken = 'K'.repeat(500);
const longLinkToken = 'linked'.repeat(80);
const longDisplayFormula = `\\operatorname{displayfit}+${'1234567890+'.repeat(80)}0`;
const longInlineFormula = `\\mathrm{${Array.from(
  { length: 192 },
  (_, index) => `INLINE${String(index).padStart(3, '0')}`
).join('')}}`;
const mediumInlineFormula = `\\mathrm{${Array.from(
  { length: 8 },
  (_, index) => `MEDIUM${String(index).padStart(2, '0')}`
).join('')}}`;
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
  '```typescript',
  'type User = {',
  '  id: string;',
  '};',
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
  'Short prefix $x + 1$ short suffix.',
  '',
  `Medium prefix $${mediumInlineFormula}$ medium suffix.`,
  '',
  `Prefix prose wraps before [safe link](https://example.com/safe) and $${longInlineFormula}$ then suffix prose wraps after the formula.`,
  '',
  'BROKEN_INLINE_SENTINEL $\\frac{',
  '',
  `$$${longDisplayFormula}$$`,
  '',
  '$$',
  'x^2 + y^2 = z^2',
  '$$'
].join('\n');

const initMessage = {
  type: 'init',
  documentId: 'file:///preview-reading-surface.md',
  text: markdown,
  version: 1,
  savedRevision: { version: 1, text: markdown },
  diagnostics: [],
  mode: 'preview',
  uiLanguage: 'en',
  sourceLineNumbers: 'on',
  previewAppearance: 'light',
  previewFontFamily: '',
  previewSourceColoring: true,
  editorAppearance: 'light',
  gitChangesGutter: false,
  gitDiffLineHighlights: false,
  gitDiffDetailsVisible: false,
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

async function assertPreviewMathMeasurementTransaction(page: import('puppeteer-core').Page): Promise<void> {
  const transaction = await page.evaluate(async () => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const runTransaction = async (selector: string, textSentinel?: string) => {
      const root = textSentinel
        ? Array.from(doc.querySelectorAll<HTMLElement>(selector))
          .find((candidate) => candidate.textContent?.includes(textSentinel))!
        : doc.querySelector<HTMLElement>(selector)!;
      const canvas = root.querySelector<HTMLElement>(':scope > .meo-latex-math-canvas')!;
      const originalRect = canvas.getBoundingClientRect.bind(canvas);
      const stable = {
        fontSize: canvas.style.fontSize,
        zoom: canvas.style.zoom,
        height: root.style.height
      };
      const afterCanvasStyleTransaction = (mutate: () => void) => new Promise<void>((resolve) => {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          resolve();
        });
        observer.observe(canvas, { attributes: true, attributeFilter: ['style'] });
        mutate();
      });

      canvas.getBoundingClientRect = () => ({ ...originalRect(), width: Number.NaN } as DOMRect);
      Object.defineProperty(canvas, 'scrollWidth', { configurable: true, get: () => Number.NaN });
      await afterCanvasStyleTransaction(() => {
        root.style.width = 'calc(100% - 1px)';
      });
      const invalid = {
        fontSize: canvas.style.fontSize,
        zoom: canvas.style.zoom,
        height: root.style.height,
        invalidCss: /(?:NaN|Infinity)/i.test(`${canvas.style.cssText};${root.style.cssText}`)
      };

      canvas.getBoundingClientRect = originalRect;
      delete (canvas as HTMLElement & { scrollWidth?: number }).scrollWidth;
      await afterCanvasStyleTransaction(() => {
        root.style.width = 'calc(100% - 2px)';
      });
      const recoveredRect = canvas.getBoundingClientRect();
      const recoveredRootRect = root.getBoundingClientRect();
      const recovered = {
        fontSize: canvas.style.fontSize,
        zoom: canvas.style.zoom,
        height: root.style.height,
        fits: recoveredRect.left >= recoveredRootRect.left - 1 && recoveredRect.right <= recoveredRootRect.right + 1
      };

      await afterCanvasStyleTransaction(() => {
        root.style.width = '';
      });
      const finalRect = canvas.getBoundingClientRect();
      const finalRootRect = root.getBoundingClientRect();
      return {
        stable,
        invalid,
        recovered,
        final: {
          fontSize: canvas.style.fontSize,
          zoom: canvas.style.zoom,
          height: root.style.height,
          fits: finalRect.left >= finalRootRect.left - 1 && finalRect.right <= finalRootRect.right + 1
        }
      };
    };

    return {
      display: await runTransaction('.meo-export-math-display:not(.meo-export-math-fenced-display)'),
      inline: await runTransaction('.meo-export-math-inline.meo-latex-math-viewport', 'INLINE000')
    };
  });

  for (const candidate of [transaction.display, transaction.inline]) {
    assert.deepEqual(
      { fontSize: candidate.invalid.fontSize, zoom: candidate.invalid.zoom, height: candidate.invalid.height },
      candidate.stable,
      JSON.stringify(transaction)
    );
    assert.equal(candidate.invalid.invalidCss, false, JSON.stringify(transaction));
    assert.equal(candidate.recovered.fits, true, JSON.stringify(transaction));
    assert.notEqual(candidate.recovered.fontSize, '1em', JSON.stringify(transaction));
    assert.equal(candidate.final.fits, true, JSON.stringify(transaction));
    assert.notEqual(candidate.final.fontSize, '1em', JSON.stringify(transaction));
  }
}

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

async function assertPreviewProjectionTransactions(
  browser: import('puppeteer-core').Browser,
  bundlePath: string
): Promise<void> {
  type ControlledRequest = {
    message: PreviewRenderRequest;
    resolve: (response: null) => void;
  };
  const available: ControlledRequest[] = [];
  const outboundTypes: string[] = [];
  let page: import('puppeteer-core').Page;
  const resolveRequest = async (request: ControlledRequest): Promise<void> => {
    const rendered = exportRuntime.renderPreviewDocument({
      markdownText: request.message.text,
      sourceDocumentPath,
      uiLanguage: request.message.uiLanguage,
      styleEnvironment: request.message.environment
    });
    const response = decodeHostToWebviewMessage({
      type: 'previewRenderResult',
      requestId: request.message.requestId,
      result: { ok: true, value: rendered }
    });
    assert.equal(response?.type, 'previewRenderResult');
    request.resolve(null);
    await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), response);
  };

  page = await browser.newPage();
  try {
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    await page.exposeFunction('__hasPendingProjectionRequest', () => available.length > 0);
    const nextRequest = async (label: string): Promise<ControlledRequest> => {
      try {
        await page.waitForFunction(async () => (
          await (window as typeof window & { __hasPendingProjectionRequest: () => Promise<boolean> })
            .__hasPendingProjectionRequest()
        ));
      } catch (error) {
        const state = await page.evaluate(() => ({
          fontFamily: document.querySelector<HTMLSelectElement>('.preview-font-family-select')?.value,
          sourceColoring: document.querySelector<HTMLSelectElement>('.preview-source-coloring-select')?.value,
          frameText: document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent
        }));
        throw new Error(`No ${label} Preview request: ${JSON.stringify({ outboundTypes, state })}`, { cause: error });
      }
      return available.shift()!;
    };
    await page.exposeFunction('__deliverProjectionMessageToHost', (raw: unknown) => {
      const message = decodeWebviewToHostMessage(raw);
      assert.ok(message, 'Projection transaction message failed Protocol decoding');
      outboundTypes.push(message.type);
      if (message.type !== 'requestPreviewRender') return null;
      return new Promise<null>((resolve) => {
        available.push({ message, resolve });
      });
    });
    await page.setRequestInterception(true);
    page.once('request', (request) => void request.respond({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>'
    }));
    await page.goto('http://localhost');
    await page.setRequestInterception(false);
    await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.acquireVsCodeApi=()=>({
        postMessage(message) {
          window.__deliverProjectionMessageToHost(message).then((response) => {
            if (response) window.dispatchEvent(new MessageEvent('message', { data: response }));
          });
        },
        getState() { return undefined; },
        setState() {}
      });
    ` });
    await page.addScriptTag({ path: bundlePath });
    const initialText = '# Projection T0\n\nOld frame sentinel\n\n```javascript\nconst themeProbe = "palette";\n```';
    await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), {
      ...initMessage,
      text: initialText,
      savedRevision: { version: 1, text: initialText }
    });
    const initialRequest = await nextRequest('initial');
    assert.equal(initialRequest.message.text, initialText);
    await resolveRequest(initialRequest);
    await page.waitForFunction(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('Old frame sentinel')
    ));

    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.preview-appearance-dropdown')!.click();
      document.querySelector<HTMLButtonElement>(
        '.preview-appearance-dropdown-panel .preview-dropdown-option[data-value="dark"]'
      )!.click();
    });
    await page.waitForFunction(() => (
      getComputedStyle(document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.documentElement)
        .colorScheme === 'dark'
    ));
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.preview-source-coloring-dropdown')!.click();
      document.querySelector<HTMLButtonElement>(
        '.preview-source-coloring-dropdown-panel .preview-dropdown-option[data-value="false"]'
      )!.click();
    });
    const disabledColoringRequest = await nextRequest('disabled source coloring from custom dropdown');
    await resolveRequest(disabledColoringRequest);
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const source = doc.querySelector<HTMLElement>('.meo-export-code-line-source');
      const span = source?.querySelector<HTMLElement>('span');
      return source !== null && span !== null
        && getComputedStyle(span).color === getComputedStyle(source).color
        && getComputedStyle(span).fontWeight === getComputedStyle(source).fontWeight;
    }, { timeout: 3000 });
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.preview-source-coloring-dropdown')!.click();
      document.querySelector<HTMLButtonElement>(
        '.preview-source-coloring-dropdown-panel .preview-dropdown-option[data-value="true"]'
      )!.click();
    });
    await resolveRequest(await nextRequest('enabled source coloring from custom dropdown'));
    await page.waitForFunction(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector('.meo-export-code-line-source[data-meo-shiki]') !== null
    ), { timeout: 5000 });
    const darkCodeColor = await page.$eval<HTMLIFrameElement, string>('.preview-frame', (frame) => (
      getComputedStyle(frame.contentDocument!.querySelector<HTMLElement>('.meo-export-code-line-source span')!).color
    ));
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.preview-appearance-dropdown')!.click();
      document.querySelector<HTMLButtonElement>(
        '.preview-appearance-dropdown-panel .preview-dropdown-option[data-value="light"]'
      )!.click();
    });
    await page.waitForFunction((previousColor) => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const span = doc.querySelector<HTMLElement>('.meo-export-code-line-source span');
      return getComputedStyle(doc.documentElement).colorScheme === 'light'
        && span !== null
        && getComputedStyle(span).color !== previousColor;
    }, {}, darkCodeColor);

    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'docChanged', text: '', version: 2 }
    })));
    const emptyDocumentRequest = await nextRequest('empty document');
    await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('.preview-font-family-select')!;
      select.value = 'SimSun';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const coloring = document.querySelector<HTMLSelectElement>('.preview-source-coloring-select')!;
      coloring.value = 'false';
      coloring.dispatchEvent(new Event('change', { bubbles: true }));
      const appearance = document.querySelector<HTMLSelectElement>('.preview-appearance-select')!;
      appearance.value = 'dark';
      appearance.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const emptyFontRequest = await nextRequest('empty font');
    const emptySourceRequest = await nextRequest('empty source-color');
    assert.deepEqual(
      [emptyDocumentRequest.message.text, emptyFontRequest.message.text, emptySourceRequest.message.text],
      ['', '', ''],
      'Empty pending text must survive font/source reprojection'
    );
    await resolveRequest(emptySourceRequest);
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
      return frame?.contentDocument?.querySelector('.meo-export-doc')?.textContent === '';
    });
    await resolveRequest(emptyFontRequest);
    await resolveRequest(emptyDocumentRequest);
    await page.waitForFunction(() => (
      document.querySelector<HTMLElement>('.cm-content')?.textContent === ''
    ));

    await page.close();
    available.length = 0;
    outboundTypes.length = 0;
    page = await browser.newPage();
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    await page.exposeFunction('__hasPendingProjectionRequest', () => available.length > 0);
    await page.exposeFunction('__deliverProjectionMessageToHost', (raw: unknown) => {
      const message = decodeWebviewToHostMessage(raw);
      assert.ok(message, 'Projection transaction message failed Protocol decoding');
      outboundTypes.push(message.type);
      if (message.type !== 'requestPreviewRender') return null;
      return new Promise<null>((resolve) => available.push({ message, resolve }));
    });
    await page.setRequestInterception(true);
    page.once('request', (request) => void request.respond({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>'
    }));
    await page.goto('http://localhost');
    await page.setRequestInterception(false);
    await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.acquireVsCodeApi=()=>({
        postMessage(message) {
          window.__deliverProjectionMessageToHost(message).then((response) => {
            if (response) window.dispatchEvent(new MessageEvent('message', { data: response }));
          });
        },
        getState() { return undefined; },
        setState() {}
      });
    ` });
    await page.addScriptTag({ path: bundlePath });
    await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), {
      ...initMessage,
      text: initialText,
      savedRevision: { version: 1, text: initialText }
    });
    await resolveRequest(await nextRequest('second initial'));
    await page.waitForFunction(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('Old frame sentinel')
    ));

    const nextText = `# Projection T1\n\n${Array.from({ length: 80 }, (_, index) => `Line ${index}`).join('\n\n')}`;
    await page.evaluate((text) => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'docChanged', text, version: 2 }
    })), nextText);
    const nextDocumentRequest = await nextRequest('T1 document');
    await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('.preview-font-family-select')!;
      select.value = 'Georgia';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const appearance = document.querySelector<HTMLSelectElement>('.preview-appearance-select')!;
      appearance.value = 'light';
      appearance.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const nextFontRequest = await nextRequest('T1 font');
    assert.equal(nextFontRequest.message.text, nextText);
    await resolveRequest(nextFontRequest);
    await page.waitForFunction(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('Projection T1')
    ));
    await resolveRequest(nextDocumentRequest);

    const interaction = await page.evaluateHandle(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      const paragraph = doc.querySelector('p')!;
      const range = doc.createRange();
      range.selectNodeContents(paragraph);
      const selection = doc.defaultView!.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      doc.scrollingElement!.scrollTop = 160;
      frame.focus();
      doc.defaultView!.focus();
      return { document: doc, selection: selection.toString(), scrollTop: doc.scrollingElement!.scrollTop };
    });
    await page.evaluate(() => {
      const coloring = document.querySelector<HTMLSelectElement>('.preview-source-coloring-select')!;
      coloring.value = 'false';
      coloring.dispatchEvent(new Event('change', { bubbles: true }));
      const select = document.querySelector<HTMLSelectElement>('.preview-font-family-select')!;
      select.value = 'Arial';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const appearance = document.querySelector<HTMLSelectElement>('.preview-appearance-select')!;
      appearance.value = 'dark';
      appearance.dispatchEvent(new Event('change', { bubbles: true }));
      appearance.value = 'light';
      appearance.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const sourceRequest = await nextRequest('final source-color');
    const finalFontRequest = await nextRequest('final font');
    await resolveRequest(finalFontRequest);
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      return getComputedStyle(doc.documentElement).colorScheme === 'light'
        && getComputedStyle(doc.querySelector<HTMLElement>('.meo-export-doc')!).fontFamily.includes('Arial');
    });
    await page.evaluate(() => new Promise<void>((resolve) => (
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )));
    const preserved = await page.evaluate((before) => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      return {
        sameDocument: doc === before.document,
        selection: doc.defaultView!.getSelection()!.toString(),
        expectedSelection: before.selection,
        scrollTop: doc.scrollingElement!.scrollTop,
        expectedScrollTop: before.scrollTop,
        frameFocused: document.activeElement === frame
      };
    }, interaction);
    await interaction.dispose();
    assert.deepEqual(preserved, {
      sameDocument: true,
      selection: preserved.expectedSelection,
      expectedSelection: preserved.expectedSelection,
      scrollTop: preserved.expectedScrollTop,
      expectedScrollTop: preserved.expectedScrollTop,
      frameFocused: true
    });
    await resolveRequest(sourceRequest);
    assert.equal(outboundTypes.filter((type) => /^(?:edit|undo|redo|applied|docChanged)/i.test(type)).length, 0);
  } finally {
    await page.close();
  }
}

async function assertFontEnumerationFallbackMatrix(
  browser: import('puppeteer-core').Browser,
  bundlePath: string
): Promise<void> {
  const scenarios = ['unsupported', 'NotAllowedError', 'SecurityError', 'other', 'throw', 'empty'] as const;
  const fallbackText = '# Font fallback\n\n`synthetic code`';
  const fallbackInit = {
    ...initMessage,
    uiLanguage: 'zh-CN' as const,
    text: fallbackText,
    savedRevision: { version: 1, text: fallbackText }
  };
  for (const scenario of scenarios) {
    const page = await browser.newPage();
    try {
      await page.exposeFunction('__deliverFontFallbackMessageToHost', (raw: unknown) => {
        const message = decodeWebviewToHostMessage(raw);
        assert.ok(message, 'Font fallback message failed Protocol decoding');
        if (message.type !== 'requestPreviewRender') return null;
        return decodeHostToWebviewMessage({
          type: 'previewRenderResult',
          requestId: message.requestId,
          result: {
            ok: true,
            value: exportRuntime.renderPreviewDocument({
              markdownText: message.text,
              sourceDocumentPath,
              uiLanguage: message.uiLanguage,
              styleEnvironment: message.environment
            })
          }
        });
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
      await page.addScriptTag({ content: `
        window.__meoFallbackFontQueryCount = 0;
        const scenario = ${JSON.stringify(scenario)};
        if (scenario !== 'unsupported') {
          window.queryLocalFonts = () => {
            window.__meoFallbackFontQueryCount += 1;
            if (scenario === 'throw') throw new Error('synthetic unavailable');
            return (async () => {
              if (scenario === 'empty') return [];
              if (scenario === 'other') throw new Error('synthetic unavailable');
              throw new DOMException('synthetic unavailable', scenario);
            })();
          };
        }
        window.acquireVsCodeApi = () => ({
          postMessage(message) {
            window.__deliverFontFallbackMessageToHost(message).then((response) => {
              if (response) window.dispatchEvent(new MessageEvent('message', { data: response }));
            });
          },
          getState() { return undefined; },
          setState() {}
        });
      ` });
      await page.addScriptTag({ path: bundlePath });
      await page.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), fallbackInit);
      await page.waitForFunction(() => (
        document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('Font fallback')
      ));
      assert.equal(await page.evaluate(() => (
        (window as typeof window & { __meoFallbackFontQueryCount?: number }).__meoFallbackFontQueryCount
      )), 0);
      assert.equal(await page.$eval('.preview-font-family-select', (select) => (
        (select as HTMLSelectElement).options.length
      )), 8);
      assert.equal(await page.evaluate(() => (
        (window as typeof window & { __meoFallbackFontQueryCount?: number }).__meoFallbackFontQueryCount
      )), 0);
      await page.select('.preview-font-family-select', 'SimSun');
      await page.waitForFunction(() => (
        getComputedStyle(
          document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
            .querySelector<HTMLElement>('.meo-export-doc')!
        ).fontFamily.includes('SimSun')
      ));
    } finally {
      await page.close();
    }
  }
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
  const previewFontFamilyCommands: string[] = [];
  try {
    await assertPreviewProjectionTransactions(browser, path.join(temp, 'bundle.js'));
    if (process.argv.includes('--projection-only')) {
      console.log('Preview projection transaction regression test passed');
      return;
    }
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 700, deviceScaleFactor: 1 });
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
      if (message.type === 'setPreviewFontFamily') {
        previewFontFamilyCommands.push(message.fontFamily);
        return null;
      }
      if (message.type !== 'requestPreviewRender') return null;
      const rendered = exportRuntime.renderPreviewDocument({
        markdownText: message.text,
        sourceDocumentPath,
        uiLanguage: message.uiLanguage,
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
      window.__meoSyntheticFontQueryCount = 0;
      window.queryLocalFonts = () => {
        window.__meoSyntheticFontQueryCount += 1;
        return new Promise((resolve) => {
          window.__resolveMEOFontQuery = () => resolve([
            { family: 'MEO Synthetic Serif' },
            { family: 'meo synthetic serif' },
            { family: 'MEO Synthetic Sans' },
            { family: '' },
            { family: 'MEO\\nMalformed' },
            { family: 42 }
          ]);
        });
      };
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
    const propertiesGeometry = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const properties = doc.createElement('section');
      properties.className = 'meo-export-frontmatter';
      properties.innerHTML = [
        '<div class="meo-export-frontmatter-header"><span class="meo-export-frontmatter-header-icon"></span><span>Properties</span></div>',
        '<div class="meo-export-frontmatter-line is-property">',
        '<span class="meo-export-frontmatter-key-cell">key</span>',
        '<div class="meo-export-frontmatter-value-group">value</div>',
        '</div>'
      ].join('');
      doc.body.append(properties);
      const lastRow = properties.querySelector<HTMLElement>('.meo-export-frontmatter-line:last-child')!;
      const propertiesStyle = getComputedStyle(properties);
      const gap = properties.getBoundingClientRect().bottom
        - lastRow.getBoundingClientRect().bottom
        - Number.parseFloat(propertiesStyle.borderBottomWidth);
      const header = properties.querySelector<HTMLElement>('.meo-export-frontmatter-header')!.getBoundingClientRect();
      const label = properties.querySelector<HTMLElement>('.meo-export-frontmatter-header > span:last-child')!.getBoundingClientRect();
      const rowHeight = lastRow.getBoundingClientRect().height;
      properties.remove();
      return { gap, rowHeight, headerHeight: header.height,
        centerOffset: (label.top + label.bottom - header.top - header.bottom) / 2 };
    });
    assert.ok(
      propertiesGeometry.gap <= 0.5,
      `Preview Properties must not leave a blank strip below its final row: ${propertiesGeometry.gap}px`
    );
    assert.ok(Math.abs(propertiesGeometry.headerHeight - propertiesGeometry.rowHeight) <= 1,
      `Preview Properties header must match a single property row: ${JSON.stringify(propertiesGeometry)}`);
    assert.ok(Math.abs(propertiesGeometry.centerOffset) <= 0.5,
      `Preview Properties title must remain centered: ${JSON.stringify(propertiesGeometry)}`);
    const fontControlContract = await page.evaluate(() => ({
      selectCount: document.querySelectorAll('select.preview-font-family-select').length,
      inputCount: document.querySelectorAll('.preview-font-family-input').length,
      customDropdownCount: document.querySelectorAll('.preview-font-family-dropdown').length,
      datalistCount: document.querySelectorAll('#meo-preview-font-family-options').length
    }));
    assert.deepEqual(fontControlContract, {
      selectCount: 1,
      inputCount: 0,
      customDropdownCount: 1,
      datalistCount: 0
    }, 'Preview font control must expose one custom non-editable dropdown backed by one hidden select');
    await page.click('.preview-font-family-dropdown');
    const dropdownThemeContract = await page.evaluate(() => {
      const control = document.querySelector<HTMLElement>('.preview-font-family-control')!;
      const trigger = document.querySelector<HTMLElement>('.preview-font-family-dropdown')!;
      const panel = document.querySelector<HTMLElement>('.preview-font-family-dropdown-panel')!;
      const panelStyle = getComputedStyle(panel);
      const triggerStyle = getComputedStyle(trigger);
      return {
        controlAppearance: control.dataset.previewAppearance,
        panelAppearance: panel.dataset.previewAppearance,
        panelHidden: panel.hidden,
        panelBackground: panelStyle.backgroundColor,
        panelRadius: Number.parseFloat(panelStyle.borderRadius),
        panelShadow: panelStyle.boxShadow,
        triggerShadow: triggerStyle.boxShadow
      };
    });
    assert.deepEqual(dropdownThemeContract, {
      controlAppearance: 'light',
      panelAppearance: 'light',
      panelHidden: false,
      panelBackground: 'rgb(255, 255, 255)',
      panelRadius: 9,
      panelShadow: 'none',
      triggerShadow: 'none'
    }, 'Preview dropdown popup must use the editor toolbar appearance with rounded, shadowless surfaces');
    await page.keyboard.press('Escape');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.mouse.move(0, 0);
    assert.deepEqual(await page.evaluate(() => Array.from(
      document.querySelectorAll<HTMLElement>('.preview-toolbar-dropdown'),
      (trigger) => {
        const chevron = trigger.querySelector<HTMLElement>('.preview-toolbar-dropdown-chevron')!;
        return {
          border: getComputedStyle(trigger).borderTopColor,
          chevron: getComputedStyle(chevron).borderRightColor
        };
      }
    )), [
      { border: 'rgb(122, 132, 144)', chevron: 'rgb(122, 132, 144)' },
      { border: 'rgb(122, 132, 144)', chevron: 'rgb(122, 132, 144)' },
      { border: 'rgb(122, 132, 144)', chevron: 'rgb(122, 132, 144)' }
    ], 'Inactive Preview dropdown borders and chevrons must share the requested neutral color');
    await page.select('.preview-appearance-select', 'dark');
    await page.click('.preview-font-family-dropdown');
    assert.deepEqual(await page.evaluate(() => ({
      previewAppearance: document.querySelector<HTMLSelectElement>('.preview-appearance-select')!.value,
      controlAppearance: document.querySelector<HTMLElement>('.preview-font-family-control')!.dataset.previewAppearance,
      panelAppearance: document.querySelector<HTMLElement>('.preview-font-family-dropdown-panel')!.dataset.previewAppearance,
      panelBackground: getComputedStyle(
        document.querySelector<HTMLElement>('.preview-font-family-dropdown-panel')!
      ).backgroundColor
    })), {
      previewAppearance: 'dark',
      controlAppearance: 'light',
      panelAppearance: 'light',
      panelBackground: 'rgb(255, 255, 255)'
    }, 'Preview content appearance must not recolor toolbar dropdowns');
    await page.keyboard.press('Escape');
    await page.select('.preview-appearance-select', 'light');
    assert.equal(await page.evaluate(() => {
      document.querySelector<HTMLSelectElement>('.preview-font-family-select')!
        .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      return (window as typeof window & { __meoSyntheticFontQueryCount?: number }).__meoSyntheticFontQueryCount;
    }), 0, 'Init and synthetic activation must not enumerate local fonts');
    const previewFrameCenter = await page.$eval('.preview-frame', (frame) => {
      const rect = frame.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(previewFrameCenter.x, previewFrameCenter.y);
    await page.mouse.wheel({ deltaY: 1 });
    const fontInteractionState = await page.evaluateHandle(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      const target = doc.querySelector<HTMLElement>('.meo-export-code-line-source')!;
      const range = doc.createRange();
      range.selectNodeContents(target);
      const selection = doc.defaultView!.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      doc.defaultView!.scrollTo(0, 120);
      return { frame, selection: selection.toString(), scrollTop: doc.scrollingElement!.scrollTop };
    });
    await page.select('.preview-font-family-select', 'SimSun');
    const enumeratedFontOptions = await page.evaluate(() => ({
      count: (window as typeof window & { __meoSyntheticFontQueryCount?: number }).__meoSyntheticFontQueryCount,
      values: Array.from(
        document.querySelectorAll<HTMLOptionElement>('.preview-font-family-select option'),
        (option) => option.value
      )
    }));
    assert.deepEqual(enumeratedFontOptions, {
      count: 0,
      values: ['', 'Microsoft YaHei', 'Segoe UI', 'Noto Sans CJK SC', 'Source Han Sans SC', 'SimSun', 'Arial', 'Georgia']
    });
    assert.equal(await page.$eval('.preview-font-family-select', (select) => (select as HTMLSelectElement).value), 'SimSun');
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
      if (!doc) return false;
      const bodyFamily = getComputedStyle(doc.querySelector<HTMLElement>('.meo-export-doc')!).fontFamily;
      const codeFamily = getComputedStyle(doc.querySelector<HTMLElement>('.meo-export-code-line-source')!).fontFamily;
      return bodyFamily.includes('SimSun') && !codeFamily.includes('SimSun');
    });
    assert.equal(previewFontFamilyCommands.at(-1), 'SimSun');
    await page.evaluate(() => new Promise<void>((resolve) => (
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    )));
    const preservedFontInteraction = await page.evaluate((before) => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      return {
        sameFrame: frame === before.frame,
        selection: doc.defaultView!.getSelection()!.toString(),
        expectedSelection: before.selection,
        scrollTop: doc.scrollingElement!.scrollTop,
        expectedScrollTop: before.scrollTop,
        maxScrollTop: Math.max(0, doc.scrollingElement!.scrollHeight - doc.scrollingElement!.clientHeight)
      };
    }, fontInteractionState);
    await fontInteractionState.dispose();
    assert.deepEqual(preservedFontInteraction, {
      sameFrame: true,
      selection: preservedFontInteraction.expectedSelection,
      expectedSelection: preservedFontInteraction.expectedSelection,
      scrollTop: Math.min(preservedFontInteraction.expectedScrollTop, preservedFontInteraction.maxScrollTop),
      expectedScrollTop: preservedFontInteraction.expectedScrollTop,
      maxScrollTop: preservedFontInteraction.maxScrollTop
    });
    await page.select('.preview-font-family-select', '');
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      return !getComputedStyle(doc.querySelector<HTMLElement>('.meo-export-doc')!).fontFamily.includes('SimSun');
    });
    assert.equal(previewFontFamilyCommands.at(-1), '');
    await page.select('.preview-font-family-select', 'Arial');
    await page.waitForFunction(() => (
      getComputedStyle(
        document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
          .querySelector<HTMLElement>('.meo-export-doc')!
      ).fontFamily.includes('Arial')
    ));
    await page.evaluate(() => {
      const select = document.querySelector<HTMLSelectElement>('.preview-font-family-select')!;
      const appearance = document.querySelector<HTMLSelectElement>('.preview-appearance-select')!;
      const coloring = document.querySelector<HTMLSelectElement>('.preview-source-coloring-select')!;
      appearance.value = 'dark';
      appearance.dispatchEvent(new Event('change', { bubbles: true }));
      coloring.value = 'false';
      coloring.dispatchEvent(new Event('change', { bubbles: true }));
      select.value = 'Georgia';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      appearance.value = 'light';
      appearance.dispatchEvent(new Event('change', { bubbles: true }));
      coloring.value = 'true';
      coloring.dispatchEvent(new Event('change', { bubbles: true }));
      select.value = 'Microsoft YaHei';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      return getComputedStyle(doc.documentElement).colorScheme === 'light'
        && document.querySelector<HTMLSelectElement>('.preview-source-coloring-select')!.value === 'true'
        && getComputedStyle(doc.querySelector<HTMLElement>('.meo-export-doc')!).fontFamily.includes('Microsoft YaHei');
    });
    const initialRows = await page.evaluate(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')
        ?.contentDocument?.querySelectorAll('.meo-export-code-line').length ?? 0
    ));
    assert.equal(initialRows, 6, 'Preview must expose one independent row per fenced source line');
    await page.evaluate(() => {
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
        ?.querySelector('code.language-typescript')?.scrollIntoView({ block: 'center' });
    });
    await page.waitForFunction(() => (
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
        ?.querySelectorAll('code.language-typescript .meo-export-code-line-source[data-meo-shiki]').length === 3
    ));
    const previewShikiColors = await page.evaluate(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const tokens = Array.from(doc.querySelectorAll<HTMLElement>(
        'code.language-typescript .meo-export-code-line-source[data-meo-shiki] > span'
      ));
      const colorFor = (text: string) => tokens.find((token) => token.textContent?.trim() === text)?.style.color ?? '';
      return {
        unique: [...new Set(tokens.map((token) => token.style.color).filter(Boolean))],
        keyword: colorFor('type'),
        typeName: colorFor('User'),
        bracket: colorFor('{')
      };
    });
    assert.ok(previewShikiColors.unique.length >= 4, JSON.stringify(previewShikiColors));
    assert.ok(previewShikiColors.keyword && previewShikiColors.typeName && previewShikiColors.bracket);
    assert.notEqual(previewShikiColors.keyword, previewShikiColors.typeName);
    const currentFrame = await page.$('.preview-frame');
    assert.ok(currentFrame, 'Preview iframe must exist before Mermaid settlement');
    await page.waitForFunction((frame) => {
      if (!(frame instanceof HTMLIFrameElement) || !frame.isConnected) return false;
      const doc = frame.contentDocument;
      return doc?.querySelectorAll('.meo-export-mermaid.is-rendered svg[data-fit-diagram]').length === 2
        && doc.querySelectorAll('.meo-export-mermaid.is-rendered .meo-fit-graphic').length === 10
        && doc.querySelector('.meo-export-mermaid.is-error code') !== null;
    }, {}, currentFrame);
    await page.waitForFunction((frame) => {
      if (!(frame instanceof HTMLIFrameElement) || !frame.isConnected) return false;
      return frame.contentDocument?.querySelectorAll('.meo-export-math-fenced-display > .meo-latex-math-canvas').length === 1;
    }, {}, currentFrame);
    const fencedMathSpacing = await page.evaluate(() => {
      const root = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
        .querySelector<HTMLElement>('.meo-export-math-fenced-display')!;
      const canvas = root.querySelector<HTMLElement>(':scope > .meo-latex-math-canvas')!;
      const style = root.ownerDocument.defaultView!.getComputedStyle(root);
      const rootRect = root.getBoundingClientRect();
      const canvasRect = canvas.getBoundingClientRect();
      return {
        paddingTop: Number.parseFloat(style.paddingTop),
        paddingBottom: Number.parseFloat(style.paddingBottom),
        visualTop: canvasRect.top - rootRect.top,
        visualBottom: rootRect.bottom - canvasRect.bottom
      };
    });
    assert.ok(
      fencedMathSpacing.visualTop >= 12 && fencedMathSpacing.visualBottom >= 12,
      `Preview fenced math needs a visible line of vertical breathing room: ${JSON.stringify(fencedMathSpacing)}`
    );

    const initialNative = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      const paragraph = Array.from(doc.querySelectorAll<HTMLParagraphElement>('p'))
        .find((candidate) => candidate.textContent?.includes('Medium prefix'))!;
      const root = paragraph.querySelector<HTMLElement>('.meo-export-math-inline')!;
      const before = doc.createElement('span');
      const after = doc.createElement('span');
      before.style.cssText = after.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;';
      root.before(before);
      root.after(after);
      return {
        html: root.innerHTML,
        className: root.className,
        canvasCount: root.querySelectorAll(':scope > .meo-latex-math-canvas').length,
        baselineDelta: Math.abs(before.getBoundingClientRect().bottom - after.getBoundingClientRect().bottom),
        scrollTop: doc.scrollingElement!.scrollTop
      };
    });
    assert.equal(initialNative.canvasCount, 0, JSON.stringify(initialNative));
    assert.equal(initialNative.className, 'meo-export-math meo-export-math-inline', JSON.stringify(initialNative));
    assert.ok(initialNative.html.startsWith('<span class="katex"'), JSON.stringify(initialNative));
    assert.ok(initialNative.baselineDelta <= 0.01, JSON.stringify(initialNative));

    await page.setViewport({ width: 420, height: 700, deviceScaleFactor: 1 });
    await page.waitForFunction((expectedFrame) => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      if (frame !== expectedFrame) return false;
      const paragraph = Array.from(frame.contentDocument!.querySelectorAll<HTMLParagraphElement>('p'))
        .find((candidate) => candidate.textContent?.includes('Medium prefix'))!;
      return paragraph.querySelectorAll(':scope .meo-export-math-inline > .meo-latex-math-canvas').length === 1;
    }, {}, currentFrame);
    await page.setViewport({ width: 421, height: 700, deviceScaleFactor: 1 });
    await page.setViewport({ width: 420, height: 700, deviceScaleFactor: 1 });
    const narrowed = await page.evaluate((expectedFrame) => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const doc = frame.contentDocument!;
      const paragraph = Array.from(doc.querySelectorAll<HTMLParagraphElement>('p'))
        .find((candidate) => candidate.textContent?.includes('Medium prefix'))!;
      const root = paragraph.querySelector<HTMLElement>('.meo-export-math-inline')!;
      const rootRect = root.getBoundingClientRect();
      const baseRects = Array.from(root.querySelectorAll<HTMLElement>('.katex-html .base'))
        .map((base) => base.getBoundingClientRect());
      return {
        sameFrame: frame === expectedFrame,
        canvasCount: root.querySelectorAll(':scope > .meo-latex-math-canvas').length,
        fits: Math.min(...baseRects.map((rect) => rect.left)) >= rootRect.left - 1
          && Math.max(...baseRects.map((rect) => rect.right)) <= rootRect.right + 1,
        pageOverflow: doc.querySelector<HTMLElement>('.meo-export-doc')!.scrollWidth
          - doc.querySelector<HTMLElement>('.meo-export-doc')!.clientWidth,
        scrollTop: doc.scrollingElement!.scrollTop
      };
    }, currentFrame);
    assert.deepEqual(narrowed, {
      sameFrame: true,
      canvasCount: 1,
      fits: true,
      pageOverflow: 0,
      scrollTop: initialNative.scrollTop
    }, JSON.stringify(narrowed));
    await page.setViewport({ width: 1200, height: 700, deviceScaleFactor: 1 });
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const paragraph = Array.from(doc.querySelectorAll<HTMLParagraphElement>('p'))
        .find((candidate) => candidate.textContent?.includes('Medium prefix'))!;
      return paragraph.querySelectorAll(':scope .meo-export-math-inline > .meo-latex-math-canvas').length === 1
        && doc.querySelector<HTMLElement>('.meo-export-doc')!.scrollWidth
          - doc.querySelector<HTMLElement>('.meo-export-doc')!.clientWidth <= 1;
    });

    const layoutCases = [1, 2].flatMap((deviceScaleFactor) => (
      [420, 1200].flatMap((width) => (
        [0.8, 1, 1.25].map((zoom) => ({ deviceScaleFactor, width, zoom }))
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
      const readMermaidInteractionState = () => page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const diagrams = Array.from(doc.querySelectorAll<SVGSVGElement>('svg[data-fit-diagram]'));
        return {
          viewBoxes: diagrams.map((svg) => svg.getAttribute('viewBox')),
          transforms: diagrams.flatMap((svg) => Array.from(svg.querySelectorAll<SVGGraphicsElement>('*')).map((element) => ({
            attribute: element.getAttribute('transform'),
            computed: getComputedStyle(element).transform
          }))),
          scrollPositions: Array.from(doc.querySelectorAll<HTMLElement>('.meo-export-mermaid, .meo-export-mermaid-svg'))
            .map((element) => ({ left: element.scrollLeft, top: element.scrollTop }))
        };
      });
      const previewScrollBeforeDrag = await page.evaluate(() => (
        document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
      ));
      const tallDiagramHandle = await previewFrame.$('svg[data-fit-diagram="tall"]');
      assert.ok(tallDiagramHandle, 'Tall Mermaid SVG must remain reachable for the public drag probe');
      await tallDiagramHandle.evaluate((svg) => svg.scrollIntoView({ block: 'center' }));
      const beforeMermaidDrag = await readMermaidInteractionState();
      const tallDiagramBox = await tallDiagramHandle.boundingBox();
      assert.ok(tallDiagramBox, 'Tall Mermaid SVG must expose a public viewport for the drag probe');
      const previewFrameBox = await currentFrame.boundingBox();
      assert.ok(previewFrameBox, 'Current Preview iframe must expose a public viewport for the drag probe');
      const visibleDiagramRect = {
        left: Math.max(tallDiagramBox.x, previewFrameBox.x),
        right: Math.min(tallDiagramBox.x + tallDiagramBox.width, previewFrameBox.x + previewFrameBox.width),
        top: Math.max(tallDiagramBox.y, previewFrameBox.y),
        bottom: Math.min(tallDiagramBox.y + tallDiagramBox.height, previewFrameBox.y + previewFrameBox.height)
      };
      assert.ok(
        visibleDiagramRect.right > visibleDiagramRect.left && visibleDiagramRect.bottom > visibleDiagramRect.top,
        'Tall Mermaid SVG must intersect the current Preview viewport'
      );
      const dragStart = {
        x: (visibleDiagramRect.left + visibleDiagramRect.right) / 2,
        y: (visibleDiagramRect.top + visibleDiagramRect.bottom) / 2
      };
      const dragHitTallDiagram = await previewFrame.evaluate(({ x, y }) => (
        document.elementFromPoint(x, y)?.closest('svg[data-fit-diagram="tall"]') !== null
      ), { x: dragStart.x - previewFrameBox.x, y: dragStart.y - previewFrameBox.y });
      assert.equal(dragHitTallDiagram, true, 'Public hit testing must prove the drag starts on the tall Mermaid SVG');
      await page.mouse.move(dragStart.x, dragStart.y);
      await page.mouse.down();
      await page.mouse.move(dragStart.x + 40, dragStart.y + 30);
      await page.mouse.up();
      assert.deepEqual(await readMermaidInteractionState(), beforeMermaidDrag, 'Preview Mermaid must not pan or transform after dragging');
      await page.evaluate((scrollTop) => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        doc.defaultView!.scrollTo(0, scrollTop);
      }, previewScrollBeforeDrag);
      await previewFrame.focus('a:has(img[alt="Linked alt"])');
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
        const mathRoots = Array.from(doc.querySelectorAll<HTMLElement>('.meo-export-math'));
        const inspectMathRoot = (root: HTMLElement) => {
          const rect = root.getBoundingClientRect();
          const style = getComputedStyle(root);
          const baseRects = Array.from(root.querySelectorAll<HTMLElement>('.katex-html .base'))
            .map((base) => base.getBoundingClientRect());
          const contentLeft = baseRects.length > 0 ? Math.min(...baseRects.map((base) => base.left)) : rect.left;
          const contentRight = baseRects.length > 0 ? Math.max(...baseRects.map((base) => base.right)) : rect.right;
          const clippingAncestors: string[] = [];
          for (let current: HTMLElement | null = root; current; current = current.parentElement) {
            const currentStyle = getComputedStyle(current);
            if ([currentStyle.overflowX, currentStyle.overflowY].some((value) => value === 'hidden' || value === 'clip')) {
              clippingAncestors.push(`${current.tagName.toLowerCase()}.${current.className}:${currentStyle.overflowX}/${currentStyle.overflowY}`);
            }
          }
          return {
            inline: root.classList.contains('meo-export-math-inline'),
            fenced: root.classList.contains('meo-export-math-fenced-display'),
            display: root.classList.contains('meo-export-math-display'),
            canvasCount: root.querySelectorAll(':scope > .meo-latex-math-canvas').length,
            contentWithinRoot: contentLeft >= rect.left + Number.parseFloat(style.paddingLeft) - 1
              && contentRight <= rect.right - Number.parseFloat(style.paddingRight) + 1,
            contentWithinPage: contentLeft >= rootRect.left - 1 && contentRight <= rootRect.right + 1,
            rootWithinPage: rect.left >= rootRect.left - 1 && rect.right <= rootRect.right + 1,
            scrollOverflow: root.scrollWidth - root.clientWidth,
            overflowX: style.overflowX,
            clippingAncestors,
            draggable: root.getAttribute('draggable')
          };
        };
        const shortParagraph = Array.from(doc.querySelectorAll<HTMLParagraphElement>('p'))
          .find((paragraph) => paragraph.textContent?.includes('Short prefix'))!;
        const longMathParagraph = Array.from(doc.querySelectorAll<HTMLParagraphElement>('p'))
          .find((paragraph) => paragraph.textContent?.includes('Prefix prose wraps before'))!;
        const shortInline = shortParagraph.querySelector<HTMLElement>('.meo-export-math-inline')!;
        const longInline = longMathParagraph.querySelector<HTMLElement>('.meo-export-math-inline')!;
        const installBaselineProbe = (root: HTMLElement, side: 'before' | 'after') => {
          const probe = doc.createElement('span');
          probe.dataset.mathBaselineProbe = side;
          probe.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;';
          root[side === 'before' ? 'before' : 'after'](probe);
          return probe;
        };
        const shortBefore = installBaselineProbe(shortInline, 'before');
        const shortAfter = installBaselineProbe(shortInline, 'after');
        const longBefore = installBaselineProbe(longInline, 'before');
        const longAfter = installBaselineProbe(longInline, 'after');
        const inspectInline = (root: HTMLElement, before: HTMLElement, after: HTMLElement) => {
          const inspected = inspectMathRoot(root);
          const canvas = root.querySelector<HTMLElement>(':scope > .meo-latex-math-canvas');
          const rootBox = root.getBoundingClientRect();
          const canvasBox = canvas?.getBoundingClientRect();
          const paragraph = root.closest('p')!;
          const fragmentSummary = (node: Node | null) => {
            if (!node) return { count: 0, firstTop: Number.NaN, lastTop: Number.NaN };
            const range = doc.createRange();
            range.selectNodeContents(node);
            const rects = Array.from(range.getClientRects());
            return {
              count: rects.length,
              firstTop: rects[0]?.top ?? Number.NaN,
              lastTop: rects.at(-1)?.top ?? Number.NaN
            };
          };
          return {
            ...inspected,
            computedDisplay: doc.defaultView!.getComputedStyle(root).display,
            verticalAlign: doc.defaultView!.getComputedStyle(root).verticalAlign,
            canvasFontSize: canvas?.style.fontSize ?? '',
            canvasZoom: canvas?.style.zoom ?? '',
            rootBoxCount: root.getClientRects().length,
            widthDelta: canvasBox ? Math.abs(rootBox.width - canvasBox.width) : 0,
            heightDelta: canvasBox ? Math.abs(rootBox.height - canvasBox.height) : 0,
            prefix: fragmentSummary(paragraph.firstChild),
            formula: fragmentSummary(root),
            suffix: fragmentSummary(paragraph.lastChild),
            baselineBefore: before.getBoundingClientRect().bottom,
            baselineAfter: after.getBoundingClientRect().bottom
          };
        };
        const kbdRange = doc.createRange();
        kbdRange.selectNodeContents(kbd);
        selection.removeAllRanges();
        selection.addRange(kbdRange);
        tableLink.focus({ preventScroll: true });
        const tableSelectionText = selection.toString();
        const tableCopied = doc.execCommand('copy');
        const tableClipboardText = await doc.defaultView!.navigator.clipboard.readText();
        const tableFocusedLink = doc.activeElement === tableLink;
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
          for (let current = graphic.parentElement; current; current = current.parentElement) {
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
        const mathSelection = doc.createRange();
        mathSelection.selectNodeContents(longMathParagraph);
        selection.removeAllRanges();
        selection.addRange(mathSelection);
        const safeMathLink = longMathParagraph.querySelector<HTMLAnchorElement>('a')!;
        safeMathLink.focus({ preventScroll: true });
        const normalizeMathSelection = (value: string) => normalizeText(value.replace(/[\u200b\u2060]/g, ''));
        const mathSelectionText = normalizeMathSelection(selection.toString());
        const mathCopied = doc.execCommand('copy');
        const mathClipboardText = normalizeMathSelection(await doc.defaultView!.navigator.clipboard.readText());
        const scrollingElement = doc.scrollingElement!;
        const initialScrollTop = scrollingElement.scrollTop;
        mermaidSvgs[1].scrollIntoView({ block: 'end' });
        const tallReachRect = mermaidSvgs[1].getBoundingClientRect();
        const tallBottomReachable = tallReachRect.bottom > 0 && tallReachRect.bottom <= doc.defaultView!.innerHeight + 1;
        const tallScrollTop = scrollingElement.scrollTop;
        mermaidSvgs[0].scrollIntoView({ block: 'start' });
        const wideReachRect = mermaidSvgs[0].getBoundingClientRect();
        const wideReturnReachable = wideReachRect.top >= -1 && wideReachRect.top < doc.defaultView!.innerHeight;
        const wideScrollTop = scrollingElement.scrollTop;
        doc.defaultView!.scrollTo(0, initialScrollTop);
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
          math: {
            roots: mathRoots.map(inspectMathRoot),
            controls: doc.querySelectorAll('.meo-latex-math-zoom-controls, [aria-label*="fullscreen" i]').length,
            inline: {
              short: inspectInline(shortInline, shortBefore, shortAfter),
              long: inspectInline(longInline, longBefore, longAfter),
              selectionText: mathSelectionText,
              clipboardText: mathClipboardText,
              copied: mathCopied,
              focusedLink: doc.activeElement === safeMathLink,
              href: safeMathLink.dataset.meoPreviewHref,
              linkTabIndex: safeMathLink.tabIndex
            },
            brokenFallbackVisible: doc.body.textContent?.includes('BROKEN_INLINE_SENTINEL') ?? false
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
            focusedLink: tableFocusedLink,
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
            verticalReach: {
              tallBottomReachable,
              wideReturnReachable,
              tallScrollTop,
              wideScrollTop,
              initialScrollTop
            },
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
      const displayMath = result.math.roots.filter((root) => root.display);
      const sameLineMath = displayMath.find((root) => !root.fenced)!;
      const fencedMath = displayMath.find((root) => root.fenced)!;
      assert.equal(fencedMath.canvasCount, 1, JSON.stringify({ width, zoom, deviceScaleFactor, fencedMath }));
      assert.equal(fencedMath.contentWithinRoot, true, JSON.stringify({ width, zoom, deviceScaleFactor, fencedMath }));
      assert.equal(sameLineMath.canvasCount, 1, JSON.stringify({ width, zoom, deviceScaleFactor, sameLineMath }));
      assert.equal(sameLineMath.contentWithinRoot, true, JSON.stringify({ width, zoom, deviceScaleFactor, sameLineMath }));
      assert.ok(displayMath.every((root) => root.contentWithinPage && root.rootWithinPage), JSON.stringify({ width, zoom, deviceScaleFactor, displayMath }));
      assert.ok(displayMath.every((root) => root.scrollOverflow <= 1 && !/(auto|scroll)/.test(root.overflowX)), JSON.stringify({ width, zoom, deviceScaleFactor, displayMath }));
      assert.ok(displayMath.every((root) => root.clippingAncestors.length === 0), JSON.stringify({ width, zoom, deviceScaleFactor, displayMath }));
      assert.equal(result.math.inline.short.canvasCount, 0);
      assert.equal(result.math.inline.short.computedDisplay, 'inline-flex');
      assert.equal(result.math.inline.short.verticalAlign, 'baseline');
      assert.equal(result.math.inline.short.canvasFontSize, '');
      assert.equal(result.math.inline.short.canvasZoom, '');
      assert.equal(result.math.inline.short.rootBoxCount, 1);
      assert.ok(Math.abs(result.math.inline.short.baselineBefore - result.math.inline.short.baselineAfter) <= 0.01, JSON.stringify(result.math.inline.short));
      assert.equal(result.math.inline.long.contentWithinRoot, true, JSON.stringify({ width, zoom, deviceScaleFactor, inline: result.math.inline.long }));
      assert.equal(result.math.inline.long.contentWithinPage, true, JSON.stringify({ width, zoom, deviceScaleFactor, inline: result.math.inline.long }));
      assert.equal(result.math.inline.long.canvasCount, 1, JSON.stringify({ width, zoom, deviceScaleFactor, inline: result.math.inline.long }));
      assert.equal(result.math.inline.long.computedDisplay, 'inline-flex');
      assert.equal(result.math.inline.long.verticalAlign, 'baseline');
      assert.equal(result.math.inline.long.rootBoxCount, 1);
      assert.ok(result.math.inline.long.widthDelta <= 1 && result.math.inline.long.heightDelta <= 1, JSON.stringify(result.math.inline.long));
      assert.ok(result.math.inline.long.prefix.count > 0 && result.math.inline.long.formula.count > 0 && result.math.inline.long.suffix.count > 0);
      assert.ok(result.math.inline.long.prefix.firstTop <= result.math.inline.long.formula.firstTop);
      assert.ok(result.math.inline.long.formula.firstTop <= result.math.inline.long.suffix.lastTop);
      assert.equal(result.math.inline.long.scrollOverflow <= 1, true, JSON.stringify(result.math.inline.long));
      assert.deepEqual(result.math.inline.long.clippingAncestors, []);
      assert.equal(result.math.inline.long.draggable, null);
      assert.equal(result.math.inline.selectionText, result.math.inline.clipboardText);
      assert.equal(result.math.inline.copied, true);
      assert.equal((result.math.inline.selectionText.match(/INLINE000/g) ?? []).length, 1);
      assert.equal((result.math.inline.selectionText.match(/INLINE191/g) ?? []).length, 1);
      assert.ok(result.math.inline.selectionText.startsWith('Prefix prose wraps before safe link and'));
      assert.ok(result.math.inline.selectionText.endsWith('then suffix prose wraps after the formula.'));
      assert.equal(result.math.inline.focusedLink, true);
      assert.equal(result.math.inline.href, 'https://example.com/safe');
      assert.equal(result.math.inline.linkTabIndex, 0);
      assert.equal(result.math.brokenFallbackVisible, true);
      const safeMathActivation = await activateAndWaitForOpenLink(
        openLinkWaiter,
        () => page.keyboard.press('Enter')
      );
      assert.deepEqual(safeMathActivation, {
        type: 'openLink', href: 'https://example.com/safe', source: 'preview'
      });
      assert.equal(result.math.controls, 0);
      assert.ok(displayMath.every((root) => root.draggable === null));
      if (width === 420 && zoom === 0.8 && deviceScaleFactor === 1) {
        await assertPreviewMathMeasurementTransaction(page);
      }
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
      assert.ok(
        result.mermaidSuccess.htmlClippingAncestors.every((value: string) => (
          value.startsWith('div.meo-export-mermaid is-rendered:hidden/hidden')
        )),
        JSON.stringify(result.mermaidSuccess.htmlClippingAncestors)
      );
      assert.equal(result.mermaidSuccess.verticalReach.tallBottomReachable, true);
      assert.equal(result.mermaidSuccess.verticalReach.wideReturnReachable, true);
      assert.ok(result.mermaidSuccess.verticalReach.tallScrollTop > result.mermaidSuccess.verticalReach.wideScrollTop);
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
        && diagram.withinPage && diagram.blockWithinPage
        && diagram.overflowModes.every((value) => !/(auto|scroll)/.test(value))
        && diagram.graphicsWithinViewport && diagram.graphicsWithinPage
        && diagram.preserveAspectRatio !== 0
        && diagram.draggable === null
        && diagram.cursor === 'auto'
      )), JSON.stringify({ width, zoom, deviceScaleFactor, mermaidSuccess: result.mermaidSuccess }));
      assert.deepEqual(result.table.semanticCounts, { table: 2, thead: 2, tbody: 2, tr: 5, th: 10, td: 18 });
      assert.equal(result.table.resizeHandleCount, 0);
      assert.ok(result.table.listPadding >= 24 && result.table.listCellPadding >= 10.5, JSON.stringify(result.table));
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

    const oldInlineState = await page.evaluateHandle(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const oldDocument = frame.contentDocument!;
      const oldRoot = oldDocument.querySelector<HTMLElement>('.meo-export-math-inline.meo-latex-math-viewport')!;
      const oldCanvas = oldRoot.querySelector<HTMLElement>(':scope > .meo-latex-math-canvas')!;
      return {
        document: oldDocument,
        root: oldRoot,
        canvas: oldCanvas,
        presentation: { fontSize: oldCanvas.style.fontSize, zoom: oldCanvas.style.zoom }
      };
    });
    await page.select('.preview-source-coloring-select', 'false');
    await page.waitForFunction(() => (
      document.querySelector<HTMLSelectElement>('.preview-source-coloring-select')?.value === 'false'
    ));
    const replacementCurrentness = await page.evaluate((state) => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const currentRoot = frame.contentDocument!
        .querySelector<HTMLElement>('.meo-export-math-inline.meo-latex-math-viewport')!;
      const currentCanvas = currentRoot.querySelector<HTMLElement>(':scope > .meo-latex-math-canvas')!;
      return {
        oldFrameIsCurrent: frame.contentDocument === state.document,
        sameRoot: currentRoot === state.root,
        sameCanvas: currentCanvas === state.canvas,
        oldPresentation: { fontSize: state.canvas.style.fontSize, zoom: state.canvas.style.zoom },
        expectedOldPresentation: state.presentation,
        currentConnected: currentRoot.isConnected,
        currentInvalidCss: /(?:NaN|Infinity)/i.test(`${currentCanvas.style.cssText};${currentRoot.style.cssText}`)
      };
    }, oldInlineState);
    await oldInlineState.dispose();
    assert.deepEqual(replacementCurrentness, {
      oldFrameIsCurrent: true,
      sameRoot: true,
      sameCanvas: true,
      oldPresentation: replacementCurrentness.expectedOldPresentation,
      expectedOldPresentation: replacementCurrentness.expectedOldPresentation,
      currentConnected: true,
      currentInvalidCss: false
    });

    const exportedFallback = exportRuntime.renderExportHtmlDocument({
      readingSnapshot: {
        snapshotId: 'g2a-mermaid-fallback',
        text: `\`\`\`mermaid\n${mermaidFallbackSource}\`\`\``,
        appearance: 'light',
        uiLanguage: 'en',
        environment: { previewFontFamily: '' }
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

      const injectionProbe = buildExportHtmlDocument({
        title: 'Style raw-text DOM safety',
        bodyHtml: '<p class="safe">safe</p>',
        stylesCss: '.safe{color:rgb(0,128,0)}</StYlE><script data-meo-style-injection>globalThis.__meoInjected=true</script><style>',
        target: 'html',
        hasMermaid: false,
        hasMath: false
      });
      await exportPage.setContent(injectionProbe, { waitUntil: 'domcontentloaded' });
      assert.deepEqual(await exportPage.evaluate(() => ({
        injectionNodes: document.querySelectorAll('[data-meo-style-injection]').length,
        injected: (globalThis as typeof globalThis & { __meoInjected?: boolean }).__meoInjected === true,
        color: getComputedStyle(document.querySelector<HTMLElement>('.safe')!).color
      })), { injectionNodes: 0, injected: false, color: 'rgb(0, 128, 0)' });
    } finally {
      await exportPage.close();
    }
    await assertFontEnumerationFallbackMatrix(browser, path.join(temp, 'bundle.js'));
  } finally {
    openLinkWaiter?.dispose(new Error('Preview test ended before openLink delivery'));
    await browser.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log('Preview reading surface production checks passed');
}

await main();
