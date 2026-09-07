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
      const waitUntil = async (predicate: () => boolean, label: string) => {
        if (predicate()) return;
        await new Promise<void>((resolve, reject) => {
          const observer = new MutationObserver(check);
          const timeout = window.setTimeout(() => finish(() => reject(new Error(`Timed out waiting for ${label}`))), 5_000);
          const finish = (complete: () => void) => {
            observer.disconnect();
            document.removeEventListener('focusin', check, true);
            document.removeEventListener('scroll', check, true);
            window.clearTimeout(timeout);
            complete();
          };
          function check() {
            if (predicate()) finish(resolve);
          }
          observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
          document.addEventListener('focusin', check, true);
          document.addEventListener('scroll', check, true);
          queueMicrotask(check);
        });
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
      await waitUntil(() => document.querySelectorAll('.meo-md-html-table-shell').length === 2, 'two production tables');

      const original = editor.view.state.doc.toString();
      const firstInput = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-shell:first-of-type tbody textarea'
      )!;
      firstInput.focus();
      firstInput.select();
      document.execCommand('insertText', false, 'edited');
      const contextLayout = (() => {
        const shell = firstInput.closest<HTMLElement>('.meo-md-html-table-shell')!;
        const trigger = shell.querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger')!;
        const menu = shell.querySelector<HTMLElement>('.meo-md-html-table-context-menu')!;
        const heightBefore = shell.getBoundingClientRect().height;
        pointer(trigger);
        const button = menu.querySelector<HTMLButtonElement>('.meo-md-html-table-context-btn')!;
        const triggerRect = trigger.getBoundingClientRect();
        const shellRect = shell.getBoundingClientRect();
        const wrapRect = shell.querySelector<HTMLElement>('.meo-md-html-table-wrap')!.getBoundingClientRect();
        const result = {
          triggerVisible: getComputedStyle(trigger).visibility,
          triggerInsideViewport: triggerRect.left >= -0.5
            && triggerRect.right <= window.innerWidth + 0.5,
          triggerOutsideTable: triggerRect.right <= wrapRect.left + 0.5,
          tableUsesNormalContentLeft: Math.abs(wrapRect.left - shellRect.left) < 0.5,
          menuVisible: getComputedStyle(menu).display,
          heightBefore,
          heightAfter: shell.getBoundingClientRect().height,
          menuPosition: getComputedStyle(menu).position,
          buttonSize: [button.getBoundingClientRect().width, button.getBoundingClientRect().height],
          preferredColumnWidths: Array.from(
            shell.querySelectorAll<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th'),
            (cell) => cell.getBoundingClientRect().width
          ),
          activePanel: menu.dataset.activePanel,
          visibleLabels: Array.from(
            menu.querySelectorAll('[data-context-panel="root"] .meo-md-html-table-context-btn-label'),
            (label) => label.textContent
          )
        };
        pointer(trigger);
        return result;
      })();
      pointer(document.querySelector<HTMLButtonElement>('.meo-md-html-table-shell:first-of-type .meo-md-html-table-context-trigger')!);
      pointer(document.querySelector<HTMLButtonElement>(
        '.meo-md-html-table-shell:first-of-type [data-context-panel-target="insert"]'
      )!);
      const insert = document.querySelector<HTMLButtonElement>(
        '.meo-md-html-table-shell:first-of-type button[title="Insert row below"]'
      )!;
      const consumed = !pointer(insert);
      await waitUntil(() => editor.view.state.doc.toString().includes('edited'), 'atomic insert');
      await waitUntil(() => Boolean(document.querySelector(
        '.meo-md-html-table-shell:first-of-type.is-context-menu-open .meo-md-html-table-context-menu:not([hidden])'
      )), 'context menu restore after command');
      const menuOpenAfterAtomicInsert = true;
      const afterAtomicInsert = editor.view.state.doc.toString();
      const undoApplied = await editor.undo();
      await waitUntil(() => editor.view.state.doc.toString() === original, 'atomic undo');
      const afterAtomicUndo = editor.view.state.doc.toString();
      const redoApplied = await editor.redo();
      await waitUntil(() => editor.view.state.doc.toString() === afterAtomicInsert, 'atomic redo');
      const afterAtomicRedo = editor.view.state.doc.toString();

      const shells = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell'));
      const contextButtons = Array.from(
        shells[0].querySelectorAll<HTMLButtonElement>('.meo-md-html-table-context-btn[data-command]')
      );
      const contextActions = contextButtons.map((button) => button.getAttribute('aria-label'));
      const sortingCapabilityCount = contextButtons.filter((button) => (
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
      pointer(shells[1].querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger')!);
      pointer(shells[1].querySelector<HTMLButtonElement>('[data-context-panel-target="align"]')!);
      pointer(shells[1].querySelector<HTMLButtonElement>('button[title="Align selected column right"]')!);
      await waitUntil(() => /\| C\s+\| D\s+\|\n\| ---:\s+\| ---\s+\|/.test(editor.view.state.doc.toString()), 'multi-table queue');
      const afterRapidMultiTable = editor.view.state.doc.toString();
      const contextTriggerCount = document.querySelectorAll('.meo-md-html-table-context-trigger').length;
      const contextMenuCount = document.querySelectorAll('.meo-md-html-table-context-menu').length;
      const stickyToolbarBandCount = document.querySelectorAll('.meo-md-html-table-sticky-toolbar-band').length;
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
      await waitUntil(() => document.querySelectorAll('tbody textarea').length === 4, 'race table');
      pointer(document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      const inputsAfterInsert = Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea'));
      inputsAfterInsert.find((input) => input.value === 'two')!.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0, bubbles: true, cancelable: true
      }));
      pointer(document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!);
      inputsAfterInsert.find((input) => input.value === 'one')!.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0, bubbles: true, cancelable: true
      }));
      await waitUntil(() => !raceEditor.view.state.doc.toString().includes('| two | 2 |'), 'queued coordinate command');
      const afterQueuedCoordinateChange = raceEditor.view.state.doc.toString();

      pointer(document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      pointer(document.querySelector<HTMLButtonElement>('button[title="Delete column"]')!);
      const externalText = ['| A | B |', '| --- | --- |', '| external | stable |'].join('\n');
      raceEditor.setText(externalText);
      await waitUntil(() => raceEditor.view.state.doc.toString() === externalText, 'external presentation');
      const afterExternalPresentation = raceEditor.view.state.doc.toString();
      raceEditor.destroy();

      const selectCells = (first: Element, last: Element, pointerId: number) => {
        const firstRect = first.getBoundingClientRect();
        const lastRect = last.getBoundingClientRect();
        first.dispatchEvent(new PointerEvent('pointerdown', {
          button: 0, bubbles: true, cancelable: true, pointerId,
          clientX: firstRect.left + firstRect.width / 2,
          clientY: firstRect.top + firstRect.height / 2
        }));
        last.dispatchEvent(new PointerEvent('pointermove', {
          button: 0, buttons: 1, bubbles: true, cancelable: true, pointerId,
          clientX: lastRect.left + lastRect.width / 2,
          clientY: lastRect.top + lastRect.height / 2
        }));
        last.dispatchEvent(new PointerEvent('pointerup', {
          button: 0, bubbles: true, cancelable: true, pointerId,
          clientX: lastRect.left + lastRect.width / 2,
          clientY: lastRect.top + lastRect.height / 2
        }));
      };

      app.replaceChildren();
      const rowGuardText = ['| A |', '| --- |', '| one |', '| two |'].join('\n');
      const rowGuardEditor = harness.createEditor({
        parent: app,
        text: rowGuardText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      await waitUntil(() => document.querySelectorAll('.meo-md-html-table tbody .meo-md-html-table-cell-preview').length === 2, 'row guard table');
      const rowPreviews = Array.from(document.querySelectorAll('.meo-md-html-table tbody .meo-md-html-table-cell-preview'));
      selectCells(rowPreviews[0], rowPreviews[1], 91);
      pointer(document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!);
      const afterFullRangeRowDelete = rowGuardEditor.view.state.doc.toString();
      rowGuardEditor.destroy();

      app.replaceChildren();
      const columnGuardText = ['| A | B |', '| --- | --- |', '| one | two |'].join('\n');
      const columnGuardEditor = harness.createEditor({
        parent: app,
        text: columnGuardText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      await waitUntil(() => document.querySelectorAll('.meo-md-html-table tbody .meo-md-html-table-cell-preview').length === 2, 'column guard table');
      const columnPreviews = Array.from(document.querySelectorAll('.meo-md-html-table tbody .meo-md-html-table-cell-preview'));
      selectCells(columnPreviews[0], columnPreviews[1], 92);
      pointer(document.querySelector<HTMLButtonElement>('button[title="Delete column"]')!);
      const afterFullRangeColumnDelete = columnGuardEditor.view.state.doc.toString();
      columnGuardEditor.destroy();

      app.replaceChildren();
      const queuedGuardEditor = harness.createEditor({
        parent: app,
        text: rowGuardText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      await waitUntil(() => document.querySelectorAll('tbody textarea').length === 2, 'queued guard table');
      document.querySelector<HTMLTextAreaElement>('tbody textarea')!.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0, bubbles: true, cancelable: true, pointerId: 93
      }));
      const queuedDelete = document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!;
      pointer(queuedDelete);
      pointer(queuedDelete);
      pointer(document.querySelector<HTMLButtonElement>('button[title="Align selected column left"]')!);
      await waitUntil(() => queuedGuardEditor.view.state.doc.toString().includes('| :--- |'), 'queued double-delete drain');
      const afterQueuedDoubleDelete = queuedGuardEditor.view.state.doc.toString();
      queuedGuardEditor.destroy();

      app.replaceChildren();
      const dispatchFailureText = ['| A |', '| --- |', '| original |'].join('\n');
      const retryAfterDispatchFailureEditor = harness.createEditor({
        parent: app,
        text: dispatchFailureText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      await waitUntil(() => document.querySelectorAll('tbody textarea').length === 1, 'dispatch failure retry table');
      const retryInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      retryInput.focus();
      retryInput.value = 'retry kept';
      retryInput.dispatchEvent(new Event('input', { bubbles: true }));
      const retryView = retryAfterDispatchFailureEditor.view;
      const retryDispatch = retryView.dispatch.bind(retryView);
      let retryDispatchFailed = false;
      (retryView as any).dispatch = (...transactions: any[]) => {
        if (!retryDispatchFailed) {
          retryDispatchFailed = true;
          throw new Error('expected production dispatch failure');
        }
        return retryDispatch(...transactions);
      };
      pointer(document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      await Promise.resolve();
      await Promise.resolve();
      const afterFailedDispatch = retryView.state.doc.toString();
      const retainedAfterFailedDispatch = document.querySelector<HTMLTextAreaElement>('tbody textarea')?.value;
      pointer(document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      await waitUntil(() => retryView.state.doc.toString().includes('retry kept'), 'dispatch failure command retry');
      const afterDispatchRetry = retryView.state.doc.toString();
      const retryHistory = retryAfterDispatchFailureEditor.getHistoryDepth();
      const retryUndo = await retryAfterDispatchFailureEditor.undo();
      await waitUntil(() => retryView.state.doc.toString() === dispatchFailureText, 'dispatch retry undo');
      const retryRedo = await retryAfterDispatchFailureEditor.redo();
      await waitUntil(() => retryView.state.doc.toString() === afterDispatchRetry, 'dispatch retry redo');
      retryAfterDispatchFailureEditor.destroy();

      app.replaceChildren();
      const blurAfterDispatchFailureEditor = harness.createEditor({
        parent: app,
        text: dispatchFailureText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      await waitUntil(() => document.querySelectorAll('tbody textarea').length === 1, 'dispatch failure blur table');
      const blurInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      blurInput.focus();
      blurInput.value = 'blur kept';
      blurInput.dispatchEvent(new Event('input', { bubbles: true }));
      const blurView = blurAfterDispatchFailureEditor.view;
      const blurDispatch = blurView.dispatch.bind(blurView);
      let blurDispatchFailed = false;
      (blurView as any).dispatch = (...transactions: any[]) => {
        if (!blurDispatchFailed) {
          blurDispatchFailed = true;
          throw new Error('expected production dispatch failure before blur');
        }
        return blurDispatch(...transactions);
      };
      pointer(document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!);
      await Promise.resolve();
      await Promise.resolve();
      blurInput.blur();
      await waitUntil(() => blurView.state.doc.toString().includes('blur kept'), 'dispatch failure blur recovery');
      const afterBlurRecovery = blurView.state.doc.toString();
      const blurHistory = blurAfterDispatchFailureEditor.getHistoryDepth();
      blurAfterDispatchFailureEditor.destroy();

      app.replaceChildren();
      const saveAfterDispatchFailureEditor = harness.createEditor({
        parent: app,
        text: dispatchFailureText,
        initialMode: 'live',
        onApplyChanges() {}
      });
      await waitUntil(() => document.querySelectorAll('tbody textarea').length === 1, 'dispatch failure save table');
      const saveInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      saveInput.focus();
      saveInput.value = 'save kept';
      saveInput.dispatchEvent(new Event('input', { bubbles: true }));
      const saveView = saveAfterDispatchFailureEditor.view;
      const saveDispatch = saveView.dispatch.bind(saveView);
      let saveDispatchFailed = false;
      (saveView as any).dispatch = (...transactions: any[]) => {
        if (!saveDispatchFailed) {
          saveDispatchFailed = true;
          throw new Error('expected production dispatch failure before save');
        }
        return saveDispatch(...transactions);
      };
      pointer(document.querySelector<HTMLButtonElement>('button[title="Align selected column right"]')!);
      await Promise.resolve();
      await Promise.resolve();
      const saveCommitted = saveAfterDispatchFailureEditor.commitTransientEdits();
      await waitUntil(() => saveView.state.doc.toString().includes('save kept'), 'dispatch failure save recovery');
      const afterSaveRecovery = saveView.state.doc.toString();
      const saveHistory = saveAfterDispatchFailureEditor.getHistoryDepth();
      const saveUndo = await saveAfterDispatchFailureEditor.undo();
      await waitUntil(() => saveView.state.doc.toString() === dispatchFailureText, 'save recovery undo');
      const saveRedo = await saveAfterDispatchFailureEditor.redo();
      await waitUntil(() => saveView.state.doc.toString() === afterSaveRecovery, 'save recovery redo');
      saveAfterDispatchFailureEditor.destroy();
      return {
        original,
        contextLayout,
        menuOpenAfterAtomicInsert,
        consumed,
        afterAtomicInsert,
        undoApplied,
        afterAtomicUndo,
        redoApplied,
        afterAtomicRedo,
        contextActions,
        sortingCapabilityCount,
        afterRapidMultiTable,
        contextTriggerCount,
        contextMenuCount,
        stickyToolbarBandCount,
        resizeHandleCount,
        stickyCount,
        detachedConsumed,
        afterQueuedCoordinateChange,
        externalText,
        afterExternalPresentation,
        rowGuardText,
        afterFullRangeRowDelete,
        columnGuardText,
        afterFullRangeColumnDelete,
        afterQueuedDoubleDelete,
        dispatchFailureText,
        afterFailedDispatch,
        retainedAfterFailedDispatch,
        afterDispatchRetry,
        retryHistory,
        retryUndo,
        retryRedo,
        afterBlurRecovery,
        blurHistory,
        saveCommitted,
        afterSaveRecovery,
        saveHistory,
        saveUndo,
        saveRedo
      };
    });

    assert.equal(result.consumed, true, 'Context-menu pointer command must be consumed synchronously');
    assert.equal(result.contextLayout.triggerVisible, 'visible');
    assert.equal(result.contextLayout.triggerInsideViewport, true, 'Context trigger must stay visible in the viewport');
    assert.equal(result.contextLayout.triggerOutsideTable, true, 'Context trigger must float over the gutter to the left of the table');
    assert.equal(result.contextLayout.tableUsesNormalContentLeft, true, 'Context trigger must not reserve table width');
    assert.notEqual(result.contextLayout.menuVisible, 'none');
    assert.equal(result.contextLayout.heightAfter, result.contextLayout.heightBefore, 'floating menu must not change table layout height');
    assert.equal(result.contextLayout.menuPosition, 'absolute');
    assert.ok(result.contextLayout.buttonSize[0] >= 120);
    assert.equal(result.contextLayout.buttonSize[1], 32);
    assert.ok(
      result.contextLayout.preferredColumnWidths.every((width) => width >= 89.5),
      `Columns with available space must keep the 90px preferred minimum: ${JSON.stringify(result.contextLayout.preferredColumnWidths)}`
    );
    assert.equal(result.contextLayout.activePanel, 'root');
    assert.deepEqual(result.contextLayout.visibleLabels, ['Insert', 'Move', 'Align', 'Delete']);
    assert.equal(result.menuOpenAfterAtomicInsert, true, 'Context menu must remain open after a table command restores focus');
    assert.match(result.afterAtomicInsert, /edited/);
    assert.notEqual(result.afterAtomicInsert, result.original);
    assert.equal(result.undoApplied, true);
    assert.equal(result.afterAtomicUndo, result.original, 'pending edit and row insertion must undo together');
    assert.equal(result.redoApplied, true);
    assert.equal(result.afterAtomicRedo, result.afterAtomicInsert);
    assert.deepEqual(result.contextActions, [
      'Insert row above',
      'Insert row below',
      'Insert column left',
      'Insert column right',
      'Move row up',
      'Move row down',
      'Move column left',
      'Move column right',
      'Align selected column left',
      'Align selected column center',
      'Align selected column right',
      'Delete row',
      'Delete column'
    ], 'the contextual menu must expose every structure, movement and alignment command exactly once');
    assert.equal(result.sortingCapabilityCount, 0, 'Table sorting must not have any contextual capability');
    assert.match(result.afterRapidMultiTable, /\| C\s+\| D\s+\|\n\| ---:\s+\| ---\s+\|/);
    assert.equal(result.contextTriggerCount, 2);
    assert.equal(result.contextMenuCount, 2);
    assert.equal(result.stickyToolbarBandCount, 0, 'contextual controls must not reserve a sticky toolbar band');
    assert.ok(result.resizeHandleCount >= 4, 'Column Width controls must remain available');
    assert.equal(result.stickyCount, 2, 'Sticky Header lifecycle must remain mounted per table');
    assert.equal(result.detachedConsumed, true, 'detached contextual control keeps browser-default suppression without reviving Runtime');
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
    assert.equal(result.afterFullRangeRowDelete, result.rowGuardText, 'deleting every body row must be a strict no-op');
    assert.equal(result.afterFullRangeColumnDelete, result.columnGuardText, 'deleting every column must be a strict no-op');
    assert.match(result.afterQueuedDoubleDelete, /\| two\s+\|/, 'queued deletion must not remove the last body row');
    assert.equal(result.afterFailedDispatch, result.dispatchFailureText, 'failed structure dispatch must not change Markdown');
    assert.equal(result.retainedAfterFailedDispatch, 'retry kept', 'failed structure dispatch must retain the visible pending edit');
    assert.match(result.afterDispatchRetry, /\| retry kept\s+\|\n\|\s+\|/, 'retry must atomically apply the retained edit and command');
    assert.deepEqual(result.retryHistory, { undo: 1, redo: 0 }, 'dispatch retry must create one history item');
    assert.equal(result.retryUndo, true, 'dispatch retry undo must be accepted');
    assert.equal(result.retryRedo, true, 'dispatch retry redo must be accepted');
    assert.match(result.afterBlurRecovery, /\| blur kept\s+\|/, 'blur boundary must persist the edit retained after dispatch failure');
    assert.deepEqual(result.blurHistory, { undo: 1, redo: 0 }, 'blur recovery must create one history item');
    assert.equal(result.saveCommitted, true, 'save boundary must collect the edit retained after dispatch failure');
    assert.match(result.afterSaveRecovery, /\| save kept\s+\|/, 'save boundary must persist the retained edit');
    assert.doesNotMatch(result.afterSaveRecovery, /:---/, 'failed alignment must not leak into save recovery');
    assert.deepEqual(result.saveHistory, { undo: 1, redo: 0 }, 'save recovery must create one history item');
    assert.equal(result.saveUndo, true, 'save recovery undo must be accepted');
    assert.equal(result.saveRedo, true, 'save recovery redo must be accepted');

    type MatrixCase = {
      name: string;
      title: string;
      edit: { row: number; col: number };
      target: { row: number; col: number };
      expected: string;
      focus: { row: number; col: number };
    };
    const matrixOriginal = [
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
      '| three | four |'
    ].join('\n');
    const matrixCases: MatrixCase[] = [
      {
        name: 'insert row above', title: 'Insert row above', edit: { row: 1, col: 0 }, target: { row: 1, col: 0 },
        expected: ['| A | B |', '| --- | --- |', '|  |  |', '| one! | two |', '| three | four |'].join('\n'),
        focus: { row: 1, col: 0 }
      },
      {
        name: 'insert row below', title: 'Insert row below', edit: { row: 1, col: 0 }, target: { row: 1, col: 0 },
        expected: ['| A | B |', '| --- | --- |', '| one! | two |', '|  |  |', '| three | four |'].join('\n'),
        focus: { row: 2, col: 0 }
      },
      {
        name: 'move row up', title: 'Move row up', edit: { row: 1, col: 0 }, target: { row: 2, col: 0 },
        expected: ['| A | B |', '| --- | --- |', '| three | four |', '| one! | two |'].join('\n'),
        focus: { row: 1, col: 0 }
      },
      {
        name: 'move row down', title: 'Move row down', edit: { row: 2, col: 0 }, target: { row: 1, col: 0 },
        expected: ['| A | B |', '| --- | --- |', '| three! | four |', '| one | two |'].join('\n'),
        focus: { row: 2, col: 0 }
      },
      {
        name: 'delete row', title: 'Delete row', edit: { row: 1, col: 0 }, target: { row: 2, col: 0 },
        expected: ['| A | B |', '| --- | --- |', '| one! | two |'].join('\n'),
        focus: { row: 1, col: 0 }
      },
      {
        name: 'insert column left', title: 'Insert column left', edit: { row: 1, col: 1 }, target: { row: 1, col: 1 },
        expected: ['| A |  | B |', '| --- | --- | --- |', '| one |  | two! |', '| three |  | four |'].join('\n'),
        focus: { row: 1, col: 1 }
      },
      {
        name: 'insert column right', title: 'Insert column right', edit: { row: 1, col: 0 }, target: { row: 1, col: 0 },
        expected: ['| A |  | B |', '| --- | --- | --- |', '| one! |  | two |', '| three |  | four |'].join('\n'),
        focus: { row: 1, col: 1 }
      },
      {
        name: 'move column left', title: 'Move column left', edit: { row: 1, col: 0 }, target: { row: 1, col: 1 },
        expected: ['| B | A |', '| --- | --- |', '| two | one! |', '| four | three |'].join('\n'),
        focus: { row: 1, col: 0 }
      },
      {
        name: 'move column right', title: 'Move column right', edit: { row: 1, col: 1 }, target: { row: 1, col: 0 },
        expected: ['| B | A |', '| --- | --- |', '| two! | one |', '| four | three |'].join('\n'),
        focus: { row: 1, col: 1 }
      },
      {
        name: 'delete column', title: 'Delete column', edit: { row: 1, col: 0 }, target: { row: 1, col: 1 },
        expected: ['| A |', '| --- |', '| one! |', '| three |'].join('\n'),
        focus: { row: 1, col: 0 }
      },
      {
        name: 'align left', title: 'Align selected column left', edit: { row: 1, col: 0 }, target: { row: 1, col: 0 },
        expected: ['| A | B |', '| :--- | --- |', '| one! | two |', '| three | four |'].join('\n'),
        focus: { row: 1, col: 0 }
      },
      {
        name: 'align center', title: 'Align selected column center', edit: { row: 1, col: 0 }, target: { row: 1, col: 0 },
        expected: ['| A | B |', '| :---: | --- |', '| one! | two |', '| three | four |'].join('\n'),
        focus: { row: 1, col: 0 }
      },
      {
        name: 'align right', title: 'Align selected column right', edit: { row: 1, col: 0 }, target: { row: 1, col: 0 },
        expected: ['| A | B |', '| ---: | --- |', '| one! | two |', '| three | four |'].join('\n'),
        focus: { row: 1, col: 0 }
      }
    ];

    for (const matrixCase of matrixCases) {
      await page.evaluate((text) => {
        const candidate = window as typeof window & { __tableCommandMatrixEditor?: any };
        candidate.__tableCommandMatrixEditor?.destroy();
        const app = document.getElementById('app')!;
        app.replaceChildren();
        const editor = (window as any).TableStabilityHarness.createEditor({
          parent: app,
          text,
          initialMode: 'live',
          onApplyChanges() {}
        });
        candidate.__tableCommandMatrixEditor = editor;
      }, matrixOriginal);
      await page.waitForSelector('.meo-md-html-table-shell tbody textarea');

      const editSelector = `textarea[data-table-row="${matrixCase.edit.row}"][data-table-col="${matrixCase.edit.col}"]`;
      await page.click(editSelector);
      await page.keyboard.press('End');
      await page.keyboard.type('!');
      const beforeCommand = await page.evaluate((target) => {
        const editor = (window as any).__tableCommandMatrixEditor;
        const view = editor.view;
        const before = {
          history: editor.getHistoryDepth(),
          scrollTop: view.scrollDOM.scrollTop
        };
        const input = document.querySelector<HTMLTextAreaElement>(
          `textarea[data-table-row="${target.row}"][data-table-col="${target.col}"]`
        )!;
        input.dispatchEvent(new PointerEvent('pointerdown', {
          button: 0,
          bubbles: true,
          cancelable: true,
          pointerId: 101
        }));
        return before;
      }, matrixCase.target);
      await page.evaluate((title) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.meo-md-html-table-context-btn'))
          .find((candidate) => candidate.title === title)!;
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      }, matrixCase.title);
      await page.waitForFunction((expected) => (
        (window as any).__tableCommandMatrixEditor.view.state.doc.toString() === expected
      ), {}, matrixCase.expected);

      const afterCommand = await page.evaluate(() => {
        const editor = (window as any).__tableCommandMatrixEditor;
        const active = document.activeElement;
        return {
          markdown: editor.view.state.doc.toString(),
          history: editor.getHistoryDepth(),
          focus: active instanceof HTMLTextAreaElement ? {
            row: Number(active.dataset.tableRow),
            col: Number(active.dataset.tableCol),
            start: active.selectionStart,
            end: active.selectionEnd
          } : null,
          scrollTop: editor.view.scrollDOM.scrollTop
        };
      });
      assert.equal(afterCommand.markdown, matrixCase.expected, `${matrixCase.name}: exact Markdown`);
      assert.deepEqual(beforeCommand.history, { undo: 0, redo: 0 }, `${matrixCase.name}: clean history baseline`);
      assert.deepEqual(afterCommand.history, { undo: 1, redo: 0 }, `${matrixCase.name}: one Editor History item`);
      assert.deepEqual(afterCommand.focus, { ...matrixCase.focus, start: 0, end: 0 }, `${matrixCase.name}: focus/caret`);
      assert.equal(afterCommand.scrollTop, beforeCommand.scrollTop, `${matrixCase.name}: scroll continuity`);

      assert.equal(await page.evaluate(() => (window as any).__tableCommandMatrixEditor.undo()), true, `${matrixCase.name}: undo accepted`);
      await page.waitForFunction((expected) => (
        (window as any).__tableCommandMatrixEditor.view.state.doc.toString() === expected
      ), {}, matrixOriginal);
      const afterUndo = await page.evaluate(() => {
        const editor = (window as any).__tableCommandMatrixEditor;
        return { markdown: editor.view.state.doc.toString(), history: editor.getHistoryDepth(), scrollTop: editor.view.scrollDOM.scrollTop };
      });
      assert.equal(afterUndo.markdown, matrixOriginal, `${matrixCase.name}: exact undo Markdown`);
      assert.deepEqual(afterUndo.history, { undo: 0, redo: 1 }, `${matrixCase.name}: undo history depth`);
      assert.equal(afterUndo.scrollTop, beforeCommand.scrollTop, `${matrixCase.name}: undo scroll continuity`);

      assert.equal(await page.evaluate(() => (window as any).__tableCommandMatrixEditor.redo()), true, `${matrixCase.name}: redo accepted`);
      await page.waitForFunction((expected) => (
        (window as any).__tableCommandMatrixEditor.view.state.doc.toString() === expected
      ), {}, matrixCase.expected);
      const afterRedo = await page.evaluate(() => {
        const editor = (window as any).__tableCommandMatrixEditor;
        return { markdown: editor.view.state.doc.toString(), history: editor.getHistoryDepth(), scrollTop: editor.view.scrollDOM.scrollTop };
      });
      assert.equal(afterRedo.markdown, matrixCase.expected, `${matrixCase.name}: exact redo Markdown`);
      assert.deepEqual(afterRedo.history, { undo: 1, redo: 0 }, `${matrixCase.name}: redo history depth`);
      assert.equal(afterRedo.scrollTop, beforeCommand.scrollTop, `${matrixCase.name}: redo scroll continuity`);
    }

    const rangeOriginal = [
      '| A | B | C |',
      '| --- | --- | --- |',
      '| a1 | b1 | c1 |',
      '| a2 | b2 | c2 |',
      '| a3 | b3 | c3 |'
    ].join('\n');
    const resetRangeEditor = async () => {
      await page.evaluate((text) => {
        const candidate = window as typeof window & { __tableCommandMatrixEditor?: any };
        candidate.__tableCommandMatrixEditor?.destroy();
        document.getElementById('app')!.replaceChildren();
        candidate.__tableCommandMatrixEditor = (window as any).TableStabilityHarness.createEditor({
          parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
        });
      }, rangeOriginal);
      await page.waitForSelector('.meo-md-html-table-shell tbody textarea');
    };
    const dragRange = async (from: string, to: string) => {
      const points = await page.evaluate(([firstSelector, lastSelector]) => (
        [firstSelector, lastSelector].map((selector) => {
          const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })
      ), [from, to]);
      await page.mouse.move(points[0].x, points[0].y);
      await page.mouse.down();
      await page.mouse.move(points[1].x, points[1].y, { steps: 4 });
      await page.mouse.up();
    };
    const invokeRangeCommand = async (title: string) => {
      await page.evaluate((label) => {
        const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.meo-md-html-table-context-btn'))
          .find((candidate) => candidate.title === label)!;
        button.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      }, title);
    };

    await resetRangeEditor();
    await dragRange(
      'tbody tr:nth-child(1) td:nth-child(1) .meo-md-html-table-cell-preview',
      'tbody tr:nth-child(2) td:nth-child(3) .meo-md-html-table-cell-preview'
    );
    await invokeRangeCommand('Move row down');
    const movedRows = ['| A | B | C |', '| --- | --- | --- |', '| a3 | b3 | c3 |', '| a1 | b1 | c1 |', '| a2 | b2 | c2 |'].join('\n');
    await page.waitForFunction((expected) => (window as any).__tableCommandMatrixEditor.view.state.doc.toString() === expected, {}, movedRows);

    await resetRangeEditor();
    await dragRange(
      'tbody tr:nth-child(1) td:nth-child(1) .meo-md-html-table-cell-preview',
      'tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview'
    );
    await invokeRangeCommand('Move column right');
    const movedColumns = ['| C | A | B |', '| --- | --- | --- |', '| c1 | a1 | b1 |', '| c2 | a2 | b2 |', '| c3 | a3 | b3 |'].join('\n');
    await page.waitForFunction((expected) => (window as any).__tableCommandMatrixEditor.view.state.doc.toString() === expected, {}, movedColumns);

    await resetRangeEditor();
    await dragRange(
      'tbody tr:nth-child(1) td:nth-child(1) .meo-md-html-table-cell-preview',
      'tbody tr:nth-child(1) td:nth-child(2) .meo-md-html-table-cell-preview'
    );
    await invokeRangeCommand('Align selected column right');
    const alignedColumns = ['| A | B | C |', '| ---: | ---: | --- |', '| a1 | b1 | c1 |', '| a2 | b2 | c2 |', '| a3 | b3 | c3 |'].join('\n');
    await page.waitForFunction((expected) => (window as any).__tableCommandMatrixEditor.view.state.doc.toString() === expected, {}, alignedColumns);
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
