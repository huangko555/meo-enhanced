import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-production-live-scroll-integrity-'));
const documentArgument = process.argv.find((argument) => argument.startsWith('--document='));
if (!documentArgument) throw new Error('Expected --document=<absolute markdown path>');
const source = fs.readFileSync(documentArgument.slice('--document='.length), 'utf8');

async function waitForFrames(page: Page, count: number): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function assertVisibleIntegrity(page: Page, step: string, failOnMismatch = true): Promise<void> {
  const result = await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
    const content = scroller.querySelector<HTMLElement>('.cm-content')!;
    const viewport = scroller.getBoundingClientRect();
    const sourceLines = String((window as any).__integritySource).split(/\r?\n/);
    const uniqueLines = new Map<string, number | null>();
    const fencedLines = new Set<number>();
    let openFence: { marker: '`' | '~'; length: number } | null = null;
    sourceLines.forEach((line, index) => {
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (openFence) {
        fencedLines.add(index + 1);
        if (
          fence
          && fence[1]![0] === openFence.marker
          && fence[1]!.length >= openFence.length
          && fence[2]!.trim() === ''
        ) {
          openFence = null;
        }
      } else if (fence) {
        openFence = { marker: fence[1]![0] as '`' | '~', length: fence[1]!.length };
        fencedLines.add(index + 1);
      }
      const text = line.trim();
      if (!text) return;
      uniqueLines.set(text, uniqueLines.has(text) ? null : index + 1);
    });
    const gutters = Array.from(
      scroller.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')
    ).map((element) => ({
      line: Number(element.textContent?.trim()),
      rect: element.getBoundingClientRect()
    })).filter((item) => Number.isFinite(item.line));
    const mismatches: Array<Record<string, unknown>> = [];
    const invalidStyles: Array<Record<string, unknown>> = [];
    const visibleText: string[] = [];
    for (const line of content.querySelectorAll<HTMLElement>('.cm-line')) {
      const rect = line.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) continue;
      const text = line.innerText.trim();
      if (text) visibleText.push(text);
      const expectedLine = uniqueLines.get(text);
      if (!expectedLine) continue;
      const sourceText = sourceLines[expectedLine - 1]?.trim() ?? '';
      if (fencedLines.has(expectedLine)) continue;
      const heading = /^(#{1,6})\s/.exec(sourceText);
      if (heading && !line.classList.contains(`meo-md-h${heading[1].length}`)) {
        invalidStyles.push({ text, expectedLine, missing: `meo-md-h${heading[1].length}` });
      }
      if (/\*\*[^*]+\*\*/.test(sourceText) && !line.querySelector('.meo-md-strong')) {
        invalidStyles.push({ text, expectedLine, missing: 'meo-md-strong' });
      }
      const center = rect.top + rect.height / 2;
      const gutter = gutters.reduce<typeof gutters[number] | null>((closest, item) => {
        if (!closest) return item;
        const distance = Math.abs(item.rect.top + item.rect.height / 2 - center);
        const closestDistance = Math.abs(closest.rect.top + closest.rect.height / 2 - center);
        return distance < closestDistance ? item : closest;
      }, null);
      if (gutter && Math.abs(gutter.line - expectedLine) > 3) {
        mismatches.push({ text, expectedLine, gutterLine: gutter.line });
      }
    }
    const invalidBlocks = Array.from(content.querySelectorAll<HTMLElement>(
      '.meo-md-html-table-shell,.meo-mermaid-block,.meo-md-html-block,.meo-md-math-fenced-display'
    )).filter((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.bottom <= viewport.top || rect.top >= viewport.bottom) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
      if (element.classList.contains('meo-md-html-table-shell')) {
        return !element.querySelector('table') || element.querySelectorAll('th,td').length === 0;
      }
      return false;
    }).map((element) => ({
      kind: element.dataset.meoRenderedBlockKind ?? element.className,
      startLine: element.dataset.meoRenderedBlockStartLine ?? null,
      height: element.getBoundingClientRect().height
    }));
    return {
      mismatches, invalidBlocks, invalidStyles,
      visibleText: visibleText.slice(0, 12), scrollTop: scroller.scrollTop
    };
  });
  if ((result.mismatches.length || result.invalidBlocks.length || result.invalidStyles.length) && failOnMismatch) {
    throw new Error(`Production Live integrity failed at ${step}: ${JSON.stringify(result)}`);
  }
  if (result.mismatches.length || result.invalidBlocks.length || result.invalidStyles.length) {
    console.warn(`Transient production Live mismatch at ${step}: ${JSON.stringify(result)}`);
  }
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-production-live-scroll-integrity-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) => console.error(error));
    await page.setViewport({ width: 1490, height: 960, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><body class="vscode-dark"><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar" role="presentation" aria-hidden="true"></div>
      <div class="editor-wrapper meo-preload-editor-shell" role="presentation" aria-hidden="true">
        <div class="editor-host"></div>
      </div>
    </div></body>`);
    await page.addStyleTag({
      content: ':root{--vscode-editor-background:#24292e;--vscode-editor-foreground:#e6edf3;--vscode-sideBar-background:#20252a;--vscode-panel-border:#3e444d;--vscode-toolbar-hoverBackground:#30363d}html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}'
    });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.__hostMessages=[];
      window.acquireVsCodeApi=()=>({
        postMessage(message){window.__hostMessages.push(message)},
        getState(){return window.__webviewState},
        setState(state){window.__webviewState=state}
      });
      window.mermaid={
        initialize(){},
        async render(id, source){
          await new Promise(resolve=>setTimeout(resolve, source.includes('sequenceDiagram')?180:90));
          const height=source.includes('sequenceDiagram')?320:190;
          return {svg:'<svg width="800" height="'+height+'" viewBox="0 0 800 '+height+'"><rect width="180" height="80"></rect></svg>'};
        }
      };
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((text) => {
      (window as any).__integritySource = text;
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///production-live-scroll-integrity.md', text, version: 1,
        savedRevision: { version: 1, text }, diagnostics: [], mode: 'live',
        uiLanguage: 'zh-CN', sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '',
        previewSourceColoring: true, editorAppearance: 'dark', gitChangesGutter: false,
        gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false,
        fixedBaselineActive: false, contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right',
        outlineVisible: true, outlineWidth: 300, vscodeTheme: null
      }}));
    }, source);
    await page.waitForSelector('.editor-host > .cm-editor .cm-scroller');
    await waitForFrames(page, 1);

    await page.mouse.move(700, 500);
    await page.evaluate(() => {
      const items = document.querySelectorAll<HTMLButtonElement>('.outline-item');
      items[items.length - 1]?.click();
    });
    await waitForFrames(page, 1);
    await assertVisibleIntegrity(page, 'initial-outline-jump-frame-1');
    await waitForFrames(page, 2);
    await assertVisibleIntegrity(page, 'initial-outline-jump-frame-3', false);
    await waitForFrames(page, 5);
    await assertVisibleIntegrity(page, 'initial-outline-jump-settled');
    for (let step = 0; step < 180; step += 1) {
      const top = await page.$eval('.editor-host > .cm-editor .cm-scroller', (element) => element.scrollTop);
      if (top <= 1) break;
      await page.mouse.wheel({ deltaY: -100 });
      await waitForFrames(page, 1);
      await assertVisibleIntegrity(page, `initial-reverse-${step}`);
    }
    for (let step = 0; step < 180; step += 1) {
      const before = await page.$eval('.editor-host > .cm-editor .cm-scroller', (element) => ({
        top: element.scrollTop,
        max: element.scrollHeight - element.clientHeight
      }));
      if (before.top >= before.max - 1) break;
      await page.mouse.wheel({ deltaY: 100 });
      await waitForFrames(page, 1);
      await assertVisibleIntegrity(page, `forward-${step}`);
    }
    console.log('production Live full-document scroll integrity test passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
