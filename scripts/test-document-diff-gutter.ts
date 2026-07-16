import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-document-diff-gutter-'));

function findBrowserExecutable(): string {
  const candidates = [
    process.env.MEO_TEST_BROWSER,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe'
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error('No supported browser found');
  return executable;
}

async function waitForFrames(page: puppeteer.Page, count = 4): Promise<void> {
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

  const browser = await puppeteer.launch({ executablePath: findBrowserExecutable(), headless: true, args: ['--no-sandbox'] });
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
    if (liveMarkers.length !== 1) {
      throw new Error(`Live table deletion rendered ${liveMarkers.length} markers instead of one`);
    }
    const liveMarker = liveMarkers[0];
    const liveRect = await liveMarker.boundingBox();
    if (!liveRect) throw new Error('Live deleted marker had no layout box');
    await page.mouse.move(liveRect.x + 1, liveRect.y + 1);
    await waitForFrames(page, 2);
    const liveTooltipText = await page.$eval('.meo-deletion-tooltip', (element) => element.textContent ?? '');
    if (!liveTooltipText.includes('removed one') || !liveTooltipText.includes('removed two')) {
      throw new Error(`Live deleted tooltip omitted a deletion gap: ${liveTooltipText}`);
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
    await page.mouse.move(sourceRect.x + 80, sourceRect.y + 1);
    await page.mouse.move(sourceRect.x - 6, sourceRect.y + 1);
    await waitForFrames(page, 2);
    const expandedHitTooltipVisible = await page.$eval('.meo-deletion-tooltip', (element) => !(element as HTMLElement).hidden);
    if (!expandedHitTooltipVisible) {
      throw new Error('Deleted content tooltip hit area did not extend beyond the visible triangle');
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
