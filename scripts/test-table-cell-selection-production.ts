import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-cell-selection-'));
const source = [
  '| A&B | <tag> |',
  '| --- | --- |',
  '| **bold &** <img src=x onerror=alert(1)> | apostrophe\'s |',
  '| r2a | r2b |',
  '',
  'outside',
  '',
  '| C | D |',
  '| --- | --- |',
  '| c1 | d1 |',
  '| c2 | d2 |'
].join('\n');

async function checkSingleCellDrag(page: Page) {
  const sourceTable = '.meo-md-html-table:not(.meo-md-html-table-sticky-table)';
  const first = `${sourceTable} tbody tr:first-child td:first-child .meo-md-html-table-cell-preview`;
  const last = `${sourceTable} tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview`;
  const selected = `${sourceTable} .meo-md-html-table-cell-selected`;
  const targetCell = `${sourceTable} tbody tr:first-child td:first-child`;
  const viewportFrameCount = 32;
  const center = (selector: string) => page.$eval(selector, element => {
    const box = element.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  });
  const facts = () => page.evaluate(selector => ({
    cells: Array.from(document.querySelectorAll(selector), cell => {
      const input = cell.querySelector<HTMLTextAreaElement>('textarea')!;
      return `${input.dataset.tableRow}:${input.dataset.tableCol}`;
    }),
    active: document.activeElement?.tagName,
    editing: document.querySelectorAll('.meo-md-html-table .is-editing').length,
    text: (window as any).__singleCellEditor.getText()
  }), selected);
  const placeTargetAtReadingPosition = async (label: string) => {
    const readingPosition = await page.evaluate((cellSelector) => {
      const editor = (window as any).__singleCellEditor;
      const cell = document.querySelector<HTMLElement>(cellSelector)!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const rect = cell.getBoundingClientRect();
      editor.view.scrollDOM.scrollTop += rect.top - viewport.top - viewport.height / 3;
      return { scrollTop: editor.view.scrollDOM.scrollTop };
    }, targetCell);
    assert.ok(readingPosition.scrollTop > 0, `${label}/single-cell target starts away from document top`);
    await page.waitForFunction((cellSelector) => {
      const editor = (window as any).__singleCellEditor;
      const cell = document.querySelector<HTMLElement>(cellSelector)!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const rect = cell.getBoundingClientRect();
      return editor.view.scrollDOM.scrollTop > 0 && rect.top >= viewport.top && rect.bottom <= viewport.bottom;
    }, {}, targetCell);
  };
  const viewportSnapshot = () => page.evaluate((cellSelector) => {
    const editor = (window as any).__singleCellEditor;
    const cell = document.querySelector<HTMLElement>(cellSelector)!;
    const rect = cell.getBoundingClientRect();
    const viewport = editor.view.scrollDOM.getBoundingClientRect();
    return {
      scrollTop: editor.view.scrollDOM.scrollTop,
      target: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      visible: rect.top >= viewport.top && rect.bottom <= viewport.bottom
    };
  }, targetCell);
  const beginViewportTrace = async () => {
    await page.evaluate(({ cellSelector, frameCount }) => {
      const editor = (window as any).__singleCellEditor;
      const trace: Array<unknown> = [];
      (window as any).__singleCellViewportTrace = trace;
      const sample = () => {
        const cell = document.querySelector<HTMLElement>(cellSelector);
        const table = cell?.closest<HTMLTableElement>('table');
        const viewport = editor.view.scrollDOM.getBoundingClientRect();
        const rect = cell?.getBoundingClientRect();
        const active = document.activeElement;
        const selectedCells = Array.from(document.querySelectorAll(
          '.meo-md-html-table:not(.meo-md-html-table-sticky-table) .meo-md-html-table-cell-selected'
        ), (selectedCell) => {
          const selectedInput = selectedCell.querySelector<HTMLTextAreaElement>('textarea')!;
          return `${selectedInput.dataset.tableRow}:${selectedInput.dataset.tableCol}`;
        });
        trace.push({
          scrollTop: editor.view.scrollDOM.scrollTop,
          target: rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } : null,
          visible: !!rect && rect.top >= viewport.top && rect.bottom <= viewport.bottom,
          expectedCellValue: editor.view.state.doc.line((window as any).__singleCellSourceLine).text.includes('**alpha**') ? '**alpha**' : '',
          focus: active === table
            ? { kind: 'table', cells: selectedCells }
            : active instanceof HTMLTextAreaElement
              ? {
                kind: 'input', row: active.dataset.tableRow ?? null, col: active.dataset.tableCol ?? null,
                value: active.value,
                selectionStart: active.selectionStart, selectionEnd: active.selectionEnd,
                stickyClone: Boolean(active.closest('.meo-md-html-table-sticky-table'))
              }
              : { kind: 'other', tag: active?.tagName ?? null }
        });
        if (trace.length < frameCount) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }, { cellSelector: targetCell, frameCount: viewportFrameCount });
  };
  const assertViewportTrace = async (
    label: string,
    before: Awaited<ReturnType<typeof viewportSnapshot>>,
    acceptsFocus: (focus: any) => boolean
  ) => {
    await page.waitForFunction(frameCount => (window as any).__singleCellViewportTrace.length === frameCount, {}, viewportFrameCount);
    const trace = await page.evaluate(() => (window as any).__singleCellViewportTrace) as Array<{
      scrollTop: number; target: unknown; visible: boolean; focus: any; expectedCellValue: string;
    }>;
    assert.equal(trace.length, viewportFrameCount, `${label}/captured every viewport frame`);
    for (const [index, frame] of trace.entries()) {
      assert.equal(frame.scrollTop, before.scrollTop, `${label}/frame ${index} did not jump scrollTop`);
      assert.deepEqual(frame.target, before.target, `${label}/frame ${index} kept target geometry`);
      assert.equal(frame.visible, true, `${label}/frame ${index} kept target in the reading viewport`);
      assert.ok(acceptsFocus(frame.focus), `${label}/frame ${index} kept a valid native focus or selection: ${JSON.stringify(frame.focus)}`);
      if (frame.focus.kind === 'input') assert.equal(frame.focus.value, frame.expectedCellValue,
        `${label}/frame ${index} paired native cell text with the accepted document`);
    }
  };
  const acceptsSingleCellRange = (focus: any) => focus?.kind === 'table'
    && JSON.stringify(focus.cells) === JSON.stringify(['1:0']);
  const acceptsTargetInput = (focus: any) => focus?.kind === 'input'
    && focus.row === '1' && focus.col === '0' && focus.selectionStart === 0 && focus.selectionEnd === 0
    && !focus.stickyClone;
  const acceptsRangeOrTargetInput = (focus: any) => acceptsSingleCellRange(focus) || acceptsTargetInput(focus);

  for (const large of [false, true]) {
    const readingPrefix = Array.from({ length: 36 }, (_, index) => `Before table ${index + 1}`).join('\n');
    const text = `${readingPrefix}\n\n| A | B |\n| --- | --- |\n| **alpha** | beta |\n| gamma | delta |\n\noutside`
      + (large ? '\n\n' + 'padding text\n'.repeat(8100) : '');
    const label = large ? 'optimized' : 'ordinary';
    assert.equal(assessLargeDocument(text).boundedEditorWork, large, `${label}/policy`);
    await page.evaluate(text => {
      (window as any).__singleCellEditor?.destroy();
      (window as any).__singleCellEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
      (window as any).__singleCellSourceLine = (window as any).__singleCellEditor.view.state.doc.lineAt(text.indexOf('| **alpha** |') + 2).number;
    }, text);
    await page.waitForSelector(first);
    await page.waitForFunction(large => (window as any).TableStabilityHarness
      .usesLargeDocumentDerivedWorkBudget((window as any).__singleCellEditor.view.state) === large, {}, large);
    await placeTargetAtReadingPosition(label);

    const selectSingle = async (releaseOutside = false) => {
      const start = await center(first), end = await center(last);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 4 });
      assert.equal(await page.$$eval(selected, cells => cells.length), 4, `${label}/cross-cell range`);
      await page.mouse.move(start.x, start.y, { steps: 4 });
      assert.deepEqual(await facts(), { cells: ['1:0'], active: 'TABLE', editing: 0, text }, `${label}/held single-cell range`);
      if (releaseOutside) {
        const outside = await page.$eval('.meo-md-html-table', table => ({
          x: table.getBoundingClientRect().left - 12
        }));
        await page.mouse.move(outside.x, start.y);
      }
      await page.mouse.up();
      assert.deepEqual(await facts(), { cells: ['1:0'], active: 'TABLE', editing: 0, text }, `${label}/released single-cell range`);
    };

    for (const key of ['Delete', 'Backspace'] as const) {
      await selectSingle(key === 'Backspace');
      if (process.env.MEO_TEST_SCREENSHOTS && key === 'Delete') {
        fs.mkdirSync(process.env.MEO_TEST_SCREENSHOTS, { recursive: true });
        for (const appearance of ['light', 'dark'] as const) {
          await page.evaluate(appearance => (window as any).TableStabilityHarness.applyBuiltInVisualBaseline(appearance), appearance);
          await (await page.$('.meo-md-html-table-shell'))!.screenshot({
            path: path.join(process.env.MEO_TEST_SCREENSHOTS, `single-cell-${label}-${appearance}.png`)
          });
        }
      }
      const historyBeforeCopy = await page.evaluate(() => (window as any).__singleCellEditor.getHistoryDepth());
      const beforeCopy = await viewportSnapshot();
      await beginViewportTrace();
      const copied = await page.evaluate(() => {
        const clipboard = new DataTransfer();
        const event = new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true });
        document.dispatchEvent(event);
        return {
          prevented: event.defaultPrevented,
          plain: clipboard.getData('text/plain'),
          html: clipboard.getData('text/html'),
          meo: clipboard.getData('application/x-meo-table-cells+json'),
          history: (window as any).__singleCellEditor.getHistoryDepth()
        };
      });
      assert.equal(copied.prevented, true, `${label}/single-cell copy handled`);
      assert.equal(copied.plain, '**alpha**', `${label}/single-cell copy source`);
      assert.equal(copied.html, '<table><tr><td><strong>alpha</strong></td></tr></table>', `${label}/single-cell copy format`);
      assert.ok(copied.meo, `${label}/single-cell copy internal format`);
      assert.deepEqual(copied.history, historyBeforeCopy, `${label}/copy adds no history`);
      await assertViewportTrace(`${label}/${key}/copy`, beforeCopy, acceptsSingleCellRange);

      const cleared = text.replace('| **alpha** | beta |', '|  | beta |');
      const beforeClear = await viewportSnapshot();
      await beginViewportTrace();
      await page.keyboard.press(key);
      await page.waitForFunction(expected => (window as any).__singleCellEditor.getText() === expected, {}, cleared);
      const assertEditing = async (expected: string) => {
        await page.waitForFunction(expected => {
          const input = document.activeElement;
          return (window as any).__singleCellEditor.getText() === expected
            && input instanceof HTMLTextAreaElement && input.dataset.tableRow === '1'
            && input.dataset.tableCol === '0' && input.selectionStart === 0 && input.selectionEnd === 0
            && !input.closest('.meo-md-html-table-sticky-table')
            && !document.querySelector('.meo-md-html-table-cell-selected');
        }, {}, expected);
      };
      await assertEditing(cleared);
      await assertViewportTrace(`${label}/${key}/clear`, beforeClear, acceptsRangeOrTargetInput);
      const beforeUndo = await viewportSnapshot();
      await beginViewportTrace();
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await assertEditing(text);
      await assertViewportTrace(`${label}/${key}/undo`, beforeUndo, acceptsTargetInput);
      const beforeRedo = await viewportSnapshot();
      await beginViewportTrace();
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyY');
      await page.keyboard.up('Control');
      await assertEditing(cleared);
      await assertViewportTrace(`${label}/${key}/redo`, beforeRedo, acceptsTargetInput);
      const beforeSecondUndo = await viewportSnapshot();
      await beginViewportTrace();
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await assertEditing(text);
      await assertViewportTrace(`${label}/${key}/second undo`, beforeSecondUndo, acceptsTargetInput);
      await page.keyboard.press('Escape');
    }

    await selectSingle();
    await page.keyboard.press('Escape');
    assert.equal(await page.$$eval(selected, cells => cells.length), 0, `${label}/Escape clears single-cell range`);
    await selectSingle();
    await page.click('#outside');
    assert.equal(await page.$$eval(selected, cells => cells.length), 0, `${label}/outside click clears single-cell range`);

    await selectSingle();
    await page.click(first);
    await page.waitForFunction(() => document.activeElement instanceof HTMLTextAreaElement);
    assert.equal(await page.$$eval(selected, cells => cells.length), 0, `${label}/click returns to text editing`);
    const nativeCopy = await page.evaluate(() => {
      const input = document.activeElement as HTMLTextAreaElement;
      input.setSelectionRange(2, 4);
      const event = new ClipboardEvent('copy', { clipboardData: new DataTransfer(), bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return event.defaultPrevented;
    });
    assert.equal(nativeCopy, false, `${label}/text copy remains native`);
    await page.keyboard.press('Backspace');
    assert.equal(await page.$eval('tbody textarea', input => input.value), '**pha**', `${label}/text deletion keeps the rest of the cell`);
    console.log(`single-cell drag, copy, clear and history checks passed (${label}, actual derived-work budget)`);
  }
  await page.evaluate(() => (window as any).__singleCellEditor.destroy());
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
    await page.setContent('<!doctype html><button id="outside">outside</button><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await checkSingleCellDrag(page);
    if (process.argv.includes('--single-cell-only')) return;
    await page.evaluate((text) => {
      (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, source);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell').length === 2);
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell').forEach((shell, index) => {
        shell.dataset.testTable = String(index);
      });
    });

    const rect = async (selector: string) => {
      const value = await page.$eval(selector, (element) => {
        const box = element.getBoundingClientRect();
        return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
      });
      return value;
    };
    const drag = async (from: string, to: string, hold = false) => {
      const start = await rect(from);
      const end = await rect(to);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 4 });
      const selected = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (selected <= 1) throw new Error(`drag ${from} -> ${to} selected ${selected} cells`);
      if (!hold) await page.mouse.up();
    };

    const first = '.meo-md-html-table-shell[data-test-table="0"] tbody tr:first-child td:first-child .meo-md-html-table-cell-preview';
    const last = '.meo-md-html-table-shell[data-test-table="0"] tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview';
    await page.click(first);
    await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).blur());
    await drag('.meo-md-html-table-shell[data-test-table="0"] tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview', last);
    if (await page.$('.meo-md-html-table:not(.meo-md-html-table-sticky-table) .is-editing')) {
      throw new Error('A multi-cell selection retained the suspended editing cell');
    }
    await page.keyboard.press('Escape');
    await drag(first, last);
    const persisted = await page.evaluate(() => ({
      count: document.querySelectorAll('.meo-md-html-table-cell-selected').length,
      active: document.activeElement?.tagName,
      editing: document.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) .is-editing').length
    }));
    if (persisted.count !== 4 || persisted.active !== 'TABLE' || persisted.editing !== 0) {
      throw new Error(`pointerup did not persist the visible rectangle: ${JSON.stringify(persisted)}`);
    }

    const beforeDeleteKeys = await page.evaluate(() => ({
      text: (window as any).__selectionEditor.view.state.doc.toString(),
      values: Array.from(
        document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table-shell[data-test-table="0"] textarea')
      ).map((input) => input.value)
    }));
    const expectedClearTarget = await page.$eval(first, (preview) => {
      const input = preview.closest('td')?.querySelector<HTMLTextAreaElement>('textarea');
      return {
        row: input?.dataset.tableRow ?? null,
        col: input?.dataset.tableCol ?? null
      };
    });
    const assertSelectionCleared = async (key: 'Delete' | 'Backspace') => {
      const selectedBefore = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (selectedBefore !== 4) await drag(first, last);
      await page.keyboard.press(key);
      await page.waitForFunction(() => {
        const inputs = Array.from(
          document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table-shell[data-test-table="0"] tbody textarea')
        );
        return inputs.length === 4 && inputs.every((input) => input.value === '');
      });
      const cleared = await page.evaluate(() => ({
        text: (window as any).__selectionEditor.view.state.doc.toString(),
        selected: document.querySelectorAll('.meo-md-html-table-cell-selected').length,
        active: document.activeElement?.tagName,
        row: document.activeElement instanceof HTMLTextAreaElement
          ? document.activeElement.dataset.tableRow ?? null
          : null,
        col: document.activeElement instanceof HTMLTextAreaElement
          ? document.activeElement.dataset.tableCol ?? null
          : null,
        caret: document.activeElement instanceof HTMLTextAreaElement
          ? document.activeElement.selectionStart
          : null,
        stickyClone: Boolean(document.activeElement?.closest('.meo-md-html-table-sticky-table'))
      }));
      if (
        cleared.selected !== 0 || cleared.active !== 'TEXTAREA'
        || cleared.row !== expectedClearTarget.row || cleared.col !== expectedClearTarget.col
        || cleared.caret !== 0 || cleared.stickyClone
        || !/^\| A&B \| <tag> \|/m.test(cleared.text)
      ) {
        throw new Error(`${key} did not atomically clear the rectangle and focus its top-left cell: ${JSON.stringify(cleared)}`);
      }
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyZ');
      await page.keyboard.up('Control');
      await page.waitForFunction((originalText) => (
        (window as any).__selectionEditor.view.state.doc.toString() === originalText
      ), {}, beforeDeleteKeys.text);
      const restored = await page.evaluate(() => ({
        values: Array.from(
          document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table-shell[data-test-table="0"] textarea')
        ).map((input) => input.value),
        selected: document.querySelectorAll('.meo-md-html-table-cell-selected').length,
        active: document.activeElement?.tagName,
        row: document.activeElement instanceof HTMLTextAreaElement
          ? document.activeElement.dataset.tableRow ?? null
          : null,
        col: document.activeElement instanceof HTMLTextAreaElement
          ? document.activeElement.dataset.tableCol ?? null
          : null,
        caret: document.activeElement instanceof HTMLTextAreaElement
          ? document.activeElement.selectionStart
          : null,
        stickyClone: Boolean(document.activeElement?.closest('.meo-md-html-table-sticky-table'))
      }));
      if (JSON.stringify(restored.values) !== JSON.stringify(beforeDeleteKeys.values)) {
        throw new Error(`${key} clear was not restored by one undo step: ${JSON.stringify(restored)}`);
      }
      if (
        restored.active !== 'TEXTAREA'
        || restored.row !== expectedClearTarget.row || restored.col !== expectedClearTarget.col
        || restored.caret !== 0 || restored.stickyClone
      ) {
        throw new Error(`${key} undo did not restore focus to the cleared rectangle's top-left cell: ${JSON.stringify(restored)}`);
      }
      await page.click('#outside');
      await page.waitForFunction((selector) => {
        const preview = document.querySelector<HTMLElement>(selector);
        return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
      }, {}, first);
    };
    await assertSelectionCleared('Delete');
    await assertSelectionCleared('Backspace');

    await drag(first, last);

    await page.evaluate(() => {
      (window as any).__selectionClipboard = null;
      document.addEventListener('copy', (event) => {
        (window as any).__selectionClipboard = {
          types: Array.from(event.clipboardData?.types ?? []),
          plain: event.clipboardData?.getData('text/plain') ?? '',
          html: event.clipboardData?.getData('text/html') ?? ''
        };
      }, { capture: true, once: true });
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyC');
    await page.keyboard.up('Control');
    const copied = await page.evaluate(() => (window as any).__selectionClipboard);
    const expectedPlain = '**bold &** <img src=x onerror=alert(1)>\tapostrophe\'s\nr2a\tr2b';
    const expectedHtml = '<table><tr><td><strong>bold &amp;</strong> &lt;img src=x onerror=alert(1)&gt;</td><td>apostrophe&#39;s</td></tr><tr><td>r2a</td><td>r2b</td></tr></table>';
    if (copied?.plain !== expectedPlain || copied?.html !== expectedHtml || !copied.types.includes('text/plain') || !copied.types.includes('text/html')) {
      throw new Error(`Ctrl+C clipboard payload was incomplete: ${JSON.stringify(copied)}`);
    }

    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    const sameCell = await rect(`${first} [data-meo-source-from]`);
    await page.mouse.move(sameCell.x - 8, sameCell.y);
    await page.mouse.down();
    await page.mouse.move(sameCell.x + 8, sameCell.y, { steps: 4 });
    await page.mouse.up();
    const textSelection = await page.evaluate(() => {
      const input = document.activeElement as HTMLTextAreaElement | null;
      return { tag: input?.tagName, selected: (input?.selectionEnd ?? 0) - (input?.selectionStart ?? 0), cells: document.querySelectorAll('.meo-md-html-table-cell-selected').length };
    });
    if (textSelection.tag !== 'TEXTAREA' || textSelection.selected < 1 || textSelection.cells !== 0) {
      throw new Error(`same-cell drag did not prefer ordinary text: ${JSON.stringify(textSelection)}`);
    }

    await page.evaluate(() => {
      (window as any).__selectionEscapePrevented = null;
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          (window as any).__selectionEscapePrevented = event.defaultPrevented;
        }
      }, { capture: true, once: true });
    });
    await page.keyboard.press('Escape');
    const persistedSingleEscape = await page.evaluate(() => ({
      prevented: (window as any).__selectionEscapePrevented,
      interacting: Boolean(document.querySelector('.meo-md-html-table-shell[data-test-table="0"]')?.classList.contains('is-interacting')),
      nativeText: document.getSelection()?.toString() ?? ''
    }));
    if (!persistedSingleEscape.prevented || persistedSingleEscape.interacting || persistedSingleEscape.nativeText) {
      throw new Error(`persisted same-cell Escape was not Module-owned: ${JSON.stringify(persistedSingleEscape)}`);
    }

    await page.click('#outside');
    await page.waitForFunction((selector) => {
      const preview = document.querySelector<HTMLElement>(selector);
      return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
    }, {}, first);
    await page.evaluate(() => {
      const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell[data-test-table="0"] table')!;
      const nativeRelease = table.releasePointerCapture.bind(table);
      (window as any).__sameCellEscape = { released: [] as number[], nativeRelease };
      table.releasePointerCapture = (pointerId: number) => {
        (window as any).__sameCellEscape.released.push(pointerId);
        nativeRelease(pointerId);
      };
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') {
          (window as any).__sameCellEscape.prevented = event.defaultPrevented;
        }
      }, { capture: true, once: true });
    });
    const activeEscapeStart = await rect(`${first} [data-meo-source-from]`);
    await page.mouse.move(activeEscapeStart.x - 8, activeEscapeStart.y);
    await page.mouse.down();
    await page.mouse.move(activeEscapeStart.x + 8, activeEscapeStart.y, { steps: 4 });
    await page.keyboard.press('Escape');
    await page.mouse.up();
    const activeSameCellEscape = await page.evaluate(() => {
      const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell[data-test-table="0"] table')!;
      const facts = (window as any).__sameCellEscape;
      table.releasePointerCapture = facts.nativeRelease;
      return {
        released: facts.released,
        prevented: facts.prevented,
        captured: table.hasPointerCapture?.(1) ?? false,
        interacting: Boolean(table.closest('.meo-md-html-table-shell')?.classList.contains('is-interacting')),
        nativeText: document.getSelection()?.toString() ?? ''
      };
    });
    if (
      JSON.stringify(activeSameCellEscape.released) !== JSON.stringify([1]) ||
      !activeSameCellEscape.prevented ||
      activeSameCellEscape.captured ||
      activeSameCellEscape.interacting ||
      activeSameCellEscape.nativeText
    ) {
      throw new Error(`active same-cell Escape cleanup failed: ${JSON.stringify(activeSameCellEscape)}`);
    }

    await page.click('#outside');
    await page.waitForFunction((selector) => {
      const preview = document.querySelector<HTMLElement>(selector);
      return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
    }, {}, first);
    const ownerStart = await rect(`${first} [data-meo-source-from]`);
    await page.mouse.move(ownerStart.x - 8, ownerStart.y);
    await page.mouse.down();
    await page.mouse.move(ownerStart.x + 8, ownerStart.y, { steps: 4 });
    const secondPointer = await page.evaluate(async () => {
      const cell = document.querySelector<HTMLTableCellElement>(
        '.meo-md-html-table-shell[data-test-table="0"] tbody tr:first-child td:nth-child(2)'
      )!;
      const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!;
      const input = cell.querySelector<HTMLTextAreaElement>('textarea')!;
      const box = preview.getBoundingClientRect();
      const selection = document.getSelection();
      const ranges = Array.from({ length: selection?.rangeCount ?? 0 }, (_value, index) => (
        selection!.getRangeAt(index).cloneRange()
      ));
      const originalRemoveAllRanges = Selection.prototype.removeAllRanges;
      let removeAllRangesCalls = 0;
      Selection.prototype.removeAllRanges = function () {
        removeAllRangesCalls += 1;
        return originalRemoveAllRanges.call(this);
      };
      const before = {
        text: selection?.toString() ?? '',
        selected: document.querySelectorAll('.meo-md-html-table-cell-selected').length
      };
      const styleMutations: string[] = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          styleMutations.push(`${(record.target as Element).className}:${record.attributeName}`);
        }
      });
      observer.observe(input, { attributes: true, attributeFilter: ['style'] });
      observer.observe(preview, { attributes: true, attributeFilter: ['style'] });
      const dispatch = (target: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', pointerId: number) => {
        const event = new PointerEvent(type, {
          pointerId,
          pointerType: 'touch',
          isPrimary: false,
          button: 0,
          bubbles: true,
          cancelable: true,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2
        });
        target.dispatchEvent(event);
        return event.defaultPrevented;
      };
      let defaultPrevented: boolean[] = [];
      try {
        defaultPrevented = [
          dispatch(preview, 'pointerdown', 2),
          dispatch(preview, 'pointermove', 2),
          dispatch(preview, 'pointerup', 2),
          dispatch(input, 'pointerdown', 3)
        ];
        await Promise.resolve();
      } finally {
        observer.disconnect();
        Selection.prototype.removeAllRanges = originalRemoveAllRanges;
      }
      // Synthetic pointerdown performs a browser default selection collapse that
      // a physical secondary touch does not. Restore only that synthetic default;
      // an Adapter call to removeAllRanges remains observable and fails below.
      if (removeAllRangesCalls === 0 && selection?.rangeCount === 0) {
        for (const range of ranges) selection.addRange(range);
      }
      return {
        before,
        after: {
          text: selection?.toString() ?? '',
          selected: document.querySelectorAll('.meo-md-html-table-cell-selected').length
        },
        removeAllRangesCalls,
        defaultPrevented,
        styleMutations,
        capturedSecondPointer: document.querySelector<HTMLTableElement>(
          '.meo-md-html-table-shell[data-test-table="0"] table'
        )!.hasPointerCapture?.(2) || document.querySelector<HTMLTableElement>(
          '.meo-md-html-table-shell[data-test-table="0"] table'
        )!.hasPointerCapture?.(3) || false
      };
    });
    if (
      !secondPointer.before.text ||
      secondPointer.after.text !== secondPointer.before.text ||
      secondPointer.after.selected !== secondPointer.before.selected ||
      secondPointer.removeAllRangesCalls !== 0 ||
      secondPointer.defaultPrevented.some(Boolean) ||
      secondPointer.styleMutations.length !== 0 ||
      secondPointer.capturedSecondPointer
    ) {
      throw new Error(`second pointer changed the active pointer transaction: ${JSON.stringify(secondPointer)}`);
    }
    await page.mouse.up();
    const ownerCommit = await page.evaluate(() => {
      const input = document.activeElement as HTMLTextAreaElement | null;
      return {
        tag: input?.tagName,
        selected: (input?.selectionEnd ?? 0) - (input?.selectionStart ?? 0)
      };
    });
    if (ownerCommit.tag !== 'TEXTAREA' || ownerCommit.selected < 1) {
      throw new Error(`second pointer prevented the owner pointerup: ${JSON.stringify(ownerCommit)}`);
    }
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('button[data-tooltip="Delete column"]')!
        .click();
    });
    await page.waitForFunction(() => (window as any).__selectionEditor.getText().startsWith('| <tag> |'));
    await page.evaluate((text) => (window as any).__selectionEditor.setText(text), source);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell').length === 2);
    await page.evaluate(() => {
      document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell').forEach((shell, index) => {
        shell.dataset.testTable = String(index);
      });
    });

    await page.click('#outside');
    await page.waitForFunction(() => document.activeElement?.id === 'outside');
    await page.waitForFunction((selector) => {
      const preview = document.querySelector<HTMLElement>(selector);
      return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
    }, {}, first);
    await drag(last, first);
    const reverseCount = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
    if (reverseCount !== 4) throw new Error(`reverse drag selected ${reverseCount} cells`);
    await page.click('#outside');
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    await page.waitForFunction((selector) => {
      const preview = document.querySelector<HTMLElement>(selector);
      return preview?.isConnected && getComputedStyle(preview).visibility === 'visible';
    }, {}, first);

    const beginCapturedDrag = async () => {
      await page.evaluate(() => {
        const table = document.querySelector<HTMLTableElement>(
          '.meo-md-html-table-shell[data-test-table="0"] table'
        )!;
        const nativeRelease = table.releasePointerCapture.bind(table);
        (window as any).__selectionCapture = { table, released: [] as number[], nativeRelease };
        table.releasePointerCapture = (pointerId: number) => {
          (window as any).__selectionCapture.released.push(pointerId);
          nativeRelease(pointerId);
        };
      });
      await drag(first, last, true);
      const captured = await page.evaluate(() => {
        const facts = (window as any).__selectionCapture;
        return facts.table.hasPointerCapture?.(1) ?? false;
      });
      if (!captured) throw new Error('real drag did not establish pointer capture');
    };
    const assertCaptureCleared = async (reason: string) => {
      const facts = await page.evaluate(() => {
        const capture = (window as any).__selectionCapture;
        const table = capture.table as HTMLTableElement;
        table.releasePointerCapture = capture.nativeRelease;
        return {
          released: capture.released,
          captured: table.hasPointerCapture?.(1) ?? false,
          selected: table.querySelectorAll('.meo-md-html-table-cell-selected').length,
          interacting: Boolean(table.closest('.meo-md-html-table-shell')?.classList.contains('is-interacting')),
          nativeText: document.getSelection()?.toString() ?? ''
        };
      });
      if (
        JSON.stringify(facts.released) !== JSON.stringify([1]) ||
        facts.captured ||
        facts.selected ||
        facts.interacting ||
        facts.nativeText
      ) {
        throw new Error(`${reason} did not complete active capture cleanup: ${JSON.stringify(facts)}`);
      }
    };

    await beginCapturedDrag();
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await assertCaptureCleared('Escape');

    await beginCapturedDrag();
    await page.evaluate((text) => (window as any).__selectionEditor.setText(text), source);
    await page.mouse.up();
    await assertCaptureCleared('same-text external presentation');

    const selectedSourceCells = '.meo-md-html-table-shell[data-test-table="0"] .meo-md-html-table:not(.meo-md-html-table-sticky-table) .meo-md-html-table-cell-selected';
    const outsideReleases = await page.$eval('.meo-md-html-table-shell[data-test-table="0"] table', table => {
      const box = table.getBoundingClientRect();
      return [
        { x: box.right + 16, y: box.top + box.height / 2 },
        { x: box.left - 16, y: box.top + box.height / 2 },
        { x: box.left + box.width / 2, y: box.top - 12 },
        { x: box.left + box.width / 2, y: box.bottom + 12 }
      ];
    });
    for (const outside of outsideReleases) {
      await beginCapturedDrag();
      await page.mouse.move(outside.x, outside.y, { steps: 2 });
      const visibleRange = await page.$$eval(selectedSourceCells, cells => cells.map(cell => {
        const input = cell.querySelector<HTMLTextAreaElement>('textarea')!;
        return `${input.dataset.tableRow}:${input.dataset.tableCol}`;
      }));
      await page.mouse.up();
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const released = await page.evaluate(() => {
        const capture = (window as any).__selectionCapture;
        const table = capture.table as HTMLTableElement;
        table.releasePointerCapture = capture.nativeRelease;
        return {
          released: capture.released,
          captured: table.hasPointerCapture?.(1) ?? false,
          selected: Array.from(table.querySelectorAll('.meo-md-html-table-cell-selected'), cell => {
            const input = cell.querySelector<HTMLTextAreaElement>('textarea')!;
            return `${input.dataset.tableRow}:${input.dataset.tableCol}`;
          }),
          active: document.activeElement === table
        };
      });
      if (JSON.stringify(released.released) !== '[1]' || released.captured || !released.active ||
        JSON.stringify(released.selected) !== JSON.stringify(visibleRange)) {
        throw new Error(`Outside pointerup discarded the visible range: ${JSON.stringify({ outside, visibleRange, released })}`);
      }
      await page.keyboard.press('Escape');
    }

    const outsideMoves = await page.$eval('.meo-md-html-table-shell[data-test-table="0"] table', table => {
      const box = table.getBoundingClientRect();
      const at = (row: number, col: number) => {
        const cell = table.querySelector<HTMLTableCellElement>(`[data-table-row="${row}"][data-table-col="${col}"]`)!;
        const rect = cell.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      };
      const first = at(1, 0), last = at(2, 1);
      const all = ['1:0', '1:1', '2:0', '2:1'];
      return [
        { edge: 'right, shrink', x: box.right + 16, y: first.y, selected: ['1:0', '1:1'] },
        { edge: 'right, grow', x: box.right + 16, y: last.y, selected: all },
        { edge: 'left', x: box.left - 16, y: last.y, selected: ['1:0', '2:0'] },
        { edge: 'collapse to anchor', x: box.left - 16, y: first.y, selected: ['1:0'] },
        { edge: 'left, grow again', x: box.left - 16, y: last.y, selected: ['1:0', '2:0'] },
        { edge: 'top, grow', x: last.x, y: box.top - 12, selected: ['0:0', '0:1', '1:0', '1:1'] },
        { edge: 'top, shrink', x: first.x, y: box.top - 12, selected: ['0:0', '1:0'] },
        { edge: 'bottom, grow', x: last.x, y: box.bottom + 12, selected: all },
        { edge: 'bottom, shrink', x: first.x, y: box.bottom + 12, selected: ['1:0', '2:0'] },
        { edge: 'top left corner', x: box.left - 16, y: box.top - 12, selected: ['0:0', '1:0'] },
        { edge: 'bottom right corner', x: box.right + 16, y: box.bottom + 12, selected: all },
        { edge: 'reenter table', x: last.x, y: last.y, selected: all },
        { edge: 'release outside', x: box.right + 16, y: last.y, selected: all }
      ];
    });
    for (const capturePointer of [true, false]) {
      if (!capturePointer) await page.evaluate(() => {
        const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell[data-test-table="0"] table')!;
        (window as any).__selectionNoCapture = { table, setPointerCapture: table.setPointerCapture };
        table.setPointerCapture = () => {};
      });
      const start = await rect(first);
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (const move of outsideMoves) {
        await page.mouse.move(move.x, move.y);
        const selected = await page.$$eval(selectedSourceCells, cells => cells.map(cell => {
          const input = cell.querySelector<HTMLTextAreaElement>('textarea')!;
          return `${input.dataset.tableRow}:${input.dataset.tableCol}`;
        }));
        if (JSON.stringify(selected) !== JSON.stringify(move.selected)) {
          throw new Error(`Outside drag did not adjust the range (${move.edge}, capture=${capturePointer}): ${JSON.stringify({ selected, expected: move.selected })}`);
        }
      }
      await page.mouse.up();
      if (!capturePointer) await page.evaluate(() => {
        const saved = (window as any).__selectionNoCapture;
        saved.table.setPointerCapture = saved.setPointerCapture;
      });
      if (await page.$$eval(selectedSourceCells, cells => cells.length) !== 4) {
        throw new Error('Outside drag release lost its final projected range');
      }
      await page.keyboard.press('Escape');
    }

    await beginCapturedDrag();
    await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>(
        '.meo-md-html-table-shell[data-test-table="1"] tbody tr:first-child td:first-child'
      )!;
      const box = target.getBoundingClientRect();
      target.dispatchEvent(new PointerEvent('pointerdown', {
        pointerId: 2,
        pointerType: 'touch',
        isPrimary: false,
        button: 0,
        bubbles: true,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2
      }));
      target.dispatchEvent(new PointerEvent('pointercancel', {
        pointerId: 2, pointerType: 'touch', bubbles: true, cancelable: true
      }));
    });
    await page.mouse.up();
    await assertCaptureCleared('cross-table transfer');

    const secondFirst = '.meo-md-html-table-shell[data-test-table="1"] tbody tr:first-child td:first-child .meo-md-html-table-cell-preview';
    const secondLast = '.meo-md-html-table-shell[data-test-table="1"] tbody tr:nth-child(2) td:nth-child(2) .meo-md-html-table-cell-preview';
    await drag(first, last);
    await drag(secondFirst, secondLast);
    const tableSelections = await page.$$eval('.meo-md-html-table-shell', (shells) => shells.map((shell) => shell.querySelectorAll('.meo-md-html-table-cell-selected').length));
    if (JSON.stringify(tableSelections) !== JSON.stringify([0, 4])) {
      throw new Error(`cross-table transfer retained the old owner: ${JSON.stringify(tableSelections)}`);
    }
    await page.keyboard.press('Escape');
    await page.click(first);
    await page.click(secondFirst);
    const editingOwners = await page.$$eval('.meo-md-html-table-shell', shells => shells.map(shell =>
      shell.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) .is-editing').length));
    if (JSON.stringify(editingOwners) !== JSON.stringify([0, 1])) {
      throw new Error(`Cross-table focus retained the old editing cell: ${JSON.stringify(editingOwners)}`);
    }
    await page.click('#outside');
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table:not(.meo-md-html-table-sticky-table) .is-editing').length === 0);

    for (const type of ['pointercancel', 'lostpointercapture'] as const) {
      await page.keyboard.press('Escape');
      await drag(first, last, true);
      await page.evaluate((eventType) => {
        document.querySelector('.meo-md-html-table-shell table')!.dispatchEvent(new PointerEvent(eventType, {
          pointerId: 2, bubbles: true, cancelable: true
        }));
      }, type);
      const afterForeignBoundary = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (afterForeignBoundary !== 4) {
        throw new Error(`${type} from a non-owner cleared ${afterForeignBoundary} selected cells`);
      }
      await page.mouse.up();
      const afterOwnerUp = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (afterOwnerUp !== 4) throw new Error(`${type} from a non-owner prevented owner pointerup persistence`);

      await page.keyboard.press('Escape');
      await drag(first, last, true);
      await page.evaluate((eventType) => {
        document.querySelector('.meo-md-html-table-shell table')!.dispatchEvent(new PointerEvent(eventType, {
          pointerId: 1, bubbles: true, cancelable: true
        }));
      }, type);
      await page.mouse.up();
      const count = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
      if (count !== 0) throw new Error(`${type} retained ${count} selected cells`);
    }

    await drag(first, last);
    await page.evaluate((text) => {
      (window as any).__externalTable = document.querySelector('.meo-md-html-table-shell[data-test-table="0"] table');
      (window as any).__selectionEditor.setText(text);
    }, source);
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    const externalPresentation = await page.evaluate(() => ({
      sameTable: (window as any).__externalTable === document.querySelector('.meo-md-html-table-shell[data-test-table="0"] table'),
      connected: Boolean((window as any).__externalTable?.isConnected)
    }));
    if (!externalPresentation.sameTable || !externalPresentation.connected) {
      throw new Error(`same-text external presentation replaced table DOM: ${JSON.stringify(externalPresentation)}`);
    }

    await drag(first, last);
    await page.evaluate(() => {
      (window as any).__replacementTable = document.querySelector('.meo-md-html-table-shell[data-test-table="0"] table');
      (window as any).__selectionEditor.setText('| X | Y |\n| --- | --- |\n| one | two |');
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-cell-selected').length === 0);
    await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('tbody textarea')?.value === 'one');
    const replacement = await page.evaluate(() => ({
      oldConnected: Boolean((window as any).__replacementTable?.isConnected),
      replaced: (window as any).__replacementTable !== document.querySelector('.meo-md-html-table-shell table')
    }));
    if (replacement.oldConnected || !replacement.replaced) {
      throw new Error(`replacement lifecycle was not distinct: ${JSON.stringify(replacement)}`);
    }

    await drag(
      '.meo-md-html-table-shell tbody tr:first-child td:first-child .meo-md-html-table-cell-preview',
      '.meo-md-html-table-shell tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview'
    );
    await page.evaluate(() => (window as any).__selectionEditor.setMode('source'));
    await page.waitForFunction(() => !document.querySelector('.meo-md-html-table-shell'));
    await page.evaluate(() => (window as any).__selectionEditor.setMode('live'));
    await page.waitForFunction(() => document.querySelector('.meo-md-html-table-shell'));
    const afterMode = await page.$$eval('.meo-md-html-table-cell-selected', (elements) => elements.length);
    if (afterMode !== 0) throw new Error(`mode replacement restored ${afterMode} stale selected cells`);

    await drag(
      '.meo-md-html-table-shell tbody tr:first-child td:first-child .meo-md-html-table-cell-preview',
      '.meo-md-html-table-shell tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview',
      true
    );
    const afterDestroy = await page.evaluate(() => {
      const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
      (window as any).__lateTable = table;
      const released: number[] = [];
      const nativeRelease = table.releasePointerCapture.bind(table);
      table.releasePointerCapture = (pointerId: number) => {
        released.push(pointerId);
        nativeRelease(pointerId);
      };
      (window as any).__selectionEditor.destroy();
      const before = table.outerHTML;
      const clipboard = new DataTransfer();
      const copy = new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true });
      document.dispatchEvent(copy);
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        table.dispatchEvent(new PointerEvent(type, { pointerId: 1, bubbles: true, cancelable: true }));
      }
      return {
        connected: table.isConnected,
        selected: table.querySelectorAll('.meo-md-html-table-cell-selected').length,
        unchanged: table.outerHTML === before,
        copyPrevented: copy.defaultPrevented,
        clipboardTypes: Array.from(clipboard.types),
        retainedCapture: table.hasPointerCapture?.(1) ?? false,
        released
      };
    });
    await page.mouse.up();
    if (
      afterDestroy.connected ||
      afterDestroy.selected ||
      !afterDestroy.unchanged ||
      afterDestroy.copyPrevented ||
      afterDestroy.clipboardTypes.length ||
      afterDestroy.retainedCapture ||
      JSON.stringify(afterDestroy.released) !== JSON.stringify([1])
    ) {
      throw new Error(`destroy leaked late pointer/copy effects: ${JSON.stringify(afterDestroy)}`);
    }

    await page.evaluate(() => {
      (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: '| A | B |\n| --- | --- |\n| one | two |',
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell').length === 1);
    await drag(
      '.meo-md-html-table-shell tbody tr:first-child td:first-child .meo-md-html-table-cell-preview',
      '.meo-md-html-table-shell tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview',
      true
    );
    const faultedDestroy = await page.evaluate(() => {
      const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
      const laterImageOwner = document.createElement('span');
      laterImageOwner.className = 'meo-md-image';
      let laterImageOwnerRuns = 0;
      laterImageOwner.addEventListener('meo-dispose-image-presentation', () => { laterImageOwnerRuns += 1; });
      table.append(laterImageOwner);
      const ownedText = table.querySelector('.meo-md-html-table-cell-preview')!.firstChild!;
      document.getSelection()!.setBaseAndExtent(ownedText, 0, ownedText, 1);
      const nativeRemoveAllRanges = Selection.prototype.removeAllRanges;
      const nativeRelease = table.releasePointerCapture.bind(table);
      let removeAllRangesCalls = 0;
      table.releasePointerCapture = () => {
        throw new Error('controlled release failure');
      };
      Selection.prototype.removeAllRanges = function () {
        nativeRemoveAllRanges.call(this);
        removeAllRangesCalls += 1;
        if (removeAllRangesCalls === 1) throw new Error('controlled primary cleanup failure');
      };
      let observed: unknown = null;
      try {
        (window as any).__selectionEditor.destroy();
      } catch (error) {
        observed = error;
      } finally {
        Selection.prototype.removeAllRanges = nativeRemoveAllRanges;
        table.releasePointerCapture = nativeRelease;
      }

      const clipboard = new DataTransfer();
      const copy = new ClipboardEvent('copy', { clipboardData: clipboard, bubbles: true, cancelable: true });
      document.dispatchEvent(copy);
      table.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true, cancelable: true }));
      const aggregate = observed instanceof AggregateError ? observed : null;
      return {
        errorName: observed instanceof Error ? observed.name : typeof observed,
        errors: aggregate?.errors.map((error) => error instanceof Error ? error.message : String(error)) ?? [],
        cause: aggregate?.cause instanceof Error ? aggregate.cause.message : String(aggregate?.cause ?? ''),
        laterImageOwnerRuns,
        connected: table.isConnected,
        selected: table.querySelectorAll('.meo-md-html-table-cell-selected').length,
        interacting: Boolean(table.closest('.meo-md-html-table-shell')?.classList.contains('is-interacting')),
        removeAllRangesCalls,
        copyPrevented: copy.defaultPrevented,
        clipboardTypes: Array.from(clipboard.types)
      };
    });
    await page.mouse.up();
    if (
      faultedDestroy.errorName !== 'AggregateError' ||
      JSON.stringify(faultedDestroy.errors) !== JSON.stringify([
        'controlled primary cleanup failure',
        'controlled release failure'
      ]) ||
      faultedDestroy.cause !== 'controlled primary cleanup failure' ||
      faultedDestroy.laterImageOwnerRuns !== 0 ||
      !faultedDestroy.connected ||
      faultedDestroy.selected ||
      faultedDestroy.interacting ||
      faultedDestroy.removeAllRangesCalls < 1 ||
      faultedDestroy.copyPrevented ||
      faultedDestroy.clipboardTypes.length
    ) {
      throw new Error(`release failure masked primary or skipped cleanup: ${JSON.stringify(faultedDestroy)}`);
    }

    for (const fault of ['image', 'sticky', 'listeners', 'interaction'] as const) {
      await page.evaluate((text) => {
        document.getElementById('app')!.replaceChildren();
        const harness = { active: false };
        (window as any).__destroyOwnerFault = harness;
        (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
          parent: document.getElementById('app')!,
          text,
          initialMode: 'live',
          onApplyChanges() {}
        });
      }, '| A | B |\n| --- | --- |\n| one | two |');
      await page.waitForFunction(() => document.querySelector('.meo-md-html-table-shell table'));
      const ownerFault = await page.evaluate((faultKind) => {
        const editor = (window as any).__selectionEditor;
        const harness = (window as any).__destroyOwnerFault;
        const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
        const input = table.querySelector<HTMLTextAreaElement>('textarea')!;
        const nativeWindowRemove = window.removeEventListener.bind(window);
        const nativeRemove = EventTarget.prototype.removeEventListener;
        const nativeDispatch = EventTarget.prototype.dispatchEvent;
        const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
        const nativeClearTimeout = window.clearTimeout.bind(window);
        const nativeSetTimeout = window.setTimeout.bind(window);
        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        const laterOwnerRan = { sticky: false, listeners: false, frame: false, interaction: false };
        let interactionTimer: number | undefined;

        window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
          // EditorView also removes its own resize measurement listener while
          // destroying. Only this named closure belongs to the table's sticky owner.
          if (
            harness.active &&
            type === 'resize' &&
            typeof listener === 'function' &&
            listener.name === 'requestIfActive'
          ) {
            laterOwnerRan.sticky = true;
            if (faultKind === 'sticky') throw new Error('controlled sticky owner failure');
          }
          nativeWindowRemove(type, listener, options);
        }) as typeof window.removeEventListener;
        EventTarget.prototype.removeEventListener = function (type, listener, options) {
          if (harness.active && this === table) {
            laterOwnerRan.listeners = true;
            if (faultKind === 'listeners') throw new Error('controlled listeners owner failure');
          }
          return nativeRemove.call(this, type, listener, options);
        };
        EventTarget.prototype.dispatchEvent = function (event) {
          if (
            harness.active &&
            faultKind === 'image' &&
            event.type === 'meo-dispose-image-presentation' &&
            this instanceof Element &&
            this.classList.contains('meo-md-image')
          ) {
            throw new Error('controlled image owner failure');
          }
          return nativeDispatch.call(this, event);
        };
        window.cancelAnimationFrame = (handle) => {
          if (harness.active && handle === 4242) {
            laterOwnerRan.frame = true;
            if (faultKind === 'frame') throw new Error('controlled frame owner failure');
          }
          nativeCancelAnimationFrame(handle);
        };
        window.clearTimeout = ((handle?: number) => {
          if (harness.active && interactionTimer !== undefined && handle === interactionTimer) {
            laterOwnerRan.interaction = true;
            if (faultKind === 'interaction') throw new Error('controlled interaction owner failure');
          }
          nativeClearTimeout(handle);
        }) as typeof window.clearTimeout;

        window.requestAnimationFrame = () => 4242;
        window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
          interactionTimer = nativeSetTimeout(handler, timeout, ...args);
          return interactionTimer;
        }) as typeof window.setTimeout;
        input.value = 'changed';
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'd' }));
        window.setTimeout = nativeSetTimeout;
        window.requestAnimationFrame = nativeRequestAnimationFrame;

        if (interactionTimer === undefined) throw new Error('Missing pending table edit timer before destroy');

        if (faultKind === 'image') {
          const image = document.createElement('span');
          image.className = 'meo-md-image';
          image.addEventListener('meo-dispose-image-presentation', () => {
            throw new Error('controlled image owner failure');
          });
          table.append(image);
        }
        harness.active = true;
        let observed: unknown = null;
        try {
          editor.destroy();
        } catch (error) {
          observed = error;
        } finally {
          harness.active = false;
          window.removeEventListener = nativeWindowRemove;
          EventTarget.prototype.removeEventListener = nativeRemove;
          EventTarget.prototype.dispatchEvent = nativeDispatch;
          window.cancelAnimationFrame = nativeCancelAnimationFrame;
          window.clearTimeout = nativeClearTimeout;
          window.setTimeout = nativeSetTimeout;
          window.requestAnimationFrame = nativeRequestAnimationFrame;
        }
        return {
          message: observed instanceof Error ? observed.message : String(observed),
          connected: table.isConnected,
          laterOwnerRan
        };
      }, fault);
      const expectedMessage = `controlled ${fault} owner failure`;
      if (ownerFault.message !== expectedMessage || !ownerFault.connected) {
        throw new Error(`${fault} owner did not preserve first-error DOM semantics: ${JSON.stringify(ownerFault)}`);
      }
      if (
        (fault === 'image' && (ownerFault.laterOwnerRan.sticky || ownerFault.laterOwnerRan.listeners || ownerFault.laterOwnerRan.frame)) ||
        (fault === 'sticky' && (
          ownerFault.laterOwnerRan.listeners || ownerFault.laterOwnerRan.frame
        )) ||
        (fault === 'listeners' && ownerFault.laterOwnerRan.frame) ||
        (fault === 'interaction' && (ownerFault.laterOwnerRan.sticky || ownerFault.laterOwnerRan.listeners || ownerFault.laterOwnerRan.frame))
      ) {
        throw new Error(`${fault} owner ran a later destroy owner: ${JSON.stringify(ownerFault)}`);
      }
      if (!ownerFault.laterOwnerRan.interaction) {
        throw new Error(`${fault} owner did not cancel the pending edit before resource disposal`);
      }
    }

    const commandFault = await page.evaluate(() => {
      const primaryCause = new Error('controlled target disposal cause');
      const primary = new Error('controlled target disposal failure', { cause: primaryCause });
      let lateCleanup: (() => void) | null = null;
      const registry = (window as any).TableStabilityHarness.createTableCommandTargetRegistry((cleanup: () => void) => {
        lateCleanup = cleanup;
        throw primary;
      });
      const target = {
        view: {}, identityKey: 'same-table', from: 0, isConnected: () => true,
        buildAtomicCommandTransaction: () => ({ transaction: null, outcome: 'no-op' }),
        preserveViewport: (run: () => void) => run()
      };
      const registration = registry.register(target);
      let observed: unknown = null;
      try {
        registration.dispose();
      } catch (error) {
        observed = error;
      }
      const cleanupVisible = registry.resolve(registration.id) === null;
      const replacement = { ...target, from: 1 };
      const replacementRegistration = registry.register(replacement);
      lateCleanup?.();
      const lateRejected = registry.resolve(replacementRegistration.id) === replacement;
      registry.dispose();
      return {
        message: observed instanceof Error ? observed.message : String(observed),
        cause: observed instanceof Error && observed.cause instanceof Error ? observed.cause.message : '',
        cleanupVisible,
        lateRejected,
        disposed: registry.resolve(replacementRegistration.id) === null
      };
    });
    if (
      commandFault.message !== 'controlled target disposal failure' ||
      commandFault.cause !== 'controlled target disposal cause' ||
      !commandFault.cleanupVisible ||
      !commandFault.lateRejected ||
      !commandFault.disposed
    ) {
      throw new Error(`target disposal did not preserve primary/cause or reject late cleanup: ${JSON.stringify(commandFault)}`);
    }

    const framePage = await browser.newPage();
    try {
      await framePage.setContent('<!doctype html><div id="app"></div>');
      await framePage.evaluate(() => {
        const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
        const nativeCancelAnimationFrame = window.cancelAnimationFrame.bind(window);
        (window as any).__frameDestroyFault = {
          active: false,
          requests: 0,
          cancels: 0,
          nativeRequestAnimationFrame,
          nativeCancelAnimationFrame
        };
        window.requestAnimationFrame = () => {
          (window as any).__frameDestroyFault.requests += 1;
          return 4242;
        };
        window.cancelAnimationFrame = (handle) => {
          const harness = (window as any).__frameDestroyFault;
          if (harness.active && handle === 4242) {
            harness.cancels += 1;
            throw new Error('controlled frame owner failure');
          }
          nativeCancelAnimationFrame(handle);
        };
      });
      await framePage.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
      await framePage.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
      await framePage.evaluate(() => {
        (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
          parent: document.getElementById('app')!,
          text: '| A | B |\n| --- | --- |\n| one | two |',
          initialMode: 'live',
          onApplyChanges() {}
        });
      });
      await framePage.waitForFunction(() => document.querySelector('.meo-md-html-table-shell table'));
      const frameFault = await framePage.evaluate(() => {
        const harness = (window as any).__frameDestroyFault;
        const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
        const nativeClearTimeout = window.clearTimeout.bind(window);
        let laterInteractionOwnerRuns = 0;
        window.clearTimeout = ((handle?: number) => {
          if (harness.active) laterInteractionOwnerRuns += 1;
          nativeClearTimeout(handle);
        }) as typeof window.clearTimeout;
        harness.active = true;
        let observed: unknown = null;
        try {
          (window as any).__selectionEditor.destroy();
        } catch (error) {
          observed = error;
        } finally {
          harness.active = false;
          window.requestAnimationFrame = harness.nativeRequestAnimationFrame;
          window.cancelAnimationFrame = harness.nativeCancelAnimationFrame;
          window.clearTimeout = nativeClearTimeout;
        }
        return {
          message: observed instanceof Error ? observed.message : String(observed),
          connected: table.isConnected,
          requests: harness.requests,
          cancels: harness.cancels,
          laterInteractionOwnerRuns
        };
      });
      if (
        frameFault.message !== 'controlled frame owner failure' ||
        !frameFault.connected ||
        frameFault.requests < 1 ||
        frameFault.cancels !== 1 ||
        frameFault.laterInteractionOwnerRuns !== 0
      ) {
        throw new Error(`frame owner did not short-circuit interaction owner: ${JSON.stringify(frameFault)}`);
      }
    } finally {
      await framePage.close();
    }

    for (const phase of ['begin', 'move', 'end'] as const) {
      const mapperPage = await browser.newPage();
      try {
        await mapperPage.setViewport({ width: 800, height: 500 });
        await mapperPage.setContent('<!doctype html><div id="app"></div>');
        await mapperPage.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
        await mapperPage.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
        await mapperPage.evaluate(() => {
          (window as any).__selectionEditor = (window as any).TableStabilityHarness.createEditor({
            parent: document.getElementById('app')!,
            text: '| A | B |\n| --- | --- |\n| one | two |',
            initialMode: 'live',
            onApplyChanges() {}
          });
        });
        await mapperPage.waitForFunction(() => document.querySelector('.meo-md-html-table-shell table'));
        const pageError = new Promise<Error>((resolve) => mapperPage.once('pageerror', resolve));
        const failure = await mapperPage.evaluate((mapperPhase) => {
          const table = document.querySelector<HTMLTableElement>('.meo-md-html-table-shell table')!;
          const first = table.querySelector<HTMLTableCellElement>('tbody tr:first-child td:first-child')!;
          const preview = first.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!;
          const input = first.querySelector<HTMLTextAreaElement>('textarea')!;
          const box = preview.getBoundingClientRect();
          const point = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
          const documentWithCaret = document as Document & {
            caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
          };
          const ownCaretPosition = Object.getOwnPropertyDescriptor(documentWithCaret, 'caretPositionFromPoint');
          const nativeHasCapture = table.hasPointerCapture.bind(table);
          const nativeRelease = table.releasePointerCapture.bind(table);
          const nativeRemoveAllRanges = Selection.prototype.removeAllRanges;
          const NativeAggregateError = AggregateError;
          let aggregateDetails: { errors: string[]; cause: string } | null = null;
          (window as any).AggregateError = class extends NativeAggregateError {
            constructor(errors: Iterable<unknown>, message?: string, options?: ErrorOptions) {
              const entries = Array.from(errors);
              aggregateDetails = {
                errors: entries.map((item) => item instanceof Error ? item.message : String(item)),
                cause: options?.cause instanceof Error ? options.cause.message : String(options?.cause ?? '')
              };
              super(entries, message, options);
            }
          };
          const dispatch = (type: 'pointerdown' | 'pointermove' | 'pointerup') => {
            preview.dispatchEvent(new PointerEvent(type, {
              bubbles: true,
              cancelable: true,
              button: type === 'pointerdown' ? 0 : -1,
              buttons: type === 'pointerup' ? 0 : 1,
              pointerId: 88,
              clientX: point.x,
              clientY: point.y
            }));
          };
          let mapperCalls = 0;
          let releaseCalls = 0;
          let removeAllRangesCalls = 0;
          try {
            if (mapperPhase !== 'begin') dispatch('pointerdown');
            Object.defineProperty(documentWithCaret, 'caretPositionFromPoint', {
              configurable: true,
              value: () => {
                mapperCalls += 1;
                throw new Error(`controlled ${mapperPhase} mapper failure`);
              }
            });
            if (mapperPhase === 'move') {
              table.hasPointerCapture = () => true;
              table.releasePointerCapture = () => {
                releaseCalls += 1;
                throw new Error('controlled mapper release cleanup failure');
              };
              Selection.prototype.removeAllRanges = function () {
                nativeRemoveAllRanges.call(this);
                removeAllRangesCalls += 1;
                if (removeAllRangesCalls === 1) {
                  throw new Error('controlled mapper DOM cleanup failure');
                }
              };
            }
            dispatch(mapperPhase === 'begin' ? 'pointerdown' : mapperPhase === 'move' ? 'pointermove' : 'pointerup');
          } finally {
            if (ownCaretPosition) {
              Object.defineProperty(documentWithCaret, 'caretPositionFromPoint', ownCaretPosition);
            } else {
              delete documentWithCaret.caretPositionFromPoint;
            }
            table.hasPointerCapture = nativeHasCapture;
            table.releasePointerCapture = nativeRelease;
            Selection.prototype.removeAllRanges = nativeRemoveAllRanges;
            (window as any).AggregateError = NativeAggregateError;
          }
          return {
            errors: aggregateDetails?.errors ?? [],
            cause: aggregateDetails?.cause ?? '',
            mapperCalls,
            releaseCalls,
            removeAllRangesCalls,
            selected: table.querySelectorAll('.meo-md-html-table-cell-selected').length,
            interacting: Boolean(table.closest('.meo-md-html-table-shell')?.classList.contains('is-interacting')),
            nativeText: document.getSelection()?.toString() ?? '',
            pointerEvents: input.style.pointerEvents,
            previewVisibility: preview.style.visibility
          };
        }, phase);
        const thrown = await pageError;
        const expectedPrimary = `controlled ${phase} mapper failure`;
        if (
          failure.selected || failure.interacting || failure.nativeText ||
          failure.pointerEvents || failure.previewVisibility ||
          (phase === 'move'
            ? !thrown.message.includes('Table cell selection effect cleanup failed') ||
              JSON.stringify(failure.errors) !== JSON.stringify([
                expectedPrimary,
                'controlled mapper release cleanup failure',
                'controlled mapper DOM cleanup failure'
              ]) ||
              failure.cause !== expectedPrimary || failure.releaseCalls !== 1 || failure.removeAllRangesCalls < 1
            : !thrown.message.endsWith(expectedPrimary))
        ) {
          throw new Error(`${phase} mapper failure did not reach the cleanup terminal: ${JSON.stringify({
            ...failure, thrown: { name: thrown.name, message: thrown.message }
          })}`);
        }

        const retryFrom = await mapperPage.$eval(
          '.meo-md-html-table-shell tbody tr:first-child td:first-child .meo-md-html-table-cell-preview',
          (element) => {
            const box = element.getBoundingClientRect();
            return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
          }
        );
        const retryTo = await mapperPage.$eval(
          '.meo-md-html-table-shell tbody tr:first-child td:nth-child(2) .meo-md-html-table-cell-preview',
          (element) => {
            const box = element.getBoundingClientRect();
            return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
          }
        );
        await mapperPage.mouse.move(retryFrom.x, retryFrom.y);
        await mapperPage.mouse.down();
        await mapperPage.mouse.move(retryTo.x, retryTo.y, { steps: 4 });
        await mapperPage.mouse.up();
        const retrySelection = await mapperPage.$$eval(
          '.meo-md-html-table-cell-selected',
          (elements) => elements.length
        );
        if (retrySelection !== 2) {
          throw new Error(`${phase} mapper failure blocked the next real drag: selected=${retrySelection}`);
        }
      } finally {
        await mapperPage.close();
      }
    }
    const disposalPage = await browser.newPage();
    try {
      await disposalPage.setContent('<div id="other" contenteditable="true">other editor</div><div id="app"></div>');
      await disposalPage.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
      await disposalPage.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
      for (const collapsed of [true, false]) {
        await disposalPage.evaluate(() => {
          (window as any).__disposalEditor = (window as any).TableStabilityHarness.createEditor({
            parent: document.getElementById('app')!,
            text: '| A | B |\n| --- | --- |\n| one | two |',
            initialMode: 'live', onApplyChanges() {}
          });
        });
        await disposalPage.waitForSelector('.meo-md-html-table-shell');
        const preserved = await disposalPage.evaluate((isCollapsed) => {
          const other = document.getElementById('other')!;
          const node = other.firstChild!;
          other.focus();
          const selection = document.getSelection()!;
          selection.setBaseAndExtent(node, 2, node, isCollapsed ? 2 : 7);
          (window as any).__disposalEditor.destroy();
          return selection.rangeCount === 1 && selection.anchorNode === node &&
            selection.focusNode === node && selection.anchorOffset === 2 &&
            selection.focusOffset === (isCollapsed ? 2 : 7) && document.activeElement === other;
        }, collapsed);
        if (!preserved) throw new Error(`Table disposal cleared another editor's ${collapsed ? 'caret' : 'selection'}`);
      }
    } finally {
      await disposalPage.close();
    }
    console.log('table cell selection production checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
