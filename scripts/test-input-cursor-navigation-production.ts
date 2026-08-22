import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-input-cursor-navigation-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 10): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-input-cursor-navigation-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 640, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const text = Array.from({ length: 320 }, (_, index) => (
      index === 279 ? `line ${index + 1} unique-navigation-target` : `line ${index + 1} ordinary content`
    )).join('\n');
    const immediate = await page.evaluate((documentText) => {
      const create = (window as any).__createInputCursorEditor;
      const editor = create({
        parent: document.getElementById('app'),
        text: documentText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__inputCursorEditor = editor;
      const result = editor.findNext('unique-navigation-target', { focusEditor: true });
      const scroller = editor.getScrollElement();
      scroller.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -640,
        deltaMode: WheelEvent.DOM_DELTA_PIXEL
      }));
      scroller.scrollTop = 0;
      return {
        found: result?.found ?? false,
        scrollTop: scroller.scrollTop,
        text: editor.getText(),
        focused: editor.hasFocus()
      };
    }, text);
    if (!immediate.found || immediate.scrollTop !== 0 || immediate.text !== text || !immediate.focused) {
      throw new Error(`Production navigation setup failed: ${JSON.stringify(immediate)}`);
    }

    await waitForFrames(page);
    const settled = await page.evaluate(() => {
      const editor = (window as any).__inputCursorEditor;
      const scroller = editor.getScrollElement();
      const viewport = scroller.getBoundingClientRect();
      const selectionNode = document.getSelection()?.anchorNode;
      const caretLine = (selectionNode instanceof Element ? selectionNode : selectionNode?.parentElement)
        ?.closest<HTMLElement>('.cm-line');
      const caretLineRect = caretLine?.getBoundingClientRect() ?? null;
      return {
        scrollTop: scroller.scrollTop,
        text: editor.getText(),
        focused: editor.hasFocus(),
        cursorVisible: Boolean(caretLineRect && caretLineRect.bottom > viewport.top && caretLineRect.top < viewport.bottom)
      };
    });
    if (settled.scrollTop !== 0 || settled.text !== text || !settled.focused) {
      throw new Error(`A stale command reveal overrode the later wheel interaction: ${JSON.stringify(settled)}`);
    }

    const replacementPosition = text.indexOf('line 40 ordinary content') + 'line 40 '.length;
    await page.evaluate((position) => {
      const editor = (window as any).__inputCursorEditor;
      editor.setMode('source');
      editor.revealSelection(position, position, { focusEditor: true, align: 'nearest' });
    }, replacementPosition);
    await waitForFrames(page, 2);
    const sourceScrollBeforeInput = await page.evaluate(() => (
      (window as any).__inputCursorEditor.getScrollElement().scrollTop
    ));
    await page.keyboard.type('A');
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.up('Shift');
    await page.keyboard.type('BC');
    await waitForFrames(page, 2);
    const sourceInput = await page.evaluate(({ position, beforeScroll }) => {
      const editor = (window as any).__inputCursorEditor;
      const scroller = editor.getScrollElement();
      const viewport = scroller.getBoundingClientRect();
      const selectionNode = document.getSelection()?.anchorNode;
      const caretLine = (selectionNode instanceof Element ? selectionNode : selectionNode?.parentElement)
        ?.closest<HTMLElement>('.cm-line');
      const caretLineRect = caretLine?.getBoundingClientRect() ?? null;
      return {
        replacement: editor.getText().slice(position, position + 2),
        scrollDelta: Math.abs(scroller.scrollTop - beforeScroll),
        cursorVisible: Boolean(caretLineRect && caretLineRect.bottom > viewport.top && caretLineRect.top < viewport.bottom),
        focused: editor.hasFocus()
      };
    }, { position: replacementPosition, beforeScroll: sourceScrollBeforeInput });
    if (
      sourceInput.replacement !== 'BC' || sourceInput.scrollDelta > 1 ||
      !sourceInput.cursorVisible || !sourceInput.focused
    ) {
      throw new Error(`Visible Source replacement moved or lost the caret: ${JSON.stringify(sourceInput)}`);
    }

    const navigationPosition = text.indexOf('line 120 ordinary content');
    await page.evaluate((position) => {
      const editor = (window as any).__inputCursorEditor;
      editor.revealSelection(position, position, { focusEditor: true, align: 'nearest' });
    }, navigationPosition);
    await waitForFrames(page, 2);
    const navigationScrollBefore = await page.evaluate(() => (
      (window as any).__inputCursorEditor.getScrollElement().scrollTop
    ));
    await page.keyboard.press('ArrowDown');
    await waitForFrames(page, 2);
    const navigation = await page.evaluate((beforeScroll) => {
      const editor = (window as any).__inputCursorEditor;
      const scroller = editor.getScrollElement();
      const viewport = scroller.getBoundingClientRect();
      const selectionNode = document.getSelection()?.anchorNode;
      const caretLine = (selectionNode instanceof Element ? selectionNode : selectionNode?.parentElement)
        ?.closest<HTMLElement>('.cm-line');
      const caretLineRect = caretLine?.getBoundingClientRect() ?? null;
      return {
        scrollDelta: Math.abs(scroller.scrollTop - beforeScroll),
        cursorVisible: Boolean(caretLineRect && caretLineRect.bottom > viewport.top && caretLineRect.top < viewport.bottom),
        focused: editor.hasFocus()
      };
    }, navigationScrollBefore);
    if (navigation.scrollDelta > 40 || !navigation.cursorVisible || !navigation.focused) {
      throw new Error(`Source ArrowDown exceeded nearest caret reveal: ${JSON.stringify(navigation)}`);
    }

    await page.evaluate(() => (window as any).__inputCursorEditor.destroy());
    console.log('input cursor navigation production checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
