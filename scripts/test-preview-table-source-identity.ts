import assert from 'node:assert/strict';
import { browser, server, open, frames, assertStablePaint } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

let primary: unknown;
try {
  for (const windowed of process.argv.includes('--windowed-only') ? [true] : [false, true]) {
    const text = '# Table identity\n\nIntro-target ' + 'Reading context '.repeat(100)
      + '\n\n| Name | Value |\n| --- | --- |\n| first | **untouched** <kbd>Key</kbd> $x^2$ [^n] |\n| second | stable |\n| third | stable |\n\n'
      + 'Trailing paragraph.\n\n'.repeat(windowed ? 4100 : 30) + '[^n]: **Note** content.\n';
    const page = await browser.newPage(), host = await open(page, text);
    try {
      await page.click('.source-preview-button');
      await page.waitForFunction(() => {
        const host = document.querySelector<HTMLElement>('.preview-host');
        return host && !host.hidden && !host.inert && host.style.visibility !== 'hidden'
          && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('tbody tr');
      });
      await page.click('.source-preview-scroll-sync-button');
      assert.equal(await page.$eval('.source-preview-scroll-sync-button', element => element.getAttribute('aria-pressed')), 'false');
      const position = text.indexOf('Intro-target') + 5;
      await page.evaluate(position => {
        const view = (document.querySelector('.editor-host > .cm-editor .cm-content') as any).cmTile.root.view;
        view.dispatch({ selection: { anchor: position }, scrollIntoView: true }); view.focus();
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const row = doc.querySelector<HTMLTableRowElement>('tbody tr')!;
        // The edited paragraph must be above the independent reading viewport.
        // Growth inside a visible paragraph is a legitimate content reflow.
        doc.scrollingElement!.scrollTop += row.getBoundingClientRect().top - 50;
      }, position);
      const box = await page.$eval('.preview-frame', element => { const r = element.getBoundingClientRect(); return { x: r.left + 150, y: r.top + 180 }; });
      await page.mouse.move(box.x, box.y); await page.mouse.wheel({ deltaY: 1 }); await frames(page, 16);
      const baseline = await page.evaluate(() => {
        const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!, doc = frame.contentDocument!;
        const row = doc.querySelector<HTMLTableRowElement>('tbody tr')!; (window as any).__prefixRow = row;
        (window as any).__prefixMath = row.querySelector('.meo-export-math-inline');
        const table = row.closest('table')!, rect = table.getBoundingClientRect(), frameRect = frame.getBoundingClientRect();
        return { top: row.getBoundingClientRect().top, widths: [...row.cells].map(cell => cell.getBoundingClientRect().width),
          clip: { left: Math.ceil(frameRect.left + rect.left + 4), top: Math.ceil(frameRect.top + row.getBoundingClientRect().top + 4),
            width: Math.floor(rect.width - 8), height: Math.floor(rect.bottom - row.getBoundingClientRect().top - 8) } };
      });
      const insert = '\n\nFresh paragraph.\n\n';
      let paintError: unknown;
      try {
        await assertStablePaint(page, baseline.clip, async () => {
          await page.keyboard.type(insert, { delay: 20 }); await new Promise(resolve => setTimeout(resolve, 900));
        }, `Preview-table-source-prefix-windowed-${windowed}`);
      } catch (error) { paintError = error; }
      const after = await page.evaluate(() => {
        const row = (window as any).__prefixRow as HTMLTableRowElement;
        return { connected: row.isConnected, mathConnected: (window as any).__prefixMath?.isConnected, top: row.getBoundingClientRect().top,
          widths: [...row.cells].map(cell => cell.getBoundingClientRect().width) };
      });
      if (paintError) { console.error(JSON.stringify({ windowed, baseline, after })); throw paintError; }
      assert.ok(after.connected, `Unchanged ordinary table rows must survive new preceding blocks (windowed ${windowed})`);
      assert.equal(after.mathConnected, true, 'An unchanged cell formula keeps its original DOM across source-line changes');
      assert.ok(Math.abs(after.top - baseline.top) <= 1);
      assert.deepEqual(after.widths, baseline.widths);
      assert.equal(host.readHost(), text.slice(0, position) + insert + text.slice(position));
      assert.deepEqual(host.errors, []);
      console.log(`Preview table source identity: new preceding paragraphs retain original table DOM, columns and unchanged paints (windowed ${windowed})`);
    } finally { host.dispose(); await page.close(); }
  }
} catch (error) { primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
