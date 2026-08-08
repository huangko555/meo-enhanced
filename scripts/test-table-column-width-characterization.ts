import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-column-width-characterization-'));

async function waitForFrames(page: any, count = 6): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function drag(page: any, selector: string, delta: number, finish: 'up' | 'cancel' = 'up'): Promise<void> {
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
  await waitForFrames(page, 5);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'characterization.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 420 });
    await page.setContent('<!doctype html><button id="outside">outside</button><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'characterization.js') });

    const markdown = [
      ...Array.from({ length: 12 }, (_, index) => `paragraph ${index + 1}`),
      '',
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
      '',
      '| X | Y |',
      '| --- | --- |',
      '| left | right |',
      '',
      ...Array.from({ length: 12 }, (_, index) => `tail ${index + 1}`)
    ].join('\n');

    await page.evaluate((text) => {
      (window as any).__columnWidthEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, markdown);
    await waitForFrames(page, 8);

    const tableSelector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table)';
    const handleSelector = `${tableSelector}:nth-of-type(1) th:first-child .meo-md-html-table-column-resize-handle`;
    const initial = await page.evaluate((selector) => {
      const tables = Array.from(document.querySelectorAll<HTMLElement>(selector));
      const firstInput = tables[0].querySelector<HTMLTextAreaElement>('tbody textarea')!;
      firstInput.focus();
      firstInput.setSelectionRange(1, 1);
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      tables[0].scrollIntoView({ block: 'center' });
      return {
        widths: tables.map((table) => Array.from(table.querySelectorAll<HTMLElement>('thead th'))
          .map((cell) => cell.getBoundingClientRect().width)),
        markdown: (window as any).__columnWidthEditor.getText(),
        focusedCell: document.activeElement === firstInput,
        selectionStart: firstInput.selectionStart,
        scrollTop: scroller.scrollTop
      };
    }, tableSelector);

    await drag(page, handleSelector, 60);
    const afterFirstDrag = await page.evaluate((selector) => {
      const tables = Array.from(document.querySelectorAll<HTMLElement>(selector));
      const firstInput = tables[0].querySelector<HTMLTextAreaElement>('tbody textarea')!;
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      return {
        widths: tables.map((table) => Array.from(table.querySelectorAll<HTMLElement>('thead th'))
          .map((cell) => cell.getBoundingClientRect().width)),
        markdown: (window as any).__columnWidthEditor.getText(),
        focusedCell: document.activeElement === firstInput,
        selectionStart: firstInput.selectionStart,
        scrollTop: scroller.scrollTop
      };
    }, tableSelector);
    assert.ok(afterFirstDrag.widths[0][0] > initial.widths[0][0] + 50);
    assert.ok(Math.abs(afterFirstDrag.widths[1][0] - initial.widths[1][0]) < 2);
    assert.equal(afterFirstDrag.markdown, initial.markdown);
    assert.equal(afterFirstDrag.focusedCell, initial.focusedCell);
    assert.equal(afterFirstDrag.selectionStart, initial.selectionStart);
    assert.ok(Math.abs(afterFirstDrag.scrollTop - initial.scrollTop) < 2);

    await page.evaluate(() => (window as any).__columnWidthEditor.setMode('source'));
    await waitForFrames(page, 5);
    assert.equal(await page.$$(tableSelector).then((tables) => tables.length), 0);
    await page.evaluate(() => (window as any).__columnWidthEditor.setMode('live'));
    await waitForFrames(page, 8);
    const afterModeRoundTrip = await page.$$eval(`${tableSelector} thead th`, (cells) => (
      cells.slice(0, 2).map((cell) => cell.getBoundingClientRect().width)
    ));
    assert.ok(Math.abs(afterModeRoundTrip[0] - afterFirstDrag.widths[0][0]) < 2);

    await page.evaluate(() => {
      const editor = (window as any).__columnWidthEditor;
      editor.setText(editor.getText());
    });
    await waitForFrames(page, 6);
    const afterEqualPresentation = await page.$$eval(`${tableSelector} thead th`, (cells) => (
      cells.slice(0, 2).map((cell) => cell.getBoundingClientRect().width)
    ));
    assert.ok(Math.abs(afterEqualPresentation[0] - afterFirstDrag.widths[0][0]) < 2);

    await page.evaluate(() => {
      const editor = (window as any).__columnWidthEditor;
      editor.setText(`prefix\n\n${editor.getText()}`);
    });
    await waitForFrames(page, 8);
    const afterChangedPresentation = await page.$$eval(`${tableSelector} thead th`, (cells) => (
      cells.slice(0, 2).map((cell) => cell.getBoundingClientRect().width)
    ));
    assert.ok(Math.abs(afterChangedPresentation[0] - afterFirstDrag.widths[0][0]) < 2);

    await drag(page, handleSelector, 35, 'cancel');
    const afterPointerCancel = await page.$$eval(`${tableSelector} thead th`, (cells) => (
      cells.slice(0, 2).map((cell) => cell.getBoundingClientRect().width)
    ));
    assert.ok(afterPointerCancel[0] > afterChangedPresentation[0] + 25);
    await page.evaluate(() => (window as any).__columnWidthEditor.setMode('source'));
    await page.evaluate(() => (window as any).__columnWidthEditor.setMode('live'));
    await waitForFrames(page, 8);
    const afterCancelledDragRebuild = await page.$$eval(`${tableSelector} thead th`, (cells) => (
      cells.slice(0, 2).map((cell) => cell.getBoundingClientRect().width)
    ));
    assert.ok(Math.abs(afterCancelledDragRebuild[0] - afterPointerCancel[0]) < 2);

    const beforeDisposeWidth = afterCancelledDragRebuild[0];
    const disposePoint = await page.$eval(handleSelector, (handle: Element) => {
      const rect = handle.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(disposePoint.x, disposePoint.y);
    await page.mouse.down();
    await page.mouse.move(disposePoint.x + 25, disposePoint.y, { steps: 2 });
    await page.evaluate((text) => {
      (window as any).__columnWidthEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__columnWidthEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, markdown);
    await page.mouse.move(disposePoint.x + 80, disposePoint.y, { steps: 2 });
    await page.mouse.up();
    await waitForFrames(page, 8);
    const afterDispose = await page.$eval(`${tableSelector} thead th:first-child`, (cell) => (
      cell.getBoundingClientRect().width
    ));
    assert.ok(afterDispose < beforeDisposeWidth - 20);
    await page.evaluate(() => (window as any).__columnWidthEditor.destroy());
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table column width production characterization passed');

