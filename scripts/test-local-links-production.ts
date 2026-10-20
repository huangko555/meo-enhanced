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
      const state = (window as any).__localLinks = { exists: false, hold: false, pending: [] as any[], messages: [] as any[] };
      (window as any).acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage(message: any) {
        state.messages.push(message);
        if (message.type !== 'resolveLocalLinks') return;
        const response = { type: 'resolvedLocalLinks', requestId: message.requestId,
          result: { ok: true, value: { results: message.targets.map((target: string) => ({ target, exists: state.exists })) } } };
        if (state.hold) state.pending.push(response);
        else queueMicrotask(() => window.dispatchEvent(new MessageEvent('message', { data: response })));
      } });
    });
    await page.addScriptTag({ content: bundle });
    const target = '文件夹/文档 file.md';
    const text = `caret\n\n[正文](<${target}>)\n\n| title |\n| --- |\n| [表格](<${target}>) |\n`;
    await page.evaluate(({ text, uiLanguage, appearance }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///local-links/current.md', text, version: 1, savedRevision: { version: 1, text },
        diagnostics: [], mode: 'live', uiLanguage, sourceLineNumbers: 'on', previewAppearance: appearance,
        previewFontFamily: '', previewSourceColoring: true, editorAppearance: appearance,
        editorFontSizeMode: 'auto', editorFontSize: 15, gitChangesGutter: false, gitDiffLineHighlights: false,
        gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
      } }));
    }, { text, uiLanguage, appearance });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-local-link-missing-icon').length === 2);
    assert.deepEqual(await page.evaluate(() => (window as any).__localLinks.messages.find((message: any) => message.type === 'resolveLocalLinks').targets), [target],
      'angle brackets and spaces must produce one shared target for prose and tables');
    const refresh = async (exists: boolean) => page.evaluate(exists => {
      (window as any).__localLinks.exists = exists;
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'localLinkResourcesChanged' } }));
    }, exists);
    await refresh(true);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-local-link-missing-icon').length === 0);
    const point = await page.$eval('.cm-line .meo-md-link[data-meo-link-href]', node => {
      const rect = node.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.keyboard.down('Control');
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up('Control');
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
