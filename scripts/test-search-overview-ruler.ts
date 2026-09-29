import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-search-overview-'));

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 420 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: `
      :root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-inset-background:#2a2d2f; }
      html, body, #app { height: 100%; margin: 0; }
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const waitFrames = async (count = 6) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const before = Array.from({ length: 18 }, (_, index) => `before ${index + 1}`);
      const wrappedCell = '这是一段需要换行的长内容，包含中文、 English words and numbers 12345。'.repeat(8);
      const rows = Array.from({ length: 24 }, (_, index) => (
        `| ${index + 1} | ${index === 18 ? 'overview-needle ' : ''}${wrappedCell} |`
      ));
      const after = Array.from({ length: 36 }, (_, index) => `after ${index + 1}`);
      const selectionStates: Array<{ visible?: boolean }> = [];
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: [...before, '', '| A | B |', '| --- | --- |', ...rows, '', ...after].join('\n'),
        initialMode: 'live',
        onApplyChanges() {},
        onSelectionChange(state: { visible?: boolean }) {
          selectionStates.push(state);
        }
      });
      editor.setTableStickyHeaderEnabled(true);
      await waitFrames();

      const tableRows = Array.from(document.querySelectorAll<HTMLTableRowElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody tr'
      ));
      tableRows[3].style.height = '220px';
      window.dispatchEvent(new Event('resize'));
      await waitFrames();
      editor.setSearchQuery('overview-needle');
      await waitFrames();
      editor.findNext('overview-needle', { focusEditor: false });
      await waitFrames();

      const matchedRow = tableRows[18];
      const scroller = editor.view.scrollDOM as HTMLElement;
      const ruler = document.querySelector<HTMLElement>('.meo-search-overview-ruler')!;
      const marker = ruler.querySelector<HTMLElement>('.meo-search-overview-ruler-marker')!;
      const activeMatch = document.querySelector<HTMLElement>('.meo-md-html-table .meo-search-match-active');
      const scrollRect = scroller.getBoundingClientRect();
      const rowRect = matchedRow.getBoundingClientRect();
      const activeRect = activeMatch?.getBoundingClientRect();
      const stickyChrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible');
      const stickyRect = stickyChrome?.getBoundingClientRect();
      const safeTop = Math.max(scrollRect.top, stickyRect?.bottom ?? scrollRect.top);
      const safeCenter = (safeTop + scrollRect.bottom) / 2;
      const rowTop = scroller.scrollTop + rowRect.top - scrollRect.top;
      const expectedTop = Math.round((rowTop / scroller.scrollHeight) * ruler.clientHeight);
      const actualTop = Number.parseFloat(marker.style.top);
      const state = {
        expectedTop,
        actualTop,
        delta: Math.abs(expectedTop - actualTop),
        scrollHeight: scroller.scrollHeight,
        trackHeight: ruler.clientHeight,
        activeMatchVisible: Boolean(activeRect && activeRect.top >= scrollRect.top && activeRect.bottom <= scrollRect.bottom),
        activeMatchClearsHeader: Boolean(activeRect && activeRect.top >= safeTop),
        activeMatchCenterDelta: activeRect ? Math.abs((activeRect.top + activeRect.bottom) / 2 - safeCenter) : null,
        stickyHeaderVisible: Boolean(stickyRect),
        coveredMatchWasRevealed: false,
        distantTableMatchCentered: false,
        distantTableInitiallyUnmounted: false,
        focusedMatchVisible: false,
        hasSearchSelection: editor.view.dom.classList.contains('has-search-selection'),
        selectionMenuVisible: selectionStates.at(-1)?.visible ?? null
      };
      editor.findNext('overview-needle');
      await waitFrames();
      const focusedMatchRect = document.querySelector<HTMLElement>(
        '.meo-md-html-table .meo-search-match-active'
      )?.getBoundingClientRect();
      state.focusedMatchVisible = Boolean(focusedMatchRect
        && focusedMatchRect.top >= scrollRect.top && focusedMatchRect.bottom <= scrollRect.bottom);
      if (focusedMatchRect && stickyRect) {
        scroller.scrollTop += focusedMatchRect.top - (safeTop - 4);
        await waitFrames();
        const coveredRect = document.querySelector<HTMLElement>(
          '.meo-md-html-table .meo-search-match-active'
        )?.getBoundingClientRect();
        const currentHeader = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible')
          ?.getBoundingClientRect();
        if (coveredRect && currentHeader && coveredRect.top < currentHeader.bottom) {
          editor.findNext('overview-needle', { focusEditor: false });
          await waitFrames();
          const revealedRect = document.querySelector<HTMLElement>(
            '.meo-md-html-table .meo-search-match-active'
          )?.getBoundingClientRect();
          const revealedHeader = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome.is-visible')
            ?.getBoundingClientRect();
          state.coveredMatchWasRevealed = Boolean(revealedRect && revealedHeader
            && revealedRect.top >= revealedHeader.bottom
            && Math.abs((revealedRect.top + revealedRect.bottom - revealedHeader.bottom - scrollRect.bottom) / 2) <= 24);
        }
      }
      editor.destroy();
      document.getElementById('app')!.replaceChildren();
      const distantEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: [
          ...Array.from({ length: 120 }, (_, index) => `distant before ${index + 1}`),
          '', '| A | B |', '| --- | --- |', ...rows,
          ...Array.from({ length: 40 }, (_, index) => `distant after ${index + 1}`)
        ].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      distantEditor.setTableStickyHeaderEnabled(true);
      await waitFrames();
      state.distantTableInitiallyUnmounted = !distantEditor.view.dom.querySelector('.meo-md-html-table');
      distantEditor.setSearchQuery('overview-needle');
      distantEditor.findNext('overview-needle', { focusEditor: false });
      await waitFrames(30);
      const distantScroller = distantEditor.view.scrollDOM as HTMLElement;
      const distantMatch = distantEditor.view.dom.querySelector<HTMLElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) .meo-search-match-active'
      )?.getBoundingClientRect();
      const distantViewport = distantScroller.getBoundingClientRect();
      const distantHeader = distantEditor.view.dom.querySelector<HTMLElement>(
        '.meo-md-html-table-sticky-chrome.is-visible'
      )?.getBoundingClientRect();
      state.distantTableMatchCentered = Boolean(distantMatch
        && distantScroller.scrollTop > 0
        && Math.abs((distantMatch.top + distantMatch.bottom
          - Math.max(distantViewport.top, distantHeader?.bottom ?? distantViewport.top)
          - distantViewport.bottom) / 2) <= 24);
      distantEditor.destroy();
      return state;
    });

    if (result.delta > 2) {
      throw new Error(`Search overview marker did not follow rendered row geometry: ${JSON.stringify(result)}`);
    }
    if (!result.activeMatchVisible) {
      throw new Error(`Active search match remained outside the editor viewport: ${JSON.stringify(result)}`);
    }
    if (!result.stickyHeaderVisible || !result.activeMatchClearsHeader || result.activeMatchCenterDelta === null || result.activeMatchCenterDelta > 24) {
      throw new Error(`Active table search match was not centered in the unobscured viewport: ${JSON.stringify(result)}`);
    }
    if (!result.focusedMatchVisible) {
      throw new Error(`Focused search match remained outside the editor viewport: ${JSON.stringify(result)}`);
    }
    if (!result.coveredMatchWasRevealed) {
      throw new Error(`A table match hidden under the sticky header was not centered: ${JSON.stringify(result)}`);
    }
    if (!result.distantTableInitiallyUnmounted || !result.distantTableMatchCentered) {
      throw new Error(`A search match inside an initially unmounted table was not centered: ${JSON.stringify(result)}`);
    }
    if (!result.hasSearchSelection || result.selectionMenuVisible !== false) {
      throw new Error(`Active search selection was not classified without opening the selection menu: ${JSON.stringify(result)}`);
    }
    console.log('search overview ruler checks passed');
  } finally {
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
