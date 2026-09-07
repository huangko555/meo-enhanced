import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-column-width-production-cutover-'));
const threeColumns = ['| A | B | C |', '| --- | --- | --- |', '| one | two | three |'].join('\n');
const twoColumns = ['| A | B |', '| --- | --- |', '| one | two |'].join('\n');
const focusedCase = process.argv.includes('--case=sticky-width-pointer');
const cleanupContractCase = process.argv.includes('--case=sticky-width-pointer-cleanup');
const leaseContractCase = process.argv.includes('--case=sticky-width-pointer-lease');
const rightEdgeCase = process.argv.includes('--case=right-edge');

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
  try {
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
  } catch (error) {
    const actual = await page.$eval(selector, (table: HTMLTableElement) => ({
      firstWidth: table.querySelector('thead th')?.getBoundingClientRect().width ?? null,
      tableWidth: table.getBoundingClientRect().width,
      inlineWidth: table.style.width,
      from: table.dataset.tableFrom,
      to: table.dataset.tableTo,
      owner: table.dataset.tableColumnWidthOwner
    })).catch(() => null);
    throw new Error(
      `Table width did not become ${predicate} ${value}; actual=${JSON.stringify(actual)}`,
      { cause: error }
    );
  }
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
  await page.evaluate(() => {
    delete (window as any).__tableWidthTestPointerId;
    window.addEventListener('pointerdown', (event) => {
      (window as any).__tableWidthTestPointerId = event.pointerId;
    }, { capture: true, once: true });
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  const pointerId = await page.evaluate(() => (window as any).__tableWidthTestPointerId as number);
  if (!Number.isInteger(pointerId)) throw new Error('Table width drag did not observe pointerdown');
  const started = await page.$eval(selector, (handle: Element) => (
    (handle.closest('.cm-editor') ?? handle).classList.contains('meo-table-column-resizing')
  ));
  if (!started) throw new Error(`Table width drag did not start: ${selector}`);
  await page.mouse.move(point.x + delta, point.y, { steps: 4 });
  if (finish === 'up') {
    await page.mouse.up();
  } else if (finish === 'cancel') {
    await page.evaluate((activePointerId) => window.dispatchEvent(new PointerEvent('pointercancel', {
      pointerId: activePointerId,
      pointerType: 'mouse',
      buttons: 0
    })), pointerId);
    await page.mouse.up();
  } else {
    await page.$eval(selector, (handle: Element, options: { terminal: string; pointerId: number }) => {
      const boundary = handle.closest<HTMLElement>('.cm-editor') ?? handle as HTMLElement;
      if (options.terminal === 'lostpointercapture') {
        if (boundary.hasPointerCapture(options.pointerId)) {
          boundary.releasePointerCapture(options.pointerId);
        } else {
          boundary.dispatchEvent(new PointerEvent('lostpointercapture', {
            pointerId: options.pointerId, pointerType: 'mouse', buttons: 0, bubbles: true
          }));
        }
        return;
      }
      boundary.dispatchEvent(new PointerEvent('pointerleave', {
        pointerId: options.pointerId, pointerType: 'mouse', buttons: 0, bubbles: true
      }));
    }, { terminal: finish, pointerId });
    await page.mouse.up();
  }
  await page.waitForFunction(
    (handleSelector) => document.querySelector(handleSelector) !== null,
    { polling: 'mutation', timeout: 5000 },
    selector
  );
}

async function revealHitTestableHandle(page: any, selector: string): Promise<void> {
  await page.$eval(selector, (handle: Element) => handle.scrollIntoView({ block: 'center' }));
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  await page.$eval(selector, (handle: Element) => handle.scrollIntoView({ block: 'center' }));
  await page.waitForFunction((handleSelector) => {
    const handle = document.querySelector<HTMLElement>(handleSelector);
    const rect = handle?.getBoundingClientRect();
    const table = handle?.closest<HTMLTableElement>('.meo-md-html-table');
    if (!handle || !table || table.dataset.tableColumnWidthOwner !== 'adapter'
      || !rect || rect.width <= 0 || rect.height <= 0) return false;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return hit === handle || Boolean(hit && handle.contains(hit));
  }, { polling: 'raf', timeout: 5000 }, selector);
}

async function dragWithPresentationSamples(
  page: any,
  selector: string,
  delta: number
): Promise<Array<{
  readonly primaryWidths: number[];
  readonly stickyWidths: number[];
  readonly primaryTableWidth: number;
  readonly stickyTableWidth: number;
  readonly cursor: string;
}>> {
  const point = await page.$eval(selector, (handle: Element) => {
    const rect = handle.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  const samples: Array<{
    readonly primaryWidths: number[];
    readonly stickyWidths: number[];
    readonly primaryTableWidth: number;
    readonly stickyTableWidth: number;
    readonly cursor: string;
  }> = [];
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  const tableSelector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table)';
  for (const progress of [0.2, 0.4, 0.6, 0.8, 1]) {
    const pointerY = point.y + 24;
    await page.mouse.move(point.x + delta * progress, pointerY);
    if (progress === 0.4) {
      await page.evaluate((handleSelector) => {
        const handle = document.querySelector<HTMLElement>(handleSelector);
        const table = handle?.closest<HTMLTableElement>('table');
        const container = table?.parentElement as HTMLElement | null;
        if (!container) throw new Error('Missing table container during column-width drag');
        container.style.width = `${Math.max(180, container.clientWidth - 24)}px`;
      }, selector);
    }
    const presentation = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    const cursor = await page.evaluate(({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      return target ? getComputedStyle(target).cursor : '';
    }, { x: point.x + delta * progress, y: pointerY });
    samples.push({ ...presentation, cursor });
  }
  await page.mouse.up();
  await waitForTableLayout(page, tableSelector);
  return samples;
}

async function dragWithCommittedSamples(
  page: any,
  selector: string,
  delta: number
): Promise<{
  readonly preview: Awaited<ReturnType<typeof tablePresentationWidths>>;
  readonly committed: readonly Awaited<ReturnType<typeof tablePresentationWidths>>[];
}> {
  const pointer = await page.$eval(selector, (handle: Element) => {
    const rect = handle.getBoundingClientRect();
    const pointerId = ((window as any).__columnWidthTransactionPointerId ?? 90) + 1;
    (window as any).__columnWidthTransactionPointerId = pointerId;
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, pointerId };
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      pointerId, pointerType: 'mouse', clientX: point.x, clientY: point.y
    }));
    return {
      ...point,
      started: document.querySelector('.cm-editor')?.classList.contains('meo-table-column-resizing') ?? false
    };
  });
  if (!pointer.started) throw new Error(`Synthetic table width drag did not start: ${selector}`);
  await page.evaluate(({ x, y, pointerId, requestedDelta }) => {
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, buttons: 1,
      pointerId, pointerType: 'mouse', clientX: x + requestedDelta, clientY: y
    }));
  }, { ...pointer, requestedDelta: delta });
  const tableSelector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table):first-of-type';
  const preview = await tablePresentationWidths(page, tableSelector);
  await page.evaluate(({ x, y, pointerId, requestedDelta }) => {
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, buttons: 0,
      pointerId, pointerType: 'mouse', clientX: x + requestedDelta, clientY: y
    }));
  }, { ...pointer, requestedDelta: delta });
  const committed = [
    await tablePresentationWidths(page, tableSelector),
    await tablePresentationWidths(page, tableSelector),
    await tablePresentationWidths(page, tableSelector)
  ];
  return { preview, committed };
}

async function dragAcrossWrapperResize(
  page: any,
  selector: string,
  delta: number,
  nextWrapperWidth: number
): Promise<{
  readonly preview: Awaited<ReturnType<typeof tablePresentationWidths>>;
  readonly atPointerUp: Awaited<ReturnType<typeof tablePresentationWidths>>;
  readonly eventSamples: readonly Awaited<ReturnType<typeof tablePresentationWidths>>[];
}> {
  return page.$eval(selector, async (handle: Element, options: { delta: number; wrapperWidth: number }) => {
    const table = document.querySelector<HTMLTableElement>(
      '.meo-md-html-table:not(.meo-md-html-table-sticky-table):first-of-type'
    )!;
    const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
    const presentation = () => {
      const stickyTable = table.closest('.meo-md-html-table-shell')!
        .querySelector<HTMLElement>('.meo-md-html-table-sticky-table')!;
      const stickyWidths = Array.from(stickyTable.querySelectorAll<HTMLTableColElement>('colgroup > col'))
        .map((column) => Number.parseFloat(column.style.width));
      return {
        primaryWidths: Array.from(table.querySelectorAll<HTMLElement>('thead th'))
          .map((cell) => cell.getBoundingClientRect().width),
        stickyWidths,
        primaryTableWidth: table.getBoundingClientRect().width,
        stickyTableWidth: stickyWidths.reduce((sum, width) => sum + width, 0)
      };
    };
    const eventSamples: ReturnType<typeof presentation>[] = [];
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
    const onProjected = () => {
      const sample = presentation();
      eventSamples.push(sample);
      if (Math.abs(sample.primaryTableWidth - options.wrapperWidth) < 2
        && Math.abs(sample.stickyTableWidth - sample.primaryTableWidth) < 2) {
        resolveSettled();
      }
    };
    table.addEventListener('meo-table-column-width-projected', onProjected);
    const rect = handle.getBoundingClientRect();
    const pointerId = ((window as any).__columnWidthTransactionPointerId ?? 190) + 1;
    (window as any).__columnWidthTransactionPointerId = pointerId;
    const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    handle.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, buttons: 1,
      pointerId, pointerType: 'mouse', clientX: point.x, clientY: point.y
    }));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true, cancelable: true, buttons: 1,
      pointerId, pointerType: 'mouse', clientX: point.x + options.delta, clientY: point.y
    }));
    const preview = presentation();
    wrap.style.maxWidth = 'none';
    wrap.style.width = `${options.wrapperWidth}px`;
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, buttons: 0,
      pointerId, pointerType: 'mouse', clientX: point.x + options.delta, clientY: point.y
    }));
    const atPointerUp = presentation();
    await Promise.race([
      settled,
      new Promise<void>((_resolve, reject) => window.setTimeout(() => reject(new Error(
        `dragAcrossWrapperResize timed out: ${JSON.stringify({
          wrapperWidth: options.wrapperWidth,
          actualWrapperWidth: wrap.getBoundingClientRect().width,
          preview,
          atPointerUp,
          current: presentation(),
          eventSamples
        })}`
      )), 3000))
    ]);
    table.removeEventListener('meo-table-column-width-projected', onProjected);
    return { preview, atPointerUp, eventSamples };
  }, { delta, wrapperWidth: nextWrapperWidth });
}

async function noMoveAcrossWrapperResize(
  page: any,
  selector: string,
  nextWrapperWidth: number,
  terminal: 'pointerup' | 'pointercancel' | 'lostpointercapture'
): Promise<{
  readonly before: Awaited<ReturnType<typeof tablePresentationWidths>>;
  readonly afterObserver: Awaited<ReturnType<typeof tablePresentationWidths>>;
  readonly eventSamples: readonly Awaited<ReturnType<typeof tablePresentationWidths>>[];
  readonly settled: Awaited<ReturnType<typeof tablePresentationWidths>>;
}> {
  const observed = await page.$eval(
    selector,
    async (handle: Element, options: { wrapperWidth: number; terminal: string }) => {
      const table = document.querySelector<HTMLTableElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table):first-of-type'
      )!;
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      const presentation = () => {
        const stickyTable = table.closest('.meo-md-html-table-shell')!
          .querySelector<HTMLElement>('.meo-md-html-table-sticky-table')!;
        return {
          primaryWidths: Array.from(table.querySelectorAll<HTMLElement>('thead th'))
            .map((cell) => cell.getBoundingClientRect().width),
          stickyWidths: Array.from(stickyTable.querySelectorAll<HTMLTableColElement>('colgroup > col'))
            .map((column) => Number.parseFloat(column.style.width)),
          primaryTableWidth: table.getBoundingClientRect().width,
          stickyTableWidth: stickyTable.getBoundingClientRect().width
        };
      };
      const before = presentation();
      let resolveObserverConsumed!: () => void;
      const observerConsumed = new Promise<void>((resolve) => { resolveObserverConsumed = resolve; });
      const samples: ReturnType<typeof presentation>[] = [];
      const onProjected = () => {
        samples.push(presentation());
        resolveObserverConsumed();
      };
      table.addEventListener('meo-table-column-width-projected', onProjected);
      const rect = handle.getBoundingClientRect();
      const pointerId = ((window as any).__columnWidthTransactionPointerId ?? 290) + 1;
      (window as any).__columnWidthTransactionPointerId = pointerId;
      const point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      handle.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, buttons: 1,
        pointerId, pointerType: 'mouse', clientX: point.x, clientY: point.y
      }));
      wrap.style.maxWidth = 'none';
      wrap.style.width = `${options.wrapperWidth}px`;
      await observerConsumed;
      const afterObserver = presentation();
      samples.splice(0, samples.length);
      const target = options.terminal === 'lostpointercapture'
        ? handle.closest<HTMLElement>('.cm-editor')!
        : window;
      target.dispatchEvent(new PointerEvent(options.terminal, {
        bubbles: true, cancelable: true, buttons: 0,
        pointerId, pointerType: 'mouse', clientX: point.x, clientY: point.y
      }));
      (window as any).__columnWidthNoMoveTrace = {
        table, onProjected, samples, beforeTotal: before.primaryTableWidth
      };
      return { before, afterObserver };
    },
    { wrapperWidth: nextWrapperWidth, terminal }
  );
  await page.waitForFunction(() => {
    const trace = (window as any).__columnWidthNoMoveTrace;
    return trace.samples.some((sample: { primaryTableWidth: number }) => (
      Math.abs(sample.primaryTableWidth - trace.beforeTotal) >= 1
    ));
  }, { polling: 'mutation', timeout: 5000 });
  const eventSamples = await page.evaluate(() => {
    const trace = (window as any).__columnWidthNoMoveTrace;
    trace.table.removeEventListener('meo-table-column-width-projected', trace.onProjected);
    delete (window as any).__columnWidthNoMoveTrace;
    return trace.samples;
  });
  const settled = eventSamples[eventSamples.length - 1];
  return { ...observed, eventSamples, settled };
}

async function tablePresentationWidths(
  page: any,
  selector: string
): Promise<{
  readonly primaryWidths: number[];
  readonly stickyWidths: number[];
  readonly primaryTableWidth: number;
  readonly stickyTableWidth: number;
}> {
  return page.$eval(selector, (table: HTMLTableElement) => {
    const stickyTable = table.closest('.meo-md-html-table-shell')!
      .querySelector<HTMLElement>('.meo-md-html-table-sticky-table')!;
    return {
      primaryWidths: Array.from(table.querySelectorAll<HTMLElement>('thead th'))
        .map((cell) => cell.getBoundingClientRect().width),
      stickyWidths: Array.from(stickyTable.querySelectorAll<HTMLElement>('thead th'))
        .map((cell) => cell.getBoundingClientRect().width),
      primaryTableWidth: table.getBoundingClientRect().width,
      stickyTableWidth: stickyTable.getBoundingClientRect().width
    };
  });
}

async function runStickyPointerIdentityTransaction<T>(
  page: any,
  tableSelector: string,
  beforeAcquire: () => Promise<void>,
  consume: () => Promise<T>
): Promise<T> {
  let phase: 'idle' | 'published' | 'released' = 'idle';
  let completed = false;
  let result: T | undefined;
  const primaryErrors: unknown[] = [];
  const cleanupErrors: unknown[] = [];
  const appendFlat = (target: unknown[], error: unknown) => {
    if (error instanceof AggregateError) {
      for (const nested of error.errors) appendFlat(target, nested);
    } else {
      target.push(error);
    }
  };
  try {
    await beforeAcquire();
    await page.$eval(tableSelector, (table: HTMLTableElement) => {
      if ('__columnWidthStickyPointerExpectedTable' in window) {
        throw new Error('Sticky pointer identity lease was already published');
      }
      (window as any).__columnWidthStickyPointerExpectedTable = {
        state: 'published',
        table
      };
    });
    phase = 'published';
    result = await consume();
    completed = true;
  } catch (error) {
    appendFlat(primaryErrors, error);
  } finally {
    if (phase === 'published') {
      try {
        await page.evaluate(() => {
          const lease = (window as any).__columnWidthStickyPointerExpectedTable;
          if (!lease || (lease.state !== 'published' && lease.state !== 'consuming')) {
            throw new Error('Sticky pointer identity lease cannot be released from its current state');
          }
          lease.state = 'released';
          delete (window as any).__columnWidthStickyPointerExpectedTable;
          if ('__columnWidthStickyPointerExpectedTable' in window) {
            throw new Error('Sticky pointer identity lease remained published after release');
          }
        });
      } catch (error) {
        appendFlat(cleanupErrors, error);
      }
      phase = 'released';
    }
  }
  if (primaryErrors.length && cleanupErrors.length) {
    throw new AggregateError(
      [...primaryErrors, ...cleanupErrors],
      'Sticky pointer identity transaction and cleanup failed',
      { cause: primaryErrors[0] }
    );
  }
  if (primaryErrors.length === 1) throw primaryErrors[0];
  if (primaryErrors.length > 1) {
    throw new AggregateError(primaryErrors, 'Sticky pointer identity transaction failed', { cause: primaryErrors[0] });
  }
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Sticky pointer identity transaction cleanup failed');
  }
  assert.equal(completed, true, 'Sticky pointer identity transaction completed without a result');
  return result as T;
}

async function settleStickyPointerMove(
  page: any,
  selector: string,
  column: number
): Promise<void> {
  let installed = false;
  let hasPrimary = false;
  let primary: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    const point = await page.evaluate(({ handleSelector, expectedColumn }) => {
      const lease = (window as any).__columnWidthStickyPointerExpectedTable;
      if (lease?.state !== 'published' || lease.moveSettlement) {
        throw new Error('Sticky pointer move settlement requires one published identity lease');
      }
      const matches = Array.from(document.querySelectorAll<HTMLElement>(handleSelector));
      if (matches.length !== 1) {
        throw new Error(`pointer move settlement requires one current match, received ${matches.length}: ${handleSelector}`);
      }
      const handle = matches[0];
      const stickyTable = handle.closest<HTMLTableElement>('.meo-md-html-table-sticky-table');
      const headerCell = handle.closest<HTMLTableCellElement>('th');
      const shell = stickyTable?.closest<HTMLElement>('.meo-md-html-table-shell');
      const mainTable = shell?.querySelector<HTMLTableElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table)'
      );
      const rect = handle.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      if (!handle.isConnected || !stickyTable || !mainTable?.isConnected || mainTable !== lease.table ||
        headerCell?.cellIndex !== expectedColumn || handle.dataset.tableResizeColumn !== String(expectedColumn) ||
        !(rect.width > 0 && rect.height > 0) || document.elementFromPoint(x, y) !== handle) {
        throw new Error(`pointer move settlement found no visible current target: ${handleSelector}`);
      }
      const nativeFrame = window.requestAnimationFrame.bind(window);
      const tracker = (window as any).TableStabilityHarness.installCausalFrameSettlement(window, () => null);
      const onPointerMoveRoot = () => tracker.beginEventRoot();
      window.addEventListener('pointermove', onPointerMoveRoot, { capture: true, once: true });
      lease.moveSettlement = { tracker, nativeFrame, onPointerMoveRoot };
      return { x, y };
    }, { handleSelector: selector, expectedColumn: column });
    installed = true;
    await page.mouse.move(point.x, point.y);
    await page.evaluate(async ({ handleSelector, expectedColumn }) => {
      const lease = (window as any).__columnWidthStickyPointerExpectedTable;
      const settlement = lease?.moveSettlement;
      const matches = Array.from(document.querySelectorAll<HTMLElement>(handleSelector));
      if (lease?.state !== 'published' || !settlement || matches.length !== 1) {
        throw new Error(`pointer move did not settle to one current handle: ${handleSelector}`);
      }
      const handle = matches[0];
      const stickyTable = handle.closest<HTMLTableElement>('.meo-md-html-table-sticky-table');
      const headerCell = handle.closest<HTMLTableCellElement>('th');
      const shell = stickyTable?.closest<HTMLElement>('.meo-md-html-table-shell');
      const mainTable = shell?.querySelector<HTMLTableElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table)'
      );
      const rect = handle.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!handle.isConnected || !stickyTable || !mainTable?.isConnected || mainTable !== lease.table ||
        headerCell?.cellIndex !== expectedColumn || handle.dataset.tableResizeColumn !== String(expectedColumn) ||
        !(rect.width > 0 && rect.height > 0) || !(hit === handle || (hit instanceof Node && handle.contains(hit)))) {
        throw new Error(`pointer move settled on the wrong current target: ${handleSelector}`);
      }
      settlement.tracker.accept();
      await new Promise<void>((resolve, reject) => {
        const inspect = () => {
          const diagnostics = settlement.tracker.diagnostics();
          if (diagnostics.failure) return reject(new Error(diagnostics.failure));
          if (diagnostics.phase === 'complete') return resolve();
          settlement.nativeFrame(inspect);
        };
        settlement.nativeFrame(inspect);
      });
    }, { handleSelector: selector, expectedColumn: column });
  } catch (error) {
    hasPrimary = true;
    primary = error;
  } finally {
    if (installed) {
      try {
        await page.evaluate(() => {
          const lease = (window as any).__columnWidthStickyPointerExpectedTable;
          const settlement = lease?.moveSettlement;
          if (!settlement) throw new Error('Sticky pointer move settlement was not available for cleanup');
          window.removeEventListener('pointermove', settlement.onPointerMoveRoot, { capture: true });
          settlement.tracker.dispose();
          delete lease.moveSettlement;
          if (lease.moveSettlement) throw new Error('Sticky pointer move settlement remained published after cleanup');
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (hasPrimary && cleanupErrors.length) {
    throw new AggregateError(
      [primary, ...cleanupErrors],
      'Sticky pointer move settlement and cleanup failed',
      { cause: primary }
    );
  }
  if (hasPrimary) throw primary;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Sticky pointer move settlement cleanup failed');
  }
}

async function dragPath(
  page: any,
  selector: string,
  deltas: readonly number[],
  column = 0
): Promise<number[]> {
  if (!selector.startsWith('.meo-md-html-table-sticky-table')) {
    const point = await page.$eval(selector, (handle: Element) => {
      const rect = handle.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    const samples: number[] = [];
    await page.mouse.move(point.x, point.y);
    let pointerDown = false;
    let hasPrimary = false;
    let primary: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      await page.evaluate(() => {
        delete (window as any).__tableWidthDragPathPointerDown;
        window.addEventListener('pointerdown', (event) => {
          const target = event.target as HTMLElement | null;
          const closestHandle = target?.closest('.meo-md-html-table-column-resize-handle') ?? null;
          (window as any).__tableWidthDragPathPointerDown = {
            button: event.button,
            buttons: event.buttons,
            pointerId: event.pointerId,
            targetTag: target?.tagName ?? null,
            targetClass: target?.className ?? null,
            closestHandleClass: (closestHandle as HTMLElement | null)?.className ?? null
          };
        }, { capture: true, once: true });
      });
      await page.mouse.down();
      pointerDown = true;
      const started = await page.$eval(selector, (handle: Element, pointerPoint: { x: number; y: number }) => {
        const rect = handle.getBoundingClientRect();
        const hit = document.elementFromPoint(pointerPoint.x, pointerPoint.y);
        return {
          active: (handle.closest('.cm-editor') ?? handle).classList.contains('meo-table-column-resizing'),
          owner: handle.closest<HTMLTableElement>('.meo-md-html-table')?.dataset.tableColumnWidthOwner ?? null,
          pointerDown: (window as any).__tableWidthDragPathPointerDown ?? null,
          point: pointerPoint,
          rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
          hitTag: hit?.tagName ?? null,
          hitClass: (hit as HTMLElement | null)?.className ?? null
        };
      }, point);
      if (!started.active) {
        throw new Error(`Table width drag did not start: ${JSON.stringify(started)}`);
      }
      for (const delta of deltas) {
        await page.mouse.move(point.x + delta, point.y);
        samples.push(await page.$eval(
          `.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th:nth-child(${column + 1})`,
          (cell) => cell.getBoundingClientRect().width
        ));
      }
    } catch (error) {
      hasPrimary = true;
      primary = error;
    } finally {
      if (pointerDown) {
        try { await page.mouse.up(); } catch (error) { cleanupErrors.push(error); }
      }
    }
    if (hasPrimary && cleanupErrors.length) {
      throw new AggregateError([primary, ...cleanupErrors], 'Table width drag and pointer cleanup failed');
    }
    if (hasPrimary) throw primary;
    if (cleanupErrors.length === 1) throw cleanupErrors[0];
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, 'Table width pointer cleanup failed');
    }
    return samples;
  }
  const samples: number[] = [];
  let pointerDown = false;
  let hasPrimary = false;
  let primary: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    await settleStickyPointerMove(page, selector, column);
    const acquisition = await page.evaluate(({ handleSelector, expectedColumn }) => {
      const matches = Array.from(document.querySelectorAll<HTMLElement>(handleSelector));
      if (matches.length !== 1) {
        throw new Error(`resize handle acquisition requires one current match, received ${matches.length}: ${handleSelector}`);
      }
      const handle = matches[0];
      const stickyTable = handle.closest<HTMLTableElement>('.meo-md-html-table-sticky-table');
      const headerCell = handle.closest<HTMLTableCellElement>('th');
      const shell = stickyTable?.closest<HTMLElement>('.meo-md-html-table-shell');
      const mainTable = shell?.querySelector<HTMLTableElement>('.meo-md-html-table:not(.meo-md-html-table-sticky-table)');
      const lease = (window as any).__columnWidthStickyPointerExpectedTable;
      const expectedMainTable = lease?.table;
      const rect = handle.getBoundingClientRect();
      const style = getComputedStyle(handle);
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!handle.isConnected || !stickyTable || !headerCell || !mainTable || !mainTable.isConnected) {
        throw new Error(`resize handle acquisition found a detached or ownerless current handle: ${handleSelector}`);
      }
      if (mainTable !== expectedMainTable) {
        throw new Error(`resize handle acquisition selected the wrong current table: ${handleSelector}`);
      }
      if (lease.state !== 'published') {
        throw new Error(`resize handle acquisition found an invalid identity lease state: ${String(lease.state)}`);
      }
      if (headerCell.cellIndex !== expectedColumn || handle.dataset.tableResizeColumn !== String(expectedColumn)) {
        throw new Error(`resize handle acquisition selected the wrong Sticky column: ${handleSelector}`);
      }
      if (!(rect.width > 0 && rect.height > 0) || !Number.isFinite(x) || !Number.isFinite(y)) {
        throw new Error(`current visible resize handle acquisition returned zero geometry: ${JSON.stringify({
          selector: handleSelector, width: rect.width, height: rect.height, x, y
        })}`);
      }
      if (rect.left < 0 || rect.top < 0 || rect.right > window.innerWidth || rect.bottom > window.innerHeight ||
        style.display === 'none' || style.visibility !== 'visible' || style.pointerEvents === 'none') {
        throw new Error(`resize handle acquisition requires a fully visible pointer target: ${handleSelector}`);
      }
      if (!(hit === handle || (hit instanceof Node && handle.contains(hit)))) {
        throw new Error(`current visible resize handle acquisition returned non-hit point: ${JSON.stringify({
          selector: handleSelector, x, y, hit: hit instanceof Element ? hit.tagName : null
        })}`);
      }
      lease.state = 'consuming';
      lease.handle = handle;
      lease.stickyTable = stickyTable;
      lease.mainTable = mainTable;
      lease.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      return { x, y };
    }, { handleSelector: selector, expectedColumn: column });
    const preDown = await page.evaluate(({ handleSelector, expectedColumn }) => {
      const transaction = (window as any).__columnWidthStickyPointerExpectedTable;
      const current = document.querySelector<HTMLElement>(handleSelector);
      if (transaction?.state !== 'consuming' || !transaction.handle?.isConnected || current !== transaction.handle) {
        return 'replacement-or-detach';
      }
      const handle = transaction.handle as HTMLElement;
      const rect = handle.getBoundingClientRect();
      if (handle.closest('.meo-md-html-table-sticky-table') !== transaction.stickyTable ||
        transaction.stickyTable.closest('.meo-md-html-table-shell')
          ?.querySelector('.meo-md-html-table:not(.meo-md-html-table-sticky-table)') !== transaction.mainTable ||
        handle.closest<HTMLTableCellElement>('th')?.cellIndex !== expectedColumn) return 'wrong-table-or-column';
      if (Math.abs(rect.left - transaction.rect.left) >= 0.5 || Math.abs(rect.top - transaction.rect.top) >= 0.5 ||
        Math.abs(rect.width - transaction.rect.width) >= 0.5 || Math.abs(rect.height - transaction.rect.height) >= 0.5) {
        return 'moved-after-acquisition';
      }
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!(hit === handle || (hit instanceof Node && handle.contains(hit)))) return 'non-hit-before-pointerdown';
      return 'current';
    }, { handleSelector: selector, expectedColumn: column });
    assert.equal(preDown, 'current', `resize handle changed before pointerdown: ${preDown}: ${selector}`);
    await page.mouse.down();
    pointerDown = true;
    for (const delta of deltas) {
      await page.mouse.move(acquisition.x + delta, acquisition.y);
      samples.push(await page.$eval(
        `.meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th:nth-child(${column + 1})`,
        (cell) => cell.getBoundingClientRect().width
      ));
    }
  } catch (error) {
    hasPrimary = true;
    primary = error;
  } finally {
    if (pointerDown) {
      try { await page.mouse.up(); } catch (error) { cleanupErrors.push(error); }
    }
  }
  if (hasPrimary && cleanupErrors.length) {
    throw new AggregateError([primary, ...cleanupErrors], 'Sticky width drag and pointer cleanup failed');
  }
  if (hasPrimary) throw primary;
  if (cleanupErrors.length === 1) throw cleanupErrors[0];
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, 'Sticky width pointer cleanup failed');
  }
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
    if (rightEdgeCase) {
      await page.addStyleTag({ content: ':root{--meo-semantic-tableBorder:#7f8c8d}' });
    }
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'production.js') });

    const markdown = [
      ...Array.from({ length: 24 }, (_, index) => `prefix ${index + 1}`),
      '',
      '| A | B | C |',
      '| --- | --- | --- |',
      '| one | two | three |',
      ...Array.from({ length: 14 }, (_, index) => `| row ${index + 2} | two | three |`),
      '',
      '| X | Y | Z |',
      '| --- | --- | --- |',
      '| left | center | right |',
      '',
      ...Array.from({ length: 24 }, (_, index) => `tail ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__columnWidthProduction = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
    }, markdown);
    const tableSelector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table)';
    const firstHandle = `${tableSelector}:first-of-type th:first-child .meo-md-html-table-column-resize-handle`;
    const firstStickyHandle = '.meo-md-html-table-sticky-table th:first-child .meo-md-html-table-column-resize-handle';
    await waitForTableLayout(page, tableSelector, 1, 3);
    await page.evaluate(() => {
      (window as any).__columnWidthProduction.scrollToLine(26, 'top');
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      scroller.scrollTop += 32;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await waitForTableLayout(page, tableSelector, 2, 3);
    await page.waitForFunction(() => {
      const chrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible');
      const cells = Array.from(chrome?.querySelectorAll<HTMLElement>(
        '.meo-md-html-table-sticky-table thead th'
      ) ?? []);
      return cells.length === 3 && cells.every((cell) => {
        const rect = cell.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    }, { polling: 'mutation', timeout: 5000 });
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
    if (rightEdgeCase) {
      await drag(
        page,
        `${tableSelector}:first-of-type th:first-child .meo-md-html-table-column-resize-handle`,
        1000
      );
    }
    const initialRightEdgeDiagnostics = await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
      const shell = table.closest<HTMLElement>('.meo-md-html-table-shell')!;
      const wrap = table.parentElement!;
      const lastCells = Array.from(table.querySelectorAll<HTMLElement>('tr > :last-child'));
      const tableRect = table.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      return {
        table: { left: tableRect.left, right: tableRect.right, width: tableRect.width },
        shell: { left: shellRect.left, right: shellRect.right, width: shellRect.width,
          clientWidth: shell.clientWidth, scrollWidth: shell.scrollWidth },
        wrap: (() => {
          const rect = wrap.getBoundingClientRect();
          return { left: rect.left, right: rect.right, width: rect.width,
            clientWidth: wrap.clientWidth, scrollWidth: wrap.scrollWidth };
        })(),
        lastCells: lastCells.map((cell) => {
          const rect = cell.getBoundingClientRect();
          const style = getComputedStyle(cell);
          return { left: rect.left, right: rect.right, width: rect.width,
            borderRightWidth: style.borderRightWidth, borderRightStyle: style.borderRightStyle };
        })
      };
    });
    if (rightEdgeCase) {
      assert.ok(
        initialRightEdgeDiagnostics.lastCells.every((cell) => (
          Number.parseFloat(cell.borderRightWidth) >= 1 && cell.borderRightStyle !== 'none'
        )),
        `Live table right edge must be painted by every last-column cell: ${JSON.stringify(initialRightEdgeDiagnostics)}`
      );
      assert.ok(
        initialRightEdgeDiagnostics.table.right <= initialRightEdgeDiagnostics.wrap.right
          && initialRightEdgeDiagnostics.wrap.scrollWidth <= initialRightEdgeDiagnostics.wrap.clientWidth,
        `Live table right edge must remain inside its shell without horizontal overflow: ${JSON.stringify(initialRightEdgeDiagnostics)}`
      );
      const widthSweep = await page.evaluate(async (selector) => {
        const app = document.getElementById('app')!;
        const samples = [];
        for (let step = 0; step <= 120; step += 1) {
          app.style.width = `${430 + step * 2.75}px`;
          await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
          const table = document.querySelector<HTMLTableElement>(selector)!;
          const wrap = table.parentElement!;
          const lastCell = table.querySelector<HTMLElement>('tbody tr:last-child > :last-child')!;
          const tableRect = table.getBoundingClientRect();
          const wrapRect = wrap.getBoundingClientRect();
          const lastRect = lastCell.getBoundingClientRect();
          samples.push({
            appWidth: app.getBoundingClientRect().width,
            wrapWidth: wrapRect.width,
            tableWidth: tableRect.width,
            borderRoom: wrapRect.right - lastRect.right,
            tableRoom: wrapRect.right - tableRect.right,
            clientWidth: wrap.clientWidth,
            scrollWidth: wrap.scrollWidth
          });
        }
        return samples;
      }, `${tableSelector}:first-of-type`);
      assert.ok(
        widthSweep.every((sample) => (
          sample.borderRoom >= 0.49
          && sample.tableRoom >= -0.01
          && sample.scrollWidth <= sample.clientWidth
        )),
        `Live table right border must survive fractional-width projection without overflow: ${JSON.stringify(
          widthSweep.filter((sample) => sample.borderRoom < 0.49
            || sample.tableRoom < -0.01 || sample.scrollWidth > sample.clientWidth)
        )}`
      );
      console.log(`Live table right-edge regression passed: ${JSON.stringify({
        initialRightEdgeDiagnostics,
        minimumBorderRoom: Math.min(...widthSweep.map((sample) => sample.borderRoom))
      })}`);
      return;
    }
    assert.deepEqual(initial.owners, ['adapter', 'adapter']);

    const dragSamples = await dragWithPresentationSamples(page, firstStickyHandle, 70);
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
      assert.ok(
        Math.abs(dragSamples[index].stickyTableWidth - dragSamples[index].primaryTableWidth) < 1,
        `sticky table width diverged during drag sample ${index}: ${JSON.stringify(dragSamples[index])}`
      );
      assert.equal(
        dragSamples[index].cursor,
        'col-resize',
        `column-resize cursor was lost during drag sample ${index}: ${JSON.stringify(dragSamples[index])}`
      );
    }
    const resizedPresentation = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    const resizedState = await page.evaluate((selector) => {
      const tables = Array.from(document.querySelectorAll<HTMLTableElement>(selector));
      const outside = document.getElementById('outside') as HTMLButtonElement;
      return {
        secondWidths: Array.from(tables[1].querySelectorAll<HTMLElement>('thead th'))
          .map((cell) => cell.getBoundingClientRect().width),
        text: (window as any).__columnWidthProduction.getText(),
        focused: document.activeElement === outside,
        scrollTop: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop
      };
    }, tableSelector);
    const resized = { ...resizedPresentation, ...resizedState };
    assert.ok(
      resized.primaryWidths[0] > initial.widths[0][0] + 50,
      JSON.stringify({ initial: initial.widths[0], resized })
    );
    assert.deepEqual(resized.secondWidths.map(Math.round), initial.widths[1].map(Math.round));
    assert.deepEqual(resized.stickyWidths.map(Math.round), resized.primaryWidths.map(Math.round));
    assert.equal(resized.text, markdown);
    assert.equal(resized.focused, initial.focused);
    assert.ok(Math.abs(resized.scrollTop - initial.scrollTop) < 2);

    await page.setViewport({ width: 400, height: 440 });
    try {
      await page.waitForFunction((selector) => {
        const table = document.querySelector<HTMLTableElement>(selector);
        if (!table) return false;
        const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap');
        const primary = Array.from(table.querySelectorAll<HTMLElement>('thead th'))
          .map((cell) => cell.getBoundingClientRect().width);
        const sticky = Array.from(
          table.closest('.meo-md-html-table-shell')!
            .querySelectorAll<HTMLElement>('.meo-md-html-table-sticky-table thead th')
        ).map((cell) => cell.getBoundingClientRect().width);
        return primary.length === 3
          && sticky.length === 3
          && primary.every((width, index) => width > 0 && Math.abs(width - sticky[index]) < 1)
          && Boolean(wrap && table.getBoundingClientRect().width <= wrap.clientWidth + 1);
      }, { polling: 'raf', timeout: 5000 }, `${tableSelector}:first-of-type`);
    } catch (error) {
      const diagnostics = await page.evaluate((selector) => {
        const table = document.querySelector<HTMLTableElement>(selector);
        const wrap = table?.closest<HTMLElement>('.meo-md-html-table-wrap');
        const sticky = table?.closest('.meo-md-html-table-shell')
          ?.querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table');
        return {
          tableWidth: table?.getBoundingClientRect().width,
          wrapWidth: wrap?.clientWidth,
          primary: Array.from(table?.querySelectorAll<HTMLElement>('thead th') ?? [], (cell) => cell.getBoundingClientRect().width),
          sticky: Array.from(sticky?.querySelectorAll<HTMLElement>('thead th') ?? [], (cell) => cell.getBoundingClientRect().width)
        };
      }, `${tableSelector}:first-of-type`);
      throw new Error(`Narrow table projection did not settle: ${JSON.stringify(diagnostics)}`, { cause: error });
    }
    const narrowViewport = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    assert.deepEqual(narrowViewport.stickyWidths.map(Math.round), narrowViewport.primaryWidths.map(Math.round));
    const resizedTotal = resized.primaryWidths.reduce((sum, width) => sum + width, 0);
    const startupTotal = initial.widths[0].reduce((sum, width) => sum + width, 0);
    const restoredFirstWidth = resized.primaryWidths[0] * startupTotal / resizedTotal;
    await page.setViewport({ width: 900, height: 440 });
    try {
      await page.waitForFunction((selector, expected) => {
        const cell = document.querySelector<HTMLElement>(`${selector} thead th:first-child`);
        return Boolean(cell && Math.abs(cell.getBoundingClientRect().width - expected) < 2);
      }, { polling: 'raf', timeout: 5000 }, `${tableSelector}:first-of-type`, restoredFirstWidth);
    } catch (error) {
      const diagnostics = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
      throw new Error(`Wide table projection did not restore: ${JSON.stringify({
        expectedFirstWidth: restoredFirstWidth,
        actual: diagnostics
      })}`, { cause: error });
    }
    const restoredViewport = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    assert.deepEqual(restoredViewport.stickyWidths.map(Math.round), restoredViewport.primaryWidths.map(Math.round));

    await page.setViewport({ width: 400, height: 440 });
    await page.waitForFunction((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector);
      const wrap = table?.closest<HTMLElement>('.meo-md-html-table-wrap');
      const primary = Array.from(table?.querySelectorAll<HTMLElement>('thead th') ?? [])
        .map((cell) => cell.getBoundingClientRect().width);
      const sticky = Array.from(table?.closest('.meo-md-html-table-shell')
        ?.querySelectorAll<HTMLElement>('.meo-md-html-table-sticky-table thead th') ?? [])
        .map((cell) => cell.getBoundingClientRect().width);
      return Boolean(table && wrap && primary.length === 3 && sticky.length === 3
        && table.getBoundingClientRect().width <= wrap.clientWidth + 1
        && primary.every((width, index) => Math.abs(width - sticky[index]) < 1));
    }, { timeout: 5000 }, `${tableSelector}:first-of-type`);
    const narrowedAgain = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    assert.ok(
      narrowedAgain.primaryWidths.every((width, index) => Math.abs(width - narrowViewport.primaryWidths[index]) < 2),
      `narrow-expand-narrow must restore the same constrained projection: ${JSON.stringify({ narrowViewport, narrowedAgain })}`
    );
    assert.deepEqual(narrowedAgain.stickyWidths.map(Math.round), narrowedAgain.primaryWidths.map(Math.round));
    await page.setViewport({ width: 900, height: 440 });
    await page.waitForFunction((selector, expected) => {
      const cell = document.querySelector<HTMLElement>(`${selector} thead th:first-child`);
      return Boolean(cell && Math.abs(cell.getBoundingClientRect().width - expected) < 2);
    }, { timeout: 5000 }, `${tableSelector}:first-of-type`, restoredFirstWidth);

    const cssPixelWidths = await page.$$eval(
      `${tableSelector}:first-of-type colgroup > col`,
      (columns) => columns.map((column) => Number.parseFloat((column as HTMLElement).style.width))
    );
    await page.setViewport({ width: 900, height: 440, deviceScaleFactor: 2 });
    await page.waitForFunction(() => window.devicePixelRatio === 2, { timeout: 5000 });
    await page.waitForFunction((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector);
      const primary = Array.from(table?.querySelectorAll<HTMLTableColElement>('colgroup > col') ?? [])
        .map((column) => Number.parseFloat(column.style.width));
      const sticky = Array.from(table?.closest('.meo-md-html-table-shell')
        ?.querySelectorAll<HTMLTableColElement>('.meo-md-html-table-sticky-table colgroup > col') ?? [])
        .map((column) => Number.parseFloat(column.style.width));
      return primary.length === 3 && sticky.length === 3
        && primary.every((width, index) => Math.abs(width - sticky[index]) < 1);
    }, { timeout: 5000 }, `${tableSelector}:first-of-type`);
    const highDprCssPixelWidths = await page.$$eval(
      `${tableSelector}:first-of-type colgroup > col`,
      (columns) => columns.map((column) => Number.parseFloat((column as HTMLElement).style.width))
    );
    assert.ok(
      highDprCssPixelWidths.every((width, index) => Math.abs(width - cssPixelWidths[index]) < 2),
      `DPR must not convert CSS-pixel width intent into physical pixels: ${JSON.stringify({ cssPixelWidths, highDprCssPixelWidths })}`
    );
    const cssZoomSession = await page.createCDPSession();
    await cssZoomSession.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1.25 });
    const zoomedMiddleBefore = (await widths(page, tableSelector))[1];
    await drag(page, `${tableSelector}:first-of-type th:nth-child(2) .meo-md-html-table-column-resize-handle`, 24);
    const zoomedMiddleAfter = (await widths(page, tableSelector))[1];
    assert.ok(
      Math.abs(zoomedMiddleAfter - zoomedMiddleBefore - 24) < 2,
      `zoomed pointer delta must remain a CSS-pixel delta: ${JSON.stringify({ zoomedMiddleBefore, zoomedMiddleAfter })}`
    );
    await cssZoomSession.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    await cssZoomSession.detach();
    await page.setViewport({ width: 900, height: 440, deviceScaleFactor: 1 });

    await page.evaluate(() => {
      const style = document.createElement('style');
      style.id = 'column-width-readable-minimums';
      style.textContent = [
        '#app .meo-md-html-table:not(.meo-md-html-table-sticky-table)',
        '.meo-md-html-table-cell-preview {',
        'font-size: 36px !important;',
        'padding-left: 52px !important;',
        'padding-right: 36px !important;',
        '}'
      ].join(' ');
      document.head.append(style);
    });
    await page.setViewport({ width: 360, height: 440 });
    await page.waitForFunction((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector);
      const cells = Array.from(table?.querySelectorAll<HTMLElement>('thead th') ?? []);
      if (!table || cells.length !== 3) return false;
      const numeric = (value: string) => Number.parseFloat(value) || 0;
      return cells.every((cell) => {
        const cellStyle = getComputedStyle(cell);
        const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
        const previewStyle = preview ? getComputedStyle(preview) : cellStyle;
        const minimumWidth = numeric(previewStyle.fontSize)
          + numeric(previewStyle.paddingLeft)
          + numeric(previewStyle.paddingRight)
          + numeric(cellStyle.borderLeftWidth)
          + numeric(cellStyle.borderRightWidth);
        return cell.getBoundingClientRect().width >= minimumWidth - 1;
      });
    }, { timeout: 5000 }, `${tableSelector}:first-of-type`);
    const readableMinimumProjection = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    assert.deepEqual(
      readableMinimumProjection.stickyWidths.map(Math.round),
      readableMinimumProjection.primaryWidths.map(Math.round),
      'current main-table minimums must produce one shared primary/Sticky projection'
    );
    const currentMinimums = await page.$eval(
      `${tableSelector}:first-of-type`,
      (table: HTMLTableElement) => Array.from(table.querySelectorAll<HTMLElement>('thead th')).map((cell) => {
        const cellStyle = getComputedStyle(cell);
        const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
        const previewStyle = preview ? getComputedStyle(preview) : cellStyle;
        const numeric = (value: string) => Number.parseFloat(value) || 0;
        return numeric(previewStyle.fontSize)
          + numeric(previewStyle.paddingLeft)
          + numeric(previewStyle.paddingRight)
          + numeric(cellStyle.borderLeftWidth)
          + numeric(cellStyle.borderRightWidth);
      })
    );
    await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
      table.scrollIntoView({ block: 'start' });
      const scroller = table.closest('.cm-scroller') as HTMLElement;
      const headerHeight = table.tHead?.getBoundingClientRect().height ?? 0;
      scroller.scrollTop += Math.max(24, headerHeight + 8);
      scroller.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction((selector) => {
      const handle = document.querySelector<HTMLElement>(selector);
      const rect = handle?.getBoundingClientRect();
      return Boolean(handle?.closest('.meo-md-html-table-sticky-chrome.is-visible')
        && rect && rect.width > 0 && rect.height > 0);
    }, { timeout: 5000 }, firstStickyHandle);
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const stickyHandleHitTest = await page.$eval(firstStickyHandle, (handle: HTMLElement) => {
      const rect = handle.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        handleClass: handle.className,
        hitClass: (hit as HTMLElement | null)?.className ?? null,
        hitIsHandle: hit === handle || Boolean(hit?.closest('.meo-md-html-table-column-resize-handle')),
        rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      };
    });
    assert.ok(stickyHandleHitTest.hitIsHandle, `visible Sticky resize handle is not hit-testable: ${JSON.stringify(stickyHandleHitTest)}`);
    const secondDragSamples = await dragWithPresentationSamples(page, firstStickyHandle, 40);
    for (let index = 0; index < secondDragSamples.length; index += 1) {
      const sample = secondDragSamples[index];
      assert.ok(
        sample.primaryWidths.every((width, column) => width >= currentMinimums[column] - 1),
        `second drag must honor current readable minimums: ${JSON.stringify({ currentMinimums, sample })}`
      );
      assert.deepEqual(sample.stickyWidths.map(Math.round), sample.primaryWidths.map(Math.round));
      if (index > 0) {
        assert.ok(
          sample.primaryWidths[0] > secondDragSamples[index - 1].primaryWidths[0] + 3,
          `second drag Main/Sticky trajectory reversed: ${JSON.stringify(secondDragSamples)}`
        );
      }
    }
    const secondDragCommitted = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    assert.ok(
      secondDragCommitted.primaryWidths[0] >= secondDragSamples.at(-1)!.primaryWidths[0] - 1,
      'second drag terminal reconciliation must not reverse the last visible preview'
    );
    assert.deepEqual(
      secondDragCommitted.stickyWidths.map(Math.round),
      secondDragCommitted.primaryWidths.map(Math.round)
    );
    const horizontalScrollBefore = await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      const firstHandle = table.querySelector<HTMLElement>('th:first-child .meo-md-html-table-column-resize-handle')!;
      const input = table.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      wrap.scrollLeft = 0;
      wrap.dispatchEvent(new Event('scroll'));
      input.focus();
      input.setSelectionRange(1, 1);
      const wrapRect = wrap.getBoundingClientRect();
      const firstRect = firstHandle.getBoundingClientRect();
      return {
        overflowX: getComputedStyle(wrap).overflowX,
        clientWidth: wrap.clientWidth,
        scrollWidth: wrap.scrollWidth,
        firstAccessible: firstRect.left >= wrapRect.left - 1 && firstRect.right <= wrapRect.right + 1,
        colWidths: Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup > col'))
          .map((column) => Number.parseFloat(column.style.width)),
        rowHeight: table.querySelector<HTMLElement>('tbody tr')!.getBoundingClientRect().height
      };
    });
    assert.equal(horizontalScrollBefore.overflowX, 'auto', 'infeasible readable minimums require on-demand Live overflow');
    assert.ok(horizontalScrollBefore.scrollWidth > horizontalScrollBefore.clientWidth + 1);
    assert.equal(horizontalScrollBefore.firstAccessible, true, 'the first-column content and handle must be reachable at scrollLeft=0');
    await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth;
      wrap.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector);
      const wrap = table?.closest<HTMLElement>('.meo-md-html-table-wrap');
      const handle = table?.querySelector<HTMLElement>('th:last-child .meo-md-html-table-column-resize-handle');
      if (!table || !wrap || !handle || wrap.scrollLeft <= 0) return false;
      const wrapRect = wrap.getBoundingClientRect();
      const handleRect = handle.getBoundingClientRect();
      const sticky = table.closest('.meo-md-html-table-shell')
        ?.querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table');
      const mainCells = Array.from(table.querySelectorAll<HTMLElement>('thead th'));
      const stickyCells = Array.from(sticky?.querySelectorAll<HTMLElement>('thead th') ?? []);
      return handleRect.left >= wrapRect.left - 1 && handleRect.right <= wrapRect.right + 1
        && stickyCells.length === mainCells.length
        && mainCells.every((cell, index) => (
          Math.abs(cell.getBoundingClientRect().left - stickyCells[index].getBoundingClientRect().left) < 1
          && Math.abs(cell.getBoundingClientRect().right - stickyCells[index].getBoundingClientRect().right) < 1
        ));
    }, { timeout: 5000 }, `${tableSelector}:first-of-type`);
    const horizontalScrollAfter = await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      const sticky = table.closest('.meo-md-html-table-shell')!
        .querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table')!;
      const input = table.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      const mainCells = Array.from(table.querySelectorAll<HTMLElement>('thead th'));
      const stickyCells = Array.from(sticky.querySelectorAll<HTMLElement>('thead th'));
      return {
        scrollLeft: wrap.scrollLeft,
        colWidths: Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup > col'))
          .map((column) => Number.parseFloat(column.style.width)),
        rowHeight: table.querySelector<HTMLElement>('tbody tr')!.getBoundingClientRect().height,
        focused: document.activeElement === input,
        selectionStart: input.selectionStart,
        aligned: mainCells.every((cell, index) => (
          Math.abs(cell.getBoundingClientRect().left - stickyCells[index].getBoundingClientRect().left) < 1
          && Math.abs(cell.getBoundingClientRect().right - stickyCells[index].getBoundingClientRect().right) < 1
        ))
      };
    });
    assert.ok(horizontalScrollAfter.scrollLeft > 0);
    assert.deepEqual(horizontalScrollAfter.colWidths, horizontalScrollBefore.colWidths);
    assert.ok(Math.abs(horizontalScrollAfter.rowHeight - horizontalScrollBefore.rowHeight) < 1);
    assert.equal(horizontalScrollAfter.focused, true);
    assert.equal(horizontalScrollAfter.selectionStart, 1);
    assert.equal(horizontalScrollAfter.aligned, true, 'horizontal scroll must keep main and Sticky column boundaries aligned');

    const transactionStateBefore = await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      const input = table.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      wrap.scrollLeft = 0;
      wrap.dispatchEvent(new Event('scroll'));
      return {
        rowHeight: table.querySelector<HTMLElement>('tbody tr')!.getBoundingClientRect().height,
        focused: document.activeElement === input,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd
      };
    });
    const firstGrow = await dragWithCommittedSamples(page, firstHandle, 24);
    for (const [index, sample] of firstGrow.committed.entries()) {
      assert.deepEqual(
        sample.primaryWidths.map(Math.round),
        firstGrow.preview.primaryWidths.map(Math.round),
        `infeasible first-column finish sample ${index} reversed the last valid preview`
      );
      assert.deepEqual(sample.stickyWidths.map(Math.round), sample.primaryWidths.map(Math.round));
    }
    await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth;
      wrap.dispatchEvent(new Event('scroll'));
    });
    const lastHandle = '.meo-md-html-table-sticky-table th:last-child .meo-md-html-table-column-resize-handle';
    const lastGrow = await dragWithCommittedSamples(page, lastHandle, 24);
    for (const [index, sample] of lastGrow.committed.entries()) {
      assert.deepEqual(
        sample.primaryWidths.map(Math.round),
        lastGrow.preview.primaryWidths.map(Math.round),
        `infeasible last-column finish sample ${index} reversed the last valid preview`
      );
      assert.deepEqual(sample.stickyWidths.map(Math.round), sample.primaryWidths.map(Math.round));
    }
    await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth;
      wrap.dispatchEvent(new Event('scroll'));
    });
    const lastShrink = await dragWithCommittedSamples(page, lastHandle, -12);
    const lastShrinkFacts = await page.$eval(
      `${tableSelector}:first-of-type`,
      (table: HTMLTableElement) => {
        const numeric = (value: string) => Number.parseFloat(value) || 0;
        return {
          availableWidth: table.parentElement?.clientWidth,
          tableWidth: table.getBoundingClientRect().width,
          minimums: Array.from(table.querySelectorAll<HTMLElement>('thead th')).map((cell) => {
            const cellStyle = getComputedStyle(cell);
            const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
            const previewStyle = preview ? getComputedStyle(preview) : cellStyle;
            return numeric(previewStyle.fontSize)
              + numeric(previewStyle.paddingLeft)
              + numeric(previewStyle.paddingRight)
              + numeric(cellStyle.borderLeftWidth)
              + numeric(cellStyle.borderRightWidth);
          })
        };
      }
    );
    assert.ok(
      lastShrink.preview.primaryWidths.reduce((sum, width) => sum + width, 0)
        < lastGrow.preview.primaryWidths.reduce((sum, width) => sum + width, 0) - 10
        && lastShrink.preview.primaryWidths.every((width, index) => width >= currentMinimums[index] - 1),
      JSON.stringify({
        lastGrow: lastGrow.preview.primaryWidths,
        lastShrink: lastShrink.preview.primaryWidths,
        lastShrinkFacts
      })
    );
    assert.deepEqual(
      lastShrink.committed.at(-1)!.primaryWidths.map(Math.round),
      lastShrink.preview.primaryWidths.map(Math.round)
    );
    const startupDefaultTotal = initial.widths[0].reduce((sum, width) => sum + width, 0);
    const elasticRestoreTotal = Math.max(
      startupDefaultTotal,
      currentMinimums.reduce((sum, width) => sum + width, 0)
    );
    let expandedAfterShrink = await page.$eval(
      `${tableSelector}:first-of-type`,
      async (table: HTMLTableElement, expectedTotal: number) => {
        const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
        const projected = new Promise<void>((resolve) => {
          table.addEventListener('meo-table-column-width-projected', () => resolve(), { once: true });
        });
        wrap.style.maxWidth = 'none';
        wrap.style.width = `${Math.max(500, Math.ceil(expectedTotal + 20))}px`;
        await projected;
        const sticky = table.closest('.meo-md-html-table-shell')!
          .querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table')!;
        return {
          primary: Array.from(table.querySelectorAll<HTMLElement>('thead th'))
            .map((cell) => cell.getBoundingClientRect().width),
          sticky: Array.from(sticky.querySelectorAll<HTMLElement>('thead th'))
            .map((cell) => cell.getBoundingClientRect().width)
        };
      },
      elasticRestoreTotal
    );
    await page.waitForFunction((selector, expectedTotal) => {
      const table = document.querySelector<HTMLTableElement>(selector);
      const sticky = table?.closest('.meo-md-html-table-shell')
        ?.querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table');
      const primaryWidths = Array.from(table?.querySelectorAll<HTMLElement>('thead th') ?? [])
        .map((cell) => cell.getBoundingClientRect().width);
      const stickyWidths = Array.from(sticky?.querySelectorAll<HTMLElement>('thead th') ?? [])
        .map((cell) => cell.getBoundingClientRect().width);
      return primaryWidths.length === 3
        && Math.abs(primaryWidths.reduce((sum, width) => sum + width, 0) - expectedTotal) < 2
        && stickyWidths.length === primaryWidths.length
        && primaryWidths.every((width, index) => Math.abs(width - stickyWidths[index]) < 1);
    }, { polling: 'raf', timeout: 5000 }, `${tableSelector}:first-of-type`, elasticRestoreTotal);
    const settledExpandedAfterShrink = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    expandedAfterShrink = {
      primary: settledExpandedAfterShrink.primaryWidths,
      sticky: settledExpandedAfterShrink.stickyWidths
    };
    assert.ok(
      Math.abs(expandedAfterShrink.primary.reduce((sum, width) => sum + width, 0) - elasticRestoreTotal) < 2
        && expandedAfterShrink.primary.every((width, index) => width >= currentMinimums[index] - 1),
      `an elastic table must stop at its startup default width: ${JSON.stringify({
        lastShrink: lastShrink.preview.primaryWidths,
        expandedAfterShrink: expandedAfterShrink.primary,
        currentMinimums,
        startupDefaultTotal,
        elasticRestoreTotal
      })}`
    );
    assert.deepEqual(expandedAfterShrink.sticky.map(Math.round), expandedAfterShrink.primary.map(Math.round));
    await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
      table.closest<HTMLElement>('.meo-md-html-table-wrap')!.style.width = '600px';
    });
    await page.evaluate(async () => {
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const restoredAfterShrink = await widths(page, `${tableSelector}:first-of-type`);
    assert.ok(
      restoredAfterShrink.every((width, index) => Math.abs(width - expandedAfterShrink.primary[index]) < 2),
      `container tracking must stop after restoring the startup default width: ${JSON.stringify({
        startupDefault: expandedAfterShrink.primary,
        restoredAfterShrink
      })}`
    );
    let transactionStateAfter: {
      rowHeight: number;
      focused: boolean;
      selectionStart: number;
      selectionEnd: number;
      lastReachable: boolean;
    } | null = null;
    const settleAndAssertStickyPointerHost = async (): Promise<void> => {
    let settlementFailure: unknown = null;
    try {
      transactionStateAfter = await page.$eval(
        `${tableSelector}:first-of-type`,
        async (table: HTMLTableElement, contract: { cleanup: boolean; unreachable: boolean }) => {
      const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
      const input = table.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      const lastHandle = table.querySelector<HTMLElement>('th:last-child .meo-md-html-table-column-resize-handle')!;
      const nativeFrame = window.requestAnimationFrame.bind(window);
      const installedTracker = (window as any).TableStabilityHarness.installCausalFrameSettlement(window, () => null);
      const evidence = contract.cleanup ? {
        rootCalls: 0,
        acceptedCalls: 0,
        rootRemovals: 0,
        acceptedRemovals: 0,
        disposeCalls: 0,
        cleanupErrors: [] as unknown[],
        completionErrors: [] as unknown[],
        originalRemove: table.removeEventListener
      } : null;
      if (evidence) {
        (window as any).__columnWidthCleanupEvidence = evidence;
      }
      const tracker = evidence ? {
        beginEventRoot: () => installedTracker.beginEventRoot(),
        accept: () => installedTracker.accept(),
        runRoot: () => { throw new Error('synthetic settlement root failure'); },
        diagnostics: () => installedTracker.diagnostics(),
        dispose: () => {
          evidence.disposeCalls += 1;
          installedTracker.dispose();
          throw new Error('synthetic tracker dispose failure');
        }
      } : installedTracker;
      const onProjectedRoot = () => {
        if (evidence) evidence.rootCalls += 1;
        tracker.beginEventRoot();
      };
      const onProjectedAccepted = () => {
        if (evidence) evidence.acceptedCalls += 1;
        wrap.scrollLeft = wrap.scrollWidth - wrap.clientWidth;
        wrap.dispatchEvent(new Event('scroll'));
        tracker.accept();
        resolveProjected();
      };
      if (evidence) {
        table.removeEventListener = function (type, listener, options) {
          evidence.originalRemove.call(this, type, listener, options);
          if (listener === onProjectedRoot) {
            evidence.rootRemovals += 1;
            throw new Error('synthetic root listener cleanup failure');
          }
          if (listener === onProjectedAccepted) {
            evidence.acceptedRemovals += 1;
            throw new Error('synthetic accepted listener cleanup failure');
          }
        };
      }
      let resolveProjected!: () => void;
      let hasPrimary = false;
      let primary: unknown;
      const cleanupErrors: unknown[] = [];
      let result: {
        rowHeight: number;
        focused: boolean;
        selectionStart: number;
        selectionEnd: number;
        lastReachable: boolean;
      } | null = null;
      try {
        const projected = new Promise<void>((resolve) => {
          resolveProjected = resolve;
          table.addEventListener('meo-table-column-width-projected', onProjectedRoot, {
            capture: true,
            once: true
          });
          table.addEventListener('meo-table-column-width-projected', onProjectedAccepted, { once: true });
        });
        tracker.runRoot(() => {
          wrap.style.width = '';
          wrap.style.maxWidth = '';
        });
        await projected;
        await new Promise<void>((resolve, reject) => {
          const inspect = () => {
            const diagnostics = tracker.diagnostics();
            if (diagnostics.failure) return reject(new Error(diagnostics.failure));
            if (diagnostics.phase === 'complete') return resolve();
            nativeFrame(inspect);
          };
          nativeFrame(inspect);
        });
        const wrapRect = wrap.getBoundingClientRect();
        const handleRect = lastHandle.getBoundingClientRect();
        result = {
          rowHeight: table.querySelector<HTMLElement>('tbody tr')!.getBoundingClientRect().height,
          focused: document.activeElement === input,
          selectionStart: input.selectionStart,
          selectionEnd: input.selectionEnd,
          lastReachable: !contract.unreachable &&
            handleRect.left >= wrapRect.left - 1 && handleRect.right <= wrapRect.right + 1
        };
      } catch (error) {
        hasPrimary = true;
        primary = error;
      } finally {
        try {
          table.removeEventListener('meo-table-column-width-projected', onProjectedRoot, { capture: true });
        } catch (error) { cleanupErrors.push(error); }
        try {
          table.removeEventListener('meo-table-column-width-projected', onProjectedAccepted);
        } catch (error) { cleanupErrors.push(error); }
        try { tracker.dispose(); } catch (error) { cleanupErrors.push(error); }
      }
      if (evidence) {
        evidence.cleanupErrors.push(...cleanupErrors);
        evidence.completionErrors.push(...(hasPrimary ? [primary, ...cleanupErrors] : cleanupErrors));
      }
      if (hasPrimary && cleanupErrors.length) {
        throw new AggregateError([primary, ...cleanupErrors], 'Sticky pointer settlement and cleanup failed');
      }
      if (hasPrimary) throw primary;
      if (cleanupErrors.length === 1) throw cleanupErrors[0];
      if (cleanupErrors.length > 1) {
        throw new AggregateError(cleanupErrors, 'Sticky pointer settlement cleanup failed');
      }
      return result!;
        },
        { cleanup: cleanupContractCase, unreachable: leaseContractCase }
      );
    } catch (error) {
      settlementFailure = error;
    }
    if (cleanupContractCase) {
      const cleanupEvidence = await page.evaluate(() => {
        const evidence = (window as any).__columnWidthCleanupEvidence;
        const table = document.querySelector<HTMLTableElement>(
          '.meo-md-html-table:not(.meo-md-html-table-sticky-table):first-of-type'
        )!;
        table.removeEventListener = evidence.originalRemove;
        const before = { root: evidence.rootCalls, accepted: evidence.acceptedCalls };
        try { table.dispatchEvent(new CustomEvent('meo-table-column-width-projected')); } catch {}
        const result = {
          before,
          after: { root: evidence.rootCalls, accepted: evidence.acceptedCalls },
          rootRemovals: evidence.rootRemovals,
          acceptedRemovals: evidence.acceptedRemovals,
          disposeCalls: evidence.disposeCalls,
          expectedTableSlotPresent: '__columnWidthStickyPointerExpectedTable' in window,
          cleanupErrorMessages: evidence.cleanupErrors.map((error: Error) => error.message),
          completionErrorMessages: evidence.completionErrors.map((error: Error) => error.message)
        };
        delete (window as any).__columnWidthCleanupEvidence;
        return result;
      });
      assert.match(String(settlementFailure), /Sticky pointer settlement and cleanup failed/);
      assert.deepEqual(cleanupEvidence.before, cleanupEvidence.after, 'both projected listeners must be removed after settlement failure');
      assert.equal(cleanupEvidence.rootRemovals, 1, 'root listener cleanup must run exactly once');
      assert.equal(cleanupEvidence.acceptedRemovals, 1, 'accepted listener cleanup must run exactly once');
      assert.equal(cleanupEvidence.disposeCalls, 1, 'tracker disposal must run exactly once');
      assert.equal(cleanupEvidence.expectedTableSlotPresent, false, 'settlement failure must not acquire an identity lease');
      assert.deepEqual(cleanupEvidence.cleanupErrorMessages, [
        'synthetic root listener cleanup failure',
        'synthetic accepted listener cleanup failure',
        'synthetic tracker dispose failure'
      ]);
      assert.deepEqual(cleanupEvidence.completionErrorMessages, [
        'synthetic settlement root failure',
        'synthetic root listener cleanup failure',
        'synthetic accepted listener cleanup failure',
        'synthetic tracker dispose failure'
      ]);
      return;
    }
    if (settlementFailure) throw settlementFailure;
    assert.ok(transactionStateAfter);
    assert.ok(Math.abs(transactionStateAfter.rowHeight - transactionStateBefore.rowHeight) < 1);
    assert.equal(transactionStateAfter.focused, transactionStateBefore.focused);
    assert.equal(transactionStateAfter.selectionStart, transactionStateBefore.selectionStart);
    assert.equal(transactionStateAfter.selectionEnd, transactionStateBefore.selectionEnd);
    await page.waitForFunction((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector);
      const sticky = table?.closest('.meo-md-html-table-shell')
        ?.querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table');
      const primary = Array.from(table?.querySelectorAll<HTMLElement>('thead th') ?? []);
      const projected = Array.from(sticky?.querySelectorAll<HTMLElement>('thead th') ?? []);
      return primary.length === 3 && projected.length === 3 && primary.every((cell, index) => (
        Math.abs(cell.getBoundingClientRect().left - projected[index].getBoundingClientRect().left) < 1
        && Math.abs(cell.getBoundingClientRect().right - projected[index].getBoundingClientRect().right) < 1
      ));
    }, { timeout: 5000 }, `${tableSelector}:first-of-type`);
    };
    if (cleanupContractCase) {
      await settleAndAssertStickyPointerHost();
      return;
    }
    let identityTransactionFailure: unknown = null;
    try {
      await runStickyPointerIdentityTransaction(
        page,
        `${tableSelector}:first-of-type`,
        settleAndAssertStickyPointerHost,
        async () => {
          assert.equal(transactionStateAfter.lastReachable, true, 'last Sticky handle must remain reachable');
          const scrolledStickySamples = await dragPath(
            page,
            '.meo-md-html-table-sticky-table th:nth-child(2) .meo-md-html-table-column-resize-handle',
            [8, 16, 24],
            1
          );
          assert.ok(
            scrolledStickySamples.every((width, index) => index === 0 || width > scrolledStickySamples[index - 1] + 5),
            `a visible handle at non-zero scrollLeft must resize continuously: ${JSON.stringify(scrolledStickySamples)}`
          );
          const scrolledDragProjection = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
          assert.deepEqual(
            scrolledDragProjection.stickyWidths.map(Math.round),
            scrolledDragProjection.primaryWidths.map(Math.round)
          );
        }
      );
    } catch (error) {
      identityTransactionFailure = error;
    }
    if (leaseContractCase) {
      assert.match(String(identityTransactionFailure), /last Sticky handle must remain reachable/);
      assert.equal(
        await page.evaluate(() => '__columnWidthStickyPointerExpectedTable' in window),
        false,
        'failed host assertion must release its Sticky pointer identity lease'
      );
      return;
    }
    if (identityTransactionFailure) throw identityTransactionFailure;
    if (focusedCase) {
      await page.evaluate(() => (window as any).__columnWidthProduction.destroy());
      return;
    }
    await page.evaluate(() => {
      const editor = (window as any).__columnWidthProduction;
      editor.setMode('source');
      editor.setMode('live');
    });
    try {
      await page.waitForFunction((selector) => {
        const table = document.querySelector<HTMLTableElement>(selector);
        const cells = Array.from(table?.querySelectorAll<HTMLElement>('thead th') ?? []);
        if (!table || cells.length !== 3) return false;
        const numeric = (value: string) => Number.parseFloat(value) || 0;
        return cells.every((cell) => {
          const cellStyle = getComputedStyle(cell);
          const preview = cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview');
          const previewStyle = preview ? getComputedStyle(preview) : cellStyle;
          return cell.getBoundingClientRect().width >= numeric(previewStyle.fontSize)
            + numeric(previewStyle.paddingLeft)
            + numeric(previewStyle.paddingRight)
            + numeric(cellStyle.borderLeftWidth)
            + numeric(cellStyle.borderRightWidth) - 1;
        });
      }, { timeout: 5000 }, `${tableSelector}:first-of-type`);
    } catch (error) {
      const facts = await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
        const numeric = (value: string) => Number.parseFloat(value) || 0;
        return Array.from(table.querySelectorAll<HTMLElement>('thead th')).map((cell) => {
          const cellStyle = getComputedStyle(cell);
          const previewStyle = getComputedStyle(cell.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!);
          return {
            width: cell.getBoundingClientRect().width,
            minimum: numeric(previewStyle.fontSize) + numeric(previewStyle.paddingLeft)
              + numeric(previewStyle.paddingRight) + numeric(cellStyle.borderLeftWidth)
              + numeric(cellStyle.borderRightWidth)
          };
        });
      });
      throw new Error(
        `Replacement minimum projection did not settle: ${JSON.stringify(facts)}`,
        { cause: error }
      );
    }
    const replacementMinimumProjection = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    assert.deepEqual(
      replacementMinimumProjection.stickyWidths.map(Math.round),
      replacementMinimumProjection.primaryWidths.map(Math.round),
      'replacement main table and rebuilt Sticky must measure and share the current minimums'
    );
    await page.evaluate(() => document.getElementById('column-width-readable-minimums')?.remove());
    await page.setViewport({ width: 900, height: 440 });
    await page.evaluate(async () => {
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await page.waitForFunction((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector);
      const wrap = table?.closest<HTMLElement>('.meo-md-html-table-wrap');
      const sticky = table?.closest('.meo-md-html-table-shell')
        ?.querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table');
      const mainCells = Array.from(table?.querySelectorAll<HTMLElement>('thead th') ?? []);
      const stickyCells = Array.from(sticky?.querySelectorAll<HTMLElement>('thead th') ?? []);
      const mainColumns = Array.from(table?.querySelectorAll<HTMLTableColElement>('colgroup > col') ?? [])
        .map((column) => Number.parseFloat(column.style.width));
      const stickyColumns = Array.from(sticky?.querySelectorAll<HTMLTableColElement>('colgroup > col') ?? [])
        .map((column) => Number.parseFloat(column.style.width));
      return Boolean(table && wrap && mainCells.length === 3 && stickyCells.length === 3
        && wrap.scrollWidth <= wrap.clientWidth + 1
        && mainColumns.length === 3 && stickyColumns.length === 3
        && mainColumns.every((width, index) => (
          Number.isFinite(width)
          && Math.abs(width - stickyColumns[index]) < 1
          && Math.abs(width - mainCells[index].getBoundingClientRect().width) < 1
        ))
        && mainCells.every((cell, index) => (
          Math.abs(cell.getBoundingClientRect().left - stickyCells[index].getBoundingClientRect().left) < 1
          && Math.abs(cell.getBoundingClientRect().right - stickyCells[index].getBoundingClientRect().right) < 1
        )));
    }, { timeout: 5000 }, `${tableSelector}:first-of-type`);
    const afterAccessibleRoundTrip = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    assert.deepEqual(
      afterAccessibleRoundTrip.stickyWidths.map(Math.round),
      afterAccessibleRoundTrip.primaryWidths.map(Math.round)
    );
    const accessibleRoundTripFirstWidth = await page.$eval(
      `${tableSelector}:first-of-type thead th:first-child`,
      (cell) => cell.getBoundingClientRect().width
    );

    await page.evaluate(() => {
      const editor = (window as any).__columnWidthProduction;
      editor.setText(editor.getText());
      editor.setText(`prefix\n\n${editor.getText()}`);
    });
    await waitForTableWidth(page, tableSelector, 'near', accessibleRoundTripFirstWidth);
    const afterPrefix = await page.$eval(`${tableSelector} thead th:first-child`, (cell) => (
      cell.getBoundingClientRect().width
    ));
    assert.ok(Math.abs(afterPrefix - accessibleRoundTripFirstWidth) < 2);

    await page.evaluate(() => (window as any).__columnWidthProduction.setMode('source'));
    await page.waitForFunction(() => (
      document.querySelectorAll('.meo-md-html-table, .meo-md-html-table-column-resize-handle').length === 0
    ), { polling: 'mutation', timeout: 5000 });
    await page.evaluate(() => (window as any).__columnWidthProduction.setMode('live'));
    await waitForTableWidth(page, tableSelector, 'near', accessibleRoundTripFirstWidth);
    const afterModeRoundTrip = await page.$eval(`${tableSelector} thead th:first-child`, (cell) => (
      cell.getBoundingClientRect().width
    ));
    assert.ok(Math.abs(afterModeRoundTrip - accessibleRoundTripFirstWidth) < 2);

    await page.evaluate((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector)!;
      const input = table.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      input.focus();
      input.setSelectionRange(1, 1);
    }, tableSelector);
    await page.$eval(`${tableSelector}:first-of-type`, (table: HTMLTableElement) => {
      table.scrollIntoView({ block: 'start' });
      const scroller = table.closest('.cm-scroller') as HTMLElement;
      const headerHeight = table.tHead?.getBoundingClientRect().height ?? 0;
      scroller.scrollTop += Math.max(24, headerHeight + 8);
      scroller.dispatchEvent(new Event('scroll'));
    });
    await page.waitForFunction((selector) => {
      const handle = document.querySelector<HTMLElement>(selector);
      const rect = handle?.getBoundingClientRect();
      if (!handle?.closest('.meo-md-html-table-sticky-chrome.is-visible')
        || !rect || rect.width <= 0 || rect.height <= 0) return false;
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit === handle || Boolean(hit?.closest('.meo-md-html-table-column-resize-handle'));
    }, { polling: 'raf', timeout: 5000 }, firstStickyHandle);
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const beforePointerCancel = await page.evaluate((selector) => {
      const table = document.querySelector<HTMLTableElement>(selector)!;
      const input = table.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      return {
        width: table.querySelector<HTMLElement>('thead th:first-child')!.getBoundingClientRect().width,
        focused: document.activeElement === input,
        selectionStart: input.selectionStart,
        scrollTop: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop
      };
    }, tableSelector);
    await drag(page, firstStickyHandle, 35, 'cancel');
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
    assert.ok(
      afterPointerCancel.width > beforePointerCancel.width + 25,
      'pointercancel must commit the last preview shown to the user'
    );
    assert.equal(afterPointerCancel.focused, beforePointerCancel.focused);
    assert.equal(afterPointerCancel.selectionStart, beforePointerCancel.selectionStart);
    assert.ok(
      Math.abs(afterPointerCancel.scrollTop - beforePointerCancel.scrollTop) < 2,
      `pointercancel moved the editor viewport: ${JSON.stringify({ beforePointerCancel, afterPointerCancel })}`
    );
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
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.evaluate(async () => {
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await revealHitTestableHandle(page, firstHandle);

    const backAndForth = await dragPath(page, firstHandle, [48, 12, 36]);
    assert.ok(
      backAndForth[0] > afterPointerCancelRebuild + 35,
      JSON.stringify({ afterPointerCancelRebuild, backAndForth })
    );
    assert.ok(backAndForth[1] < backAndForth[0] - 25, JSON.stringify({ backAndForth }));
    assert.ok(backAndForth[2] > backAndForth[1] + 15, JSON.stringify({ backAndForth }));

    await drag(page, firstHandle, -1000);
    const minimumWidth = (await widths(page, tableSelector))[0];
    await drag(page, firstHandle, -1000);
    const repeatedMinimumWidth = (await widths(page, tableSelector))[0];
    assert.ok(minimumWidth > 0, `minimum column width collapsed: ${minimumWidth}`);
    assert.ok(
      Math.abs(repeatedMinimumWidth - minimumWidth) < 2,
      `minimum column width was not stable: ${JSON.stringify({ minimumWidth, repeatedMinimumWidth })}`
    );

    const beforeLostPointerCapture = await widths(page, tableSelector);
    await drag(page, firstHandle, 28, 'lostpointercapture');
    const afterLostPointerCapture = await widths(page, tableSelector);
    assert.ok(
      afterLostPointerCapture[0] > beforeLostPointerCapture[0] + 20,
      `lostpointercapture must commit the last preview shown to the user: ${JSON.stringify({
        beforeLostPointerCapture,
        afterLostPointerCapture
      })}`
    );
    await page.evaluate(() => {
      const editor = (window as any).__columnWidthProduction;
      editor.setMode('source');
      editor.setMode('live');
    });
    await waitForTableWidth(page, tableSelector, 'near', afterLostPointerCapture[0]);
    await revealHitTestableHandle(page, firstHandle);

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
    assert.ok(
      Math.abs(afterThreeToTwo[0] - afterThreeToTwo[1]) < 2
        && Math.abs(afterThreeToTwo[0] - resizedThree[0]) > 1,
      JSON.stringify({ resizedThree, afterThreeToTwo, afterThreeToTwoToThree })
    );
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
    assert.deepEqual(afterTwoToThree, resizedThree);
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
    assert.deepEqual(
      afterEdit,
      beforeEdit,
      'content shorter than the preferred column width must not resize the table'
    );
    assert.deepEqual(afterUndo, beforeEdit);
    assert.deepEqual(afterRedo, beforeEdit);

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
    assert.ok(terminalEvents.includes('lostpointercapture'));
    assert.equal(terminalEvents.includes('pointercancel'), false);
    assert.ok(terminalEvents.includes('pointerup'));
    assert.ok(afterWindowBlur[0] > afterRedo[0] + 20);

    const richTable = [
      '| Kind | Rich content | Tail |',
      '| --- | --- | --- |',
      `| mixed | **bold** ${'wrapping words '.repeat(18)} | final |`,
      '| breaks | first<br>second<br>third | ![fixture](fixture.png) |',
      ...Array.from({ length: 18 }, (_, index) => `| row ${index + 1} | ${'more wrapping content '.repeat(8)} | end ${index + 1} |`)
    ].join('\n');
    await page.evaluate((markdown) => {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" fill="red"/></svg>';
      (window as any).TableStabilityHarness.setImageSrcResolver(
        () => `data:image/svg+xml,${encodeURIComponent(svg)}`
      );
      (window as any).__columnWidthProduction.setText(markdown);
    }, richTable);
    await waitForTableLayout(page, tableSelector, 1, 3);
    await page.waitForSelector(`${tableSelector} tbody .meo-md-image-img`);
    const richRowHeightBefore = await page.$eval(
      `${tableSelector} tbody tr:first-child`,
      (row) => row.getBoundingClientRect().height
    );
    const richWidthsBefore = await widths(page, tableSelector);
    await drag(
      page,
      `${tableSelector} th:nth-child(2) .meo-md-html-table-column-resize-handle`,
      -70
    );
    await page.waitForFunction((selector, previousHeight) => {
      const row = document.querySelector<HTMLElement>(`${selector} tbody tr:first-child`);
      return Boolean(row && row.getBoundingClientRect().height > previousHeight + 1);
    }, { timeout: 5000 }, tableSelector, richRowHeightBefore);
    const richWidthsAfterMiddle = await widths(page, tableSelector);
    assert.ok(richWidthsAfterMiddle[1] < richWidthsBefore[1] - 60);
    assert.equal(await page.evaluate(() => (window as any).__columnWidthProduction.getText()), richTable);

    await page.evaluate(() => {
      (window as any).__columnWidthProduction.scrollToLine(3, 'top');
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      scroller.scrollTop += 32;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await page.waitForSelector('.meo-md-html-table-sticky-chrome.is-visible');
    await drag(
      page,
      '.meo-md-html-table-sticky-table th:last-child .meo-md-html-table-column-resize-handle',
      -30
    );
    const richLastProjection = await tablePresentationWidths(page, tableSelector);
    assert.ok(richLastProjection.primaryWidths[2] < richWidthsAfterMiddle[2] - 20);
    assert.deepEqual(
      richLastProjection.stickyWidths.map(Math.round),
      richLastProjection.primaryWidths.map(Math.round),
      'rich-content last-column resize must use the same main/Sticky projection'
    );

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

    const currentnessMarkdown = [
      ...Array.from({ length: 24 }, (_, index) => `currentness prefix ${index + 1}`),
      '',
      threeColumns,
      ...Array.from({ length: 12 }, (_, index) => (
        `| currentness column one ${index + 2} repeated repeated | `
        + `currentness column two ${index + 2} repeated repeated | `
        + `currentness column three ${index + 2} repeated repeated |`
      )),
      '',
      'currentness tail'
    ].join('\n');
    await page.evaluate((text) => {
      const app = document.getElementById('app')!;
      app.replaceChildren();
      (window as any).__columnWidthCurrentness = (window as any).TableStabilityHarness.createEditor({
        parent: app, text, initialMode: 'live', onApplyChanges() {}
      });
    }, currentnessMarkdown);
    await waitForTableLayout(page, tableSelector, 1, 3);
    const currentnessStartupWidth = await page.$eval(
      `${tableSelector}:first-of-type`,
      (table: HTMLTableElement) => table.getBoundingClientRect().width
    );
    assert.ok(
      currentnessStartupWidth >= 700,
      `currentness fixture must leave room below its startup-width ceiling: ${currentnessStartupWidth}`
    );
    const currentnessHandle = `${tableSelector}:first-of-type th:first-child .meo-md-html-table-column-resize-handle`;
    const setCurrentnessWrapperWidth = async (width: number) => {
      await page.$eval(`${tableSelector}:first-of-type`, async (table: HTMLTableElement, nextWidth: number) => {
        const wrap = table.closest<HTMLElement>('.meo-md-html-table-wrap')!;
        const projected = new Promise<void>((resolve) => {
          table.addEventListener('meo-table-column-width-projected', () => resolve(), { once: true });
        });
        wrap.style.maxWidth = 'none';
        wrap.style.width = `${nextWidth}px`;
        await projected;
      }, width);
    };
    await setCurrentnessWrapperWidth(300);
    const growCurrentness = await dragAcrossWrapperResize(page, currentnessHandle, 30, 500);
    const shrinkCurrentness = await dragAcrossWrapperResize(page, currentnessHandle, 30, 300);
    for (const [direction, trace] of [
      ['grow', growCurrentness],
      ['shrink', shrinkCurrentness]
    ] as const) {
      assert.deepEqual(
        trace.atPointerUp.primaryWidths.map(Math.round),
        trace.preview.primaryWidths.map(Math.round),
        `${direction} pointerup must preserve the last complete preview before causal resize projection`
      );
      assert.ok(
        trace.atPointerUp.stickyWidths.every((width, index) => (
          Math.abs(width - trace.atPointerUp.primaryWidths[index]) < 1
        )),
        `${direction} Sticky projection diverged at pointerup: ${JSON.stringify(trace.atPointerUp)}`
      );
      for (const sample of trace.eventSamples) {
        assert.ok(
          sample.stickyWidths.every((width, index) => Math.abs(width - sample.primaryWidths[index]) < 1),
          `${direction} Sticky projection diverged during a projection event: ${JSON.stringify(sample)}`
        );
      }
      const previewTotal = Math.round(trace.preview.primaryTableWidth);
      const eventTotals = trace.eventSamples.map((sample) => Math.round(sample.primaryTableWidth));
      const changedTotals = eventTotals.filter((total) => total !== previewTotal);
      assert.equal(
        changedTotals.length,
        1,
        `${direction} public projection events must expose one changed geometry value: ${JSON.stringify(trace)}`
      );
      assert.equal(new Set(changedTotals).size, changedTotals.length, 'the same changed value must not be written twice');
      for (let index = 1; index < eventTotals.length; index += 1) {
        assert.ok(
          direction === 'grow'
            ? eventTotals[index] >= eventTotals[index - 1]
            : eventTotals[index] <= eventTotals[index - 1],
          `${direction} public event trace reversed: ${JSON.stringify(eventTotals)}`
        );
      }
      assert.ok(direction === 'grow' ? changedTotals[0] > previewTotal : changedTotals[0] < previewTotal);
    }
    for (const [terminal, width] of [
      ['pointerup', 500],
      ['pointercancel', 300],
      ['lostpointercapture', 500]
    ] as const) {
      const trace = await noMoveAcrossWrapperResize(page, currentnessHandle, width, terminal);
      assert.deepEqual(
        trace.afterObserver.primaryWidths.map(Math.round),
        trace.before.primaryWidths.map(Math.round),
        `${terminal} no-move observer consumption must preserve committed geometry until terminal`
      );
      assert.deepEqual(trace.settled.stickyWidths.map(Math.round), trace.settled.primaryWidths.map(Math.round));
      const changedTotals = trace.eventSamples
        .map((sample) => Math.round(sample.primaryTableWidth))
        .filter((total) => total !== Math.round(trace.before.primaryTableWidth));
      assert.equal(
        changedTotals.length,
        1,
        `${terminal} no-move terminal must expose exactly one causal changed projection: ${JSON.stringify(trace)}`
      );
      assert.equal(new Set(changedTotals).size, 1, `${terminal} must not repeat the changed geometry value`);
    }
    await page.evaluate((text) => {
      (window as any).__columnWidthCurrentness.destroy();
      const app = document.getElementById('app')!;
      app.replaceChildren();
      (window as any).__columnWidthCurrentness = (window as any).TableStabilityHarness.createEditor({
        parent: app, text, initialMode: 'live', onApplyChanges() {}
      });
    }, currentnessMarkdown);
    await waitForTableLayout(page, tableSelector, 1, 3);
    assert.ok(
      await page.$eval(
        `${tableSelector}:first-of-type`,
        (table: HTMLTableElement) => table.getBoundingClientRect().width
      ) >= 700,
      'elastic re-entry fixture must keep the same table startup-width ceiling'
    );
    await setCurrentnessWrapperWidth(550);
    await page.$eval(currentnessHandle, (handle: Element) => handle.scrollIntoView({ block: 'center' }));
    await page.evaluate(async () => {
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await drag(page, currentnessHandle, -80);
    await drag(page, currentnessHandle, -80);
    const fixedBeforeReentry = await tablePresentationWidths(page, `${tableSelector}:first-of-type`);
    assert.ok(
      fixedBeforeReentry.primaryTableWidth < 549,
      `fixture must exit elastic mode before re-entry: ${JSON.stringify(fixedBeforeReentry)}`
    );
    const reenteredGrow = await dragWithCommittedSamples(page, currentnessHandle, 600);
    assert.ok(reenteredGrow.preview.primaryTableWidth >= 549, 'explicit grow must reach the 550px container');
    for (const sample of reenteredGrow.committed) {
      assert.deepEqual(sample.primaryWidths.map(Math.round), reenteredGrow.preview.primaryWidths.map(Math.round));
    }
    await setCurrentnessWrapperWidth(700);
    const expandedAfterReentry = await page.$eval(
      `${tableSelector}:first-of-type`,
      (table: HTMLTableElement) => {
        const sticky = table.closest('.meo-md-html-table-shell')!
          .querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table')!;
        const primaryWidths = Array.from(table.querySelectorAll<HTMLElement>('thead th'))
          .map((cell) => cell.getBoundingClientRect().width);
        const stickyWidths = Array.from(sticky.querySelectorAll<HTMLTableColElement>('colgroup > col'))
          .map((column) => Number.parseFloat(column.style.width));
        return {
          primaryWidths,
          stickyWidths,
          primaryTableWidth: table.getBoundingClientRect().width
        };
      }
    );
    assert.ok(
      expandedAfterReentry.primaryWidths.every((width, index) => (
        width >= reenteredGrow.preview.primaryWidths[index] - 1
      )),
      `main columns must grow monotonically after active elastic re-entry: ${JSON.stringify({
        preview: reenteredGrow.preview,
        expanded: expandedAfterReentry
      })}`
    );
    assert.ok(
      expandedAfterReentry.primaryTableWidth >= reenteredGrow.preview.primaryTableWidth + 149,
      `container growth after active re-entry must expand the real table: ${JSON.stringify({
        preview: reenteredGrow.preview,
        expanded: expandedAfterReentry
      })}`
    );
    assert.deepEqual(
      expandedAfterReentry.stickyWidths.map(Math.round),
      expandedAfterReentry.primaryWidths.map(Math.round),
      'Sticky must follow the same monotonic width trajectory as the main table'
    );
    await page.evaluate(() => (window as any).__columnWidthCurrentness.destroy());
    assert.equal(await page.$$('[data-table-column-width-owner="adapter"]').then((items) => items.length), 0);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (cleanupContractCase) {
  const settlementPrimaryFailure = new Error('synthetic pointer settlement primary failure');
  const settlementCleanupFailure = new Error('synthetic pointer settlement cleanup failure');
  let settlementMoves = 0;
  let settlementCleanups = 0;
  let settlementEvaluations = 0;
  const settlementPage = {
    async evaluate() {
      settlementEvaluations += 1;
      if (settlementEvaluations === 1) return { x: 20, y: 30 };
      settlementCleanups += 1;
      throw settlementCleanupFailure;
    },
    mouse: {
      async move() {
        settlementMoves += 1;
        throw settlementPrimaryFailure;
      }
    }
  };
  let settlementObserved: unknown = null;
  try {
    await settleStickyPointerMove(settlementPage, '.sticky-table-handle', 1);
  } catch (error) {
    settlementObserved = error;
  }
  assert.ok(settlementObserved instanceof AggregateError,
    'pointer settlement cleanup must not replace the primary error');
  assert.deepEqual(settlementObserved.errors, [settlementPrimaryFailure, settlementCleanupFailure]);
  assert.equal(settlementObserved.cause, settlementPrimaryFailure);
  assert.equal(settlementMoves, 1, 'pointer settlement primary action must run once');
  assert.equal(settlementCleanups, 1, 'pointer settlement cleanup must run once');

  const moveFailure = new Error('synthetic pointer move failure');
  const releaseFailure = new Error('synthetic pointer release failure');
  let moves = 0;
  const fakePage = {
    $eval: async () => ({ x: 20, y: 30 }),
    mouse: {
      async move() {
        moves += 1;
        if (moves === 2) throw moveFailure;
      },
      async down() {},
      async up() { throw releaseFailure; }
    }
  };
  let observed: unknown = null;
  try {
    await dragPath(fakePage, '.main-table-handle', [8]);
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof AggregateError, 'safe pointer release must not replace the drag primary error');
  assert.deepEqual(observed.errors, [moveFailure, releaseFailure]);
  await main();
  console.log('table column width pointer cleanup contracts passed');
} else {
  await main();
  if (leaseContractCase) {
    const createLeasePage = (releaseFailure?: unknown) => {
      const state = { phase: 'idle', published: 0, released: 0, slotPresent: false };
      return {
        state,
        page: {
          async $eval() {
            state.published += 1;
            state.phase = 'published';
            state.slotPresent = true;
          },
          async evaluate() {
            state.released += 1;
            state.phase = 'released';
            state.slotPresent = false;
            if (releaseFailure !== undefined) throw releaseFailure;
          }
        }
      };
    };
    const observedFrom = async (run: () => Promise<unknown>) => {
      try { await run(); } catch (error) { return error; }
      return null;
    };

    const entryFailure = new Error('synthetic drag entry failure');
    const entryCase = createLeasePage();
    assert.equal(await observedFrom(() => runStickyPointerIdentityTransaction(
      entryCase.page, '.table', async () => {}, () => { throw entryFailure; }
    )), entryFailure);
    assert.deepEqual(entryCase.state, { phase: 'released', published: 1, released: 1, slotPresent: false });

    const dragFailure = new Error('synthetic drag primary failure');
    const deleteFailure = new Error('synthetic identity lease delete failure');
    const dragCleanupCase = createLeasePage(deleteFailure);
    const dragCleanupError = await observedFrom(() => runStickyPointerIdentityTransaction(
      dragCleanupCase.page, '.table', async () => {}, () => { throw dragFailure; }
    ));
    assert.ok(dragCleanupError instanceof AggregateError);
    assert.deepEqual(dragCleanupError.errors, [dragFailure, deleteFailure]);
    assert.equal(dragCleanupError.cause, dragFailure);
    assert.deepEqual(dragCleanupCase.state, { phase: 'released', published: 1, released: 1, slotPresent: false });

    const hostFailure = new Error('synthetic host primary failure');
    const trackerFailure = new Error('synthetic tracker cleanup failure');
    const listenerFailure = new Error('synthetic listener cleanup failure');
    const globalFailure = new Error('synthetic global cleanup failure');
    const hostCleanupCase = createLeasePage(globalFailure);
    const hostCleanupError = await observedFrom(() => runStickyPointerIdentityTransaction(
      hostCleanupCase.page,
      '.table',
      async () => {},
      () => { throw new AggregateError([hostFailure, trackerFailure, listenerFailure], 'synthetic host failure'); }
    ));
    assert.ok(hostCleanupError instanceof AggregateError);
    assert.deepEqual(hostCleanupError.errors, [hostFailure, trackerFailure, listenerFailure, globalFailure]);
    assert.equal(hostCleanupError.cause, hostFailure);
    assert.deepEqual(hostCleanupCase.state, { phase: 'released', published: 1, released: 1, slotPresent: false });

    const successCase = createLeasePage();
    assert.equal(await runStickyPointerIdentityTransaction(
      successCase.page, '.table', async () => {}, async () => 'success'
    ), 'success');
    assert.deepEqual(successCase.state, { phase: 'released', published: 1, released: 1, slotPresent: false });

    const settlementFailure = new Error('synthetic pre-publication settlement failure');
    const settlementCase = createLeasePage();
    assert.equal(await observedFrom(() => runStickyPointerIdentityTransaction(
      settlementCase.page, '.table', async () => { throw settlementFailure; }, async () => 'unreachable'
    )), settlementFailure);
    assert.deepEqual(settlementCase.state, { phase: 'idle', published: 0, released: 0, slotPresent: false });
  }
  console.log(leaseContractCase
    ? 'table column width pointer identity lease contracts passed'
    : 'table column width production cutover Chromium trace passed');
}
