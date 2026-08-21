import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

type ObserverMetrics = {
  constructs: number;
  observes: number;
  disconnects: number;
  callbacks: number;
  queries: number;
};

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-source-table-column-width-'));

const waitForFrames = async (page: import('puppeteer-core').Page, count = 6): Promise<void> => {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
};

const readMetrics = (
  page: import('puppeteer-core').Page,
  editorId: string
): Promise<ObserverMetrics> => page.evaluate((id) => (
  structuredClone((window as any).__tableColumnWidthObserverMetrics[id])
), editorId);

const tableSelector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table)';

const firstColumnWidth = (
  page: import('puppeteer-core').Page,
  host: string
): Promise<number> => page.$eval(
  `${host} ${tableSelector} thead th:first-child`,
  (cell) => cell.getBoundingClientRect().width
);

async function dragFirstColumn(
  page: import('puppeteer-core').Page,
  host: string,
  delta: number
): Promise<void> {
  const handle = `${host} ${tableSelector} th:first-child .meo-md-html-table-column-resize-handle`;
  const point = await page.$eval(handle, (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  await page.mouse.move(point.x + delta, point.y, { steps: 4 });
  await page.mouse.up();
  await waitForFrames(page);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-source-lightweight-table-column-width-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
    await page.setContent([
      '<!doctype html><style>html,body{height:100%;margin:0}.host{height:50%;overflow:auto}</style>',
      '<div id="first" class="host" data-column-width-observer-host="first"></div>',
      '<div id="second" class="host" data-column-width-observer-host="second"></div>'
    ].join(''));
    await page.evaluate(() => {
      const NativeMutationObserver = window.MutationObserver;
      const nativeQuerySelectorAll = Element.prototype.querySelectorAll;
      const metrics: Record<string, ObserverMetrics> = {};
      const callbacks: Record<string, MutationCallback[]> = {};
      const forId = (id: string): ObserverMetrics => (
        metrics[id] ??= { constructs: 0, observes: 0, disconnects: 0, callbacks: 0, queries: 0 }
      );

      class ObservedMutationObserver implements MutationObserver {
        private readonly nativeObserver: MutationObserver;
        private editorId: string | null = null;

        constructor(private readonly callback: MutationCallback) {
          this.nativeObserver = new NativeMutationObserver((records) => {
            if (this.editorId) forId(this.editorId).callbacks += 1;
            callback(records, this);
          });
        }

        observe(target: Node, options?: MutationObserverInit): void {
          if (
            target instanceof HTMLElement &&
            target.dataset.columnWidthObserverHost &&
            options?.childList === true &&
            options.subtree === true
          ) {
            this.editorId = target.dataset.columnWidthObserverHost;
            forId(this.editorId).constructs += 1;
            forId(this.editorId).observes += 1;
            (callbacks[this.editorId] ??= []).push(this.callback);
          }
          this.nativeObserver.observe(target, options);
        }

        disconnect(): void {
          if (this.editorId) forId(this.editorId).disconnects += 1;
          this.nativeObserver.disconnect();
        }

        takeRecords(): MutationRecord[] {
          return this.nativeObserver.takeRecords();
        }
      }

      Element.prototype.querySelectorAll = function querySelectorAll<E extends Element = Element>(
        selectors: string
      ): NodeListOf<E> {
        if (selectors === 'table[data-table-column-width]' && this instanceof HTMLElement) {
          const id = this.dataset.columnWidthObserverHost;
          if (id) forId(id).queries += 1;
        }
        return nativeQuerySelectorAll.call(this, selectors) as NodeListOf<E>;
      };
      window.MutationObserver = ObservedMutationObserver;
      forId('first');
      forId('second');
      (window as any).__tableColumnWidthObserverMetrics = metrics;
      (window as any).__invokeTableColumnWidthObserver = (id: string) => {
        for (const callback of callbacks[id] ?? []) callback([], {} as MutationObserver);
      };
    });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const text = ['# Source table', '', '| A | B |', '| --- | --- |', '| one | two |'].join('\n');
    await page.evaluate((documentText) => {
      const harness = (window as any).SourceLightweightTableColumnWidthHarness;
      const editor = harness.createEditor({
        parent: document.getElementById('first'),
        text: documentText,
        initialMode: 'source',
        onApplyChanges() {}
      });
      (window as any).__tableWidthEditors = { first: editor };
      const target = documentText.indexOf('one');
      editor.view.dispatch({ selection: { anchor: target, head: target + 3 } });
      editor.focus();
    }, text);
    await waitForFrames(page);

    assert.deepEqual(
      await readMetrics(page, 'first'),
      { constructs: 0, observes: 0, disconnects: 0, callbacks: 0, queries: 0 },
      'production Source bootstrap must not create a Table Column Width observer or query rendered tables'
    );

    await page.evaluate(() => {
      const editor = (window as any).__tableWidthEditors.first;
      const marker = document.createElement('span');
      marker.dataset.sourceMutation = 'ordinary';
      editor.view.dom.append(marker);
    });
    await waitForFrames(page);
    assert.deepEqual(
      await readMetrics(page, 'first'),
      { constructs: 0, observes: 0, disconnects: 0, callbacks: 0, queries: 0 },
      'ordinary Source DOM mutations must not schedule rendered-table discovery'
    );

    const initialState = await page.evaluate(() => {
      const editor = (window as any).__tableWidthEditors.first;
      return {
        text: editor.getText(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        scrollTop: editor.view.scrollDOM.scrollTop
      };
    });

    await page.evaluate(() => (window as any).__tableWidthEditors.first.setMode('live'));
    await page.waitForSelector('#first table[data-table-column-width][data-table-column-width-owner="adapter"]');
    await waitForFrames(page);
    let firstMetrics = await readMetrics(page, 'first');
    assert.equal(firstMetrics.constructs, 1, 'Source-to-Live must construct one column-width observer');
    assert.equal(firstMetrics.observes, 1, 'Source-to-Live must observe one editor root');
    assert.equal(firstMetrics.disconnects, 0);
    assert.ok(firstMetrics.queries > 0, 'Live must discover the rendered table through the DOM seam');

    const beforeDragWidth = await firstColumnWidth(page, '#first');
    await dragFirstColumn(page, '#first', 55);
    const resizedWidth = await firstColumnWidth(page, '#first');
    assert.ok(resizedWidth > beforeDragWidth + 45, 'Live table resize must remain active');
    const projectedColumns = await page.$eval('#first .meo-md-html-table-shell', (shell) => {
      const primary = shell.querySelector<HTMLTableElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table)'
      );
      const sticky = shell.querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table');
      return {
        primary: primary?.querySelector<HTMLTableColElement>('colgroup > col')?.style.width,
        sticky: sticky?.querySelector<HTMLTableColElement>('colgroup > col')?.style.width
      };
    });
    assert.equal(projectedColumns.sticky, projectedColumns.primary, 'Sticky Header must share the Live width projection');

    const liveState = await page.evaluate(() => {
      const editor = (window as any).__tableWidthEditors.first;
      return {
        text: editor.getText(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        scrollTop: editor.view.scrollDOM.scrollTop
      };
    });
    assert.deepEqual(liveState, initialState, 'mode and width presentation must preserve text/selection/focus/viewport/history');

    await page.evaluate(() => (window as any).__tableWidthEditors.first.setMode('source'));
    await waitForFrames(page);
    firstMetrics = await readMetrics(page, 'first');
    assert.equal(firstMetrics.disconnects, 1, 'Live-to-Source must disconnect the active observer once');
    const sourceQueryBaseline = firstMetrics.queries;
    await page.evaluate(() => {
      const editor = (window as any).__tableWidthEditors.first;
      editor.view.dom.append(document.createElement('i'));
      (window as any).__invokeTableColumnWidthObserver('first');
    });
    await waitForFrames(page);
    assert.equal(
      (await readMetrics(page, 'first')).queries,
      sourceQueryBaseline,
      'Source mutations and late callbacks from a released observer must have no DOM-query side effect'
    );

    for (let cycle = 0; cycle < 2; cycle += 1) {
      await page.evaluate(() => (window as any).__tableWidthEditors.first.setMode('live'));
      await page.waitForSelector('#first table[data-table-column-width][data-table-column-width-owner="adapter"]');
      await waitForFrames(page);
      assert.ok(
        Math.abs(await firstColumnWidth(page, '#first') - resizedWidth) < 2,
        'WidthIntent must remain owned by the adapter across Source round trips'
      );
      await page.evaluate(() => (window as any).__tableWidthEditors.first.setMode('source'));
      await waitForFrames(page);
    }
    firstMetrics = await readMetrics(page, 'first');
    assert.equal(firstMetrics.constructs, 3);
    assert.equal(firstMetrics.observes, 3);
    assert.equal(firstMetrics.disconnects, 3, 'repeated mode switches must balance observer acquisition and release');

    await page.evaluate((documentText) => {
      const harness = (window as any).SourceLightweightTableColumnWidthHarness;
      const state = (window as any).__tableWidthEditors;
      state.first.setMode('live');
      state.second = harness.createEditor({
        parent: document.getElementById('second'),
        text: documentText.replace('Source table', 'Second table'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, text);
    await page.waitForSelector('#first table[data-table-column-width][data-table-column-width-owner="adapter"]');
    await page.waitForSelector('#second table[data-table-column-width][data-table-column-width-owner="adapter"]');
    await waitForFrames(page);
    assert.equal((await readMetrics(page, 'first')).constructs, 4);
    const initialLiveSecond = await readMetrics(page, 'second');
    assert.equal(initialLiveSecond.constructs, 1, 'an initial Live editor must construct one observer');
    assert.equal(initialLiveSecond.observes, 1, 'an initial Live editor must observe its own root once');
    assert.equal(initialLiveSecond.disconnects, 0);
    assert.ok(initialLiveSecond.queries > 0);

    const beforeFirstMutation = await readMetrics(page, 'first');
    const beforeSecondMutation = await readMetrics(page, 'second');
    await page.evaluate(() => {
      (window as any).__tableWidthEditors.first.view.dom.append(document.createElement('b'));
    });
    await waitForFrames(page, 2);
    const afterFirstMutation = await readMetrics(page, 'first');
    const afterSecondMutation = await readMetrics(page, 'second');
    assert.ok(afterFirstMutation.queries > beforeFirstMutation.queries);
    assert.equal(
      afterSecondMutation.queries,
      beforeSecondMutation.queries,
      'one Live editor DOM mutation must not trigger another editor instance'
    );

    await page.evaluate(() => (window as any).__tableWidthEditors.first.setMode('source'));
    await waitForFrames(page);
    const firstReleasedQueries = (await readMetrics(page, 'first')).queries;
    const secondLiveQueries = (await readMetrics(page, 'second')).queries;
    await page.evaluate(() => {
      const state = (window as any).__tableWidthEditors;
      state.first.view.dom.append(document.createElement('em'));
      state.second.view.dom.append(document.createElement('em'));
    });
    await waitForFrames(page, 2);
    assert.equal((await readMetrics(page, 'first')).queries, firstReleasedQueries);
    assert.ok((await readMetrics(page, 'second')).queries > secondLiveQueries);

    await page.evaluate(() => (window as any).__tableWidthEditors.second.destroy());
    const secondDestroyed = await readMetrics(page, 'second');
    assert.equal(secondDestroyed.disconnects, 1, 'destroy must release a Live observer exactly once');
    const secondDestroyedQueries = secondDestroyed.queries;
    await page.evaluate(() => (window as any).__invokeTableColumnWidthObserver('second'));
    assert.equal((await readMetrics(page, 'second')).queries, secondDestroyedQueries);

    await page.evaluate(() => (window as any).__tableWidthEditors.first.destroy());
    const firstDestroyed = await readMetrics(page, 'first');
    assert.equal(firstDestroyed.disconnects, firstDestroyed.constructs, 'destroy after Source release must remain idempotent');
  } finally {
    await browser.close();
  }

  console.log('Source lightweight Table Column Width production trace passed');
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
