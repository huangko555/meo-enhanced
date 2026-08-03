import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-column-resizing-'));

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 960, height: 360 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: `
      :root {
        --meo-background: #24292e;
        --meo-inset-background: #2a2d2f;
        --meo-foreground: #e6edf3;
        --meo-caret: #e6edf3;
        --meo-semantic-tableBorder: #474b50;
      }
      html, body, #app { height: 100%; margin: 0; }
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const text = [
      '| First | Second | Third |',
      '| --- | --- | --- |',
      ...Array.from({ length: 28 }, (_, index) => `| ${index + 1} | row ${index + 1} | value ${index + 1} |`)
    ].join('\n');
    await page.evaluate((markdown) => {
      (window as any).__tableResizeEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: markdown,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, text);
    await page.evaluate(async () => {
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });

    const initial = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const cells = Array.from(table.querySelectorAll<HTMLElement>('thead th'));
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      return {
        handleColumns: Array.from(table.querySelectorAll<HTMLElement>('.meo-md-html-table-column-resize-handle'))
          .map((handle) => Number(handle.dataset.tableResizeColumn)),
        tableWidth: table.getBoundingClientRect().width,
        cellWidths: cells.map((cell) => cell.getBoundingClientRect().width),
        maximumWidth: wrap.clientWidth,
        markdown: (window as any).__tableResizeEditor.view.state.doc.toString()
      };
    });
    if (JSON.stringify(initial.handleColumns) !== JSON.stringify([0, 1, 2])) {
      throw new Error(`Expected one right-edge handle per column and no left-edge handle: ${JSON.stringify(initial)}`);
    }

    const dragHandle = async (selector: string, deltaX: number) => {
      const point = await page.$eval(selector, (handle) => {
        const rect = handle.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      await page.mouse.move(point.x + deltaX, point.y, { steps: 4 });
      await page.mouse.up();
      await page.evaluate(async () => {
        for (let index = 0; index < 4; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      });
    };

    await dragHandle(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle',
      80
    );
    const expanded = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      return {
        tableWidth: table.getBoundingClientRect().width,
        cellWidths: Array.from(table.querySelectorAll<HTMLElement>('thead th')).map((cell) => cell.getBoundingClientRect().width),
        markdown: (window as any).__tableResizeEditor.view.state.doc.toString()
      };
    });
    if (
      Math.abs(expanded.tableWidth - initial.tableWidth - 80) > 2 ||
      Math.abs(expanded.cellWidths[0] - initial.cellWidths[0] - 80) > 2 ||
      expanded.cellWidths.slice(1).some((width, index) => Math.abs(width - initial.cellWidths[index + 1]) > 2) ||
      expanded.markdown !== initial.markdown
    ) {
      throw new Error(`Dragging a separator did not resize only its left column: ${JSON.stringify({ initial, expanded })}`);
    }

    await dragHandle(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle',
      -200
    );
    const clamped = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table)',
      (table) => table.getBoundingClientRect().width
    );
    if (Math.abs(clamped - initial.tableWidth) > 2) {
      throw new Error(`Table shrank below its initial width: ${JSON.stringify({ initial: initial.tableWidth, clamped })}`);
    }

    await dragHandle(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle',
      60
    );
    await page.evaluate(async () => {
      const editor = (window as any).__tableResizeEditor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const header = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead')!;
      scroller.scrollTop += header.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 8;
      scroller.dispatchEvent(new Event('scroll'));
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const stickyVisible = await page.$eval(
      '.meo-md-html-table-sticky-chrome',
      (chrome) => getComputedStyle(chrome).display !== 'none'
    );
    if (!stickyVisible) throw new Error('Sticky header did not become visible for resize test');
    const stickyHandleCursor = await page.$eval(
      '.meo-md-html-table-sticky-table .meo-md-html-table-column-resize-handle',
      (handle) => getComputedStyle(handle).cursor
    );
    if (stickyHandleCursor !== 'col-resize') {
      throw new Error(`Sticky-header resize handle had the wrong cursor: ${stickyHandleCursor}`);
    }
    await dragHandle(
      '.meo-md-html-table-sticky-table th:nth-child(2) .meo-md-html-table-column-resize-handle',
      40
    );
    const stickyResize = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const sticky = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-table')!;
      const sourceWidths = Array.from(table.querySelectorAll<HTMLElement>('thead th')).map((cell) => cell.getBoundingClientRect().width);
      const stickyWidths = Array.from(sticky.querySelectorAll<HTMLElement>('thead th')).map((cell) => cell.getBoundingClientRect().width);
      return {
        tableWidth: table.getBoundingClientRect().width,
        sourceWidths,
        widthDeltas: stickyWidths.map((width, index) => Math.abs(width - sourceWidths[index])),
        markdown: (window as any).__tableResizeEditor.view.state.doc.toString()
      };
    });
    if (
      stickyResize.widthDeltas.some((delta) => delta > 2) ||
      Math.abs(stickyResize.tableWidth - initial.tableWidth - 100) > 3 ||
      stickyResize.markdown !== initial.markdown
    ) {
      throw new Error(`Sticky-header resize did not stay synchronized: ${JSON.stringify(stickyResize)}`);
    }

    await dragHandle(
      '.meo-md-html-table-sticky-table th:last-child .meo-md-html-table-column-resize-handle',
      1000
    );
    const maximum = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      return { tableWidth: table.getBoundingClientRect().width, maximumWidth: wrap.clientWidth };
    });
    if (maximum.tableWidth > maximum.maximumWidth + 2) {
      throw new Error(`Table exceeded its default maximum width: ${JSON.stringify(maximum)}`);
    }

    const beforeRebuildWidths = await page.$$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th',
      (cells) => cells.map((cell) => cell.getBoundingClientRect().width)
    );
    await page.evaluate(async () => {
      const editor = (window as any).__tableResizeEditor;
      editor.view.dispatch({ changes: { from: 0, insert: 'before table\n\n' } });
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const rebuiltWidths = await page.$$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th',
      (cells) => cells.map((cell) => cell.getBoundingClientRect().width)
    );
    if (rebuiltWidths.some((width, index) => Math.abs(width - beforeRebuildWidths[index]) > 2)) {
      throw new Error(`Column widths were lost when the table widget rebuilt: ${JSON.stringify({ beforeRebuildWidths, rebuiltWidths })}`);
    }

    const resetState = await page.evaluate(async (markdown) => {
      (window as any).__tableResizeEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableResizeEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: markdown,
        initialMode: 'live',
        onApplyChanges() {}
      });
      for (let index = 0; index < 6; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      return {
        width: table.getBoundingClientRect().width,
        inlineWidth: table.style.width,
        tableLayout: getComputedStyle(table).tableLayout
      };
    }, text);
    if (Math.abs(resetState.width - initial.tableWidth) > 2 || resetState.inlineWidth || resetState.tableLayout !== 'auto') {
      throw new Error(`Column widths survived beyond the editor tab lifetime: ${JSON.stringify({ initial, resetState })}`);
    }

    console.log('table column resizing checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
