import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { closeTestBrowser, findBrowserExecutable, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import type { PreviewDocumentOperation } from '../src/foundation/previewDocument';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-code-update-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const text = '# Viewport budget\n\nEarly reference[^early].\n\n[^early]: Footnote rendered after the final section.\n\n'
  + Array.from({ length: 4_100 }, (_, index) => `Paragraph ${index}.\n\n`).join('')
  + '<details>\n<summary>Closed section</summary>\n\n## Hidden heading\n\nHidden paragraph.\n\n</details>\n\n'
  + '## Final section\n\nFinal paragraph.';
const browser = await launchTestBrowser({
  createUserDataDir: () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'meo-preview-scrollbar-test-')),
  launch: ({ userDataDir }) => puppeteer.launch({
    executablePath: findBrowserExecutable(), headless: true, userDataDir, protocolTimeout: 30_000,
    ignoreDefaultArgs: ['--hide-scrollbars'], args: ['--no-sandbox', '--edge-skip-compat-layer-relaunch']
  }),
  cleanupUserDataDir: async directory => {
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)
      && path.basename(directory).startsWith('meo-preview-scrollbar-test-'));
    await fs.promises.rm(directory, { recursive: true });
  }
});
let primaryError: unknown;
let stage = 'initialization';
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1100, height: 720 });
  await page.setContent('<!doctype html><style>html,body{height:100%;margin:0}</style><body></body>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: '.preview-host:not([hidden]){height:100%;display:flex;flex-direction:column}.preview-frame{width:100%;height:100%;flex:1}' });
  if (process.argv.includes('--declined-owner')) await page.evaluate(() => {
    (window as any).__previewDeclineViewportTransactionOwner = true;
  });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const windowText = '# Reading window\n\n' + Array.from({ length: 5000 }, (_, index) =>
    `Paragraph ${index} with **needle-${index}** and editable source context.\n\n`).join('')
    + '## Complete tail\n\nNotes[^first] and[^second].\n\n[^second]: Second note.\n\n[^first]: First note.\n';
  const windowDocument = createPreviewDocument('window-fixture', {
    markdownText: windowText, sourceDocumentPath: '/fixture/window.md', uiLanguage: 'en'
  });
  const openedWindow = windowDocument.open(1);
  stage = 'window mounting and navigation';
  await page.exposeFunction('__windowOperation', (_id: string, operation: PreviewDocumentOperation) => windowDocument.run(operation));
  await page.evaluate(opened => {
    const scope = window as any;
    const frame = scope.__windowFrame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:20';
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.open(); doc.write(`<!doctype html><style>${opened.styles.light}</style><body tabindex="-1"><div class="meo-export-page"><main class="meo-export-doc markdown-body"></main></div></body>`); doc.close();
    scope.__windowChanges = 0;
    scope.__windowErrors = [];
    scope.__windowViewport = scope.__createPreviewViewport(doc.querySelector('main'), opened.document, {
      request: async (id: string, operation: any) => {
        if (operation.kind === 'blocks' && scope.__windowBlockRequests) {
          scope.__windowBlockRequests.push([...operation.indices]);
          scope.__windowBlockFlight = (scope.__windowBlockFlight ?? 0) + 1;
          scope.__windowBlockPeak = Math.max(scope.__windowBlockPeak ?? 0, scope.__windowBlockFlight);
          try {
            if (scope.__windowBlockPause) await new Promise(resolve => (scope.__windowBlockReleases ??= []).push(resolve));
            return await scope.__windowOperation(id, operation);
          } finally { scope.__windowBlockFlight -= 1; }
        }
        const gate = scope.__windowDelay;
        if (gate && (gate.kind === 'locate' && operation.kind === 'locate'
          || gate.kind === 'blocks' && operation.kind === 'blocks' && operation.indices.includes(gate.block))) {
          gate.started = true;
          await new Promise((resolve, reject) => { gate.resolve = resolve; gate.reject = reject; });
        }
        return scope.__windowOperation(id, operation);
      },
      mutate: (run: () => void) => run(),
      changed: () => { scope.__windowChanges += 1; },
      error: (error: unknown) => scope.__windowErrors.push(String(error)),
      reveal: (element: HTMLElement, block: ScrollLogicalPosition) => element.scrollIntoView({ block }),
      writeClipboard: async (value: Promise<unknown>) => { scope.__windowCopied = await value; }
    });
  }, openedWindow);
  stage = 'fast scrolling coalesces background demand';
  const burst = await page.evaluate(async () => {
    const scope = window as any, viewport = scope.__windowViewport, doc = scope.__windowFrame.contentDocument;
    await viewport.whenReady();
    scope.__windowBlockRequests = []; scope.__windowBlockPause = true;
    for (let index = 1; index <= 30; index++) {
      doc.scrollingElement.scrollTop = index / 30 * (doc.scrollingElement.scrollHeight - doc.scrollingElement.clientHeight);
      doc.dispatchEvent(new Event('scroll'));
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    const result = { peak: scope.__windowBlockPeak, requests: scope.__windowBlockRequests.length };
    scope.__windowBlockPause = false;
    for (const release of scope.__windowBlockReleases ?? []) release();
    await viewport.whenReady();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    result.requests = scope.__windowBlockRequests.length;
    const anchor = viewport.readAnchor(100);
    return { ...result, anchor, mounted: anchor && viewport.containsLine(anchor.line), errors: scope.__windowErrors };
  });
  assert.equal(burst.peak, 1, 'one reading viewport must not flood the shared renderer while an earlier window is pending');
  assert.ok(burst.requests <= 3, `obsolete scroll windows must coalesce into the final demand, got ${burst.requests} batches`);
  assert.ok(burst.mounted, 'backpressure must still materialize the final reading window');
  assert.deepEqual(burst.errors, []);
  await page.evaluate(() => { delete (window as any).__windowBlockRequests; });
  await page.evaluate(async () => {
    const viewport = (window as any).__windowViewport;
    await viewport.ensure({ block: 0 });
    viewport.rebind({ ...viewport.manifest, chunks: [] });
    await viewport.whenReady();
  });
  stage = 'window keyboard navigation supersession';
  await page.evaluate(() => {
    const scope = window as any, doc = scope.__windowFrame.contentDocument;
    scope.__windowDelay = { kind: 'blocks', block: scope.__windowViewport.manifest.blocks.length - 1 };
    doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true, cancelable: true }));
    doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true, cancelable: true }));
    doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => (window as any).__windowDelay.started);
  const supersededNavigation = await page.evaluate(async () => {
    const scope = window as any;
    scope.__windowDelay.reject(new Error('Obsolete block request')); scope.__windowDelay = null;
    for (let index = 0; index < 4; index += 1) await new Promise(resolve => requestAnimationFrame(resolve));
    const rect = scope.__windowFrame.contentDocument.querySelector('h1').getBoundingClientRect();
    // scrollIntoView rounds to physical pixels; a fractional negative edge
    // still means Home reached the first heading, not the obsolete End target.
    return rect.top >= -1 / devicePixelRatio && rect.top < innerHeight;
  });
  assert.ok(supersededNavigation, 'a late Ctrl+End result must not override a newer Ctrl+Home intent');
  assert.deepEqual(await page.evaluate(() => (window as any).__windowErrors), [], 'superseded block failures must not fail the current reading window');
  for (const block of [750, 2500, 4999, 2]) {
    const result = await page.evaluate(async block => {
      const scope = window as any;
      const element = await scope.__windowViewport.ensure({ block, align: 'center' });
      const rect = element?.getBoundingClientRect();
      return { visible: Boolean(rect && rect.top < innerHeight && rect.bottom > 0),
        nodes: scope.__windowFrame.contentDocument.querySelectorAll('*').length };
    }, block);
    assert.ok(result.visible, `requested window block ${block} must be visible`);
    assert.ok(result.nodes < 2000, `windowing retained ${result.nodes} DOM nodes for 5000 paragraphs`);
  }
  const tailWindow = await page.evaluate(async () => {
    const scope = window as any;
    const element = await scope.__windowViewport.ensure({ anchor: 'complete-tail', align: 'end' });
    return element?.textContent;
  });
  assert.equal(tailWindow, 'Complete tail');
  const secondDefinitionLine = windowText.slice(0, windowText.indexOf('[^second]:')).split('\n').length;
  const noteNavigation = await page.evaluate(async line => {
    const scope = window as any;
    const definition = await scope.__windowViewport.ensure({ line, align: 'center' });
    const first = await scope.__windowViewport.ensure({ anchor: 'fn-1', align: 'center' });
    const reference = await scope.__windowViewport.ensure({ anchor: 'fnref-2', align: 'center' });
    return { definition: definition?.textContent.includes('Second note'), first: first?.textContent.includes('First note'),
      reference: reference?.id };
  }, secondDefinitionLine);
  assert.deepEqual(noteNavigation, { definition: true, first: true, reference: 'fnref-2' },
    'source and fragment navigation must preserve footnote visual order independently of definition order');
  stage = 'window whole-document selection/copy';
  await page.evaluate(() => {
    const scope = window as any, doc = scope.__windowFrame.contentDocument;
    doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    doc.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
    doc.body.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => Boolean((window as any).__windowCopied));
  const copiedWindow = await page.evaluate(() => {
    const scope = window as any;
    return { first: scope.__windowCopied.text.includes('Reading window'), last: scope.__windowCopied.text.includes('Complete tail'),
      paragraphs: (scope.__windowCopied.text.match(/Paragraph \d+ with/g) ?? []).length,
      formatting: scope.__windowCopied.html.includes('<strong>needle-2500</strong>'), errors: scope.__windowErrors };
  });
  assert.deepEqual(copiedWindow, { first: true, last: true, paragraphs: 5000, formatting: true, errors: [] });
  stage = 'window partial selection with hydrated endpoint text';
  await page.evaluate(async () => {
    const scope = window as any, doc = scope.__windowFrame.contentDocument;
    doc.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    const first = await scope.__windowViewport.ensure({ block: 1 });
    const selected = doc.defaultView.getSelection(), range = doc.createRange();
    range.setStart(first.firstChild, 2); range.setEnd(first.firstChild, 3);
    selected.removeAllRanges(); selected.addRange(range);
    const last = await scope.__windowViewport.ensure({ block: 2501 });
    last.querySelector('strong').textContent = 'hydrated-final-value';
    selected.extend(last.querySelector('strong').firstChild, 14);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    scope.__windowCopied = null;
    doc.body.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => Boolean((window as any).__windowCopied));
  const partial = await page.evaluate(() => (window as any).__windowCopied);
  assert.ok(partial.text.startsWith('ragraph 0 with needle-0'), 'partial selection must retain the first DOM endpoint');
  assert.ok(partial.text.endsWith('hydrated-final'), 'hydrated endpoint offsets must not be applied to parser source text');
  assert.ok(partial.html.includes('<strong>needle-1250</strong>'), 'unmounted interior formatting must be copied');
  const cancelledLocation = await page.evaluate(async () => {
    const scope = window as any;
    const gate = scope.__windowDelay = { kind: 'locate' };
    const pending = scope.__windowViewport.ensure({ anchor: 'complete-tail' });
    scope.__windowViewport.dispose();
    gate.reject(new Error('Preview request cancelled')); scope.__windowDelay = null;
    return await pending;
  });
  assert.equal(cancelledLocation, null, 'disposing a pending fragment request must not fail the replacement Preview');
  await page.evaluate(() => {
    const scope = window as any;
    scope.__windowViewport.dispose(); scope.__windowFrame.remove();
  });
  windowDocument.dispose();
  stage = 'production window transport, search and source navigation';
  const controllerDocuments = new Map<string, ReturnType<typeof createPreviewDocument>>();
  await page.exposeFunction('__previewControllerHost', async (message: any) => {
    if (message.type === 'requestPreviewRender') {
      const options = { markdownText: message.text, sourceDocumentPath: '/fixture/controller.md', uiLanguage: 'en' as const,
        preset: message.preset, styleEnvironment: message.environment };
      let value;
      if (message.window) {
        const parsed = createPreviewDocument(message.requestId, options);
        controllerDocuments.set(message.requestId, parsed);
        value = parsed.open(message.window.anchorLine);
      } else value = exportRuntime.renderPreviewDocument(options);
      return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } };
    }
    if (message.type === 'requestPreviewDocument') {
      const parsed = controllerDocuments.get(message.documentId);
      return { type: 'previewDocumentResult', requestId: message.requestId, documentId: message.documentId,
        result: parsed ? { ok: true, value: await parsed.run(message.operation) }
          : { ok: false, error: { message: 'Preview document expired', code: 'failed' } } };
    }
    return null;
  });
  await page.evaluate(async text => {
    const scope = window as any, controller = scope.__previewController;
    scope.__previewBridgeErrors = [];
    scope.__previewHostMessage = (message: any) => {
      const pending = scope.__projectionGate;
      const gate = pending && message.type === 'requestPreviewDocument' && message.operation.kind === 'blocks'
        && message.operation.indices.some((index: number) => index >= pending.from && index <= pending.to) ? pending : null;
      const ready = gate ? new Promise<void>(resolve => { gate.started = true; gate.release = resolve; }) : Promise.resolve();
      void ready.then(() => scope.__previewControllerHost(message)).then((response: any) => {
        if (response?.type === 'previewRenderResult') {
          scope.__previewManifest = response.result.value.document;
          controller.acceptRenderResponse(response);
        }
        else if (response?.type === 'previewDocumentResult') controller.acceptDocumentResponse(response);
      }).catch((error: unknown) => scope.__previewBridgeErrors.push(String(error)));
    };
    controller.setVisible(true); controller.setSourceColoring(false);
    await controller.requestRender(text, { force: true });
  }, windowText);
  await page.waitForFunction(() => {
    const scope = window as any;
    return scope.__previewController.getSearchAdapter().isSearchReady()
      && scope.__previewController.host.querySelector('iframe').contentDocument.querySelector('[data-meo-preview-block]');
  });
  assert.ok(await page.evaluate(() => (window as any).__previewMessages.some((message: any) => message.type === 'requestPreviewRender' && message.window)),
    'large production Preview must request a reading window');
  stage = 'source alignment retains painted content until the destination is ready';
  const pendingProjection = await page.evaluate(async () => {
    const scope = window as any, controller = scope.__previewController;
    const doc = controller.host.querySelector('iframe').contentDocument, scroll = doc.scrollingElement;
    // Let initial overscan finish before delaying the distant source alignment.
    for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    const block = scope.__previewManifest.blocks.find((block: any) => block.sourceLine === 6003).index;
    scope.__projectionGate = { from: block, to: block };
    const before = scroll.scrollTop;
    controller.restoreTopLine(6003);
    for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    const visible = [...doc.querySelectorAll('[data-meo-preview-block]')].some((element: any) => {
      const rect = element.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < doc.defaultView.innerHeight;
    });
    return { before, after: scroll.scrollTop, visible, started: scope.__projectionGate.started };
  });
  assert.ok(pendingProjection.started, 'the alignment must request a genuinely unmounted destination');
  assert.equal(pendingProjection.after, pendingProjection.before, 'alignment must not scroll into an unloaded gap');
  assert.ok(pendingProjection.visible, 'the existing reading window must remain painted while alignment waits');
  await page.evaluate(() => {
    const scope = window as any, gate = scope.__projectionGate;
    scope.__projectionGate = { from: gate.from - 64, to: gate.to + 64 }; gate.release();
  });
  stage = 'destination alignment after prepared blocks';
  await page.waitForFunction(() => {
    const controller = (window as any).__previewController;
    const doc = controller.host.querySelector('iframe').contentDocument;
    const target = doc.querySelector('[data-source-line="6003"]:not([data-meo-preview-gap])')?.getBoundingClientRect();
    return target && target.top < doc.defaultView.innerHeight && target.bottom > 0;
  });
  const destinationPaint = await page.evaluate(async () => {
    const scope = window as any, doc = scope.__previewController.host.querySelector('iframe').contentDocument;
    // Gap measurements may finish after the destination's first paint. Keep
    // it visible on every frame while adjacent blocks are still pending.
    for (let frame = 0; frame < 12; frame++) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      const rect = doc.querySelector('[data-source-line="6003"]:not([data-meo-preview-gap])')?.getBoundingClientRect();
      if (!rect || rect.top >= doc.defaultView.innerHeight || rect.bottom <= 0)
        throw new Error(`Prepared destination left the reading viewport on frame ${frame}: ${JSON.stringify(rect?.toJSON())}`);
    }
    const bottoms = [...doc.querySelectorAll('[data-meo-preview-block]')].map((element: any) => element.getBoundingClientRect().bottom);
    const gate = scope.__projectionGate; scope.__projectionGate = null; gate.release?.();
    return Math.max(...bottoms);
  });
  assert.ok(destinationPaint >= 500, `alignment must prepare the destination reading window, not one isolated paragraph: ${destinationPaint}`);
  stage = 'return from destination alignment';
  await page.evaluate(() => (window as any).__previewController.restoreTopLine(1));
  await page.waitForFunction(() => (window as any).__previewController.readScrollTop() < 100);
  stage = 'superseded source alignment releases its owner';
  await page.evaluate(() => {
    const scope = window as any;
    const block = scope.__previewManifest.blocks.find((block: any) => block.sourceLine === 4003).index;
    scope.__projectionGate = { from: block, to: block };
    scope.__projectionOwner = true;
    scope.__previewController.restoreTopVisiblePosition({ line: 4003, lineOffset: 0 }, () => scope.__projectionOwner);
  });
  await page.waitForFunction(() => (window as any).__projectionGate.started);
  const cancelledProjection = await page.evaluate(async () => {
    const scope = window as any, controller = scope.__previewController, before = controller.readScrollTop();
    scope.__projectionOwner = false;
    const gate = scope.__projectionGate; scope.__projectionGate = null; gate.release();
    for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    return { before, after: controller.readScrollTop() };
  });
  assert.equal(cancelledProjection.after, cancelledProjection.before, 'an async destination must respect the originating alignment owner cancellation');
  stage = 'hiding Preview cancels a pending source alignment';
  await page.evaluate(() => {
    const scope = window as any;
    const block = scope.__previewManifest.blocks.find((block: any) => block.sourceLine === 8003).index;
    scope.__projectionGate = { from: block, to: block };
    scope.__previewController.restoreTopLine(8003);
  });
  await page.waitForFunction(() => (window as any).__projectionGate.started);
  const hiddenProjection = await page.evaluate(async () => {
    const scope = window as any, controller = scope.__previewController;
    const before = controller.readScrollTop(), gate = scope.__projectionGate;
    controller.setVisible(false);
    scope.__projectionGate = null; gate.release();
    for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    controller.setVisible(true);
    for (let frame = 0; frame < 4; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
    return { before, after: controller.readScrollTop() };
  });
  assert.equal(hiddenProjection.after, hiddenProjection.before, 'a late alignment must not move a Preview after switching away and back');
  stage = 'reading window preserves leading whitespace';
  const leadingWhitespace = await page.evaluate(() => {
    const controller = (window as any).__previewController;
    const doc = controller.host.querySelector('iframe').contentDocument;
    const scroll = doc.scrollingElement;
    scroll.scrollTop = 0;
    const first = doc.querySelector('[data-source-line]');
    const padding = first.getBoundingClientRect().top;
    const positions = [0, Math.min(8, padding / 2)].map(top => {
      scroll.scrollTop = top;
      const before = scroll.scrollTop;
      controller.getOutlineAdapter().preserveViewportLayout(() => {});
      return { before, after: scroll.scrollTop };
    });
    return { padding, positions };
  });
  assert.ok(leadingWhitespace.padding > 2, 'the production fixture must expose its leading reading margin');
  for (const position of leadingWhitespace.positions) assert.ok(Math.abs(position.after - position.before) <= 1,
    `a passive layout round trip must preserve document-top whitespace: ${JSON.stringify(leadingWhitespace)}`);
  const productionHeadings = await page.evaluate(() => (window as any).__previewController.getOutlineAdapter().getHeadings());
  assert.equal(productionHeadings.at(-1).text, 'Complete tail', 'outline must include unmounted headings');
  await page.evaluate(() => (window as any).__previewController.getOutlineAdapter().scrollToLine(10003));
  await page.waitForFunction(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const bounds = doc.querySelector('#complete-tail')?.getBoundingClientRect();
    return bounds && bounds.top < doc.defaultView.innerHeight && bounds.bottom > 0;
  });
  await page.evaluate(() => (window as any).__previewController.getSearchAdapter().setSearchQuery('needle-2500', { wholeWord: true }));
  await page.waitForFunction(() => !(window as any).__previewController.getSearchAdapter().isSearchPending());
  assert.equal(await page.evaluate(() => (window as any).__previewController.getSearchAdapter().countMatches('needle-2500', {})), 1);
  await page.evaluate(() => (window as any).__previewController.getSearchAdapter().findNext('needle-2500', { wholeWord: true }));
  await page.waitForFunction(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const element = [...doc.querySelectorAll('strong')].find((node: any) => node.textContent === 'needle-2500');
    const bounds = element?.getBoundingClientRect();
    return bounds && bounds.top < doc.defaultView.innerHeight && bounds.bottom > 0;
  });
  const productionWindow = await page.evaluate(() => {
    const scope = window as any, controller = scope.__previewController;
    return { nodes: controller.host.querySelector('iframe').contentDocument.querySelectorAll('*').length,
      anchor: controller.getSearchAdapter().getSearchAnchor(), errors: scope.__previewBridgeErrors };
  });
  assert.ok(productionWindow.nodes < 2000, `production window retained ${productionWindow.nodes} nodes`);
  assert.deepEqual(productionWindow.errors, []);
  assert.equal(productionWindow.anchor.line, 5003);
  stage = 'production accessibility complete-document route';
  await page.evaluate(() => document.body.classList.add('vscode-using-screen-reader'));
  await page.waitForFunction(() => (window as any).__previewController.host.querySelector('iframe').contentDocument.querySelectorAll('p').length === 5003);
  assert.equal(await page.evaluate(() => (window as any).__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1).window), undefined);
  await page.evaluate(() => document.body.classList.remove('vscode-using-screen-reader'));
  await page.waitForFunction(() => (window as any).__previewController.host.querySelector('iframe').contentDocument.querySelectorAll('p').length < 100);
  await page.evaluate(() => {
    const scope = window as any;
    scope.__previewHostMessage = undefined;
    scope.__previewController.getSearchAdapter().setSearchQuery('');
    scope.__previewController.setVisible(false);
    scope.__previewRenderedAt = undefined;
  });
  for (const parsed of controllerDocuments.values()) parsed.dispose();
  stage = 'complete-DOM scrollbar regression';
  const stableBottom = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:240px;border:0';
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.open(); doc.write('<!doctype html><style>html,body{margin:0}.meo-export-page{height:5000px}</style><main class="meo-export-page">Stable page</main>'); doc.close();
    const controller = (window as any).__createPreviewScrollRange(doc);
    const scroll = doc.scrollingElement!;
    scroll.scrollTop = scroll.scrollHeight - scroll.clientHeight;
    controller.start({ button: 0, pointerId: 31, clientX: frame.contentWindow!.innerWidth - 1, clientY: 20 });
    controller.release(31, scroll.clientHeight - 3);
    const frames = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
    await frames();
    const height = scroll.scrollHeight;
    scroll.scrollTop -= 129;
    await frames();
    const result = { heightUnchanged: scroll.scrollHeight === height, atBottom: scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 2 };
    controller.dispose(); frame.remove();
    return result;
  });
  assert.deepEqual(stableBottom, { heightUnchanged: true, atBottom: true },
    'bottom intent must survive root-scroll correction after the last ResizeObserver delivery');
  const stableTop = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;left:0;top:0;width:320px;height:240px;border:0';
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.open(); doc.write('<!doctype html><style>html,body{margin:0}.meo-export-page{height:5000px}</style><main class="meo-export-page">Stable page</main>'); doc.close();
    const controller = (window as any).__createPreviewScrollRange(doc);
    const scroll = doc.scrollingElement!, page = doc.querySelector<HTMLElement>('.meo-export-page')!;
    const frames = async () => { for (let i = 0; i < 4; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
    scroll.scrollTop = 1_000;
    controller.start({ button: 0, pointerId: 32, clientX: frame.contentWindow!.innerWidth - 1, clientY: scroll.clientHeight - 20 });
    controller.release(32, 3);
    const releasedAtTop = scroll.scrollTop === 0;
    await frames();
    page.style.height = '5200px';
    scroll.scrollTop = 129;
    await frames();
    const correctedAtTop = scroll.scrollTop === 0;
    controller.interrupt();
    scroll.scrollTop = 191;
    await frames();
    const navigationCanLeaveTop = scroll.scrollTop === 191;
    controller.start({ button: 0, pointerId: 33, clientX: frame.contentWindow!.innerWidth - 1, clientY: 3 });
    controller.release(33, 3);
    await frames();
    const arrowIsNotDrag = scroll.scrollTop === 191;
    controller.dispose(); frame.remove();
    return { releasedAtTop, correctedAtTop, navigationCanLeaveTop, arrowIsNotDrag };
  });
  assert.deepEqual(stableTop, { releasedAtTop: true, correctedAtTop: true, navigationCanLeaveTop: true, arrowIsNotDrag: true },
    'top thumb intent must survive estimated layout and root correction, then yield to new navigation without treating arrow clicks as drags');
  const pendingFind = await page.evaluate(() => {
    const scope = window as any, controller = scope.__previewController;
    controller.setVisible(true);
    const before = scope.__previewInteractionCount ?? 0;
    const result = controller.getSearchAdapter().findNext('pending target', {});
    controller.getSearchAdapter().setSearchQuery('');
    return { found: result.found, interactions: (scope.__previewInteractionCount ?? 0) - before };
  });
  assert.deepEqual(pendingFind, { found: false, interactions: 1 },
    'an explicit Find intent must retire old viewport restores even while Preview is preparing its search surface');
  const value = exportRuntime.renderPreviewDocument({ markdownText: text, sourceDocumentPath: 'C:/preview-budget.md', uiLanguage: 'en' });
  await page.evaluate(({ text, value }) => {
    const scope = window as any;
    const controller = scope.__previewController;
    controller.setVisible(true);
    controller.setSourceColoring(false);
    void controller.requestRender(text);
    const message = scope.__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1);
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
  }, { text, value });
  await page.waitForFunction(() => !!(window as any).__previewRenderedAt);
  await new Promise(resolve => setTimeout(resolve, 250));
  const frameBounds = await (await page.$('.preview-frame'))!.boundingBox();
  assert.ok(frameBounds);
  await page.mouse.move(frameBounds.x + 5, frameBounds.y + 50);
  await page.mouse.down();
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await page.evaluate(() => (window as any).__previewController.isViewportInteracting()), true,
    'a held Preview pointer must stay active beyond the wheel idle interval');
  const refreshedText = text + '\n\nRefresh while the pointer is held.\n';
  const refreshedValue = exportRuntime.renderPreviewDocument({ markdownText: refreshedText, sourceDocumentPath: 'C:/preview-budget.md', uiLanguage: 'en' });
  const heldRefresh = await page.evaluate(async ({ text, value }) => {
    const scope = window as any, controller = scope.__previewController;
    const previous = controller.host.querySelector('iframe').contentDocument;
    void controller.requestRender(text, { force: true, preserveFrame: true });
    const message = scope.__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1);
    const accepted = controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { accepted, sameDocument: controller.host.querySelector('iframe').contentDocument === previous, active: controller.isViewportInteracting() };
  }, { text: refreshedText, value: refreshedValue });
  assert.deepEqual(heldRefresh, { accepted: true, sameDocument: true, active: true },
    'a preserved iframe refresh must keep the ongoing pointer gesture');
  await page.mouse.move(0, 0);
  await page.mouse.up();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await page.evaluate(() => (window as any).__previewController.isViewportInteracting()), false,
    'releasing outside the iframe must end its gesture');
  const rangeBefore = await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    doc.scrollingElement.scrollTop = 0;
    const page = doc.querySelector('.meo-export-page');
    page.style.setProperty('overflow', 'visible', 'important');
    return { height: doc.scrollingElement.scrollHeight, scrollbar: doc.defaultView.innerWidth - doc.documentElement.clientWidth };
  });
  assert.ok(rangeBefore.scrollbar > 0, 'this contract must expose the real native scrollbar');
  await page.mouse.move(frameBounds.x + frameBounds.width - rangeBefore.scrollbar / 2, frameBounds.y + 14);
  await page.mouse.down();
  const heldRange = await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const page = doc.querySelector('.meo-export-page');
    doc.querySelector('p[data-source-line]').style.minHeight = '800px';
    return { height: doc.scrollingElement.scrollHeight, held: !!page.style.height };
  });
  assert.deepEqual(heldRange, { height: rangeBefore.height, held: true },
    'a native scrollbar gesture must keep its range while nearby content changes size');
  await page.mouse.move(0, 0);
  await page.mouse.up();
  const releasedRange = await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const page = doc.querySelector('.meo-export-page');
    const result = { height: doc.scrollingElement.scrollHeight, held: !!page.style.height,
      overflow: page.style.getPropertyValue('overflow'), priority: page.style.getPropertyPriority('overflow') };
    doc.querySelector('p[data-source-line]').style.removeProperty('min-height');
    page.style.removeProperty('overflow');
    return result;
  });
  assert.ok(releasedRange.height > rangeBefore.height + 500);
  assert.deepEqual({ ...releasedRange, height: 0 }, { height: 0, held: false, overflow: 'visible', priority: 'important' },
    'releasing outside the iframe must restore authored page styles and its natural range');
  await new Promise(resolve => setTimeout(resolve, 300));
  stage = 'scrollbar bottom ownership';
  await page.mouse.move(frameBounds.x + frameBounds.width - rangeBefore.scrollbar / 2, frameBounds.y + 14);
  await page.mouse.down();
  await page.mouse.move(frameBounds.x + frameBounds.width - rangeBefore.scrollbar / 2, frameBounds.y + frameBounds.height - 3, { steps: 15 });
  await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    // Reproduce the native large-document anchor adjustment just before the
    // release. The user's thumb reached the bottom even when layout moved it.
    doc.scrollingElement.scrollTop = doc.scrollingElement.scrollHeight - doc.scrollingElement.clientHeight - 300;
  });
  await page.mouse.up();
  await page.waitForFunction(() => {
    const scroll = (window as any).__previewController.host.querySelector('iframe').contentDocument.scrollingElement;
    return scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 2;
  });
  await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const addition = doc.createElement('div'); addition.id = 'late-scrollbar-range'; addition.style.height = '900px';
    doc.querySelector('.meo-export-page').appendChild(addition);
  });
  await page.waitForFunction(() => {
    const scroll = (window as any).__previewController.host.querySelector('iframe').contentDocument.scrollingElement;
    return scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 2;
  }, { timeout: 2_000 });
  await page.evaluate(() => {
    const scroll = (window as any).__previewController.host.querySelector('iframe').contentDocument.scrollingElement;
    // Browser anchoring can move the root after ResizeObserver has already
    // delivered the final page size. The drag's bottom intention still owns it.
    scroll.scrollTop -= 129;
  });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await page.evaluate(() => {
    const scroll = (window as any).__previewController.host.querySelector('iframe').contentDocument.scrollingElement;
    return scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 2;
  }), true, 'a later root-scroll adjustment must retain the chosen bottom even without another resize');
  await page.mouse.move(frameBounds.x + frameBounds.width / 2, frameBounds.y + frameBounds.height / 2);
  await page.mouse.wheel({ deltaY: -250 });
  await new Promise(resolve => setTimeout(resolve, 200));
  const wheelTop = await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const top = doc.scrollingElement.scrollTop;
    doc.getElementById('late-scrollbar-range').style.height = '1600px';
    return top;
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.ok(Math.abs(await page.evaluate(() => (window as any).__previewController.host.querySelector('iframe').contentDocument.scrollingElement.scrollTop) - wheelTop) < 3,
    'a later wheel gesture must retire the scrollbar bottom intention');
  await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    doc.getElementById('late-scrollbar-range').remove(); doc.scrollingElement.scrollTop = 0;
  });
  stage = 'viewport query budgets';
  const reads = await page.evaluate(() => {
    const controller = (window as any).__previewController;
    const adapter = controller.getOutlineAdapter();
    const frame = controller.host.querySelector('iframe') as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    const prototype = (frame.contentWindow as any).Element.prototype;
    const rect = prototype.getBoundingClientRect;
    const rects = prototype.getClientRects;
    controller.captureLinkedGeometry();
    let sourceReads = 0;
    prototype.getBoundingClientRect = function() { if (this.hasAttribute('data-source-line')) sourceReads++; return rect.call(this); };
    prototype.getClientRects = function() { if (this.hasAttribute('data-source-line')) sourceReads++; return rects.call(this); };
    try {
      for (let repeat = 0; repeat < 10; repeat++) {
        adapter.getVisibleDocumentRange();
        adapter.getViewportAnchorOffset();
      }
    } finally {
      prototype.getBoundingClientRect = rect;
      prototype.getClientRects = rects;
    }
    return { sourceReads, sources: doc.querySelectorAll('[data-source-line]').length };
  });
  assert.ok(reads.sources > 4_000);
  console.log('Preview repeated viewport reads:', reads);
  assert.ok(reads.sourceReads < 100, 'scroll/outline queries must reuse the measured source index instead of measuring the whole document');
  const resizeReads = await page.evaluate(async () => {
    const frame = (window as any).__previewController.host.querySelector('iframe') as HTMLIFrameElement;
    const doc = frame.contentDocument!, prototype = (frame.contentWindow as any).Element.prototype;
    const rect = prototype.getBoundingClientRect;
    let reads = 0;
    prototype.getBoundingClientRect = function() { if (this.hasAttribute('data-source-line')) reads++; return rect.call(this); };
    try {
      const paragraph = doc.querySelector<HTMLElement>('p[data-source-line]')!;
      for (let step = 1; step <= 4; step++) {
        paragraph.style.minHeight = `${step * 40}px`;
        for (let frame = 0; frame < 3; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
      }
      return reads;
    } finally { prototype.getBoundingClientRect = rect; }
  });
  assert.ok(resizeReads < 100, `resource reflow without a geometry consumer must not measure the entire document: ${resizeReads}`);
  const invalidatedReads = await page.evaluate(() => {
    const controller = (window as any).__previewController;
    const frame = controller.host.querySelector('iframe') as HTMLIFrameElement;
    const prototype = (frame.contentWindow as any).Element.prototype, original = prototype.getBoundingClientRect;
    let reads = 0;
    prototype.getBoundingClientRect = function() { if (this.hasAttribute('data-source-line')) reads++; return original.call(this); };
    try { controller.getTopVisiblePosition(); controller.getOutlineAdapter().getVisibleDocumentRange(); return reads; }
    finally { prototype.getBoundingClientRect = original; }
  });
  assert.ok(invalidatedReads < 200, `a reading query after resource reflow must measure local blocks (${invalidatedReads} reads)`);
  const restored = await page.evaluate(() => {
    const controller = (window as any).__previewController;
    const frame = controller.host.querySelector('iframe') as HTMLIFrameElement;
    const doc = frame.contentDocument!, scroller = doc.scrollingElement!;
    const target = doc.querySelectorAll<HTMLElement>('p[data-source-line]')[1_400];
    scroller.scrollTop += target.getBoundingClientRect().top + 5;
    controller.captureLinkedGeometry();
    const before = controller.getTopVisiblePosition();
    const anchor = [...doc.querySelectorAll<HTMLElement>('[data-source-line]')]
      .find(element => Number(element.dataset.sourceLine) === before.sourceRange.startLine)!;
    const offset = anchor.getBoundingClientRect().top;
    const prototype = (frame.contentWindow as any).Element.prototype, rect = prototype.getBoundingClientRect;
    let reads = 0;
    prototype.getBoundingClientRect = function() { if (this.hasAttribute('data-source-line')) reads++; return rect.call(this); };
    try {
      controller.getOutlineAdapter().preserveViewportLayout(() => {
        doc.querySelector<HTMLElement>('p[data-source-line]')!.style.minHeight = '400px';
        controller.refreshLayout();
      });
      return { reads, drift: Math.abs(anchor.getBoundingClientRect().top - offset) };
    } finally { prototype.getBoundingClientRect = rect; }
  });
  assert.ok(restored.reads < 100, `restoring a known resource reading anchor must measure its range instead of every block: ${restored.reads}`);
  assert.ok(restored.drift < 1, `resource layout must preserve the painted reading anchor: ${restored.drift}`);
  for (const position of [0, 0.53, 1]) {
    const result = await page.evaluate(position => {
      const controller = (window as any).__previewController;
      const frame = controller.host.querySelector('iframe') as HTMLIFrameElement;
      const doc = frame.contentDocument!;
      const scroller = doc.scrollingElement!;
      scroller.scrollTop = position * (scroller.scrollHeight - scroller.clientHeight);
      const height = frame.contentWindow!.innerHeight;
      const rendered = Array.from(doc.querySelectorAll<HTMLElement>('[data-source-line]'))
        .filter(element => element.getClientRects().length)
        .map(element => {
          const rect = element.getBoundingClientRect();
          return { start: Number(element.dataset.sourceLine), top: rect.top, bottom: rect.bottom };
        });
      const visible = rendered.filter(entry => entry.bottom > entry.top && entry.bottom > 0 && entry.top < height);
      const lines = visible.map(entry => entry.start);
      const anchors = rendered.filter(entry => entry.top <= height * 0.2)
        .sort((a, b) => a.top - b.top || a.bottom - b.bottom || a.start - b.start);
      const adapter = controller.getOutlineAdapter();
      return { actual: adapter.getVisibleDocumentRange(), anchor: adapter.getViewportAnchorOffset(),
        expected: { from: Math.min(...lines), to: Math.max(...lines), fromLine: Math.min(...lines), toLine: Math.max(...lines) },
        expectedAnchor: anchors.at(-1)?.start ?? 1 };
    }, position);
    assert.deepEqual(result.actual, result.expected, `visible source range at ${position}`);
    assert.equal(result.anchor, result.expectedAnchor, `visual anchor at ${position}, including relocated footnotes`);
  }
  const hidden = await page.evaluate(() => {
    const controller = (window as any).__previewController;
    controller.setVisible(false);
    return controller.getOutlineAdapter().getVisibleDocumentRange();
  });
  assert.deepEqual(hidden, { from: 1, to: 1, fromLine: 1, toLine: 1 });
  const noteText = 'References: ' + Array.from({ length: 150 }, (_, index) => `[^dense-${index}]`).join(' ') + '\n\n'
    + 'Ordinary paragraph.\n\n'.repeat(4_100)
    + Array.from({ length: 150 }, (_, index) => `[^dense-${index}]: Note ${index}.\n\n    Continued paragraph.\n\n`).join('');
  const noteValue = exportRuntime.renderPreviewDocument({ markdownText: noteText, sourceDocumentPath: 'C:/preview-notes.md', uiLanguage: 'en' });
  await page.evaluate(({ text, value }) => {
    const scope = window as any, controller = scope.__previewController;
    scope.__previewRenderedAt = 0; controller.setVisible(true);
    void controller.requestRender(text);
    const message = scope.__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1);
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
  }, { text: noteText, value: noteValue });
  await page.waitForFunction(() => !!(window as any).__previewRenderedAt);
  await page.evaluate(async () => {
    const controller = (window as any).__previewController, doc = controller.host.querySelector('iframe').contentDocument;
    const target = [...doc.querySelectorAll('.footnote-item')].at(-1) as HTMLElement;
    controller.getOutlineAdapter().scrollToLine(Number(target.dataset.sourceLine));
    for (let frame = 0; frame < 14; frame++) await new Promise(resolve => requestAnimationFrame(resolve));
  });
  const noteReads = await page.evaluate(() => {
    const controller = (window as any).__previewController, frame = controller.host.querySelector('iframe');
    const prototype = frame.contentWindow.Element.prototype, original = prototype.getBoundingClientRect;
    let reads = 0;
    prototype.getBoundingClientRect = function() { if (this.hasAttribute('data-source-line')) reads++; return original.call(this); };
    try { controller.refreshLayout(); controller.getTopVisiblePosition(); controller.getOutlineAdapter().getVisibleDocumentRange(); return reads; }
    finally { prototype.getBoundingClientRect = original; }
  });
  assert.ok(noteReads < 120, `a reading band inside the footnote list must not measure every distant note (${noteReads} reads)`);
  const codeText = Array.from({ length: 600 }, (_, index) => `\`\`\`js\nconst value = ${index};\n\`\`\`\n\n`).join('')
    + 'Ordinary paragraph.\n\n'.repeat(4_100);
  const codeValue = exportRuntime.renderPreviewDocument({ markdownText: codeText, sourceDocumentPath: 'C:/preview-code-budget.md', uiLanguage: 'en' });
  await page.evaluate(({ text, value }) => {
    const scope = window as any, controller = scope.__previewController;
    const frame = controller.host.querySelector('iframe') as HTMLIFrameElement;
    scope.__typographyReads = 0;
    scope.__typographyWindows = [];
    const instrument = () => {
      const win = frame.contentWindow as any;
      if (scope.__typographyWindows.some((probe: any) => probe.wrapper === win.getComputedStyle)) return;
      const original = win.getComputedStyle.bind(win);
      const wrapper = (element: Element, pseudo?: string) => {
        if (element.matches('.meo-export-code-line')) scope.__typographyReads++;
        return original(element, pseudo);
      };
      scope.__typographyWindows.push({ win, original, wrapper });
      win.getComputedStyle = wrapper;
    };
    scope.__typographyLoad = instrument;
    frame.addEventListener('load', instrument);
    instrument();
    scope.__previewRenderedAt = 0;
    controller.setVisible(true);
    controller.setSourceColoring(true);
    void controller.requestRender(text);
    const message = scope.__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1);
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
  }, { text: codeText, value: codeValue });
  await page.waitForFunction(() => !!(window as any).__previewRenderedAt);
  await page.evaluate(() => { (window as any).__previewController.host.querySelector('iframe').contentDocument.scrollingElement.scrollTop = 0; });
  await new Promise(resolve => setTimeout(resolve, 150));
  const typographyReads = await page.evaluate(() => {
    const scope = window as any;
    scope.__previewController.host.querySelector('iframe').removeEventListener('load', scope.__typographyLoad);
    for (const probe of scope.__typographyWindows) {
      if (probe.win.getComputedStyle === probe.wrapper) probe.win.getComputedStyle = probe.original;
    }
    return scope.__typographyReads;
  });
  console.log('Preview initial code typography reads:', typographyReads);
  assert.ok(typographyReads > 0 && typographyReads < 200, `initial large Preview must check nearby code typography instead of every source line (${typographyReads} reads)`);
  const initialCopyControls = await page.evaluate(() => (window as any).__previewController.host
    .querySelector('iframe').contentDocument.querySelectorAll('.meo-preview-code-actions').length);
  assert.ok(initialCopyControls > 0 && initialCopyControls < 200,
    `initial large Preview must only mount nearby reading controls (${initialCopyControls} controls)`);
  const copyPointer = await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const bounds = doc.querySelector('.meo-copy-code-btn').getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  });
  await page.mouse.move(frameBounds.x + copyPointer.x, frameBounds.y + copyPointer.y);
  await page.mouse.down();
  await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const target = doc.querySelectorAll('code.hljs')[580];
    target.dataset.typographyBudgetTarget = 'true';
    const style = doc.createElement('style');
    style.textContent = 'code[data-typography-budget-target] .meo-export-code-line{font-size:0;line-height:0}';
    doc.head.appendChild(style);
    (window as any).__previewController.getOutlineAdapter().scrollToLine(Number(target.closest('[data-source-line]')?.getAttribute('data-source-line')));
  });
  stage = 'deferred typography and copy controls';
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    return !!doc.querySelector('code[data-typography-budget-target]')?.closest('.meo-export-code-block-wrap')?.querySelector('.meo-copy-code-btn');
  }), false, 'background controls must wait while a native pointer gesture owns Preview');
  await page.mouse.move(0, 0);
  await page.mouse.up();
  try { await page.waitForFunction(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const line = doc.querySelector('code[data-typography-budget-target] .meo-export-code-line');
    return line && Number.parseFloat(doc.defaultView.getComputedStyle(line).fontSize) > 0 && line.getBoundingClientRect().height > 0
      && doc.querySelector('code[data-typography-budget-target]')?.closest('.meo-export-code-block-wrap')?.querySelector('.meo-copy-code-btn');
  }, { timeout: 5_000 }); } catch (error) {
    console.error('Distant typography state:', await page.evaluate(() => {
      const controller = (window as any).__previewController, doc = controller.host.querySelector('iframe').contentDocument;
      const code = doc.querySelector('code[data-typography-budget-target]'), line = code?.querySelector('.meo-export-code-line');
      return { interacting: controller.isViewportInteracting(), top: doc.scrollingElement.scrollTop,
        pageHeight: doc.querySelector('.meo-export-page').style.height,
        codeBounds: code?.getBoundingClientRect().toJSON(), lineBounds: line?.getBoundingClientRect().toJSON(),
        font: line && doc.defaultView.getComputedStyle(line).fontSize,
        copy: !!code?.closest('.meo-export-code-block-wrap')?.querySelector('.meo-copy-code-btn') };
    }));
    throw error;
  }
  stage = 'distant code clipboard';
  await page.evaluate(() => {
    const scope = window as any;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText(text: string) { scope.__budgetCopied = text; }
    } });
    const doc = scope.__previewController.host.querySelector('iframe').contentDocument;
    scope.__budgetCopyButton = doc.querySelector('code[data-typography-budget-target]')
      .closest('.meo-export-code-block-wrap').querySelector('.meo-copy-code-btn');
    scope.__budgetCopyButton.click();
  });
  await page.waitForFunction(() => (window as any).__budgetCopied === 'const value = 580;');
  const updatedCodeText = codeText + '\nUpdated final paragraph.\n';
  const updatedCodeValue = exportRuntime.renderPreviewDocument({ markdownText: updatedCodeText, sourceDocumentPath: 'C:/preview-code-budget.md', uiLanguage: 'en' });
  await page.evaluate(({ text, value }) => {
    const scope = window as any, controller = scope.__previewController;
    scope.__previewRenderedAt = 0;
    void controller.requestRender(text, { force: true, preserveFrame: true });
    const message = scope.__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1);
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
  }, { text: updatedCodeText, value: updatedCodeValue });
  await page.waitForFunction(() => !!(window as any).__previewRenderedAt);
  stage = 'retained code clipboard';
  const retainedCopyButton = await page.evaluate(() => {
    const scope = window as any, doc = scope.__previewController.host.querySelector('iframe').contentDocument;
    const button = doc.querySelectorAll('code.hljs')[580].closest('.meo-export-code-block-wrap').querySelector('.meo-copy-code-btn');
    scope.__budgetCopied = null;
    button.click();
    return button === scope.__budgetCopyButton;
  });
  assert.equal(retainedCopyButton, true, 'preserved iframe updates must retain mounted controls and their event handlers');
  await page.waitForFunction(() => (window as any).__budgetCopied === 'const value = 580;');
  const scrollingReads = await page.evaluate(async () => {
    const frame = (window as any).__previewController.host.querySelector('iframe') as HTMLIFrameElement;
    const doc = frame.contentDocument!, prototype = (frame.contentWindow as any).Element.prototype;
    const rect = prototype.getBoundingClientRect;
    let codeReads = 0;
    prototype.getBoundingClientRect = function() { if (this.matches('code.hljs')) codeReads++; return rect.call(this); };
    try {
      for (let repeat = 0; repeat < 8; repeat++) {
        doc.scrollingElement!.scrollTop += 120;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      }
      return { codeReads, codes: doc.querySelectorAll('code.hljs').length };
    } finally { prototype.getBoundingClientRect = rect; }
  });
  console.log('Preview scrolling code reads:', scrollingReads);
  assert.equal(scrollingReads.codes, 600);
  assert.ok(scrollingReads.codeReads < 500, 'scrolling must inspect nearby code resources instead of all code blocks on every frame');
  await page.addScriptTag({ path: 'node_modules/mermaid/dist/mermaid.min.js' });
  const diagramText = ('```mermaid\nflowchart LR\n A --> B\n```\n\n' + 'Ordinary paragraph.\n\n'.repeat(1_500)).repeat(3);
  const diagramValue = exportRuntime.renderPreviewDocument({ markdownText: diagramText, sourceDocumentPath: 'C:/preview-diagram-budget.md', uiLanguage: 'en' });
  await page.evaluate(({ text, value }) => {
    const scope = window as any, controller = scope.__previewController;
    scope.__previewRenderedAt = 0;
    controller.setSourceColoring(false);
    void controller.requestRender(text);
    const message = scope.__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1);
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
  }, { text: diagramText, value: diagramValue });
  await page.waitForFunction(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    return !!doc.querySelector('.meo-export-mermaid.is-rendered svg[id]');
  });
  await page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const last = [...doc.querySelectorAll('.meo-export-mermaid')].at(-1) as HTMLElement;
    (window as any).__previewController.getOutlineAdapter().scrollToLine(Number(last.dataset.sourceLine));
  });
  await page.waitForFunction(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    return doc.querySelectorAll('.meo-export-mermaid.is-rendered svg[id]').length === 2;
  });
  const diagramIds = await page.evaluate(() => [...(window as any).__previewController.host.querySelector('iframe').contentDocument
    .querySelectorAll('.meo-export-mermaid.is-rendered > .meo-export-mermaid-svg > svg[id]')].map((svg: any) => svg.id));
  assert.equal(new Set(diagramIds).size, 2, 'identical diagrams entering the viewport at different times must retain distinct SVG identities');
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).__previewController.dispose());
  stage = 'streaming parser equivalence and cancellation';
  const mathValue = exportRuntime.renderPreviewDocument({ markdownText: '$$\n\\frac{x^2+1}{y}=\\sqrt{z}\n$$\n\n| A | B |\n| --- | --- |\n| **bold** | $a+b$ |', sourceDocumentPath: 'C:/parser.md', uiLanguage: 'en' });
  const parserResult = await page.evaluate(async html => {
    const write = (window as any).__writePreviewFrame;
    const expected = document.createElement('main'); expected.innerHTML = html;
    const frame = document.createElement('iframe'); document.body.append(frame);
    let stale = 0, current = 0, frames = 0, running = true, incompleteLayouts = 0;
    const tick = () => {
      if (running) {
        frames++;
        const body = frame.contentDocument?.body;
        if (!current && body && body.getBoundingClientRect().height > 0) incompleteLayouts++;
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
    const header = '<!doctype html><html><body style="display:block!important;color:red"><main>', footer = '</main></body></html>';
    const cancel = write(frame, header, '<p>Cancelled document</p>' + html, footer, () => true, () => { stale++; });
    cancel();
    const cancelledDisplay = frame.contentDocument!.body.style.getPropertyValue('display');
    let cancelCurrent: () => void;
    await new Promise<void>(resolve => {
      cancelCurrent = write(frame, header, html, footer, () => true, () => { current++; resolve(); });
      cancel(); // An old cancellation must remain inert after the next document starts.
    });
    running = false;
    const body = frame.contentDocument!.body;
    const result = {
      equal: frame.contentDocument!.querySelector('main')!.innerHTML === expected.innerHTML,
      stale, current, frames, incompleteLayouts, cancelledDisplay,
      display: body.style.getPropertyValue('display'), priority: body.style.getPropertyPriority('display'),
      color: body.style.color, visibleHeight: body.getBoundingClientRect().height
    };
    cancelCurrent!(); frame.remove();
    return result;
  }, '<p>' + 'x'.repeat(32_764) + '😀 &amp; 中文</p>' + codeValue.html + mathValue.html);
  assert.equal(parserResult.equal, true, 'chunk boundaries must preserve UTF-16 pairs, entities, code, tables and MathML exactly');
  assert.equal(parserResult.stale, 0, 'cancelled parser work must never publish an older presentation');
  assert.equal(parserResult.current, 1, 'the current parser must publish ready exactly once');
  assert.ok(parserResult.frames > 0, 'large HTML parsing must yield to animation frames');
  assert.equal(parserResult.incompleteLayouts, 0, 'growing HTML prefixes must not repeatedly participate in page layout');
  assert.equal(parserResult.cancelledDisplay, 'block', 'cancelling a partial document must release its temporary layout hold');
  assert.deepEqual([parserResult.display, parserResult.priority, parserResult.color], ['block', 'important', 'red'],
    'ready presentation must restore authored body styles exactly');
  assert.ok(parserResult.visibleHeight > 0, 'the complete document must enter normal layout before ready is published');
  console.log('Preview viewport source index, visual footnote order and hidden surface budget passed');
} catch (error) {
  console.error('Preview viewport budget failed during:', stage);
  primaryError = error;
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
