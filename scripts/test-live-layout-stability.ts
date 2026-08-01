import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-layout-stability-'));

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
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-mutedForeground:#8b949e; --meo-semantic-tableBorder:#3e444d; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:monospace; --meo-font-source-weight:400; --meo-font-source-size:14px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

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
      (window as any).LiveLayoutStabilityHarness.toggleCollapsibleSection(editor.view, anchor);
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
      const toggled = (window as any).LiveLayoutStabilityHarness.toggleCollapsibleSection(editor.view, anchor);
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
      return (window as any).LiveLayoutStabilityHarness.toggleCollapsibleSection(editor.view, anchor);
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
      return (window as any).LiveLayoutStabilityHarness.toggleCollapsibleSection(editor.view, anchor);
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
      return (window as any).LiveLayoutStabilityHarness.toggleCollapsibleSection(editor.view, anchor);
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
      summaryTop: document.querySelector<HTMLElement>('.meo-md-details-summary')?.getBoundingClientRect().top ?? null
    }));
    if (
      !hybridExpanded.bodyVisible || !hybridExpanded.listVisible || hybridExpanded.summaryTop === null ||
      Math.abs(hybridExpanded.summaryTop - hybridSummaryPoint.top) > 1
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

    const tableSource = [
      ...Array.from({ length: 80 }, (_, index) => `before table ${index + 1}`),
      '| Name | Description |',
      '| --- | --- |',
      `| Alpha | ${'long table content '.repeat(8)} |`,
      '| Beta | Short |',
      ...Array.from({ length: 60 }, (_, index) => `table anchor ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      const editor = (window as any).__editor;
      editor.setText(text);
      editor.view.dispatch({ selection: { anchor: editor.getText().length } });
      const tablePosition = editor.getText().indexOf('| Name |');
      editor.view.scrollDOM.scrollTop = editor.view.lineBlockAt(tablePosition).top + 8;
    }, tableSource);
    await waitForFrames(page);
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

    console.log('live layout stability browser tests passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
