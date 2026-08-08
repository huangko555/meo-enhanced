import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const entryPath = path.join(repoRoot, 'scripts', 'test-table-column-width-adapter-entry.ts');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-column-width-adapter-'));

async function waitForFrames(page: any, count = 4): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function drag(page: any, selector: string, delta: number, terminal = 'pointerup'): Promise<void> {
  const point = await page.$eval(selector, (handle: Element) => {
    const rect = handle.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + delta, point.y, { steps: 3 });
  if (terminal === 'pointerup') await page.mouse.up();
  else {
    await page.evaluate((type) => window.dispatchEvent(new PointerEvent(type, {
      pointerId: 1,
      pointerType: 'mouse',
      buttons: 0
    })), terminal);
    await page.mouse.up();
  }
  await waitForFrames(page);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [entryPath],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'candidate.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 720, height: 420 });
    await page.setContent(`<!doctype html><style>
      .table-column-width-candidate-root { width: 360px; }
      [data-table-column-width] { border-collapse: collapse; table-layout: fixed; width: 300px; }
      [data-table-column-width] th { box-sizing: border-box; padding: 0; border: 0; min-width: 0; }
      [data-table-resize-column] { display: block; width: 8px; height: 18px; float: right; }
    </style><div id="app"></div>`);
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });

    await page.evaluate(() => {
      const candidate = window.TableColumnWidthAdapterCandidate!;
      (window as any).__widthCandidate = candidate.create(document.getElementById('app')!, 'abcdef');
      const root = document.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      const makeTable = (id: string, from: number, to: number, columns: number) => {
        const table = document.createElement('table');
        table.dataset.tableColumnWidth = id;
        table.dataset.tableFrom = String(from);
        table.dataset.tableTo = String(to);
        const colgroup = document.createElement('colgroup');
        const head = document.createElement('thead');
        const row = document.createElement('tr');
        for (let index = 0; index < columns; index += 1) {
          colgroup.append(document.createElement('col'));
          const cell = document.createElement('th');
          cell.textContent = String(index);
          const handle = document.createElement('span');
          handle.dataset.tableResizeColumn = String(index);
          cell.append(handle);
          row.append(cell);
        }
        head.append(row);
        table.append(colgroup, head);
        root.append(table);
        return table;
      };
      (window as any).__makeWidthTable = makeTable;
      makeTable('first', 0, 3, 3);
      makeTable('second', 3, 6, 3);
      (window as any).__widthCandidate.adapter.accept({ type: 'refresh' });
    });
    await waitForFrames(page, 6);

    const handle = '[data-table-column-width="first"] [data-table-resize-column="0"]';
    const widths = async (id: string) => page.$$eval(
      `[data-table-column-width="${id}"] th`,
      (cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width))
    );
    const initialFirst = await widths('first');
    const initialSecond = await widths('second');
    await drag(page, handle, 90);
    const resizedFirst = await widths('first');
    assert.ok(resizedFirst[0] > initialFirst[0] + 80);
    assert.deepEqual(await widths('second'), initialSecond);

    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      const first = root.querySelector('[data-table-column-width="first"]')!;
      first.remove();
      (window as any).__makeWidthTable('first', 0, 3, 2);
      (window as any).__widthCandidate.adapter.accept({ type: 'refresh' });
    });
    await waitForFrames(page);
    assert.equal((await widths('first')).length, 2);
    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      root.querySelector('[data-table-column-width="first"]')!.remove();
      (window as any).__makeWidthTable('first', 0, 3, 3);
      (window as any).__widthCandidate.adapter.accept({ type: 'refresh' });
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), resizedFirst);

    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      runtime.view.dispatch({ changes: { from: 0, insert: 'xx' } });
      const first = document.querySelector<HTMLElement>('[data-table-column-width="first"]')!;
      first.dataset.tableFrom = '2';
      first.dataset.tableTo = '5';
      runtime.adapter.accept({ type: 'refresh' });
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), resizedFirst);

    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      assert(runtime.undo());
      const first = document.querySelector<HTMLElement>('[data-table-column-width="first"]')!;
      first.dataset.tableFrom = '0';
      first.dataset.tableTo = '3';
      runtime.adapter.accept({ type: 'refresh' });
      function assert(value: unknown): asserts value {
        if (!value) throw new Error('native undo was not applied');
      }
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), resizedFirst);
    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      if (!runtime.redo()) throw new Error('native redo was not applied');
      const first = document.querySelector<HTMLElement>('[data-table-column-width="first"]')!;
      first.dataset.tableFrom = '2';
      first.dataset.tableTo = '5';
      runtime.adapter.accept({ type: 'refresh' });
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), resizedFirst);

    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      runtime.adapter.accept({ type: 'externalDocumentPresented' });
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), resizedFirst);

    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      runtime.view.dispatch({ changes: { from: 0, to: runtime.view.state.doc.length, insert: 'replacement' } });
      const first = document.querySelector<HTMLElement>('[data-table-column-width="first"]')!;
      first.dataset.tableFrom = '0';
      first.dataset.tableTo = '3';
      runtime.adapter.accept({ type: 'externalDocumentPresented' });
      runtime.adapter.accept({ type: 'refresh' });
    });
    await waitForFrames(page);
    assert.ok(Math.abs((await widths('first'))[0] - initialFirst[0]) < 2);

    await drag(page, handle, 45, 'pointercancel');
    const cancelled = await widths('first');
    assert.ok(cancelled[0] > initialFirst[0] + 35);

    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      const root = document.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      const saved = root.innerHTML;
      root.replaceChildren();
      runtime.adapter.accept({ type: 'refresh' });
      root.innerHTML = saved;
      runtime.adapter.accept({ type: 'refresh' });
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), cancelled);

    const terminalPoint = await page.$eval(handle, (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(terminalPoint.x, terminalPoint.y);
    await page.mouse.down();
    await page.mouse.move(terminalPoint.x + 20, terminalPoint.y, { steps: 2 });
    await page.evaluate(() => {
      document.querySelector('.table-column-width-candidate-root')!.dispatchEvent(
        new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse', buttons: 0 })
      );
    });
    await waitForFrames(page);
    const afterPointerLeave = await widths('first');
    await page.mouse.move(terminalPoint.x + 70, terminalPoint.y, { steps: 2 });
    await page.mouse.up();
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), afterPointerLeave);

    const blurPoint = await page.$eval(handle, (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const beforeBlurDrag = await widths('first');
    await page.mouse.move(blurPoint.x, blurPoint.y);
    await page.mouse.down();
    await page.mouse.move(blurPoint.x + 15, blurPoint.y, { steps: 2 });
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.move(blurPoint.x + 30, blurPoint.y, { steps: 2 });
    await page.mouse.up();
    await waitForFrames(page);
    assert.ok((await widths('first'))[0] > beforeBlurDrag[0] + 25);

    const beforeResize = await widths('first');
    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      root.style.width = '260px';
    });
    await waitForFrames(page, 8);
    const afterResize = await widths('first');
    assert.ok(afterResize.reduce((sum, width) => sum + width, 0) < beforeResize.reduce((sum, width) => sum + width, 0));

    const disposePoint = await page.$eval(handle, (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(disposePoint.x, disposePoint.y);
    await page.mouse.down();
    await page.mouse.move(disposePoint.x + 20, disposePoint.y, { steps: 2 });
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      (window as any).__widthCandidate.destroy();
    });
    await page.evaluate(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, pointerType: 'mouse', buttons: 1 }));
      document.querySelector('.table-column-width-candidate-root')?.dispatchEvent(
        new PointerEvent('pointerleave', { pointerId: 1, pointerType: 'mouse', buttons: 0 })
      );
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, pointerType: 'mouse', buttons: 0 }));
    });
    await page.mouse.up();
    assert.equal(await page.evaluate(() => window.TableColumnWidthAdapterCandidate!.instances), 1);
    assert.equal(await page.evaluate(() => window.TableColumnWidthAdapterCandidate!.legacyInstances), 0);
    assert.equal(await page.evaluate(() => window.TableColumnWidthAdapterCandidate!.policyInstances), 1);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table column width adapter Chromium candidate trace passed');
