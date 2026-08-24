import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-cell-selection-'));
const source = [
  '| A&B | <tag> |',
  '| --- | --- |',
  '| **bold &** <img src=x onerror=alert(1)> | apostrophe\'s |',
  '| r2a | r2b |',
  '',
  'outside',
  '',
  '| C | D |',
  '| --- | --- |',
  '| c1 | d1 |',
  '| c2 | d2 |'
].join('\n');

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
    await page.setViewport({ width: 1000, height: 700 });
    await page.setContent('<!doctype html><button id="outside">outside</button><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((text) => {
      (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, source);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell').length === 2);
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell').forEach((shell, index) => {
        shell.dataset.testTable = String(index);
      });
    });

    const rect = async (selector: string) => {
      const value = await page.$eval(selector, (element) => {
        const box = element.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      });
      return value;
    };
    const drag = async (from: string, to: string, hold = false) => {
      const start = await rect(from);
      const end = await rect(to);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 4 });
      const selected = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (selected <= 1) throw new Error(`drag ${from} -> ${to} selected ${selected} cells`);
      if (!hold) await page.mouse.up();
    };

    const first = '.meo-md-html-table-shell[data-test-table="0"] tbody tr:first-child td:first-child .meo-md-html-table-cell-preview';
    const last = '.meo-md-html-table-shell[data-test-table="0"] tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview';
    await drag(first, last);
    const persisted = await page.evaluate(() => ({
      count: document.querySelectorAll('.meo-md-html-table-cell-selected').length,
      active: document.activeElement?.tagName
    }));
    if (persisted.count !== 4 || persisted.active !== 'TABLE') {
      throw new Error(`pointerup did not persist the visible rectangle: ${JSON.stringify(persisted)}`);
    }

    await page.evaluate(() => {
      (window as any).__selectionClipboard = null;
      document.addEventListener('copy', (event) => {
        (window as any).__selectionClipboard = {
          types: Array.from(event.clipboardData?.types ?? []),
          plain: event.clipboardData?.getData('text/plain') ?? '',
          html: event.clipboardData?.getData('text/html') ?? ''
        };
      }, { capture: true, once: true });
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyC');
    await page.keyboard.up('Control');
    const copied = await page.evaluate(() => (window as any).__selectionClipboard);
    const expectedPlain = '**bold &** <img src=x onerror=alert(1)>\tapostrophe\'s\nr2a\tr2b';
    const expectedHtml = '<table><tr><td><strong>bold &amp;</strong> &lt;img src=x onerror=alert(1)&gt;</td><td>apostrophe&#39;s</td></tr><tr><td>r2a</td><td>r2b</td></tr></table>';
    if (copied?.plain !== expectedPlain || copied?.html !== expectedHtml || !copied.types.includes('text/plain') || !copied.types.includes('text/html')) {
      throw new Error(`Ctrl+C clipboard payload was incomplete: ${JSON.stringify(copied)}`);
    }

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    const sameCell = await rect(`${first} [data-meo-source-from]`);
    await page.mouse.move(sameCell.x - 8, sameCell.y);
    await page.mouse.down();
    await page.mouse.move(sameCell.x + 8, sameCell.y, { steps: 4 });
    await page.mouse.up();
    const textSelection = await page.evaluate(() => {
      const input = document.activeElement as HTMLTextAreaElement | null;
      return { tag: input?.tagName, selected: (input?.selectionEnd ?? 0) - (input?.selectionStart ?? 0), cells: document.querySelectorAll('.meo-md-html-table-cell-selected').length };
    });
    if (textSelection.tag !== 'TEXTAREA' || textSelection.selected < 1 || textSelection.cells !== 0) {
      throw new Error(`same-cell drag did not prefer ordinary text: ${JSON.stringify(textSelection)}`);
    }
    await page.click('#outside');
    await page.waitForFunction(() => document.activeElement?.id === 'outside');
    await page.waitForFunction((selector) => {
      const preview = document.querySelector<HTMLElement>(selector);
      return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
    }, {}, first);
    await drag(last, first);
    const reverseCount = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
    if (reverseCount !== 4) throw new Error(`reverse drag selected ${reverseCount} cells`);
    await page.click('#outside');
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    await page.waitForFunction((selector) => {
      const preview = document.querySelector<HTMLElement>(selector);
      return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
    }, {}, first);

    const secondFirst = '.meo-md-html-table-shell[data-test-table="1"] tbody tr:first-child td:first-child .meo-md-html-table-cell-preview';
    const secondLast = '.meo-md-html-table-shell[data-test-table="1"] tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview';
    await drag(first, last);
    await drag(secondFirst, secondLast);
    const tableSelections = await page.$$eval('.meo-md-html-table-shell', (shells) => shells.map((shell) => shell.querySelectorAll('.meo-md-html-table-cell-selected').length));
    if (JSON.stringify(tableSelections) !== JSON.stringify([0, 4])) {
      throw new Error(`cross-table transfer retained the old owner: ${JSON.stringify(tableSelections)}`);
    }

    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      await page.keyboard.press('Escape');
      await drag(first, last, true);
      await page.evaluate((eventType) => {
        document.querySelector('.meo-md-html-table-shell table')!.dispatchEvent(new PointerEvent(eventType, {
          pointerId: 2, bubbles: true, cancelable: true
        }));
      }, type);
      const afterForeignBoundary = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (afterForeignBoundary !== 4) {
        throw new Error(`${type} from a non-owner cleared ${afterForeignBoundary} selected cells`);
      }
      await page.mouse.up();
      const afterOwnerUp = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (afterOwnerUp !== 4) throw new Error(`${type} from a non-owner prevented owner pointerup persistence`);

      await page.keyboard.press('Escape');
      await drag(first, last, true);
      await page.evaluate((eventType) => {
        document.querySelector('.meo-md-html-table-shell table')!.dispatchEvent(new PointerEvent(eventType, {
          pointerId: 1, bubbles: true, cancelable: true
        }));
      }, type);
      await page.mouse.up();
      const count = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (count !== 0) throw new Error(`${type} retained ${count} selected cells`);
    }

    await drag(first, last);
    await page.evaluate((text) => {
      (window as any).__externalTable = document.querySelector('.meo-md-html-table-shell[data-test-table="0"] table');
      (window as any).__selectionEditor.setText(text);
    }, source);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    const externalPresentation = await page.evaluate(() => ({
      sameTable: (window as any).__externalTable === document.querySelector('.meo-md-html-table-shell[data-test-table="0"] table'),
      connected: Boolean((window as any).__externalTable?.isConnected)
    }));
    if (!externalPresentation.sameTable || !externalPresentation.connected) {
      throw new Error(`same-text external presentation replaced table DOM: ${JSON.stringify(externalPresentation)}`);
    }

    await drag(first, last);
    await page.evaluate(() => {
      (window as any).__replacementTable = document.querySelector('.meo-md-html-table-shell[data-test-table="0"] table');
      (window as any).__selectionEditor.setText('| X | Y |\n| --- | --- |\n| one | two |');
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('tbody textarea')?.value === 'one');
    const replacement = await page.evaluate(() => ({
      oldConnected: Boolean((window as any).__replacementTable?.isConnected),
      replaced: (window as any).__replacementTable !== document.querySelector('.meo-md-html-table-shell table')
    }));
    if (replacement.oldConnected || !replacement.replaced) {
      throw new Error(`replacement lifecycle was not distinct: ${JSON.stringify(replacement)}`);
    }

    await drag(
      '.meo-md-html-table-shell tbody tr:first-child td:first-child .meo-md-html-table-cell-preview',
      '.meo-md-html-table-shell tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview'
    );
    await page.evaluate(() => (window as any).__selectionEditor.setMode('source'));
    await page.waitForFunction(() => !document.querySelector('.meo-md-html-table-shell'));
    await page.evaluate(() => (window as any).__selectionEditor.setMode('live'));
    await page.waitForFunction(() => document.querySelector('.meo-md-html-table-shell'));
    const afterMode = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
    if (afterMode !== 0) throw new Error(`mode replacement restored ${afterMode} stale selected cells`);

    await drag(
      '.meo-md-html-table-shell tbody tr:first-child td:first-child .meo-md-html-table-cell-preview',
      '.meo-md-html-table-shell tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview',
      true
    );
    const afterDestroy = await page.evaluate(() => {
      const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
      (window as any).__lateTable = table;
      (window as any).__selectionEditor.destroy();
      const before = table.outerHTML;
      const clipboard = new DataTransfer();
      const copy = new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true });
      document.dispatchEvent(copy);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        table.dispatchEvent(new PointerEvent(type, { pointerId: 1, bubbles: true, cancelable: true }));
      }
      return {
        connected: table.isConnected,
        selected: table.querySelectorAll('.meo-md-html-table-cell-selected').length,
        unchanged: table.outerHTML === before,
        copyPrevented: copy.defaultPrevented,
        clipboardTypes: Array.from(clipboard.types),
        retainedCapture: table.hasPointerCapture?.(1) ?? false
      };
    });
    await page.mouse.up();
    if (afterDestroy.connected || afterDestroy.selected || !afterDestroy.unchanged || afterDestroy.copyPrevented || afterDestroy.clipboardTypes.length || afterDestroy.retainedCapture) {
      throw new Error(`destroy leaked late pointer/copy effects: ${JSON.stringify(afterDestroy)}`);
    }
    console.log('table cell selection production checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
