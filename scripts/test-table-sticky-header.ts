import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-sticky-header-'));

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
    await page.setViewport({ width: 960, height: 360 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: `
      :root {
        --meo-background: #202223;
        --meo-inset-background: #2a2d2f;
        --meo-foreground: #e6edf3;
        --meo-semantic-tableBorder: #474b50;
      }
      html, body, #app { height: 100%; margin: 0; }
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const waitFrames = async (count = 4) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const create = async (text: string) => {
        app.replaceChildren();
        const editor = harness.createEditor({
          parent: app,
          text,
          initialMode: 'live',
          onApplyChanges() {}
        });
        await waitFrames();
        return editor;
      };
      const scrollPastHeader = async (editor: any) => {
        const scroller = editor.view.scrollDOM as HTMLElement;
        const header = document.querySelector<HTMLElement>('.meo-md-html-table thead')!;
        const delta = header.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top + 8;
        scroller.scrollTop += Math.max(1, delta);
        scroller.dispatchEvent(new Event('scroll'));
        await waitFrames();
      };

      const longRows = Array.from({ length: 28 }, (_, index) => `| ${index + 1} | row ${index + 1} |`);
      const beforeLongTable = Array.from({ length: 6 }, (_, index) => `before long table ${index + 1}`);
      const afterLongTable = Array.from({ length: 24 }, (_, index) => `after long table ${index + 1}`);
      const longEditor = await create([
        ...beforeLongTable,
        '',
        '| 编号 | 内容 |',
        '| ---: | :--- |',
        ...longRows,
        '',
        ...afterLongTable
      ].join('\n'));
      const longChrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
      const longInitiallyHidden = !longChrome || getComputedStyle(longChrome).display === 'none';
      await scrollPastHeader(longEditor);
      const scrollerRect = longEditor.view.scrollDOM.getBoundingClientRect();
      const visibleChrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
      const visibleHeader = visibleChrome?.querySelector<HTMLElement>('.meo-md-html-table-sticky-header');
      const originalHeaderCells = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table thead th'));
      const stickyHeaderCells = Array.from(visibleHeader?.querySelectorAll<HTMLElement>('th') ?? []);
      const visibleHeaderRect = visibleHeader?.getBoundingClientRect();
      const separatorStyle = visibleChrome ? getComputedStyle(visibleChrome, '::after') : null;
      const hitElement = visibleHeaderRect
        ? document.elementFromPoint(visibleHeaderRect.left + 4, visibleHeaderRect.top + visibleHeaderRect.height / 2)
        : null;
      const passiveState = {
        initiallyHidden: longInitiallyHidden,
        visible: Boolean(visibleChrome && getComputedStyle(visibleChrome).display !== 'none'),
        top: visibleChrome?.getBoundingClientRect().top ?? null,
        scrollerTop: scrollerRect.top,
        text: stickyHeaderCells.map((cell) => cell.textContent?.trim() ?? ''),
        interactiveCount: visibleChrome?.querySelectorAll('textarea, input, select, button, a[href]').length ?? -1,
        cursor: visibleHeader ? getComputedStyle(visibleHeader).cursor : '',
        hitCursor: hitElement ? getComputedStyle(hitElement).cursor : '',
        hitElement: hitElement instanceof Element ? `${hitElement.tagName}.${hitElement.className}` : '',
        shadow: visibleHeader ? getComputedStyle(visibleHeader).boxShadow : '',
        separatorHeight: separatorStyle ? Number.parseFloat(separatorStyle.height) : 0,
        separatorColor: separatorStyle?.backgroundColor ?? '',
        separatorSpace: visibleChrome && visibleHeader
          ? visibleChrome.getBoundingClientRect().height - visibleHeader.getBoundingClientRect().height
          : 0,
        widthDeltas: stickyHeaderCells.map((cell, index) => (
          Math.abs(cell.getBoundingClientRect().width - originalHeaderCells[index].getBoundingClientRect().width)
        ))
      };
      app.style.width = '720px';
      window.dispatchEvent(new Event('resize'));
      await waitFrames();
      const resizedOriginalCells = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table thead th'));
      const resizedStickyCells = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-sticky-header th'));
      const resizedChrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
      const resizeState = {
        visible: Boolean(resizedChrome && getComputedStyle(resizedChrome).display !== 'none'),
        widthDeltas: resizedStickyCells.map((cell, index) => (
          Math.abs(cell.getBoundingClientRect().width - resizedOriginalCells[index].getBoundingClientRect().width)
        )),
        withinEditor: (resizedChrome?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY) <= app.getBoundingClientRect().right + 1
      };
      app.style.removeProperty('width');
      window.dispatchEvent(new Event('resize'));
      await waitFrames();

      const bodyInput = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      bodyInput.focus({ preventScroll: true });
      await waitFrames();
      const activeChrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
      const toolbarBand = activeChrome?.querySelector<HTMLElement>('.meo-md-html-table-sticky-toolbar-band');
      const stickyHeader = activeChrome?.querySelector<HTMLElement>('.meo-md-html-table-sticky-header');
      const toolbar = document.querySelector<HTMLElement>('.meo-md-html-table-toolbar')!;
      const activeState = {
        hasToolbarBand: activeChrome?.classList.contains('has-sticky-controls') ?? false,
        bandHeight: toolbarBand?.getBoundingClientRect().height ?? 0,
        bandBackground: toolbarBand ? getComputedStyle(toolbarBand).backgroundColor : '',
        documentBackground: getComputedStyle(document.documentElement).getPropertyValue('--meo-background').trim(),
        toolbarTop: toolbar.getBoundingClientRect().top,
        chromeTop: activeChrome?.getBoundingClientRect().top ?? null,
        headerTop: stickyHeader?.getBoundingClientRect().top ?? null,
        bandWidth: toolbarBand?.getBoundingClientRect().width ?? 0,
        chromeWidth: activeChrome?.getBoundingClientRect().width ?? 0
      };
      bodyInput.blur();
      await waitFrames();
      const inactiveChrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
      const inactiveHeader = inactiveChrome?.querySelector<HTMLElement>('.meo-md-html-table-sticky-header');
      const inactiveState = {
        hasToolbarBand: inactiveChrome?.classList.contains('has-sticky-controls') ?? true,
        chromeTop: inactiveChrome?.getBoundingClientRect().top ?? null,
        headerTop: inactiveHeader?.getBoundingClientRect().top ?? null
      };
      const headerInput = document.querySelector<HTMLTextAreaElement>('thead textarea[data-table-col="0"]')!;
      headerInput.value = '新编号';
      headerInput.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFrames();
      const syncedHeaderText = document.querySelector<HTMLElement>(
        '.meo-md-html-table-sticky-header th:first-child'
      )?.textContent?.trim() ?? '';
      const longScroller = longEditor.view.scrollDOM as HTMLElement;
      longScroller.scrollTop = longScroller.scrollHeight - longScroller.clientHeight;
      longScroller.dispatchEvent(new Event('scroll'));
      await waitFrames();
      const hiddenAtTableEnd = getComputedStyle(activeChrome!).display === 'none';
      longEditor.destroy();

      const trailingLines = Array.from({ length: 40 }, (_, index) => `after ${index}`).join('\n');
      const shortEditor = await create([
        '| A | B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '| 3 | 4 |',
        '',
        trailingLines
      ].join('\n'));
      await scrollPastHeader(shortEditor);
      const shortChrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
      const shortState = {
        visible: Boolean(shortChrome && getComputedStyle(shortChrome).display !== 'none')
      };
      shortEditor.destroy();

      const fittingRows = Array.from({ length: 7 }, (_, index) => `| ${index + 1} | fitting row ${index + 1} |`);
      const fittingEditor = await create([
        '| Fit A | Fit B |',
        '| --- | --- |',
        ...fittingRows,
        '',
        trailingLines
      ].join('\n'));
      const fittingTable = document.querySelector<HTMLElement>('.meo-md-html-table')!;
      const fittingScroller = fittingEditor.view.scrollDOM as HTMLElement;
      const fittingTableFitsViewport = fittingTable.getBoundingClientRect().height <= fittingScroller.getBoundingClientRect().height;
      await scrollPastHeader(fittingEditor);
      const fittingChrome = document.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
      const fittingState = {
        fitsViewport: fittingTableFitsViewport,
        visible: Boolean(fittingChrome && getComputedStyle(fittingChrome).display !== 'none')
      };
      fittingEditor.destroy();

      const spacerLines = Array.from({ length: 18 }, (_, index) => `between tables ${index + 1}`);
      const multiEditor = await create([
        '| Short A | Short B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
        ...spacerLines,
        '',
        '| Long A | Long B |',
        '| --- | --- |',
        ...longRows,
        '',
        ...afterLongTable
      ].join('\n'));
      const tableShells = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell'));
      const secondHeader = tableShells[1]?.querySelector<HTMLElement>('thead');
      const multiScroller = multiEditor.view.scrollDOM as HTMLElement;
      if (secondHeader) {
        multiScroller.scrollTop += Math.max(
          1,
          secondHeader.getBoundingClientRect().bottom - multiScroller.getBoundingClientRect().top + 8
        );
        multiScroller.dispatchEvent(new Event('scroll'));
        await waitFrames();
      }
      const multiState = tableShells.map((shell) => {
        const chrome = shell.querySelector<HTMLElement>('.meo-md-html-table-sticky-chrome');
        return Boolean(chrome && getComputedStyle(chrome).display !== 'none');
      });
      multiEditor.destroy();

      return {
        passiveState,
        resizeState,
        activeState,
        inactiveState,
        syncedHeaderText,
        hiddenAtTableEnd,
        shortState,
        fittingState,
        multiState
      };
    });

    const failures: string[] = [];
    if (
      !result.passiveState.initiallyHidden ||
      !result.passiveState.visible ||
      result.passiveState.top === null ||
      Math.abs(result.passiveState.top - result.passiveState.scrollerTop) > 1 ||
      JSON.stringify(result.passiveState.text) !== JSON.stringify(['编号', '内容']) ||
      result.passiveState.interactiveCount !== 0 ||
      result.passiveState.cursor !== 'default' ||
      result.passiveState.hitCursor !== 'default' ||
      result.passiveState.shadow !== 'none' ||
      Math.abs(result.passiveState.separatorHeight - 1) > 0.5 ||
      result.passiveState.separatorColor === 'rgba(0, 0, 0, 0)' ||
      result.passiveState.separatorSpace < 3.5 ||
      result.passiveState.widthDeltas.some((delta: number) => delta > 1)
    ) {
      failures.push(`long table sticky header was incorrect: ${JSON.stringify(result.passiveState)}`);
    }
    if (
      !result.resizeState.visible ||
      !result.resizeState.withinEditor ||
      result.resizeState.widthDeltas.some((delta: number) => delta > 1)
    ) {
      failures.push(`sticky header did not track editor resize: ${JSON.stringify(result.resizeState)}`);
    }
    if (
      !result.activeState.hasToolbarBand ||
      result.activeState.chromeTop === null ||
      Math.abs(result.activeState.bandHeight - 21) > 1 ||
      result.activeState.bandBackground !== 'rgb(32, 34, 35)' ||
      Math.abs(result.activeState.toolbarTop - result.activeState.chromeTop) > 1 ||
      result.activeState.headerTop === null ||
      Math.abs(result.activeState.headerTop - result.activeState.chromeTop - 21) > 1 ||
      Math.abs(result.activeState.bandWidth - result.activeState.chromeWidth) > 1
    ) {
      failures.push(`sticky toolbar stack was incorrect: ${JSON.stringify(result.activeState)}`);
    }
    if (
      result.inactiveState.hasToolbarBand ||
      result.inactiveState.chromeTop === null ||
      result.inactiveState.headerTop === null ||
      Math.abs(result.inactiveState.headerTop - result.inactiveState.chromeTop) > 1
    ) {
      failures.push(`sticky toolbar band did not clear after blur: ${JSON.stringify(result.inactiveState)}`);
    }
    if (result.syncedHeaderText !== '新编号') failures.push(`sticky header content stayed ${JSON.stringify(result.syncedHeaderText)}`);
    if (!result.hiddenAtTableEnd) failures.push('sticky header remained visible after the table body ended');
    if (result.shortState.visible) failures.push('short table unexpectedly enabled its sticky header');
    if (!result.fittingState.fitsViewport || !result.fittingState.visible) {
      failures.push(`viewport-fitting long table did not enable its sticky header: ${JSON.stringify(result.fittingState)}`);
    }
    if (JSON.stringify(result.multiState) !== JSON.stringify([false, true])) {
      failures.push(`multiple table sticky headers were not isolated: ${JSON.stringify(result.multiState)}`);
    }
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('table sticky header checks passed');
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
