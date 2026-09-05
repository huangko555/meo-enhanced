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
      for (const value of ['pending', 'pending cell']) {
        input.value = value;
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: value
        }));
      }
    }, inputSelector);

    const before = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
    assert.equal(before.tableValue, 'pending cell');
    assert.equal(before.hostRevision.text, initialText, 'pending table cell must still be outside TextDocument');
    assert.equal(before.diskText, initialText);
    assert.equal(before.persistedDraft, null);

    await new Promise((resolve) => setTimeout(resolve, 500));
    const autoSave = await page.evaluate(() => (window as any).__nativeSaveTableFlush.autoSaveIfDirty());
    assert.deepEqual(autoSave, {
      started: true,
      response: {
        type: 'flushDocumentEditsResult',
        requestId: 'native-save-0',
        result: { ok: true, value: { text: expectedText } }
      }
    });
    const after = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
    assert.equal(after.hostRevision.text, expectedText);
    assert.equal(after.diskText, expectedText, 'disk write must happen only after exact TextDocument synchronization');
    assert.equal(after.persistedDraft, null);
    assert.equal(after.mode, before.mode);
    assert.deepEqual(after.top, before.top);
    assert.equal(after.activeTableInput, true, 'controlled commit must restore the focused table input');

    assert.equal(
      await page.evaluate(() => (window as any).__nativeSaveTableFlush.replayHistory('undo')),
      true,
      'one undo must consume the cell edit'
    );
    const undone = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
    assert.equal(undone.hostRevision.text, initialText);
    assert.equal(undone.diskText, expectedText, 'history replay must not silently save');
    assert.equal(undone.tableValue, 'old');
    assert.equal(undone.mode, before.mode);
    assert.deepEqual(undone.top, before.top);

    assert.equal(
      await page.evaluate(() => (window as any).__nativeSaveTableFlush.replayHistory('redo')),
      true,
      'one redo must restore the cell edit'
    );
    const redone = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
    assert.equal(redone.hostRevision.text, expectedText);
    assert.equal(redone.diskText, expectedText);
    assert.equal(redone.tableValue, 'pending cell');
    assert.equal(redone.mode, before.mode);
    assert.deepEqual(redone.top, before.top);

    const concurrentText = expectedText.replace('pending cell', 'input during save');
    const concurrentSave = await page.evaluate((selector) => {
      const save = (window as any).__nativeSaveTableFlush.nativeSave();
      const input = document.querySelector<HTMLTextAreaElement>(selector);
      if (!input) throw new Error('Missing table input during save');
      input.focus();
      input.value = 'input during save';
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: 'input during save'
      }));
      return save;
    }, inputSelector);
    assert.equal(concurrentSave.result.ok, true);
    const concurrent = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
    assert.equal(concurrent.diskText, concurrentText,
      'a table edit collected while reading the save snapshot must reach Host before the flush response');
    assert.equal(concurrent.hostRevision.text, concurrentText);
    assert.equal(concurrent.activeTableInput, true);

    const tableCdp = await page.createCDPSession();
    await page.keyboard.press('End');
    await page.keyboard.type(' prior');
    await tableCdp.send('Input.imeSetComposition', { text: 'pinyin', selectionStart: 6, selectionEnd: 6 });
    await new Promise(resolve => setTimeout(resolve, 300));
    const tablePreedit = await page.evaluate(() => (window as any).__nativeSaveTableFlush.nativeSave());
    const tableBeforeComposition = concurrentText.replace('input during save', 'input during save prior');
    assert.deepEqual(tablePreedit.result, { ok: true, value: { text: tableBeforeComposition } },
      'table preedit must remain outside the save snapshot');
    const composingTable = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
    assert.equal(composingTable.diskText, tableBeforeComposition);
    assert.equal(composingTable.tableValue, 'input during save priorpinyin');
    await tableCdp.send('Input.insertText', { text: '中文' });
    await new Promise(resolve => setTimeout(resolve, 300));
    await page.evaluate(() => (window as any).__nativeSaveTableFlush.nativeSave());
    const committedTable = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
    assert.equal(committedTable.diskText, tableBeforeComposition.replace('prior', 'prior中文'));
    await tableCdp.detach();

    await page.evaluate(() => (window as any).__nativeSaveTableFlush.destroy());
    for (const mode of ['live', 'source']) {
      await page.goto('about:blank');
      await page.setContent('<!doctype html><body><div id="editor"></div></body>');
      await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
      await page.addScriptTag({ path: path.join(tempDir, 'trace.js') });
      await page.evaluate(mode => (window as any).__nativeSaveTableFlush.initialize('text', mode), mode);
      await page.click('.cm-content');
      await page.keyboard.press('End');
      await page.keyboard.type(' committed');
      const cdp = await page.createCDPSession();
      await cdp.send('Input.imeSetComposition', { text: 'pinyin', selectionStart: 6, selectionEnd: 6 });
      await new Promise(resolve => setTimeout(resolve, 180));
      const preeditSave = await page.evaluate(() => (window as any).__nativeSaveTableFlush.nativeSave());
      const composing = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
      assert.equal(composing.hostRevision.text, 'text committed');
      assert.deepEqual(preeditSave.result, { ok: true, value: { text: 'text committed' } },
        `${mode}: saving during IME must preserve preedit and flush only committed text`);
      assert.equal(composing.diskText, 'text committed');
      assert.ok(await page.$eval('.cm-content', node => node.textContent?.includes('pinyin')));
      await cdp.send('Input.insertText', { text: '中文' });
      await new Promise(resolve => setTimeout(resolve, 180));
      await page.evaluate(() => (window as any).__nativeSaveTableFlush.nativeSave());
      const committed = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
      assert.equal(committed.diskText, 'text committed中文');
      assert.equal(committed.hostRevision.text, committed.diskText);
      await cdp.send('Input.imeSetComposition', { text: 'cancel', selectionStart: 6, selectionEnd: 6 });
      await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
      await new Promise(resolve => setTimeout(resolve, 180));
      await page.evaluate(() => (window as any).__nativeSaveTableFlush.nativeSave());
      const cancelled = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
      assert.equal(cancelled.diskText, committed.diskText, `${mode}: cancelled IME must not reach disk`);
      await cdp.detach();
      await page.evaluate(() => (window as any).__nativeSaveTableFlush.destroy());
    }
    for (const block of [
      { text: '```mermaid\ngraph TD\nA --> B\n```', kind: 'mermaid', marker: 'C' },
      { text: '$$\nx = 1\n$$', kind: 'latex-math', marker: '+2' }
    ]) {
      await page.goto('about:blank');
      await page.setContent('<!doctype html><body><div id="editor"></div></body>');
      await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
      await page.addScriptTag({ path: path.join(tempDir, 'trace.js') });
      await page.evaluate(text => (window as any).__nativeSaveTableFlush.initialize(text), block.text);
      await page.click(`.meo-${block.kind}-mode-btn`);
      const selector = `.meo-${block.kind}-source-editor .cm-content`;
      await page.waitForSelector(selector);
      await page.click(selector);
      await page.keyboard.down('Control');
      await page.keyboard.press('End');
      await page.keyboard.up('Control');
      await page.keyboard.type(block.marker);
      const saved = await page.evaluate(() => (window as any).__nativeSaveTableFlush.nativeSave());
      const snapshot = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
      const expected = block.text.replace(/\n([^\n]+)$/, `${block.marker}\n$1`);
      assert.deepEqual(saved.result, { ok: true, value: { text: expected } });
      assert.equal(snapshot.diskText, expected, `${block.kind}: embedded input must reach disk`);
      assert.equal(await page.$eval(selector, node => node === document.activeElement), true,
        'saving must preserve embedded editor focus');
      const cdp = await page.createCDPSession();
      await cdp.send('Input.imeSetComposition', { text: 'pinyin', selectionStart: 6, selectionEnd: 6 });
      await new Promise(resolve => setTimeout(resolve, 180));
      const preeditSave = await page.evaluate(() => (window as any).__nativeSaveTableFlush.nativeSave());
      assert.deepEqual(preeditSave.result, { ok: true, value: { text: expected } },
        `${block.kind}: embedded preedit must not enter the save snapshot`);
      const preedit = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
      assert.equal(preedit.hostRevision.text, expected);
      await cdp.send('Input.insertText', { text: '中文' });
      await new Promise(resolve => setTimeout(resolve, 180));
      await page.evaluate(() => (window as any).__nativeSaveTableFlush.nativeSave());
      const committed = await page.evaluate(() => (window as any).__nativeSaveTableFlush.snapshot());
      assert.equal(committed.diskText, expected.replace(/\n([^\n]+)$/, '中文\n$1'));
      await cdp.detach();
      await page.evaluate(() => (window as any).__nativeSaveTableFlush.destroy());
    }
    console.log('Native save transient input browser checks passed (table, IME, Mermaid, math)');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
