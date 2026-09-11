import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-layout-stability-'));
const tableWrapFixture = ' wrapping table cell content'.repeat(8);

type EndCaretObservation = {
  isActive: boolean;
  selectionEnd: number | null;
  valueLength: number;
  inputBottom: number;
  cellBottom: number;
  scrollerBottom: number;
};

const GEOMETRY_EPSILON = 1;

function hasCompleteAppendedInput(value: string, initialLength: number): boolean {
  return value.length === initialLength + tableWrapFixture.length && value.endsWith(tableWrapFixture);
}

function hasVisibleEndCaret(observation: EndCaretObservation): boolean {
  return observation.isActive && observation.selectionEnd === observation.valueLength &&
    observation.inputBottom <= observation.scrollerBottom + GEOMETRY_EPSILON &&
    observation.cellBottom <= observation.scrollerBottom + GEOMETRY_EPSILON;
}

async function waitForFrames(page: Page, count = 10): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-live-layout-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-mutedForeground:#8b949e; --meo-semantic-tableBorder:#3e444d; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:monospace; --meo-font-source-weight:400; --meo-font-source-size:14px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const tableSource = [
      ...Array.from({ length: 80 }, (_, index) => `before table ${index + 1}`),
      '| Name | Description |',
      '| --- | --- |',
      `| Alpha | ${'long table content '.repeat(8)} |`,
      '| Beta | Short |',
      ...Array.from({ length: 60 }, (_, index) => `table anchor ${index + 1}`)
    ].join('\n');
    const tableWrapCounterexample = process.argv.find((argument) => (
      argument.startsWith('--table-wrap-counterexample=')
    ))?.split('=')[1] ?? null;
    const tableStableVisibleOnly = process.argv.includes('--table-stable-visible');
    const tableWrapOnly = process.argv.includes('--table-wrap')
      || tableStableVisibleOnly
      || tableWrapCounterexample !== null;
    if (tableWrapOnly) {
      await page.evaluate(() => {
        (window as any).__editor = (window as any).LiveLayoutStabilityHarness.createEditor({
          parent: document.getElementById('app')!,
          text: '',
          initialMode: 'live',
          onApplyChanges() {}
        });
      });
    } else {
      const source = [
      ...Array.from({ length: 80 }, (_, index) => `before ${index + 1}`),
      '<details>',
      '<summary>Visible summary</summary>',
      ...Array.from({ length: 6 }, (_, index) => index === 0
        ? 'details body 1 with **source markers**'
        : `details body ${index + 1}`),
      '</details>',
      ...Array.from({ length: 60 }, (_, index) => `stable anchor ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__editor = (window as any).LiveLayoutStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, source);
    await waitForFrames(page);
    await page.evaluate(() => (window as any).__editor.scrollToLine(82, 'top'));
    await waitForFrames(page);
    await page.evaluate(() => (window as any).__editor.view.dispatch({ selection: { anchor: 0 } }));
    await waitForFrames(page);

    const defaultCollapsedSourceState = await page.evaluate(() => {
      const editor = (window as any).__editor;
      document.querySelector<HTMLButtonElement>('.meo-md-html-source-toggle')!.click();
      return (window as any).LiveLayoutStabilityHarness.getDetailsBlocks(editor.view.state)[0];
    });
    await waitForFrames(page);
    const defaultCollapsedSourceDom = await page.evaluate(() => ({
      bodyVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .some((line) => line.textContent?.includes('details body 1')),
      sourceVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .some((line) => line.textContent?.includes('<details>'))
    }));
    if (
      defaultCollapsedSourceState?.collapsed !== true ||
      !defaultCollapsedSourceDom.sourceVisible || !defaultCollapsedSourceDom.bodyVisible
    ) {
      throw new Error(`Default-collapsed details changed state when revealing source: ${JSON.stringify({
        defaultCollapsedSourceState,
        defaultCollapsedSourceDom
      })}`);
    }
    await page.evaluate(() => (window as any).__editor.view.dispatch({ selection: { anchor: 0 } }));
    await waitForFrames(page);

    const detailsToggleClickPoint = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const summaryLine = document.querySelector<HTMLElement>('.meo-md-html-block summary')!;
      const scrollerTop = scroller.getBoundingClientRect().top;
      scroller.scrollTop += summaryLine.getBoundingClientRect().top - scrollerTop - 8;
      const summaryRect = summaryLine.getBoundingClientRect();
      (window as any).__detailsAnchorFrames = [{
        rawSourceVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent?.includes('<details>')),
        summaryTop: summaryLine.getBoundingClientRect().top
      }];
      const sampleAnchor = () => {
        const currentSummary = document.querySelector<HTMLElement>('.meo-md-html-block summary');
        (window as any).__detailsAnchorFrames.push({
          rawSourceVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
            .some((line) => line.textContent?.includes('<details>')),
          summaryTop: currentSummary?.getBoundingClientRect().top ?? null
        });
        if ((window as any).__detailsAnchorFrames.length < 14) requestAnimationFrame(sampleAnchor);
      };
      requestAnimationFrame(sampleAnchor);
      return {
        x: summaryRect.left + Math.min(80, summaryRect.width / 2),
        y: summaryRect.top + summaryRect.height / 2
      };
    });
    await page.mouse.click(detailsToggleClickPoint.x, detailsToggleClickPoint.y);
    await waitForFrames(page, 16);
    const detailsAnchorFrames = await page.evaluate(() => (window as any).__detailsAnchorFrames as Array<{
      rawSourceVisible: boolean;
      summaryTop: number | null;
    }>);
    const detailsSummaryBeforeTop = detailsAnchorFrames[0].summaryTop;
    if (
      detailsSummaryBeforeTop === null ||
      detailsAnchorFrames.some((frame) => (
        frame.summaryTop === null || Math.abs(frame.summaryTop - detailsSummaryBeforeTop) > 1 ||
        frame.rawSourceVisible
      ))
    ) {
      throw new Error(`Details toggle redrew or moved content across frames: ${JSON.stringify(detailsAnchorFrames)}`);
    }
    const detailsAfterExpand = await page.evaluate(() => {
      const editor = (window as any).__editor;
      return (window as any).LiveLayoutStabilityHarness.getDetailsBlocks(editor.view.state)[0];
    });
    if (detailsAfterExpand?.collapsed !== false) {
      throw new Error(`Details click did not expand the block: ${JSON.stringify(detailsAfterExpand)}`);
    }

    const detailsCollapseClickPoint = await page.evaluate(() => {
      const summaryLine = document.querySelector<HTMLElement>('.meo-md-html-block summary')!;
      const summaryRect = summaryLine.getBoundingClientRect();
      (window as any).__detailsCollapseFrames = [{ summaryTop: summaryRect.top }];
      const sampleAnchor = () => {
        const currentSummary = document.querySelector<HTMLElement>('.meo-md-html-block summary');
        (window as any).__detailsCollapseFrames.push({
          summaryTop: currentSummary?.getBoundingClientRect().top ?? null
        });
        if ((window as any).__detailsCollapseFrames.length < 14) requestAnimationFrame(sampleAnchor);
      };
      requestAnimationFrame(sampleAnchor);
      return {
        x: summaryRect.left + Math.min(80, summaryRect.width / 2),
        y: summaryRect.top + summaryRect.height / 2
      };
    });
    await page.mouse.click(detailsCollapseClickPoint.x, detailsCollapseClickPoint.y);
    await waitForFrames(page, 16);
    const detailsCollapseFrames = await page.evaluate(() => (window as any).__detailsCollapseFrames as Array<{
      summaryTop: number | null;
    }>);
    const detailsCollapseSummaryBeforeTop = detailsCollapseFrames[0].summaryTop;
    if (
      detailsCollapseSummaryBeforeTop === null ||
      detailsCollapseFrames.some((frame) => (
        frame.summaryTop === null || Math.abs(frame.summaryTop - detailsCollapseSummaryBeforeTop) > 1
      ))
    ) {
      throw new Error(`Details collapse moved its summary across frames: ${JSON.stringify(detailsCollapseFrames)}`);
    }
    const detailsAfterCollapse = await page.evaluate(() => {
      const editor = (window as any).__editor;
      return (window as any).LiveLayoutStabilityHarness.getDetailsBlocks(editor.view.state)[0];
    });
    if (detailsAfterCollapse?.collapsed !== true) {
      throw new Error(`Details click did not collapse the block: ${JSON.stringify(detailsAfterCollapse)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const anchor = editor.getText().indexOf('<details>');
      (window as any).LiveLayoutStabilityHarness.toggleDetailsBlock(editor.view, anchor);
    });
    await waitForFrames(page);
    const detailsExpandedState = await page.evaluate(() => {
      const editor = (window as any).__editor;
      return (window as any).LiveLayoutStabilityHarness.getDetailsBlocks(editor.view.state)[0];
    });
    if (detailsExpandedState?.collapsed !== false) {
      throw new Error(`Details did not expand before source-mode check: ${JSON.stringify(detailsExpandedState)}`);
    }
    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const summaryLine = document.querySelector<HTMLElement>('.meo-md-html-block summary')!;
      const scrollerTop = scroller.getBoundingClientRect().top;
      scroller.scrollTop += summaryLine.getBoundingClientRect().top - scrollerTop - 8;
    });
    await waitForFrames(page);
    const detailsSourceAnchor = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const anchor = editor.getText().indexOf('<details>');
      document.querySelector<HTMLButtonElement>('.meo-md-html-source-toggle')!.click();
      return anchor;
    });
    await waitForFrames(page);
    const sourceToggleResult = await page.evaluate((anchor) => {
      const editor = (window as any).__editor;
      const sourceVisible = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .some((line) => line.textContent?.includes('**source markers**'));
      const toggled = (window as any).LiveLayoutStabilityHarness.toggleDetailsBlock(editor.view, anchor);
      return { sourceVisible, toggled };
    }, detailsSourceAnchor);
    await waitForFrames(page);
    const detailsAfterSourceCollapse = await page.evaluate(() => {
      const editor = (window as any).__editor;
      return {
        bodyVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent?.includes('details body 1')),
        details: (window as any).LiveLayoutStabilityHarness.getDetailsBlocks(editor.view.state)[0],
        selectionHead: editor.view.state.selection.main.head
      };
    });
    if (
      !sourceToggleResult.sourceVisible || !sourceToggleResult.toggled ||
      detailsAfterSourceCollapse.details?.collapsed !== true || !detailsAfterSourceCollapse.bodyVisible ||
      detailsAfterSourceCollapse.selectionHead !== detailsAfterSourceCollapse.details?.lineFrom
    ) {
      throw new Error(`Details source mode must allow folding without reopening: ${JSON.stringify({
        ...sourceToggleResult,
        ...detailsAfterSourceCollapse
      })}`);
    }

    const sourceExpandResult = await page.evaluate((anchor) => {
      const editor = (window as any).__editor;
      return (window as any).LiveLayoutStabilityHarness.toggleDetailsBlock(editor.view, anchor);
    }, detailsSourceAnchor);
    await waitForFrames(page);
    const detailsAfterSourceExpand = await page.evaluate(() => {
      const editor = (window as any).__editor;
      return (window as any).LiveLayoutStabilityHarness.getDetailsBlocks(editor.view.state)[0];
    });
    if (!sourceExpandResult || detailsAfterSourceExpand?.collapsed !== false) {
      throw new Error(`Default-collapsed details source mode must allow re-expanding: ${JSON.stringify({
        sourceExpandResult,
        detailsAfterSourceExpand
      })}`);
    }
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.meo-md-html-preview-toggle')?.click();
    });
    await waitForFrames(page);

    const defaultOpenSource = [
      ...Array.from({ length: 20 }, (_, index) => `before open ${index + 1}`),
      '<details open>',
      '<summary>Default open summary</summary>',
      'default open body with **source markers**',
      '</details>',
      ...Array.from({ length: 20 }, (_, index) => `after open ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      const editor = (window as any).__editor;
      editor.setText(text);
      editor.view.dispatch({ selection: { anchor: 0 } });
      editor.scrollToLine(20, 'top');
    }, defaultOpenSource);
    await waitForFrames(page);
    const defaultOpenSourceAnchor = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const button = document.querySelector<HTMLButtonElement>('.meo-md-html-source-toggle');
      button!.click();
      return editor.getText().indexOf('<details open>');
    });
    await waitForFrames(page);
    const defaultOpenBeforeToggle = await page.evaluate(() => {
      const editor = (window as any).__editor;
      return {
        details: (window as any).LiveLayoutStabilityHarness.getDetailsBlocks(editor.view.state)[0],
        sourceVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent?.includes('**source markers**'))
      };
    });
    if (defaultOpenBeforeToggle.details?.collapsed !== false || !defaultOpenBeforeToggle.sourceVisible) {
      throw new Error(`Default-open details changed state when revealing source: ${JSON.stringify(defaultOpenBeforeToggle)}`);
    }
    const defaultOpenCollapseResult = await page.evaluate((anchor) => {
      const editor = (window as any).__editor;
      return (window as any).LiveLayoutStabilityHarness.toggleDetailsBlock(editor.view, anchor);
    }, defaultOpenSourceAnchor);
    await waitForFrames(page);
    const defaultOpenAfterCollapse = await page.evaluate(() => {
      const editor = (window as any).__editor;
      return {
        bodyVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent?.includes('default open body')),
        details: (window as any).LiveLayoutStabilityHarness.getDetailsBlocks(editor.view.state)[0],
        selectionHead: editor.view.state.selection.main.head
      };
    });
    if (
      !defaultOpenCollapseResult || defaultOpenAfterCollapse.details?.collapsed !== true ||
      !defaultOpenAfterCollapse.bodyVisible ||
      defaultOpenAfterCollapse.selectionHead !== defaultOpenAfterCollapse.details?.lineFrom
    ) {
      throw new Error(`Default-open details source mode must allow folding: ${JSON.stringify({
        defaultOpenCollapseResult,
        defaultOpenAfterCollapse
      })}`);
    }
    const defaultOpenExpandResult = await page.evaluate((anchor) => {
      const editor = (window as any).__editor;
      return (window as any).LiveLayoutStabilityHarness.toggleDetailsBlock(editor.view, anchor);
    }, defaultOpenSourceAnchor);
    await waitForFrames(page);
    const defaultOpenAfterExpand = await page.evaluate(() => {
      const editor = (window as any).__editor;
      return (window as any).LiveLayoutStabilityHarness.getDetailsBlocks(editor.view.state)[0];
    });
    if (!defaultOpenExpandResult || defaultOpenAfterExpand?.collapsed !== false) {
      throw new Error(`Default-open details source mode must allow re-expanding: ${JSON.stringify({
        defaultOpenExpandResult,
        defaultOpenAfterExpand
      })}`);
    }

    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.meo-md-html-preview-toggle')?.click();
    });
    const hybridDetailsSource = [
      ...Array.from({ length: 20 }, (_, index) => `before hybrid ${index + 1}`),
      '<details>',
      '<summary>Hybrid Markdown summary</summary>',
      '',
      'Hybrid body with **bold text**.',
      '',
      '- hybrid markdown list item',
      '',
      '</details>',
      ...Array.from({ length: 20 }, (_, index) => `after hybrid ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      const editor = (window as any).__editor;
      editor.setText(text);
      editor.view.dispatch({ selection: { anchor: 0 } });
      const anchor = editor.getText().indexOf('<details>');
      editor.view.scrollDOM.scrollTop = Math.max(0, editor.view.lineBlockAt(anchor).top - 80);
    }, hybridDetailsSource);
    await waitForFrames(page, 8);
    const hybridPreview = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const anchor = editor.getText().indexOf('<details>');
      const summary = document.querySelector<HTMLElement>('.meo-md-details-summary');
      const summaryIcon = summary?.querySelector<HTMLElement>('.meo-md-details-summary-icon[aria-hidden="true"]') ?? null;
      const summaryTop = summary?.getBoundingClientRect().top ?? null;
      const summaryLine = summary?.closest<HTMLElement>('.cm-line') ?? null;
      const sourceToggle = document.querySelector<HTMLElement>('.meo-md-details-source-toggle');
      const summaryLineRect = summaryLine?.getBoundingClientRect() ?? null;
      const sourceToggleRect = sourceToggle?.getBoundingClientRect() ?? null;
      const scrollerRect = editor.view.scrollDOM.getBoundingClientRect();
      editor.view.dispatch({ selection: { anchor: anchor + 1 } });
      return {
        collapsed: (window as any).LiveLayoutStabilityHarness.getDetailsBlocks(editor.view.state)[0]?.collapsed,
        rawOpeningVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent?.includes('<details>')),
        summaryTop,
        summaryIconVisible: (summaryIcon?.getBoundingClientRect().width ?? 0) > 0,
        summaryIconTransform: summaryIcon ? getComputedStyle(summaryIcon).transform : '',
        summaryExpanded: summary?.getAttribute('aria-expanded') ?? null,
        sourceToggleVisible: Boolean(sourceToggle),
        sourceToggleSameRow: Boolean(
          summaryLineRect && sourceToggleRect &&
          sourceToggleRect.top < summaryLineRect.bottom && sourceToggleRect.bottom > summaryLineRect.top
        ),
        sourceToggleOutsideContent: Boolean(
          summaryLineRect && sourceToggleRect && sourceToggleRect.left >= summaryLineRect.right + 4
        ),
        sourceToggleInsideViewport: Boolean(sourceToggleRect && sourceToggleRect.right <= scrollerRect.right + 1),
        sourceToggleTopDelta: sourceToggleRect && summaryLineRect
          ? sourceToggleRect.top - summaryLineRect.top
          : null,
        bodyVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent?.includes('Hybrid body'))
      };
    });
    await waitForFrames(page, 4);
    if (
      hybridPreview.collapsed !== true || hybridPreview.rawOpeningVisible ||
      !hybridPreview.summaryIconVisible || hybridPreview.summaryIconTransform !== 'none' ||
      hybridPreview.summaryExpanded !== 'false' ||
      !hybridPreview.sourceToggleVisible || !hybridPreview.sourceToggleSameRow ||
      !hybridPreview.sourceToggleOutsideContent || !hybridPreview.sourceToggleInsideViewport ||
      hybridPreview.sourceToggleTopDelta === null || Math.abs(hybridPreview.sourceToggleTopDelta) > 1 ||
      hybridPreview.bodyVisible || hybridPreview.summaryTop === null
    ) {
      throw new Error(`Hybrid details did not use the unified preview shell: ${JSON.stringify(hybridPreview)}`);
    }
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.meo-md-details-source-toggle')!.click();
    });
    await waitForFrames(page, 6);
    const hybridSourceMode = await page.evaluate(() => {
      const sourceRangeLines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line.meo-md-html-source-range'));
      return {
        rawOpeningVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent?.includes('<details>')),
        markdownBodyVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent?.includes('Hybrid body with **bold text**.')),
        previewToggleVisible: Boolean(document.querySelector('.meo-md-html-preview-toggle')),
        summaryWidgetVisible: Boolean(document.querySelector('.meo-md-details-summary')),
        sourceRangeLineCount: sourceRangeLines.length,
        sourceRangeStart: sourceRangeLines[0]?.classList.contains('meo-md-html-source-range-start') ?? false,
        sourceRangeEnd: sourceRangeLines.at(-1)?.classList.contains('meo-md-html-source-range-end') ?? false
      };
    });
    if (
      !hybridSourceMode.rawOpeningVisible || !hybridSourceMode.markdownBodyVisible ||
      !hybridSourceMode.previewToggleVisible || hybridSourceMode.summaryWidgetVisible ||
      hybridSourceMode.sourceRangeLineCount !== 8 ||
      !hybridSourceMode.sourceRangeStart || !hybridSourceMode.sourceRangeEnd
    ) {
      throw new Error(`Hybrid details source mode was not fully editable: ${JSON.stringify(hybridSourceMode)}`);
    }
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.meo-md-html-preview-toggle')!.click();
    });
    await waitForFrames(page, 6);
    const hybridSummaryPoint = await page.$eval('.meo-md-details-summary', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + Math.min(90, rect.width / 2), y: rect.top + rect.height / 2, top: rect.top };
    });
    await page.mouse.click(hybridSummaryPoint.x, hybridSummaryPoint.y);
    await waitForFrames(page, 8);
    const hybridExpanded = await page.evaluate(() => ({
      bodyVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .some((line) => line.textContent?.includes('Hybrid body')),
      listVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .some((line) => line.textContent?.includes('hybrid markdown list item')),
      summaryTop: document.querySelector<HTMLElement>('.meo-md-details-summary')?.getBoundingClientRect().top ?? null,
      summaryIconTransform: getComputedStyle(
        document.querySelector<HTMLElement>('.meo-md-details-summary .meo-md-details-summary-icon[aria-hidden="true"]')!
      ).transform,
      summaryExpanded: document.querySelector<HTMLElement>('.meo-md-details-summary')?.getAttribute('aria-expanded') ?? null
    }));
    if (
      !hybridExpanded.bodyVisible || !hybridExpanded.listVisible || hybridExpanded.summaryTop === null ||
      Math.abs(hybridExpanded.summaryTop - hybridSummaryPoint.top) > 1 ||
      hybridExpanded.summaryIconTransform === hybridPreview.summaryIconTransform ||
      hybridExpanded.summaryExpanded !== 'true'
    ) {
      throw new Error(`Hybrid details did not expand Markdown content in place: ${JSON.stringify({ hybridSummaryPoint, hybridExpanded })}`);
    }

    const quoteSource = [
      ...Array.from({ length: 80 }, (_, index) => `before quote ${index + 1}`),
      `> ${'wrapping quoted content '.repeat(18)}`,
      ...Array.from({ length: 60 }, (_, index) => `quote anchor ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      const editor = (window as any).__editor;
      editor.setText(text);
      editor.scrollToLine(81, 'top');
    }, quoteSource);
    await waitForFrames(page);
    const quoteAnchorBeforeTop = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const quoteLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('wrapping quoted content'))!;
      const anchorLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('quote anchor 1'))!;
      const scrollerTop = scroller.getBoundingClientRect().top;
      scroller.scrollTop += quoteLine.getBoundingClientRect().top - scrollerTop + 8;
      const quotePosition = editor.getText().indexOf('>') + 1;
      editor.view.dispatch({ selection: { anchor: quotePosition } });
      editor.view.focus();
      return anchorLine.getBoundingClientRect().top;
    });
    await page.keyboard.press('Backspace');
    const quoteAfter = await page.evaluate(async () => {
      const editor = (window as any).__editor;
      const tops: Array<number | null> = [];
      for (let index = 0; index < 12; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const anchorLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((line) => line.textContent?.includes('quote anchor 1'));
        tops.push(anchorLine?.getBoundingClientRect().top ?? null);
      }
      return { text: editor.getText(), top: tops.at(-1) ?? null, tops };
    });
    if (quoteAfter.text.includes(`> ${'wrapping quoted content '.repeat(18)}`)) {
      throw new Error('Backspace did not remove the blockquote marker');
    }
    if (quoteAfter.top === null || Math.abs(quoteAfter.top - quoteAnchorBeforeTop) > 1) {
      throw new Error(`Removing a blockquote marker moved unchanged viewport content: ${quoteAnchorBeforeTop} -> ${quoteAfter.top}; frames=${JSON.stringify(quoteAfter.tops)}`);
    }

    }
    await page.evaluate(({ text, focused }) => {
      const editor = (window as any).__editor;
      editor.setText(text);
      editor.view.dispatch({ selection: { anchor: editor.getText().length } });
      if (focused) {
        editor.scrollToLine(81, 'top');
        return;
      }
      const tablePosition = editor.getText().indexOf('| Name |');
      editor.view.scrollDOM.scrollTop = editor.view.lineBlockAt(tablePosition).top + 8;
    }, { text: tableSource, focused: tableWrapOnly });
    await waitForFrames(page);
    if (tableWrapOnly) {
      await page.waitForSelector('.meo-md-html-table-shell tbody tr:nth-child(2) td:nth-child(2) textarea');
      await page.evaluate(() => (window as any).__editor.scrollToLine(83, 'center'));
      await waitForFrames(page, 6);
      const stableInput = await page.$(
        '.meo-md-html-table-shell tbody tr:nth-child(2) td:nth-child(2) textarea'
      );
      if (!stableInput) throw new Error('Could not locate the stable visible table input');
      await stableInput.click();
      await stableInput.press('End');
      const stableBefore = await page.$eval(
        '.meo-md-html-table-shell tbody tr:nth-child(2) td:nth-child(2) textarea',
        (input: HTMLTextAreaElement) => {
          const scroller = input.closest<HTMLElement>('.cm-scroller')!;
          const cell = input.closest<HTMLTableCellElement>('td')!;
          const viewport = scroller.getBoundingClientRect();
          const rect = cell.getBoundingClientRect();
          return {
            scrollTop: scroller.scrollTop,
            visible: rect.top >= viewport.top + 20 && rect.bottom <= viewport.bottom - 20,
            value: input.value
          };
        }
      );
      if (!stableBefore.visible) throw new Error(`Stable table fixture was not comfortably visible: ${JSON.stringify(stableBefore)}`);
      const stableFrames: number[] = [];
      const stableFocus: Array<{ active: boolean; value: string }> = [];
      let expectedStableValue = stableBefore.value;
      for (const character of 'ABCDE') {
        await page.keyboard.type(character);
        expectedStableValue += character;
        // Exercise the real manual-typing path: each character survives the
        // 250ms table auto-commit, widget projection, and focus restoration.
        await new Promise((resolve) => setTimeout(resolve, 320));
        await waitForFrames(page, 3);
        stableFrames.push(await page.$eval('.cm-scroller', (scroller) => scroller.scrollTop));
        const currentFocus = await page.$eval(
          '.meo-md-html-table-shell tbody tr:nth-child(2) td:nth-child(2) textarea',
          (input: HTMLTextAreaElement) => ({
            active: document.activeElement === input,
            value: input.value
          })
        );
        stableFocus.push(currentFocus);
        if (!currentFocus.active || currentFocus.value !== expectedStableValue) {
          throw new Error(`Table auto-commit lost the active cell or subsequent input: ${JSON.stringify({
            expectedStableValue,
            stableFocus
          })}`);
        }
      }
      if (stableFrames.some((scrollTop) => Math.abs(scrollTop - stableBefore.scrollTop) > 1)) {
        throw new Error(`Typing in a fully visible table cell moved the document viewport: ${JSON.stringify({
          stableBefore, stableFrames
        })}`);
      }
      if (tableStableVisibleOnly) {
        console.log('stable visible table input passed');
        return;
      }
      await page.evaluate(({ text }) => {
        const editor = (window as any).__editor;
        editor.setText(text);
        editor.scrollToLine(81, 'top');
      }, { text: tableSource });
      await waitForFrames(page, 8);
    }
    if (!tableWrapOnly) {
      const tableBefore = await page.evaluate(() => ({
        shellTop: document.querySelector('.meo-md-html-table-shell')?.getBoundingClientRect().top ?? null,
        followingTop: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((line) => line.textContent?.includes('table anchor 1'))?.getBoundingClientRect().top ?? null
      }));
      if (tableBefore.shellTop === null || tableBefore.followingTop === null) {
        throw new Error('Could not locate the table and its following viewport content');
      }
      const firstTableInput = await page.$('.meo-md-html-table-shell tbody textarea');
      if (!firstTableInput) throw new Error('Could not locate an editable Live table cell');
      await firstTableInput.click();
      await firstTableInput.type(' edited');
      await waitForFrames(page);
      const tableAfter = await page.evaluate(() => ({
        shellTop: document.querySelector('.meo-md-html-table-shell')?.getBoundingClientRect().top ?? null,
        followingTop: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((line) => line.textContent?.includes('table anchor 1'))?.getBoundingClientRect().top ?? null
      }));
      if (
        tableAfter.shellTop === null || Math.abs(tableAfter.shellTop - tableBefore.shellTop) > 1 ||
        tableAfter.followingTop === null || tableAfter.followingTop < tableBefore.followingTop
      ) {
        throw new Error(`Editing a table did not grow downward in place: ${JSON.stringify({ tableBefore, tableAfter })}`);
      }
    }

    const wrappingTableInput = await page.$(
      '.meo-md-html-table-shell tbody tr:nth-child(2) td:nth-child(2) textarea'
    );
    if (!wrappingTableInput) throw new Error('Could not locate the table wrap threshold input');
    await wrappingTableInput.click();
    await wrappingTableInput.press('End');
    await waitForFrames(page, 3);
    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const currentElements = () => {
        const shell = document.querySelector<HTMLElement>('.meo-md-html-table-shell')!;
        const row = shell.querySelector<HTMLElement>('tbody tr:nth-child(2)')!;
        const input = row.querySelector<HTMLTextAreaElement>('td:nth-child(2) textarea')!;
        return { shell, row, input };
      };
      const { shell, row } = currentElements();
      const scrollerRect = scroller.getBoundingClientRect();
      scroller.scrollTop += row.getBoundingClientRect().bottom - scrollerRect.bottom + 12;
      (window as any).__tableWrapFrames = [];
      (window as any).__focusedTableInputCollapsed = false;
      new MutationObserver((records) => {
        const currentInput = currentElements().input;
        if (
          currentInput.style.height === '0px' || currentInput.clientHeight <= 0 ||
          records.some((record) => (
            record.target === currentInput && record.oldValue?.includes('height: 0px')
          ))
        ) {
          (window as any).__focusedTableInputCollapsed = true;
        }
      }).observe(scroller, {
        attributes: true,
        attributeFilter: ['style'],
        attributeOldValue: true,
        childList: true,
        subtree: true
      });
      const capture = (stage: string) => {
        const { shell, row, input } = currentElements();
        const currentScrollerRect = scroller.getBoundingClientRect();
        const cellRect = input.closest('td')!.getBoundingClientRect();
        (window as any).__tableWrapFrames.push({
          stage,
          scrollTop: scroller.scrollTop,
          shellTop: shell.getBoundingClientRect().top,
          rowHeight: row.getBoundingClientRect().height,
          inputScrollTop: input.scrollTop,
          inputClientHeight: input.clientHeight,
          inputEndVisible: input.getBoundingClientRect().bottom <= currentScrollerRect.bottom + 1 &&
            cellRect.bottom <= currentScrollerRect.bottom + 1
        });
      };
      (window as any).__captureTableWrapFrame = capture;
      document.addEventListener('input', (event) => {
        if (!(event.target instanceof HTMLTextAreaElement) || !event.target.closest('.meo-md-html-table-shell')) return;
        capture('input');
        queueMicrotask(() => capture('microtask'));
      }, true);
      let remaining = 300;
      const sample = () => {
        capture('frame');
        remaining -= 1;
        if (remaining > 0) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    if (tableWrapCounterexample === 'incomplete') {
      const initialLength = await wrappingTableInput.evaluate((input) => input.value.length);
      await wrappingTableInput.type(tableWrapFixture.slice(0, -Math.floor(tableWrapFixture.length / 2)));
      const value = await page.$eval(
        '.meo-md-html-table-shell tbody tr:nth-child(2) td:nth-child(2) textarea',
        (input: HTMLTextAreaElement) => input.value
      );
      if (
        !value.includes('wrapping table cell content') ||
        hasCompleteAppendedInput(value, initialLength)
      ) {
        throw new Error('Incomplete table input did not distinguish the exact append contract');
      }
      console.log('incomplete table input counterexample passed');
      return;
    }
    if (tableWrapCounterexample === 'caret') {
      const observation = await page.$eval(
        '.meo-md-html-table-shell tbody tr:nth-child(2) td:nth-child(2) textarea',
        (input: HTMLTextAreaElement) => {
          const cell = input.closest<HTMLTableCellElement>('td')!;
          const scroller = input.closest<HTMLElement>('.cm-scroller')!;
          const cellRect = cell.getBoundingClientRect();
          const scrollerRect = scroller.getBoundingClientRect();
          scroller.scrollTop += cellRect.top - scrollerRect.bottom + cellRect.height / 2;
          const movedCellRect = cell.getBoundingClientRect();
          const inputRect = input.getBoundingClientRect();
          return {
            legacyIntersects: movedCellRect.bottom > scrollerRect.top && movedCellRect.top < scrollerRect.bottom,
            isActive: document.activeElement === input,
            selectionEnd: input.selectionEnd,
            valueLength: input.value.length,
            inputBottom: inputRect.bottom,
            cellBottom: movedCellRect.bottom,
            scrollerBottom: scrollerRect.bottom
          };
        }
      );
      if (!observation.legacyIntersects || hasVisibleEndCaret(observation)) {
        throw new Error(`Table end-caret counterexample did not cross the viewport boundary: ${JSON.stringify(observation)}`);
      }
      console.log('table end-caret counterexample passed');
      return;
    }
    if (tableWrapCounterexample === 'replacement') {
      const observation = await page.evaluate(async () => {
        const editor = (window as any).__editor;
        const scroller = editor.view.scrollDOM as HTMLElement;
        const oldShell = document.querySelector<HTMLElement>('.meo-md-html-table-shell')!;
        const oldInput = oldShell.querySelector<HTMLTextAreaElement>(
          'tbody tr:nth-child(2) td:nth-child(2) textarea'
        )!;
        const replacementReady = new Promise<HTMLTextAreaElement>((resolve) => {
          const observer = new MutationObserver(() => {
            const currentShell = document.querySelector<HTMLElement>('.meo-md-html-table-shell');
            const currentInput = currentShell?.querySelector<HTMLTextAreaElement>(
              'tbody tr:nth-child(2) td:nth-child(2) textarea'
            );
            if (currentShell === oldShell || !currentInput || currentInput === oldInput) return;
            observer.disconnect();
            resolve(currentInput);
          });
          observer.observe(scroller, { childList: true, subtree: true });
        });
        editor.setText(editor.getText().replace('| Beta | Short |', '| Beta | Replacement |'));
        const currentReplacement = await replacementReady;
        await Promise.resolve();
        const detectedAfterNonCollapsedReplacement = Boolean((window as any).__focusedTableInputCollapsed);
        (window as any).__focusedTableInputCollapsed = false;
        currentReplacement.style.height = '0px';
        currentReplacement.style.height = 'auto';
        await Promise.resolve();
        return {
          inputWasReplaced: currentReplacement !== oldInput,
          detectedAfterNonCollapsedReplacement,
          currentObserverDetectedCollapse: Boolean((window as any).__focusedTableInputCollapsed)
        };
      });
      if (
        !observation.inputWasReplaced || observation.detectedAfterNonCollapsedReplacement ||
        !observation.currentObserverDetectedCollapse
      ) {
        throw new Error(`Replacement textarea collapse counterexample was not distinguished: ${JSON.stringify(observation)}`);
      }
      console.log('replacement textarea collapse counterexample passed');
      return;
    }
    const initialWrapRowHeight = await page.$eval(
      '.meo-md-html-table-shell tbody tr:nth-child(2)',
      (row) => row.getBoundingClientRect().height
    );
    const initialWrapInputLength = await wrappingTableInput.evaluate((input) => input.value.length);
    await wrappingTableInput.type(tableWrapFixture);
    const crossedWrapThreshold = await page.evaluate(async (initialHeight) => {
      let stableHeight: number | null = null;
      let stableFrames = 0;
      for (let index = 0; index < 60; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        (window as any).__captureTableWrapFrame('frame');
        const row = document.querySelector<HTMLElement>(
          '.meo-md-html-table-shell tbody tr:nth-child(2)'
        );
        const currentHeight = row?.getBoundingClientRect().height ?? 0;
        if (currentHeight > initialHeight && currentHeight === stableHeight) {
          stableFrames += 1;
        } else {
          stableHeight = currentHeight;
          stableFrames = currentHeight > initialHeight ? 1 : 0;
        }
        if (stableFrames >= 3) return true;
      }
      return false;
    }, initialWrapRowHeight);
    const tableWrapFrames = await page.evaluate(() => (
      (window as any).__tableWrapFrames as Array<{
        stage: string;
        scrollTop: number;
        shellTop: number;
        rowHeight: number | null;
        inputScrollTop: number;
        inputClientHeight: number;
        inputEndVisible: boolean;
      }>
    ));
    const focusedTableInputCollapsed = await page.evaluate(() => (
      Boolean((window as any).__focusedTableInputCollapsed)
    ));
    const wrapHeights = tableWrapFrames
      .map((frame) => frame.rowHeight)
      .filter((height): height is number => height !== null);
    const wrapScrollTops = tableWrapFrames.map((frame) => frame.scrollTop);
    const wrapShellTops = tableWrapFrames.map((frame) => frame.shellTop);
    const inputGeometry = await page.$eval(
      '.meo-md-html-table-shell tbody tr:nth-child(2) td:nth-child(2) textarea',
      (input: HTMLTextAreaElement) => {
        const inputRect = input.getBoundingClientRect();
        const cellRect = input.closest('td')!.getBoundingClientRect();
        const scrollerRect = input.closest('.cm-scroller')!.getBoundingClientRect();
        return {
          value: input.value,
          isActive: document.activeElement === input,
          selectionEnd: input.selectionEnd,
          valueLength: input.value.length,
          inputBottom: inputRect.bottom,
          cellBottom: cellRect.bottom,
          scrollerBottom: scrollerRect.bottom,
          scrollHeight: input.scrollHeight,
          clientHeight: input.clientHeight,
          clientWidth: input.clientWidth
        };
      }
    );
    if (
      !crossedWrapThreshold || !hasCompleteAppendedInput(inputGeometry.value, initialWrapInputLength) ||
      Math.max(...wrapHeights) <= Math.min(...wrapHeights)
    ) {
      throw new Error(`Table wrap fixture did not grow a row: ${JSON.stringify({ inputGeometry, tableWrapFrames })}`);
    }
    const scrollDirections = wrapScrollTops.slice(1)
      .map((top, index) => top - wrapScrollTops[index])
      .filter((delta) => Math.abs(delta) > 1)
      .map((delta) => Math.sign(delta));
    const shellDirections = wrapShellTops.slice(1)
      .map((top, index) => top - wrapShellTops[index])
      .filter((delta) => Math.abs(delta) > 1)
      .map((delta) => Math.sign(delta));
    if (
      scrollDirections.some((direction, index) => index > 0 && direction !== scrollDirections[index - 1]) ||
      shellDirections.some((direction, index) => index > 0 && direction !== shellDirections[index - 1]) ||
      focusedTableInputCollapsed ||
      tableWrapFrames.some((frame) => frame.inputScrollTop > 1) ||
      tableWrapFrames.some((frame) => (
        frame.inputClientHeight <= 0 || (frame.stage === 'frame' && !frame.inputEndVisible)
      )) ||
      inputGeometry.clientHeight <= 0 || !hasVisibleEndCaret(inputGeometry)
    ) {
      throw new Error(`Wrapping a focused table cell moved the viewport between frames: ${JSON.stringify({
        focusedTableInputCollapsed,
        invalidFrame: tableWrapFrames.find((frame) => (
          frame.inputScrollTop > 1 || frame.inputClientHeight <= 0 ||
          (frame.stage === 'frame' && !frame.inputEndVisible)
        )) ?? null,
        inputGeometry,
        tableWrapFrames
      })}`);
    }

    const hiddenContextTriggerHitTest = await page.evaluate(async () => {
      const editor = (window as any).__editor;
      editor.view.contentDOM.focus();
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const trigger = document.querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger')!;
      const rect = trigger.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        triggerOpacity: getComputedStyle(trigger).opacity,
        triggerPointerEvents: getComputedStyle(trigger).pointerEvents,
        triggerVisibility: getComputedStyle(trigger).visibility,
        hitClassName: hit instanceof HTMLElement ? hit.className : '',
        hitContextTrigger: Boolean(hit?.closest('.meo-md-html-table-context-trigger')),
        cursor: hit instanceof Element ? getComputedStyle(hit).cursor : ''
      };
    });
    if (
      hiddenContextTriggerHitTest.triggerVisibility !== 'hidden' ||
      hiddenContextTriggerHitTest.triggerPointerEvents !== 'none' ||
      hiddenContextTriggerHitTest.hitContextTrigger ||
      hiddenContextTriggerHitTest.cursor === 'pointer'
    ) {
      throw new Error(`Hidden table context trigger remained pointer-interactive: ${JSON.stringify(hiddenContextTriggerHitTest)}`);
    }

    console.log('live layout stability browser tests passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
