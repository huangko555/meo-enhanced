import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-links-'));
const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts', 'test-preview-mermaid-runtime-entry.ts')],
  outdir: tempDir,
  target: 'browser',
  format: 'iife',
  external: ['mermaid']
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><style>.preview-dropdown-panel { position: fixed; }</style><body></body>');
  await page.addScriptTag({ path: path.join(tempDir, 'test-preview-mermaid-runtime-entry.js') });
  const stalePreload = await page.evaluate(async () => {
    const controller = (window as any).__previewController;
    (window as any).__previewCurrentText = 'edited text';
    controller.preload('original text');
    const requestId = (window as any).__previewMessages.findLast((message: any) => message.type === 'requestPreviewRender').requestId;
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId,
      result: { ok: true, value: { hasMermaid: false, styles: { dark: '', light: '' }, html: '<p>Obsolete preload</p>' } } });
    await Promise.resolve();
    const srcdoc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.srcdoc;
    (window as any).__previewCurrentText = 'promoted text';
    controller.preload('promoted text');
    controller.setVisible(true);
    const promotedId = (window as any).__previewMessages.findLast((message: any) => message.type === 'requestPreviewRender').requestId;
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: promotedId,
      result: { ok: true, value: { hasMermaid: false, styles: { dark: '', light: '' }, html: '<p>Promoted preload</p>' } } });
    await Promise.resolve();
    const promoted = document.querySelector<HTMLIFrameElement>('.preview-frame')!.srcdoc.includes('Promoted preload');
    controller.setVisible(false);
    delete (window as any).__previewCurrentText;
    return { srcdoc, promoted };
  });
  if (stalePreload.srcdoc) throw new Error('Obsolete background preload must not start iframe layout');
  if (!stalePreload.promoted) throw new Error('Promoted preload must complete after Preview becomes visible');
  await page.evaluate(() => {
    const controller = (window as any).__previewController;
    document.body.prepend(controller.appearanceControl);
    const messages = (window as any).__previewMessages as Array<{ type?: string; requestId?: string }>;
    const html = [
      '<div class="meo-export-doc">',
      '<p id="plain">Plain preview text</p>',
      '<a id="external" href="https://example.com/">External</a>',
      '<a id="ticket" href="https://docs.example.com/issues">Ticket</a>',
      '<a id="theme" href="./CONTRIBUTING.md">Guide</a>',
      '<a id="changelog" href="CHANGELOG.md">Changelog</a>',
      '<a id="license" href="LICENSE">License</a>',
      '<a id="fragment" href="#target">Fragment</a>',
      '<h2 id="target">Target</h2>',
      '</div>'
    ].join('');
    (window as any).__previewLinkHtml = html;
    for (let round = 0; round < 3; round += 1) {
      controller.preload(`README links ${round}`);
      const requestId = messages.findLast((message) => message.type === 'requestPreviewRender')?.requestId;
      controller.acceptRenderResponse({
        type: 'previewRenderResult',
        requestId,
        result: { ok: true, value: { hasMermaid: false, styles: { dark: '', light: '' }, html } }
      });
    }
    controller.setVisible(true);
  });
  await page.waitForFunction(() => Boolean(
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.getElementById('license')
    && document.querySelector<HTMLIFrameElement>('.preview-frame')?.style.visibility !== 'hidden'
  ));
  await page.evaluate(() => {
    (window as any).__loadedPreviewDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument;
  });
  // Exercise completed-document refreshes, not only superseded pending requests.
  for (let round = 0; round < 2; round += 1) {
    await page.evaluate(round => {
      const controller = (window as any).__previewController;
      controller.requestRender(`refreshed links ${round}`);
      const requestId = (window as any).__previewMessages.findLast((message: any) => message.type === 'requestPreviewRender').requestId;
      controller.acceptRenderResponse({ type: 'previewRenderResult', requestId,
        result: { ok: true, value: { hasMermaid: false, styles: { dark: '', light: '' },
          html: (window as any).__previewLinkHtml + `<span id="refresh-${round}"></span>` } } });
    }, round);
    await page.waitForFunction(round => Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.getElementById(`refresh-${round}`)), {}, round);
    if (!await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument === (window as any).__loadedPreviewDocument)) {
      throw new Error('Preview refresh must reuse the loaded document');
    }
  }
  await page.click('.preview-appearance-dropdown');
  await page.click('.preview-appearance-dropdown-panel [data-value="dark"]');
  if (!await page.evaluate(() =>
    document.querySelector<HTMLSelectElement>('.preview-appearance-select')?.value === 'dark'
    && document.querySelector('.preview-appearance-dropdown')?.getAttribute('aria-expanded') === 'false'
  )) throw new Error('Clicking a dropdown option did not select and close it');
  // Use real pointer input: DOM click() bypasses the outside-pointer dismissal contract.
  for (const targetId of ['plain', 'fragment']) {
    await page.click('.preview-appearance-dropdown');
    if (!await page.evaluate(() =>
      document.querySelector('.preview-appearance-dropdown')?.getAttribute('aria-expanded') === 'true'
    )) throw new Error('Preview dropdown did not open');
    const point = await page.evaluate((id) => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const target = frame.contentDocument!.getElementById(id)!;
      target.scrollIntoView();
      const frameRect = frame.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      return { x: frameRect.left + rect.left + 8, y: frameRect.top + rect.top + 8 };
    }, targetId);
    await page.mouse.click(point.x, point.y);
    if (!await page.evaluate(() =>
      document.querySelector('.preview-appearance-dropdown')?.getAttribute('aria-expanded') === 'false'
    )) throw new Error(`Preview ${targetId} click did not dismiss the dropdown`);
  }
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!.scrollTo(0, 0);
  });
  const clickPoint = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const link = frame.contentDocument!.getElementById('changelog')!;
    const frameRect = frame.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    return {
      x: frameRect.left + linkRect.left + linkRect.width / 2,
      y: frameRect.top + linkRect.top + linkRect.height / 2
    };
  });
  await page.evaluate(() => {
    ((window as any).__previewMessages as unknown[]).length = 0;
  });
  await page.click('.preview-appearance-dropdown');
  await page.mouse.click(clickPoint.x, clickPoint.y);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const trustedClickResult = await page.evaluate(() => {
    const messages = (window as any).__previewMessages as Array<{
      type?: string;
      href?: string;
      source?: string;
    }>;
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const link = frame.contentDocument?.getElementById('changelog') as HTMLAnchorElement | null;
    return {
      dropdownClosed: document.querySelector('.preview-appearance-dropdown')?.getAttribute('aria-expanded') === 'false',
      messages: messages.map(({ type, href, source }) => ({ type, href, source })),
      documentPresent: Boolean(frame.contentDocument?.querySelector('.meo-export-doc')),
      nativeHref: link?.getAttribute('href') ?? null,
      brokeredHref: link?.dataset.meoPreviewHref ?? null,
      role: link?.getAttribute('role') ?? null,
      tabIndex: link?.tabIndex ?? -1,
      cursor: link ? frame.contentWindow?.getComputedStyle(link).cursor ?? null : null
    };
  });
  if (
    !trustedClickResult.dropdownClosed ||
    trustedClickResult.messages.length !== 1 ||
    trustedClickResult.messages[0]?.type !== 'openLink' ||
    trustedClickResult.messages[0]?.href !== 'CHANGELOG.md' ||
    trustedClickResult.messages[0]?.source !== 'preview' ||
    !trustedClickResult.documentPresent ||
    trustedClickResult.nativeHref !== null ||
    trustedClickResult.brokeredHref !== 'CHANGELOG.md' ||
    trustedClickResult.role !== 'link' ||
    trustedClickResult.tabIndex !== 0 ||
    trustedClickResult.cursor !== 'pointer'
  ) {
    throw new Error(`Trusted Preview link click was not intercepted: ${JSON.stringify(trustedClickResult)}`);
  }

  const modifiedClickPoint = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const link = frame.contentDocument!.getElementById('external')!;
    const frameRect = frame.getBoundingClientRect();
    const linkRect = link.getBoundingClientRect();
    ((window as any).__previewMessages as unknown[]).length = 0;
    return {
      x: frameRect.left + linkRect.left + linkRect.width / 2,
      y: frameRect.top + linkRect.top + linkRect.height / 2
    };
  });
  await page.keyboard.down('Control');
  await page.mouse.click(modifiedClickPoint.x, modifiedClickPoint.y);
  await page.keyboard.up('Control');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const modifiedClickResult = await page.evaluate(() => ({
    messages: (window as any).__previewMessages,
    documentPresent: Boolean(
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-export-doc')
    )
  }));
  if (
    modifiedClickResult.messages.length !== 1 ||
    modifiedClickResult.messages[0]?.href !== 'https://example.com/' ||
    modifiedClickResult.messages[0]?.source !== 'preview' ||
    !modifiedClickResult.documentPresent
  ) {
    throw new Error(`Modified Preview link click was not intercepted: ${JSON.stringify(modifiedClickResult)}`);
  }

  const result = await page.evaluate(async () => {
    const messages = (window as any).__previewMessages as Array<{
      type?: string;
      href?: string;
      source?: string;
    }>;
    messages.length = 0;
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const frameDocument = frame.contentDocument!;
    for (const id of ['external', 'ticket', 'theme', 'changelog', 'license', 'fragment']) {
      frameDocument.getElementById(id)!.click();
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    return {
      messages: messages.map(({ type, href, source }) => ({ type, href, source })),
      documentPresent: Boolean(frame.contentDocument?.querySelector('.meo-export-doc')),
      linkCount: frame.contentDocument?.querySelectorAll('a').length ?? 0
    };
  });
  const expectedHrefs = [
    'https://example.com/',
    'https://docs.example.com/issues',
    './CONTRIBUTING.md',
    'CHANGELOG.md',
    'LICENSE'
  ];
  const actualHrefs = result.messages
    .filter((message) => message.type === 'openLink')
    .map((message) => message.href);
  const previewSources = result.messages
    .filter((message) => message.type === 'openLink')
    .map((message) => message.source);
  if (
    JSON.stringify(actualHrefs) !== JSON.stringify(expectedHrefs) ||
    previewSources.some((source) => source !== 'preview') ||
    !result.documentPresent ||
    result.linkCount !== 6
  ) {
    throw new Error(`Preview link click routing was inconsistent: ${JSON.stringify(result)}`);
  }
  const wheel = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    doc.body.style.minHeight = '2000px';
    const scroller = doc.scrollingElement!;
    scroller.scrollTop = 0;
    doc.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 }));
    const afterRefresh = scroller.scrollTop;
    (window as any).__previewController.dispose();
    ((window as any).__previewMessages as unknown[]).length = 0;
    doc.getElementById('external')!.click();
    doc.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 }));
    return { afterRefresh, afterDispose: scroller.scrollTop, messages: (window as any).__previewMessages.length };
  });
  if (wheel.afterRefresh !== 40 || wheel.afterDispose !== 40 || wheel.messages !== 0) {
    throw new Error(`Refreshed or disposed Preview retained duplicate listeners: ${JSON.stringify(wheel)}`);
  }
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('Preview link checks passed');
