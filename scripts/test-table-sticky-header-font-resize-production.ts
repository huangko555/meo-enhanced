import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-sticky-font-'));

const build = await Bun.build({
  entrypoints: [path.join(root, 'scripts/test-table-sticky-header-production-entry.ts')],
  outdir: temp,
  target: 'browser',
  format: 'iife',
  naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 600 });
  await page.setContent('<!doctype html><body><div id="app"></div></body>');
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  await page.addStyleTag({ content: `
    :root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;
      --meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;
      --meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;
      --meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}
    html,body{margin:0;height:100%}#app{height:540px}
  ` });
  await page.addScriptTag({ path: path.join(temp, 'bundle.js') });
  const result = await page.evaluate(async () => {
    const harness = (window as any).TableStickyHeaderProductionHarness;
    harness.initializeImageHandling({ postMessage() {} });
    const before = Array.from({ length: 1128 }, (_, index) => `Paragraph ${index + 1}`);
    const rows = Array.from({ length: 10 }, (_, index) => `| Row ${index + 1} | Cell ${index + 1} with some longer content |`);
    const after = Array.from({ length: 50 }, (_, index) => `After table ${index + 1}`);
    const source = [...before, '', '| Column | Content |', '| --- | --- |', ...rows, '', ...after].join('\n');
    const editor = harness.createEditor({
      parent: document.getElementById('app')!, text: source, initialMode: 'live', onApplyChanges() {}
    });
    const wait = async () => {
      for (let index = 0; index < 12; index++) await new Promise(requestAnimationFrame);
    };
    const scroller = editor.view.scrollDOM;
    await wait();
    scroller.scrollTop = editor.view.lineBlockAt(editor.view.state.doc.line(1130).from).top;
    await wait();
    const find = () => document.querySelector<HTMLElement>('.meo-md-html-table-shell');
    const shell = find();
    if (!shell) throw new Error('Table was not mounted');
    scroller.scrollTop += shell.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 70;
    scroller.dispatchEvent(new Event('scroll'));
    await wait();
    const snapshot = (label: string) => {
      const current = find();
      const chrome = current?.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
      const table = current?.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      return {
        label,
        visible: chrome?.classList.contains('is-visible') ?? false,
        owner: chrome?.dataset.tableStickyHeaderOwner ?? null,
        tableTop: table?.getBoundingClientRect().top ?? null,
        tableBottom: table?.getBoundingClientRect().bottom ?? null,
        viewportTop: scroller.getBoundingClientRect().top
      };
    };
    const snapshots = [snapshot('initial')];
    for (const size of [15, 16, 17, 18, 19, 20, 19, 18, 17, 16, 15]) {
      editor.preserveViewport(() => {
        document.documentElement.style.setProperty('--meo-user-editor-font-size', `${size}px`);
      }, true);
      await wait();
      snapshots.push(snapshot(String(size)));
    }
    editor.setText(source, true);
    await wait();
    snapshots.push(snapshot('external presentation'));
    editor.setTableStickyHeaderEnabled(false);
    await wait();
    if (snapshot('disabled').visible) throw new Error('Floating header stayed visible when disabled');
    editor.setTableStickyHeaderEnabled(true);
    await wait();
    snapshots.push(snapshot('enabled again'));
    (window as any).__stickyFontEditor = editor;
    return snapshots;
  });
  const cellPoint = await page.$eval(
    '.meo-md-html-table-shell tbody tr:nth-child(5) td:first-child .meo-md-html-table-cell-preview',
    (preview) => {
      const rect = preview.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
  );
  await page.mouse.click(cellPoint.x, cellPoint.y);
  const cellEditable = await page.evaluate(() => document.activeElement instanceof HTMLTextAreaElement
    && Boolean(document.activeElement.closest('.meo-md-html-table-shell tbody')));
  await page.evaluate(() => (window as any).__stickyFontEditor.destroy());
  const failures = result.filter((entry) => entry.tableTop !== null
    && entry.tableTop < entry.viewportTop
    && entry.tableBottom !== null
    && entry.tableBottom > entry.viewportTop + 50
    && !entry.visible);
  if (failures.length > 0 || !result[0].visible || !cellEditable) {
    throw new Error(`Floating table header disappeared or table cell stopped responding: ${JSON.stringify({ result, failures, cellEditable })}`);
  }
  console.log('table sticky header survives font resizing in long document');
} finally {
  await closeTestBrowser(browser);
  fs.rmSync(temp, { recursive: true, force: true });
}
