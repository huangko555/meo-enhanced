import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-document-diff-gutter-'));

async function waitForFrames(page: Page, count = 4): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-editor-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 500, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-font-source:monospace; --meo-font-source-weight:400; --meo-font-source-size:14px; --git-deleted:#e05252; }' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      const editor = (window as any).EditorStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: 'first\nlast',
        initialMode: 'source',
        onApplyChanges() {}
      });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nremoved one\nremoved two\nlast'
      });
      (window as any).__editor = editor;
    });
    await waitForFrames(page);

    const marker = await page.$('.meo-git-gutter-marker.is-deleted');
    if (!marker) throw new Error('Deleted gap marker was not rendered');
    const markerState = await marker.evaluate((element) => ({
      from: (element as HTMLElement).dataset.meoBaselineFromLine,
      to: (element as HTMLElement).dataset.meoBaselineToLine
    }));
    if (markerState.from !== '2' || markerState.to !== '3') {
      throw new Error(`Deleted gap range was incorrect: ${JSON.stringify(markerState)}`);
    }

    const rect = await marker.boundingBox();
    if (!rect) throw new Error('Deleted gap marker had no layout box');
    await page.mouse.move(rect.x + 1, rect.y + 1);
    await waitForFrames(page, 2);
    const tooltip = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.meo-deletion-tooltip');
      return {
        hidden: root?.hidden,
        text: root?.textContent ?? ''
      };
    });
    if (tooltip.hidden || !tooltip.text.includes('removed one') || !tooltip.text.includes('removed two')) {
      throw new Error(`Deleted content tooltip was incorrect: ${JSON.stringify(tooltip)}`);
    }

    await page.evaluate(() => {
      (window as any).__editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nlast'
      });
    });
    await waitForFrames(page);
    if (await page.$('.meo-git-gutter-marker.is-deleted')) {
      throw new Error('Deleted marker remained after the baseline matched the document');
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setMode('source');
      editor.setText('first\ncurrent value\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\noriginal value\nlast'
      });
    });
    await waitForFrames(page, 4);
    const modifiedMarker = await page.$('.meo-git-gutter-marker.is-modified');
    const modifiedRect = await modifiedMarker?.boundingBox();
    if (!modifiedRect) throw new Error('Modified marker had no layout box');
    await page.mouse.move(modifiedRect.x + modifiedRect.width / 2, modifiedRect.y + modifiedRect.height / 2);
    await waitForFrames(page, 2);
    const modifiedTooltip = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.meo-modified-tooltip');
      return { hidden: root?.hidden, text: root?.textContent ?? '' };
    });
    if (modifiedTooltip.hidden || !modifiedTooltip.text.includes('original value')) {
      throw new Error(`Modified content tooltip was incorrect: ${JSON.stringify(modifiedTooltip)}`);
    }
    await page.mouse.move(modifiedRect.x - 2, modifiedRect.y + modifiedRect.height / 2);
    await waitForFrames(page, 2);
    const modifiedHoverState = await modifiedMarker!.evaluate((element) => ({
      stripeWidth: element.querySelector<HTMLElement>('.meo-git-gutter-stripe')?.getBoundingClientRect().width ?? 0,
      tooltipVisible: !document.querySelector<HTMLElement>('.meo-modified-tooltip')?.hidden
    }));
    if (modifiedHoverState.stripeWidth <= modifiedRect.width || !modifiedHoverState.tooltipVisible) {
      throw new Error(`Modified marker did not retain its existing expanded hover behavior: ${JSON.stringify(modifiedHoverState)}`);
    }

    await page.evaluate(() => {
      (window as any).__editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nsaved value\nlast'
      });
    });
    await waitForFrames(page, 2);
    const staleModifiedTooltipVisible = await page.$eval(
      '.meo-modified-tooltip',
      (element) => !(element as HTMLElement).hidden
    );
    if (staleModifiedTooltipVisible) {
      throw new Error('Modified tooltip remained visible after the diff baseline changed');
    }
    await page.mouse.move(modifiedRect.x + modifiedRect.width / 2, modifiedRect.y + modifiedRect.height / 2);
    await waitForFrames(page, 2);
    const refreshedModifiedTooltipText = await page.$eval(
      '.meo-modified-tooltip',
      (element) => element.textContent ?? ''
    );
    if (!refreshedModifiedTooltipText.includes('saved value') || refreshedModifiedTooltipText.includes('original value')) {
      throw new Error(`Modified tooltip did not refresh after the baseline changed: ${refreshedModifiedTooltipText}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setMode('source');
      editor.setText('before\nLONG\n\n\nHEADING\n\nafter');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'before\n\n\nLONG\n\nHEADING\n\nafter'
      });
    });
    await waitForFrames(page, 4);
    const blankLineMoveMarkers = await page.evaluate(() => ({
      added: document.querySelectorAll('.meo-git-gutter-marker.is-added').length,
      modified: document.querySelectorAll('.meo-git-gutter-marker.is-modified').length,
      deleted: Array.from(document.querySelectorAll<HTMLElement>('.meo-git-gutter-marker.is-deleted')).map((marker) => ({
        from: marker.dataset.meoBaselineFromLine,
        to: marker.dataset.meoBaselineToLine
      }))
    }));
    if (
      blankLineMoveMarkers.added !== 1 ||
      blankLineMoveMarkers.modified !== 0 ||
      blankLineMoveMarkers.deleted.length !== 1 ||
      blankLineMoveMarkers.deleted[0]?.from !== '2' ||
      blankLineMoveMarkers.deleted[0]?.to !== '3'
    ) {
      throw new Error(`Blank-line edits displaced an unchanged text anchor: ${JSON.stringify(blankLineMoveMarkers)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const baselineLines = Array.from({ length: 1201 }, (_, index) => `stable ${index}`);
      const currentLines = [...baselineLines];
      currentLines[600] = 'changed 600';
      editor.setText(currentLines.join('\n'));
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: baselineLines.join('\n')
      });
    });
    await waitForFrames(page, 4);
    const oversizedMarkerCount = await page.$$eval(
      '.meo-git-gutter-marker.is-added, .meo-git-gutter-marker.is-modified, .meo-git-gutter-marker.is-deleted',
      (markers) => markers.length
    );
    if (oversizedMarkerCount !== 0) {
      throw new Error(`Diff markers rendered past the 1200-line safety limit: ${oversizedMarkerCount}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const text = '| Name |\n| --- |\n| kept one |\n| kept two |\n\nafter';
      editor.setText(text);
      editor.revealSelection(text.length, text.length, { focus: false });
      editor.setMode('live');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: '| Name |\n| --- |\n| removed one |\n| kept one |\n| removed two |\n| kept two |\n\nafter'
      });
    });
    await waitForFrames(page, 8);
    const liveMarkers = await page.$$('.meo-git-gutter-marker.is-deleted');
    if (liveMarkers.length !== 2) {
      throw new Error(`Live table deletion rendered ${liveMarkers.length} row markers instead of two`);
    }
    const liveTooltipTexts: string[] = [];
    for (const liveMarker of liveMarkers) {
      const liveRect = await liveMarker.boundingBox();
      if (!liveRect) throw new Error('Live deleted row marker had no layout box');
      await page.mouse.move(liveRect.x + 1, liveRect.y + 1);
      await waitForFrames(page, 2);
      liveTooltipTexts.push(await page.$eval('.meo-deletion-tooltip', (element) => element.textContent ?? ''));
    }
    const liveTooltipText = liveTooltipTexts.join('\n');
    if (!liveTooltipText.includes('removed one') || !liveTooltipText.includes('removed two')) {
      throw new Error(`Live deleted row tooltips omitted a deletion gap: ${liveTooltipText}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const text = '```mermaid\nflowchart LR\nA --> B\nC --> D\n```\n\nafter';
      editor.setText(text);
      editor.revealSelection(text.length, text.length, { focus: false });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: '```mermaid\nflowchart LR\nA --> B\nB --> C\nC --> D\n```\n\nafter'
      });
    });
    await waitForFrames(page, 8);
    const mermaidDeletionMarkers = await page.$$('.meo-git-gutter-marker.is-deleted');
    if (mermaidDeletionMarkers.length !== 1) {
      throw new Error(`Live Mermaid deletion rendered ${mermaidDeletionMarkers.length} markers instead of one`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const text = '```mermaid\nflowchart LR\nA --> C\nC --> E\n```\n\nafter';
      editor.setText(text);
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: '```mermaid\nflowchart LR\nA --> B\nC --> D\n```\n\nafter'
      });
    });
    await waitForFrames(page, 8);
    const liveModifiedMarker = await page.$('.meo-git-gutter-marker.is-modified');
    const liveModifiedRect = await liveModifiedMarker?.boundingBox();
    if (!liveModifiedRect) throw new Error('Live Mermaid modified marker had no layout box');
    await page.mouse.move(
      liveModifiedRect.x + liveModifiedRect.width / 2,
      liveModifiedRect.y + liveModifiedRect.height / 2
    );
    await waitForFrames(page, 2);
    const liveModifiedTooltip = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.meo-modified-tooltip');
      return { hidden: root?.hidden, text: root?.textContent ?? '' };
    });
    if (
      liveModifiedTooltip.hidden ||
      !liveModifiedTooltip.text.includes('A --> B\nC --> D') ||
      liveModifiedTooltip.text.includes('A --> B\n…\nC --> D')
    ) {
      throw new Error(`Live modified tooltip omitted original source: ${JSON.stringify(liveModifiedTooltip)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const text = '$$\na\nc\n$$\n\nafter';
      editor.setText(text);
      editor.revealSelection(text.length, text.length, { focus: false });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: '$$\na\nb\nc\n$$\n\nafter'
      });
    });
    await waitForFrames(page, 8);
    const mathDeletionMarkers = await page.$$('.meo-git-gutter-marker.is-deleted');
    if (mathDeletionMarkers.length !== 1) {
      throw new Error(`Live display-math deletion rendered ${mathDeletionMarkers.length} markers instead of one`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setMode('source');
      editor.setText('first\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nremoved one\nremoved two\nlast'
      });
    });
    await waitForFrames(page, 4);
    const sourceMarker = await page.$('.meo-git-gutter-marker.is-deleted');
    const sourceRect = await sourceMarker?.boundingBox();
    if (!sourceRect) throw new Error('Source deleted marker had no layout box for hit-area check');
    const sourceTriangle = await sourceMarker!.evaluate((element) => {
      const markerRect = element.getBoundingClientRect();
      const style = getComputedStyle(element, '::after');
      const left = Number.parseFloat(style.left) || 0;
      const width = Number.parseFloat(style.borderLeftWidth) || 0;
      return {
        left: markerRect.left + left,
        right: markerRect.left + left + width,
        width,
        y: markerRect.top
      };
    });
    await page.mouse.move(sourceRect.x + 80, sourceRect.y + 1);
    await page.mouse.move(sourceTriangle.right + 1, sourceTriangle.y);
    await waitForFrames(page, 2);
    const rightOutsideTooltipVisible = await page.$eval('.meo-deletion-tooltip', (element) => !(element as HTMLElement).hidden);
    if (rightOutsideTooltipVisible) {
      throw new Error('Deleted content tooltip extended past the visible triangle on the right');
    }
    await page.mouse.move(sourceRect.x - 6, sourceRect.y + 1);
    await waitForFrames(page, 2);
    const expandedHitTooltipVisible = await page.$eval('.meo-deletion-tooltip', (element) => !(element as HTMLElement).hidden);
    if (!expandedHitTooltipVisible) {
      throw new Error('Deleted content tooltip hit area did not extend beyond the visible triangle');
    }
    const expandedTriangle = await sourceMarker!.evaluate((element) => {
      const markerRect = element.getBoundingClientRect();
      const style = getComputedStyle(element, '::after');
      const left = markerRect.left + (Number.parseFloat(style.left) || 0);
      const width = Number.parseFloat(style.borderLeftWidth) || 0;
      return { left, right: left + width, width };
    });
    if (expandedTriangle.width <= sourceTriangle.width) {
      throw new Error(`Deleted triangle did not expand on hover: ${sourceTriangle.width} -> ${expandedTriangle.width}`);
    }
    if (expandedTriangle.left >= sourceTriangle.left || Math.abs(expandedTriangle.right - sourceTriangle.right) > 0.1) {
      throw new Error(`Deleted triangle did not expand leftward with a fixed tip: ${JSON.stringify({
        before: sourceTriangle,
        after: expandedTriangle
      })}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setText('first\nmiddle\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nremoved upper\nmiddle\nremoved lower\nlast'
      });
      const editorRoot = document.querySelector<HTMLElement>('.cm-editor');
      if (editorRoot) {
        editorRoot.style.transform = 'scaleY(0.5)';
        editorRoot.style.transformOrigin = 'top left';
      }
    });
    await waitForFrames(page, 4);
    const adjacentMarkers = await page.evaluate(() => Array.from(
      document.querySelectorAll<HTMLElement>('.meo-git-gutter-marker.is-deleted')
    ).map((marker) => {
      const rect = marker.getBoundingClientRect();
      return { left: rect.left, top: rect.top };
    }).sort((left, right) => left.top - right.top));
    if (adjacentMarkers.length !== 2) {
      throw new Error(`Adjacent deletions rendered ${adjacentMarkers.length} markers instead of two`);
    }
    const lowerMarker = adjacentMarkers[1];
    await page.mouse.move(lowerMarker.left + 1, lowerMarker.top - 4);
    await waitForFrames(page, 2);
    const adjacentTooltipText = await page.$eval('.meo-deletion-tooltip', (element) => element.textContent ?? '');
    if (!adjacentTooltipText.includes('removed lower') || adjacentTooltipText.includes('removed upper')) {
      throw new Error(`Overlapping deletion hit areas selected the wrong marker: ${adjacentTooltipText}`);
    }

    console.log('document diff gutter checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
