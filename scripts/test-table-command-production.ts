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
assert.equal(tablesSource.includes('createTableCommandApplication'), false);
assert.equal(tablesSource.includes('createTableCommandRuntime'), false);
assert.equal(tablesSource.includes('createCodeMirrorTableCommandEffectAdapter'), false);
for (const legacy of [
  'commitMatrix(',
  'markHeaderAlignmentOverride(',
  'view.dispatch({ changes, effects: insertedRowEffect })',
  'view.dispatch({ changes, effects: deletionEffects })'
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

      const sortInput = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-shell:first-of-type tbody textarea'
      )!;
      sortInput.focus();
      sortInput.value = 'sorted-edit';
      sortInput.dispatchEvent(new Event('input', { bubbles: true }));
      pointer(document.querySelector<HTMLButtonElement>(
        '.meo-md-html-table-shell:first-of-type button[title^="Sort selected column"]'
      )!);
      await waitFrames();
      const afterPreview = editor.view.state.doc.toString();
      const apply = document.querySelector<HTMLButtonElement>(
        '.meo-md-html-table-shell:first-of-type .meo-md-html-apply-sort-btn'
      )!;
      const previewVisible = !apply.hidden;
      pointer(apply);
      await waitFrames();
      const afterApply = editor.view.state.doc.toString();
      await editor.undo();
      await waitFrames();
      const afterApplyUndo = editor.view.state.doc.toString();

      const shells = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell'));
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
      return {
        original,
        consumed,
        afterAtomicInsert,
        undoApplied,
        afterAtomicUndo,
        redoApplied,
        afterAtomicRedo,
        afterPreview,
        previewVisible,
        afterApply,
        afterApplyUndo,
        afterRapidMultiTable,
        toolbarCount,
        resizeHandleCount,
        stickyCount,
        detachedConsumed
      };
    });

    assert.equal(result.consumed, true, 'Toolbar pointer command must be consumed synchronously');
    assert.match(result.afterAtomicInsert, /edited/);
    assert.notEqual(result.afterAtomicInsert, result.original);
    assert.equal(result.undoApplied, true);
    assert.equal(result.afterAtomicUndo, result.original, 'pending edit and row insertion must undo together');
    assert.equal(result.redoApplied, true);
    assert.equal(result.afterAtomicRedo, result.afterAtomicInsert);
    assert.match(result.afterPreview, /sorted-edit/);
    assert.equal(result.previewVisible, true);
    assert.notEqual(result.afterApply, result.afterPreview, 'Apply Sort must be the document-writing step');
    assert.equal(result.afterApplyUndo, result.afterPreview, 'Apply Sort must use one native history entry');
    assert.match(result.afterRapidMultiTable, /\| C\s+\| D\s+\|\n\| ---:\s+\| ---\s+\|/);
    assert.equal(result.toolbarCount, 2);
    assert.ok(result.resizeHandleCount >= 4, 'Column Width controls must remain available');
    assert.equal(result.stickyCount, 2, 'Sticky Header lifecycle must remain mounted per table');
    assert.equal(result.detachedConsumed, true, 'detached Toolbar keeps browser-default suppression without reviving Runtime');
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

