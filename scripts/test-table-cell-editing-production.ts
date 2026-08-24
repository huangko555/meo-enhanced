import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-cell-editing-'));
const wrappedCell = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const source = `| A | B |\n| --- | --- |\n| ${wrappedCell} | two |\n| three | four |`;

async function waitForTable(page: any) {
  await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell tbody textarea').length === 4);
}

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
    await page.setViewport({ width: 900, height: 500 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-caret:#e6edf3; --meo-semantic-tableBorder:#474b50; --meo-semantic-tableSelectionBorder:#79b8ff; }' });
    await page.addStyleTag({ content: '.cm-editor .meo-md-html-table { width: 240px !important; table-layout: fixed !important; } .cm-editor .meo-md-html-table :is(th, td) { width: 120px !important; max-width: 120px !important; }' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((text) => {
      (window as any).__tableCellEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, source);
    await waitForTable(page);

    const first = 'tbody tr:first-child td:first-child textarea';
    const second = 'tbody tr:first-child td:nth-child(2) textarea';
    const last = 'tbody tr:nth-child(2) td:nth-child(2) textarea';
    const wrappedMetrics = await page.evaluate((selector) => {
      const input = document.querySelector<HTMLTextAreaElement>(selector)!;
      const rect = input.getBoundingClientRect();
      return { height: rect.height, lineHeight: Number.parseFloat(getComputedStyle(input).lineHeight) };
    }, first);
    if (wrappedMetrics.height < wrappedMetrics.lineHeight * 2.5) {
      throw new Error(`Narrow production cell did not wrap onto visual lines: ${JSON.stringify(wrappedMetrics)}`);
    }
    await page.click(first, { offset: { x: 18, y: wrappedMetrics.lineHeight * 1.5 } });
    await page.keyboard.press('ArrowUp');
    const wrappedArrowUp = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return { row: active?.dataset.tableRow, col: active?.dataset.tableCol };
    });
    if (wrappedArrowUp.row !== '1' || wrappedArrowUp.col !== '0') {
      throw new Error(`ArrowUp escaped from the second visual line: ${JSON.stringify(wrappedArrowUp)}`);
    }
    await page.click(first, { offset: { x: 18, y: wrappedMetrics.lineHeight * 0.5 } });
    await page.keyboard.press('ArrowUp');
    const firstVisualLineTarget = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return { row: active?.dataset.tableRow, col: active?.dataset.tableCol };
    });
    if (firstVisualLineTarget.row !== '0' || firstVisualLineTarget.col !== '0') {
      throw new Error(`ArrowUp did not cross from the first visual line: ${JSON.stringify(firstVisualLineTarget)}`);
    }
    await page.click(first, { offset: { x: 18, y: wrappedMetrics.height - wrappedMetrics.lineHeight * 0.5 } });
    await page.keyboard.press('ArrowDown');
    const lastVisualLineTarget = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return { row: active?.dataset.tableRow, col: active?.dataset.tableCol };
    });
    if (lastVisualLineTarget.row !== '2' || lastVisualLineTarget.col !== '0') {
      throw new Error(`ArrowDown did not cross from the last visual line: ${JSON.stringify(lastVisualLineTarget)}`);
    }

    await page.click(first);
    await page.keyboard.press('Tab');
    const tabTarget = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return active ? { row: active.dataset.tableRow, col: active.dataset.tableCol } : null;
    });
    if (tabTarget?.row !== '1' || tabTarget.col !== '1') throw new Error(`Tab did not select adjacent cell: ${JSON.stringify(tabTarget)}`);
    await page.keyboard.down('Shift');
    await page.keyboard.press('Tab');
    await page.keyboard.up('Shift');
    const shiftTabTarget = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return active ? { row: active.dataset.tableRow, col: active.dataset.tableCol } : null;
    });
    if (shiftTabTarget?.row !== '1' || shiftTabTarget.col !== '0') throw new Error(`Shift+Tab did not select preceding cell: ${JSON.stringify(shiftTabTarget)}`);

    await page.click(last);
    await page.keyboard.press('Tab');
    const lastTabState = await page.evaluate(() => ({
      rows: document.querySelectorAll('.meo-md-html-table-shell tbody tr').length,
      text: (window as any).__tableCellEditor.getText()
    }));
    if (lastTabState.rows !== 2 || lastTabState.text !== source) throw new Error(`Last-cell Tab changed Markdown: ${JSON.stringify(lastTabState)}`);

    await page.click(second);
    await page.keyboard.press('End');
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await page.keyboard.type('continued');
    await page.waitForFunction(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return active?.value.includes('<br>\ncontinued') ?? false;
    });
    await page.keyboard.press('ArrowLeft');
    const arrowState = await page.evaluate(() => {
      const active = document.activeElement as HTMLTextAreaElement | null;
      return { sameCell: active?.dataset.tableRow === '1' && active.dataset.tableCol === '1', caret: active?.selectionStart };
    });
    if (!arrowState.sameCell || arrowState.caret === null) throw new Error(`Ordinary ArrowLeft was stolen: ${JSON.stringify(arrowState)}`);

    const beforeEscapeDepth = await page.evaluate(() => (window as any).__tableCellEditor.getHistoryDepth());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => (window as any).__tableCellEditor.getText().includes('continued'));
    const escaped = await page.evaluate(() => ({
      text: (window as any).__tableCellEditor.getText(),
      active: document.activeElement?.tagName ?? '',
      depth: (window as any).__tableCellEditor.getHistoryDepth()
    }));
    if (escaped.active === 'TEXTAREA' || escaped.depth.undo !== beforeEscapeDepth.undo + 1) {
      throw new Error(`Escape did not commit exactly once and exit: ${JSON.stringify({ beforeEscapeDepth, escaped })}`);
    }
    const undo = await page.evaluate(() => (window as any).__tableCellEditor.undo());
    await page.waitForFunction(() => !(window as any).__tableCellEditor.getText().includes('continued'));
    const redo = await page.evaluate(() => (window as any).__tableCellEditor.redo());
    await page.waitForFunction(() => (window as any).__tableCellEditor.getText().includes('continued'));
    if (!undo || !redo) throw new Error('Escape commit did not use the shared editor history');

    await page.click(first);
    await page.keyboard.press('End');
    await page.keyboard.type(' pending');
    await page.evaluate(() => (window as any).__tableCellEditor.setText('| A | B |\n| --- | --- |\n| external | kept |'));
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('tbody textarea')?.value === 'external');
    const external = await page.evaluate(() => (window as any).__tableCellEditor.getText());
    if (external !== '| A | B |\n| --- | --- |\n| external | kept |') throw new Error(`Late cell timer overwrote external text: ${external}`);

    await page.click('tbody tr:first-child td:first-child textarea');
    await page.keyboard.press('End');
    await page.keyboard.type(' mode');
    await page.evaluate(() => (window as any).__tableCellEditor.setMode('source'));
    await page.waitForFunction(() => !document.querySelector('.meo-md-html-table-shell'));
    const sourceModeText = await page.evaluate(() => (window as any).__tableCellEditor.getText());
    if (!sourceModeText.includes('external mode')) throw new Error(`Mode transition lost pending cell intent: ${sourceModeText}`);

    await page.evaluate(() => (window as any).__tableCellEditor.destroy());
    console.log('table cell editing production checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
