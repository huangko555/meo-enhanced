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
        .scroller { position: relative; width: 320px; height: 210px; overflow: auto; }
        .content { width: 560px; }
        .spacer { height: 64px; }
        table.source { width: 520px; height: 380px; border-collapse: collapse; }
        table.source thead { height: 34px; }
        .sticky { position: fixed; visibility: hidden; }
        .sticky.is-visible { visibility: visible; }
        .sticky-viewport { overflow: hidden; }
      </style>
      ${[1, 2].map((id) => `<section class="shell" id="shell-${id}">
        <div class="scroller" id="scroller-${id}"><div class="content"><div class="spacer"></div>
          <table class="source" id="table-${id}"><colgroup><col style="width:180px"><col style="width:340px"></colgroup>
            <thead><tr><th><a href="#x">Header ${id}</a><input value="interactive"></th><th>Value</th></tr></thead>
            <tbody>${Array.from({ length: 12 }, (_, row) => `<tr><td>${id}-${row}</td><td>row</td></tr>`).join('')}</tbody>
          </table><div style="height:220px"></div>
        </div></div>
        <div class="sticky" id="sticky-${id}"><button class="sticky-toolbar-button">Toolbar</button><div class="sticky-viewport" id="viewport-${id}">
          <table id="sticky-table-${id}"><thead><tr id="sticky-row-${id}"></tr></thead></table>
        </div></div>
      </section>`).join('')}`);
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });

    const result = await page.evaluate(async () => {
      class DeterministicSharedLayoutScheduler {
        records = new Set<any>();
        frames = 0;
        register(task: () => void) {
          const record = { task, active: true, pending: false };
          this.records.add(record);
          return {
            request: () => {
              if (!record.active || record.pending) return;
              const hadPending = Array.from(this.records).some((candidate) => candidate.pending);
              record.pending = true;
              if (!hadPending) this.frames += 1;
            },
            dispose: () => {
              record.active = false;
              record.pending = false;
              this.records.delete(record);
            }
          };
        }
        flush() {
          const current = Array.from(this.records).filter((record) => record.active && record.pending);
          for (const record of current) record.pending = false;
          for (const record of current) record.task();
          return current.length;
        }
        get pending() {
          return Array.from(this.records).filter((record) => record.pending).length;
        }
      }

      const candidate = (window as any).TableStickyHeaderAdapterCandidate;
      const scheduler = new DeterministicSharedLayoutScheduler();
      const elements = (id: number) => ({
        shell: document.getElementById(`shell-${id}`)!,
        scroller: document.getElementById(`scroller-${id}`)!,
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
        controlsVisible: () => elements(1).shell.classList.contains('controls-visible')
      });
      const adapter2 = candidate.createAdapter({
        policy: candidate.policy,
        scheduler,
        resolveElements: () => elements(2),
        controlsVisible: () => false
      });

      const sourceText = elements(1).table.textContent;
      const initialScroll = elements(1).scroller.scrollTop;
      const sourceInput = elements(1).table.querySelector('input') as HTMLInputElement;
      sourceInput.focus();
      sourceInput.setSelectionRange(2, 7);
      adapter1.mount();
      adapter2.mount();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const initialTasks = scheduler.flush();
      const reentryPending = scheduler.pending;
      scheduler.flush();
      const initiallyHidden = !elements(1).stickyChrome.classList.contains('is-visible');
      const passive = {
        ariaHidden: elements(1).stickyHeaderViewport.getAttribute('aria-hidden'),
        pointerEvents: elements(1).stickyHeaderViewport.style.pointerEvents,
        inputs: elements(1).stickyHeaderRow.querySelectorAll('input,button,textarea,select').length,
        href: elements(1).stickyHeaderRow.querySelector('a')?.getAttribute('href') ?? null,
        toolbarButtons: elements(1).stickyChrome.querySelectorAll('.sticky-toolbar-button').length
      };

      const framesBeforeStorm = scheduler.frames;
      for (const id of [1, 2]) {
        elements(id).scroller.scrollTop = 90;
        elements(id).scroller.scrollLeft = 45;
        elements(id).scroller.dispatchEvent(new Event('scroll'));
        elements(id).scroller.dispatchEvent(new Event('scroll'));
      }
      window.dispatchEvent(new Event('resize'));
      const stormFrames = scheduler.frames - framesBeforeStorm;
      const stormTasks = scheduler.flush();
      const visible = elements(1).stickyChrome.classList.contains('is-visible');
      const transform = elements(1).stickyTable.style.transform;
      const visibleHeight = Number.parseFloat(elements(1).stickyChrome.style.height);

      elements(1).shell.classList.add('controls-visible');
      adapter1.invalidate();
      scheduler.flush();
      const controls = {
        className: elements(1).stickyChrome.classList.contains('has-sticky-controls'),
        height: elements(1).stickyChrome.style.height
      };

      elements(1).table.tHead!.rows[0].cells[0].querySelector('a')!.textContent = 'Updated header';
      await new Promise((resolve) => setTimeout(resolve, 0));
      scheduler.flush();
      const updatedHeader = elements(1).stickyHeaderRow.textContent;

      elements(1).table.style.width = '480px';
      elements(1).table.dispatchEvent(new Event('meo-table-column-width-projected'));
      scheduler.flush();
      const projectedWidth = elements(1).stickyTable.style.width;
      const focusAndSelectionPreserved = (
        document.activeElement === sourceInput &&
        sourceInput.selectionStart === 2 &&
        sourceInput.selectionEnd === 7
      );

      let otherLayoutRuns = 0;
      const other = scheduler.register(() => { otherLayoutRuns += 1; });
      other.request();
      adapter1.invalidate();
      scheduler.flush();

      elements(1).shell.style.display = 'none';
      adapter1.invalidate();
      scheduler.flush();
      const hiddenWithOuterMode = !elements(1).stickyChrome.classList.contains('is-visible');
      elements(1).shell.style.display = '';
      const oldTable = elements(1).table;
      oldTable.replaceWith(oldTable.cloneNode(true));
      adapter1.update();
      await new Promise((resolve) => setTimeout(resolve, 0));
      scheduler.flush();
      const visibleAfterRebuild = elements(1).stickyChrome.classList.contains('is-visible');

      const styleBeforeUnmount = elements(1).stickyTable.style.width;
      adapter1.unmount();
      elements(1).table.style.width = '440px';
      elements(1).scroller.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
      scheduler.flush();
      const styleAfterUnmount = elements(1).stickyTable.style.width;
      const hiddenAfterUnmount = !elements(1).stickyChrome.classList.contains('is-visible');

      other.request();
      adapter1.dispose();
      scheduler.flush();
      const otherSurvivedDispose = otherLayoutRuns === 2;
      const registrationsAfterFirstDispose = scheduler.records.size;
      adapter2.dispose();
      other.dispose();

      return {
        adapterInstances: 2,
        legacyInstances: 0,
        initialTasks,
        reentryPending,
        initiallyHidden,
        passive,
        stormFrames,
        stormTasks,
        visible,
        transform,
        visibleHeight,
        controls,
        updatedHeader,
        projectedWidth,
        focusAndSelectionPreserved,
        hiddenWithOuterMode,
        visibleAfterRebuild,
        styleBeforeUnmount,
        styleAfterUnmount,
        hiddenAfterUnmount,
        otherSurvivedDispose,
        registrationsAfterFirstDispose,
        sourceUnchanged: elements(1).table.textContent?.replace('Updated header', 'Header 1') === sourceText,
        scrollUnchangedByProjection: elements(1).scroller.scrollTop === 90 && initialScroll === 0,
        internalRafCalls: 0
      };
    });

    assert.equal(result.adapterInstances, 2);
    assert.equal(result.legacyInstances, 0);
    assert.equal(result.initialTasks, 2);
    assert.equal(result.reentryPending, 1, 'invalidation during refresh must schedule the next shared tick');
    assert.equal(result.initiallyHidden, true);
    assert.deepEqual(result.passive, {
      ariaHidden: 'true', pointerEvents: 'none', inputs: 0, href: null, toolbarButtons: 1
    });
    assert.equal(result.stormFrames, 1, 'multiple adapters and event storms share one scheduled tick');
    assert.equal(result.stormTasks, 2);
    assert.equal(result.visible, true);
    assert.equal(result.transform, 'translateX(-45px)');
    assert.equal(result.controls.className, true);
    assert.equal(Number.parseFloat(result.controls.height) - result.visibleHeight, 24);
    assert.match(result.updatedHeader ?? '', /Updated header/);
    assert.equal(result.projectedWidth, '480px');
    assert.equal(result.focusAndSelectionPreserved, true);
    assert.equal(result.hiddenWithOuterMode, true);
    assert.equal(result.visibleAfterRebuild, true);
    assert.equal(result.styleAfterUnmount, result.styleBeforeUnmount);
    assert.equal(result.hiddenAfterUnmount, true);
    assert.equal(result.otherSurvivedDispose, true);
    assert.equal(result.registrationsAfterFirstDispose, 2, 'disposing sticky removes only its own registration');
    assert.equal(result.sourceUnchanged, true);
    assert.equal(result.scrollUnchangedByProjection, true);
    assert.equal(result.internalRafCalls, 0);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table sticky header adapter Chromium candidate trace passed');
