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
      (window as any).__widthCandidate.adapter.acquire();
    });
    await waitForFrames(page, 6);

    const handle = '[data-table-column-width="first"] [data-table-resize-column="0"]';
    const widths = async (id: string) => page.$$eval(
      `[data-table-column-width="${id}"] th`,
      (cells) => cells.map((cell) => Math.round(cell.getBoundingClientRect().width))
    );
    const initialFirst = await widths('first');
    const initialSecond = await widths('second');

    const infeasibleTransaction = await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const runtime = window.TableColumnWidthAdapterCandidate!.create(host, 'infeasible');
      const root = host.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      root.style.width = '300px';
      const table = document.createElement('table');
      table.style.width = '330px';
      table.dataset.tableColumnWidth = 'infeasible';
      table.dataset.tableFrom = '0';
      table.dataset.tableTo = '10';
      const colgroup = document.createElement('colgroup');
      const head = document.createElement('thead');
      const row = document.createElement('tr');
      for (const [index, minimumWidth] of [180, 100, 50].entries()) {
        const column = document.createElement('col');
        column.style.width = `${minimumWidth}px`;
        colgroup.append(column);
        const cell = document.createElement('th');
        cell.style.fontSize = '10px';
        cell.style.paddingLeft = `${minimumWidth - 10}px`;
        const handle = document.createElement('span');
        handle.dataset.tableResizeColumn = String(index);
        cell.append(handle);
        row.append(cell);
      }
      head.append(row);
      table.append(colgroup, head);
      root.append(table);
      const projected = new Promise<void>((resolve) => {
        table.addEventListener('meo-table-column-width-projected', () => resolve(), { once: true });
      });
      runtime.adapter.acquire();
      await projected;
      table.style.width = '330px';
      Array.from(table.querySelectorAll<HTMLTableColElement>('col')).forEach((column, index) => {
        column.style.width = `${[180, 100, 50][index]}px`;
      });

      let pointerId = 80;
      const readWidths = () => Array.from(table.querySelectorAll<HTMLTableColElement>('col'))
        .map((column) => Math.round(Number.parseFloat(column.style.width)));
      const drag = (column: number, delta: number, terminal = 'pointerup') => {
        pointerId += 1;
        const handle = table.querySelector<HTMLElement>(`[data-table-resize-column="${column}"]`)!;
        handle.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true, cancelable: true, button: 0, buttons: 1,
          pointerId, pointerType: 'mouse', clientX: 100
        }));
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, buttons: 1, pointerId, pointerType: 'mouse', clientX: 100 + delta
        }));
        const preview = readWidths();
        window.dispatchEvent(new PointerEvent(terminal, {
          bubbles: true, buttons: 0, pointerId, pointerType: 'mouse', clientX: 100 + delta
        }));
        return { preview, committed: readWidths() };
      };

      const grown = drag(2, 24);
      const cancelled = drag(2, 8, 'pointercancel');
      const narrowed = drag(2, -12);
      const noChange = drag(2, 0);
      const expandedProjection = new Promise<void>((resolve) => {
        table.addEventListener('meo-table-column-width-projected', () => resolve(), { once: true });
      });
      root.style.width = '500px';
      await expandedProjection;
      const expanded = readWidths();
      runtime.destroy();
      host.remove();
      return { grown, narrowed, noChange, cancelled, expanded };
    });
    assert.deepEqual(infeasibleTransaction.grown.preview, [180, 100, 74]);
    assert.deepEqual(
      infeasibleTransaction.grown.committed,
      infeasibleTransaction.grown.preview,
      'finish must commit the last valid infeasible-container preview without reprojecting it'
    );
    assert.deepEqual(infeasibleTransaction.cancelled.committed, [180, 100, 82]);
    assert.deepEqual(infeasibleTransaction.narrowed.preview, [180, 100, 70]);
    assert.deepEqual(infeasibleTransaction.narrowed.committed, [180, 100, 70]);
    assert.deepEqual(infeasibleTransaction.noChange.committed, [180, 100, 70]);
    assert.deepEqual(
      infeasibleTransaction.expanded,
      [180, 100, 70],
      'an active shrink exits elastic behavior, so later container growth cannot expand or reverse it'
    );

    await drag(page, handle, 90);
    const resizedFirst = await widths('first');
    assert.ok(resizedFirst[0] > initialFirst[0] + 80);
    assert.deepEqual(await widths('second'), initialSecond);

    await page.evaluate(() => {
      document.querySelector('[data-table-column-width="second"]')?.remove();
    });
    await waitForFrames(page, 3);

    const failedTableGeneration = await page.evaluate(async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const candidate = window.TableColumnWidthAdapterCandidate!;
      const runtime = candidate.create(host, 'failure');
      const root = host.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      const table = document.createElement('table');
      table.dataset.tableColumnWidth = 'failure';
      table.dataset.tableFrom = '0';
      table.dataset.tableTo = '7';
      const colgroup = document.createElement('colgroup');
      const head = document.createElement('thead');
      const row = document.createElement('tr');
      for (let index = 0; index < 2; index += 1) {
        colgroup.append(document.createElement('col'));
        const cell = document.createElement('th');
        const handle = document.createElement('span');
        handle.dataset.tableResizeColumn = String(index);
        cell.append(handle);
        row.append(cell);
      }
      head.append(row);
      table.append(colgroup, head);
      root.append(table);
      let events = 0;
      table.addEventListener('meo-table-column-width-projected', () => { events += 1; });
      runtime.adapter.acquire();
      const frames = async (count: number) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      await frames(4);
      const handle = table.querySelector<HTMLElement>('[data-table-resize-column="0"]')!;
      const initialFirstWidth = table.querySelector<HTMLElement>('th')!.getBoundingClientRect().width;
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: 1,
        pointerId: 71,
        pointerType: 'mouse',
        clientX: 100
      }));
      window.dispatchEvent(new PointerEvent('pointermove', {
        bubbles: true,
        buttons: 1,
        pointerId: 71,
        pointerType: 'mouse',
        clientX: 120
      }));
      window.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        buttons: 0,
        pointerId: 71,
        pointerType: 'mouse',
        clientX: 120
      }));
      await frames(3);
      const intentEstablished = table.querySelector<HTMLElement>('th')!.getBoundingClientRect().width
        > initialFirstWidth + 10;
      runtime.resetProjectCalls();
      events = 0;
      runtime.failNextRefresh();
      runtime.dispatchInput(runtime.view.state.doc.length, 'a');
      table.dataset.tableTo = String(runtime.view.state.doc.length);
      root.style.width = '330px';
      await frames(4);
      const afterFailure = { projects: runtime.projectCalls(), events };
      runtime.resetProjectCalls();
      events = 0;
      runtime.dispatchInput(runtime.view.state.doc.length, 'b');
      table.dataset.tableTo = String(runtime.view.state.doc.length);
      await frames(4);
      const afterRecovery = { projects: runtime.projectCalls(), events };
      runtime.destroy();
      host.remove();
      return { intentEstablished, afterFailure, afterRecovery };
    });
    assert.equal(failedTableGeneration.intentEstablished, true, 'failure fixture must own a committed width intent');
    assert.deepEqual(failedTableGeneration.afterFailure, { projects: 0, events: 0 });
    assert.deepEqual(
      failedTableGeneration.afterRecovery,
      { projects: 1, events: 1 },
      'a failed Table generation must not replay its Resize consumer during recovery input'
    );

    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      const root = document.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      const oldTable = root.querySelector<HTMLTableElement>('[data-table-column-width="first"]')!;
      const facts = { queries: 0, reconciles: 0, writes: 0, currentEvents: 0, detachedEvents: 0 };
      const writtenTables = new Set<Element>();
      const originalQuery = Element.prototype.querySelectorAll;
      Element.prototype.querySelectorAll = function(selectors: string) {
        if (this === root && selectors === 'table[data-table-column-width]') {
          facts.reconciles += 1;
        }
        if ((this === root || root.contains(this)) && /data-table-column-width|thead th|colgroup/.test(selectors)) {
          facts.queries += 1;
        }
        return originalQuery.call(this, selectors);
      } as typeof Element.prototype.querySelectorAll;
      const writes = new MutationObserver((records) => {
        for (const record of records) {
          if (record.type === 'attributes' && record.target instanceof HTMLTableElement) {
            writtenTables.add(record.target);
          }
        }
        facts.writes = writtenTables.size;
      });
      oldTable.addEventListener('meo-table-column-width-projected', () => { facts.detachedEvents += 1; });
      runtime.resetProjectCalls();
      (window as any).__pendingObserverFirstFrame = new Promise((resolve) => {
        requestAnimationFrame(() => setTimeout(() => resolve({
          ...facts,
          projects: runtime.projectCalls()
        }), 0));
      });
      runtime.dispatchInput(runtime.view.state.doc.length, '!');
      oldTable.remove();
      const replacement = (window as any).__makeWidthTable('first', 0, 3, 3) as HTMLTableElement;
      replacement.addEventListener('meo-table-column-width-projected', () => { facts.currentEvents += 1; });
      root.style.width = '340px';
      writes.observe(root, { attributes: true, subtree: true, attributeFilter: ['style'] });
      (window as any).__pendingObserverFacts = facts;
      (window as any).__pendingObserverFinish = () => {
        writes.disconnect();
        Element.prototype.querySelectorAll = originalQuery;
      };
    });
    const pendingObserverFirstFrame = await page.evaluate(() => (
      (window as any).__pendingObserverFirstFrame
    ));
    assert.deepEqual(
      pendingObserverFirstFrame,
      { queries: 0, reconciles: 0, writes: 0, currentEvents: 0, detachedEvents: 0, projects: 0 },
      'pending Mutation/Resize callbacks must not query, project, write, or emit for current/detached tables'
    );
    await waitForFrames(page, 5);
    const pendingObserverSettled = await page.evaluate(() => {
      (window as any).__pendingObserverFinish();
      const result = {
        ...(window as any).__pendingObserverFacts,
        projects: (window as any).__widthCandidate.projectCalls()
      };
      document.querySelector<HTMLElement>('.table-column-width-candidate-root')!.style.width = '360px';
      return result;
    });
    assert.ok(pendingObserverSettled.queries > 0, 'current replacement must be queried after the barrier');
    assert.equal(pendingObserverSettled.reconciles, 1, 'Mutation/Resize/refresh must share one reconcile leaf');
    assert.equal(pendingObserverSettled.projects, 1, 'current replacement must be projected exactly once');
    assert.equal(pendingObserverSettled.writes, 1, 'only the current replacement may receive style writes');
    assert.equal(pendingObserverSettled.currentEvents, 1, 'current replacement must emit one latest projection event');
    assert.equal(pendingObserverSettled.detachedEvents, 0, 'detached binding must remain a bounded no-op');
    await waitForFrames(page, 3);

    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      const first = root.querySelector('[data-table-column-width="first"]')!;
      first.remove();
      (window as any).__makeWidthTable('first', 0, 3, 2);
      (window as any).__widthCandidate.adapter.acquire();
    });
    await waitForFrames(page);
    assert.equal((await widths('first')).length, 2);
    await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      root.querySelector('[data-table-column-width="first"]')!.remove();
      (window as any).__makeWidthTable('first', 0, 3, 3);
      (window as any).__widthCandidate.adapter.acquire();
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), resizedFirst);

    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      const first = document.querySelector<HTMLElement>('[data-table-column-width="first"]')!;
      first.dataset.tableFrom = '2';
      first.dataset.tableTo = '5';
      runtime.view.dispatch({ changes: { from: 0, insert: 'xx' } });
      runtime.adapter.acquire();
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), resizedFirst);

    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      const first = document.querySelector<HTMLElement>('[data-table-column-width="first"]')!;
      first.dataset.tableFrom = '0';
      first.dataset.tableTo = '3';
      assert(runtime.undo());
      runtime.adapter.acquire();
      function assert(value: unknown): asserts value {
        if (!value) throw new Error('native undo was not applied');
      }
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), resizedFirst);
    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      const first = document.querySelector<HTMLElement>('[data-table-column-width="first"]')!;
      first.dataset.tableFrom = '2';
      first.dataset.tableTo = '5';
      if (!runtime.redo()) throw new Error('native redo was not applied');
      runtime.adapter.acquire();
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), resizedFirst);

    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      runtime.adapter.acquire();
    });
    await waitForFrames(page);
    assert.deepEqual(await widths('first'), resizedFirst);

    await page.evaluate(() => {
      const runtime = (window as any).__widthCandidate;
      const first = document.querySelector<HTMLElement>('[data-table-column-width="first"]')!;
      first.dataset.tableFrom = '0';
      first.dataset.tableTo = '3';
      runtime.view.dispatch({ changes: { from: 0, to: runtime.view.state.doc.length, insert: 'replacement' } });
      runtime.adapter.acquire();
      runtime.adapter.acquire();
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
      runtime.adapter.acquire();
      root.innerHTML = saved;
      runtime.adapter.acquire();
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
    assert.equal(await page.evaluate(() => window.TableColumnWidthAdapterCandidate!.instances), 3);
    assert.equal(await page.evaluate(() => window.TableColumnWidthAdapterCandidate!.legacyInstances), 0);
    assert.equal(await page.evaluate(() => window.TableColumnWidthAdapterCandidate!.policyInstances), 1);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table column width adapter Chromium candidate trace passed');
