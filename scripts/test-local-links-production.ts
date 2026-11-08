import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-basic-capability-index-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
try {
  for (const [uiLanguage, appearance] of [['zh-CN', 'light'], ['en', 'dark']]) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1000, height: 700 });
    await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${appearance}"><div id="app"></div></body>`);
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.addStyleTag({ content: ':root{--vscode-editor-font-size:15px;--vscode-editor-font-family:monospace;--vscode-font-family:Arial}' });
    await page.evaluate(() => {
      const state = (window as any).__localLinks = { exists: false, hold: false, pending: [] as any[], messages: [] as any[], pageId: '' };
      (window as any).acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message: any) {
        state.messages.push(message);
        if (message.type === 'ready') state.pageId = message.pageId;
        if (message.type !== 'resolveLocalLinks') return;
        const response = { type: 'resolvedLocalLinks', requestId: message.requestId,
          result: { ok: true, value: { results: message.targets.map((target: string) => ({ target, exists: state.exists })) } } };
        if (state.hold) state.pending.push(response);
        else queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: response })));
      } });
    });
    await page.addScriptTag({ content: bundle });
    await page.waitForFunction(() => typeof (window as any).__localLinks.pageId === 'string' && (window as any).__localLinks.pageId.length > 0);
    const target = '文件夹/文档 file.md';
    const text = `caret\n\n[正文](<${target}>)\n\n| title |\n| --- |\n| [表格](<${target}>) |\n`;
    await page.evaluate(({ text, uiLanguage, appearance, pageId }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', pageId, documentId: 'file:///local-links/current.md', text, version: 1, savedRevision: { version: 1, text },
        diagnostics: [], mode: 'live', uiLanguage, sourceLineNumbers: 'on', previewAppearance: appearance,
        previewFontFamily: '', previewSourceColoring: true, editorAppearance: appearance,
        editorFontSizeMode: 'auto', editorFontSize: 15, gitChangesGutter: false, gitDiffLineHighlights: false,
        gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
      } }));
    }, { text, uiLanguage, appearance, pageId: await page.evaluate(() => (window as any).__localLinks.pageId as string) });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-local-link-missing-icon').length === 2);
    assert.deepEqual(await page.evaluate(() => (window as any).__localLinks.messages.find((message: any) => message.type === 'resolveLocalLinks').targets), [target],
      'angle brackets and spaces must produce one shared target for prose and tables');
    const refresh = async (exists: boolean) => page.evaluate(exists => {
      (window as any).__localLinks.exists = exists;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'localLinkResourcesChanged' } }));
    }, exists);
    await refresh(true);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-local-link-missing-icon').length === 0);
    await page.waitForFunction(() => {
      const host = document.querySelector<HTMLElement>('.editor-host');
      const loading = document.querySelector<HTMLElement>('.editor-loading');
      const link = document.querySelector<HTMLElement>('.cm-line .meo-md-link[data-meo-link-href]');
      if (!host || !link || host.inert || loading?.hidden === false) return false;
      const rect = link.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return rect.width > 0 && rect.height > 0 && link.contains(hit);
    });
    const point = await page.$eval('.cm-line .meo-md-link[data-meo-link-href]', node => {
      const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const hitEvidence = await page.evaluate(({ point, target }) => {
      const linkSelector = '[data-meo-link-href]';
      const link = document.querySelector<HTMLElement>(`.cm-line .meo-md-link${linkSelector}`)!;
      const hit = document.elementFromPoint(point.x, point.y);
      const closestHref = (event: Event) => event.composedPath().find((entry): entry is HTMLElement =>
        entry instanceof HTMLElement && entry.matches(linkSelector))?.dataset.meoLinkHref ?? null;
      const state = (window as any).__localLinks;
      state.clickReceipts = [];
      const record = (event: Event) => {
        if (state.clickReceipts.length >= 16) return;
        const pointer = event as PointerEvent;
        const keyboard = event as KeyboardEvent;
        state.clickReceipts.push({ type: event.type, trusted: event.isTrusted, targetHref: closestHref(event),
          ctrlKey: 'ctrlKey' in event ? pointer.ctrlKey : null, metaKey: 'metaKey' in event ? pointer.metaKey : null,
          key: 'key' in event ? keyboard.key : null });
      };
      for (const type of ['keydown', 'keyup', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        document.addEventListener(type, record, true);
      }
      return {
        expectedHref: target,
        targetHref: link.dataset.meoLinkHref ?? null,
        hitHref: hit?.closest<HTMLElement>(linkSelector)?.dataset.meoLinkHref ?? null,
        targetHit: Boolean(hit && link.contains(hit)),
        hostInert: (document.querySelector('.editor-host') as HTMLElement | null)?.inert ?? false,
        activeTag: document.activeElement?.tagName ?? null
      };
    }, { point, target });
    assert.deepEqual({
      expectedHref: hitEvidence.expectedHref, targetHref: hitEvidence.targetHref, hitHref: hitEvidence.hitHref,
      targetHit: hitEvidence.targetHit, hostInert: hitEvidence.hostInert
    }, {
      expectedHref: target, targetHref: target, hitHref: target, targetHit: true, hostInert: false
    }, 'the Ctrl-click fixture must expose the live link at the actual pointer hit before delivery: ' + JSON.stringify(hitEvidence));
    await page.keyboard.down('Control');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Control');
    const clickReceipts = await page.evaluate(() => (window as any).__localLinks.clickReceipts);
    const clickEvents = clickReceipts.filter((receipt: any) => ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].includes(receipt.type));
    assert.deepEqual(clickEvents.map((receipt: any) => receipt.type), ['pointerdown', 'pointerup', 'click'],
      'the production link route must receive the complete trusted pointer/click sequence');
    assert.ok(clickEvents.every((receipt: any) => receipt.trusted && receipt.targetHref === target && receipt.ctrlKey === true && receipt.metaKey === false),
      'the production link route must receive Ctrl on the actual href target: ' + JSON.stringify(clickReceipts));
    assert.ok(clickReceipts.some((receipt: any) => receipt.type === 'keydown' && receipt.key === 'Control' && receipt.ctrlKey === true),
      'the fixture must deliver the Control press before the pointer sequence: ' + JSON.stringify(clickReceipts));
    assert.equal(await page.evaluate(() => (window as any).__localLinks.messages.find((message: any) => message.type === 'openLink')?.href), target,
      'a real Live Ctrl click must send the same angle-wrapped target as the existence check');

    // A second invalidation supersedes a request still checking an older filesystem state.
    await page.evaluate(() => { (window as any).__localLinks.hold = true; });
    await refresh(false);
    await refresh(true);
    await page.evaluate(() => {
      const pending = (window as any).__localLinks.pending;
      window.dispatchEvent(new MessageEvent('message', { data: pending.pop() }));
      window.dispatchEvent(new MessageEvent('message', { data: pending.pop() }));
      (window as any).__localLinks.hold = false;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.$$eval('.meo-md-local-link-missing-icon', nodes => nodes.length), 0,
      'a late missing response must not resurrect an obsolete warning');
    await refresh(false);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-local-link-missing-icon').length === 2);
    await refresh(true);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-local-link-missing-icon').length === 0);
    assert.deepEqual(errors, [], 'the production Webview must not throw during resource invalidation');
    await page.close();
  }
  console.log('Production angle-wrapped local links: prose/table status invalidation, real clicks and stale responses passed in Chinese/light and English/dark');
} finally { await browser.close(); }
