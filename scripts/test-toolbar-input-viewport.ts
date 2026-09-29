import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Browser, Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-toolbar-input-viewport-'));
const text = Array.from({ length: 40 }, (_, index) => `line ${index + 1} ordinary content`).join('\n');

const init = (mode: 'live' | 'source', documentText = text) => ({
  type: 'init',
  documentId: `file:///toolbar-input-${mode}.md`,
  text: documentText,
  version: 1,
  savedRevision: { version: 1, text: documentText },
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

async function open(browser: Browser, mode: 'live' | 'source', documentText = text): Promise<Page> {
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
  }, init(mode, documentText));
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
    await page.waitForFunction(() => document.activeElement === document.querySelector('.cm-content'));
    await page.keyboard.type('RETURN_MARK');
    const restored = await page.evaluate(() => (window as any).__hostMessages
      .filter((message: any) => message.type === 'draftChanged').at(-1)?.text as string);
    assert.match(restored.split('\n')[2], /RETURN_MARK/, `${mode} return focus did not restore the caret`);

    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });
    await page.waitForFunction(() => document.activeElement === document.querySelector('.cm-content'));
    await page.keyboard.type('LATE_BLUR_MARK');
    const lateBlurRestored = await page.evaluate(() => (window as any).__hostMessages
      .filter((message: any) => message.type === 'draftChanged').at(-1)?.text as string);
    assert.match(lateBlurRestored.split('\n')[2], /LATE_BLUR_MARK/,
      `${mode} return focus missed editor focusout before window blur`);

    const clickPriority = await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      const originalFocus = content.focus.bind(content);
      let restoreCalls = 0;
      content.focus = (options?: FocusOptions) => { restoreCalls += 1; originalFocus(options); };
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      document.querySelector<HTMLElement>('.cm-line:nth-child(5)')!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0
      }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      content.focus = originalFocus;
      return restoreCalls;
    });
    assert.equal(clickPriority, 0, `${mode} delayed focus restoration overrode a new document pointerdown`);

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

async function runPassiveControls(browser: Browser, mode: 'live' | 'source'): Promise<void> {
  const page = await open(browser, mode);
  try {
    await page.click('.cm-line:nth-child(3)');
    const blank = await page.evaluate(() => {
      const rect = document.querySelector<HTMLElement>('.mode-toolbar')!.getBoundingClientRect();
      return { x: rect.left + 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(blank.x, blank.y);
    const afterBlank = await page.evaluate(() => ({
      focused: document.activeElement === document.querySelector('.cm-content'),
      line: document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent
    }));
    assert.equal(afterBlank.focused, true, `${mode} toolbar background hid the insertion caret`);
    assert.match(afterBlank.line ?? '', /line 3 ordinary content/);

    await page.click('[data-action="settings"]');
    await page.click('[data-action="tableStickyHeader"]');
    const afterSwitch = await page.evaluate(() => ({
      focused: document.activeElement === document.querySelector('.cm-content'),
      switched: document.querySelector('[data-action="tableStickyHeader"]')?.getAttribute('aria-checked'),
      menuOpen: !document.querySelector<HTMLElement>('.more-tools-panel')?.hidden
    }));
    assert.deepEqual(afterSwitch, { focused: true, switched: 'false', menuOpen: true },
      `${mode} settings switch lost the editing caret`);
    await page.click('.line-jump-input');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.line-jump-input')), true,
      `${mode} line-jump input could not take focus`);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement === document.querySelector('.cm-content'));
    await page.click('.line-jump-input');
    await page.keyboard.type('40');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement === document.querySelector('.cm-content'));
    assert.ok(await page.$eval('.cm-scroller', element => element.scrollTop) > 0,
      `${mode} line-jump focus recovery undid navigation`);

    await page.click('[data-action="outline-right"]');
    await page.click('.outline-header-button[data-action="expand-all"]');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.cm-content')), true,
      `${mode} outline action hid the insertion caret`);

    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'future-passive-control';
      button.textContent = 'Future action';
      button.style.cssText = 'position:fixed;right:8px;top:110px;z-index:100';
      const input = document.createElement('input');
      input.id = 'future-transient-control';
      input.style.cssText = 'position:fixed;right:8px;top:145px;z-index:100';
      document.getElementById('app')!.append(button, input);
    });
    await page.click('#future-passive-control');
    assert.equal(await page.evaluate(() => document.activeElement === document.querySelector('.cm-content')), true,
      `${mode} unregistered passive control hid the insertion caret`);
    await page.click('#future-transient-control');
    await page.evaluate(() => document.querySelector<HTMLInputElement>('#future-transient-control')!.blur());
    await page.waitForFunction(() => document.activeElement === document.querySelector('.cm-content'));
  } finally {
    await page.close();
  }
}

async function runTableControlFocus(browser: Browser): Promise<void> {
  const page = await open(browser, 'live', '| A | B |\n| --- | --- |\n| alpha | beta |');
  try {
    await page.waitForSelector('tbody textarea[data-table-row="1"][data-table-col="0"]');
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea[data-table-row="1"][data-table-col="0"]')!;
      input.focus();
      input.setSelectionRange(2, 2);
    });
    await page.click('[data-action="settings"]');
    const focusedAfterOpen = await page.evaluate(() => document.activeElement
      === document.querySelector('tbody textarea[data-table-row="1"][data-table-col="0"]'));
    assert.equal(focusedAfterOpen, true, 'Opening settings lost the Live table cell caret');
    await page.click('[data-action="tableStickyHeader"]');
    const result = await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea[data-table-row="1"][data-table-col="0"]');
      return {
        focused: document.activeElement === input,
        selection: input?.selectionStart,
        switched: document.querySelector('[data-action="tableStickyHeader"]')?.getAttribute('aria-checked')
      };
    });
    assert.deepEqual(result, { focused: true, selection: 2, switched: 'false' },
      `Live table cell caret was lost while toggling a settings switch: ${JSON.stringify(result)}`);
  } finally {
    await page.close();
  }
}

async function runActivationClickPriority(browser: Browser, mode: 'live' | 'source'): Promise<void> {
  const page = await open(browser, mode);
  try {
    await page.click('.cm-line:nth-child(3)');
    const result = await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      const originalFocus = content.focus.bind(content);
      let oldCaretRestores = 0;
      content.focus = (options?: FocusOptions) => { oldCaretRestores += 1; originalFocus(options); };
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      const beforeClick = oldCaretRestores;
      document.querySelector<HTMLElement>('.cm-line:nth-child(5)')!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0
      }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      content.focus = originalFocus;
      return { beforeClick, afterFrame: oldCaretRestores };
    });
    assert.deepEqual(result, { beforeClick: 0, afterFrame: 0 },
      `${mode} activation showed the old caret before a document click: ${JSON.stringify(result)}`);
  } finally {
    await page.close();
  }
}

async function runDelayedActivationClick(browser: Browser, mode: 'live' | 'source'): Promise<void> {
  const page = await open(browser, mode);
  try {
    await page.click('.cm-line:nth-child(3)');
    const result = await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      const originalFocus = content.focus.bind(content);
      let oldCaretRestores = 0;
      content.focus = (options?: FocusOptions) => { oldCaretRestores += 1; originalFocus(options); };
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const beforeClick = {
        restores: oldCaretRestores,
        caretHidden: getComputedStyle(content).caretColor === 'rgba(0, 0, 0, 0)'
      };
      document.querySelector<HTMLElement>('.cm-line:nth-child(5)')!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0
      }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const afterClick = { restores: oldCaretRestores, caretVisible: getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)' };
      content.focus = originalFocus;
      return { beforeClick, afterClick };
    });
    assert.deepEqual(result, {
      beforeClick: { restores: 0, caretHidden: true },
      afterClick: { restores: 0, caretVisible: true }
    }, `${mode} delayed activation flashed the old caret: ${JSON.stringify(result)}`);
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
    await runActivationClickPriority(browser, 'live');
    await runActivationClickPriority(browser, 'source');
    await runDelayedActivationClick(browser, 'live');
    await runDelayedActivationClick(browser, 'source');
    await runPassiveControls(browser, 'live');
    await runPassiveControls(browser, 'source');
    await runTableControlFocus(browser);
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
