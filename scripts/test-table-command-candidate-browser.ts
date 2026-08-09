import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const entryPath = path.join(repoRoot, 'scripts', 'test-table-command-candidate-entry.ts');
const entrySource = fs.readFileSync(entryPath, 'utf8');
assert.equal(entrySource.includes('../webview/src/application/tableCommand'), true);
assert.equal(entrySource.includes('../webview/src/editor.ts'), false);
assert.equal(entrySource.includes('../webview/src/index.ts'), false);
assert.equal(entrySource.includes('../webview/src/helpers/tables'), false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-command-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [entryPath],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'candidate.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <button data-command="insert-row-below">Insert row below</button>
      <button data-command="preview-sort">Preview sort</button>
      <button data-command="delete-column" disabled>Delete column</button>`);
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });

    const result = await page.evaluate(() => {
      const candidate = (window as any).TableCommandCandidate;
      const click = (command: string) => document.querySelector<HTMLButtonElement>(
        `[data-command="${command}"]`
      )!.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));

      click('insert-row-below');
      const structuralId = candidate.state().activeCommandId;
      click('preview-sort');
      candidate.run(candidate.dispatch({
        type: 'commandCompleted', commandId: structuralId + 1, outcome: 'changed'
      }));
      candidate.run(candidate.dispatch({
        type: 'commandCompleted', commandId: structuralId, outcome: 'changed'
      }));

      click('preview-sort');
      const sortId = candidate.state().activeCommandId;
      candidate.run(candidate.dispatch({ type: 'pendingEditsFlushed', commandId: sortId }));
      candidate.run(candidate.dispatch({ type: 'commandCompleted', commandId: sortId, outcome: 'presented' }));

      click('delete-column');
      const beforeDispose = candidate.state();
      candidate.dispatch({ type: 'dispose' });
      candidate.run(candidate.dispatch({ type: 'commandCompleted', commandId: sortId, outcome: 'changed' }));
      return {
        instances: candidate.instances,
        legacyInstances: candidate.legacyInstances,
        effects: candidate.effects(),
        beforeDispose,
        afterDispose: candidate.state()
      };
    });

    assert.equal(result.instances, 1);
    assert.equal(result.legacyInstances, 0);
    assert.deepEqual(result.effects.map((effect: { type: string }) => effect.type), [
      'executeCommand',
      'restoreInteraction',
      'flushPendingEdits',
      'executeCommand',
      'restoreInteraction'
    ]);
    assert.equal(result.effects[0].pendingEdits, 'atomic');
    assert.equal(result.effects[2].tableId, 'candidate-table');
    assert.equal(result.effects[3].pendingEdits, 'flushed');
    assert.deepEqual(result.beforeDispose, { phase: 'idle', activeCommandId: null });
    assert.deepEqual(result.afterDispose, { phase: 'disposed', activeCommandId: null });
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table command Chromium candidate trace passed');
