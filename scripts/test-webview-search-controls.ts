import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { darkBuiltInVisuals } from '../src/shared/builtInVisualBaseline';
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
        type: 'init', documentId: 'file:///search.md', text: documentText, version: 1,
        savedRevision: { version: 1, text: documentText }, diagnostics: [], mode: 'live', uiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'dark',
        gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
        diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        vscodeTheme: null
      }}));
    }, { documentText: text, theme: darkBuiltInVisuals });
    await page.waitForSelector('.editor-host > .cm-editor');
    await new Promise((resolve) => setTimeout(resolve, 100));
    const localizedFindChrome = await page.evaluate(() => ({
      panel: document.querySelector('.find-panel')?.getAttribute('aria-label'),
      find: document.querySelector<HTMLInputElement>('.find-input')?.placeholder,
      replace: document.querySelectorAll<HTMLInputElement>('.find-input')[1]?.placeholder,
      close: document.querySelector('.find-close-button')?.getAttribute('aria-label'),
      wholeWord: document.querySelector('.find-option-button')?.getAttribute('aria-label')
    }));

    for (const appearance of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.querySelector<HTMLButtonElement>(`[data-editor-appearance="${value}"]`)!.click();
        document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
      }, appearance);
      for (const row of ['.find-row:first-child', '.find-replace-row']) {
        const inputSelector = '.find-panel ' + row + ' .find-input';
        const clearSelector = '.find-panel ' + row + ' .find-clear-button';
        await page.$eval(inputSelector, input => { (input as HTMLInputElement).value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); });
        const empty = await page.$eval(clearSelector, button => getComputedStyle(button).display);
        if (empty !== 'none') throw new Error(`${appearance} ${row}: empty input exposes a clear button`);
        await page.type(inputSelector, 'needle');
        await page.mouse.move(10, 610);
        const normal = await page.$eval(clearSelector, button => {
          const style = getComputedStyle(button), input = button.parentElement!.querySelector('input')!;
          const box = button.getBoundingClientRect(), inputBox = input.getBoundingClientRect();
          return { display: style.display, color: style.color, background: style.backgroundColor,
            radius: getComputedStyle(input).borderRadius, inset: box.left >= inputBox.left && box.right <= inputBox.right && box.top > inputBox.top && box.bottom < inputBox.bottom,
            buttonBox: box.toJSON(), inputBox: inputBox.toJSON() };
        });
        await page.hover(clearSelector);
        const hovered = await page.$eval(clearSelector, button => ({ color: getComputedStyle(button).color, background: getComputedStyle(button).backgroundColor }));
        if (normal.display === 'none' || normal.radius !== '4px' || !normal.inset || normal.color === hovered.color
          || normal.background !== 'rgba(0, 0, 0, 0)' || hovered.background !== 'rgba(0, 0, 0, 0)') {
          throw new Error(`${appearance} ${row}: clear button visibility, hover or input geometry regressed: ${JSON.stringify({ normal, hovered })}`);
        }
        await page.click(clearSelector);
        const cleared = await page.$eval(clearSelector, button => ({ value: button.parentElement!.querySelector('input')!.value, display: getComputedStyle(button).display }));
        if (cleared.value !== '' || cleared.display !== 'none') throw new Error(`${appearance} ${row}: clearing did not hide the button`);
      }
      const closeSelector = '.find-close-button';
      const nextSelector = '.find-row:first-child > .format-button:last-child';
      const readToolbarButton = (selector: string) => page.$eval(selector, button => {
        const style = getComputedStyle(button);
        return { color: style.color, background: style.backgroundColor,
          stroke: getComputedStyle(button.querySelector('svg')!).strokeWidth };
      });
      await page.mouse.move(10, 610);
      const closeNormal = await readToolbarButton(closeSelector);
      const nextNormal = await readToolbarButton(nextSelector);
      await page.hover(closeSelector);
      const closeHover = await readToolbarButton(closeSelector);
      await page.hover(nextSelector);
      const nextHover = await readToolbarButton(nextSelector);
      if (JSON.stringify(closeNormal) !== JSON.stringify(nextNormal)
        || JSON.stringify(closeHover) !== JSON.stringify(nextHover)
        || closeNormal.background === closeHover.background) {
        throw new Error(`${appearance}: panel close must share toolbar button styling: ${JSON.stringify({ closeNormal, nextNormal, closeHover, nextHover })}`);
      }
      await page.click('.more-tools-wrapper > button');
      const popupLayout = await page.evaluate(() => {
        const find = document.querySelector<HTMLElement>('.find-panel')!;
        const menu = document.querySelector<HTMLElement>('.more-tools-panel')!;
        const findRect = find.getBoundingClientRect();
        const menuRect = menu.getBoundingClientRect();
        const left = Math.max(findRect.left, menuRect.left);
        const right = Math.min(findRect.right, menuRect.right);
        const top = Math.max(findRect.top, menuRect.top);
        const bottom = Math.min(findRect.bottom, menuRect.bottom);
        const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
        return {
          radius: getComputedStyle(find).borderRadius,
          border: getComputedStyle(find).borderTopWidth,
          onRight: findRect.left > window.innerWidth / 2,
          fits: findRect.right <= window.innerWidth,
          overlap: right > left && bottom > top,
          menuOnTop: Boolean(hit && menu.contains(hit))
        };
      });
      if (popupLayout.radius !== '8px' || popupLayout.border !== '1px'
        || !popupLayout.onRight || !popupLayout.fits || !popupLayout.overlap || !popupLayout.menuOnTop) {
        throw new Error(`${appearance} search popup layout/stacking regressed: ${JSON.stringify(popupLayout)}`);
      }
      await page.click('.more-tools-wrapper > button');
      await page.click('.find-close-button');
    }

    for (const language of ['en', 'zh-CN']) {
      const titles = await page.evaluate((value) => {
        document.querySelector<HTMLButtonElement>(`[data-ui-language="${value}"]`)!.click();
        const button = document.querySelector<HTMLButtonElement>('[data-action="discard"]')!;
        const normal = button.dataset.tooltip!;
        button.click();
        const armed = button.dataset.tooltip!;
        // Clicking elsewhere cancels confirmation without discarding any content.
        document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        return { normal, armed };
      }, language);
      const warning = language === 'en' ? /unsaved changes/i : /未保存内容/;
      if (!warning.test(titles.normal) || !warning.test(titles.armed)) {
        throw new Error(`${language} reload tooltip omitted the unsaved-change warning: ${JSON.stringify(titles)}`);
      }
    }

    const tableSelectionText = await page.evaluate(async () => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      input.focus();
      input.setSelectionRange(0, 'table-selected'.length);
      document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return document.querySelector<HTMLInputElement>('.find-input')!.value;
    });
    await page.click('.find-close-button');

    await page.evaluate(() => {
      const find = document.querySelector<HTMLInputElement>('.find-input')!;
      document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
      find.value = 'needle';
      find.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForSelector('.meo-search-match');
    const localizedFindStatus = await page.$eval('.find-status', (element) => element.textContent);
    await page.click('[data-mode="preview"]');
    const previewRequestId = await page.evaluate(() => (
      (window as any).__hostMessages as Array<{ type?: string; requestId?: string }>
    ).findLast((message) => message.type === 'requestPreviewRender')?.requestId);
    const previewHtml = Array.from({ length: 90 }, (_, index) => (
      `<p data-source-line="${index + 1}">${index === 20 ? 'Preview selected phrase' : `Preview line ${index + 1}`}</p>`
    )).join('');
    await page.evaluate(({ requestId, html }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'previewRenderResult', requestId, result: { ok: true, value: { hasMermaid: false,
        styles: { dark: 'html,body{margin:0}', light: 'html,body{margin:0}' }, html } }
      }}));
    }, { requestId: previewRequestId, html: previewHtml });
    await page.waitForFunction(() => Boolean(
      document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('[data-source-line="21"]')
    ));
    await page.click('[data-mode="live"]');
    const liveHighlightCountAfterModeSwitch = await page.$$eval('.meo-search-match', (matches) => matches.length);

    await page.click('.find-close-button');
    await page.click('[data-mode="preview"]');
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.hidden);
    const previewWheelPoint = await page.evaluate(() => {
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
      const trace = (window as any).__searchPreviewWheel = { before: scrollElement.scrollTop,
        trusted: false, prevented: false, count: 0, ended: false };
      frameDocument.addEventListener('wheel', event => {
        trace.trusted = event.isTrusted; trace.prevented = event.defaultPrevented; trace.count++;
      });
      frameDocument.addEventListener('scrollend', () => {
        if (trace.count && scrollElement.scrollTop !== trace.before) trace.ended = true;
      });
      const bounds = frame.getBoundingClientRect();
      return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
    });
    await page.mouse.move(previewWheelPoint.x, previewWheelPoint.y);
    await page.mouse.wheel({ deltaY: 80 });
    await page.waitForFunction(() => (window as any).__searchPreviewWheel.ended, { timeout: 3000 });
    const previewState = await page.evaluate(async () => {
      const scrollElement = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!;
      const trace = (window as any).__searchPreviewWheel;
      document.querySelector<HTMLButtonElement>('[data-action="find"]')!.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return {
        selectedText: document.querySelector<HTMLInputElement>('.find-input')!.value,
        wheelTrusted: trace.trusted,
        wheelCount: trace.count,
        wheelPrevented: trace.prevented,
        wheelDelta: scrollElement.scrollTop - trace.before
      };
    });
    await page.click('.find-close-button');

    const discardState = await page.evaluate(async () => {
      const messages = (window as any).__hostMessages as Array<{ type?: string; topLine?: number }>;
      messages.length = 0;
      const button = document.querySelector<HTMLButtonElement>('[data-action="discard"]');
      if (!button) return { exists: false, afterClick: 0, firstArmed: false, recoveredAfterTimeout: false, afterSecondClick: 0, finalArmed: false, topLine: null };
      button.click();
      const afterClick = messages.filter((message) => message.type === 'reloadDocumentFromDisk').length;
      const firstArmed = button.classList.contains('is-discard-armed');
      await new Promise((resolve) => window.setTimeout(resolve, 3050));
      const recoveredAfterTimeout = !button.classList.contains('is-discard-armed');
      button.click();
      button.click();
      for (let attempt = 0; attempt < 20
        && !messages.some((message) => message.type === 'reloadDocumentFromDisk'); attempt += 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 10));
      }
      const discard = messages.find((message) => message.type === 'reloadDocumentFromDisk');
      return {
        exists: true,
        afterClick,
        firstArmed,
        recoveredAfterTimeout,
        afterSecondClick: messages.filter((message) => message.type === 'reloadDocumentFromDisk').length,
        finalArmed: button.classList.contains('is-discard-armed'),
        topLine: discard?.topLine ?? null
      };
    });
    const codeBlockIconShape = await page.$eval(
      '[data-action="codeBlock"] svg',
      (icon) => ({ paths: icon.querySelectorAll('path').length, rects: icon.querySelectorAll('rect').length })
    );

    const failures: string[] = [];
    if (JSON.stringify(localizedFindChrome) !== JSON.stringify({
      panel: '查找和替换', find: '查找', replace: '替换', close: '关闭查找', wholeWord: '全字匹配'
    })) {
      failures.push(`Find chrome did not use the resolved language: ${JSON.stringify(localizedFindChrome)}`);
    }
    if (localizedFindStatus !== '2 个匹配项') {
      failures.push(`Find status did not use the resolved language: ${JSON.stringify(localizedFindStatus)}`);
    }
    if (tableSelectionText !== 'table-selected') {
      failures.push(`table selection was not copied into Find: ${JSON.stringify(tableSelectionText)}`);
    }
    if (liveHighlightCountAfterModeSwitch === 0) {
      failures.push(`Live search highlights disappeared during a mode switch: ${liveHighlightCountAfterModeSwitch}`);
    }
    if (previewState.selectedText !== 'Preview selected phrase') {
      failures.push(`Preview selection was not copied into Find: ${JSON.stringify(previewState.selectedText)}`);
    }
    if (!previewState.wheelTrusted || previewState.wheelCount !== 1 || previewState.wheelPrevented || Math.abs(previewState.wheelDelta - 80) > 1) {
      failures.push(`Preview wheel must retain native scrolling and selection: ${JSON.stringify(previewState)}`);
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
    if (codeBlockIconShape.paths !== 2 || codeBlockIconShape.rects !== 1) {
      failures.push(`Code block control did not use SquareCode: ${JSON.stringify(codeBlockIconShape)}`);
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
