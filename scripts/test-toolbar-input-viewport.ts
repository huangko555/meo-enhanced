import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { installBrowserTimeoutClock } from './browser-timeout-clock';
import { testBrowserTimeoutClock } from './test-browser-timeout-clock';
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

async function open(browser: Browser, mode: 'live' | 'source', documentText = text, stubMermaid = false): Promise<Page> {
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
  if (stubMermaid) await page.evaluate(() => {
    (window as any).mermaid = { initialize() {}, async render() {
      return { svg: '<svg viewBox="0 0 120 60"><text x="4" y="20">diagram</text></svg>' };
    } };
  });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  await page.evaluate((message) => {
    window.dispatchEvent(new MessageEvent('message', { data: message }));
  }, init(mode, documentText));
  await page.waitForSelector('.editor-wrapper:not(.meo-preload-editor-shell) .cm-content');
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.editor-host')!.inert
      && document.querySelector<HTMLElement>('.editor-loading')?.hidden !== false);

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
      let visibleOldRestores = 0;
      content.focus = (options?: FocusOptions) => {
        if (getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)') visibleOldRestores += 1;
        originalFocus(options);
      };
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      document.querySelector<HTMLElement>('.cm-line:nth-child(5)')!.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, button: 0
      }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      content.focus = originalFocus;
      return visibleOldRestores;
    });
    assert.equal(clickPriority, 0, `${mode} activation exposed the old caret or reapplied it after pointerdown`);

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
    await page.evaluate(() => {
      const blank = document.createElement('div');
      blank.id = 'outside-blank';
      blank.style.cssText = 'position:fixed;left:0;top:95px;width:16px;height:24px;z-index:1000';
      document.body.append(blank);
    });
    await page.click('#outside-blank');
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } })));
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true,
      `${mode} late Host return stole focus from a non-focusable outside click`);

  } finally {
    await page.close();
  }
}

async function runImmediateFocusReturn(browser: Browser, mode: 'live' | 'source'): Promise<void> {
  const page = await open(browser, mode);
  try {
    await page.click('.cm-line:nth-child(3)');
    const immediate = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      return document.activeElement === content;
    });
    assert.equal(immediate, true, `${mode} window return left an input gap before the first key`);
    await page.keyboard.type('FAST_RETURN', { delay: 2 });
    const firstInput = await page.evaluate(() => ({
      changed: (window as any).__hostMessages.filter((message: any) => message.type === 'draftChanged').at(-1)?.text,
      caretVisible: getComputedStyle(document.querySelector<HTMLElement>('.cm-content')!).caretColor !== 'rgba(0, 0, 0, 0)'
    }));
    assert.match(firstInput.changed.split('\n')[2], /FAST_RETURN/, `${mode} window return lost the first input`);
    assert.equal(firstInput.caretVisible, true, `${mode} fast return input kept the caret hidden`);

    const idleReturn = await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } })), 35);
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 70));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { focused: document.activeElement === content,
        caretVisible: getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)' };
    });
    assert.deepEqual(idleReturn, { focused: true, caretVisible: true },
      `${mode} idle return exceeded the short caret display bound`);

    const keyboardReturn = await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Alt', bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { focused: document.activeElement === content,
        caretVisible: getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)' };
    });
    assert.deepEqual(keyboardReturn, { focused: true, caretVisible: true },
      `${mode} confirmed keyboard return waited for the caret display bound`);

    const nativeReturn = await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      window.dispatchEvent(new Event('blur'));
      content.blur();
      // A native focusin must settle the visual guard even if window/Host
      // activation notifications have not arrived yet.
      content.focus({ preventScroll: true });
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 70));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { focused: document.activeElement === content,
        caretVisible: getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)' };
    });
    assert.deepEqual(nativeReturn, { focused: true, caretVisible: true },
      `${mode} native focusin left the return caret hidden`);

    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      (document.activeElement as HTMLElement)?.blur();
    });
    await page.keyboard.type('EARLY_SIGNAL', { delay: 2 });
    const beforeSignal = await page.evaluate(() => ({
      changed: (window as any).__hostMessages.filter((message: any) => message.type === 'draftChanged').at(-1)?.text,
      caretVisible: getComputedStyle(document.querySelector<HTMLElement>('.cm-content')!).caretColor !== 'rgba(0, 0, 0, 0)'
    }));
    assert.match(beforeSignal.changed.split('\n')[2], /EARLY_SIGNAL/,
      `${mode} input before return notifications lost characters`);
    assert.equal(beforeSignal.caretVisible, true, `${mode} early input left the caret hidden`);
    const rapidBlur = await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('blur'));
      content.blur();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { focused: document.activeElement === content,
        hidden: getComputedStyle(content).caretColor === 'rgba(0, 0, 0, 0)' };
    });
    assert.deepEqual(rapidBlur, { focused: false, hidden: true },
      `${mode} an old activation frame completed after another blur`);

    const compositionStart = await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      window.dispatchEvent(new Event('focus'));
      content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      const visible = getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)';
      content.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      return visible;
    });
    assert.equal(compositionStart, true, `${mode} composition began with an invisible caret`);
    const input = await page.createCDPSession();
    try {
      await input.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
      await input.send('Input.insertText', { text: '中' });
      await page.waitForFunction(() => (window as any).__hostMessages
        .filter((message: any) => message.type === 'draftChanged').at(-1)?.text?.includes('中'), { timeout: 3000 });
      assert.equal(await page.$eval('.cm-content', (content) => getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)'), true,
        `${mode} committed composition left the caret hidden`);
    } finally {
      await input.detach();
    }

  } finally {
    await page.close();
  }
}


async function observeHostKeyForwarding(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Exercise the Windows policy deterministically on every browser-test OS.
    Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Win32' });
    (window as any).__forwardedKeys = [];
    // VS Code listens on the content window and forwards even defaultPrevented
    // events. Only stopping propagation before this boundary avoids menu focus.
    for (const type of ['keydown', 'keyup']) window.addEventListener(type, (event) => {
      const key = event as KeyboardEvent;
      (window as any).__forwardedKeys.push({ type, key: key.key, code: key.code, alt: key.altKey });
    });
  });
}

async function expectBareAltPreservesInput(page: Page, label: string): Promise<void> {
  await page.evaluate(() => {
    const selection = document.getSelection();
    const active = document.activeElement;
    (window as any).__beforeAlt = {
      active, anchor: selection?.anchorNode, anchorOffset: selection?.anchorOffset,
      focus: selection?.focusNode, focusOffset: selection?.focusOffset,
      range: active instanceof HTMLTextAreaElement ? [active.selectionStart, active.selectionEnd] : null
    };
    (window as any).__forwardedKeys = [];
  });
  await page.keyboard.press('Alt');
  await page.keyboard.press('Alt');
  const result = await page.evaluate(() => {
    const previous = (window as any).__beforeAlt;
    const selection = document.getSelection();
    const active = document.activeElement;
    return {
      forwarded: (window as any).__forwardedKeys,
      focused: document.hasFocus() && active === previous.active,
      selectionKept: active instanceof HTMLTextAreaElement
        ? active.selectionStart === previous.range[0] && active.selectionEnd === previous.range[1]
        : selection?.anchorNode === previous.anchor && selection?.anchorOffset === previous.anchorOffset
          && selection?.focusNode === previous.focus && selection?.focusOffset === previous.focusOffset,
      caretVisible: active instanceof HTMLElement && getComputedStyle(active).caretColor !== 'rgba(0, 0, 0, 0)'
    };
  });
  assert.deepEqual(result, { forwarded: [], focused: true, selectionKept: true, caretVisible: true },
    label + ' bare Alt reached Host menu forwarding or changed the input point: ' + JSON.stringify(result));
}

async function runAltFocusPolicy(browser: Browser, mode: 'live' | 'source'): Promise<void> {
  const page = await open(browser, mode);
  try {
    await page.click('.cm-line:nth-child(3)');
    await page.keyboard.press('End');
    await observeHostKeyForwarding(page);
    await expectBareAltPreservesInput(page, mode);
    await page.keyboard.type('ALT_INPUT');
    await page.waitForFunction(() => (window as any).__hostMessages
      .filter((message: any) => message.type === 'draftChanged').at(-1)?.text?.split('\n')[2] === 'line 3 ordinary contentALT_INPUT');

    const reset = () => page.evaluate(() => { (window as any).__forwardedKeys = []; });
    await reset();
    await page.keyboard.down('Alt');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Alt');
    const chord = await page.evaluate(() => (window as any).__forwardedKeys);
    assert.ok(chord.some((key: any) => key.type === 'keydown' && key.key === 'ArrowRight' && key.alt),
      mode + ' Alt combination did not reach Host');
    assert.ok(chord.some((key: any) => key.type === 'keyup' && key.key === 'Alt'),
      mode + ' Alt combination left the Host modifier pressed');

    await reset();
    await page.keyboard.down('Control');
    await page.keyboard.press('Alt');
    await page.keyboard.up('Control');
    assert.equal(await page.evaluate(() => (window as any).__forwardedKeys.filter((key: any) => key.key === 'Alt').length), 2,
      mode + ' Ctrl+Alt was intercepted');
    await reset();
    await page.keyboard.press('AltRight');
    assert.equal(await page.evaluate(() => (window as any).__forwardedKeys.filter((key: any) => key.code === 'AltRight').length), 2,
      mode + ' right Alt was intercepted');

    for (const flags of [{ isComposing: true }, { modifierAltGraph: true }]) {
      const forwarded = await page.evaluate((flags) => {
        const target = document.activeElement!;
        (window as any).__forwardedKeys = [];
        for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, {
          key: 'Alt', code: 'AltLeft', altKey: type === 'keydown', ...flags, bubbles: true, cancelable: true
        }));
        return (window as any).__forwardedKeys.length;
      }, flags);
      assert.equal(forwarded, 2, mode + ' composition/AltGraph was intercepted');
    }

    await reset();
    await page.keyboard.down('Alt');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      (document.activeElement as HTMLElement).blur();
      window.dispatchEvent(new Event('focus'));
    });
    await page.keyboard.up('Alt');
    assert.equal(await page.evaluate(() => (window as any).__forwardedKeys.length), 0,
      mode + ' unmatched Alt release reached Host after window return');
    assert.equal(await page.$eval('.cm-content', element => getComputedStyle(element).caretColor !== 'rgba(0, 0, 0, 0)'), true,
      mode + ' Alt return left the caret hidden');

    // An OS window switch can hide both Tab and Alt release from the Webview.
    // The next complete gesture must work without a stuck suppression cycle.
    await page.keyboard.down('Alt');
    await page.focus('#outside');
    await page.keyboard.up('Alt');
    await page.focus('.cm-content');
    await expectBareAltPreservesInput(page, mode + ' after focus transfer');
    await page.evaluate(() => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Alt', code: 'AltLeft', altKey: true, bubbles: true, cancelable: true
      }));
      window.dispatchEvent(new Event('blur'));
      (document.activeElement as HTMLElement).blur();
      window.dispatchEvent(new Event('focus'));
    });
    await expectBareAltPreservesInput(page, mode + ' after lost keyup');

    await page.focus('#outside');
    await reset();
    await page.keyboard.press('Alt');
    assert.equal(await page.evaluate(() => (window as any).__forwardedKeys.length), 2,
      mode + ' bare Alt outside the document was intercepted');
    await page.focus('.cm-content');
    const readOnly = await page.evaluate(() => {
      const target = document.activeElement!;
      target.setAttribute('contenteditable', 'false');
      (window as any).__forwardedKeys = [];
      for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, {
        key: 'Alt', code: 'AltLeft', altKey: type === 'keydown', bubbles: true, cancelable: true
      }));
      target.setAttribute('contenteditable', 'true');
      return (window as any).__forwardedKeys.length;
    });
    assert.equal(readOnly, 2, mode + ' read-only content was intercepted');
    await page.keyboard.down('Alt');
    await page.keyboard.down('Shift');
    await page.keyboard.press('m');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    const nextMode = mode === 'live' ? 'source' : 'live';
    await page.waitForFunction((expected) => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === expected,
      { timeout: 3000 }, nextMode);
    await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content'));
    await expectBareAltPreservesInput(page, mode + ' after Alt+Shift+M');
    await page.evaluate(() => Object.defineProperty(navigator, 'platform', { configurable: true, value: 'Linux x86_64' }));
    await reset();
    await page.keyboard.press('Alt');
    assert.equal(await page.evaluate(() => (window as any).__forwardedKeys.length), 2,
      mode + ' non-Windows bare Alt was intercepted');
    console.log(mode + ' bare Alt scope, combinations, input and lifecycle passed');
  } finally {
    await page.close();
  }
}

async function runComponentFocusReturn(browser: Browser): Promise<void> {
  const fixtures = [
    { kind: 'table', text: '| A | B |\n| --- | --- |\n| alpha | beta |',
      selector: 'tbody textarea[data-table-row="1"][data-table-col="0"]', from: 'alpha', to: 'alRa' },
    { kind: 'code', text: 'intro\n\n```js\nconst value = 1;\n```\n\ntail',
      selector: '.cm-content', line: 'const value = 1;', from: 'const value = 1;', to: 'const value = 1;R' },
    { kind: 'html', text: 'intro\n\n<div>\n<p>alpha beta</p>\n</div>\n\ntail',
      selector: '.cm-content',
      line: '<p>alpha beta</p>', from: '<p>alpha beta</p>', to: '<p>alpha beta</p>R' },
    ...[1, 2].map((clicks) => ({ kind: `mermaid-${clicks === 1 ? 'stacked' : 'side'}`,
      text: 'intro\n\n```mermaid\ngraph TD\nA --> B\n```\n\ntail',
      selector: '.cm-editor > .cm-scroller > .cm-content', button: '.meo-mermaid-mode-btn', clicks, line: 'A --> B',
      from: 'A --> B', to: 'A --> BR' })),
    ...(['live', 'source'] as const).map((mode) => ({ kind: `math-${mode}`, mode,
      text: 'intro\n\n$$\nx^2 + y^2 = 1\n$$\n\ntail',
      selector: '.cm-content', line: 'x^2 + y^2 = 1', from: 'x^2 + y^2 = 1', to: 'x^2 + y^2 = 1R' }))
  ];
  for (const fixture of fixtures) {
    const page = await open(browser, 'mode' in fixture ? fixture.mode : 'live', fixture.text, fixture.kind.startsWith('mermaid'));
    try {
      if (fixture.kind === 'math-live') await page.click('.meo-md-math-fenced-display');
      if (fixture.kind === 'html') await page.click('.meo-md-html-content');
      if ('button' in fixture) {
        for (let step = 0; step < fixture.clicks; step += 1) {
          await page.evaluate((selector) => document.querySelector<HTMLButtonElement>(selector)!.click(), step===0?fixture.button:'.meo-mermaid-layout-btn');
          await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
        }
      }
      await page.waitForSelector(fixture.selector);
      if ('line' in fixture) {
        const point = await page.evaluate((lineText) => {
          const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
            .find((element) => element.textContent?.endsWith(lineText))!;
          const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
          while (walker.nextNode()) {
            const text = walker.currentNode.textContent!, index = text.search(/\S/);
            if (index < 0 || walker.currentNode.parentElement?.closest('[contenteditable="false"],.cm-widgetBuffer')) continue;
            const range = document.createRange(); range.setStart(walker.currentNode, index);
            range.setEnd(walker.currentNode, index + 1);
            const rect = range.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          }
          throw new Error('Native source focus fixture needs an actual text glyph');
        }, fixture.line);
        await page.mouse.click(point.x, point.y);
        assert.equal(await page.evaluate(() => document.activeElement?.matches('.cm-content[contenteditable="true"]')), true, `${fixture.kind}: source glyph click must enter its native editor`);
        await page.keyboard.press('End');
      } else {
        await page.focus(fixture.selector);
        if (fixture.kind === 'table') {
          await page.evaluate((selector) => document.querySelector<HTMLTextAreaElement>(selector)!.setSelectionRange(2, 4), fixture.selector);
        } else {
          await page.keyboard.down('Control');
          await page.keyboard.press('End');
          await page.keyboard.up('Control');
        }
      }
      await observeHostKeyForwarding(page);
      await expectBareAltPreservesInput(page, fixture.kind);
      const restored = await page.evaluate((selector) => {
        const target = document.querySelector<HTMLElement>(selector)!;
        window.dispatchEvent(new Event('blur'));
        target.blur();
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
        return { focused: document.activeElement === document.querySelector(selector),
          range: target instanceof HTMLTextAreaElement ? [target.selectionStart, target.selectionEnd] : null };
      }, fixture.selector);
      assert.equal(restored.focused, true, `${fixture.kind} return did not synchronously focus its editor`);
      if (fixture.kind === 'table') assert.deepEqual(restored.range, [2, 4], 'Table return lost its selected range');
      await page.keyboard.type('R');
      const expected = fixture.text.replace(fixture.from, fixture.to);
      await page.waitForFunction((expected) => (window as any).__hostMessages
        .filter((message: any) => message.type === 'draftChanged').at(-1)?.text === expected,
        { timeout: 3000 }, expected);
      const afterInput = await page.evaluate((selector) => {
        const target = document.querySelector<HTMLElement>(selector)!;
        return { focused: document.activeElement === target,
          caretVisible: getComputedStyle(target).caretColor !== 'rgba(0, 0, 0, 0)' };
      }, fixture.selector);
      assert.deepEqual(afterInput, { focused: true, caretVisible: true }, `${fixture.kind} accepted hidden or unfocused input`);
    } finally {
      await page.close();
    }
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
    // Focus is synchronous; CodeMirror applies the requested scroll during its next measure.
    await page.waitForFunction(() => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller');
      const line = document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line');
      return scroller !== null && scroller.scrollTop > 0 && line?.textContent === 'line 40 ordinary content';
    }, { timeout: 3000 });
    await page.evaluate(async () => {
      for (let frame = 0; frame < 2; frame += 1) {
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
    });
    assert.equal(await page.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent),
      'line 40 ordinary content', `${mode} line-jump focus recovery moved the insertion point`);
    assert.ok(await page.$eval('.cm-scroller', element => element.scrollTop) > 0,
      `${mode} line-jump focus recovery undid navigation`);

    await page.click('.line-jump-input');
    await page.keyboard.type('9999');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement === document.querySelector('.cm-content'), { timeout: 3000 });
    assert.equal(await page.evaluate(() => document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent),
      'line 40 ordinary content', `${mode} an oversized line number did not jump to the final line`);
    assert.deepEqual(await page.$eval('.line-jump-input', element => ({
      value: (element as HTMLInputElement).value, invalid: element.getAttribute('aria-invalid')
    })), { value: '', invalid: null }, `${mode} an oversized line number left an error in the toolbar`);

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
    await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      const originalFocus = content.focus.bind(content);
      (window as any).__activationPaints = [];
      (window as any).__visibleOldRestores = 0;
      content.focus = (options?: FocusOptions) => {
        if (getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)') {
          const line = document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent;
          if (line?.includes('line 3 ordinary content')) (window as any).__visibleOldRestores += 1;
        }
        originalFocus(options);
      };
      window.dispatchEvent(new Event('blur'));
      content.blur();
      // Deliver activation before the trusted click reaches the document.
      // The first painted frame must contain the click's new selection.
      window.addEventListener('pointerdown', () => {
        window.dispatchEvent(new Event('focus'));
        window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      }, { capture: true, once: true });
      // Paint feedback follows the accepted release. A held activation press
      // can still receive another native blur/refocus before that boundary.
      document.addEventListener('pointerup', () => {
        requestAnimationFrame(() => {
          (window as any).__activationPaints.push({
            line: document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent,
            focused: document.activeElement === content,
            visible: getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)'
          });
        });
      }, { once: true });
      (window as any).__restoreOriginalFocus = () => { content.focus = originalFocus; };
    });
    await page.click('.cm-line:nth-child(5)');
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const result = await page.evaluate(() => ({
      paints: (window as any).__activationPaints,
      visibleOldRestores: (window as any).__visibleOldRestores,
      line: document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent
    }));
    assert.equal(result.visibleOldRestores, 0, `${mode} activation flashed the old insertion point`);
    assert.equal(result.paints.length, 1);
    assert.match(result.paints[0].line ?? '', /line 5 ordinary content/,
      `${mode} first activation paint still contained the old selection`);
    assert.equal(result.paints[0].focused, true);
    assert.equal(result.paints[0].visible, true);
    assert.match(result.line ?? '', /line 5 ordinary content/, `${mode} late Host focus rewound the click`);
    await page.evaluate(() => (window as any).__restoreOriginalFocus());
    await page.keyboard.type('ACTIVATION_CLICK');
    const changed = await page.evaluate(() => (window as any).__hostMessages
      .filter((message: any) => message.type === 'draftChanged').at(-1)?.text as string);
    assert.match(changed.split('\n')[4], /ACTIVATION_CLICK/, `${mode} first activation click did not accept input`);
  } finally {
    await page.close();
  }
}

async function runClickAfterSettledReturn(browser: Browser, mode: 'live' | 'source'): Promise<void> {
  const page = await open(browser, mode);
  try {
    await page.click('.cm-line:nth-child(3)');
    const beforeClick = await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      await new Promise<void>((resolve) => setTimeout(() => resolve(), 70));
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return { focused: document.activeElement === content,
        caretVisible: getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)' };
    });
    assert.deepEqual(beforeClick, { focused: true, caretVisible: true },
      `${mode} settled return left the old input point unavailable`);
    await page.click('.cm-line:nth-child(5)');
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } })));
    await page.keyboard.type('NEW_CLICK');
    const changed = await page.evaluate(() => (window as any).__hostMessages
      .filter((message: any) => message.type === 'draftChanged').at(-1)?.text as string);
    assert.match(changed.split('\n')[4], /NEW_CLICK/, `${mode} delayed notification overrode the new click`);
    assert.doesNotMatch(changed.split('\n')[2], /NEW_CLICK/);
  } finally {
    await page.close();
  }
}

async function runSeparatedActivationClick(browser: Browser, mode: 'live' | 'source'): Promise<void> {
  const page = await open(browser, mode);
  try {
    await page.click('.cm-line:nth-child(3)');
    const point = await page.$eval('.cm-line:nth-child(5)', (line) => {
      const rect = line.getBoundingClientRect();
      return { x: rect.left + 12, y: rect.top + rect.height / 2 };
    });
    await page.exposeFunction('__deliverReturnClick', () => page.mouse.click(point.x, point.y));
    const result = await page.evaluate(async () => {
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      const frames: Array<{ line: string | null | undefined; visible: boolean; focused: boolean }> = [];
      let clicking = false;
      const sample = () => ({
        line: document.getSelection()?.anchorNode?.parentElement?.closest('.cm-line')?.textContent,
        visible: getComputedStyle(content).caretColor !== 'rgba(0, 0, 0, 0)',
        focused: document.activeElement === content
      });
      const observe = () => {
        if (clicking) return;
        frames.push(sample());
        requestAnimationFrame(observe);
      };
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      const inputReady = document.activeElement === content;
      requestAnimationFrame(observe);
      // Unlike the same-event activation fixture, let an activation frame
      // actually render before delivering a trusted browser click.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await (window as any).__deliverReturnClick();
      clicking = true;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const afterClick = sample();
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { inputReady, frames, afterClick, afterHost: sample() };
    });
    assert.equal(result.inputReady, true, `${mode} caret protection delayed input readiness`);
    assert.ok(result.frames.length > 0, `${mode} fixture never rendered before clicking`);
    assert.equal(result.frames.some((frame) => frame.focused && frame.visible && frame.line?.includes('line 3 ordinary content')), false,
      `${mode} old caret flashed between activation and click: ${JSON.stringify(result.frames)}`);
    assert.match(result.afterClick.line ?? '', /line 5 ordinary content/);
    assert.equal(result.afterClick.visible, true, `${mode} click did not reveal its caret on the next paint`);
    assert.deepEqual(result.afterHost, result.afterClick, `${mode} late Host notification changed the clicked caret`);
    await page.keyboard.type('SEPARATED_CLICK');
    const changed = await page.evaluate(() => (window as any).__hostMessages
      .filter((message: any) => message.type === 'draftChanged').at(-1)?.text as string);
    assert.match(changed.split('\n')[4], /SEPARATED_CLICK/, `${mode} separate activation click lost input`);
  } finally {
    await page.close();
  }
}

async function runPaintedActivationClick(browser: Browser, mode: 'live' | 'source'): Promise<void> {
  const page = await open(browser, mode);
  const input = await page.createCDPSession();
  const frames: Array<{ data: string; sequence: number }> = [];
  const acknowledgements: Promise<void>[] = [];
  const infrastructureErrors: unknown[] = [];
  let primaryError: unknown;
  const observeFrame = ({ data, sessionId }: { data: string; sessionId: number }) => {
    frames.push({ data, sequence: frames.length });
    acknowledgements.push(input.send('Page.screencastFrameAck', { sessionId }).then(() => {}, error => { infrastructureErrors.push(error); }));
  };
  try {
    await page.$eval('.editor-root', (root, mode) => (root as HTMLElement).style.setProperty(mode === 'source' ? '--meo-source-caret' : '--meo-caret-color', '#ff00ff'), mode);
    // Stabilize the existing real caret's blink phase, never draw a substitute.
    await page.addStyleTag({ content: '.cm-content{caret-animation:manual!important}.cm-cursorLayer{animation:none!important}' });
    await page.click('.cm-line:nth-child(3)');
    const geometry = await page.evaluate(() => {
      const old = document.getSelection()!.getRangeAt(0).getBoundingClientRect();
      const line = document.querySelector('.cm-line:nth-child(5)')!.getBoundingClientRect();
      const marker = document.createElement('div');
      marker.id = 'caret-paint-epoch';
      marker.style.cssText = 'position:fixed;left:0;top:0;width:6px;height:6px;z-index:2147483647;pointer-events:none;background:rgb(20,40,60)';
      document.body.append(marker);
      return { old: { left: old.left - 4, top: old.top - 2, right: old.right + 4, bottom: old.bottom + 2 },
        next: { left: line.left, top: line.top - 2, right: line.right, bottom: line.bottom + 2 },
        click: { x: line.left + 12, y: line.top + line.height / 2 } };
    });
    assert.equal(await page.$eval('.editor-root', root => root.classList.contains('meo-window-focus-return-pending')), false,
      mode + ' fixture already had an activation timer before installing its timeout clock');
    await page.screenshot({ captureBeyondViewport: false });
    input.on('Page.screencastFrame', observeFrame);
    await input.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    const baselineDeadline = Date.now() + 5000;
    while (frames.length === 0 && Date.now() < baselineDeadline) await new Promise(resolve => setTimeout(resolve, 5));
    assert.ok(frames.length > 0, mode + ' no baseline compositor frame');
    // Only timeout scheduling is controlled. Native rAF, performance.now, input,
    // selection and the compositor retain their actual browser implementations.
    await page.evaluate(installBrowserTimeoutClock);
    const ready = await page.evaluate(() => {
      document.getElementById('caret-paint-epoch')!.style.background = 'rgb(60,40,60)';
      const content = document.querySelector<HTMLElement>('.cm-content')!;
      window.dispatchEvent(new Event('blur'));
      content.blur();
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      return document.activeElement === content;
    });
    assert.equal(ready, true, mode + ' painted caret guard delayed input focus');
    const guardTimers = await page.evaluate(async () => {
      await (window as any).__timeoutClock.advance(34);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      document.getElementById('caret-paint-epoch')!.style.background = 'rgb(100,40,60)';
      return (window as any).__timeoutClock.pending() as Array<{ id: number; due: number }>;
    });
    assert.deepEqual(guardTimers.map(timer => timer.due), [50], mode + ' activation guard must still be pending at 34ms');
    // Screenshots are real paint barriers. Transport may take real time without
    // consuming the production guard's remaining logical timeout budget.
    frames.push({ data: Buffer.from(await page.screenshot({ captureBeyondViewport: false })).toString('base64'), sequence: frames.length });
    await page.evaluate(() => {
      (window as any).__caretTrusted = false;
      document.addEventListener('pointerdown', event => {
        (window as any).__caretTrusted = event.isTrusted;
        document.getElementById('caret-paint-epoch')!.style.background = 'rgb(140,40,60)';
      }, { capture: true, once: true });
    });
    await input.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...geometry.click });
    await input.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...geometry.click });
    const afterClickTimers = await page.evaluate(() => ({ now: (window as any).__timeoutClock.now(), pending: (window as any).__timeoutClock.pending() as Array<{ id: number; due: number }> }));
    assert.equal(afterClickTimers.now, 34, mode + ' click advanced the timeout budget');
    assert.equal(afterClickTimers.pending.some(timer => timer.id === guardTimers[0]!.id), false,
      mode + ' trusted click did not cancel the activation guard before its deadline');
    const clock = await page.evaluate(async () => {
      await (window as any).__timeoutClock.advance(34);
      await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      document.getElementById('caret-paint-epoch')!.style.background = 'rgb(180,40,60)';
      return { now: (window as any).__timeoutClock.now(), pending: (window as any).__timeoutClock.pending(), trusted: (window as any).__caretTrusted };
    });
    assert.equal(clock.now, 68, mode + ' timeout clock did not preserve 0\u219234\u219268');
    assert.equal(clock.trusted, true, mode + ' caret click was not trusted');
    assert.deepEqual(clock.pending, [], mode + ' click left pending fake timeout callbacks');
    frames.push({ data: Buffer.from(await page.screenshot({ captureBeyondViewport: false })).toString('base64'), sequence: frames.length });
    await input.send('Page.stopScreencast');
    input.off('Page.screencastFrame', observeFrame);
    await Promise.allSettled(acknowledgements);
    assert.equal(infrastructureErrors.length, 0, mode + ' frame acknowledgement failed');
    const pixels: PaintedCaretFrame[] = [];
    for (const frame of frames) {
      const { data, info: { width, height } } = await sharp(Buffer.from(frame.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const markerOffset = (2 * width + 2) * 4;
      assert.equal(data[markerOffset + 1], 40, mode + ' missing paint epoch marker');
      assert.equal(data[markerOffset + 2], 60, mode + ' missing paint epoch marker');
      const epoch = (data[markerOffset]! - 20) / 40;
      const count = (rect: { left: number; top: number; right: number; bottom: number }) => {
        let result = 0;
        for (let y = Math.max(0, Math.floor(rect.top)); y < Math.min(height, Math.ceil(rect.bottom)); y += 1) {
          for (let x = Math.max(0, Math.floor(rect.left)); x < Math.min(width, Math.ceil(rect.right)); x += 1) {
            const offset = (y * width + x) * 4;
            if (data[offset]! > 200 && data[offset + 1]! < 70 && data[offset + 2]! > 200) result += 1;
          }
        }
        return result;
      };
      pixels.push({ epoch, old: count(geometry.old), next: count(geometry.next) });
    }
    assertPaintedCaretFrames(mode, pixels);
    console.log(mode + ' activation caret pixels: ' + JSON.stringify({ pixels, clock }));
  } catch (error) { primaryError = error; }
  finally {
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [() => input.send('Page.stopScreencast'),
      async () => { input.off('Page.screencastFrame', observeFrame); await Promise.allSettled(acknowledgements); },
      async () => {
        const abandoned = await page.evaluate(() => (window as any).__timeoutClock?.restore() ?? []);
        assert.deepEqual(abandoned, [], mode + ' timeout callbacks remained at descriptor restoration: ' + JSON.stringify(abandoned));
      },
      () => input.detach(), () => page.close()]) {
      try { await cleanup(); } catch (error) { cleanupErrors.push(error); }
    }
    cleanupErrors.push(...infrastructureErrors);
    if (primaryError !== undefined) {
      if (cleanupErrors.length) throw new AggregateError([primaryError, ...cleanupErrors], mode + ' caret witness and cleanup failed', { cause: primaryError });
      throw primaryError;
    }
    if (cleanupErrors.length) throw new AggregateError(cleanupErrors, mode + ' caret witness cleanup failed', { cause: cleanupErrors[0] });
  }
}

type PaintedCaretFrame = { epoch: number; old: number; next: number };

function assertPaintedCaretFrames(mode: string, frames: readonly PaintedCaretFrame[]): void {
  for (const epoch of [0, 2, 4]) assert.ok(frames.some(frame => frame.epoch === epoch), `${mode} missing paint epoch ${epoch}`);
  assert.ok(frames.some(frame => frame.epoch === 0 && frame.old > 0), `${mode} fixture could not capture a real native caret`);
  for (const frame of frames) {
    assert.ok(Number.isInteger(frame.epoch) && frame.epoch >= 0 && frame.epoch <= 4, `${mode} invalid paint epoch`);
    if (frame.epoch > 0) assert.equal(frame.old, 0, `${mode} old caret painted in epoch ${frame.epoch}: ${JSON.stringify(frames)}`);
    if (frame.epoch === 4) assert.ok(frame.next > 0, `${mode} terminal frame did not contain the new clicked caret`);
  }
}

function testPaintedCaretFrameClassification(): void {
  const valid = [0, 1, 2, 3, 4].map(epoch => ({ epoch, old: epoch === 0 ? 19 : 0, next: epoch === 4 ? 19 : 0 }));
  // Arrival order and duplicates cannot turn an old PNG into a new phase.
  assertPaintedCaretFrames('late/duplicate', [...valid.slice(1), valid[0]!, valid[4]!]);
  for (const epoch of [0, 2, 4]) assert.throws(() => assertPaintedCaretFrames('missing', valid.filter(frame => frame.epoch !== epoch)));
  for (const epoch of [1, 2, 3, 4]) assert.throws(() => assertPaintedCaretFrames('old flash', [...valid, { epoch, old: 1, next: 19 }]));
  assert.throws(() => assertPaintedCaretFrames('late rollback', [...valid, { epoch: 4, old: 0, next: 0 }]));
  assert.throws(() => assertPaintedCaretFrames('unattributed', [...valid, { epoch: 5, old: 0, next: 19 }]));
}

async function runWorkbenchMenuFocus(browser: Browser, mode: 'live' | 'source', loading = false): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1000, height: 700 });
    // A same-document outside button cannot reproduce losing focus across the
    // Workbench and Webview frames. Keep both Webview layers in this fixture.
    await page.setContent('<button id="host-menu">Host menu</button><iframe id="webview" style="width:980px;height:640px" srcdoc="<iframe style=\'width:960px;height:620px\'></iframe>"></iframe>');
    const shell = page.frames().find((frame) => frame.parentFrame() === page.mainFrame())!;
    const content = page.frames().find((frame) => frame.parentFrame() === shell)!;
    await content.setContent('<style>html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}</style><div id="app"></div>');
    await content.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await content.addScriptTag({ content: 'window.__hostMessages=[];window.acquireVsCodeApi=()=>({postMessage(message){window.__hostMessages.push(message)},getState(){},setState(){}})' });
    if (loading) await content.evaluate(() => {
      // Let the real editor mount, then hold its preparation frames until the
      // loading cover is visible and focus has moved to the Workbench menu.
      const scope = window as any, request = window.requestAnimationFrame.bind(window);
      const cancel = window.cancelAnimationFrame.bind(window), held = new Map<number, FrameRequestCallback>();
      let released = false;
      window.requestAnimationFrame = callback => {
        const id = request(time => {
          if (!released && document.querySelector('.cm-content')) held.set(id, callback);
          else callback(time);
        });
        return id;
      };
      window.cancelAnimationFrame = id => { held.delete(id); cancel(id); };
      scope.__releaseWorkbenchLoading = () => {
        released = true;
        for (const callback of held.values()) request(callback);
        held.clear();
        window.requestAnimationFrame = request;
        window.cancelAnimationFrame = cancel;
      };
    });
    await content.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await content.evaluate((message) => window.dispatchEvent(new MessageEvent('message', { data: message })), init(mode, 'alpha\nbeta'));
    await content.waitForSelector('.cm-content');
    await content.waitForFunction(loading => loading
      ? document.querySelector<HTMLElement>('.editor-loading')?.hidden === false && document.querySelector<HTMLElement>('.editor-host')?.inert
      : document.querySelector<HTMLElement>('.editor-loading')?.hidden !== false && !document.querySelector<HTMLElement>('.editor-host')?.inert,
      { polling: 10 }, loading);
    await (await content.$(loading ? '.editor-loading' : '.cm-line:nth-child(2)'))!.click();
    const before = await content.evaluate(() => {
      const element = document.querySelector('.cm-content') as HTMLElement & { cmTile: any };
      return element.cmTile.root.view.state.selection.main.head as number;
    });
    await page.click('#host-menu');
    assert.equal(await content.evaluate(() => document.hasFocus()), false, `${mode} menu fixture stayed focused`);
    await content.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } })));
    if (loading) {
      await content.evaluate(() => (window as any).__releaseWorkbenchLoading());
      await content.waitForFunction(() => document.querySelector<HTMLElement>('.editor-loading')?.hidden
        && !document.querySelector<HTMLElement>('.editor-host')?.inert);
    }
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'host-menu', `${mode} late Host notification or loading completion dismissed the Workbench menu`);
    assert.equal(await content.evaluate(() => document.hasFocus()), false, `${mode} late Host notification stole frame focus`);
    // Restoring only the shell is not permission to steal focus. A real return
    // into the content window must still reconnect input at the saved position.
    await page.evaluate(() => document.querySelector<HTMLIFrameElement>('#webview')!.focus());
    await shell.evaluate(() => document.querySelector<HTMLIFrameElement>('iframe')!.contentWindow!.focus());
    await content.waitForFunction(() => document.activeElement === document.querySelector('.cm-content'));
    await page.keyboard.type('MENU_RETURN');
    const after = await content.evaluate(() => (window as any).__hostMessages.filter((message: any) => message.type === 'draftChanged').at(-1)?.text);
    assert.equal(after, 'alpha\nbeta'.slice(0, before) + 'MENU_RETURN' + 'alpha\nbeta'.slice(before), `${mode} content-window return lost the saved position or first input`);
  } finally {
    await page.close();
  }
}
async function runIsolatedPaintedActivationClicks(): Promise<void> {
  // Keep the pixel witness independent of earlier cross-frame focus and timer state.
  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    await runPaintedActivationClick(browser, 'live');
    await runPaintedActivationClick(browser, 'source');
  } catch (error) {
    primaryError = error;
  } finally {
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

async function main(): Promise<void> {
  await testBrowserTimeoutClock();
  testPaintedCaretFrameClassification();
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
    await runWorkbenchMenuFocus(browser, 'live');
    await runWorkbenchMenuFocus(browser, 'source');
    await runWorkbenchMenuFocus(browser, 'live', true);
    await runWorkbenchMenuFocus(browser, 'source', true);
    await runAltFocusPolicy(browser, 'live');
    await runAltFocusPolicy(browser, 'source');
    await runIsolatedPaintedActivationClicks();
    await runSeparatedActivationClick(browser, 'live');
    await runSeparatedActivationClick(browser, 'source');
    await runComponentFocusReturn(browser);
    await runImmediateFocusReturn(browser, 'live');
    await runImmediateFocusReturn(browser, 'source');
    await runMode(browser, 'live');
    await runMode(browser, 'source');
    await runFocusReturn(browser, 'live');
    await runFocusReturn(browser, 'source');
    await runActivationClickPriority(browser, 'live');
    await runActivationClickPriority(browser, 'source');
    await runClickAfterSettledReturn(browser, 'live');
    await runClickAfterSettledReturn(browser, 'source');
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
