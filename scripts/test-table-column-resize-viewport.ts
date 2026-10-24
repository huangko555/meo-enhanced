import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-column-resize-viewport-'));
const tableSelector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table)';

async function frames(page: Page, count = 6): Promise<void> {
  await page.evaluate(async count => {
    for (let index = 0; index < count; index++) await new Promise(requestAnimationFrame);
  }, count);
}

async function setup(page: Page, rowCount: number, editing: 'none' | 'visible' | 'offscreen' = 'none', readingRow = 20): Promise<void> {
  await page.evaluate(({ rowCount }) => {
    (window as any).__resizeEditor?.destroy();
    document.getElementById('app')!.replaceChildren();
    const description = '列宽变化时上方的文字会重新换行，需要让正在阅读的内容保持稳定。'.repeat(3);
    const text = ['# Column resize', '', '| 名称 | 说明 |', '| --- | --- |',
      ...Array.from({ length: rowCount }, (_, index) => `| Row ${index} | ${description} |`), '',
      ...Array.from({ length: 40 }, () => 'After table.')].join('\n');
    (window as any).__resizeEditor = (window as any).EmbeddedInputViewportHarness.createEditor({
      parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
    });
    (window as any).__resizeText = text;
    (window as any).__resizeEditor.scrollToLine(25, 'start');
  }, { rowCount });
  await frames(page, 16);
  await page.evaluate(({ tableSelector, editing, rowCount, readingRow }) => {
    const table = document.querySelector<HTMLTableElement>(tableSelector)!;
    const viewport = table.closest<HTMLElement>('.cm-scroller')!;
    if (rowCount >= 1200) {
      const body = table.tBodies[0]!.getBoundingClientRect();
      viewport.scrollTop += body.top - viewport.getBoundingClientRect().top + body.height * readingRow / rowCount - 100;
      return;
    }
    const row = table.querySelector<HTMLElement>('tbody tr[data-table-body-row="20"]')!;
    if (!row) throw new Error('Reading row was not mounted');
    viewport.scrollTop += row.getBoundingClientRect().top - viewport.getBoundingClientRect().top - 100;
    if (editing !== 'none') {
      const target = table.querySelector<HTMLTextAreaElement>(
        `textarea[data-table-row="${editing === 'visible' ? 22 : 1}"][data-table-col="1"]`
      )!;
      target.focus({ preventScroll: true });
      target.setSelectionRange(0, 0);
    }
  }, { tableSelector, editing, rowCount, readingRow });
  await frames(page, 12);
  await page.evaluate(({ tableSelector, editing }) => {
    const table = document.querySelector<HTMLTableElement>(tableSelector)!;
    const viewport = table.closest<HTMLElement>('.cm-scroller')!;
    const viewportRect = viewport.getBoundingClientRect();
    const sticky = table.closest('.meo-md-html-table-shell')!
      .querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome')!;
    const visibleTop = Math.max(viewportRect.top, sticky.getBoundingClientRect().bottom);
    const anchor = editing === 'visible' ? document.activeElement as HTMLElement
      : Array.from(table.tBodies[0]!.rows).find(row => !row.classList.contains('meo-table-row-gap')
        && row.getBoundingClientRect().bottom > visibleTop && row.getBoundingClientRect().top < viewportRect.bottom)!;
    const probe = { table, viewport, anchor, originalTop: anchor.getBoundingClientRect().top,
      tops: [] as number[], disconnected: false, sampling: true, width: table.rows[0]!.cells[0]!.getBoundingClientRect().width };
    (window as any).__resizeProbe = probe;
    const sample = () => {
      if (!probe.sampling) return;
      probe.tops.push(anchor.getBoundingClientRect().top);
      probe.disconnected ||= !anchor.isConnected;
      requestAnimationFrame(sample);
    };
    sample();
  }, { tableSelector, editing });
}

async function drag(page: Page, deltas: number[], scrollDuringDrag = false): Promise<void> {
  const point = await page.$eval('.meo-md-html-table-sticky-table [data-table-resize-column="0"]', handle => {
    const rect = handle.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) throw new Error('Sticky handle is hidden');
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  try {
    for (const delta of deltas) {
      await page.mouse.move(point.x + delta, point.y);
      await frames(page, 3);
      if (delta === deltas[0]) await frames(page, 28);
    }
    if (scrollDuringDrag) {
      await page.mouse.wheel({ deltaY: 140 });
      await frames(page, 12);
      await page.evaluate(() => { (window as any).__resizeProbe.afterWheel = (window as any).__resizeProbe.viewport.scrollTop; });
      await page.mouse.move(point.x + deltas.at(-1)! + 20, point.y);
      await frames(page, 4);
    }
  } finally {
    await page.mouse.up();
  }
  await frames(page, 28);
}

async function result(page: Page) {
  return page.evaluate(() => {
    const probe = (window as any).__resizeProbe;
    probe.sampling = false;
    return { top: probe.anchor.getBoundingClientRect().top, originalTop: probe.originalTop,
      maximumDrift: Math.max(...probe.tops.map((top: number) => Math.abs(top - probe.originalTop))),
      span: Math.max(...probe.tops) - Math.min(...probe.tops), disconnected: probe.disconnected,
      widthDelta: probe.table.rows[0].cells[0].getBoundingClientRect().width - probe.width,
      textUnchanged: (window as any).__resizeEditor.getText() === (window as any).__resizeText,
      afterWheel: probe.afterWheel, scrollTop: probe.viewport.scrollTop,
      windowed: probe.table.hasAttribute('data-meo-table-windowed') };
  });
}

async function main(): Promise<void> {
  const build = await Bun.build({ entrypoints: [path.join(repoRoot, 'scripts/test-live-embedded-input-viewport-entry.ts')],
    outdir: tempDir, target: 'browser', format: 'iife', naming: 'bundle.js' });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 900, height: 640, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
    await page.addStyleTag({ content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    for (const scene of [
      { rows: 60, editing: 'none', readingRow: 20, deltas: [50, 100, 150, 80, -50] },
      { rows: 60, editing: 'visible', readingRow: 20, deltas: [70, 150, 30, -60] },
      { rows: 60, editing: 'offscreen', readingRow: 20, deltas: [70, 150, 30, -60] },
      { rows: 1200, editing: 'none', readingRow: 20, deltas: [70, 150, 30, -60] },
      { rows: 1200, editing: 'none', readingRow: 600, deltas: [70, 150, 30, -60] },
      { rows: 1200, editing: 'none', readingRow: 1190, deltas: [70, 150, 30, -60] }
    ] as const) {
      await setup(page, scene.rows, scene.editing, scene.readingRow);
      await drag(page, [...scene.deltas]);
      const observed = await result(page);
      console.log(JSON.stringify({ scene, observed }));
      assert.equal(observed.disconnected, false, 'Reading row was unmounted during column resize');
      assert.ok(observed.maximumDrift <= 2, `Column resize shifted the reading anchor: ${JSON.stringify(observed)}`);
      assert.ok(Math.abs(observed.widthDelta) > 20, 'Fixture did not actually resize a column');
      assert.equal(observed.textUnchanged, true);
      assert.equal(observed.windowed, scene.rows >= 1200);
    }
    await setup(page, 60);
    await drag(page, [70], true);
    const scrolled = await result(page);
    assert.ok(Math.abs(scrolled.scrollTop - scrolled.afterWheel) < 2,
      `Column resize fought the user's wheel gesture: ${JSON.stringify(scrolled)}`);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(tempDir, 'column-resize.png') });
    console.log(`table column resize reading viewport passed; screenshot: ${path.join(tempDir, 'column-resize.png')}`);
  } catch (error) { primaryError = error; }
  if (primaryError !== undefined) await closeTestBrowser(browser, primaryError);
  else await closeTestBrowser(browser);
}

await main();
