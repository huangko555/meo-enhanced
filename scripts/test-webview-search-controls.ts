import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultThemeSettings } from '../src/shared/themeDefaults';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-webview-search-'));

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-webview-viewport-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 520 });
    await page.setContent(`<!doctype html><body><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar" aria-hidden="true"></div>
      <div class="editor-wrapper meo-preload-editor-shell" aria-hidden="true"><div class="editor-host"></div></div>
    </div></body>`);
    await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.__hostMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return window.__webviewState; },
        setState(state) { window.__webviewState = state; }
      });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const text = [
      'before needle',
      '',
      '| A | B |',
      '| --- | --- |',
      '| table-selected | value |',
      '| another needle | value |',
      '',
      ...Array.from({ length: 80 }, (_, index) => `line ${index + 1}`)
    ].join('\n');
    await page.evaluate(({ documentText, theme }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', text: documentText, version: 1, diagnostics: [], mode: 'live', previewAppearance: 'dark',
        lineNumbers: true, gitChangesGutter: false, gitDiffLineHighlights: false,
        spellCheckEnabled: false, contentMaxWidthEnabled: false,
        vimMode: false, vimKeybindings: [], vimLeader: '\\',
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        theme, shikiCodeBlocks: false, codeTheme: null, restoreTopLine: 1, restoreTopLineOffset: 0
      }}));
    }, { documentText: text, theme: defaultThemeSettings });
    await page.waitForSelector('.editor-host > .cm-editor');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const tableSelectionText = await page.evaluate(async () => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      input.focus();
      input.setSelectionRange(0, 'table-selected'.length);
      document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return document.querySelector<HTMLInputElement>('.find-input')!.value;
    });
    await page.click('[aria-label="Close Find"]');

    await page.evaluate(() => {
      const find = document.querySelector<HTMLInputElement>('.find-input')!;
      document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
      find.value = 'needle';
      find.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForSelector('.meo-search-match');
    await page.click('[data-mode="preview"]');
    const previewRequestId = await page.evaluate(() => (
      (window as any).__hostMessages as Array<{ type?: string; requestId?: string }>
    ).findLast((message) => message.type === 'requestPreviewRender')?.requestId);
    const previewHtml = Array.from({ length: 90 }, (_, index) => (
      `<p data-source-line="${index + 1}">${index === 20 ? 'Preview selected phrase' : `Preview line ${index + 1}`}</p>`
    )).join('');
    await page.evaluate(({ requestId, html }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'previewRendered', requestId, hasMermaid: false,
        styles: { dark: 'html,body{margin:0}', light: 'html,body{margin:0}' }, html
      }}));
    }, { requestId: previewRequestId, html: previewHtml });
    await page.waitForFunction(() => Boolean(
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('[data-source-line="21"]')
    ));
    await page.click('[data-mode="live"]');
    const liveHighlightCountAfterModeSwitch = await page.$$eval('.meo-search-match', (matches) => matches.length);

    await page.click('[data-mode="preview"]');
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.hidden);
    const previewState = await page.evaluate(async () => {
      const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
      const frameWindow = frame.contentWindow!;
      const frameDocument = frame.contentDocument!;
      const target = frameDocument.querySelector<HTMLElement>('[data-source-line="21"]')!;
      const textNode = target.firstChild!;
      const range = frameDocument.createRange();
      range.setStart(textNode, 0);
      range.setEnd(textNode, 'Preview selected phrase'.length);
      frameWindow.getSelection()!.removeAllRanges();
      frameWindow.getSelection()!.addRange(range);

      const scrollElement = frameDocument.scrollingElement!;
      const before = scrollElement.scrollTop;
      const wheel = new frameWindow.WheelEvent('wheel', { deltaY: 80, bubbles: true, cancelable: true });
      frameDocument.dispatchEvent(wheel);
      await new Promise<void>((resolve) => frameWindow.requestAnimationFrame(() => resolve()));

      document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return {
        selectedText: document.querySelector<HTMLInputElement>('.find-input')!.value,
        wheelPrevented: wheel.defaultPrevented,
        wheelDelta: scrollElement.scrollTop - before
      };
    });
    await page.click('[aria-label="Close Find"]');

    const discardState = await page.evaluate(async () => {
      const messages = (window as any).__hostMessages as Array<{ type?: string; topLine?: number }>;
      messages.length = 0;
      const button = document.querySelector<HTMLButtonElement>('[data-action="discard"]');
      if (!button) return { exists: false, afterClick: 0, firstArmed: false, recoveredAfterTimeout: false, afterSecondClick: 0, finalArmed: false, topLine: null };
      button.click();
      const afterClick = messages.filter((message) => message.type === 'discardChanges').length;
      const firstArmed = button.classList.contains('is-discard-armed');
      await new Promise((resolve) => window.setTimeout(resolve, 550));
      const recoveredAfterTimeout = !button.classList.contains('is-discard-armed');
      button.click();
      button.click();
      const discard = messages.find((message) => message.type === 'discardChanges');
      return {
        exists: true,
        afterClick,
        firstArmed,
        recoveredAfterTimeout,
        afterSecondClick: messages.filter((message) => message.type === 'discardChanges').length,
        finalArmed: button.classList.contains('is-discard-armed'),
        topLine: discard?.topLine ?? null
      };
    });

    const failures: string[] = [];
    if (tableSelectionText !== 'table-selected') {
      failures.push(`table selection was not copied into Find: ${JSON.stringify(tableSelectionText)}`);
    }
    if (liveHighlightCountAfterModeSwitch !== 0) {
      failures.push(`Live search highlights survived closing Find during a mode switch: ${liveHighlightCountAfterModeSwitch}`);
    }
    if (previewState.selectedText !== 'Preview selected phrase') {
      failures.push(`Preview selection was not copied into Find: ${JSON.stringify(previewState.selectedText)}`);
    }
    if (!previewState.wheelPrevented || Math.abs(previewState.wheelDelta - 80) > 1) {
      failures.push(`Preview wheel used inconsistent native/fallback scrolling: ${JSON.stringify(previewState)}`);
    }
    if (
      !discardState.exists ||
      discardState.afterClick !== 0 ||
      !discardState.firstArmed ||
      !discardState.recoveredAfterTimeout ||
      discardState.afterSecondClick !== 1 ||
      discardState.finalArmed ||
      discardState.topLine === null
    ) {
      failures.push(`Discard control did not provide timed two-click confirmation with viewport context: ${JSON.stringify(discardState)}`);
    }
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('webview search and control checks passed');
  } finally {
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
