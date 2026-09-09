import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-selection-viewport-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 12): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-live-embedded-input-viewport-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 600, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b1f23;--meo-surface-background:#24292e;--meo-semantic-mutedForeground:#8b949e;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      const text = [
        '---',
        'fixture: true',
        'second: value',
        '---',
        '',
        '',
        '| 类型 | | 类型 | | | 内容 | 备注 |',
        '| --- | --- | --- | --- | --- |',
        '| 链接 | | | [VS Code](https://code.visualstudio.com/) | #table/tag |',
        '| 强调 | | | **粗体**、*斜体*、~~删除线~~ | `inline code` |',
        '| | | | 1 | |',
        '| | | | | | | |',
        '| | | | | | | |',
        '| | | | | | | |',
        '| | | | | | | |',
        '| | | | | | | |',
        '| | | | | | 多列表格 |'
      ].join('\n');
      (window as any).__selectionViewportEditor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table tbody tr').length === 9);
    const looseStartSelector = '.meo-md-html-table tbody tr:first-child td:nth-child(4) .meo-md-html-table-cell-preview';
    const looseEndSelector = '.meo-md-html-table tbody tr:nth-child(2) td:nth-child(5) .meo-md-html-table-cell-preview';
    const looseExpectedTarget = await page.$eval(looseStartSelector, (preview) => {
      const input = preview.closest('td')?.querySelector<HTMLTextAreaElement>('textarea');
      return { row: input?.dataset.tableRow ?? null, col: input?.dataset.tableCol ?? null };
    });
    const looseCenter = async (query: string) => page.$eval(query, (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const looseStart = await looseCenter(looseStartSelector);
    const looseEnd = await looseCenter(looseEndSelector);
    await page.mouse.move(looseStart.x, looseStart.y);
    await page.mouse.down();
    await page.mouse.move(looseEnd.x, looseEnd.y, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => !(window as any).__selectionViewportEditor.getText().includes('VS Code'));
    await page.evaluate(() => {
      const editor = (window as any).__selectionViewportEditor;
      editor.view.contentDOM.focus({ preventScroll: true });
      editor.undo();
    });
    await page.waitForFunction(() => (window as any).__selectionViewportEditor.getText().includes('VS Code'));
    await waitForFrames(page, 12);
    const looseUndoFocus = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLTextAreaElement ? {
        row: active.dataset.tableRow ?? null,
        col: active.dataset.tableCol ?? null,
        caret: active.selectionStart,
        stickyClone: Boolean(active.closest('.meo-md-html-table-sticky-table'))
      } : null;
    });
    if (
      looseUndoFocus?.row !== looseExpectedTarget.row || looseUndoFocus.col !== looseExpectedTarget.col
      || looseUndoFocus.caret !== 0 || looseUndoFocus.stickyClone
    ) {
      throw new Error(`Loose-table undo focused outside the cleared rectangle: ${JSON.stringify({
        expected: looseExpectedTarget, actual: looseUndoFocus
      })}`);
    }
    await page.evaluate(() => {
      (window as any).__selectionViewportEditor.destroy();
      document.getElementById('app')!.replaceChildren();
    });
    await page.evaluate(() => {
      const rows = Array.from({ length: 12 }, (_, index) => {
        const row = String(index + 1).padStart(2, '0');
        return `| ${row} | A${row} | B${row} |`;
      });
      const text = [
        ...Array.from({ length: 35 }, (_, index) => `Before ${index + 1}`),
        '',
        '| Row | A | B |',
        '| --- | --- | --- |',
        ...rows,
        '',
        ...Array.from({ length: 35 }, (_, index) => `After ${index + 1}`)
      ].join('\n');
      (window as any).__selectionViewportEditor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
      (window as any).__selectionViewportEditor.scrollToLine(39, 'center');
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell').length > 0);
    const renderedRowCount = await page.$$eval('.meo-md-html-table tbody tr', (rows) => rows.length);
    if (renderedRowCount !== 12) throw new Error(`Expected 12 rendered table rows, got ${renderedRowCount}`);

    const selector = (row: number, col: number) => (
      `.meo-md-html-table tbody td[data-table-row="${row}"][data-table-col="${col}"] .meo-md-html-table-cell-preview`
    );
    const center = async (query: string) => page.$eval(query, (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const start = await center(selector(3, 2));
    const end = await center(selector(2, 1));
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 5 });
    await page.mouse.up();
    await waitForFrames(page, 4);
    const selectedCount = await page.$$eval('.meo-md-html-table-cell-selected', (cells) => cells.length);
    if (selectedCount !== 4) throw new Error(`Expected 4 selected cells, got ${selectedCount}`);

    const moveSelectionAboveViewport = async () => {
      await page.evaluate(() => {
        const editor = (window as any).__selectionViewportEditor;
        const cell = document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="1"]')!;
        const viewport = editor.view.scrollDOM.getBoundingClientRect();
        const rect = cell.getBoundingClientRect();
        editor.view.scrollDOM.scrollTop += rect.bottom - viewport.top + 100;
      });
      await waitForFrames(page, 4);
    };
    const moveSelectionUnderStickyHeader = async () => {
      await page.evaluate(() => {
        const editor = (window as any).__selectionViewportEditor;
        const cell = document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="1"]')!;
        const viewport = editor.view.scrollDOM.getBoundingClientRect();
        editor.view.scrollDOM.scrollTop += cell.getBoundingClientRect().bottom - viewport.top + 20;
      });
      await waitForFrames(page, 8);
      await page.evaluate(() => {
        const editor = (window as any).__selectionViewportEditor;
        const cell = document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="1"]')!;
        const sticky = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible');
        if (!sticky) throw new Error('Sticky header did not become visible');
        editor.view.scrollDOM.scrollTop += cell.getBoundingClientRect().bottom
          - sticky.getBoundingClientRect().bottom + 4;
      });
      await waitForFrames(page, 4);
    };
    const visibility = async () => page.evaluate(() => {
      const editor = (window as any).__selectionViewportEditor;
      const cell = document.querySelector<HTMLElement>('td[data-table-row="2"][data-table-col="1"]');
      const sticky = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible');
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const rect = cell?.getBoundingClientRect() ?? null;
      const usableTop = Math.max(viewport.top, sticky?.getBoundingClientRect().bottom ?? viewport.top);
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        top: rect?.top ?? null,
        bottom: rect?.bottom ?? null,
        usableTop,
        viewportBottom: viewport.bottom,
        visible: Boolean(rect && rect.bottom > usableTop && rect.top < viewport.bottom),
        active: document.activeElement?.tagName ?? null
      };
    });

    await moveSelectionAboveViewport();
    const beforeDelete = await visibility();
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => {
      const editor = (window as any).__selectionViewportEditor;
      return !editor.getText().includes('A02') && !editor.getText().includes('B03');
    });
    await waitForFrames(page, 16);
    const afterDelete = await visibility();
    const afterDeleteFocus = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLTextAreaElement ? {
        row: active.dataset.tableRow ?? null,
        col: active.dataset.tableCol ?? null,
        selectionStart: active.selectionStart,
        stickyClone: Boolean(active.closest('.meo-md-html-table-sticky-table'))
      } : null;
    });

    await moveSelectionUnderStickyHeader();
    const beforeUndo = await visibility();
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => (window as any).__selectionViewportEditor.getText().includes('A02'));
    await waitForFrames(page, 20);
    const afterUndo = await page.evaluate(() => {
      const editor = (window as any).__selectionViewportEditor;
      const active = document.activeElement;
      const sticky = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible');
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const rect = active instanceof HTMLTextAreaElement ? active.getBoundingClientRect() : null;
      const usableTop = Math.max(viewport.top, sticky?.getBoundingClientRect().bottom ?? viewport.top);
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        value: active instanceof HTMLTextAreaElement ? active.value : null,
        row: active instanceof HTMLTextAreaElement ? active.dataset.tableRow ?? null : null,
        col: active instanceof HTMLTextAreaElement ? active.dataset.tableCol ?? null : null,
        caret: active instanceof HTMLTextAreaElement ? active.selectionStart : null,
        stickyClone: Boolean(active?.closest('.meo-md-html-table-sticky-table')),
        top: rect?.top ?? null,
        bottom: rect?.bottom ?? null,
        usableTop,
        viewportBottom: viewport.bottom,
        visible: Boolean(rect && rect.bottom > usableTop && rect.top < viewport.bottom)
      };
    });

    if (
      beforeDelete.visible || !afterDelete.visible || beforeUndo.visible || !afterUndo.visible
      || afterDeleteFocus?.row !== '2' || afterDeleteFocus.col !== '1'
      || afterDeleteFocus.selectionStart !== 0 || afterDeleteFocus.stickyClone
      || afterUndo.row !== '2' || afterUndo.col !== '1'
      || afterUndo.caret !== 0 || afterUndo.stickyClone
    ) {
      throw new Error(`Offscreen multi-cell delete/undo did not minimally reveal its target: ${JSON.stringify({
        beforeDelete, afterDelete, afterDeleteFocus, beforeUndo, afterUndo
      })}`);
    }

    await page.evaluate(() => {
      (window as any).__selectionViewportEditor.destroy();
      const text = [
        ...Array.from({ length: 25 }, (_, index) => `Before Enter ${index + 1}`),
        '',
        '| A | B |',
        '| --- | --- |',
        '| one | two |',
        '| three | four |',
        '',
        ...Array.from({ length: 30 }, (_, index) => `After Enter ${index + 1}`)
      ].join('\n');
      (window as any).__selectionViewportEditor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
      (window as any).__selectionViewportEditor.scrollToLine(30, 'center');
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table tbody tr').length === 2);
    await page.evaluate(() => {
      const editor = (window as any).__selectionViewportEditor;
      const input = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table textarea[data-table-row="2"][data-table-col="1"]'
      )!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const rect = input.getBoundingClientRect();
      editor.view.scrollDOM.scrollTop += rect.bottom - (viewport.bottom - 100);
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      (window as any).__tableEnterViewportTrace = [];
      const sample = () => {
        const active = document.activeElement;
        (window as any).__tableEnterViewportTrace.push({
          scrollTop: editor.view.scrollDOM.scrollTop,
          activeRow: active instanceof HTMLTextAreaElement ? active.dataset.tableRow : null,
          activeCol: active instanceof HTMLTextAreaElement ? active.dataset.tableCol : null
        });
        if ((window as any).__tableEnterViewportTrace.length < 80) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    const beforeEnter = await page.evaluate(() => ({
      scrollTop: (window as any).__selectionViewportEditor.view.scrollDOM.scrollTop,
      rowCount: document.querySelectorAll('.meo-md-html-table tbody tr').length
    }));
    const beforeEnterText = await page.evaluate(() => (window as any).__selectionViewportEditor.getText());
    await page.keyboard.press('Enter');
    await waitForFrames(page, 24);
    const afterEnter = await page.evaluate(() => {
      const editor = (window as any).__selectionViewportEditor;
      const active = document.activeElement;
      const trace = (window as any).__tableEnterViewportTrace as Array<{ scrollTop: number }>;
      return {
        text: editor.getText(),
        rowCount: document.querySelectorAll('.meo-md-html-table tbody tr').length,
        selectionLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
        scrollTop: editor.view.scrollDOM.scrollTop,
        scrollSpan: Math.max(...trace.map((sample) => sample.scrollTop))
          - Math.min(...trace.map((sample) => sample.scrollTop)),
        activeTag: active?.tagName ?? null
      };
    });
    if (
      afterEnter.text !== beforeEnterText || afterEnter.rowCount !== 2
      || afterEnter.selectionLine !== 31 || afterEnter.activeTag === 'TEXTAREA'
      || afterEnter.scrollSpan > 2
    ) {
      throw new Error(`Last-row Enter did not leave the table without changing Markdown: ${JSON.stringify({ beforeEnter, afterEnter })}`);
    }

    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table textarea[data-table-row="2"][data-table-col="1"]'
      )!;
      input.focus({ preventScroll: true });
      input.setSelectionRange(0, 0);
    });
    const beforeFinalTab = await page.evaluate(() => ({
      scrollTop: (window as any).__selectionViewportEditor.view.scrollDOM.scrollTop
    }));
    await page.keyboard.press('Tab');
    await waitForFrames(page, 4);
    const afterFinalTab = await page.evaluate(() => {
      const editor = (window as any).__selectionViewportEditor;
      const active = document.activeElement;
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        stayedInFinalCell: active instanceof HTMLTextAreaElement
          && active.dataset.tableRow === '2'
          && active.dataset.tableCol === '1'
      };
    });
    if (
      !afterFinalTab.stayedInFinalCell ||
      Math.abs(afterFinalTab.scrollTop - beforeFinalTab.scrollTop) > 1
    ) {
      throw new Error(`Tab escaped the final table cell: ${JSON.stringify({ beforeFinalTab, afterFinalTab })}`);
    }
    console.log('table selection viewport checks passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
