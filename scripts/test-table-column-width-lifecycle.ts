import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

type LifecycleSnapshot = {
  mutationConstructs: number;
  mutationObserves: number;
  mutationDisconnects: number;
  resizeConstructs: number;
  resizeObserves: number;
  resizeDisconnects: number;
  queries: number;
  frameRequests: number;
  frameCancels: number;
  projections: number;
};

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-column-width-lifecycle-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-column-width-lifecycle-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'lifecycle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent([
      '<!doctype html><style>.root{width:400px}table{width:300px}th{width:150px}</style>',
      '<div id="first" class="root" data-lifecycle-root="first"></div>',
      '<div id="second" class="root" data-lifecycle-root="second"></div>'
    ].join(''));
    await page.evaluate(() => {
      type ObserverKind = 'mutation' | 'resize';
      type ObserverRecord = {
        kind: ObserverKind;
        callback: (...args: any[]) => void;
        rootId: string | null;
        disconnected: boolean;
      };
      const records: ObserverRecord[] = [];
      const frames = new Map<number, FrameRequestCallback>();
      let nextFrame = 1;
      const metrics = {
        mutationConstructs: 0,
        mutationObserves: 0,
        mutationDisconnects: 0,
        resizeConstructs: 0,
        resizeObserves: 0,
        resizeDisconnects: 0,
        queries: 0,
        frameRequests: 0,
        frameCancels: 0,
        projections: 0
      };
      const rootIdFor = (target: Node): string | null => {
        const element = target instanceof Element ? target : target.parentElement;
        return element?.closest<HTMLElement>('[data-lifecycle-root]')?.dataset.lifecycleRoot ?? null;
      };
      const register = (kind: ObserverKind, callback: (...args: any[]) => void): ObserverRecord => {
        const record = { kind, callback, rootId: null, disconnected: false };
        records.push(record);
        if (kind === 'mutation') metrics.mutationConstructs += 1;
        else metrics.resizeConstructs += 1;
        return record;
      };

      class ControlledMutationObserver implements MutationObserver {
        private readonly record: ObserverRecord;
        constructor(callback: MutationCallback) {
          this.record = register('mutation', callback);
        }
        observe(target: Node): void {
          this.record.rootId = rootIdFor(target);
          metrics.mutationObserves += 1;
        }
        disconnect(): void {
          if (this.record.disconnected) return;
          this.record.disconnected = true;
          metrics.mutationDisconnects += 1;
        }
        takeRecords(): MutationRecord[] { return []; }
      }

      class ControlledResizeObserver implements ResizeObserver {
        private readonly record: ObserverRecord;
        constructor(callback: ResizeObserverCallback) {
          this.record = register('resize', callback);
        }
        observe(target: Element): void {
          this.record.rootId = rootIdFor(target);
          metrics.resizeObserves += 1;
        }
        disconnect(): void {
          if (this.record.disconnected) return;
          this.record.disconnected = true;
          metrics.resizeDisconnects += 1;
        }
        unobserve(): void {}
      }

      const nativeQuerySelectorAll = Element.prototype.querySelectorAll;
      Element.prototype.querySelectorAll = function querySelectorAll<E extends Element = Element>(
        selectors: string
      ): NodeListOf<E> {
        if (selectors === 'table[data-table-column-width]' && this.hasAttribute('data-lifecycle-root')) {
          metrics.queries += 1;
        }
        return nativeQuerySelectorAll.call(this, selectors) as NodeListOf<E>;
      };
      const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function dispatchEvent(event: Event): boolean {
        if (event.type === 'meo-table-column-width-projected') metrics.projections += 1;
        return nativeDispatchEvent.call(this, event);
      };
      window.MutationObserver = ControlledMutationObserver;
      window.ResizeObserver = ControlledResizeObserver;
      window.requestAnimationFrame = (callback) => {
        const id = nextFrame++;
        frames.set(id, callback);
        metrics.frameRequests += 1;
        return id;
      };
      window.cancelAnimationFrame = (id) => {
        metrics.frameCancels += 1;
        // Keep the callback available so the test can simulate a callback already dequeued by Chromium.
      };

      const makeTable = (rootId: string): HTMLTableElement => {
        const root = document.querySelector<HTMLElement>(`[data-lifecycle-root="${rootId}"]`)!;
        const table = document.createElement('table');
        table.dataset.tableColumnWidth = rootId;
        table.dataset.tableFrom = '0';
        table.dataset.tableTo = '5';
        const colgroup = document.createElement('colgroup');
        const head = document.createElement('thead');
        const row = document.createElement('tr');
        for (let index = 0; index < 2; index += 1) {
          colgroup.append(document.createElement('col'));
          const cell = document.createElement('th');
          cell.textContent = String(index);
          row.append(cell);
        }
        head.append(row);
        table.append(colgroup, head);
        root.append(table);
        return table;
      };

      (window as any).__lifecycle = {
        metrics,
        records,
        frames,
        makeTable,
        snapshot: (): LifecycleSnapshot => structuredClone(metrics),
        callbacks(kind: ObserverKind, rootId: string) {
          return records.filter((record) => record.kind === kind && record.rootId === rootId)
            .map((record) => record.callback);
        },
        runFrame(id: number) {
          frames.get(id)?.(performance.now());
        },
        lastFrameId() {
          return nextFrame - 1;
        }
      };
    });
    await page.addScriptTag({ path: path.join(tempDir, 'lifecycle.js') });

    const source = await page.evaluate(() => {
      const lifecycle = (window as any).__lifecycle;
      lifecycle.makeTable('first');
      const adapter = window.TableColumnWidthLifecycleHarness!.create(
        document.querySelector<HTMLElement>('[data-lifecycle-root="first"]')!
      );
      (window as any).__firstWidthLifecycle = adapter;
      document.querySelector('[data-lifecycle-root="first"]')!.append(document.createElement('span'));
      return lifecycle.snapshot();
    });
    assert.deepEqual(source, {
      mutationConstructs: 0,
      mutationObserves: 0,
      mutationDisconnects: 0,
      resizeConstructs: 0,
      resizeObserves: 0,
      resizeDisconnects: 0,
      queries: 0,
      frameRequests: 0,
      frameCancels: 0,
      projections: 0
    }, 'Source lifecycle must allocate and observe nothing');

    const firstAcquire = await page.evaluate(() => {
      const adapter = (window as any).__firstWidthLifecycle;
      adapter.acquire();
      const afterFirst = (window as any).__lifecycle.snapshot();
      adapter.acquire();
      const lifecycle = (window as any).__lifecycle;
      return { afterFirst, afterSecond: lifecycle.snapshot() };
    });
    assert.deepEqual(firstAcquire.afterSecond, firstAcquire.afterFirst, 'repeated acquire must be idempotent');
    assert.equal(firstAcquire.afterSecond.mutationConstructs, 1);
    assert.equal(firstAcquire.afterSecond.mutationObserves, 1);
    assert.equal(firstAcquire.afterSecond.resizeConstructs, 1);
    assert.equal(firstAcquire.afterSecond.resizeObserves, 1);

    const releaseEffects = await page.evaluate(() => {
      const lifecycle = (window as any).__lifecycle;
      const oldRootCallback = lifecycle.callbacks('mutation', 'first')[0];
      const oldResizeCallback = lifecycle.callbacks('resize', 'first')[0];
      oldResizeCallback([], {});
      const pendingFrame = lifecycle.lastFrameId();
      lifecycle.oldFrame = pendingFrame;
      (window as any).__firstWidthLifecycle.release();
      const released = lifecycle.snapshot();
      const table = document.querySelector<HTMLTableElement>('[data-table-column-width="first"]')!;
      table.style.width = '321px';
      oldRootCallback([], {});
      oldResizeCallback([], {});
      lifecycle.runFrame(pendingFrame);
      return {
        released,
        afterLateCallbacks: lifecycle.snapshot(),
        width: table.style.width
      };
    });
    assert.equal(releaseEffects.released.mutationDisconnects, 1);
    assert.equal(releaseEffects.released.resizeDisconnects, 1);
    assert.deepEqual(
      releaseEffects.afterLateCallbacks,
      releaseEffects.released,
      'released root/resize/RAF callbacks must not query, schedule, project, or mutate'
    );
    assert.equal(releaseEffects.width, '321px');

    const reacquired = await page.evaluate(() => {
      const lifecycle = (window as any).__lifecycle;
      const oldRootCallback = lifecycle.callbacks('mutation', 'first')[0];
      const oldResizeCallback = lifecycle.callbacks('resize', 'first')[0];
      (window as any).__firstWidthLifecycle.acquire();
      const beforeOldCallbacks = lifecycle.snapshot();
      oldRootCallback([], {});
      oldResizeCallback([], {});
      lifecycle.runFrame(lifecycle.oldFrame);
      const afterOldCallbacks = lifecycle.snapshot();
      const currentRootCallback = lifecycle.callbacks('mutation', 'first')[1];
      const currentResizeCallback = lifecycle.callbacks('resize', 'first')[1];
      currentRootCallback([], {});
      const afterCurrentRoot = lifecycle.snapshot();
      currentResizeCallback([], {});
      const afterCurrentResize = lifecycle.snapshot();
      lifecycle.runFrame(lifecycle.lastFrameId());
      return {
        beforeOldCallbacks,
        afterOldCallbacks,
        afterCurrentRoot,
        afterCurrentResize,
        current: lifecycle.snapshot()
      };
    });
    assert.deepEqual(
      reacquired.afterOldCallbacks,
      reacquired.beforeOldCallbacks,
      'a previous epoch must remain inert after reacquire'
    );
    assert.ok(reacquired.afterCurrentRoot.queries > reacquired.afterOldCallbacks.queries);
    assert.equal(
      reacquired.afterCurrentResize.frameRequests,
      reacquired.afterCurrentRoot.frameRequests + 1,
      'the current resize observer must schedule projection on a frame after reacquire'
    );
    assert.equal(
      reacquired.afterCurrentResize.queries,
      reacquired.afterCurrentRoot.queries,
      'the resize observer must not project before its requested frame runs'
    );
    assert.ok(reacquired.current.queries > reacquired.afterCurrentResize.queries);
    assert.equal(
      reacquired.current.projections,
      reacquired.afterOldCallbacks.projections,
      'a current resize with stable geometry must not publish a duplicate projection event'
    );

    const balanced = await page.evaluate(() => {
      const lifecycle = (window as any).__lifecycle;
      const adapter = (window as any).__firstWidthLifecycle;
      adapter.release();
      adapter.release();
      adapter.acquire();
      adapter.dispose();
      adapter.dispose();
      return lifecycle.snapshot();
    });
    assert.equal(balanced.mutationConstructs, 3);
    assert.equal(balanced.mutationObserves, 3);
    assert.equal(balanced.mutationDisconnects, 3);
    assert.equal(balanced.resizeConstructs, 3);
    assert.equal(balanced.resizeObserves, 3);
    assert.equal(balanced.resizeDisconnects, 3);

    const isolated = await page.evaluate(() => {
      const lifecycle = (window as any).__lifecycle;
      document.querySelector('[data-lifecycle-root="first"]')!.replaceChildren();
      document.querySelector('[data-lifecycle-root="second"]')!.replaceChildren();
      lifecycle.makeTable('first');
      lifecycle.makeTable('second');
      const first = window.TableColumnWidthLifecycleHarness!.create(
        document.querySelector<HTMLElement>('[data-lifecycle-root="first"]')!
      );
      const second = window.TableColumnWidthLifecycleHarness!.create(
        document.querySelector<HTMLElement>('[data-lifecycle-root="second"]')!
      );
      first.acquire();
      second.acquire();
      const secondResize = lifecycle.callbacks('resize', 'second').at(-1);
      first.release();
      const beforeSecond = lifecycle.snapshot();
      secondResize([], {});
      lifecycle.runFrame(lifecycle.lastFrameId());
      const afterSecond = lifecycle.snapshot();
      first.dispose();
      first.dispose();
      second.dispose();
      second.dispose();
      const sourceOnly = window.TableColumnWidthLifecycleHarness!.create(document.createElement('div'));
      sourceOnly.dispose();
      sourceOnly.dispose();
      return { beforeSecond, afterSecond, final: lifecycle.snapshot() };
    });
    assert.ok(
      isolated.afterSecond.queries > isolated.beforeSecond.queries,
      'the surviving adapter must consume its own resize callback after the peer releases'
    );
    assert.equal(
      isolated.afterSecond.projections,
      isolated.beforeSecond.projections,
      'an isolated stable resize must not publish a duplicate projection event'
    );
    assert.equal(
      isolated.final.mutationDisconnects,
      isolated.final.mutationConstructs,
      'Live destroy must balance resources while Source destroy remains allocation-free'
    );
    assert.equal(isolated.final.resizeDisconnects, isolated.final.resizeConstructs);
  } finally {
    await browser.close();
  }
}

await main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }));

console.log('table column width deterministic lifecycle matrix passed');
