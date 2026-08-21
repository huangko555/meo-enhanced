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
  rafRequests: number;
  projections: number;
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
  (window as any).__readTableColumnWidthObserverMetrics(id)
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
      const NativeResizeObserver = window.ResizeObserver;
      const nativeRequestAnimationFrame = window.requestAnimationFrame.bind(window);
      const nativeQuerySelectorAll = Element.prototype.querySelectorAll;
      const nativeDispatchEvent = EventTarget.prototype.dispatchEvent;
      const metrics: Record<string, ObserverMetrics> = {};
      const observerRecords: Array<{
        callback: MutationCallback;
        editorId: string | null;
        observes: number;
      }> = [];
      let activeResizeEditorId: string | null = null;
      const forId = (id: string): ObserverMetrics => (
        metrics[id] ??= {
          constructs: 0,
          observes: 0,
          disconnects: 0,
          callbacks: 0,
          queries: 0,
          rafRequests: 0,
          projections: 0
        }
      );

      class ObservedMutationObserver implements MutationObserver {
        private readonly nativeObserver: MutationObserver;
        private readonly record: (typeof observerRecords)[number];

        constructor(callback: MutationCallback) {
          this.record = { callback, editorId: null, observes: 0 };
          observerRecords.push(this.record);
          this.nativeObserver = new NativeMutationObserver((records) => {
            if (this.record.editorId) forId(this.record.editorId).callbacks += 1;
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
            this.record.editorId = target.dataset.columnWidthObserverHost;
            this.record.observes += 1;
            forId(this.record.editorId).observes += 1;
          }
          this.nativeObserver.observe(target, options);
        }

        disconnect(): void {
          if (this.record.editorId) forId(this.record.editorId).disconnects += 1;
          this.nativeObserver.disconnect();
        }

        takeRecords(): MutationRecord[] {
          return this.nativeObserver.takeRecords();
        }
      }

      class ObservedResizeObserver implements ResizeObserver {
        private readonly nativeObserver: ResizeObserver;
        private editorId: string | null = null;

        constructor(callback: ResizeObserverCallback) {
          this.nativeObserver = new NativeResizeObserver((entries, observer) => {
            const previous = activeResizeEditorId;
            activeResizeEditorId = this.editorId;
            try {
              callback(entries, observer);
            } finally {
              activeResizeEditorId = previous;
            }
          });
        }

        observe(target: Element, options?: ResizeObserverOptions): void {
          this.editorId = target instanceof HTMLElement
            && target.classList.contains('meo-md-html-table-shell')
            ? target.closest<HTMLElement>('[data-column-width-observer-host]')
              ?.dataset.columnWidthObserverHost ?? null
            : null;
          this.nativeObserver.observe(target, options);
        }

        disconnect(): void { this.nativeObserver.disconnect(); }
        unobserve(target: Element): void { this.nativeObserver.unobserve(target); }
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
      EventTarget.prototype.dispatchEvent = function dispatchEvent(event: Event): boolean {
        if (event.type === 'meo-table-column-width-projected' && this instanceof Element) {
          const id = this.closest<HTMLElement>('[data-column-width-observer-host]')
            ?.dataset.columnWidthObserverHost;
          if (id) forId(id).projections += 1;
        }
        return nativeDispatchEvent.call(this, event);
      };
      window.MutationObserver = ObservedMutationObserver;
      window.ResizeObserver = ObservedResizeObserver;
      window.requestAnimationFrame = (callback) => {
        if (activeResizeEditorId) forId(activeResizeEditorId).rafRequests += 1;
        return nativeRequestAnimationFrame(callback);
      };
      forId('first');
      forId('second');
      (window as any).__readTableColumnWidthObserverMetrics = (id: string): ObserverMetrics => ({
        ...structuredClone(forId(id)),
        constructs: observerRecords.filter((record) => record.editorId === id).length
      });
      (window as any).__invokeTableColumnWidthObserver = (id: string) => {
        for (const record of observerRecords) {
          if (record.editorId === id) record.callback([], {} as MutationObserver);
        }
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
      (window as any).__tableWidthHostRevisions = { first: [] };
      (window as any).__tableWidthSelections = { first: null };
      const editor = harness.createEditor({
        parent: document.getElementById('first'),
        text: documentText,
        initialMode: 'source',
        onApplyChanges(text: string) {
          ((window as any).__tableWidthHostRevisions.first ??= []).push(text);
        },
        onSelectionChange(selection: unknown) {
          (window as any).__tableWidthSelections.first = selection;
        }
      });
      (window as any).__tableWidthEditors = { first: editor };
      const target = documentText.indexOf('one');
      editor.revealSelection(target, target + 3, { focusEditor: true, align: 'nearest' });
      editor.focus();
    }, text);
    await waitForFrames(page);
    assert.equal(await page.$('#first .cm-editor.meo-mode-source').then(Boolean), true);

    assert.deepEqual(
      await readMetrics(page, 'first'),
      {
        constructs: 0,
        observes: 0,
        disconnects: 0,
        callbacks: 0,
        queries: 0,
        rafRequests: 0,
        projections: 0
      },
      'production Source bootstrap must not create a Table Column Width observer or query rendered tables'
    );

    await page.evaluate(() => {
      const marker = document.createElement('span');
      marker.dataset.sourceMutation = 'ordinary';
      document.querySelector('#first .cm-editor')!.append(marker);
    });
    await waitForFrames(page);
    assert.deepEqual(
      await readMetrics(page, 'first'),
      {
        constructs: 0,
        observes: 0,
        disconnects: 0,
        callbacks: 0,
        queries: 0,
        rafRequests: 0,
        projections: 0
      },
      'ordinary Source DOM mutations must not schedule rendered-table discovery'
    );

    await page.evaluate(() => {
      const editor = (window as any).__tableWidthEditors.first;
      editor.revealSelection(editor.getText().length, editor.getText().length, {
        focusEditor: true,
        align: 'nearest'
      });
    });
    await page.keyboard.type('!');
    await waitForFrames(page);
    await page.evaluate(() => {
      const editor = (window as any).__tableWidthEditors.first;
      const target = editor.getText().indexOf('one');
      editor.revealSelection(target, target + 3, { focusEditor: true, align: 'nearest' });
    });
    await waitForFrames(page);

    const initialState = await page.evaluate(() => {
      const editor = (window as any).__tableWidthEditors.first;
      const selection = (window as any).__tableWidthSelections.first;
      return {
        text: editor.getText(),
        selection: { from: selection?.from, to: selection?.to },
        hostRevision: (window as any).__tableWidthHostRevisions.first.at(-1),
        focused: editor.hasFocus(),
        topVisible: editor.getTopVisiblePosition()
      };
    });

    await page.evaluate(() => (window as any).__tableWidthEditors.first.setMode('live'));
    await page.waitForSelector('#first table[data-table-column-width][data-table-column-width-owner="adapter"]');
    await page.waitForSelector('#first .cm-editor.meo-mode-live');
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
      const selection = (window as any).__tableWidthSelections.first;
      return {
        text: editor.getText(),
        selection: { from: selection?.from, to: selection?.to },
        hostRevision: (window as any).__tableWidthHostRevisions.first.at(-1),
        focused: editor.hasFocus(),
        topVisible: editor.getTopVisiblePosition()
      };
    });
    assert.deepEqual(liveState, initialState, 'mode and width presentation must preserve text/selection/focus/viewport');

    await page.evaluate(() => (window as any).__tableWidthEditors.first.setMode('source'));
    await waitForFrames(page);
    assert.equal(await page.$('#first .cm-editor.meo-mode-source').then(Boolean), true);
    firstMetrics = await readMetrics(page, 'first');
    assert.equal(firstMetrics.disconnects, 1, 'Live-to-Source must disconnect the active observer once');
    const sourceQueryBaseline = firstMetrics.queries;
    await page.evaluate(() => {
      document.querySelector('#first .cm-editor')!.append(document.createElement('i'));
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

    assert.equal(
      await page.evaluate(async (originalText) => {
        const editor = (window as any).__tableWidthEditors.first;
        const applied = await editor.undo();
        return applied && editor.getText() === originalText;
      }, text),
      true,
      'one native undo after mode round trips must undo the user edit, not a mode transition'
    );
    assert.equal(
      await page.evaluate(async (editedText) => {
        const editor = (window as any).__tableWidthEditors.first;
        const applied = await editor.redo();
        return applied && editor.getText() === editedText;
      }, initialState.text),
      true,
      'native redo must restore the same user edit after mode round trips'
    );

    await page.evaluate((documentText) => {
      const harness = (window as any).SourceLightweightTableColumnWidthHarness;
      const state = (window as any).__tableWidthEditors;
      state.first.setMode('live');
      state.first.setText(`host revision\n\n${state.first.getText()}`);
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
    assert.ok(
      Math.abs(await firstColumnWidth(page, '#first') - resizedWidth) < 2,
      'WidthIntent must survive a production external presentation'
    );
    assert.equal((await readMetrics(page, 'first')).constructs, 4);
    const initialLiveSecond = await readMetrics(page, 'second');
    assert.equal(initialLiveSecond.constructs, 1, 'an initial Live editor must construct one observer');
    assert.equal(initialLiveSecond.observes, 1, 'an initial Live editor must observe its own root once');
    assert.equal(initialLiveSecond.disconnects, 0);
    assert.ok(initialLiveSecond.queries > 0);

    const beforeFirstMutation = await readMetrics(page, 'first');
    const beforeSecondMutation = await readMetrics(page, 'second');
    await page.evaluate(() => {
      document.querySelector('#first .cm-editor')!.append(document.createElement('b'));
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
      document.querySelector('#first .cm-editor')!.append(document.createElement('em'));
      document.querySelector('#second .cm-editor')!.append(document.createElement('em'));
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
