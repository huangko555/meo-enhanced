import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const entryPath = path.join(repoRoot, 'scripts', 'test-table-command-runtime-entry.ts');
const entrySource = fs.readFileSync(entryPath, 'utf8');
for (const forbidden of [
  '../webview/src/editor.ts', '../webview/src/index.ts', '../webview/src/helpers/tables'
]) assert.equal(entrySource.includes(forbidden), false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-command-runtime-'));
const initial = [
  '| A | B |', '| --- | --- |', '| 2 | beta |', '| 1 | alpha |', '',
  '| C | D |', '| --- | --- |', '| keep | second |'
].join('\n');

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [entryPath], outdir: tempDir, target: 'browser', format: 'iife', naming: 'candidate.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="editor"></div><div id="tables"></div>');
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });
    await page.evaluate((text) => (window as any).__tableCommandCandidate.initialize(text), initial);

    const click = async (table: number, command: string) => {
      await page.evaluate(({ table, command }) => {
        document.querySelector<HTMLElement>(
          `[data-table-id="table-${table}"] [data-command="${command}"]`
        )!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      }, { table, command });
      await page.evaluate(() => (window as any).__tableCommandCandidate.waitIdle());
    };
    const snapshot = () => page.evaluate(() => (window as any).__tableCommandCandidate.snapshot());

    await page.evaluate(() => {
      const cell = document.querySelector<HTMLElement>('[data-table-id="table-1"] td[data-row="1"][data-col="0"]')!;
      cell.focus();
      cell.textContent = '20';
      cell.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '0' }));
    });
    await click(1, 'insert-row-below');
    const afterInsert = await snapshot();
    assert.equal(afterInsert.transactions, 1, 'pending edit + row insertion must dispatch one transaction');
    assert.ok(afterInsert.text.includes('| 20 | beta |\n|  |  |'));
    assert.equal(afterInsert.provenance.insertedRows.length, 1);
    assert.equal(afterInsert.activeText, '20');
    assert.equal(await page.evaluate(() => (window as any).__tableCommandCandidate.undo()), true);
    assert.equal((await snapshot()).text, initial);
    assert.equal(await page.evaluate(() => (window as any).__tableCommandCandidate.redo()), true);
    assert.equal((await snapshot()).text, afterInsert.text);

    await page.evaluate(() => {
      const cell = document.querySelector<HTMLElement>('[data-table-id="table-1"] td[data-row="1"][data-col="0"]')!;
      cell.textContent = '30';
      cell.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '0' }));
    });
    const beforePreviewTransactions = (await snapshot()).transactions;
    await click(1, 'preview-sort');
    const previewed = await snapshot();
    assert.equal(previewed.transactions, beforePreviewTransactions + 1, 'preview must flush pending edits once');
    assert.ok(previewed.text.includes('| 30 | beta |'));
    assert.equal(previewed.preview.length, 1);
    const sourceBeforeApply = previewed.text;
    await click(1, 'preview-sort');
    const previewedAgain = await snapshot();
    assert.equal(previewedAgain.transactions, previewed.transactions, 'continuous preview must not add history');
    await click(1, 'apply-sort');
    const applied = await snapshot();
    assert.equal(applied.transactions, previewed.transactions + 1);
    assert.equal(applied.preview.length, 0);
    assert.notEqual(applied.text, sourceBeforeApply);
    assert.equal(await page.evaluate(() => (window as any).__tableCommandCandidate.undo()), true);
    assert.equal((await snapshot()).text, sourceBeforeApply);

    const beforeAlignment = (await snapshot()).text;
    await click(1, 'align-center');
    const afterAlignment = (await snapshot()).text;
    assert.ok(afterAlignment.includes('| :---: | --- |'));
    assert.equal(await page.evaluate(() => (window as any).__tableCommandCandidate.undo()), true);
    assert.equal((await snapshot()).text, beforeAlignment);
    assert.equal(await page.evaluate(() => (window as any).__tableCommandCandidate.redo()), true);
    assert.equal((await snapshot()).text, afterAlignment);
    await click(1, 'insert-column-right');
    const afterColumnInsert = (await snapshot()).text;
    assert.ok(afterColumnInsert.includes('| A |  | B |'));
    assert.equal(await page.evaluate(() => (window as any).__tableCommandCandidate.undo()), true);
    assert.equal((await snapshot()).text, afterAlignment);
    assert.equal(await page.evaluate(() => (window as any).__tableCommandCandidate.redo()), true);
    assert.equal((await snapshot()).text, afterColumnInsert);
    await click(1, 'delete-column');
    assert.ok(!(await snapshot()).text.includes('| A |  | B |'));
    const secondBefore = (await snapshot()).text.split('\n\n')[1];
    await click(1, 'delete-row');
    assert.equal((await snapshot()).text.split('\n\n')[1], secondBefore, 'commands must not cross table scope');
    await click(1, 'delete-row');
    const onlyRow = await snapshot();
    await click(1, 'delete-row');
    assert.equal((await snapshot()).text, onlyRow.text, 'only row deletion must be a no-op');
    await click(1, 'delete-column');
    const onlyColumn = await snapshot();
    await click(1, 'delete-column');
    assert.equal((await snapshot()).text, onlyColumn.text, 'only column deletion must be a no-op');

    await page.evaluate((text) => (window as any).__tableCommandCandidate.externalPresent(text), initial);
    const external = await snapshot();
    assert.equal(external.provenance.insertedRows.length, 0);
    assert.equal(external.provenance.deletedRows.length, 0);

    const rapid = await page.evaluate(async () => {
      const candidate = (window as any).__tableCommandCandidate;
      const target = { tableId: 'table-1', row: 1, column: 0 };
      const first = candidate.dispatch({ type: 'request', command: 'insert-row-above', target, enabled: true });
      const second = candidate.dispatch({ type: 'request', command: 'align-right', target, enabled: true });
      return Promise.all([first, second]);
    });
    assert.deepEqual(rapid, ['changed', 'changed']);

    const beforeDispose = await snapshot();
    await page.evaluate(() => (window as any).__tableCommandCandidate.dispose());
    const afterDispose = await snapshot();
    assert.equal(beforeDispose.applicationStarts, 1);
    assert.equal(beforeDispose.runtimeStarts, 1);
    assert.equal(beforeDispose.adapterStarts, 1);
    assert.equal(beforeDispose.legacyStarts, 0);
    assert.equal(afterDispose.phase, 'disposed');
    assert.equal(afterDispose.reportCount, 0);
    assert.ok(beforeDispose.consumedCount >= 6, 'pointer commands must be consumed synchronously');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table command Runtime + CodeMirror Chromium candidate trace passed');
