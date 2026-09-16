import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-body-interaction-'));

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
    await page.setContent('<!doctype html><style>html,body{margin:0}#app{height:520px}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const columns = Array.from({ length: 8 }, (_, index) => `Column ${index + 1}`);
    const tableRows = Array.from({ length: 36 }, (_, row) => (
      `| ${columns.map((_, column) => `row ${row + 1} value ${column + 1}`).join(' | ')} |`
    ));
    const source = [
      'before', '',
      `| ${columns.join(' | ')} |`,
      `| ${columns.map(() => '---').join(' | ')} |`,
      ...tableRows, '', 'after'
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__tableBodyInteractionEditor = (window as any).__createInputCursorEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, source);
    await page.waitForSelector('.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody tr:nth-child(2) td:first-child');
    await waitForFrames(page);

    const headerClickPoint = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th:nth-child(3) .meo-md-html-table-cell-preview',
      (preview) => {
        const rect = preview.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    );
    await page.mouse.click(headerClickPoint.x, headerClickPoint.y);
    await waitForFrames(page, 2);
    const activeHeaderStickyState = await page.evaluate(async () => {
      const editor = (window as any).__tableBodyInteractionEditor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const bodyRow = table.querySelector<HTMLElement>('tbody tr:nth-child(24)')!;
      const viewport = scroller.getBoundingClientRect();
      const active = document.activeElement;
      const activeHeader = active instanceof HTMLTextAreaElement
        && active.closest('th')?.dataset.tableRow === '0'
        && active.closest('th')?.dataset.tableCol === '2';
      scroller.scrollTop += bodyRow.getBoundingClientRect().top - viewport.top - viewport.height / 2;
      scroller.dispatchEvent(new Event('scroll'));
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const stickyCell = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-table thead th:nth-child(3)');
      const stickyInput = stickyCell?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
      const stickyPreview = stickyCell?.querySelector<HTMLElement>('.meo-md-html-table-cell-preview') ?? null;
      const isVisible = (element: HTMLElement | null) => {
        if (!element) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      return {
        activeHeader,
        sourceValue: active instanceof HTMLTextAreaElement ? active.value : null,
        stickyVisible: Boolean(stickyCell && stickyCell.getBoundingClientRect().height > 0),
        stickyInputVisible: isVisible(stickyInput),
        stickyInputValue: stickyInput?.value ?? null,
        stickyPreviewVisible: isVisible(stickyPreview),
        stickyPreviewText: stickyPreview?.innerText.trim() ?? null
      };
    });
    const activeHeaderStickyText = activeHeaderStickyState.stickyInputVisible
      ? activeHeaderStickyState.stickyInputValue
      : activeHeaderStickyState.stickyPreviewText;
    if (
      !activeHeaderStickyState.activeHeader
      || activeHeaderStickyState.sourceValue !== 'Column 3'
      || !activeHeaderStickyState.stickyVisible
      || activeHeaderStickyText !== 'Column 3'
    ) {
      throw new Error(`Active header cell became empty in the floating header: ${JSON.stringify(activeHeaderStickyState)}`);
    }

    const stickyHeaderClick = await page.$eval(
      '.meo-md-html-table-sticky-table thead th:nth-child(4) .meo-md-html-table-cell-preview',
      (preview) => {
        const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
        const rect = preview.getBoundingClientRect();
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          scrollTop: scroller.scrollTop
        };
      }
    );
    await page.mouse.click(stickyHeaderClick.x, stickyHeaderClick.y);
    await waitForFrames(page, 3);
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await waitForFrames(page, 5);
    const interactiveStickyHeader = await page.evaluate((expectedScrollTop) => {
      const editor = (window as any).__tableBodyInteractionEditor;
      const active = document.activeElement;
      const input = active instanceof HTMLTextAreaElement ? active : null;
      const trigger = document.querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger');
      const triggerStyle = trigger ? getComputedStyle(trigger) : null;
      return {
        activeInSticky: Boolean(input?.closest('.meo-md-html-table-sticky-table')),
        row: input?.dataset.tableRow ?? null,
        col: input?.dataset.tableCol ?? null,
        value: input?.value ?? null,
        uniqueInputCount: document.querySelectorAll(
          'textarea[data-table-row="0"][data-table-col="3"]'
        ).length,
        placeholderCount: document.querySelectorAll(
          '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead [data-meo-sticky-header-placeholder="true"]'
        ).length,
        triggerVisible: Boolean(
          trigger && !trigger.hidden && triggerStyle?.visibility !== 'hidden' && triggerStyle?.opacity !== '0'
        ),
        scrollDelta: Math.abs(editor.view.scrollDOM.scrollTop - expectedScrollTop),
        sourceUpdated: editor.getText().includes('Column 4 edited')
      };
    }, stickyHeaderClick.scrollTop);
    if (
      !interactiveStickyHeader.activeInSticky
      || interactiveStickyHeader.row !== '0'
      || interactiveStickyHeader.col !== '3'
      || interactiveStickyHeader.value !== 'Column 4 edited'
      || interactiveStickyHeader.uniqueInputCount !== 1
      || interactiveStickyHeader.placeholderCount !== 1
      || !interactiveStickyHeader.triggerVisible
      || interactiveStickyHeader.scrollDelta > 1
      || !interactiveStickyHeader.sourceUpdated
    ) {
      throw new Error(`Floating table header did not preserve one editable surface: ${JSON.stringify(interactiveStickyHeader)}`);
    }
    await page.click('.meo-md-html-table-context-trigger');
    await waitForFrames(page, 2);
    await page.click('.meo-md-html-table-context-next');
    await waitForFrames(page, 1);
    const stickyToolbar = await page.evaluate(() => {
      const menu = document.querySelector<HTMLElement>('.meo-md-html-table-context-menu');
      const activeInput = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-sticky-table textarea[data-table-row="0"][data-table-col="3"]'
      );
      return {
        visible: Boolean(menu && !menu.hidden && getComputedStyle(menu).display !== 'none'),
        activePage: menu?.dataset.activePage ?? null,
        enabledButtons: menu?.querySelectorAll(
          '[data-context-page="arrangement"] button:not(:disabled)'
        ).length ?? 0,
        editorStillProjected: Boolean(activeInput),
        uniqueInputCount: document.querySelectorAll(
          'textarea[data-table-row="0"][data-table-col="3"]'
        ).length
      };
    });
    if (
      !stickyToolbar.visible
      || stickyToolbar.activePage !== 'arrangement'
      || stickyToolbar.enabledButtons === 0
      || !stickyToolbar.editorStillProjected
      || stickyToolbar.uniqueInputCount !== 1
    ) {
      throw new Error(`Floating header table actions were not reachable: ${JSON.stringify(stickyToolbar)}`);
    }
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-sticky-table textarea[data-table-row="0"][data-table-col="3"]'
      )!;
      input.focus({ preventScroll: true });
      input.setSelectionRange(2, 8, 'forward');
    });
    await page.evaluate(() => {
      const editor = (window as any).__tableBodyInteractionEditor;
      editor.view.scrollDOM.scrollTop = 0;
      editor.view.scrollDOM.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page, 4);
    const restoredHeaderEditor = await page.evaluate(() => {
      const active = document.activeElement;
      const input = active instanceof HTMLTextAreaElement ? active : null;
      return {
        activeInPrimary: Boolean(input?.closest(
          '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead'
        )),
        value: input?.value ?? null,
        selectionStart: input?.selectionStart ?? null,
        selectionEnd: input?.selectionEnd ?? null,
        uniqueInputCount: document.querySelectorAll(
          'textarea[data-table-row="0"][data-table-col="3"]'
        ).length,
        placeholderCount: document.querySelectorAll('[data-meo-sticky-header-placeholder="true"]').length
      };
    });
    if (
      !restoredHeaderEditor.activeInPrimary
      || restoredHeaderEditor.value !== 'Column 4 edited'
      || restoredHeaderEditor.selectionStart !== 2
      || restoredHeaderEditor.selectionEnd !== 8
      || restoredHeaderEditor.uniqueInputCount !== 1
      || restoredHeaderEditor.placeholderCount !== 0
    ) {
      throw new Error(`Floating header editor did not return to the primary table intact: ${JSON.stringify(restoredHeaderEditor)}`);
    }

    const clickPoint = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody tr:nth-child(2) td:nth-child(8) .meo-md-html-table-cell-preview',
      (preview) => {
        const wrap = preview.closest<HTMLElement>('.meo-md-html-table-wrap')!;
        wrap.scrollLeft = wrap.scrollWidth;
        const rect = preview.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    );
    await page.mouse.click(clickPoint.x, clickPoint.y);
    await waitForFrames(page, 3);
    const clickedCell = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLTextAreaElement
        && active.closest('td')?.dataset.tableRow === '2'
        && active.closest('td')?.dataset.tableCol === '7';
    });
    if (!clickedCell) throw new Error('Clicking a table body cell did not place the caret in that cell');

    const scrollState = await page.evaluate(async () => {
      const editor = (window as any).__tableBodyInteractionEditor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const header = table.querySelector<HTMLElement>('thead')!;
      const bodyRow = table.querySelector<HTMLElement>('tbody tr:nth-child(24)')!;
      const viewport = scroller.getBoundingClientRect();
      scroller.scrollTop += bodyRow.getBoundingClientRect().top - viewport.top - viewport.height / 2;
      scroller.dispatchEvent(new Event('scroll'));
      for (let frame = 0; frame < 12; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const sticky = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-table');
      return {
        headerBottom: header.getBoundingClientRect().bottom,
        viewportTop: viewport.top,
        stickyVisible: Boolean(sticky && getComputedStyle(sticky).display !== 'none' && sticky.getBoundingClientRect().height > 0)
      };
    });
    if (scrollState.headerBottom >= scrollState.viewportTop || !scrollState.stickyVisible) {
      throw new Error(`Long table did not expose its floating header while scrolling: ${JSON.stringify(scrollState)}`);
    }

    const scrolledClickPoint = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody tr:nth-child(24) td:nth-child(4) .meo-md-html-table-cell-preview',
      (preview) => {
        const rect = preview.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    );
    await page.mouse.click(scrolledClickPoint.x, scrolledClickPoint.y);
    await waitForFrames(page, 3);
    const scrolledCellClicked = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLTextAreaElement
        && active.closest('td')?.dataset.tableRow === '24'
        && active.closest('td')?.dataset.tableCol === '3';
    });
    if (!scrolledCellClicked) {
      throw new Error('Clicking a visible body cell while the floating header is active did not place the caret');
    }

    for (let cycle = 0; cycle < 16; cycle += 1) {
      const beforePresentation = await page.evaluate((text) => {
        const editor = (window as any).__tableBodyInteractionEditor;
        const anchor = editor.getTopVisiblePosition();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        editor.setText(text, true);
        return anchor;
      }, source);
      await waitForFrames(page, 4);
      const afterPresentation = await page.evaluate(() => {
        const editor = (window as any).__tableBodyInteractionEditor;
        const sticky = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-table');
        const preview = document.querySelector<HTMLElement>(
          '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody tr:nth-child(24) td:nth-child(4) .meo-md-html-table-cell-preview'
        )!;
        const rect = preview.getBoundingClientRect();
        return {
          anchor: editor.getTopVisiblePosition(),
          stickyVisible: Boolean(sticky && getComputedStyle(sticky).display !== 'none' && sticky.getBoundingClientRect().height > 0),
          clickPoint: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        };
      });
      if (
        Math.abs(afterPresentation.anchor.line - beforePresentation.line) > 1
        || Math.abs(afterPresentation.anchor.lineOffset - beforePresentation.lineOffset) > 2
      ) {
        throw new Error(`Table viewport anchor drifted after external presentation cycle ${cycle + 1}: ${JSON.stringify({ beforePresentation, afterPresentation })}`);
      }
      if (!afterPresentation.stickyVisible) throw new Error(`Floating table header disappeared in cycle ${cycle + 1}`);
      await page.mouse.click(afterPresentation.clickPoint.x, afterPresentation.clickPoint.y);
      const bodyCellFocused = await page.evaluate(() => (
        document.activeElement instanceof HTMLTextAreaElement
        && document.activeElement.closest('td')?.dataset.tableRow === '24'
      ));
      if (!bodyCellFocused) throw new Error(`Table body lost click focus after external presentation cycle ${cycle + 1}`);
    }

    await page.evaluate(() => (window as any).__tableBodyInteractionEditor.destroy());
    console.log('table body interaction and sticky header production checks passed');
  } finally {
    await closeTestBrowser(browser);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
