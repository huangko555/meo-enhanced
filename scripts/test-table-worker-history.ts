import assert from 'node:assert/strict';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

const text = '# Table Worker history\n\n| Name | Value |\n| --- | --- |\n'
  + Array.from({ length: 1600 }, (_, row) => `| Row ${row} | **formatted** ${row % 53 === 0 ? 'wrapped content '.repeat(30) : row} |\n`).join('')
  + '\nAfter table.\n';
let primary: unknown;
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1720, height: 1020 });
  const host = await open(page, text, false, 'live');
  try {
    for (const mode of ['preview', 'live']) {
      await page.click(`button[data-mode="${mode}"]`);
      await page.waitForFunction(mode => document.querySelector('#app')?.getAttribute('data-mode') === mode
        && !document.querySelector('button[data-mode][aria-busy="true"]'), {}, mode);
      await frames(page);
    }
    await page.click('table[data-meo-table-windowed] td[data-table-row="1"][data-table-col="0"]');
    await page.keyboard.press('Home');
    const digits = '1234567890'.repeat(6), edited = text.replace('| Row 0 |', `| ${digits}Row 0 |`);
    await page.keyboard.type(digits, { delay: 15 });
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(host.readHost(), edited);
    for (const [key, expected, value] of [['z', text, 'Row 0'], ['y', edited, digits + 'Row 0'], ['z', text, 'Row 0']]) {
      await page.evaluate(() => {
        const scope = window as any; scope.historyInput = document.activeElement; scope.historyFrames = [];
        const sample = () => { const input = scope.historyInput as HTMLTextAreaElement;
          scope.historyFrames.push({ connected: input.isConnected, focused: document.activeElement === input });
          scope.historyFrame = requestAnimationFrame(sample); };
        scope.historyFrame = requestAnimationFrame(sample);
      });
      await page.keyboard.down('Control'); await page.keyboard.press(key!); await page.keyboard.up('Control');
      await new Promise(resolve => setTimeout(resolve, 1000)); await frames(page);
      const result = await page.evaluate(() => {
        const scope = window as any; cancelAnimationFrame(scope.historyFrame);
        return { frames: scope.historyFrames as Array<{ connected: boolean; focused: boolean }>,
          value: (document.activeElement as HTMLTextAreaElement)?.value, caret: (document.activeElement as HTMLTextAreaElement)?.selectionStart };
      });
      assert.equal(host.readHost(), expected);
      assert.ok(result.frames.length > 10 && result.frames.every(frame => frame.connected && frame.focused),
        `Content-only table history must keep its input through actual Worker preparation: ${JSON.stringify(result)}`);
      assert.equal(result.value, value);
      assert.equal(result.caret, key === 'z' ? 0 : digits.length, 'History restores the source insertion point, rather than clamping an old caret to the cell end');
    }
    await page.keyboard.down('Control'); await page.keyboard.press('y'); await page.keyboard.up('Control');
    await frames(page, 2);
    await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
    await page.keyboard.type('7');
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(host.readHost(), text.replace('| Row 0 |', '| 7Row 0 |'), 'The first digit immediately after Undo must reach the restored cell');
    assert.deepEqual(host.errors, []);
    console.log('Table Worker history: original native input remains usable through Ctrl+Z/Ctrl+Y and asynchronous syntax/context publication');
  } finally { host.dispose(); await page.close(); }
} catch (error) { primary = error; throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
