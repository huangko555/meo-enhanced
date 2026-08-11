import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-column-width-production-cutover-'));
const threeColumns = ['| A | B | C |', '| --- | --- | --- |', '| one | two | three |'].join('\n');
const twoColumns = ['| A | B |', '| --- | --- |', '| one | two |'].join('\n');

async function waitForTableLayout(
  page: any,
  selector: string,
  expectedTables?: number,
  expectedColumns?: number
): Promise<void> {
  await page.waitForFunction(
    ({ tableSelector, tableCount, columnCount }) => {
      const tables = Array.from(document.querySelectorAll<HTMLTableElement>(tableSelector));
      if (tableCount !== undefined && tables.length !== tableCount) return false;
      return tables.length > 0 && tables.every((table) => {
        const cells = Array.from(table.querySelectorAll<HTMLElement>('thead th'));
        if (columnCount !== undefined && cells.length !== columnCount) return false;
        return cells.every((cell) => {
          const rect = cell.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
      });
    },
    { polling: 'mutation', timeout: 5000 },
    { tableSelector: selector, tableCount: expectedTables, columnCount: expectedColumns }
  );
}

async function waitForTableWidth(
  page: any,
  selector: string,
  predicate: 'above' | 'below' | 'near',
  value: number,
  tolerance = 2
): Promise<void> {
  await page.waitForFunction(
    ({ tableSelector, comparison, target, epsilon }) => {
      const cell = document.querySelector<HTMLElement>(`${tableSelector} thead th:first-child`);
      if (!cell) return false;
      const width = cell.getBoundingClientRect().width;
      if (comparison === 'above') return width > target;
      if (comparison === 'below') return width < target;
      return Math.abs(width - target) < epsilon;
    },
    { polling: 'mutation', timeout: 5000 },
    { tableSelector: selector, comparison: predicate, target: value, epsilon: tolerance }
  );
}

async function drag(
  page: any,
  selector: string,
  delta: number,
  finish: 'up' | 'cancel' | 'leave' | 'lostpointercapture' = 'up'
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
  } else if (finish === 'cancel') {
    await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 0
    })));
    await page.mouse.up();
  } else {
    await page.$eval(selector, (handle: Element, terminal: string) => {
      const target = terminal === 'leave' ? handle.closest('.cm-editor') ?? handle : handle;
      target.dispatchEvent(new PointerEvent(terminal === 'leave' ? 'pointerleave' : 'lostpointercapture', {
        pointerId: 1,
        pointerType: 'mouse',
        buttons: 0,
        bubbles: true
      }));
    }, finish);
    await page.mouse.up();
  }
  await page.waitForFunction(
    (handleSelector) => document.querySelector(handleSelector) !== null,
    { polling: 'mutation', timeout: 5000 },
    selector
  );
}

async function dragWithPresentationSamples(
  page: any,
  selector: string,
  delta: number
): Promise<Array<{ readonly primaryWidths: number[]; readonly stickyWidths: number[] }>> {
  const point = await page.$eval(selector, (handle: Element) => {
    const rect = handle.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const samples: Array<{ readonly primaryWidths: number[]; readonly stickyWidths: number[] }> = [];
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  const tableSelector = selector.split(' th:first-child ')[0];
  for (const progress of [0.2, 0.4, 0.6, 0.8, 1]) {
    await page.mouse.move(point.x + delta * progress, point.y);
    if (progress === 0.4) {
      await page.evaluate((handleSelector) => {
        const handle = document.querySelector<HTMLElement>(handleSelector);
        const table = handle?.closest<HTMLTableElement>('table');
        const container = table?.parentElement as HTMLElement | null;
        if (!container) throw new Error('Missing table container during column-width drag');
        container.style.width = `${Math.max(180, container.clientWidth - 24)}px`;
      }, selector);
    }
    samples.push(await page.evaluate(async (handleSelector) => {
      const handle = document.querySelector<HTMLElement>(handleSelector);
      const table = handle?.closest<HTMLTableElement>('table');
      if (!table) throw new Error('Missing table during column-width drag');
      const primaryWidths = Array.from(table.querySelectorAll<HTMLElement>('thead th'))
        .map((cell) => cell.getBoundingClientRect().width);
      const stickyWidths = Array.from(
        table.closest('.meo-md-html-table-shell')!
          .querySelectorAll<HTMLElement>('.meo-md-html-table-sticky-table colgroup > col')
      ).map((column) => {
        const visibleWidth = column.getBoundingClientRect().width;
        return visibleWidth || Number.parseFloat(getComputedStyle(column).width) || 0;
      });
      return { primaryWidths, stickyWidths };
    }, selector));
  }
  await page.mouse.up();
  await waitForTableLayout(page, selector);
  return samples;
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
    const tableSelector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table)';
    const firstHandle = `${tableSelector}:first-of-type th:first-child .meo-md-html-table-column-resize-handle`;
    await waitForTableLayout(page, tableSelector, 2, 3);
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

    const dragSamples = await dragWithPresentationSamples(page, firstHandle, 70);
    for (let index = 1; index < dragSamples.length; index += 1) {
      assert.ok(
        dragSamples[index].primaryWidths[0] > dragSamples[index - 1].primaryWidths[0] + 5,
        `column-width drag regressed between samples ${index - 1} and ${index}: ${JSON.stringify(dragSamples)}`
      );
      assert.deepEqual(
        dragSamples[index].stickyWidths.map(Math.round),
        dragSamples[index].primaryWidths.map(Math.round),
        `sticky projection diverged during drag sample ${index}: ${JSON.stringify(dragSamples[index])}`
      );
    }
    const resized = await page.evaluate((selector) => {
      const tables = Array.from(document.querySelectorAll<HTMLTableElement>(selector));
      const first = tables[0];
      const outside = document.getElementById('outside') as HTMLButtonElement;
      const primaryWidths = Array.from(first.querySelectorAll<HTMLElement>('thead th'))
        .map((cell) => cell.getBoundingClientRect().width);
      const stickyWidths = Array.from(
        first.closest('.meo-md-html-table-shell')!
          .querySelectorAll<HTMLElement>('.meo-md-html-table-sticky-table colgroup > col')
      ).map((column) => {
        const visibleWidth = column.getBoundingClientRect().width;
        return visibleWidth || Number.parseFloat(getComputedStyle(column).width) || 0;
      });
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
    await waitForTableWidth(page, tableSelector, 'near', resized.primaryWidths[0]);
    const afterPrefix = await page.$eval(`${tableSelector} thead th:first-child`, (cell) => (
      cell.getBoundingClientRect().width
    ));
    assert.ok(Math.abs(afterPrefix - resized.primaryWidths[0]) < 2);

    await page.evaluate(() => {
      const editor = (window as any).__columnWidthProduction;
      editor.setMode('source');
      editor.setMode('live');
    });
    await waitForTableWidth(page, tableSelector, 'near', resized.primaryWidths[0]);
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
    await waitForTableWidth(page, tableSelector, 'near', afterPointerCancel.width);
    const afterPointerCancelRebuild = await page.$eval(
      `${tableSelector} thead th:first-child`,
      (cell) => cell.getBoundingClientRect().width
    );
    assert.ok(Math.abs(afterPointerCancelRebuild - afterPointerCancel.width) < 2);

    const beforeLostPointerCapture = await widths(page, tableSelector);
    await drag(page, firstHandle, 28, 'lostpointercapture');
    const afterLostPointerCapture = await widths(page, tableSelector);
    assert.ok(afterLostPointerCapture[0] > beforeLostPointerCapture[0] + 20);

    const beforePointerLeave = await widths(page, tableSelector);
    await drag(page, firstHandle, 26, 'leave');
    const afterPointerLeave = await widths(page, tableSelector);
    assert.ok(afterPointerLeave[0] > beforePointerLeave[0] + 18);

    await page.evaluate((text) => {
      (window as any).__columnWidthProduction.setText(`replacement\n\n${text}\n\ntail`);
    }, markdown);
    await waitForTableWidth(page, tableSelector, 'below', resized.primaryWidths[0] - 20);
    const afterReplacement = await page.$eval(`${tableSelector} thead th:first-child`, (cell) => (
      cell.getBoundingClientRect().width
    ));
    assert.ok(afterReplacement < resized.primaryWidths[0] - 20);

    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), threeColumns);
    await waitForTableLayout(page, tableSelector, 1, 3);
    await drag(page, firstHandle, 70);
    const resizedThree = await widths(page, tableSelector);
    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), twoColumns);
    await waitForTableLayout(page, tableSelector, 1, 2);
    const afterThreeToTwo = await widths(page, tableSelector);
    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), threeColumns);
    await waitForTableLayout(page, tableSelector, 1, 3);
    const afterThreeToTwoToThree = await widths(page, tableSelector);
    assert.equal(afterThreeToTwo.length, 2);
    assert.ok(afterThreeToTwo[0] < resizedThree[0] - 1);
    assert.deepEqual(afterThreeToTwoToThree, resizedThree);

    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), twoColumns);
    await waitForTableLayout(page, tableSelector, 1, 2);
    await drag(page, firstHandle, 55);
    const resizedTwo = await widths(page, tableSelector);
    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), threeColumns);
    await waitForTableLayout(page, tableSelector, 1, 3);
    const afterTwoToThree = await widths(page, tableSelector);
    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), twoColumns);
    await waitForTableLayout(page, tableSelector, 1, 2);
    const afterTwoToThreeToTwo = await widths(page, tableSelector);
    assert.equal(afterTwoToThree.length, 3);
    assert.ok(afterTwoToThree[0] < resizedTwo[0] - 20);
    assert.deepEqual(afterTwoToThreeToTwo, resizedTwo);

    await page.evaluate((text) => (window as any).__columnWidthProduction.setText(text), threeColumns);
    await waitForTableLayout(page, tableSelector, 1, 3);
    await drag(page, firstHandle, 40);
    const beforeRowChange = await widths(page, tableSelector);
    await page.evaluate((text) => {
      (window as any).__columnWidthProduction.setText(`${text}\n| four | five | six |`);
    }, threeColumns);
    await waitForTableLayout(page, tableSelector, 1, 3);
    assert.deepEqual(await widths(page, tableSelector), beforeRowChange);

    await page.evaluate((text) => {
      (window as any).__columnWidthProduction.setText(
        `completely different prefix\n\n${text}\n\ncompletely different tail`
      );
    }, threeColumns);
    await waitForTableLayout(page, tableSelector, 1, 3);
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
    await waitForTableLayout(page, tableSelector, 1, 3);
    const afterEdit = await widths(page, tableSelector);
    await page.evaluate(async () => { await (window as any).__columnWidthProduction.undo(); });
    await waitForTableLayout(page, tableSelector, 1, 3);
    const afterUndo = await widths(page, tableSelector);
    await page.evaluate(async () => { await (window as any).__columnWidthProduction.redo(); });
    await waitForTableLayout(page, tableSelector, 1, 3);
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
    await page.waitForFunction(() => document.hidden, { timeout: 5000 });
    await page.bringToFront();
    await page.waitForFunction(() => !document.hidden, { timeout: 5000 });
    await page.mouse.up();
    await otherPage.close();
    await waitForTableLayout(page, tableSelector, 1, 3);
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
