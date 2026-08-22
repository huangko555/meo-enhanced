import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-input-path-'));

type FrameSample = {
  text: string;
  domText: string;
  applyCount: number;
  selectionText: string;
  tableCount: number;
  caretVisible: boolean;
};

async function waitForFrames(page: import('puppeteer-core').Page, count: number): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function armFirstFrame(
  page: import('puppeteer-core').Page,
  eventName: 'beforeinput' | 'paste'
): Promise<void> {
  await page.evaluate((inputEventName) => {
    const content = document.querySelector<HTMLElement>('.cm-content');
    if (!content) throw new Error('CodeMirror content was not mounted');
    (window as any).__liveInputFirstFrame = new Promise<FrameSample>((resolve) => {
      content.addEventListener(inputEventName, () => {
        requestAnimationFrame(() => {
          const editor = (window as any).__liveInputEditor;
          const selection = document.getSelection();
          const caret = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
          const viewport = content.closest<HTMLElement>('.cm-scroller')?.getBoundingClientRect() ?? null;
          resolve({
            text: editor.getText(),
            domText: content.textContent ?? '',
            applyCount: (window as any).__liveInputApplies.length,
            selectionText: selection?.toString() ?? '',
            tableCount: document.querySelectorAll('.meo-md-html-table-shell').length,
            caretVisible: Boolean(caret && viewport && caret.bottom >= viewport.top && caret.top <= viewport.bottom)
          });
        });
      }, { capture: true, once: true });
    });
  }, eventName);
}

async function readFirstFrame(page: import('puppeteer-core').Page): Promise<FrameSample> {
  return page.evaluate(() => (window as any).__liveInputFirstFrame);
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
    await page.setViewport({ width: 960, height: 640, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html>
      <style>html,body,#app{height:100%;margin:0}#app{display:flex}.editor{min-width:0;flex:1}</style>
      <div id="app"><div id="primary" class="editor"></div><div id="secondary" class="editor"></div></div>`);
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const original = 'plain line\n**marked text**\n\n| A | B |\n| --- | --- |\n| cell | value |\nlast line';
    await page.evaluate((text) => {
      const create = (window as any).__createInputCursorEditor;
      (window as any).__liveInputApplies = [];
      (window as any).__secondaryApplies = [];
      (window as any).__liveInputEditor = create({
        parent: document.getElementById('primary'),
        text,
        initialMode: 'live',
        onApplyChanges(nextText: string) {
          (window as any).__liveInputApplies.push(nextText);
        }
      });
      (window as any).__secondaryEditor = create({
        parent: document.getElementById('secondary'),
        text: 'second editor',
        initialMode: 'live',
        onApplyChanges(nextText: string) {
          (window as any).__secondaryApplies.push(nextText);
        }
      });
    }, original);
    await waitForFrames(page, 6);

    const initialTableCount = await page.evaluate(() => (
      document.querySelectorAll('#primary .meo-md-html-table-shell').length
    ));
    if (initialTableCount !== 1) {
      throw new Error(`Live table fixture did not render: ${initialTableCount}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__liveInputEditor;
      editor.revealSelection('plain '.length, 'plain '.length, { focusEditor: true, align: 'nearest' });
    });
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('X');
    const plainImmediate = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      applies: [...(window as any).__liveInputApplies]
    }));
    const plainFrame = await readFirstFrame(page);
    if (
      !plainImmediate.text.startsWith('plain Xline') ||
      plainImmediate.applies.at(-1) !== plainImmediate.text ||
      plainFrame.text !== plainImmediate.text ||
      !plainFrame.domText.includes('plain Xline') ||
      plainFrame.selectionText !== '' ||
      !plainFrame.caretVisible ||
      plainFrame.tableCount !== 1
    ) {
      throw new Error(`Plain input was not committed and visible before derived work: ${JSON.stringify({ plainImmediate, plainFrame })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      const markerStart = text.indexOf('marked');
      editor.revealSelection(markerStart, markerStart + 'marked'.length, {
        focusEditor: true,
        align: 'nearest'
      });
    }, original);
    await waitForFrames(page, 3);
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('Q');
    const markerFrame = await readFirstFrame(page);
    if (!markerFrame.text.includes('**Q text**') || !markerFrame.domText.includes('Q text') || !markerFrame.caretVisible) {
      throw new Error(`Markdown-adjacent replacement was hidden or reverted: ${JSON.stringify(markerFrame)}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      const blankLine = text.indexOf('\n\n|') + 1;
      editor.revealSelection(blankLine, blankLine, { focusEditor: true, align: 'nearest' });
    }, original);
    await waitForFrames(page, 3);
    await armFirstFrame(page, 'beforeinput');
    await page.keyboard.type('Z');
    const boundaryFrame = await readFirstFrame(page);
    await waitForFrames(page, 3);
    const boundarySettled = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      domText: document.querySelector<HTMLElement>('#primary .cm-content')?.textContent ?? '',
      tableCount: document.querySelectorAll('#primary .meo-md-html-table-shell').length
    }));
    if (
      !boundaryFrame.text.includes('**marked text**\nZ\n| A | B |') ||
      !boundaryFrame.domText.includes('Z') ||
      boundaryFrame.tableCount !== 1 ||
      boundarySettled.tableCount !== 1 ||
      boundarySettled.text !== boundaryFrame.text
    ) {
      throw new Error(`Rendered-block boundary did not preserve primary text and the unaffected block: ${JSON.stringify({ boundaryFrame, boundarySettled })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain'.length, 'plain'.length, { focusEditor: true, align: 'nearest' });
    }, original);
    await waitForFrames(page, 2);
    await armFirstFrame(page, 'paste');
    const pasteHandled = await page.evaluate(() => {
      const data = new DataTransfer();
      data.setData('text/plain', ' PASTE');
      return !document.querySelector<HTMLElement>('#primary .cm-content')!.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: data
      }));
    });
    const pasteFrame = await readFirstFrame(page);
    if (!pasteHandled || !pasteFrame.text.startsWith('plain PASTE line') || !pasteFrame.domText.includes('plain PASTE line') || !pasteFrame.caretVisible) {
      throw new Error(`Paste was not committed and visible on its first frame: ${JSON.stringify({ pasteHandled, pasteFrame })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain line'.length, 'plain line'.length, { focusEditor: true, align: 'nearest' });
    }, original);
    await waitForFrames(page, 2);
    const beforeImeApplyCount = await page.evaluate(() => (window as any).__liveInputApplies.length);
    const session = await page.createCDPSession();
    await session.send('Input.imeSetComposition', { text: 'pin', selectionStart: 3, selectionEnd: 3 });
    const preedit = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      applyCount: (window as any).__liveInputApplies.length,
      domText: document.querySelector<HTMLElement>('#primary .cm-content')?.textContent ?? ''
    }));
    await session.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#primary .cm-content')?.dispatchEvent(new CompositionEvent('compositionend', {
        data: '拼',
        bubbles: true
      }));
    });
    await armFirstFrame(page, 'beforeinput');
    await session.send('Input.insertText', { text: '拼' });
    const imeFrame = await readFirstFrame(page);
    if (
      !preedit.text.startsWith('plain linepin') || preedit.applyCount !== beforeImeApplyCount || !preedit.domText.includes('pin') ||
      !imeFrame.text.startsWith('plain line拼') || !imeFrame.domText.includes('plain line拼') || !imeFrame.caretVisible
    ) {
      throw new Error(`IME commit did not preserve preedit/commit ownership: ${JSON.stringify({ preedit, imeFrame })}`);
    }

    await page.evaluate((text) => {
      const editor = (window as any).__liveInputEditor;
      editor.setText(text, true);
      editor.revealSelection('plain'.length, 'plain'.length, { focusEditor: true, align: 'nearest' });
    }, original);
    await waitForFrames(page, 2);
    await page.keyboard.type('abcdef');
    const burst = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      latestApply: (window as any).__liveInputApplies.at(-1)
    }));
    await page.evaluate(() => (window as any).__liveInputEditor.setText('external reload wins', true));
    await waitForFrames(page, 4);
    const currentness = await page.evaluate(() => ({
      text: (window as any).__liveInputEditor.getText(),
      domText: document.querySelector<HTMLElement>('#primary .cm-content')?.textContent ?? ''
    }));
    if (!burst.text.startsWith('plainabcdef line') || burst.latestApply !== burst.text || currentness.text !== 'external reload wins' || !currentness.domText.includes('external reload wins')) {
      throw new Error(`Burst/reload currentness failed: ${JSON.stringify({ burst, currentness })}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__secondaryEditor;
      editor.revealSelection(editor.getText().length, editor.getText().length, { focusEditor: true, align: 'nearest' });
    });
    await page.keyboard.type(' remains');
    await page.evaluate(() => {
      (window as any).__liveInputEditor.setMode('source');
      (window as any).__liveInputEditor.destroy();
    });
    await waitForFrames(page, 4);
    const isolation = await page.evaluate(() => ({
      secondaryText: (window as any).__secondaryEditor.getText(),
      secondaryApply: (window as any).__secondaryApplies.at(-1),
      secondaryDom: document.querySelector<HTMLElement>('#secondary .cm-content')?.textContent ?? '',
      primaryConnected: Boolean(document.querySelector('#primary .cm-editor'))
    }));
    if (
      isolation.secondaryText !== 'second editor remains' ||
      isolation.secondaryApply !== isolation.secondaryText ||
      !isolation.secondaryDom.includes('second editor remains') ||
      isolation.primaryConnected
    ) {
      throw new Error(`Destroy/multi-editor isolation failed: ${JSON.stringify(isolation)}`);
    }

    console.log('Live input production frame trace passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
