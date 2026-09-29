import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-toolbar-input-viewport-'));
const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1} ordinary content`).join('\n');

const init = (mode: 'live' | 'source') => ({
  type: 'init',
  documentId: `file:///toolbar-input-${mode}.md`,
  text,
  version: 1,
  savedRevision: { version: 1, text },
  diagnostics: [],
  mode,
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
  largeDocumentOptimizationEnabled: true,
  findOptions: { wholeWord: false, caseSensitive: false },
  outlinePosition: 'right',
  outlineVisible: false,
  outlineWidth: 260,
  vscodeTheme: null
});

async function open(browser: Browser, mode: 'live' | 'source'): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><button id="outside">outside</button><div id="app"><div class="mode-toolbar meo-preload-toolbar"></div><div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
  await page.addScriptTag({ content: `
    window.__hostMessages=[];
    window.acquireVsCodeApi=()=>({
      postMessage(message){window.__hostMessages.push(message)},
      getState(){return undefined},
      setState(){}
    });
  ` });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  await page.evaluate((message) => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  }, init(mode));
  await page.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell) .cm-content');
  return page;
}

async function moveCaretOffscreen(page: Page, mode: 'live' | 'source'): Promise<void> {
  await page.click('.cm-content');
  await page.keyboard.down('Control');
  await page.keyboard.press('End');
  await page.keyboard.up('Control');
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    scroller.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -640,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL
    }));
    scroller.scrollTop = 0;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  const fixture = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const viewport = scroller.getBoundingClientRect();
    const selection = document.getSelection();
    const caret = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
    return {
      focused: document.querySelector('.cm-editor')?.classList.contains('cm-focused') ?? false,
      scrollTop: scroller.scrollTop,
      visible: Boolean(caret && caret.top >= viewport.top && caret.bottom <= viewport.bottom)
    };
  });
  assert.deepEqual(fixture, { focused: true, scrollTop: 0, visible: false }, `${mode} fixture did not start offscreen`);
}

async function runMode(browser: Browser, mode: 'live' | 'source'): Promise<void> {
  const page = await open(browser, mode);
  try {
    await moveCaretOffscreen(page, mode);
    await page.click('[data-action="bulletList"]');
    await page.evaluate(async () => {
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const result = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      const viewport = scroller.getBoundingClientRect();
      const selection = document.getSelection();
      const caret = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
      const changed = (window as any).__hostMessages
        .filter((message: any) => message.type === 'draftChanged')
        .at(-1)?.text as string | undefined;
      return {
        changed,
        focused: document.querySelector('.cm-editor')?.classList.contains('cm-focused') ?? false,
        scrollTop: scroller.scrollTop,
        visible: Boolean(caret && caret.top >= viewport.top && caret.bottom <= viewport.bottom)
      };
    });
    assert.equal(result.changed, text.replace('line 40 ordinary content', '- line 40 ordinary content'));
    assert.equal(result.focused, true, `${mode} toolbar edit lost editor focus`);
    assert.equal(result.visible, true, `${mode} toolbar edit left the changed caret outside the viewport: ${JSON.stringify(result)}`);
    assert.ok(result.scrollTop > 0, `${mode} toolbar edit did not move the offscreen caret into view`);
  } finally {
    await page.close();
  }
}

async function runFocusReturn(browser: Browser, mode: 'live' | 'source'): Promise<void> {
  const page = await open(browser, mode);
  try {
    await page.click('.cm-line:nth-child(3)');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      (document.activeElement as HTMLElement)?.blur();
      window.dispatchEvent(new Event('focus'));
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await page.keyboard.type('RETURN_MARK');
    const restored = await page.evaluate(() => (window as any).__hostMessages
      .filter((message: any) => message.type === 'draftChanged').at(-1)?.text as string);
    assert.match(restored.split('\n')[2], /RETURN_MARK/, `${mode} return focus did not restore the caret`);

    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      (document.activeElement as HTMLElement)?.blur();
      document.getElementById('outside')!.focus();
      window.dispatchEvent(new Event('focus'));
    });
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'focusEditor' }
    })));
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'outside', `${mode} window return stole an outside click`);
    await page.click('.cm-line:nth-child(5)');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'focusEditor' }
    })));
    await page.keyboard.type('CLICK_MARK');
    const clicked = await page.evaluate(() => (window as any).__hostMessages
      .filter((message: any) => message.type === 'draftChanged').at(-1)?.text as string);
    assert.match(clicked.split('\n')[4], /CLICK_MARK/, `${mode} return click did not place the caret`);
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-basic-capability-index-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    await runMode(browser, 'live');
    await runMode(browser, 'source');
    await runFocusReturn(browser, 'live');
    await runFocusReturn(browser, 'source');
    console.log('Toolbar input viewport regression passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
