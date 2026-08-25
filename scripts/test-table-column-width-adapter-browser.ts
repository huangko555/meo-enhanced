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
    assert.deepEqual(
      infeasibleTransaction.cancelled.committed,
      infeasibleTransaction.cancelled.preview,
      'pointercancel must commit the last preview shown to the user'
    );
    assert.deepEqual(infeasibleTransaction.narrowed.preview, [180, 100, 70]);
    assert.deepEqual(infeasibleTransaction.narrowed.committed, [180, 100, 70]);
    assert.deepEqual(infeasibleTransaction.noChange.committed, [180, 100, 70]);
    assert.deepEqual(
      infeasibleTransaction.expanded,
      [180, 100, 70],
      'an active shrink exits elastic behavior, so later container growth cannot expand or reverse it'
    );

    const currentnessMatrix = await page.evaluate(() => {
      const run = (options: {
        id: string;
        initialWidth: number;
        nextWidth: number;
        minimums: readonly number[];
        nextMinimums?: readonly number[];
        terminal?: 'pointerup' | 'pointercancel' | 'lostpointercapture';
      }) => {
        const host = document.createElement('div');
        document.body.append(host);
        const runtime = window.TableColumnWidthAdapterCandidate!.createControlled(host);
        const root = host.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
        root.style.width = `${options.initialWidth}px`;
        let capturedPointer: number | null = null;
        let releases = 0;
        root.setPointerCapture = (pointerId) => { capturedPointer = pointerId; };
        root.hasPointerCapture = (pointerId) => capturedPointer === pointerId;
        root.releasePointerCapture = (pointerId) => {
          if (capturedPointer !== pointerId) throw new Error('released a pointer that was not captured');
          releases += 1;
          capturedPointer = null;
        };
        const table = document.createElement('table');
        table.style.width = `${Math.max(options.initialWidth, options.minimums.reduce((sum, value) => sum + value, 0))}px`;
        table.dataset.tableColumnWidth = options.id;
        table.dataset.tableFrom = '0';
        table.dataset.tableTo = String(options.id.length);
        const colgroup = document.createElement('colgroup');
        const head = document.createElement('thead');
        const row = document.createElement('tr');
        for (const [index, minimum] of options.minimums.entries()) {
          colgroup.append(document.createElement('col'));
          const cell = document.createElement('th');
          cell.style.fontSize = '10px';
          cell.style.paddingLeft = `${minimum - 10}px`;
          const handle = document.createElement('span');
          handle.dataset.tableResizeColumn = String(index);
          cell.append(handle);
          row.append(cell);
        }
        head.append(row);
        table.append(colgroup, head);
        root.append(table);
        runtime.adapter.acquire();
        table.style.width = `${options.initialWidth}px`;
        Array.from(table.querySelectorAll<HTMLTableColElement>('col')).forEach((column) => {
          column.style.width = `${options.initialWidth / options.minimums.length}px`;
        });
        const read = () => Array.from(table.querySelectorAll<HTMLTableColElement>('col'))
          .map((column) => Number.parseFloat(column.style.width));
        const pointerId = 220 + options.id.length;
        table.querySelector<HTMLElement>('[data-table-resize-column="0"]')!.dispatchEvent(
          new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, button: 0, buttons: 1,
            pointerId, pointerType: 'mouse', clientX: 100
          })
        );
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, buttons: 1,
          pointerId, pointerType: 'mouse', clientX: 130
        }));
        const preview = read();
        const terminal = options.terminal ?? 'pointerup';
        const terminalTarget = terminal === 'lostpointercapture' ? root : window;
        terminalTarget.dispatchEvent(new PointerEvent(terminal, {
          bubbles: true, cancelable: true, buttons: 0,
          pointerId: pointerId + 1, pointerType: 'mouse', clientX: 130
        }));
        const afterWrongTerminal = read();
        root.style.width = `${options.nextWidth}px`;
        if (options.nextMinimums) {
          Array.from(table.querySelectorAll<HTMLElement>('thead th')).forEach((cell, index) => {
            cell.style.paddingLeft = `${options.nextMinimums![index] - 10}px`;
          });
        }
        runtime.notifyResize();
        runtime.drainScheduler();
        const afterObserver = read();
        terminalTarget.dispatchEvent(new PointerEvent(terminal, {
          bubbles: true, cancelable: true, buttons: 0,
          pointerId, pointerType: 'mouse', clientX: 130
        }));
        const atTerminal = read();
        runtime.drainScheduler();
        const reconciled = read();
        window.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true, cancelable: true, buttons: 1,
          pointerId, pointerType: 'mouse', clientX: 170
        }));
        terminalTarget.dispatchEvent(new PointerEvent(terminal, {
          bubbles: true, cancelable: true, buttons: 0,
          pointerId, pointerType: 'mouse', clientX: 170
        }));
        runtime.drainScheduler();
        const afterLateTerminal = read();
        const resizing = root.classList.contains('meo-table-column-resizing');
        runtime.destroy();
        host.remove();
        return {
          preview, afterWrongTerminal, afterObserver, atTerminal, reconciled, afterLateTerminal,
          releases, resizing
        };
      };
      const runNoMove = (options: {
        id: string;
        initialWidth: number;
        nextWidth: number;
        minimums: readonly number[];
        nextMinimums?: readonly number[];
        terminal: 'pointerup' | 'pointercancel' | 'lostpointercapture';
      }) => {
        const host = document.createElement('div');
        document.body.append(host);
        const runtime = window.TableColumnWidthAdapterCandidate!.createControlled(host);
        const root = host.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
        root.style.width = `${options.initialWidth}px`;
        const table = document.createElement('table');
        table.style.width = `${options.initialWidth}px`;
        table.dataset.tableColumnWidth = options.id;
        table.dataset.tableFrom = '0';
        table.dataset.tableTo = String(options.id.length);
        const colgroup = document.createElement('colgroup');
        const head = document.createElement('thead');
        const row = document.createElement('tr');
        for (const [index, minimum] of options.minimums.entries()) {
          colgroup.append(document.createElement('col'));
          const cell = document.createElement('th');
          cell.style.fontSize = '10px';
          cell.style.paddingLeft = `${minimum - 10}px`;
          const handle = document.createElement('span');
          handle.dataset.tableResizeColumn = String(index);
          cell.append(handle);
          row.append(cell);
        }
        head.append(row);
        table.append(colgroup, head);
        root.append(table);
        runtime.adapter.acquire();
        runtime.notifyResize();
        runtime.drainScheduler();
        const read = () => Array.from(table.querySelectorAll<HTMLTableColElement>('col'))
          .map((column) => Number.parseFloat(column.style.width));
        const handle = table.querySelector<HTMLElement>('[data-table-resize-column="0"]')!;
        const dispatch = (type: string, pointerId: number, clientX: number, buttons: number) => {
          const target = type === 'lostpointercapture' ? root : type === 'pointerdown' ? handle : window;
          target.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, button: type === 'pointerdown' ? 0 : -1,
            buttons, pointerId, pointerType: 'mouse', clientX
          }));
        };

        // Establish the committed WidthIntent through the same public pointer seam.
        dispatch('pointerdown', 401, 100, 1);
        dispatch('pointermove', 401, 130, 1);
        dispatch('pointerup', 401, 130, 0);
        runtime.drainScheduler();
        const committed = read();

        dispatch('pointerdown', 402, 100, 1);
        root.style.width = `${options.nextWidth}px`;
        if (options.nextMinimums) {
          Array.from(table.querySelectorAll<HTMLElement>('thead th')).forEach((cell, index) => {
            cell.style.paddingLeft = `${options.nextMinimums![index] - 10}px`;
          });
        }
        runtime.notifyResize();
        runtime.drainScheduler();
        const afterObserver = read();
        dispatch(options.terminal, 402, 100, 0);
        runtime.drainScheduler();
        const reconciled = read();
        dispatch(options.terminal, 402, 100, 0);
        runtime.drainScheduler();
        runtime.destroy();
        host.remove();
        return {
          id: options.id, committed, afterObserver, reconciled
        };
      };
      const runSecondDragCurrentFacts = (options: {
        id: string;
        currentWidths: readonly number[];
        currentMinimums: readonly number[];
        currentAvailableWidth: number;
        delta: number;
        terminal?: 'pointerup' | 'pointercancel' | 'lostpointercapture';
        duringDrag?: {
          availableWidth: number;
          minimums: readonly number[];
        };
      }) => {
        const host = document.createElement('div');
        document.body.append(host);
        const runtime = window.TableColumnWidthAdapterCandidate!.createControlled(host);
        const root = host.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
        root.style.width = '200px';
        const table = document.createElement('table');
        table.dataset.tableColumnWidth = options.id;
        table.dataset.tableFrom = '0';
        table.dataset.tableTo = '25';
        const colgroup = document.createElement('colgroup');
        const head = document.createElement('thead');
        const row = document.createElement('tr');
        for (let index = 0; index < 2; index += 1) {
          colgroup.append(document.createElement('col'));
          const cell = document.createElement('th');
          cell.style.fontSize = '10px';
          cell.style.paddingLeft = '10px';
          const handle = document.createElement('span');
          handle.dataset.tableResizeColumn = String(index);
          cell.append(handle);
          row.append(cell);
        }
        head.append(row);
        table.append(colgroup, head);
        root.append(table);
        runtime.adapter.acquire();
        runtime.drainScheduler();
        const columns = Array.from(table.querySelectorAll<HTMLTableColElement>('col'));
        const cells = Array.from(table.querySelectorAll<HTMLElement>('th'));
        const handle = cells[0].querySelector<HTMLElement>('[data-table-resize-column="0"]')!;
        const dispatch = (type: string, pointerId: number, clientX: number, buttons: number) => {
          const target = type === 'pointerdown'
            ? handle
            : type === 'lostpointercapture'
              ? root
              : window;
          target.dispatchEvent(new PointerEvent(type, {
            bubbles: true, cancelable: true, button: type === 'pointerdown' ? 0 : -1,
            buttons, pointerId, pointerType: 'mouse', clientX
          }));
        };
        const setCurrentLayout = (widths: readonly number[], minimums: readonly number[]) => {
          table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
          table.style.tableLayout = 'fixed';
          widths.forEach((width, index) => { columns[index].style.width = `${width}px`; });
          minimums.forEach((minimum, index) => { cells[index].style.paddingLeft = `${minimum - 10}px`; });
        };

        setCurrentLayout([100, 100], [20, 20]);
        dispatch('pointerdown', 501, 100, 1);
        dispatch('pointermove', 501, 100, 1);
        dispatch('pointerup', 501, 100, 0);
        runtime.drainScheduler();

        root.style.width = `${options.currentAvailableWidth}px`;
        setCurrentLayout(options.currentWidths, options.currentMinimums);
        dispatch('pointerdown', 502, 100, 1);
        if (options.duringDrag) {
          root.style.width = `${options.duringDrag.availableWidth}px`;
          options.duringDrag.minimums.forEach((minimum, index) => {
            cells[index].style.paddingLeft = `${minimum - 10}px`;
          });
          runtime.notifyResize();
          runtime.drainScheduler();
        }
        dispatch('pointermove', 502, 100 + options.delta, 1);
        const preview = columns.map((column) => Number.parseFloat(column.style.width));
        dispatch(options.terminal ?? 'pointerup', 502, 100 + options.delta, 0);
        const atTerminal = columns.map((column) => Number.parseFloat(column.style.width));
        runtime.drainScheduler();
        const reconciled = columns.map((column) => Number.parseFloat(column.style.width));
        dispatch(options.terminal ?? 'pointerup', 502, 100 + options.delta, 0);
        runtime.drainScheduler();
        const afterLateTerminal = columns.map((column) => Number.parseFloat(column.style.width));
        runtime.destroy();
        host.remove();
        return { id: options.id, preview, atTerminal, reconciled, afterLateTerminal };
      };
      const terminals = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;
      return {
        secondDragCurrentFacts: [
          runSecondDragCurrentFacts({
            id: 'second-shrink-up', currentWidths: [140, 60], currentMinimums: [80, 20],
            currentAvailableWidth: 200, delta: -50
          }),
          runSecondDragCurrentFacts({
            id: 'second-shrink-cancel', currentWidths: [140, 60], currentMinimums: [80, 20],
            currentAvailableWidth: 200, delta: -50, terminal: 'pointercancel'
          }),
          runSecondDragCurrentFacts({
            id: 'second-shrink-lost', currentWidths: [140, 60], currentMinimums: [80, 20],
            currentAvailableWidth: 200, delta: -50, terminal: 'lostpointercapture'
          }),
          runSecondDragCurrentFacts({
            id: 'second-grow', currentWidths: [90, 60], currentMinimums: [80, 20],
            currentAvailableWidth: 200, delta: 50
          }),
          runSecondDragCurrentFacts({
            id: 'second-no-change', currentWidths: [140, 60], currentMinimums: [80, 20],
            currentAvailableWidth: 200, delta: 0
          }),
          runSecondDragCurrentFacts({
            id: 'second-facts-change', currentWidths: [140, 60], currentMinimums: [20, 20],
            currentAvailableWidth: 200, delta: -50,
            duringDrag: { availableWidth: 300, minimums: [80, 20] }
          }),
          runSecondDragCurrentFacts({
            id: 'second-infeasible', currentWidths: [180, 100], currentMinimums: [180, 100],
            currentAvailableWidth: 200, delta: 24
          })
        ],
        pointerup: run({ id: 'pointerup', initialWidth: 300, nextWidth: 500, minimums: [20, 20, 20] }),
        pointercancel: run({
          id: 'pointercancel', initialWidth: 300, nextWidth: 500, minimums: [20, 20, 20], terminal: 'pointercancel'
        }),
        lostpointercapture: run({
          id: 'lostpointercapture', initialWidth: 300, nextWidth: 500,
          minimums: [20, 20, 20], terminal: 'lostpointercapture'
        }),
        shrink: run({ id: 'shrink', initialWidth: 500, nextWidth: 300, minimums: [20, 20, 20] }),
        subPixel: run({ id: 'sub-pixel', initialWidth: 300, nextWidth: 300.4, minimums: [20, 20, 20] }),
        exactPixel: run({ id: 'exact-pixel', initialWidth: 300, nextWidth: 301, minimums: [20, 20, 20] }),
        overPixel: run({ id: 'over-pixel', initialWidth: 300, nextWidth: 302, minimums: [20, 20, 20] }),
        currentMinimums: run({
          id: 'minimums', initialWidth: 300, nextWidth: 300,
          minimums: [20, 20, 20], nextMinimums: [140, 100, 80]
        }),
        infeasibleMinimums: run({
          id: 'infeasible-minimums', initialWidth: 500, nextWidth: 300,
          minimums: [180, 100, 50]
        }),
        noMove: terminals.flatMap((terminal) => [
          runNoMove({ id: `${terminal}-grow`, initialWidth: 300, nextWidth: 500, minimums: [20, 20, 20], terminal }),
          runNoMove({ id: `${terminal}-shrink`, initialWidth: 500, nextWidth: 300, minimums: [20, 20, 20], terminal }),
          runNoMove({
            id: `${terminal}-minimum`, initialWidth: 300, nextWidth: 300,
            minimums: [20, 20, 20], nextMinimums: [140, 100, 80], terminal
          }),
          runNoMove({
            id: `${terminal}-both-grow`, initialWidth: 300, nextWidth: 500,
            minimums: [20, 20, 20], nextMinimums: [140, 100, 80], terminal
          }),
          runNoMove({
            id: `${terminal}-both-shrink`, initialWidth: 500, nextWidth: 300,
            minimums: [20, 20, 20], nextMinimums: [180, 100, 50], terminal
          })
        ]),
        noMoveNoChange: runNoMove({
          id: 'no-change', initialWidth: 300, nextWidth: 300,
          minimums: [20, 20, 20], terminal: 'pointerup'
        }),
        noMoveTolerance: [300.4, 301, 302].map((nextWidth) => runNoMove({
          id: `tolerance-${nextWidth}`, initialWidth: 300, nextWidth,
          minimums: [20, 20, 20], terminal: 'pointerup'
        }))
      };
    });
    for (const result of [
      currentnessMatrix.pointerup,
      currentnessMatrix.pointercancel,
      currentnessMatrix.lostpointercapture
    ]) {
      assert.deepEqual(result.afterWrongTerminal, result.preview, 'a wrong pointer terminal must be effect-free');
      assert.deepEqual(result.afterObserver, result.preview, 'observer work consumed during drag must preserve the preview');
      assert.deepEqual(result.atTerminal, result.preview, 'every terminal must first commit the complete preview snapshot');
      assert.ok(result.reconciled.reduce((sum, width) => sum + width, 0)
        > result.preview.reduce((sum, width) => sum + width, 0) + 100);
      assert.deepEqual(result.afterLateTerminal, result.reconciled, 'late terminal and move events must be effect-free');
      assert.equal(result.releases, 1, 'pointer capture must be released exactly once');
      assert.equal(result.resizing, false, 'active drag presentation must be cleaned exactly once');
    }
    assert.deepEqual(currentnessMatrix.shrink.atTerminal, currentnessMatrix.shrink.preview);
    assert.ok(
      currentnessMatrix.shrink.reconciled.reduce((sum, width) => sum + width, 0)
        < currentnessMatrix.shrink.preview.reduce((sum, width) => sum + width, 0) - 100,
      JSON.stringify(currentnessMatrix.shrink)
    );
    assert.deepEqual(currentnessMatrix.subPixel.reconciled, currentnessMatrix.subPixel.preview);
    for (const result of [currentnessMatrix.exactPixel, currentnessMatrix.overPixel]) {
      assert.ok(result.reconciled.reduce((sum, width) => sum + width, 0)
        > result.preview.reduce((sum, width) => sum + width, 0));
    }
    assert.deepEqual(currentnessMatrix.currentMinimums.atTerminal, currentnessMatrix.currentMinimums.preview);
    assert.ok(currentnessMatrix.currentMinimums.reconciled[0] >= 140);
    assert.ok(currentnessMatrix.currentMinimums.reconciled[1] >= 100);
    assert.ok(currentnessMatrix.currentMinimums.reconciled[2] >= 80);
    assert.ok(currentnessMatrix.infeasibleMinimums.reconciled[0] >= 180);
    assert.ok(currentnessMatrix.infeasibleMinimums.reconciled[1] >= 100);
    assert.ok(currentnessMatrix.infeasibleMinimums.reconciled[2] >= 50);
    for (const result of currentnessMatrix.noMove) {
      assert.deepEqual(result.afterObserver, result.committed, 'active-drag observer work must not project early');
    }
    assert.deepEqual(currentnessMatrix.noMoveNoChange.reconciled, currentnessMatrix.noMoveNoChange.committed);
    assert.deepEqual(
      currentnessMatrix.noMoveTolerance.map((result) => Math.round(
        result.reconciled.reduce((sum, width) => sum + width, 0)
      )),
      [300, 301, 302],
      'no-move terminal currentness must retain the existing <1/=1/>1 tolerance'
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
      events = 0;
      const beforeFailure = Array.from(table.querySelectorAll<HTMLTableColElement>('col'))
        .map((column) => Number.parseFloat(column.style.width));
      runtime.failNextRefresh();
      runtime.dispatchInput(runtime.view.state.doc.length, 'a');
      table.dataset.tableTo = String(runtime.view.state.doc.length);
      root.style.width = '330px';
      await frames(4);
      const afterFailure = {
        widths: Array.from(table.querySelectorAll<HTMLTableColElement>('col'))
          .map((column) => Number.parseFloat(column.style.width)),
        projected: events > 0
      };
      events = 0;
      runtime.dispatchInput(runtime.view.state.doc.length, 'b');
      table.dataset.tableTo = String(runtime.view.state.doc.length);
      await frames(4);
      const afterRecovery = {
        widths: Array.from(table.querySelectorAll<HTMLTableColElement>('col'))
          .map((column) => Number.parseFloat(column.style.width)),
        projected: events > 0,
        current: table.isConnected && root.contains(table)
      };
      runtime.destroy();
      host.remove();
      return { intentEstablished, beforeFailure, afterFailure, afterRecovery };
    });
    assert.equal(failedTableGeneration.intentEstablished, true, 'failure fixture must own a committed width intent');
    assert.deepEqual(failedTableGeneration.afterFailure.widths, failedTableGeneration.beforeFailure);
    assert.equal(failedTableGeneration.afterFailure.projected, false);
    assert.equal(failedTableGeneration.afterRecovery.projected, true);
    assert.equal(failedTableGeneration.afterRecovery.current, true);
    assert.ok(failedTableGeneration.afterRecovery.widths.every(Number.isFinite));

    const replacementSettlement = await page.evaluate(async () => {
      const runtime = (window as any).__widthCandidate;
      const root = document.querySelector<HTMLElement>('.table-column-width-candidate-root')!;
      const oldTable = root.querySelector<HTMLTableElement>('[data-table-column-width="first"]')!;
      const oldWidths = Array.from(oldTable.querySelectorAll<HTMLTableColElement>('col'))
        .map((column) => column.style.width);
      let detachedProjected = false;
      oldTable.addEventListener('meo-table-column-width-projected', () => { detachedProjected = true; });
      const currentProjected = new Promise<void>((resolve) => {
        runtime.dispatchInput(runtime.view.state.doc.length, '!');
        oldTable.remove();
        const replacement = (window as any).__makeWidthTable('first', 0, 3, 3) as HTMLTableElement;
        replacement.addEventListener('meo-table-column-width-projected', () => resolve(), { once: true });
        root.style.width = '360px';
      });
      await currentProjected;
      const replacement = root.querySelector<HTMLTableElement>('[data-table-column-width="first"]')!;
      const currentWidths = Array.from(replacement.querySelectorAll<HTMLTableColElement>('col'))
        .map((column) => Number.parseFloat(column.style.width));
      return {
        oldConnected: oldTable.isConnected,
        oldWidths,
        lateOldWidths: Array.from(oldTable.querySelectorAll<HTMLTableColElement>('col'))
          .map((column) => column.style.width),
        detachedProjected,
        currentConnected: replacement.isConnected,
        currentWidths
      };
    });
    for (const result of currentnessMatrix.secondDragCurrentFacts.slice(0, 3)) {
      assert.deepEqual(result.preview, [90, 60], `${result.id} must use current DOM widths and minimums`);
      assert.deepEqual(result.atTerminal, result.preview, `${result.id} must commit this transaction preview`);
      assert.deepEqual(result.reconciled, result.preview, `${result.id} must not reverse after reconciliation`);
      assert.deepEqual(result.afterLateTerminal, result.reconciled, `${result.id} late terminal must be effect-free`);
    }
    for (const [result, expected] of [
      [currentnessMatrix.secondDragCurrentFacts[3], [140, 60]],
      [currentnessMatrix.secondDragCurrentFacts[4], [140, 60]],
      [currentnessMatrix.secondDragCurrentFacts[5], [90, 60]],
      [currentnessMatrix.secondDragCurrentFacts[6], [204, 100]]
    ] as const) {
      assert.deepEqual(result.preview, expected, `${result.id} must use current feasible/infeasible facts`);
      assert.deepEqual(result.atTerminal, expected);
      assert.deepEqual(result.reconciled, expected);
      assert.deepEqual(result.afterLateTerminal, expected);
    }
    assert.equal(replacementSettlement.oldConnected, false);
    assert.deepEqual(replacementSettlement.lateOldWidths, replacementSettlement.oldWidths);
    assert.equal(replacementSettlement.detachedProjected, false, 'detached binding must remain a bounded no-op');
    assert.equal(replacementSettlement.currentConnected, true);
    assert.ok(replacementSettlement.currentWidths.every(Number.isFinite));

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
    assert.ok(
      cancelled[0] > initialFirst[0] + 35,
      'pointercancel must commit the active preview when no prior committed intent exists'
    );

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
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table column width adapter Chromium candidate trace passed');
