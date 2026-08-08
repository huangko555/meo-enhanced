import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-column-width-legacy-lifecycle-'));

const threeColumns = ['| A | B | C |', '| --- | --- | --- |', '| one | two | three |'].join('\n');
const twoColumns = ['| A | B |', '| --- | --- |', '| one | two |'].join('\n');

async function waitForFrames(page: any, count = 6): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function widths(page: any): Promise<number[]> {
  return page.$$eval(
    '.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th',
    (cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width))
  );
}

async function drag(page: any, delta: number): Promise<void> {
  const point = await page.$eval(
    '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle',
    (handle: Element) => {
      const rect = handle.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
  );
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + delta, point.y, { steps: 4 });
  await page.mouse.up();
  await waitForFrames(page);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'legacy.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 760, height: 420 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'legacy.js') });
    await page.evaluate((text) => {
      (window as any).__legacyWidthEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, threeColumns);
    await waitForFrames(page, 8);

    const initial = await widths(page);
    await drag(page, 70);
    const resized = await widths(page);
    assert.ok(resized[0] > initial[0] + 60);

    await page.evaluate((text) => (window as any).__legacyWidthEditor.setText(text), twoColumns);
    await waitForFrames(page, 8);
    const afterThreeToTwo = await widths(page);
    await page.evaluate((text) => (window as any).__legacyWidthEditor.setText(text), threeColumns);
    await waitForFrames(page, 8);
    const afterThreeToTwoToThree = await widths(page);

    await page.evaluate((text) => (window as any).__legacyWidthEditor.setText(text), twoColumns);
    await waitForFrames(page, 8);
    await drag(page, 55);
    const resizedTwo = await widths(page);
    await page.evaluate((text) => (window as any).__legacyWidthEditor.setText(text), threeColumns);
    await waitForFrames(page, 8);
    const afterTwoToThree = await widths(page);
    await page.evaluate((text) => (window as any).__legacyWidthEditor.setText(text), twoColumns);
    await waitForFrames(page, 8);
    const afterTwoToThreeToTwo = await widths(page);

    await page.evaluate((text) => (window as any).__legacyWidthEditor.setText(text), threeColumns);
    await waitForFrames(page, 8);
    await drag(page, 40);
    const beforeRowChange = await widths(page);
    await page.evaluate((text) => (window as any).__legacyWidthEditor.setText(`${text}\n| four | five | six |`), threeColumns);
    await waitForFrames(page, 8);
    const afterRowChange = await widths(page);

    await page.evaluate((text) => (window as any).__legacyWidthEditor.setText(
      `completely different prefix\n\n${text}\n\ncompletely different tail`
    ), threeColumns);
    await waitForFrames(page, 8);
    const afterFullPresentation = await widths(page);

    const beforeEdit = await widths(page);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody textarea'
      )!;
      input.focus();
      input.value = `${input.value} changed`;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      (window as any).__legacyWidthEditor.commitTransientEdits();
    });
    await waitForFrames(page, 8);
    const afterEdit = await widths(page);
    await page.evaluate(async () => { await (window as any).__legacyWidthEditor.undo(); });
    await waitForFrames(page, 8);
    const afterUndo = await widths(page);
    await page.evaluate(async () => { await (window as any).__legacyWidthEditor.redo(); });
    await waitForFrames(page, 8);
    const afterRedo = await widths(page);

    await page.evaluate(() => {
      (window as any).__widthTerminalEvents = [];
      for (const type of ['blur', 'lostpointercapture', 'pointercancel', 'pointerleave', 'pointerup']) {
        window.addEventListener(type, () => (window as any).__widthTerminalEvents.push(type), true);
      }
    });
    const point = await page.$eval(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table) th:first-child .meo-md-html-table-column-resize-handle',
      (handle: Element) => {
        const rect = handle.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    );
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + 30, point.y, { steps: 2 });
    const otherPage = await browser.newPage();
    await otherPage.setContent('<!doctype html><p>other</p>');
    await otherPage.bringToFront();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await page.bringToFront();
    await page.mouse.up();
    await otherPage.close();
    await waitForFrames(page, 8);
    const terminalEvents = await page.evaluate(() => (window as any).__widthTerminalEvents);
    const afterWindowBlur = await widths(page);

    assert.equal(afterThreeToTwo.length, 2);
    assert.ok(afterThreeToTwo[0] < resized[0] - 1);
    assert.deepEqual(afterThreeToTwoToThree, resized);
    assert.equal(afterTwoToThree.length, 3);
    assert.ok(afterTwoToThree[0] < resizedTwo[0] - 20);
    assert.deepEqual(afterTwoToThreeToTwo, resizedTwo);
    assert.deepEqual(afterRowChange, beforeRowChange);
    assert.ok(afterFullPresentation[0] < beforeRowChange[0] - 20);
    assert.notDeepEqual(afterEdit, beforeEdit);
    assert.deepEqual(afterUndo, beforeEdit);
    assert.deepEqual(afterRedo, afterEdit);
    assert.ok(terminalEvents.includes('blur'));
    assert.equal(terminalEvents.includes('lostpointercapture'), false);
    assert.equal(terminalEvents.includes('pointercancel'), false);
    assert.equal(terminalEvents.includes('pointerleave'), false);
    assert.ok(terminalEvents.includes('pointerup'));
    assert.ok(afterWindowBlur[0] > afterRedo[0] + 20);
    await page.evaluate(() => (window as any).__legacyWidthEditor.destroy());
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table column width lifecycle characterization passed');
