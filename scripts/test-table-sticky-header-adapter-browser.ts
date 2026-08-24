import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const entryPath = path.join(repoRoot, 'scripts', 'test-table-sticky-header-adapter-entry.ts');
const entrySource = fs.readFileSync(entryPath, 'utf8');
assert.equal(entrySource.includes('../webview/src/editor/internal/codeMirrorDomTableStickyHeaderAdapter'), true);
assert.equal(entrySource.includes('../webview/src/editor.ts'), false);
assert.equal(entrySource.includes('../webview/src/index.ts'), false);
assert.equal(entrySource.includes('../webview/src/helpers/tables'), false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-sticky-header-adapter-'));

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
    await page.setViewport({ width: 900, height: 640 });
    await page.setContent(`<!doctype html>
      <style>
        .shell { position: relative; margin: 8px; }
        .outer { height: 260px; overflow-y: auto; }
        .scroller { position: relative; width: 320px; height: 210px; overflow-x: hidden; overflow-y: auto; }
        .content { width: 320px; }
        .horizontal { width: 320px; overflow-x: auto; }
        .spacer { height: 64px; }
        table.source { width: 520px; height: 380px; border-collapse: collapse; }
        table.source thead { height: 34px; }
        .sticky { position: fixed; visibility: hidden; }
        .sticky.is-visible { visibility: visible; }
        .sticky-viewport { overflow: hidden; }
      </style>
      <main class="outer" id="outer">${[1, 2].map((id) => `<section class="shell" id="shell-${id}">
        <div class="scroller" id="scroller-${id}"><div class="content"><div class="spacer"></div>
          <div class="horizontal" id="horizontal-${id}"><table class="source" id="table-${id}"><colgroup><col style="width:180px"><col style="width:340px"></colgroup>
            <thead><tr><th><a href="#x" tabindex="2">Header ${id}</a><input value="interactive"><button>Command</button>
              <span contenteditable>empty editable</span><span contenteditable="plaintext-only">plain editable</span>
              <span contenteditable="TrUe"><span>inherited editable</span></span><span contenteditable="false" tabindex="0">false editable</span>
              <span role="button" tabindex="0">role command</span><span class="meo-md-html-table-column-resize-handle" aria-hidden="true"></span>
            </th><th>Value<span class="meo-md-html-table-column-resize-handle" aria-hidden="true"></span></th></tr></thead>
            <tbody>${Array.from({ length: 12 }, (_, row) => `<tr><td>${id}-${row}</td><td>row</td></tr>`).join('')}</tbody>
          </table></div><div style="height:220px"></div>
        </div></div>
        <div class="sticky" id="sticky-${id}"><button class="sticky-toolbar-button">Toolbar</button><div class="sticky-viewport" id="viewport-${id}">
          <table id="sticky-table-${id}"><thead><tr id="sticky-row-${id}"></tr></thead></table>
        </div></div>
      </section>`).join('')}</main>`);
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });

    const result = await page.evaluate(async () => {
      class DeterministicSharedLayoutScheduler {
        records = new Set<any>();
        drainScheduled = false;
        waiters = new Set<() => void>();
        register(task: () => void) {
          const record = { task, active: true, pending: false };
          this.records.add(record);
          return {
            request: () => {
              if (!record.active || record.pending) return;
              record.pending = true;
              this.scheduleDrain();
            },
            dispose: () => {
              record.active = false;
              record.pending = false;
              this.records.delete(record);
            }
          };
        }
        scheduleDrain() {
          if (this.drainScheduled) return;
          this.drainScheduled = true;
          queueMicrotask(() => this.drain());
        }
        drain() {
          this.drainScheduled = false;
          const current = Array.from(this.records).filter((record) => record.active && record.pending);
          for (const record of current) record.pending = false;
          for (const record of current) record.task();
          if (Array.from(this.records).some((record) => record.active && record.pending)) {
            this.scheduleDrain();
            return;
          }
          queueMicrotask(() => {
            if (this.drainScheduled || Array.from(this.records).some((record) => record.active && record.pending)) return;
            for (const resolve of this.waiters) resolve();
            this.waiters.clear();
          });
        }
        whenEmpty() {
          return new Promise<void>((resolve) => {
            this.waiters.add(resolve);
            this.scheduleDrain();
          });
        }
        get empty() {
          return !this.drainScheduled && !Array.from(this.records).some((record) => record.active && record.pending);
        }
      }

      const candidate = (window as any).TableStickyHeaderAdapterCandidate;
      const scheduler = new DeterministicSharedLayoutScheduler();
      const settle = async (action: () => void) => {
        const originalFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = () => {
          throw new Error('Table Sticky Header Adapter must use the injected scheduler');
        };
        try {
          action();
          await scheduler.whenEmpty();
          if (!scheduler.empty) throw new Error('layout scheduler did not reach an empty causal queue');
        } finally {
          window.requestAnimationFrame = originalFrame;
        }
        if (window.requestAnimationFrame !== originalFrame) {
          throw new Error('requestAnimationFrame capability was not restored');
        }
      };
      const settleError = async (action: () => void) => {
        const originalFrame = window.requestAnimationFrame;
        window.requestAnimationFrame = () => {
          throw new Error('Table Sticky Header Adapter must use the injected scheduler');
        };
        let error: unknown = null;
        try {
          action();
        } catch (caught) {
          error = caught;
        }
        try {
          await scheduler.whenEmpty();
        } finally {
          window.requestAnimationFrame = originalFrame;
        }
        if (window.requestAnimationFrame !== originalFrame) {
          throw new Error('requestAnimationFrame capability was not restored after failure');
        }
        return error;
      };
      const elements = (id: number) => ({
        shell: document.getElementById(`shell-${id}`)!,
        scroller: document.getElementById(`scroller-${id}`)!,
        horizontalScroller: document.getElementById(`horizontal-${id}`)!,
        table: document.getElementById(`table-${id}`) as HTMLTableElement,
        stickyChrome: document.getElementById(`sticky-${id}`)!,
        stickyHeaderViewport: document.getElementById(`viewport-${id}`)!,
        stickyTable: document.getElementById(`sticky-table-${id}`) as HTMLTableElement,
        stickyHeaderRow: document.getElementById(`sticky-row-${id}`) as HTMLTableRowElement
      });
      let adapter1: any;
      let invalidateDuringRefresh = true;
      const policyWithReentry = {
        layout(input: any) {
          if (invalidateDuringRefresh) {
            invalidateDuringRefresh = false;
            adapter1.invalidate();
          }
          return candidate.policy.layout(input);
        }
      };
      adapter1 = candidate.createAdapter({
        policy: policyWithReentry,
        scheduler,
        resolveElements: () => elements(1),
        controlsHeight: () => elements(1).shell.classList.contains('controls-visible') ? 24 : 0
      });
      const adapter2 = candidate.createAdapter({
        policy: candidate.policy,
        scheduler,
        resolveElements: () => elements(2),
        controlsHeight: () => 0
      });

      const sourceText = elements(1).table.textContent;
      const initialScroll = elements(1).scroller.scrollTop;
      const sourceInput = elements(1).table.querySelector('input') as HTMLInputElement;
      sourceInput.focus();
      sourceInput.setSelectionRange(2, 7);
      await settle(() => {
        adapter1.mount();
        adapter2.mount();
      });
      const initiallyHidden = !elements(1).stickyChrome.classList.contains('is-visible');
      const passive = {
        ariaHidden: elements(1).stickyHeaderViewport.getAttribute('aria-hidden'),
        inputs: elements(1).stickyHeaderRow.querySelectorAll('input,button,textarea,select').length,
        href: elements(1).stickyHeaderRow.querySelector('a')?.getAttribute('href') ?? null,
        editableCount: Array.from(elements(1).stickyHeaderRow.querySelectorAll<HTMLElement>('*'))
          .filter((element) => element.isContentEditable).length,
        focusableCount: Array.from(elements(1).stickyHeaderRow.querySelectorAll<HTMLElement>('*'))
          .filter((element) => element.tabIndex >= 0).length,
        focusable: Array.from(elements(1).stickyHeaderRow.querySelectorAll<HTMLElement>('*'))
          .filter((element) => element.tabIndex >= 0)
          .map((element) => `${element.tagName}:${element.outerHTML}`),
        resizeHandles: elements(1).stickyHeaderRow.querySelectorAll('.meo-md-html-table-column-resize-handle').length,
        toolbarButtons: elements(1).stickyChrome.querySelectorAll('.sticky-toolbar-button').length
      };
      const sourceUnchangedByMount = elements(1).table.textContent === sourceText;

      await settle(() => {
        for (const id of [1, 2]) {
          elements(id).scroller.scrollTop = 90;
          elements(id).scroller.dispatchEvent(new Event('scroll'));
          elements(id).scroller.dispatchEvent(new Event('scroll'));
        }
      });
      const visible = elements(1).stickyChrome.classList.contains('is-visible');
      const outer = document.getElementById('outer')!;
      await settle(() => {
        outer.scrollTop = 24;
        outer.dispatchEvent(new Event('scroll'));
      });
      const outerScrollAligned = [1, 2].every((id) => (
        Number.parseFloat(elements(id).stickyChrome.style.top) ===
        Math.round(elements(id).scroller.getBoundingClientRect().top)
      ));
      await settle(() => {
        elements(1).horizontalScroller.scrollLeft = 45;
        elements(1).horizontalScroller.dispatchEvent(new Event('scroll'));
        elements(1).horizontalScroller.dispatchEvent(new Event('scroll'));
      });
      const transform = elements(1).stickyTable.style.transform;
      const visibleHeight = Number.parseFloat(elements(1).stickyChrome.style.height);

      await settle(() => {
        elements(1).shell.classList.add('controls-visible');
        adapter1.invalidate();
      });
      const controls = {
        className: elements(1).stickyChrome.classList.contains('has-sticky-controls'),
        height: elements(1).stickyChrome.style.height
      };

      await settle(() => {
        elements(1).table.tHead!.rows[0].cells[0].querySelector('a')!.textContent = 'Updated header';
        adapter1.update();
      });
      const updatedHeader = elements(1).stickyHeaderRow.textContent;
      const pendingZeroClone = elements(1).stickyHeaderRow.firstElementChild!;
      const pendingOne = Object.assign(document.createElement('span'), {
        className: 'pending-image', textContent: 'pending-1'
      });
      const pendingTwo = Object.assign(document.createElement('span'), {
        className: 'pending-image', textContent: 'pending-2'
      });
      await settle(() => {
        elements(1).table.tHead!.rows[0].cells[0].append(pendingOne, pendingTwo);
      });
      const pendingTwoProjected = elements(1).stickyHeaderRow.querySelectorAll('.pending-image').length;
      await settle(() => {
        pendingOne.className = 'resolved-image';
        pendingOne.replaceChildren(Object.assign(document.createElement('img'), { alt: 'resolved-1' }));
      });
      const pendingOneProjected = elements(1).stickyHeaderRow.querySelectorAll('.pending-image').length;
      await settle(() => {
        pendingTwo.className = 'rejected-image';
        pendingTwo.textContent = 'rejected-2';
      });
      const pendingImageGeneration = {
        oldDetached: !pendingZeroClone.isConnected,
        pendingTwoProjected,
        pendingOneProjected,
        pendingZeroProjected: elements(1).stickyHeaderRow.querySelectorAll('.pending-image').length,
        resolved: elements(1).stickyHeaderRow.querySelectorAll('.resolved-image img').length,
        rejected: elements(1).stickyHeaderRow.querySelectorAll('.rejected-image').length,
        currentLate: 0
      };
      await settle(() => pendingZeroClone.append(
        Object.assign(document.createElement('span'), { className: 'late-old-generation', textContent: 'late' })
      ));
      pendingImageGeneration.currentLate = elements(1).stickyHeaderRow
        .querySelectorAll('.late-old-generation').length;

      await settle(() => {
        elements(1).table.style.width = '480px';
        elements(1).table.dispatchEvent(new Event('meo-table-column-width-projected'));
        adapter1.invalidate();
      });
      const projectedWidth = elements(1).stickyTable.style.width;
      const focusAndSelectionPreserved = (
        document.activeElement === sourceInput &&
        sourceInput.selectionStart === 2 &&
        sourceInput.selectionEnd === 7
      );

      await settle(() => {
        elements(1).shell.style.display = 'none';
        adapter1.invalidate();
      });
      const hiddenWithOuterMode = !elements(1).stickyChrome.classList.contains('is-visible');
      elements(1).shell.style.display = '';

      const detachedTable = elements(1).table;
      const rebuiltTable = detachedTable.cloneNode(true) as HTMLTableElement;
      await settle(() => {
        detachedTable.replaceWith(rebuiltTable);
        adapter1.update();
      });
      const visibleAfterRebuild = elements(1).stickyChrome.classList.contains('is-visible');
      await settle(() => {
        detachedTable.tHead!.rows[0].cells[0].querySelector('a')!.textContent = 'Detached header';
      });
      const headerAfterDetachedMutation = elements(1).stickyHeaderRow.textContent;
      await settle(() => {
        rebuiltTable.tHead!.rows[0].cells[0].querySelector('a')!.textContent = 'Rebuilt header';
      });
      const headerAfterRebuiltMutation = elements(1).stickyHeaderRow.textContent;

      const oldHorizontalScroller = elements(1).horizontalScroller;
      const replacementHorizontalScroller = document.createElement('div');
      replacementHorizontalScroller.id = 'horizontal-1';
      replacementHorizontalScroller.className = 'horizontal';
      await settle(() => {
        oldHorizontalScroller.before(replacementHorizontalScroller);
        replacementHorizontalScroller.append(elements(1).table);
        oldHorizontalScroller.remove();
        adapter1.update();
      });
      const transformBeforeStaleScroll = elements(1).stickyTable.style.transform;
      await settle(() => oldHorizontalScroller.dispatchEvent(new Event('scroll')));
      const transformAfterStaleScroll = elements(1).stickyTable.style.transform;
      await settle(() => {
        elements(1).horizontalScroller.scrollLeft = 35;
        elements(1).horizontalScroller.dispatchEvent(new Event('scroll'));
      });
      const transformAfterHorizontalReplacement = elements(1).stickyTable.style.transform;

      const replacedStickyChrome = elements(1).stickyChrome;
      const replacedStickyViewport = elements(1).stickyHeaderViewport;
      const currentStickyChrome = replacedStickyChrome.cloneNode(true) as HTMLElement;
      replacedStickyChrome.replaceWith(currentStickyChrome);
      await settle(() => adapter1.update());
      const currentHeaderBeforeStaleCloneMutation = elements(1).stickyHeaderRow.textContent;
      const staleEditable = document.createElement('span');
      staleEditable.contentEditable = 'true';
      await settle(() => replacedStickyViewport.append(staleEditable));
      const staleCloneObserverDetached = staleEditable.getAttribute('contenteditable') === 'true';
      const currentHeaderAfterStaleCloneMutation = elements(1).stickyHeaderRow.textContent;

      const styleBeforeUnmount = elements(1).stickyTable.style.width;
      await settle(() => adapter1.unmount());
      let lateWrites = 0;
      const lateObserver = new MutationObserver((records) => { lateWrites += records.length; });
      lateObserver.observe(elements(1).stickyChrome, { attributes: true, childList: true, subtree: true });
      await settle(() => {
        elements(1).table.style.width = '440px';
        elements(1).scroller.dispatchEvent(new Event('scroll'));
        elements(1).horizontalScroller.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('resize'));
      });
      lateObserver.disconnect();
      const styleAfterUnmount = elements(1).stickyTable.style.width;
      const hiddenAfterUnmount = !elements(1).stickyChrome.classList.contains('is-visible');

      const mountedDisposeNode = elements(2).stickyChrome;
      let mountedDisposeLateWrites = 0;
      const mountedDisposeObserver = new MutationObserver((records) => { mountedDisposeLateWrites += records.length; });
      mountedDisposeObserver.observe(mountedDisposeNode, { attributes: true, childList: true, subtree: true });
      await settle(() => adapter2.dispose());
      mountedDisposeLateWrites = 0;
      await settle(() => {
        adapter2.mount();
        adapter2.update();
        adapter2.invalidate();
        adapter2.unmount();
        adapter2.dispose();
        elements(2).scroller.dispatchEvent(new Event('scroll'));
        elements(2).horizontalScroller.dispatchEvent(new Event('scroll'));
        window.dispatchEvent(new Event('resize'));
        elements(2).table.tHead!.rows[0].cells[0].append('late source mutation');
      });
      mountedDisposeObserver.disconnect();

      const primaryError = new Error('primary clone failure');
      const cleanupFirst = new Error('passive listener cleanup failure');
      const cleanupSecond = new Error('horizontal listener cleanup failure');
      const errorAdapter = candidate.createAdapter({
        policy: candidate.policy,
        scheduler,
        resolveElements: () => elements(2),
        controlsHeight: () => 0
      });
      await settle(() => errorAdapter.mount());
      const sourceCell = elements(2).table.tHead!.rows[0].cells[0] as HTMLTableCellElement & {
        cloneNode: (deep?: boolean) => Node;
      };
      const originalCloneNode = sourceCell.cloneNode;
      const originalViewportRemove = elements(2).stickyHeaderViewport.removeEventListener;
      const originalHorizontalRemove = elements(2).horizontalScroller.removeEventListener;
      sourceCell.cloneNode = () => { throw primaryError; };
      elements(2).stickyHeaderViewport.removeEventListener = function (...args: Parameters<typeof originalViewportRemove>) {
        originalViewportRemove.apply(this, args);
        throw cleanupFirst;
      };
      elements(2).horizontalScroller.removeEventListener = function (...args: Parameters<typeof originalHorizontalRemove>) {
        originalHorizontalRemove.apply(this, args);
        throw cleanupSecond;
      };
      const primaryCleanupError = await settleError(() => errorAdapter.update());
      sourceCell.cloneNode = originalCloneNode;
      elements(2).stickyHeaderViewport.removeEventListener = originalViewportRemove;
      elements(2).horizontalScroller.removeEventListener = originalHorizontalRemove;
      errorAdapter.dispose();

      const cleanupAdapter = candidate.createAdapter({
        policy: candidate.policy,
        scheduler,
        resolveElements: () => elements(2),
        controlsHeight: () => 0
      });
      await settle(() => cleanupAdapter.mount());
      elements(2).stickyHeaderViewport.removeEventListener = function (...args: Parameters<typeof originalViewportRemove>) {
        originalViewportRemove.apply(this, args);
        throw cleanupFirst;
      };
      elements(2).horizontalScroller.removeEventListener = function (...args: Parameters<typeof originalHorizontalRemove>) {
        originalHorizontalRemove.apply(this, args);
        throw cleanupSecond;
      };
      const cleanupOnlyError = await settleError(() => cleanupAdapter.unmount());
      elements(2).stickyHeaderViewport.removeEventListener = originalViewportRemove;
      elements(2).horizontalScroller.removeEventListener = originalHorizontalRemove;
      cleanupAdapter.dispose();
      adapter1.dispose();
      await scheduler.whenEmpty();

      return {
        initiallyHidden,
        passive,
        outerScrollAligned,
        visible,
        transform,
        visibleHeight,
        controls,
        updatedHeader,
        pendingImageGeneration,
        projectedWidth,
        focusAndSelectionPreserved,
        hiddenWithOuterMode,
        visibleAfterRebuild,
        headerAfterDetachedMutation,
        headerAfterRebuiltMutation,
        transformBeforeStaleScroll,
        transformAfterStaleScroll,
        transformAfterHorizontalReplacement,
        staleCloneObserverDetached,
        currentHeaderBeforeStaleCloneMutation,
        currentHeaderAfterStaleCloneMutation,
        styleBeforeUnmount,
        styleAfterUnmount,
        hiddenAfterUnmount,
        lateWrites,
        mountedDisposeLateWrites,
        primaryCleanupError: primaryCleanupError instanceof AggregateError ? {
          cause: primaryCleanupError.cause === primaryError,
          errors: primaryCleanupError.errors.map((error) => (error as Error).message)
        } : null,
        cleanupOnlyError: cleanupOnlyError instanceof AggregateError ? {
          cause: cleanupOnlyError.cause === cleanupFirst,
          errors: cleanupOnlyError.errors.map((error) => (error as Error).message)
        } : null,
        causalQueueEmpty: scheduler.empty,
        sourceUnchangedByMount,
        scrollUnchangedByProjection: elements(1).scroller.scrollTop === 90
          && elements(1).horizontalScroller.scrollLeft === 35
          && initialScroll === 0
      };
    });

    assert.equal(result.initiallyHidden, true);
    assert.deepEqual(result.passive, {
      ariaHidden: 'true', inputs: 0, href: null, editableCount: 0, focusableCount: 0, focusable: [],
      resizeHandles: 2, toolbarButtons: 1
    });
    assert.equal(result.outerScrollAligned, true, 'outer scrolling keeps Sticky geometry aligned to public scroller bounds');
    assert.equal(result.visible, true);
    assert.equal(result.transform, 'translateX(-45px)');
    assert.equal(result.controls.className, true);
    assert.equal(Number.parseFloat(result.controls.height) - result.visibleHeight, 24);
    assert.match(result.updatedHeader ?? '', /Updated header/);
    assert.deepEqual(result.pendingImageGeneration, {
      oldDetached: true,
      pendingTwoProjected: 2,
      pendingOneProjected: 1,
      pendingZeroProjected: 0,
      resolved: 1,
      rejected: 1,
      currentLate: 0
    });
    assert.equal(result.projectedWidth, '480px');
    assert.equal(result.focusAndSelectionPreserved, true);
    assert.equal(result.hiddenWithOuterMode, true);
    assert.equal(result.visibleAfterRebuild, true);
    assert.doesNotMatch(result.headerAfterDetachedMutation ?? '', /Detached header/);
    assert.match(result.headerAfterRebuiltMutation ?? '', /Rebuilt header/);
    assert.equal(result.transformAfterStaleScroll, result.transformBeforeStaleScroll,
      'a replaced horizontal scroller must not change current Sticky geometry');
    assert.equal(result.transformAfterHorizontalReplacement, 'translateX(-35px)');
    assert.equal(result.staleCloneObserverDetached, true);
    assert.equal(result.currentHeaderAfterStaleCloneMutation, result.currentHeaderBeforeStaleCloneMutation);
    assert.equal(result.styleAfterUnmount, result.styleBeforeUnmount);
    assert.equal(result.hiddenAfterUnmount, true);
    assert.equal(result.lateWrites, 0);
    assert.equal(result.mountedDisposeLateWrites, 0);
    assert.deepEqual(result.primaryCleanupError, {
      cause: true,
      errors: ['primary clone failure', 'passive listener cleanup failure', 'horizontal listener cleanup failure']
    });
    assert.deepEqual(result.cleanupOnlyError, {
      cause: true,
      errors: ['passive listener cleanup failure', 'horizontal listener cleanup failure']
    });
    assert.equal(result.causalQueueEmpty, true);
    assert.equal(result.sourceUnchangedByMount, true);
    assert.equal(result.scrollUnchangedByProjection, true);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table sticky header adapter Chromium candidate trace passed');
