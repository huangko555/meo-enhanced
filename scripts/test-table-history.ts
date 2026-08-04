import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-history-'));

async function waitForFrames(page: any, count = 6) {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
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
    await page.setViewport({ width: 900, height: 500 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const original = '| Name | Value |\n| --- | --- |\n| Alpha | Before |';
    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, original);
    await waitForFrames(page);

    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>('tbody tr:first-child td:nth-child(2) textarea')!;
      input.focus();
      input.value = 'After';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'After' }));
    });
    const beforeUndo = await page.evaluate(() => ({
      documentText: (window as any).__tableHistoryEditor.view.state.doc.toString(),
      inputValue: document.querySelector<HTMLTextAreaElement>('tbody tr:first-child td:nth-child(2) textarea')!.value,
      activeTag: document.activeElement?.tagName
    }));
    if (beforeUndo.documentText !== original || beforeUndo.inputValue !== 'After' || beforeUndo.activeTag !== 'TEXTAREA') {
      throw new Error(`Table edit was not pending before undo: ${JSON.stringify(beforeUndo)}`);
    }

    const undoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.undo());
    await waitForFrames(page);
    const afterUndo = await page.evaluate(() => ({
      documentText: (window as any).__tableHistoryEditor.view.state.doc.toString(),
      inputValue: document.querySelector<HTMLTextAreaElement>('tbody tr:first-child td:nth-child(2) textarea')!.value
    }));
    if (!undoApplied || afterUndo.documentText !== original || afterUndo.inputValue !== 'Before') {
      throw new Error(`Undo did not include the active table edit: ${JSON.stringify({ undoApplied, afterUndo })}`);
    }

    const redoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
    await waitForFrames(page);
    const afterRedo = await page.evaluate(() => ({
      documentText: (window as any).__tableHistoryEditor.view.state.doc.toString(),
      inputValue: document.querySelector<HTMLTextAreaElement>('tbody tr:first-child td:nth-child(2) textarea')!.value
    }));
    if (!redoApplied || !afterRedo.documentText.includes('| Alpha | After |') || afterRedo.inputValue !== 'After') {
      throw new Error(`Redo did not restore the active table edit: ${JSON.stringify({ redoApplied, afterRedo })}`);
    }

    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, original);
    await waitForFrames(page);

    const editCell = async (selector: string, value: string) => {
      await page.focus(selector);
      await waitForFrames(page, 2);
      await page.$eval(selector, (input, nextValue) => {
        const textarea = input as HTMLTextAreaElement;
        textarea.value = nextValue;
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
      }, value);
    };
    await editCell('tbody tr:first-child td:first-child textarea', 'Alpha One');
    await editCell('tbody tr:first-child td:nth-child(2) textarea', 'After');

    const firstUndoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.undo());
    await waitForFrames(page);
    const afterFirstUndo = await page.evaluate(() => ({
      text: (window as any).__tableHistoryEditor.view.state.doc.toString(),
      values: Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')).map((input) => input.value)
    }));
    if (!firstUndoApplied || !afterFirstUndo.text.includes('| Alpha One | Before |') || afterFirstUndo.values.join('|') !== 'Alpha One|Before') {
      throw new Error(`First undo did not revert only the active cell: ${JSON.stringify({ firstUndoApplied, afterFirstUndo })}`);
    }

    const secondUndoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.undo());
    await waitForFrames(page);
    const afterSecondUndo = await page.evaluate(() => (window as any).__tableHistoryEditor.view.state.doc.toString());
    if (!secondUndoApplied || afterSecondUndo !== original) {
      throw new Error(`Second undo did not revert the preceding cell: ${JSON.stringify({ secondUndoApplied, afterSecondUndo })}`);
    }

    const firstRedoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
    await waitForFrames(page);
    const afterFirstRedo = await page.evaluate(() => (window as any).__tableHistoryEditor.view.state.doc.toString());
    if (!firstRedoApplied || !afterFirstRedo.includes('| Alpha One | Before |')) {
      throw new Error(`First redo did not restore one cell: ${JSON.stringify({ firstRedoApplied, afterFirstRedo })}`);
    }

    const secondRedoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
    await waitForFrames(page);
    const afterSecondRedo = await page.evaluate(() => ({
      text: (window as any).__tableHistoryEditor.view.state.doc.toString(),
      values: Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')).map((input) => input.value)
    }));
    if (
      !secondRedoApplied ||
      !afterSecondRedo.text.includes('| Alpha One | After |') ||
      afterSecondRedo.values.join('|') !== 'Alpha One|After'
    ) {
      throw new Error(`Second redo did not restore the active cell without leaving the table: ${JSON.stringify({ secondRedoApplied, afterSecondRedo })}`);
    }

    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, original);
    await waitForFrames(page);
    await page.evaluate(() => {
      const inputs = document.querySelectorAll<HTMLTextAreaElement>('tbody textarea');
      inputs[0].focus();
      inputs[0].value = 'Alpha fast';
      inputs[0].dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Alpha fast' }));
      inputs[1].focus();
      inputs[1].value = 'After fast';
      inputs[1].dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'After fast' }));
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await waitForFrames(page);
    const afterFastUndo = await page.evaluate(() => (window as any).__tableHistoryEditor.view.state.doc.toString());
    if (!afterFastUndo.includes('| Alpha fast | Before |')) {
      throw new Error(`Fast edits were merged instead of undoing one cell: ${afterFastUndo}`);
    }

    const twoTables = [
      '| First A | First B |',
      '| --- | --- |',
      '| One | Two |',
      '',
      'between',
      '',
      '| Second A | Second B |',
      '| --- | --- |',
      '| Three | Four |'
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, twoTables);
    await waitForFrames(page);
    await page.evaluate(() => {
      const tables = document.querySelectorAll<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      (window as any).__firstTableToolbar = tables[0].closest('.meo-md-html-table-shell')?.querySelector('.meo-md-html-table-toolbar');
      const input = tables[0].querySelector<HTMLTextAreaElement>('tbody textarea')!;
      input.focus();
      input.value = 'One edited';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'One edited' }));
      const editorDom = (window as any).__tableHistoryEditor.view.dom as HTMLElement;
      (window as any).__tableInteractionDropped = false;
      (window as any).__tableInteractionObserver = new MutationObserver(() => {
        if (!editorDom.classList.contains('meo-table-interaction-active')) {
          (window as any).__tableInteractionDropped = true;
        }
      });
      (window as any).__tableInteractionObserver.observe(editorDom, { attributes: true, attributeFilter: ['class'] });
    });
    const secondTablePoint = await page.evaluate(() => {
      const tables = document.querySelectorAll<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const rect = tables[1].querySelector<HTMLTextAreaElement>('tbody textarea')!.getBoundingClientRect();
      return { x: rect.left + 8, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(secondTablePoint.x, secondTablePoint.y);
    await waitForFrames(page);
    const crossTableFocus = await page.evaluate(() => {
      (window as any).__tableInteractionObserver.disconnect();
      const tables = document.querySelectorAll<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const secondInput = tables[1].querySelector<HTMLTextAreaElement>('tbody textarea')!;
      return {
        activeSecondInput: document.activeElement === secondInput,
        toolbarPreserved: (window as any).__firstTableToolbar === tables[0].closest('.meo-md-html-table-shell')?.querySelector('.meo-md-html-table-toolbar'),
        interactionDropped: (window as any).__tableInteractionDropped,
        text: (window as any).__tableHistoryEditor.view.state.doc.toString(),
        activeClass: document.activeElement?.className ?? ''
      };
    });
    await page.keyboard.type(' inserted');
    const secondTableValue = await page.evaluate(() => {
      const tables = document.querySelectorAll<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      return tables[1].querySelector<HTMLTextAreaElement>('tbody textarea')!.value;
    });
    if (!crossTableFocus.activeSecondInput || !crossTableFocus.toolbarPreserved || crossTableFocus.interactionDropped || !secondTableValue.includes('inserted')) {
      throw new Error(`Switching tables rebuilt the toolbar or lost the target caret: ${JSON.stringify({ crossTableFocus, secondTableValue })}`);
    }
    const committedTwoTables = await page.evaluate(() => (window as any).__tableHistoryEditor.getText());
    await waitForFrames(page);
    if (!committedTwoTables.includes('| One edited | Two |') || !committedTwoTables.includes(`| ${secondTableValue.trim()} | Four |`)) {
      throw new Error(`Committing cross-table edits lost a pending cell: ${committedTwoTables}`);
    }

    const fiveCellHistory = [
      '| A | B |',
      '| --- | --- |',
      '| a1 | a2 |',
      '',
      '| C | D |',
      '| --- | --- |',
      '| c1 | c2 |',
      '',
      '| E | F |',
      '| --- | --- |',
      '| e1 | e2 |'
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, fiveCellHistory);
    await waitForFrames(page);
    await page.evaluate(() => {
      const inputs = () => Array.from(document.querySelectorAll<HTMLTextAreaElement>(
        '.meo-md-html-table-wrap .meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea'
      ));
      const edit = (index: number, value: string) => {
        const input = inputs()[index];
        input.focus();
        input.value = value;
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      };
      edit(0, 'a1 edited');
      edit(3, 'c2 edited');
      edit(4, 'e1 edited');
      edit(1, 'a2 edited');
      edit(5, 'e2 edited');
    });
    const readFiveCellState = () => page.evaluate(() => ({
      values: Array.from(document.querySelectorAll<HTMLTextAreaElement>(
        '.meo-md-html-table-wrap .meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea'
      )).map((input) => input.value),
      activeTag: document.activeElement?.tagName ?? '',
      activeClass: document.activeElement instanceof HTMLElement ? document.activeElement.className : ''
    }));
    const undos: Array<Awaited<ReturnType<typeof readFiveCellState>>> = [];
    const redos: Array<Awaited<ReturnType<typeof readFiveCellState>>> = [];
    const ctrlYUndos: Array<Awaited<ReturnType<typeof readFiveCellState>>> = [];
    const ctrlYRedos: Array<Awaited<ReturnType<typeof readFiveCellState>>> = [];
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.down('Control');
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
      await waitForFrames(page, 2);
      undos.push(await readFiveCellState());
    }
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.down('Control');
      await page.keyboard.down('Shift');
      await page.keyboard.press('z');
      await page.keyboard.up('Shift');
      await page.keyboard.up('Control');
      await waitForFrames(page, 2);
      redos.push(await readFiveCellState());
    }
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.down('Control');
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
      await waitForFrames(page, 2);
      ctrlYUndos.push(await readFiveCellState());
    }
    for (let index = 0; index < 5; index += 1) {
      await page.keyboard.down('Control');
      await page.keyboard.press('y');
      await page.keyboard.up('Control');
      await waitForFrames(page, 2);
      ctrlYRedos.push(await readFiveCellState());
    }
    const fiveCellResult = { undos, redos, ctrlYUndos, ctrlYRedos };
    const initialFiveValues = ['a1', 'a2', 'c1', 'c2', 'e1', 'e2'];
    const editsInOrder: Array<[number, string]> = [
      [0, 'a1 edited'],
      [3, 'c2 edited'],
      [4, 'e1 edited'],
      [1, 'a2 edited'],
      [5, 'e2 edited']
    ];
    const fiveVersions = [initialFiveValues];
    for (const [cell, value] of editsInOrder) {
      const next = [...fiveVersions[fiveVersions.length - 1]];
      next[cell] = value;
      fiveVersions.push(next);
    }
    const expectedUndos = [4, 3, 2, 1, 0].map((index) => fiveVersions[index]);
    const expectedRedos = [1, 2, 3, 4, 5].map((index) => fiveVersions[index]);
    if (
      JSON.stringify(fiveCellResult.undos.map((state) => state.values)) !== JSON.stringify(expectedUndos) ||
      JSON.stringify(fiveCellResult.redos.map((state) => state.values)) !== JSON.stringify(expectedRedos) ||
      JSON.stringify(fiveCellResult.ctrlYUndos.map((state) => state.values)) !== JSON.stringify(expectedUndos) ||
      JSON.stringify(fiveCellResult.ctrlYRedos.map((state) => state.values)) !== JSON.stringify(expectedRedos) ||
      [
        ...fiveCellResult.undos,
        ...fiveCellResult.redos,
        ...fiveCellResult.ctrlYUndos,
        ...fiveCellResult.ctrlYRedos
      ].some((state) => state.activeTag !== 'TEXTAREA')
    ) {
      throw new Error(`Five-cell cross-table history order was not preserved: ${JSON.stringify(fiveCellResult)}`);
    }

    const imageBetweenTables = [
      '![fixture](fixture.png)',
      '| First A | First B |',
      '| --- | --- |',
      '| One | Two |',
      '',
      '',
      '| Second A | Second B |',
      '| --- | --- |',
      '| Three | Four |'
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).TableStabilityHarness.setImageSrcResolver(
        () => `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"/>')}`
      );
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, imageBetweenTables);
    await waitForFrames(page);
    await page.evaluate(() => {
      const tables = document.querySelectorAll<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const secondInput = tables[1].querySelector<HTMLTextAreaElement>('tbody textarea')!;
      secondInput.focus();
      secondInput.value = 'Three edited';
      secondInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'Three edited' }));
      (window as any).__imageBeforeTableSwitch = document.querySelector('.meo-md-image');
      const firstInput = tables[0].querySelector<HTMLTextAreaElement>('tbody textarea')!;
      firstInput.focus();
      firstInput.value = 'One edited';
      firstInput.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'One edited' }));
    });
    const imagePreserved = await page.evaluate(() => (
      (window as any).__imageBeforeTableSwitch === document.querySelector('.meo-md-image')
    ));
    if (!imagePreserved) {
      throw new Error('Switching between tables replaced the adjacent image widget');
    }

    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await waitForFrames(page);
    const reverseFirstUndo = await page.evaluate(() => (window as any).__tableHistoryEditor.view.state.doc.toString());
    if (!reverseFirstUndo.includes('| One | Two |') || !reverseFirstUndo.includes('| Three edited | Four |')) {
      throw new Error(`Undo did not follow the actual cross-table edit order: ${reverseFirstUndo}`);
    }

    await page.evaluate(() => (window as any).__tableHistoryEditor.undo());
    await waitForFrames(page);
    const reverseSecondUndo = await page.evaluate(() => (window as any).__tableHistoryEditor.view.state.doc.toString());
    if (reverseSecondUndo !== imageBetweenTables) {
      throw new Error(`Second undo did not revert the earlier table cell: ${reverseSecondUndo}`);
    }

    await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
    await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
    await waitForFrames(page);
    const reverseRedos = await page.evaluate(() => (window as any).__tableHistoryEditor.view.state.doc.toString());
    if (!reverseRedos.includes('| One edited | Two |') || !reverseRedos.includes('| Three edited | Four |')) {
      throw new Error(`Redo did not restore the cross-table cells independently: ${reverseRedos}`);
    }

    console.log('table history checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
