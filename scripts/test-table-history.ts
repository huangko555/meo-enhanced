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

    await page.keyboard.down('Control');
    try {
      for (let count = 1; count <= 8; count += 1) {
        await page.keyboard.down('z');
        const text = await page.evaluate(() => (window as any).__tableHistoryEditor.view.state.doc.toString());
        if (text !== original) {
          throw new Error(`Held Ctrl+Z recreated a table edit after the history boundary at repeat ${count}: ${text}`);
        }
      }
      await page.keyboard.up('z');
    } finally {
      await page.keyboard.up('Control');
    }
    await waitForFrames(page, 8);
    const heldBoundaryState = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea'));
      return {
        text: (window as any).__tableHistoryEditor.view.state.doc.toString(),
        activeIndex: inputs.indexOf(document.activeElement as HTMLTextAreaElement),
        selectionStart: (document.activeElement as HTMLTextAreaElement | null)?.selectionStart ?? null
      };
    });
    if (heldBoundaryState.text !== original || heldBoundaryState.activeIndex !== 1 || heldBoundaryState.selectionStart === null) {
      throw new Error(`Held table history boundary lost its cell caret: ${JSON.stringify(heldBoundaryState)}`);
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
    const visibleHistoryBaseline = await page.evaluate(() => {
      const scroller = (window as any).__tableHistoryEditor.view.scrollDOM as HTMLElement;
      const table = document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!;
      return { scrollTop: scroller.scrollTop, tableTop: table.getBoundingClientRect().top };
    });

    const firstUndoImmediate = await page.evaluate(() => {
      const applied = (window as any).__tableHistoryEditor.undo();
      const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea'));
      return {
        applied,
        activeIndex: inputs.indexOf(document.activeElement as HTMLTextAreaElement),
        scrollTop: ((window as any).__tableHistoryEditor.view.scrollDOM as HTMLElement).scrollTop,
        tableTop: document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!.getBoundingClientRect().top
      };
    });
    await waitForFrames(page);
    const afterFirstUndo = await page.evaluate(() => ({
      text: (window as any).__tableHistoryEditor.view.state.doc.toString(),
      values: Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')).map((input) => input.value),
      activeIndex: Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')).indexOf(document.activeElement as HTMLTextAreaElement),
      scrollTop: ((window as any).__tableHistoryEditor.view.scrollDOM as HTMLElement).scrollTop,
      tableTop: document.querySelector<HTMLElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)')!.getBoundingClientRect().top
    }));
    if (
      !firstUndoImmediate.applied ||
      firstUndoImmediate.activeIndex !== 1 ||
      Math.abs(firstUndoImmediate.scrollTop - visibleHistoryBaseline.scrollTop) > 1 ||
      Math.abs(firstUndoImmediate.tableTop - visibleHistoryBaseline.tableTop) > 1 ||
      !afterFirstUndo.text.includes('| Alpha One | Before |') ||
      afterFirstUndo.values.join('|') !== 'Alpha One|Before' ||
      afterFirstUndo.activeIndex !== 1 ||
      Math.abs(afterFirstUndo.scrollTop - visibleHistoryBaseline.scrollTop) > 1 ||
      Math.abs(afterFirstUndo.tableTop - visibleHistoryBaseline.tableTop) > 1
    ) {
      throw new Error(`First undo did not keep the changed cell stable in the same frame: ${JSON.stringify({ firstUndoImmediate, afterFirstUndo })}`);
    }

    const secondUndoImmediate = await page.evaluate(() => {
      const applied = (window as any).__tableHistoryEditor.undo();
      const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea'));
      return {
        applied,
        activeIndex: inputs.indexOf(document.activeElement as HTMLTextAreaElement),
        scrollTop: ((window as any).__tableHistoryEditor.view.scrollDOM as HTMLElement).scrollTop
      };
    });
    await waitForFrames(page);
    const afterSecondUndo = await page.evaluate(() => ({
      text: (window as any).__tableHistoryEditor.view.state.doc.toString(),
      activeIndex: Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')).indexOf(document.activeElement as HTMLTextAreaElement),
      scrollTop: ((window as any).__tableHistoryEditor.view.scrollDOM as HTMLElement).scrollTop
    }));
    if (
      !secondUndoImmediate.applied ||
      secondUndoImmediate.activeIndex !== 0 ||
      Math.abs(secondUndoImmediate.scrollTop - visibleHistoryBaseline.scrollTop) > 1 ||
      afterSecondUndo.text !== original ||
      afterSecondUndo.activeIndex !== 0 ||
      Math.abs(afterSecondUndo.scrollTop - visibleHistoryBaseline.scrollTop) > 1
    ) {
      throw new Error(`Second undo did not keep the preceding cell stable in the same frame: ${JSON.stringify({ secondUndoImmediate, afterSecondUndo })}`);
    }

    const firstRedoImmediate = await page.evaluate(() => {
      const applied = (window as any).__tableHistoryEditor.redo();
      const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea'));
      return {
        applied,
        activeIndex: inputs.indexOf(document.activeElement as HTMLTextAreaElement),
        scrollTop: ((window as any).__tableHistoryEditor.view.scrollDOM as HTMLElement).scrollTop
      };
    });
    await waitForFrames(page);
    const afterFirstRedo = await page.evaluate(() => ({
      text: (window as any).__tableHistoryEditor.view.state.doc.toString(),
      activeIndex: Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')).indexOf(document.activeElement as HTMLTextAreaElement),
      scrollTop: ((window as any).__tableHistoryEditor.view.scrollDOM as HTMLElement).scrollTop
    }));
    if (
      !firstRedoImmediate.applied ||
      firstRedoImmediate.activeIndex !== 0 ||
      Math.abs(firstRedoImmediate.scrollTop - visibleHistoryBaseline.scrollTop) > 1 ||
      !afterFirstRedo.text.includes('| Alpha One | Before |') ||
      afterFirstRedo.activeIndex !== 0 ||
      Math.abs(afterFirstRedo.scrollTop - visibleHistoryBaseline.scrollTop) > 1
    ) {
      throw new Error(`First redo did not keep the restored cell stable in the same frame: ${JSON.stringify({ firstRedoImmediate, afterFirstRedo })}`);
    }

    const secondRedoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
    await waitForFrames(page);
    const afterSecondRedo = await page.evaluate(() => ({
      text: (window as any).__tableHistoryEditor.view.state.doc.toString(),
      values: Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')).map((input) => input.value),
      activeIndex: Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea')).indexOf(document.activeElement as HTMLTextAreaElement),
      scrollTop: ((window as any).__tableHistoryEditor.view.scrollDOM as HTMLElement).scrollTop
    }));
    if (
      !secondRedoApplied ||
      !afterSecondRedo.text.includes('| Alpha One | After |') ||
      afterSecondRedo.values.join('|') !== 'Alpha One|After' ||
      afterSecondRedo.activeIndex !== 1 ||
      Math.abs(afterSecondRedo.scrollTop - visibleHistoryBaseline.scrollTop) > 1
    ) {
      throw new Error(`Second redo did not restore the active cell without leaving the table: ${JSON.stringify({ secondRedoApplied, afterSecondRedo })}`);
    }

    const immediateInputBaseline = await page.evaluate(() => ({
      scrollTop: ((window as any).__tableHistoryEditor.view.scrollDOM as HTMLElement).scrollTop
    }));
    const immediateInputSetup = await page.evaluate(() => {
      const editor = (window as any).__tableHistoryEditor;
      const applied = editor.undo();
      const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea'));
      const input = inputs[0];
      input.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      input.focus({ preventScroll: true });
      input.value = 'Immediate typing';
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: 'Immediate typing'
      }));
      return {
        applied,
        activeIndex: inputs.indexOf(document.activeElement as HTMLTextAreaElement)
      };
    });
    await waitForFrames(page, 16);
    const immediateInputEnd = await page.evaluate(() => {
      const editor = (window as any).__tableHistoryEditor;
      const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea'));
      const active = document.activeElement as HTMLTextAreaElement | null;
      return {
        activeIndex: inputs.indexOf(active as HTMLTextAreaElement),
        value: active?.value ?? null,
        selectionStart: active?.selectionStart ?? null,
        scrollTop: (editor.view.scrollDOM as HTMLElement).scrollTop
      };
    });
    if (
      !immediateInputSetup.applied ||
      immediateInputSetup.activeIndex !== 0 ||
      immediateInputEnd.activeIndex !== 0 ||
      immediateInputEnd.value !== 'Immediate typing' ||
      immediateInputEnd.selectionStart !== 'Immediate typing'.length ||
      Math.abs(immediateInputEnd.scrollTop - immediateInputBaseline.scrollTop) > 1
    ) {
      throw new Error(`Typing immediately after table history was stolen by a stale focus callback: ${JSON.stringify({ immediateInputSetup, immediateInputEnd })}`);
    }

    const plainText = 'alpha beta gamma';
    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      const view = (window as any).__tableHistoryEditor.view;
      view.dispatch({ selection: { anchor: 6 } });
      view.dispatch({ changes: { from: 6, to: 10, insert: 'BETA' }, selection: { anchor: 10 } });
      view.focus();
    }, plainText);
    await waitForFrames(page);
    const plainUndoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.undo());
    await waitForFrames(page);
    const plainAfterUndo = await page.evaluate(() => {
      const view = (window as any).__tableHistoryEditor.view;
      return {
        text: view.state.doc.toString(),
        head: view.state.selection.main.head,
        focused: view.hasFocus,
        scrollTop: (view.scrollDOM as HTMLElement).scrollTop
      };
    });
    const plainRedoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
    await waitForFrames(page);
    const plainAfterRedo = await page.evaluate(() => {
      const view = (window as any).__tableHistoryEditor.view;
      return {
        text: view.state.doc.toString(),
        head: view.state.selection.main.head,
        focused: view.hasFocus,
        scrollTop: (view.scrollDOM as HTMLElement).scrollTop
      };
    });
    if (
      !plainUndoApplied ||
      plainAfterUndo.text !== plainText ||
      plainAfterUndo.head !== 6 ||
      !plainAfterUndo.focused ||
      plainAfterUndo.scrollTop !== 0 ||
      !plainRedoApplied ||
      plainAfterRedo.text !== 'alpha BETA gamma' ||
      plainAfterRedo.head !== 10 ||
      !plainAfterRedo.focused ||
      plainAfterRedo.scrollTop !== 0
    ) {
      throw new Error(`Plain-document history did not restore the changed position without scrolling: ${JSON.stringify({ plainUndoApplied, plainAfterUndo, plainRedoApplied, plainAfterRedo })}`);
    }

    const chainedHistoryBase = ['A:', 'B:', 'C:'].join('\n');
    const chainedHistoryEdits = [
      { line: 1, insert: 'alpha' },
      { line: 2, insert: 'beta' },
      { line: 3, insert: 'gamma' }
    ];
    await page.evaluate(({ text, edits }) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      const view = (window as any).__tableHistoryEditor.view;
      for (const edit of edits) {
        const position = view.state.doc.line(edit.line).to;
        view.dispatch({
          changes: { from: position, insert: edit.insert },
          // History navigation must follow the changed range even when a caller
          // supplies a stale or unrelated transaction selection.
          selection: { anchor: 0 }
        });
      }
      view.focus();
    }, { text: chainedHistoryBase, edits: chainedHistoryEdits });
    await waitForFrames(page);

    const collectChainedHistoryState = () => page.evaluate(() => {
      const view = (window as any).__tableHistoryEditor.view;
      return {
        text: view.state.doc.toString(),
        head: view.state.selection.main.head
      };
    });
    const chainedUndoStates: Array<{ text: string; head: number }> = [];
    for (let index = 0; index < chainedHistoryEdits.length; index += 1) {
      await page.evaluate(() => (window as any).__tableHistoryEditor.undo());
      await waitForFrames(page, 2);
      chainedUndoStates.push(await collectChainedHistoryState());
    }
    const chainedRedoStates: Array<{ text: string; head: number }> = [];
    for (let index = 0; index < chainedHistoryEdits.length; index += 1) {
      await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
      await waitForFrames(page, 2);
      chainedRedoStates.push(await collectChainedHistoryState());
    }
    const chainedVersions = [chainedHistoryBase];
    for (const edit of chainedHistoryEdits) {
      const current = chainedVersions[chainedVersions.length - 1];
      const lines = current.split('\n');
      lines[edit.line - 1] += edit.insert;
      chainedVersions.push(lines.join('\n'));
    }
    const expectedChainedUndo = [2, 1, 0].map((version) => ({
      text: chainedVersions[version],
      head: chainedVersions[version].split('\n').slice(0, version + 1).join('\n').length
    }));
    const expectedChainedRedo = [1, 2, 3].map((version) => ({
      text: chainedVersions[version],
      head: chainedVersions[version].split('\n').slice(0, version).join('\n').length
    }));
    if (
      JSON.stringify(chainedUndoStates) !== JSON.stringify(expectedChainedUndo) ||
      JSON.stringify(chainedRedoStates) !== JSON.stringify(expectedChainedRedo)
    ) {
      throw new Error(`Chained history did not focus each actual changed range: ${JSON.stringify({ chainedUndoStates, expectedChainedUndo, chainedRedoStates, expectedChainedRedo })}`);
    }

    const visibleDocumentText = Array.from({ length: 80 }, (_, index) => `visible line ${index + 1}`).join('\n');
    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, visibleDocumentText);
    await waitForFrames(page);
    const visibleHistorySetup = await page.evaluate(() => {
      const view = (window as any).__tableHistoryEditor.view;
      const target = view.state.doc.line(35);
      view.dispatch({ selection: { anchor: target.to } });
      view.dispatch({
        changes: { from: target.to, insert: ' edited' },
        selection: { anchor: target.to + ' edited'.length }
      });
      const nearby = view.state.doc.line(38);
      view.dispatch({ selection: { anchor: nearby.from } });
      const scroller = view.scrollDOM as HTMLElement;
      const targetBlock = view.lineBlockAt(view.state.doc.line(35).from);
      scroller.scrollTop = Math.max(0, targetBlock.bottom - scroller.clientHeight + 1);
      view.focus();
      (window as any).__plainHistoryScrollSamples = [scroller.scrollTop];
      scroller.addEventListener('scroll', () => {
        (window as any).__plainHistoryScrollSamples.push(scroller.scrollTop);
      });
      const targetCoords = view.coordsAtPos(view.state.doc.line(35).from)!;
      const viewport = scroller.getBoundingClientRect();
      return {
        scrollTop: scroller.scrollTop,
        targetVisible: targetCoords.top >= viewport.top && targetCoords.bottom <= viewport.bottom
      };
    });
    if (!visibleHistorySetup.targetVisible) {
      throw new Error(`Plain history viewport fixture did not keep the target visible: ${JSON.stringify(visibleHistorySetup)}`);
    }
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await waitForFrames(page, 4);
    const visibleAfterKeyboardUndo = await page.evaluate(() => {
      const view = (window as any).__tableHistoryEditor.view;
      return {
        text: view.state.doc.line(35).text,
        selectionLine: view.state.doc.lineAt(view.state.selection.main.head).number,
        scrollTop: (view.scrollDOM as HTMLElement).scrollTop,
        scrollSamples: [...(window as any).__plainHistoryScrollSamples]
      };
    });
    if (
      visibleAfterKeyboardUndo.text !== 'visible line 35' ||
      visibleAfterKeyboardUndo.selectionLine !== 35 ||
      Math.abs(visibleAfterKeyboardUndo.scrollTop - visibleHistorySetup.scrollTop) > 1 ||
      visibleAfterKeyboardUndo.scrollSamples.some((scrollTop: number) => Math.abs(scrollTop - visibleHistorySetup.scrollTop) > 1)
    ) {
      throw new Error(`Keyboard undo scrolled despite the changed text remaining visible: ${JSON.stringify({ visibleHistorySetup, visibleAfterKeyboardUndo })}`);
    }
    await page.keyboard.down('Control');
    await page.evaluate(() => {
      (window as any).__plainHistoryScrollSamples = [
        ((window as any).__tableHistoryEditor.view.scrollDOM as HTMLElement).scrollTop
      ];
    });
    await page.keyboard.press('y');
    await page.keyboard.up('Control');
    await waitForFrames(page, 4);
    const visibleAfterKeyboardRedo = await page.evaluate(() => {
      const view = (window as any).__tableHistoryEditor.view;
      return {
        text: view.state.doc.line(35).text,
        selectionLine: view.state.doc.lineAt(view.state.selection.main.head).number,
        scrollTop: (view.scrollDOM as HTMLElement).scrollTop,
        scrollSamples: [...(window as any).__plainHistoryScrollSamples]
      };
    });
    if (
      visibleAfterKeyboardRedo.text !== 'visible line 35 edited' ||
      visibleAfterKeyboardRedo.selectionLine !== 35 ||
      Math.abs(visibleAfterKeyboardRedo.scrollTop - visibleHistorySetup.scrollTop) > 1 ||
      visibleAfterKeyboardRedo.scrollSamples.some((scrollTop: number) => Math.abs(scrollTop - visibleHistorySetup.scrollTop) > 1)
    ) {
      throw new Error(`Keyboard redo scrolled despite the changed text remaining visible: ${JSON.stringify({ visibleHistorySetup, visibleAfterKeyboardRedo })}`);
    }

    const longHistoryText = Array.from({ length: 100 }, (_, index) => `long history line ${index + 1}`).join('\n');
    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, longHistoryText);
    await waitForFrames(page);
    const longHistorySetup = await page.evaluate(async () => {
      const editor = (window as any).__tableHistoryEditor;
      const view = editor.view;
      for (let lineNumber = 20; lineNumber <= 43; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        view.dispatch({ selection: { anchor: line.from } });
        view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: '#', bubbles: true }));
        view.dispatch({
          changes: { from: line.from, insert: '# ' },
          selection: { anchor: line.from + 2 }
        });
      }
      const target = view.state.doc.line(43);
      const scroller = view.scrollDOM as HTMLElement;
      const block = view.lineBlockAt(target.from);
      scroller.scrollTop = Math.max(0, block.bottom - scroller.clientHeight + 20);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const measuredBlock = view.lineBlockAt(target.from);
      scroller.scrollTop = Math.max(0, measuredBlock.bottom - scroller.clientHeight + 20);
      view.focus();
      (window as any).__longHistoryScrollSamples = [scroller.scrollTop];
      scroller.addEventListener('scroll', () => {
        (window as any).__longHistoryScrollSamples.push(scroller.scrollTop);
      });
      const selectionHead = view.state.selection.main.head;
      const selectionCoords = view.coordsAtPos(selectionHead);
      const viewport = scroller.getBoundingClientRect();
      view.dom.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true,
        ctrlKey: true,
        key: 'z'
      }));
      const applied = editor.undo();
      return {
        applied,
        scrollTop: scroller.scrollTop,
        selectionLine: view.state.doc.lineAt(selectionHead).number,
        viewportFromLine: view.state.doc.lineAt(view.viewport.from).number,
        viewportToLine: view.state.doc.lineAt(view.viewport.to).number,
        selectionVisible: Boolean(
          selectionCoords && selectionCoords.bottom > viewport.top && selectionCoords.top < viewport.bottom
        )
      };
    });
    await waitForFrames(page, 8);
    const longHistoryAfterFirstUndo = await page.evaluate(() => {
      const view = (window as any).__tableHistoryEditor.view;
      return {
        line: view.state.doc.line(43).text,
        selectionLine: view.state.doc.lineAt(view.state.selection.main.head).number,
        scrollTop: (view.scrollDOM as HTMLElement).scrollTop,
        scrollSamples: [...(window as any).__longHistoryScrollSamples]
      };
    });
    if (
      !longHistorySetup.applied ||
      longHistoryAfterFirstUndo.line !== 'long history line 43' ||
      longHistoryAfterFirstUndo.selectionLine !== 43 ||
      Math.abs(longHistoryAfterFirstUndo.scrollTop - longHistorySetup.scrollTop) > 1 ||
      longHistoryAfterFirstUndo.scrollSamples.some(
        (scrollTop: number) => Math.abs(scrollTop - longHistorySetup.scrollTop) > 1
      )
    ) {
      throw new Error(`First undo after a long edit chain scrolled a visible change: ${JSON.stringify({ longHistorySetup, longHistoryAfterFirstUndo })}`);
    }

    const externalUpdatedText = visibleDocumentText.replace('visible line 35', 'visible line 35 externally edited');
    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, visibleDocumentText);
    await waitForFrames(page);
    await page.evaluate((text) => {
      const editor = (window as any).__tableHistoryEditor;
      const view = editor.view;
      const target = view.state.doc.line(35);
      view.dispatch({ selection: { anchor: target.to } });
      editor.setText(text);
      view.dispatch({ selection: { anchor: view.state.doc.line(38).from } });
    }, externalUpdatedText);
    await waitForFrames(page, 8);
    const externalHistorySetup = await page.evaluate(() => {
      const view = (window as any).__tableHistoryEditor.view;
      const scroller = view.scrollDOM as HTMLElement;
      const targetBlock = view.lineBlockAt(view.state.doc.line(35).from);
      scroller.scrollTop = Math.max(0, targetBlock.bottom - scroller.clientHeight + 1);
      view.focus();
      return { scrollTop: scroller.scrollTop };
    });
    const externalSyncDepth = await page.evaluate(() => (window as any).__tableHistoryEditor.getHistoryDepth());
    const externalUndoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.undo());
    const externalRedoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
    await waitForFrames(page, 4);
    const externalAfterHistory = await page.evaluate(() => {
      const view = (window as any).__tableHistoryEditor.view;
      const block = view.lineBlockAt(view.state.selection.main.head);
      return {
        text: view.state.doc.line(35).text,
        selectionLine: view.state.doc.lineAt(view.state.selection.main.head).number,
        scrollTop: (view.scrollDOM as HTMLElement).scrollTop,
        blockTop: block.top,
        blockBottom: block.bottom,
        clientHeight: (view.scrollDOM as HTMLElement).clientHeight
      };
    });
    const externalAfterDepth = await page.evaluate(() => (window as any).__tableHistoryEditor.getHistoryDepth());
    if (
      externalUndoApplied ||
      externalRedoApplied ||
      externalSyncDepth.undo !== externalAfterDepth.undo ||
      externalSyncDepth.redo !== externalAfterDepth.redo ||
      externalAfterHistory.text !== 'visible line 35 externally edited' ||
      externalAfterHistory.selectionLine !== 38 ||
      Math.abs(externalAfterHistory.scrollTop - externalHistorySetup.scrollTop) > 1
    ) {
      throw new Error(`External synchronization polluted history or moved the viewport: ${JSON.stringify({ externalUndoApplied, externalRedoApplied, externalHistorySetup, externalSyncDepth, externalAfterDepth, externalAfterHistory })}`);
    }

    const offscreenDocumentText = Array.from({ length: 120 }, (_, index) => `offscreen line ${index + 1}`).join('\n');
    const offscreenUpdatedText = offscreenDocumentText.replace('offscreen line 90', 'offscreen line 90 externally edited');
    await page.evaluate((text) => {
      (window as any).__tableHistoryEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__tableHistoryEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, offscreenDocumentText);
    await waitForFrames(page);
    await page.evaluate((text) => {
      const editor = (window as any).__tableHistoryEditor;
      const view = editor.view;
      const target = view.state.doc.line(90);
      view.dispatch({ selection: { anchor: target.to } });
      editor.setText(text);
      view.dispatch({ selection: { anchor: view.state.doc.line(1).from } });
    }, offscreenUpdatedText);
    await waitForFrames(page, 8);
    await page.evaluate(() => {
      const view = (window as any).__tableHistoryEditor.view;
      (view.scrollDOM as HTMLElement).scrollTop = 0;
      view.focus();
    });
    const offscreenBeforeHistory = await page.evaluate(() => (window as any).__tableHistoryEditor.getHistoryDepth());
    const offscreenUndoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.undo());
    const offscreenRedoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
    const offscreenAfterHistory = await page.evaluate(() => {
      const editor = (window as any).__tableHistoryEditor;
      const view = editor.view;
      return {
        text: view.state.doc.line(90).text,
        selectionLine: view.state.doc.lineAt(view.state.selection.main.head).number,
        scrollTop: (view.scrollDOM as HTMLElement).scrollTop,
        depth: editor.getHistoryDepth()
      };
    });
    if (
      offscreenUndoApplied ||
      offscreenRedoApplied ||
      offscreenBeforeHistory.undo !== offscreenAfterHistory.depth.undo ||
      offscreenBeforeHistory.redo !== offscreenAfterHistory.depth.redo ||
      offscreenAfterHistory.text !== 'offscreen line 90 externally edited' ||
      offscreenAfterHistory.selectionLine !== 1 ||
      offscreenAfterHistory.scrollTop !== 0
    ) {
      throw new Error(`Offscreen external synchronization polluted history or moved the viewport: ${JSON.stringify({ offscreenUndoApplied, offscreenRedoApplied, offscreenBeforeHistory, offscreenAfterHistory })}`);
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
    const readFiveCellState = () => page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
        '.meo-md-html-table-wrap .meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea'
      ));
      const active = document.activeElement as HTMLTextAreaElement | null;
      return {
        values: inputs.map((input) => input.value),
        activeTag: active?.tagName ?? '',
        activeClass: active instanceof HTMLElement ? active.className : '',
        activeIndex: active ? inputs.indexOf(active) : -1
      };
    });
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
    const expectedUndoCells = [5, 1, 4, 3, 0];
    const expectedRedoCells = [0, 3, 4, 1, 5];
    if (
      JSON.stringify(fiveCellResult.undos.map((state) => state.values)) !== JSON.stringify(expectedUndos) ||
      JSON.stringify(fiveCellResult.redos.map((state) => state.values)) !== JSON.stringify(expectedRedos) ||
      JSON.stringify(fiveCellResult.ctrlYUndos.map((state) => state.values)) !== JSON.stringify(expectedUndos) ||
      JSON.stringify(fiveCellResult.ctrlYRedos.map((state) => state.values)) !== JSON.stringify(expectedRedos) ||
      JSON.stringify(fiveCellResult.undos.map((state) => state.activeIndex)) !== JSON.stringify(expectedUndoCells) ||
      JSON.stringify(fiveCellResult.redos.map((state) => state.activeIndex)) !== JSON.stringify(expectedRedoCells) ||
      JSON.stringify(fiveCellResult.ctrlYUndos.map((state) => state.activeIndex)) !== JSON.stringify(expectedUndoCells) ||
      JSON.stringify(fiveCellResult.ctrlYRedos.map((state) => state.activeIndex)) !== JSON.stringify(expectedRedoCells) ||
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
