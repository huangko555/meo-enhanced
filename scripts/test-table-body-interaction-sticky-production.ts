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
      || activeHeaderStickyState.stickyInputVisible
      || activeHeaderStickyText !== 'Column 3'
    ) {
      throw new Error(`Active header cell became empty in the floating header: ${JSON.stringify(activeHeaderStickyState)}`);
    }
    await page.evaluate(() => {
      const editor = (window as any).__tableBodyInteractionEditor;
      editor.view.scrollDOM.scrollTop = 0;
      editor.view.scrollDOM.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page, 4);

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

    const stickyNavigationPoint = await page.$eval(
      '.meo-md-html-table-sticky-header',
      (viewport) => {
        const rect = viewport.getBoundingClientRect();
        return { x: rect.left + rect.width * 0.43, y: rect.top + rect.height / 2 };
      }
    );
    await page.mouse.move(stickyNavigationPoint.x, stickyNavigationPoint.y);
    await waitForFrames(page, 2);
    const stickyNavigationHover = await page.evaluate((point) => {
      const viewport = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-header')!;
      const hit = document.elementFromPoint(point.x, point.y);
      return {
        cursor: hit instanceof Element ? getComputedStyle(hit).cursor : getComputedStyle(viewport).cursor,
        indicatorCount: document.querySelectorAll('.meo-md-html-table-sticky-navigation-indicator').length,
        hit: hit instanceof Element ? `${hit.tagName}.${hit.className}` : null,
        title: viewport.dataset.tooltip
      };
    }, stickyNavigationPoint);
    if (
      stickyNavigationHover.cursor !== 'pointer'
      || stickyNavigationHover.indicatorCount !== 0
      || !stickyNavigationHover.title
    ) {
      throw new Error(`Floating table header did not expose one clean click surface: ${JSON.stringify(stickyNavigationHover)}`);
    }
    const scrollBeforeHeaderNavigation = await page.evaluate(() => (
      (window as any).__tableBodyInteractionEditor.view.scrollDOM.scrollTop
    ));
    await page.mouse.click(stickyNavigationPoint.x, stickyNavigationPoint.y);
    await waitForFrames(page, 12);
    const stickyNavigationResult = await page.evaluate((previousScrollTop) => {
      const editor = (window as any).__tableBodyInteractionEditor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const viewport = scroller.getBoundingClientRect();
      const header = document.querySelector<HTMLElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead'
      )!;
      const headerRect = header.getBoundingClientRect();
      const stickyChrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome')!;
      return {
        headerVisible: headerRect.top >= viewport.top - 0.5 && headerRect.bottom <= viewport.bottom + 0.5,
        scrollMovedUp: scroller.scrollTop < previousScrollTop,
        stickyHidden: !stickyChrome.classList.contains('is-visible'),
        stickyInputs: document.querySelectorAll('.meo-md-html-table-sticky-table textarea').length
      };
    }, scrollBeforeHeaderNavigation);
    if (
      !stickyNavigationResult.headerVisible
      || !stickyNavigationResult.scrollMovedUp
      || !stickyNavigationResult.stickyHidden
      || stickyNavigationResult.stickyInputs !== 0
    ) {
      throw new Error(`Clicking the floating table header did not reveal the source header: ${JSON.stringify({ stickyNavigationHover, stickyNavigationResult })}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__tableBodyInteractionEditor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const bodyRow = table.querySelector<HTMLElement>('tbody tr:nth-child(24)')!;
      const viewport = scroller.getBoundingClientRect();
      scroller.scrollTop += bodyRow.getBoundingClientRect().top - viewport.top - viewport.height / 2;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page, 12);

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
