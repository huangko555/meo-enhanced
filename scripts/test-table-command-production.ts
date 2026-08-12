import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-command-production-'));

const editorSource = fs.readFileSync(path.join(repoRoot, 'webview', 'src', 'editor.ts'), 'utf8');
const tablesSource = fs.readFileSync(path.join(repoRoot, 'webview', 'src', 'helpers', 'tables.ts'), 'utf8');
assert.equal((editorSource.match(/createTableCommandApplication\(/g) ?? []).length, 1);
assert.equal((editorSource.match(/createTableCommandRuntime\(/g) ?? []).length, 1);
assert.equal((editorSource.match(/createCodeMirrorTableCommandEffectAdapter\(/g) ?? []).length, 1);
assert.equal((editorSource.match(/createTableCommandTargetRegistry\(/g) ?? []).length, 1);
assert.equal(tablesSource.includes('createTableCommandApplication'), false);
assert.equal(tablesSource.includes('createTableCommandRuntime'), false);
assert.equal(tablesSource.includes('createCodeMirrorTableCommandEffectAdapter'), false);
assert.equal(tablesSource.includes('createTableCommandTargetRegistry'), false);
for (const legacy of [
  'commitMatrix(',
  'markHeaderAlignmentOverride(',
  'view.dispatch({ changes, effects: insertedRowEffect })',
  'view.dispatch({ changes, effects: deletionEffects })',
  'insertRowAboveTarget(',
  'insertRowBelowTarget(',
  'deleteTargetRow(',
  'insertColumnLeftTarget(',
  'insertColumnRightTarget(',
  'deleteTargetColumn(',
  'sortByColumn(',
  'setColumnAlignment(',
  'applyCurrentSort('
]) {
  assert.equal(tablesSource.includes(legacy), false, `Legacy table command path returned: ${legacy}`);
}
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
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const waitFrames = async (count = 4) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const pointer = (button: HTMLButtonElement) => button.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        bubbles: true,
        cancelable: true
      }));
      const editor = harness.createEditor({
        parent: app,
        text: [
          '| A | B |',
          '| --- | --- |',
          '| one | 2 |',
          '| two | 1 |',
          '',
          '| C | D |',
          '| --- | --- |',
          '| x | y |'
        ].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      await waitFrames();

      const original = editor.view.state.doc.toString();
      const firstInput = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-shell:first-of-type tbody textarea'
      )!;
      firstInput.focus();
      firstInput.value = 'edited';
      firstInput.dispatchEvent(new Event('input', { bubbles: true }));
      const insert = document.querySelector<HTMLButtonElement>(
        '.meo-md-html-table-shell:first-of-type button[title="Insert row below"]'
      )!;
      const consumed = !pointer(insert);
      await waitFrames();
      const afterAtomicInsert = editor.view.state.doc.toString();
      const undoApplied = await editor.undo();
      await waitFrames();
      const afterAtomicUndo = editor.view.state.doc.toString();
      const redoApplied = await editor.redo();
      await waitFrames();
      const afterAtomicRedo = editor.view.state.doc.toString();

      const shells = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell'));
      const toolbarButtons = Array.from(
        shells[0].querySelectorAll<HTMLButtonElement>('.meo-md-html-table-toolbar-btn')
      );
      const toolbarActions = toolbarButtons.map((button) => button.getAttribute('aria-label'));
      const sortingCapabilityCount = toolbarButtons.filter((button) => (
        /\b(?:sort|order|reorder)(?:ing|ed)?\b/i.test([
          button.getAttribute('aria-label'),
          button.title,
          button.textContent,
          button.dataset.action,
          button.dataset.command
        ].filter(Boolean).join(' '))
      )).length;
      const secondInput = shells[1]?.querySelector<HTMLTextAreaElement>('tbody textarea');
      secondInput?.focus();
      pointer(shells[0].querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      pointer(shells[1].querySelector<HTMLButtonElement>('button[title="Align selected column right"]')!);
      await waitFrames();
      const afterRapidMultiTable = editor.view.state.doc.toString();
      const toolbarCount = document.querySelectorAll('.meo-md-html-table-toolbar').length;
      const resizeHandleCount = document.querySelectorAll('.meo-md-html-table-column-resize-handle').length;
      const stickyCount = document.querySelectorAll('.meo-md-html-table-sticky-chrome').length;
      const detachedButton = shells[0].querySelector<HTMLButtonElement>('button[title="Insert row below"]')!;
      editor.destroy();
      const detachedConsumed = !pointer(detachedButton);
      app.replaceChildren();

      const raceEditor = harness.createEditor({
        parent: app,
        text: ['| A | B |', '| --- | --- |', '| one | 1 |', '| two | 2 |'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      await waitFrames();
      pointer(document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      const inputsAfterInsert = Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea'));
      inputsAfterInsert.find((input) => input.value === 'two')!.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0, bubbles: true, cancelable: true
      }));
      pointer(document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!);
      inputsAfterInsert.find((input) => input.value === 'one')!.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0, bubbles: true, cancelable: true
      }));
      await waitFrames();
      const afterQueuedCoordinateChange = raceEditor.view.state.doc.toString();

      pointer(document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      pointer(document.querySelector<HTMLButtonElement>('button[title="Delete column"]')!);
      const externalText = ['| A | B |', '| --- | --- |', '| external | stable |'].join('\n');
      raceEditor.setText(externalText);
      await waitFrames();
      const afterExternalPresentation = raceEditor.view.state.doc.toString();
      raceEditor.destroy();
      return {
        original,
        consumed,
        afterAtomicInsert,
        undoApplied,
        afterAtomicUndo,
        redoApplied,
        afterAtomicRedo,
        toolbarActions,
        sortingCapabilityCount,
        afterRapidMultiTable,
        toolbarCount,
        resizeHandleCount,
        stickyCount,
        detachedConsumed,
        afterQueuedCoordinateChange,
        externalText,
        afterExternalPresentation
      };
    });

    assert.equal(result.consumed, true, 'Toolbar pointer command must be consumed synchronously');
    assert.match(result.afterAtomicInsert, /edited/);
    assert.notEqual(result.afterAtomicInsert, result.original);
    assert.equal(result.undoApplied, true);
    assert.equal(result.afterAtomicUndo, result.original, 'pending edit and row insertion must undo together');
    assert.equal(result.redoApplied, true);
    assert.equal(result.afterAtomicRedo, result.afterAtomicInsert);
    assert.deepEqual(result.toolbarActions, [
      'Insert row above',
      'Insert row below',
      'Delete row',
      'Insert column left',
      'Insert column right',
      'Delete column',
      'Align selected column left',
      'Align selected column center',
      'Align selected column right'
    ], 'the real Table Toolbar must expose every retained structure/alignment command exactly once');
    assert.equal(result.sortingCapabilityCount, 0, 'Table sorting must not have any Toolbar capability');
    assert.match(result.afterRapidMultiTable, /\| C\s+\| D\s+\|\n\| ---:\s+\| ---\s+\|/);
    assert.equal(result.toolbarCount, 2);
    assert.ok(result.resizeHandleCount >= 4, 'Column Width controls must remain available');
    assert.equal(result.stickyCount, 2, 'Sticky Header lifecycle must remain mounted per table');
    assert.equal(result.detachedConsumed, true, 'detached Toolbar keeps browser-default suppression without reviving Runtime');
    assert.match(result.afterQueuedCoordinateChange, /\| one\s+\| 1\s+\|/);
    assert.doesNotMatch(
      result.afterQueuedCoordinateChange,
      /\| two\s+\| 2\s+\|/,
      'queued commands must use the row captured by their request, not the later active cell'
    );
    assert.equal(
      result.afterExternalPresentation,
      result.externalText,
      'external presentation must invalidate queued commands from the previous document scope'
    );
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log('table command production cutover checks passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
