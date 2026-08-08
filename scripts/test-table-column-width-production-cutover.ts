import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-column-width-production-cutover-'));
const threeColumns = ['| A | B | C |', '| --- | --- | --- |', '| one | two | three |'].join('\n');
const twoColumns = ['| A | B |', '| --- | --- |', '| one | two |'].join('\n');

async function waitForFrames(page: any, count = 6): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function drag(
  page: any,
  selector: string,
  delta: number,
  finish: 'up' | 'cancel' = 'up'
): Promise<void> {
  const point = await page.$eval(selector, (handle: Element) => {
    const rect = handle.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + delta, point.y, { steps: 4 });
  if (finish === 'up') {
    await page.mouse.up();
  } else {
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 0
    })));
    await page.mouse.up();
  }
  await waitForFrames(page);
}

async function widths(page: any, selector: string): Promise<number[]> {
  return page.$$eval(
    `${selector} thead th`,
    (cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width))
  );
}

async function main(): Promise<void> {
  const entryPath = path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts');
  const build = await Bun.build({
    entrypoints: [entryPath],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'production.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 440 });
    await page.setContent('<!doctype html><button id="outside">outside</button><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'production.js') });

    const markdown = [
      '| A | B | C |',
      '| --- | --- | --- |',
      '| one | two | three |',
      '',
      '| X | Y | Z |',
      '| --- | --- | --- |',
      '| left | center | right |'
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__columnWidthProduction = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, markdown);
    await waitForFrames(page, 10);

    const tableSelector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table)';
    const firstHandle = `${tableSelector}:first-of-type th:first-child .meo-md-html-table-column-resize-handle`;
    const initial = await page.evaluate((selector) => {
      const tables = Array.from(document.querySelectorAll<HTMLTableElement>(selector));
      const outside = document.getElementById('outside') as HTMLButtonElement;
      outside.focus();
      return {
        owners: tables.map((table) => table.dataset.tableColumnWidthOwner),
        widths: tables.map((table) => Array.from(table.querySelectorAll<HTMLElement>('thead th'))
          .map((cell) => cell.getBoundingClientRect().width)),
        focused: document.activeElement === outside,
        scrollTop: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop
      };
    }, tableSelector);
    assert.deepEqual(initial.owners, ['adapter', 'adapter']);

    await drag(page, firstHandle, 70);
    const resized = await page.evaluate((selector) => {
      const tables = Array.from(document.querySelectorAll<HTMLTableElement>(selector));
      const first = tables[0];
      const outside = document.getElementById('outside') as HTMLButtonElement;
      const primaryWidths = Array.from(first.querySelectorAll<HTMLElement>('thead th'))
        .map((cell) => cell.getBoundingClientRect().width);
      const stickyWidths = Array.from(
        first.closest('.meo-md-html-table-shell')!
          .querySelectorAll<HTMLElement>('.meo-md-html-table-sticky-table col')
      ).map((column) => Number.parseFloat(column.style.width));
      return {
        primaryWidths,
        stickyWidths,
        secondWidths: Array.from(tables[1].querySelectorAll<HTMLElement>('thead th'))
          .map((cell) => cell.getBoundingClientRect().width),
        text: (window as any).__columnWidthProduction.getText(),
        focused: document.activeElement === outside,
        scrollTop: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop
      };
    }, tableSelector);
    assert.ok(
      resized.primaryWidths[0] > initial.widths[0][0] + 50,
      JSON.stringify({ initial: initial.widths[0], resized })
    );
    assert.deepEqual(resized.secondWidths.map(Math.round), initial.widths[1].map(Math.round));
    assert.deepEqual(resized.stickyWidths.map(Math.round), resized.primaryWidths.map(Math.round));
    assert.equal(resized.text, markdown);
    assert.equal(resized.focused, initial.focused);
    assert.ok(Math.abs(resized.scrollTop - initial.scrollTop) < 2);

    await page.evaluate(() => {
      const editor = (window as any).__columnWidthProduction;
      editor.setText(editor.getText());
      editor.setText(`prefix\n\n${editor.getText()}`);
    });
    await waitForFrames(page, 10);
    const afterPrefix = await page.$eval(`${tableSelector} thead th:first-child`, (cell) => (
      cell.getBoundingClientRect().width
    ));
    assert.ok(Math.abs(afterPrefix - resized.primaryWidths[0]) < 2);

    await page.evaluate(() => {
      const editor = (window as any).__columnWidthProduction;
      editor.setMode('source');
      editor.setMode('live');
    });
    await waitForFrames(page, 10);
    const afterModeRoundTrip = await page.$eval(`${tableSelector} thead th:first-child`, (cell) => (
      cell.getBoundingClientRect().width
    ));
    assert.ok(Math.abs(afterModeRoundTrip - resized.primaryWidths[0]) < 2);

    const beforePointerCancel = await page.evaluate((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector)!;
      const input = table.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      input.focus();
      input.setSelectionRange(1, 1);
      table.scrollIntoView({ block: 'center' });
      return {
        width: table.querySelector<HTMLElement>('thead th:first-child')!.getBoundingClientRect().width,
        focused: document.activeElement === input,
        selectionStart: input.selectionStart,
        scrollTop: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop
      };
    }, tableSelector);
    await drag(page, firstHandle, 35, 'cancel');
    const afterPointerCancel = await page.evaluate((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector)!;
      const input = table.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      return {
        width: table.querySelector<HTMLElement>('thead th:first-child')!.getBoundingClientRect().width,
        focused: document.activeElement === input,
        selectionStart: input.selectionStart,
        scrollTop: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop
      };
    }, tableSelector);
    assert.ok(afterPointerCancel.width > beforePointerCancel.width + 25);
    assert.equal(afterPointerCancel.focused, beforePointerCancel.focused);
    assert.equal(afterPointerCancel.selectionStart, beforePointerCancel.selectionStart);
    assert.ok(Math.abs(afterPointerCancel.scrollTop - beforePointerCancel.scrollTop) < 2);
    await page.evaluate(() => {
      const editor = (window as any).__columnWidthProduction;
      editor.setMode('source');
      editor.setMode('live');
    });
    await waitForFrames(page, 8);
    const afterPointerCancelRebuild = await page.$eval(
      `${tableSelector} thead th:first-child`,
      (cell) => cell.getBoundingClientRect().width
    );
    assert.ok(Math.abs(afterPointerCancelRebuild - afterPointerCancel.width) < 2);

    await page.evaluate((text) => {
      (window as any).__columnWidthProduction.setText(`replacement\n\n${text}\n\ntail`);
    }, markdown);
    await waitForFrames(page, 10);
    const afterReplacement = await page.$eval(`${tableSelector} thead th:first-child`, (cell) => (
      cell.getBoundingClientRect().width
    ));
    assert.ok(afterReplacement < resized.primaryWidths[0] - 20);

    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), threeColumns);
    await waitForFrames(page, 8);
    await drag(page, firstHandle, 70);
    const resizedThree = await widths(page, tableSelector);
    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), twoColumns);
    await waitForFrames(page, 8);
    const afterThreeToTwo = await widths(page, tableSelector);
    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), threeColumns);
    await waitForFrames(page, 8);
    const afterThreeToTwoToThree = await widths(page, tableSelector);
    assert.equal(afterThreeToTwo.length, 2);
    assert.ok(afterThreeToTwo[0] < resizedThree[0] - 1);
    assert.deepEqual(afterThreeToTwoToThree, resizedThree);

    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), twoColumns);
    await waitForFrames(page, 8);
    await drag(page, firstHandle, 55);
    const resizedTwo = await widths(page, tableSelector);
    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), threeColumns);
    await waitForFrames(page, 8);
    const afterTwoToThree = await widths(page, tableSelector);
    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), twoColumns);
    await waitForFrames(page, 8);
    const afterTwoToThreeToTwo = await widths(page, tableSelector);
    assert.equal(afterTwoToThree.length, 3);
    assert.ok(afterTwoToThree[0] < resizedTwo[0] - 20);
    assert.deepEqual(afterTwoToThreeToTwo, resizedTwo);

    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), threeColumns);
    await waitForFrames(page, 8);
    await drag(page, firstHandle, 40);
    const beforeRowChange = await widths(page, tableSelector);
    await page.evaluate((text) => {
      (window as any).__columnWidthProduction.setText(`${text}\n| four | five | six |`);
    }, threeColumns);
    await waitForFrames(page, 8);
    assert.deepEqual(await widths(page, tableSelector), beforeRowChange);

    await page.evaluate((text) => {
      (window as any).__columnWidthProduction.setText(
        `completely different prefix\n\n${text}\n\ncompletely different tail`
      );
    }, threeColumns);
    await waitForFrames(page, 8);
    const beforeEdit = await widths(page, tableSelector);
    assert.ok(beforeEdit[0] < beforeRowChange[0] - 20);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea'
      )!;
      input.focus();
      input.value = `${input.value} changed`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (window as any).__columnWidthProduction.commitTransientEdits();
    });
    await waitForFrames(page, 8);
    const afterEdit = await widths(page, tableSelector);
    await page.evaluate(async () => { await (window as any).__columnWidthProduction.undo(); });
    await waitForFrames(page, 8);
    const afterUndo = await widths(page, tableSelector);
    await page.evaluate(async () => { await (window as any).__columnWidthProduction.redo(); });
    await waitForFrames(page, 8);
    const afterRedo = await widths(page, tableSelector);
    assert.notDeepEqual(afterEdit, beforeEdit);
    assert.deepEqual(afterUndo, beforeEdit);
    assert.deepEqual(afterRedo, afterEdit);

    await page.evaluate(() => {
      (window as any).__widthTerminalEvents = [];
      for (const type of ['blur', 'lostpointercapture', 'pointercancel', 'pointerleave', 'pointerup']) {
        window.addEventListener(type, () => (window as any).__widthTerminalEvents.push(type), true);
      }
    });
    const blurPoint = await page.$eval(firstHandle, (handle: Element) => {
      const rect = handle.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(blurPoint.x, blurPoint.y);
    await page.mouse.down();
    await page.mouse.move(blurPoint.x + 30, blurPoint.y, { steps: 2 });
    const otherPage = await browser.newPage();
    await otherPage.setContent('<!doctype html><p>other</p>');
    await otherPage.bringToFront();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await page.bringToFront();
    await page.mouse.up();
    await otherPage.close();
    await waitForFrames(page, 8);
    const terminalEvents = await page.evaluate(() => (window as any).__widthTerminalEvents);
    const afterWindowBlur = await widths(page, tableSelector);
    assert.ok(terminalEvents.includes('blur'));
    assert.equal(terminalEvents.includes('lostpointercapture'), false);
    assert.equal(terminalEvents.includes('pointercancel'), false);
    assert.equal(terminalEvents.includes('pointerleave'), false);
    assert.ok(terminalEvents.includes('pointerup'));
    assert.ok(afterWindowBlur[0] > afterRedo[0] + 20);

    const disposePoint = await page.$eval(firstHandle, (handle: Element) => {
      const rect = handle.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(disposePoint.x, disposePoint.y);
    await page.mouse.down();
    await page.mouse.move(disposePoint.x + 20, disposePoint.y, { steps: 2 });
    await page.evaluate(() => (window as any).__columnWidthProduction.destroy());
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1 }));
      window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', buttons: 0 }));
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse', buttons: 0 }));
    });
    await page.mouse.up();
    assert.equal(await page.$$('[data-table-column-width-owner="adapter"]').then((items) => items.length), 0);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table column width production cutover Chromium trace passed');
