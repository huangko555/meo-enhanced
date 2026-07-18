import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-git-diff-overview-ruler-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

function createTallMermaidFixture(targetText: string): string {
  const lines = Array.from({ length: 120 }, (_, index) => `stable line ${index + 1}`);
  lines[9] = '```mermaid';
  lines[10] = 'flowchart TD';
  lines[11] = '  Start --> End';
  lines[12] = '```';
  lines[79] = targetText;
  return lines.join('\n');
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
    await page.setViewport({ width: 900, height: 500, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root{--meo-background:#202223;--meo-foreground:#e6edf3;--meo-font-live:Arial;--meo-font-source:monospace;--meo-font-live-size:16px;--meo-font-source-size:14px;--git-added:#40a060;--git-changed:#4090d0;--git-deleted:#e05252}' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      const editor = (window as any).EditorStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: 'first\ncurrent value\nlast',
        initialMode: 'source',
        initialGitGutter: true,
        onApplyChanges() {}
      });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\noriginal value\nlast'
      });
      (window as any).__editor = editor;
    });
    await page.waitForSelector('.meo-git-overview-ruler-marker');
    await waitForFrames(page);

    const width = await page.$eval(
      '.meo-git-overview-ruler-marker',
      (element) => element.getBoundingClientRect().width
    );
    if (width !== 4) {
      throw new Error(`Git diff overview marker width must be 4px, received ${width}px`);
    }

    const currentText = createTallMermaidFixture('TARGET_CHANGE');
    const baseText = createTallMermaidFixture('TARGET_BASE');
    await page.evaluate(({ current, base }) => {
      (window as any).__editor.destroy();
      document.getElementById('app')!.textContent = '';
      (window as any).mermaid = {
        initialize() {},
        async render() {
          await new Promise((resolve) => setTimeout(resolve, 120));
          return { svg: '<svg width="800" height="1800" viewBox="0 0 800 1800"><rect width="800" height="1800"></rect></svg>' };
        }
      };
      const editor = (window as any).EditorStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: current,
        initialMode: 'live',
        initialGitGutter: true,
        onApplyChanges() {}
      });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: base
      });
      (window as any).__editor = editor;
    }, { current: currentText, base: baseText });

    await page.waitForSelector('.meo-mermaid-block svg[height="1800"]');
    await waitForFrames(page, 16);
    const position = await page.evaluate(async () => {
      const editor = (window as any).__editor;
      editor.scrollToLine(80, 'top');
      for (let index = 0; index < 8; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const scroller = editor.getScrollElement() as HTMLElement;
      const track = document.querySelector<HTMLElement>('.meo-git-overview-ruler')!;
      const marker = track.querySelector<HTMLElement>('.meo-git-overview-ruler-marker')!;
      const targetScrollTop = scroller.scrollTop;
      const mappedScrollTop = Number.parseFloat(marker.style.top) / track.clientHeight * scroller.scrollHeight;
      return {
        targetScrollTop,
        mappedScrollTop,
        contentHeight: scroller.scrollHeight,
        error: Math.abs(mappedScrollTop - targetScrollTop)
      };
    });
    if (position.contentHeight < 3000 || position.error > 100) {
      throw new Error(`Git diff overview marker did not follow visual document geometry: ${JSON.stringify(position)}`);
    }

    console.log('git diff overview ruler checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
