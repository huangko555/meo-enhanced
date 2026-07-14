import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-webview-viewport-'));

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

async function waitForFrames(page: puppeteer.Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

function createFixture(): string {
  const lines = Array.from({ length: 280 }, (_, index) => `stable line ${index + 1}`);
  lines[77] = '## Short Mermaid';
  lines[78] = '```mermaid';
  lines[79] = 'flowchart LR';
  lines[80] = '  Start --> Done';
  lines[81] = '```';
  lines[108] = '```mermaid';
  lines[109] = 'sequenceDiagram';
  lines[110] = '  User->>Editor: Update';
  lines[111] = '  Editor-->>User: Render';
  lines[112] = '```';
  lines[132] = '```typescript';
  for (let index = 133; index <= 220; index += 1) lines[index] = `const line${index - 132} = ${index - 132};`;
  lines[221] = '```';
  return lines.join('\n');
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-webview-viewport-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await puppeteer.launch({
    executablePath: findBrowserExecutable(),
    headless: true,
    args: ['--no-sandbox']
  });
  try {
    const page = await browser.newPage();
    page.on('console', (message) => console.log(message.text()));
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><body><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar" role="presentation" aria-hidden="true"></div>
      <div class="editor-wrapper meo-preload-editor-shell" role="presentation" aria-hidden="true">
        <div class="editor-host"></div>
      </div>
    </div></body>`);
    await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.__hostMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return window.__webviewState; },
        setState(state) { window.__webviewState = state; }
      });
      window.mermaid = {
        initialize() {},
        async render(id, source) {
          await new Promise(resolve => setTimeout(resolve, source.includes('Check') ? 80 : 5));
          const height = source.includes('Step18') ? 640 : source.includes('sequenceDiagram') ? 260 : 120;
          return { svg: '<svg width="800" height="' + height + '" viewBox="0 0 800 ' + height + '"></svg>' };
        }
      };
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const initialText = createFixture();
    await page.evaluate(({ text, theme }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', text, version: 1, diagnostics: [], mode: 'live',
        lineNumbers: true, gitChangesGutter: false, gitDiffLineHighlights: false,
        spellCheckEnabled: false, contentMaxWidthEnabled: false,
        vimMode: false, vimKeybindings: [], vimLeader: '\\',
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        theme, shikiCodeBlocks: false, codeTheme: null,
        restoreTopLine: 139, restoreTopLineOffset: 0
      }}));
    }, { text: initialText, theme: defaultThemeSettings });
    await page.waitForSelector('.editor-host > .cm-editor');
    await new Promise((resolve) => setTimeout(resolve, 120));
    await waitForFrames(page);
    const readViewport = () => page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!;
      const viewport = scroller.getBoundingClientRect();
      const visibleCodeLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .map((line) => ({ text: line.textContent ?? '', rect: line.getBoundingClientRect() }))
        .filter(({ text, rect }) => text.startsWith('const line') && rect.bottom > viewport.top && rect.top < viewport.bottom)
        .sort((left, right) => left.rect.top - right.rect.top)[0];
      return {
        text: visibleCodeLine?.text ?? null,
        top: visibleCodeLine?.rect.top ?? null,
        scrollTop: scroller.scrollTop
      };
    });

    const before = await readViewport();
    const updatedText = initialText.replace('Start --> Done', 'Start --> Check --> Done');
    await page.evaluate((text) => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'docChanged', text, version: 2 } }));
      const selection = text.indexOf('const line6');
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'revealSelection', anchor: selection, head: selection, focus: false, preserveViewport: true
      }}));
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } }));
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    }, updatedText);
    await page.keyboard.down('Control');
    await page.keyboard.press('s');
    await page.keyboard.up('Control');
    await waitForFrames(page, 1);
    const afterUpdate = await readViewport();

    await page.mouse.move(450, 260);
    const wheelScrollTops: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      await page.mouse.wheel({ deltaY: -80 });
      await waitForFrames(page, 1);
      wheelScrollTops.push(await page.evaluate(() =>
        document.querySelector<HTMLElement>('.editor-host > .cm-editor .cm-scroller')!.scrollTop
      ));
    }
    await new Promise((resolve) => setTimeout(resolve, 180));
    await waitForFrames(page);
    const afterUpwardScroll = await readViewport();

    const lineNumber = (value: string | null): number | null => {
      const match = value?.match(/^const line(\d+)/);
      return match ? Number(match[1]) : null;
    };
    const beforeLine = lineNumber(before.text);
    const afterUpdateLine = lineNumber(afterUpdate.text);
    const wheelMovedOnlyUp = wheelScrollTops.every((scrollTop, index) => (
      scrollTop <= (index === 0 ? afterUpdate.scrollTop : wheelScrollTops[index - 1]) + 0.5
    ));
    if (
      beforeLine === null || afterUpdateLine === null ||
      beforeLine > 12 ||
      Math.abs(afterUpdateLine - beforeLine) > 1 || !wheelMovedOnlyUp
    ) {
      throw new Error(`Implicit webview updates moved the visual anchor: ${JSON.stringify({ before, afterUpdate, wheelScrollTops, afterUpwardScroll })}`);
    }
    console.log('webview viewport checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
