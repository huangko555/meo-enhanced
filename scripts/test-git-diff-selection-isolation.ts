import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-git-diff-selection-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 4): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
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
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-selection-bg:#3f6380;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--git-added:#4caf7d;--git-deleted:#e05252}' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      const harness = (window as any).EditorStabilityHarness;
      const editor = harness.createEditor({
        parent: document.getElementById('app')!,
        text: 'line 570\nline 571\ncurrent 575\ncurrent 576\ncurrent 577\nline 580\ncurrent 582\nline 586',
        initialMode: 'source',
        onApplyChanges() {}
      });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'line 570\nline 571\noriginal 575\noriginal 576\noriginal 577\nline 580\noriginal 582\nline 586'
      });
      harness.setGitDiffDetailsVisible(editor, true);
      (window as any).__editor = editor;
    });
    await waitForFrames(page);

    const drag = await page.evaluate(() => {
      const currentLines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'));
      const point = (line: HTMLElement, atEnd: boolean) => {
        const range = document.createRange();
        range.selectNodeContents(line);
        const rect = range.getBoundingClientRect();
        return { x: atEnd ? rect.right - 2 : rect.left + 2, y: rect.top + rect.height / 2 };
      };
      return {
        start: point(currentLines[0]!, false),
        end: point(currentLines[currentLines.length - 1]!, true)
      };
    });
    await page.mouse.move(drag.start.x, drag.start.y);
    await page.mouse.down();
    await page.mouse.move(drag.end.x, drag.end.y, { steps: 12 });
    await page.mouse.up();
    await waitForFrames(page, 2);

    const selectedBefore = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const selectionHost = document.documentElement;
      const selection = document.getSelection();
      const element = (node: Node | null) => node instanceof Element ? node : node?.parentElement;
      return {
        currentSelectionEmpty: editor.view.state.selection.main.empty,
        currentDomain: selectionHost.classList.contains('meo-git-diff-selecting-current'),
        nativeText: selection?.toString() ?? '',
        anchorClass: element(selection?.anchorNode ?? null)?.className ?? '',
        focusClass: element(selection?.focusNode ?? null)?.className ?? '',
        visibleCurrentLayers: Array.from(document.querySelectorAll<HTMLElement>('.cm-selectionBackground'))
          .filter((layer) => getComputedStyle(layer).display !== 'none').length
      };
    });

    const originalPoint = await page.$eval('.meo-git-diff-original-content:last-of-type', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + Math.min(80, rect.width / 2), y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(originalPoint.x, originalPoint.y);
    await page.mouse.down();
    const held = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const selectionHost = document.documentElement;
      const layers = Array.from(document.querySelectorAll<HTMLElement>('.cm-selectionBackground'));
      return {
        currentSelectionEmpty: editor.view.state.selection.main.empty,
        originalDomain: selectionHost.classList.contains('meo-git-diff-selecting-original'),
        currentDomain: selectionHost.classList.contains('meo-git-diff-selecting-current'),
        nativeText: document.getSelection()?.toString() ?? '',
        visibleCurrentLayers: layers.filter((layer) => getComputedStyle(layer).display !== 'none').length
      };
    });
    await page.mouse.up();
    await waitForFrames(page, 2);
    const released = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const selectionHost = document.documentElement;
      return {
        currentSelectionEmpty: editor.view.state.selection.main.empty,
        originalDomain: selectionHost.classList.contains('meo-git-diff-selecting-original'),
        nativeText: document.getSelection()?.toString() ?? ''
      };
    });

    if (
      selectedBefore.currentSelectionEmpty ||
      !selectedBefore.currentDomain ||
      selectedBefore.nativeText.includes('original') ||
      !selectedBefore.nativeText.includes('current 582') ||
      !held.currentSelectionEmpty ||
      !held.originalDomain ||
      held.currentDomain ||
      held.nativeText !== '' ||
      held.visibleCurrentLayers !== 0 ||
      !released.currentSelectionEmpty ||
      released.nativeText !== ''
    ) {
      throw new Error(`Git diff selection domains overlapped: ${JSON.stringify({ selectedBefore, held, released })}`);
    }

    const originalDrag = await page.evaluate(() => {
      const contents = Array.from(document.querySelectorAll<HTMLElement>('.meo-git-diff-original-content'));
      const point = (content: HTMLElement, atEnd: boolean) => {
        const rect = content.getBoundingClientRect();
        return { x: atEnd ? rect.right - 2 : rect.left + 2, y: rect.top + rect.height / 2 };
      };
      return {
        start: point(contents[0]!, false),
        end: point(contents[0]!, true)
      };
    });
    await page.mouse.move(originalDrag.start.x, originalDrag.start.y);
    await page.mouse.down();
    await page.mouse.move(originalDrag.end.x, originalDrag.end.y, { steps: 8 });
    await page.mouse.up();
    await waitForFrames(page, 2);
    const originalSelected = await page.evaluate(() => {
      const editor = (window as any).__editor;
      return {
        currentSelectionEmpty: editor.view.state.selection.main.empty,
        originalDomain: document.documentElement.classList.contains('meo-git-diff-selecting-original'),
        nativeText: document.getSelection()?.toString() ?? ''
      };
    });
    if (
      !originalSelected.currentSelectionEmpty ||
      !originalSelected.originalDomain ||
      !originalSelected.nativeText.includes('original 575') ||
      originalSelected.nativeText.includes('current')
    ) {
      throw new Error(`Original diff selection escaped its domain: ${JSON.stringify(originalSelected)}`);
    }
    console.log('git diff selection isolation checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
