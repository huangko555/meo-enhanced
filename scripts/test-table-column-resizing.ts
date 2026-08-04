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
    const dragHandleToMinimum = async (selector: string) => {
      const deltaX = await page.$eval(selector, (handle) => {
        const cell = handle.closest<HTMLElement>('th')!;
        const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!;
        const cellStyle = getComputedStyle(cell);
        const previewStyle = getComputedStyle(preview);
        const minimumWidth = parseFloat(previewStyle.fontSize)
          + parseFloat(previewStyle.paddingLeft)
          + parseFloat(previewStyle.paddingRight)
          + parseFloat(cellStyle.borderLeftWidth)
          + parseFloat(cellStyle.borderRightWidth);
        return minimumWidth - cell.getBoundingClientRect().width;
      });
      await dragHandle(selector, deltaX);
    };

    const exitPoint = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle',
      (handle) => {
        const rect = handle.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    );
    await page.mouse.move(exitPoint.x, exitPoint.y);
    await page.mouse.down();
    await page.mouse.move(exitPoint.x + 30, exitPoint.y, { steps: 2 });
    const widthBeforeDocumentExit = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table)',
      (table) => table.getBoundingClientRect().width
    );
    await page.$eval('.cm-editor', (editor) => {
      editor.dispatchEvent(new PointerEvent('pointerleave', {
        pointerId: 1,
        pointerType: 'mouse',
        buttons: 1
      }));
    });
    await page.mouse.move(exitPoint.x + 90, exitPoint.y, { steps: 2 });
    const widthAfterDocumentReturn = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table)',
      (table) => table.getBoundingClientRect().width
    );
    await page.mouse.up();
    if (Math.abs(widthAfterDocumentReturn - widthBeforeDocumentExit) > 2) {
      throw new Error(`Column resize remained active after leaving the document: ${JSON.stringify({ widthBeforeDocumentExit, widthAfterDocumentReturn })}`);
    }
    await page.evaluate(async (markdown) => {
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
    }, text);

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

    const smoothDragPoint = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle',
      (handle) => {
        const rect = handle.getBoundingClientRect();
        const table = handle.closest('table')!;
        return {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          tableWidth: table.getBoundingClientRect().width
        };
      }
    );
    await page.evaluate(() => {
      const table = document.querySelector('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      (window as any).__resizeRowStyleMutations = 0;
      (window as any).__resizeRowObserver = new MutationObserver((records) => {
        (window as any).__resizeRowStyleMutations += records.length;
      });
      for (const element of table.querySelectorAll('tbody textarea, tbody .meo-md-html-table-cell-content')) {
        (window as any).__resizeRowObserver.observe(element, { attributes: true, attributeFilter: ['style'] });
      }
    });
    await page.mouse.move(smoothDragPoint.x, smoothDragPoint.y);
    await page.mouse.down();
    await page.mouse.move(smoothDragPoint.x + 40, smoothDragPoint.y);
    const smoothDragImmediate = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table)',
      (table) => table.getBoundingClientRect().width
    );
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const smoothDragSettled = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table)',
      (table) => table.getBoundingClientRect().width
    );
    const resizeRowStyleMutations = await page.evaluate(() => {
      (window as any).__resizeRowObserver.disconnect();
      return (window as any).__resizeRowStyleMutations;
    });
    await page.mouse.up();
    if (
      smoothDragImmediate < smoothDragPoint.tableWidth + 30 ||
      Math.abs(smoothDragSettled - smoothDragImmediate) > 2 ||
      resizeRowStyleMutations > 0
    ) {
      throw new Error(`Column width did not remain under the pointer during a held drag: ${JSON.stringify({
        before: smoothDragPoint.tableWidth,
        immediate: smoothDragImmediate,
        settled: smoothDragSettled,
        resizeRowStyleMutations
      })}`);
    }

    await dragHandle(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle',
      -200
    );
    const narrowed = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const firstCell = table.querySelector<HTMLElement>('thead th:first-child')!;
      return { tableWidth: table.getBoundingClientRect().width, firstColumnWidth: firstCell.getBoundingClientRect().width };
    });
    if (narrowed.tableWidth >= initial.tableWidth - 2 || narrowed.firstColumnWidth >= initial.cellWidths[0] - 2) {
      throw new Error(`Table could not shrink below its initial width: ${JSON.stringify({ initial, narrowed })}`);
    }

    await page.evaluate(async (markdown) => {
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
    }, text);

    await dragHandle(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle',
      200
    );
    await dragHandleToMinimum(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:nth-child(2) .meo-md-html-table-column-resize-handle'
    );
    const minimumColumn = await page.evaluate(() => {
      const cell = document.querySelector<HTMLElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th:nth-child(2)'
      )!;
      const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!;
      const cellStyle = getComputedStyle(cell);
      const previewStyle = getComputedStyle(preview);
      const expectedMinimum = parseFloat(previewStyle.fontSize)
        + parseFloat(previewStyle.paddingLeft)
        + parseFloat(previewStyle.paddingRight)
        + parseFloat(cellStyle.borderLeftWidth)
        + parseFloat(cellStyle.borderRightWidth);
      return { width: cell.getBoundingClientRect().width, expectedMinimum };
    });
    if (
      minimumColumn.width >= 48 ||
      Math.abs(minimumColumn.width - minimumColumn.expectedMinimum) > 2
    ) {
      throw new Error(`Column did not clamp to one Chinese character: ${JSON.stringify(minimumColumn)}`);
    }
    await page.evaluate(async (markdown) => {
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
    }, text);

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

    const issueTableText = [
      '| 类型 | 单元格内容 |',
      '| --- | --- |',
      '| 无序列表 | - Apple-**Banana**- Cherry123 |',
      '| 有序列表 | 3. 第三项开始4.*下一项*5. 最后一项 ![测试图片](fixture.png) |',
      '| 嵌套无序列表 | - 一级 A  <br>- 二级<br>       A.1<br>           - 二级 |'
    ].join('\n');
    await page.evaluate(async (markdown) => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="100"><rect width="400" height="100" fill="red"/></svg>';
      (window as any).TableStabilityHarness.setImageSrcResolver(() => `data:image/svg+xml,${encodeURIComponent(svg)}`);
      (window as any).__tableResizeEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableResizeEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: markdown,
        initialMode: 'live',
        onApplyChanges() {}
      });
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    }, issueTableText);
    const issueInitial = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const cells = Array.from(table.querySelectorAll<HTMLElement>('thead th'));
      return {
        tableWidth: table.getBoundingClientRect().width,
        cellWidths: cells.map((cell) => cell.getBoundingClientRect().width),
        hasImage: Boolean(document.querySelector('.meo-md-html-table tbody .meo-md-image-img'))
      };
    });
    if (!issueInitial.hasImage) throw new Error('Issue fixture did not render its table image');

    await dragHandleToMinimum(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle'
    );
    const issueMiddleDrag = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const cells = Array.from(table.querySelectorAll<HTMLElement>('thead th'));
      return {
        tableWidth: table.getBoundingClientRect().width,
        cellWidths: cells.map((cell) => cell.getBoundingClientRect().width)
      };
    });
    if (issueMiddleDrag.tableWidth >= issueInitial.tableWidth - 2 || issueMiddleDrag.cellWidths[0] >= issueInitial.cellWidths[0] - 2) {
      throw new Error(`The middle separator could not narrow the issue table: ${JSON.stringify({ issueInitial, issueMiddleDrag })}`);
    }

    await dragHandleToMinimum(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:last-child .meo-md-html-table-column-resize-handle'
    );
    const issueRightDrag = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const cells = Array.from(table.querySelectorAll<HTMLElement>('thead th'));
      const image = document.querySelector<HTMLElement>('.meo-md-html-table tbody .meo-md-image-img')!;
      const imageCell = image.closest<HTMLElement>('td')!;
      return {
        tableWidth: table.getBoundingClientRect().width,
        cellWidths: cells.map((cell) => cell.getBoundingClientRect().width),
        imageRight: image.getBoundingClientRect().right,
        imageCellRight: imageCell.getBoundingClientRect().right
      };
    });
    if (
      issueRightDrag.tableWidth >= issueMiddleDrag.tableWidth - 2 ||
      issueRightDrag.cellWidths[1] >= issueMiddleDrag.cellWidths[1] - 2 ||
      issueRightDrag.imageRight > issueRightDrag.imageCellRight + 1
    ) {
      throw new Error(`The right separator or image prevented narrowing: ${JSON.stringify({ issueMiddleDrag, issueRightDrag })}`);
    }

    await dragHandle(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle',
      320
    );
    await dragHandle(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:last-child .meo-md-html-table-column-resize-handle',
      320
    );
    const beforeViewportNarrowing = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const widths = Array.from(table.querySelectorAll<HTMLElement>('thead th')).map((cell) => cell.getBoundingClientRect().width);
      return { widths, ratio: widths[0] / widths[1] };
    });
    await page.setViewport({ width: 520, height: 360 });
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const afterViewportNarrowing = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      const widths = Array.from(table.querySelectorAll<HTMLElement>('thead th')).map((cell) => cell.getBoundingClientRect().width);
      return {
        tableWidth: table.getBoundingClientRect().width,
        maximumWidth: wrap.clientWidth,
        ratio: widths[0] / widths[1]
      };
    });
    if (
      afterViewportNarrowing.tableWidth > afterViewportNarrowing.maximumWidth + 2 ||
      Math.abs(afterViewportNarrowing.ratio - beforeViewportNarrowing.ratio) > 0.03
    ) {
      throw new Error(`Resized columns did not scale proportionally with the viewport: ${JSON.stringify({ beforeViewportNarrowing, afterViewportNarrowing })}`);
    }
    await page.setViewport({ width: 960, height: 360 });
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const afterViewportRestoration = await page.$$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th',
      (cells) => cells.map((cell) => cell.getBoundingClientRect().width)
    );
    if (afterViewportRestoration.some((width, index) => Math.abs(width - beforeViewportNarrowing.widths[index]) > 2)) {
      throw new Error(`Column widths were not restored with the viewport: ${JSON.stringify({ beforeViewportNarrowing, afterViewportRestoration })}`);
    }

    const longTableText = [
      '| 第一列 | 第二列 | 第三列 |',
      '| --- | --- | --- |',
      `| ${'很长的内容'.repeat(20)} | ${'另一段长内容'.repeat(20)} | ${'末列内容'.repeat(20)} |`
    ].join('\n');
    await page.evaluate(async (markdown) => {
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
    }, longTableText);
    const defaultMaximum = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      return {
        tableWidth: table.getBoundingClientRect().width,
        wrapWidth: wrap.getBoundingClientRect().width,
        rightInset: wrap.getBoundingClientRect().right - table.getBoundingClientRect().right
      };
    });
    await dragHandle(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:last-child .meo-md-html-table-column-resize-handle',
      1000
    );
    await page.setViewport({ width: 520, height: 360 });
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const resizedMaximum = await page.evaluate(() => {
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      return {
        tableWidth: table.getBoundingClientRect().width,
        wrapWidth: wrap.getBoundingClientRect().width,
        rightInset: wrap.getBoundingClientRect().right - table.getBoundingClientRect().right
      };
    });
    if (resizedMaximum.rightInset + 0.1 < defaultMaximum.rightInset) {
      throw new Error(`Manually resized maximum clipped farther right than the default maximum: ${JSON.stringify({ defaultMaximum, resizedMaximum })}`);
    }

    console.log('table column resizing checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
