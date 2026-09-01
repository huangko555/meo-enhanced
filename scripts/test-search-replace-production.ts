import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-search-replace-production-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 8): Promise<void> {
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
    await page.setViewport({ width: 980, height: 620, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body{margin:0} .test-host{height:520px}</style><div id="search" class="test-host"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const navigationText = Array.from({ length: 80 }, (_, index) => {
      if (index === 3 || index === 5 || index === 59) return `line ${index + 1} needle`;
      if (index === 69) return `line ${index + 1} solo`;
      return `line ${index + 1} ordinary`;
    }).join('\n');
    await page.evaluate((text) => {
      (window as any).__searchContractEditor = (window as any).__createInputCursorEditor({
        parent: document.getElementById('search')!,
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
    }, navigationText);
    await waitForFrames(page);

    const visibleNavigation = await page.evaluate(async () => {
      const editor = (window as any).__searchContractEditor;
      const scroller = editor.getScrollElement();
      const first = editor.findNext('needle', { focusEditor: false });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const afterFirst = scroller.scrollTop;
      const second = editor.findNext('needle', { focusEditor: false });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      return { first, second, afterFirst, afterSecond: scroller.scrollTop };
    });
    if (
      !visibleNavigation.first.found || !visibleNavigation.second.found ||
      Math.abs(visibleNavigation.afterSecond - visibleNavigation.afterFirst) > 1
    ) {
      throw new Error(`Visible search navigation moved the viewport: ${JSON.stringify(visibleNavigation)}`);
    }

    const outsideNavigation = await page.evaluate(async () => {
      const editor = (window as any).__searchContractEditor;
      const result = editor.findNext('needle', { focusEditor: false });
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const selection = editor.view.state.selection.main;
      const activeRect = editor.view.coordsAtPos(selection.from);
      if (!activeRect) throw new Error('Outside search result has no public editor coordinates');
      const viewport = editor.getScrollElement().getBoundingClientRect();
      return {
        result,
        centerDelta: Math.abs(
          (activeRect.top + activeRect.bottom) / 2 - (viewport.top + viewport.bottom) / 2
        )
      };
    });
    if (!outsideNavigation.result.found || outsideNavigation.centerDelta > 24) {
      throw new Error(`Outside search result was not contextually centered: ${JSON.stringify(outsideNavigation)}`);
    }

    const replacementNavigation = await page.evaluate(async () => {
      const editor = (window as any).__searchContractEditor;
      const wrapped = editor.replaceCurrent('needle', 'changed');
      editor.findNext('solo', { focusEditor: false });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const selfContaining = editor.replaceCurrent('solo', 'solo-next');
      const selection = editor.view.state.selection.main;
      return {
        wrapped,
        selfContaining,
        selectionEmpty: selection.empty,
        precedingText: editor.getText().slice(selection.from - 'solo-next'.length, selection.from)
      };
    });
    if (
      !replacementNavigation.wrapped.replaced || !replacementNavigation.wrapped.found ||
      !replacementNavigation.selfContaining.replaced || replacementNavigation.selfContaining.found ||
      !replacementNavigation.selectionEmpty || replacementNavigation.precedingText !== 'solo-next'
    ) {
      throw new Error(`Single replacement continuation drifted: ${JSON.stringify(replacementNavigation)}`);
    }

    await page.evaluate(() => {
      (window as any).__searchContractEditor.destroy();
      document.getElementById('search')!.replaceChildren();
      const lines = Array.from({ length: 55 }, (_, index) => {
        if (index === 4 || index === 39) return `line ${index + 1} bulk`;
        if (index === 19) return '| A | B |';
        if (index === 20) return '| --- | --- |';
        if (index === 21) return '| bulk | value |';
        if (index === 22) return '| stable | row |';
        return `line ${index + 1} ordinary`;
      });
      const text = lines.join('\n');
      (window as any).__replaceAllOriginalText = text;
      (window as any).__replaceAllEditor = (window as any).__createInputCursorEditor({
        parent: document.getElementById('search')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page, 10);
    await page.waitForSelector('tbody td:first-child > [data-table-resize-column="0"]');
    const bodyHandleCount = await page.$$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody td > [data-table-resize-column]',
      (handles) => handles.length
    );
    const widthBefore = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th:first-child',
      (cell) => cell.getBoundingClientRect().width
    );
    await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody td:first-child > [data-table-resize-column="0"]',
      (handle) => {
        const rect = handle.getBoundingClientRect();
        const clientX = rect.left + rect.width / 2;
        const clientY = rect.top + rect.height / 2;
        handle.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, button: 0, buttons: 1, pointerId: 731, pointerType: 'mouse', clientX, clientY
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, buttons: 1, pointerId: 731, pointerType: 'mouse', clientX: clientX + 48, clientY
        }));
        window.dispatchEvent(new PointerEvent('pointerup', {
          bubbles: true, button: 0, buttons: 0, pointerId: 731, pointerType: 'mouse', clientX: clientX + 48, clientY
        }));
      }
    );
    await waitForFrames(page);
    const resizedWidth = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th:first-child',
      (cell) => cell.getBoundingClientRect().width
    );

    const replaceAllState = await page.evaluate(async () => {
      const editor = (window as any).__replaceAllEditor;
      const selectionPosition = editor.view.state.doc.line(35).from + 4;
      editor.revealSelection(selectionPosition, selectionPosition, { focusEditor: false, align: 'center' });
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const beforeTopLine = editor.getTopVisiblePosition().line;
      const beforeHistory = editor.getHistoryDepth();
      const result = editor.replaceAll('bulk', 'done');
      for (let frame = 0; frame < 10; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const selectionLine = editor.view.state.doc.lineAt(editor.view.state.selection.main.anchor).number;
      const afterTopLine = editor.getTopVisiblePosition().line;
      const afterHistory = editor.getHistoryDepth();
      const width = document.querySelector<HTMLElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th:first-child'
      )!.getBoundingClientRect().width;
      const undoApplied = await editor.undo();
      for (let frame = 0; frame < 10; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const restored = editor.getText() === (window as any).__replaceAllOriginalText;
      const redoApplied = await editor.redo();
      for (let frame = 0; frame < 10; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      return {
        result,
        beforeTopLine,
        afterTopLine,
        selectionLine,
        beforeHistory,
        afterHistory,
        width,
        undoApplied,
        restored,
        redoApplied,
        redone: !editor.getText().includes('bulk') && editor.getText().split('done').length - 1 === 3
      };
    });
    if (
      bodyHandleCount !== 4 || resizedWidth < widthBefore + 30 ||
      replaceAllState.result.replaced !== 3 || replaceAllState.selectionLine !== 35 ||
      Math.abs(replaceAllState.afterTopLine - replaceAllState.beforeTopLine) > 1 ||
      replaceAllState.afterHistory.undo !== replaceAllState.beforeHistory.undo + 1 ||
      Math.abs(replaceAllState.width - resizedWidth) > 2 ||
      !replaceAllState.undoApplied || !replaceAllState.restored ||
      !replaceAllState.redoApplied || !replaceAllState.redone
    ) {
      throw new Error(`Replace-all or table-width contract failed: ${JSON.stringify({
        bodyHandleCount,
        widthBefore,
        resizedWidth,
        replaceAllState
      })}`);
    }

    console.log('search and replace production contracts passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
