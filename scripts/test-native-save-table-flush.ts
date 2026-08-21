import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-native-save-table-flush-'));
const initialText = '| Name | Value |\n| --- | --- |\n| Alpha | old |';
const expectedText = '| Name | Value |\n| --- | --- |\n| Alpha | pending cell |';

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-native-save-table-flush-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'trace.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 600 });
    await page.setContent('<!doctype html><body><div id="editor"></div></body>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'trace.js') });
    await page.evaluate((text) => (window as any).__nativeSaveTableFlush.initialize(text), initialText);
    const inputSelector =
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea[data-table-col="1"]';
    await page.waitForSelector(inputSelector);
    await page.evaluate((selector) => {
      const input = document.querySelector<HTMLTextAreaElement>(selector);
      if (!input) throw new Error('Missing production table cell editor');
      input.focus();
      input.value = 'pending cell';
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: 'pending cell'
      }));
    }, inputSelector);

    const before = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
    assert.equal(before.tableValue, 'pending cell');
    assert.equal(before.hostRevision.text, initialText, 'pending table cell must still be outside TextDocument');
    assert.equal(before.diskText, initialText);
    assert.equal(before.persistedDraft, null);

    const response = await page.evaluate(() => (window as any).__nativeSaveTableFlush.nativeSave());
    assert.deepEqual(response, {
      type: 'flushDocumentEditsResult',
      requestId: 'native-save-0',
      result: { ok: true, value: { text: expectedText } }
    });
    const after = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
    assert.equal(after.hostRevision.text, expectedText);
    assert.equal(after.diskText, expectedText, 'disk write must happen only after exact TextDocument synchronization');
    assert.equal(after.persistedDraft, null);
    assert.equal(after.mode, before.mode);
    assert.deepEqual(after.top, before.top);
    assert.equal(after.history.undo, before.history.undo + 1, 'flush adds only the pending cell edit transaction');
    assert.equal(after.history.redo, before.history.redo);

    await page.evaluate(() => (window as any).__nativeSaveTableFlush.destroy());
    console.log('Native save pending table flush browser trace passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
