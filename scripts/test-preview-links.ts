import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-links-'));
const entryPath = path.join(tempDir, 'entry.ts');
fs.writeFileSync(entryPath, `
import ${JSON.stringify(path.join(repoRoot, 'scripts', 'test-preview-mermaid-runtime-entry.ts'))};
import { bindTooltips } from ${JSON.stringify(path.join(repoRoot, 'webview', 'src', 'adapters', 'tooltip.ts'))};
bindTooltips(document.body);
`);
const build = await Bun.build({
  entrypoints: [entryPath],
  outdir: tempDir,
  target: 'browser',
  format: 'iife',
  naming: 'bundle.js',
  external: ['mermaid']
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><style>html,body{height:100%;margin:0}body{display:flex;flex-direction:column}.preview-host{flex:1;min-height:0}</style><body></body>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
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
  // Use the actual Host renderer: hand-written <a href> fixtures miss paths
  // removed by Markdown parsing or sanitization before iframe binding.
  for (const preset of ['default', 'github-readme', 'whitey', 'newsprint', 'obsidian-minimal'] as const) {
    const payload = exportRuntime.renderPreviewDocument({
      markdownText: '[Absolute file](<D:\\notes\\link target.md>)\n\n[Document](./guide.md#target)\n\n[Reference][guide]\n\n[guide]: ./guide.md#target\n\n<a href="./guide.md#target">HTML</a>\n\n[[guide#target|Wiki]]',
      sourceDocumentPath: 'C:/notes/current.md', uiLanguage: 'en', preset
    });
    await page.evaluate(({ preset, payload }) => {
      const controller = (window as any).__previewController;
      controller.setPreset(preset);
      controller.requestRender('absolute file fixture');
      const requestId = (window as any).__previewMessages.findLast((message: any) => message.type === 'requestPreviewRender').requestId;
      controller.acceptRenderResponse({ type: 'previewRenderResult', requestId, result: { ok: true, value: payload } });
      controller.setVisible(true);
    }, { preset, payload });
    await page.waitForFunction(preset => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
      return frame?.contentDocument?.documentElement.dataset.meoPreviewPreset === preset
        && frame.contentDocument.querySelector('a[data-meo-preview-href]')?.textContent === 'Absolute file';
    }, {}, preset);
    const point = await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!, doc = frame.contentDocument!;
      const link = doc.querySelector<HTMLAnchorElement>('a[data-meo-preview-href]')!, box = link.getBoundingClientRect(), frameBox = frame.getBoundingClientRect();
      (window as any).__previewMessages.length = 0;
      return { x: frameBox.left + box.left + box.width / 2, y: frameBox.top + box.top + box.height / 2,
        cursor: doc.defaultView!.getComputedStyle(link).cursor };
    });
    if (point.cursor !== 'pointer') throw new Error(`${preset}: absolute file link has no pointer`);
    await page.mouse.move(0, 0);
    await page.mouse.move(point.x, point.y);
    try {
      await page.waitForFunction(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
        return doc?.querySelector('.meo-tooltip.is-visible .meo-tooltip-label')?.textContent === 'Go to: file:///D:/notes/link target.md';
      }, { timeout: 5000 });
    } catch (error) {
      const hint = await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        return { text: doc.querySelector('.meo-tooltip-label')?.textContent,
          classes: doc.querySelector('.meo-tooltip')?.className,
          hovered: doc.querySelector('a')?.matches(':hover'), styles: doc.querySelectorAll('[data-meo-tooltip-style]').length };
      });
      throw new Error(`${preset}: absolute file hover hint missing: ${JSON.stringify(hint)}`, { cause: error });
    }
    await page.mouse.click(point.x, point.y);
    const opened = await page.evaluate(() => (window as any).__previewMessages.filter((message: any) => message.type === 'openLink'));
    if (opened.length !== 1 || opened[0].href !== 'file:///D:/notes/link%20target.md' || opened[0].source !== 'preview') {
      throw new Error(`${preset}: absolute file navigation differs from shared normalization: ${JSON.stringify(opened)}`);
    }
    for (const label of ['Document', 'Reference', 'HTML', ...(preset === 'github-readme' ? [] : ['Wiki'])]) {
      for (const modified of [false, true]) {
        const point = await page.evaluate(label => {
          const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
          const link = [...frame.contentDocument!.querySelectorAll('a[data-meo-preview-href]')].find(link => link.textContent === label)!;
          const rect = link.getBoundingClientRect(), outer = frame.getBoundingClientRect();
          (window as any).__previewMessages.length = 0;
          return { x: outer.left + rect.left + rect.width / 2, y: outer.top + rect.top + rect.height / 2 };
        }, label);
        if (modified) await page.keyboard.down('Control');
        await page.mouse.click(point.x, point.y);
        if (modified) await page.keyboard.up('Control');
        const messages = await page.evaluate(() => (window as any).__previewMessages.filter((message: any) => message.type === 'openLink'));
        const href = label === 'Wiki' ? 'meo-wiki:guide%23target' : './guide.md#target';
        if (messages.length !== 1 || messages[0].href !== href || messages[0].source !== 'preview') {
          throw new Error(`${preset}: ${label} modified=${modified}: ${JSON.stringify(messages)}`);
        }
      }
    }
  }
  await page.evaluate(() => {
    const controller = (window as any).__previewController;
    controller.setVisible(false); controller.setPreset('default');
  });
  await page.evaluate(() => {
    const controller = (window as any).__previewController;
    document.body.prepend(controller.appearanceControl, controller.fontFamilyControl);
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
  await page.click('[data-preview-appearance-choice="dark"]');
  await page.click('.preview-font-family-dropdown');
  const selectedFont = await page.$eval('.preview-font-family-dropdown-panel .preview-dropdown-option:nth-child(2)', option => (option as HTMLElement).dataset.value);
  await page.click('.preview-font-family-dropdown-panel .preview-dropdown-option:nth-child(2)');
  if (!await page.evaluate(selectedFont =>
    document.querySelector<HTMLSelectElement>('.preview-appearance-select')?.value === 'dark'
    && document.querySelector<HTMLSelectElement>('.preview-font-family-select')?.value === selectedFont
    && document.querySelector('.preview-font-family-dropdown')?.getAttribute('aria-expanded') === 'true',
    selectedFont
  )) throw new Error('Preview controls did not select and keep font comparison open');
  await page.keyboard.press('Escape');
  if (!await page.evaluate(() => document.querySelector('.preview-font-family-dropdown')?.getAttribute('aria-expanded') === 'false')) {
    throw new Error('Escape did not close the font comparison');
  }
  await page.evaluate(() => {
    // Keep this fixture's pointer targets below the font popup rather than clicking covered text.
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!
      .querySelector<HTMLElement>('.meo-export-doc')!.style.paddingTop = '320px';
  });
  // Use real pointer input: DOM click() bypasses the outside-pointer dismissal contract.
  const previewPointerPoint = (id: string) => page.evaluate(id => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const target = frame.contentDocument!.getElementById(id)!;
    target.scrollIntoView({ block: 'nearest' });
    const frameRect = frame.getBoundingClientRect();
    const rect = target.getBoundingClientRect();
    const y = frameRect.top + rect.top + rect.height / 2;
    // A popup may cover part of an inline link; require a visible hit on the intended target.
    for (const offset of [rect.width / 2, 2, rect.width - 2]) {
      const x = frameRect.left + rect.left + offset;
      if (document.elementFromPoint(x, y) === frame
        && target.contains(frame.contentDocument!.elementFromPoint(x - frameRect.left, y - frameRect.top))) return { x, y };
    }
    throw new Error(`Preview ${id} pointer target is covered`);
  }, id);
  for (const targetId of ['plain', 'fragment']) {
    await page.click('.preview-font-family-dropdown');
    if (!await page.evaluate(() =>
      document.querySelector('.preview-font-family-dropdown')?.getAttribute('aria-expanded') === 'true'
    )) throw new Error('Preview dropdown did not open');
    const point = await previewPointerPoint(targetId);
    await page.mouse.click(point.x, point.y);
    if (!await page.evaluate(() =>
      document.querySelector('.preview-font-family-dropdown')?.getAttribute('aria-expanded') === 'false'
    )) throw new Error(`Preview ${targetId} click did not dismiss the dropdown`);
  }
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!.scrollTo(0, 0);
  });
  await page.evaluate(() => {
    ((window as any).__previewMessages as unknown[]).length = 0;
  });
  await page.click('.preview-font-family-dropdown');
  const clickPoint = await previewPointerPoint('changelog');
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
      dropdownClosed: document.querySelector('.preview-font-family-dropdown')?.getAttribute('aria-expanded') === 'false',
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
  const wheelPoint = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    doc.body.style.minHeight = '2000px';
    const scroller = doc.scrollingElement!;
    scroller.scrollTop = 0;
    const trace = (window as any).__previewWheelTrace = { events: [] as Array<{ trusted: boolean; prevented: boolean }>, ended: false };
    doc.addEventListener('wheel', event => trace.events.push({ trusted: event.isTrusted, prevented: event.defaultPrevented }));
    doc.addEventListener('scrollend', () => { if (trace.events.length && scroller.scrollTop > 0) trace.ended = true; });
    const bounds = document.querySelector('.preview-frame')!.getBoundingClientRect();
    return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
  });
  await page.mouse.move(wheelPoint.x, wheelPoint.y);
  await page.mouse.wheel({ deltaY: 40 });
  await page.waitForFunction(() => (window as any).__previewWheelTrace.ended, { timeout: 3000 });
  const wheel = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const scroller = doc.scrollingElement!;
    const afterRefresh = scroller.scrollTop;
    const events = [...(window as any).__previewWheelTrace.events];
    (window as any).__previewController.dispose();
    ((window as any).__previewMessages as unknown[]).length = 0;
    doc.getElementById('external')!.click();
    doc.body.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 40 }));
    return { afterRefresh, afterDispose: scroller.scrollTop, messages: (window as any).__previewMessages.length,
      events };
  });
  if (wheel.afterRefresh !== 40 || wheel.afterDispose !== 40 || wheel.messages !== 0
    || wheel.events.length !== 1 || !wheel.events[0].trusted || wheel.events[0].prevented) {
    throw new Error(`Refreshed or disposed Preview retained duplicate listeners: ${JSON.stringify(wheel)}`);
  }
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log('Preview link checks passed');
