import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-clipboard-production-'));

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
    await page.setViewport({ width: 900, height: 650 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const original = [
      '| A | B |',
      '| --- | --- |',
      '| **bold** | a\\|b |',
      '| c | d |',
      '',
      '| X |',
      '| --- |',
      '| old |'
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__clipboardEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, original);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell').length === 2);

    const centers = await page.evaluate(() => {
      const cells = document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell:first-of-type tbody .meo-md-html-table-cell-preview');
      return [cells[0], cells[3]].map((cell) => {
        const rect = cell.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      });
    });
    await page.mouse.move(centers[0].x, centers[0].y);
    await page.mouse.down();
    await page.mouse.move(centers[1].x, centers[1].y, { steps: 4 });
    await page.mouse.up();

    const pasteResult = await page.evaluate(() => {
      const clipboard = new DataTransfer();
      const copy = new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true });
      document.dispatchEvent(copy);
      const destination = document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell')[1]
        .querySelector<HTMLTextAreaElement>('tbody textarea')!;
      destination.focus();
      const paste = new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true });
      destination.dispatchEvent(paste);
      return {
        copyPrevented: copy.defaultPrevented,
        pastePrevented: paste.defaultPrevented,
        types: Array.from(clipboard.types),
        history: (window as any).__clipboardEditor.getHistoryDepth()
      };
    });
    const expected = [
      '| A | B |',
      '| --- | --- |',
      '| **bold** | a\\|b |',
      '| c | d |',
      '',
      '| X |  |',
      '| --- | --- |',
      '| **bold** | a\\|b |',
      '| c | d |'
    ].join('\n');
    await page.waitForFunction((text) => (window as any).__clipboardEditor.view.state.doc.toString() === text, {}, expected);
    assert.equal(pasteResult.copyPrevented, true);
    assert.equal(pasteResult.pastePrevented, true);
    assert.ok(pasteResult.types.includes('application/x-meo-table-cells+json'));
    assert.deepEqual(pasteResult.history, { undo: 1, redo: 0 }, 'cross-table paste must be one history item');
    assert.equal(await page.evaluate(() => (window as any).__clipboardEditor.undo()), true);
    await page.waitForFunction((text) => (window as any).__clipboardEditor.view.state.doc.toString() === text, {}, original);

    const external = await page.evaluate(() => {
      const destination = document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell')[1]
        .querySelector<HTMLTextAreaElement>('tbody textarea')!;
      destination.focus();
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', 'u|v\tw\nx\ty');
      const paste = new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true });
      destination.dispatchEvent(paste);
      return paste.defaultPrevented;
    });
    assert.equal(external, true);
    await page.waitForFunction(() => (window as any).__clipboardEditor.view.state.doc.toString().includes('| u\\|v | w |\n| x | y |'));

    const ordinary = await page.evaluate(() => {
      const destination = document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell')[1]
        .querySelector<HTMLTextAreaElement>('tbody textarea')!;
      const clipboard = new DataTransfer();
      clipboard.setData('text/plain', 'ordinary\nparagraph');
      const paste = new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true });
      destination.dispatchEvent(paste);
      return paste.defaultPrevented;
    });
    assert.equal(ordinary, false, 'ordinary multiline text must remain a native cell paste');
    await page.evaluate(() => (window as any).__clipboardEditor.destroy());
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log('table clipboard production checks passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
