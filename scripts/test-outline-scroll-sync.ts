import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-outline-scroll-sync-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

function createDocument(): string {
  const lines = Array.from({ length: 120 }, (_, index) => `content line ${index + 1}`);
  lines[0] = '# First heading';
  lines[30] = '# Second heading';
  lines[60] = '# Third heading';
  lines[90] = '# Fourth heading';
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
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root{--meo-background:#202223;--meo-foreground:#e6edf3;--meo-font-live:Arial;--meo-font-source:monospace;--meo-font-live-size:16px;--meo-font-source-size:14px;--meo-line-height-live:1.5;--meo-line-height-source:1.5;--meo-semantic-mutedForeground:#7d8794;--meo-semantic-headingForeground:#79b8ff}' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((text) => { (window as any).__outlineDocument = text; }, createDocument());

    for (const mode of ['source', 'live'] as const) {
      await page.evaluate((nextMode) => {
        const root = document.getElementById('app')!;
        root.replaceChildren();
        const editorWrapper = document.createElement('div');
        editorWrapper.className = 'editor-wrapper';
        editorWrapper.style.height = '100%';
        const editorHost = document.createElement('div');
        editorHost.className = 'editor-host';
        editorHost.style.height = '100%';
        const outlineButton = document.createElement('button');
        root.appendChild(editorWrapper);
        editorWrapper.appendChild(editorHost);
        const editor = (window as any).EditorStabilityHarness.createEditor({
          parent: editorHost,
          text: (window as any).__outlineDocument,
          initialMode: nextMode,
          initialGitGutter: false,
          onApplyChanges() {}
        });
        const outline = (window as any).EditorStabilityHarness.createOutlineController({
          root,
          editorWrapper,
          outlineButton,
          getEditor: () => editor
        });
        editorWrapper.appendChild(outline.sidebar);
        outline.setVisible(true);
        (window as any).__outlineEditor = editor;
      }, mode);
      await waitForFrames(page, 12);

      const initialHeading = await page.$eval('.outline-item.is-visible-first', (element) => element.textContent?.trim() ?? '');
      await page.evaluate(() => (window as any).__outlineEditor.scrollToLine(91, 'top'));
      await waitForFrames(page, 12);
      const scrolledHeading = await page.$eval('.outline-item.is-visible-first', (element) => element.textContent?.trim() ?? '');
      if (initialHeading === scrolledHeading || scrolledHeading !== 'Fourth heading') {
        throw new Error(`Outline did not follow ${mode} scrolling: ${JSON.stringify({ initialHeading, scrolledHeading })}`);
      }
    }

    console.log('outline scroll sync checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
