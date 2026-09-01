import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-reload-mermaid-viewport-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 10): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let frame = 0; frame < frameCount; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-webview-viewport-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 920, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><body><div id="app"></div></body>');
    await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    const prefix = Array.from({ length: 24 }, (_, index) => `prefix line ${index + 1}`);
    const suffix = Array.from({ length: 100 }, (_, index) => `suffix line ${index + 1}`);
    const mermaidChain = Array.from({ length: 32 }, (_, index) => (
      index === 31 ? '' : `N${index}[Node ${index}] --> N${index + 1}[Node ${index + 1}]`
    )).filter(Boolean);
    const diskText = [
      ...prefix,
      '```mermaid',
      'flowchart TD',
      ...mermaidChain,
      '```',
      ...suffix
    ].join('\n');
    await page.addScriptTag({ content: `
      window.__diskText = ${JSON.stringify(diskText)};
      window.__reloadRequests = [];
      window.__reloadCompletions = [];
      window.__nextReloadId = 1;
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          if (message.type === 'reloadDocumentFromDisk') {
            window.__reloadRequests.push(message);
            const reloadId = window.__nextReloadId++;
            setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: {
              type: 'documentReloadedFromDisk', reloadId, version: reloadId + 1,
              text: window.__diskText, topLine: message.topLine, topLineOffset: message.topLineOffset
            }})), reloadId * 20);
          }
          if (message.type === 'documentReloadPresentationCompleted') {
            window.__reloadCompletions.push(message);
            const generation = window.__reloadCompletions.length;
            setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data: {
              type: 'gitBaselineChanged',
              payload: {
                available: true, tracked: true, mode: 'current-edit', generation,
                baseText: window.__diskText.replace('suffix line 1', 'baseline suffix line 1')
              }
            }})), 0);
          }
        },
        getState() { return undefined; },
        setState() {}
      });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((text) => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///reload-mermaid.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode: 'live',
      uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '',
      previewSourceColoring: true, editorAppearance: 'dark', gitChangesGutter: true,
      gitDiffLineHighlights: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false,
      fixedBaselineActive: false, contentMaxWidthEnabled: false,
      findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right',
      outlineVisible: false, outlineWidth: 260, vscodeTheme: null
    }})), diskText);
    await page.waitForSelector('.meo-mermaid-block');
    await waitForFrames(page, 2);
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-block')!;
      const viewport = scroller.getBoundingClientRect();
      scroller.scrollTop += block.getBoundingClientRect().top - viewport.top + 60;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page);

    for (let cycle = 0; cycle < 6; cycle += 1) {
      await page.click('[data-action="discard"]');
      await page.click('[data-action="discard"]');
    }
    await page.waitForFunction(() => (window as any).__reloadCompletions.length >= 6);
    await waitForFrames(page, 20);
    const result = await page.evaluate(() => ({
      requests: (window as any).__reloadRequests,
      completions: (window as any).__reloadCompletions,
      scrollTop: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop
    }));
    assert.equal(result.requests.length, 6);
    assert.equal(result.completions.length, 6);
    assert.ok(result.completions.every((item: any) => item.presented), 'every disk reload must be presented');
    const lines = result.requests.map((item: any) => item.topLine);
    const offsets = result.requests.map((item: any) => item.topLineOffset);
    assert.ok(
      Math.max(...lines) - Math.min(...lines) <= 1 && Math.max(...offsets) - Math.min(...offsets) <= 2,
      `Repeated disk reloads with Mermaid drifted upward: ${JSON.stringify(result)}`
    );

    await page.click('.meo-mermaid-mode-btn');
    await page.waitForSelector('.meo-mermaid-editing-block.is-split');
    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-split')!;
      const viewport = scroller.getBoundingClientRect();
      scroller.scrollTop += block.getBoundingClientRect().top - viewport.top + 60;
      scroller.dispatchEvent(new Event('scroll'));
    });
    await waitForFrames(page, 4);
    for (let cycle = 0; cycle < 6; cycle += 1) {
      await page.click('[data-action="discard"]');
      await page.click('[data-action="discard"]');
    }
    await page.waitForFunction(() => (window as any).__reloadCompletions.length >= 12);
    await waitForFrames(page, 20);
    const splitResult = await page.evaluate(() => ({
      requests: (window as any).__reloadRequests.slice(6),
      completions: (window as any).__reloadCompletions.slice(6)
    }));
    const splitLines = splitResult.requests.map((item: any) => item.topLine);
    const splitOffsets = splitResult.requests.map((item: any) => item.topLineOffset);
    assert.equal(splitResult.requests.length, 6);
    assert.ok(splitResult.completions.every((item: any) => item.presented));
    assert.ok(
      Math.max(...splitLines) - Math.min(...splitLines) <= 1
        && Math.max(...splitOffsets) - Math.min(...splitOffsets) <= 2,
      `Repeated disk reloads with split Mermaid drifted upward: ${JSON.stringify(splitResult)}`
    );
    console.log('repeated Mermaid disk reload viewport checks passed');
  } finally {
    await closeTestBrowser(browser);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
