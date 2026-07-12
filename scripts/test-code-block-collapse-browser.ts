import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-code-block-collapse-'));

function findBrowserExecutable(): string {
  const candidates = [
    process.env.MEO_TEST_BROWSER,
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter((candidate): candidate is string => Boolean(candidate));
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) {
    throw new Error('No supported browser found. Set MEO_TEST_BROWSER to a Chrome or Edge executable.');
  }
  return executable;
}

async function waitForFrames(page: puppeteer.Page, frames = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, frames);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-code-block-collapse-entry.ts')],
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
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-caret:#e6edf3; --meo-code-background:#292d31; --meo-semantic-codeCopyForeground:#b9d8ff; --meo-semantic-codeCopyBackground:#344454; --meo-semantic-codeCopyHoverForeground:#ffffff; --meo-semantic-codeCopyHoverBackground:#42637d; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const initial = await page.evaluate(() => {
      const typedLines = Array.from({ length: 100 }, (_, index) => (
        index === 99 ? 'const SEARCH_NEEDLE = true;' : `const line${index + 1} = ${index + 1};`
      )).join('\n');
      const mermaidLines = Array.from({ length: 13 }, (_, index) => `A-->B${index + 1}`).join('\n');
      const mathLines = Array.from({ length: 13 }, (_, index) => `x_${index + 1}`).join('\n');
      const plainLines = Array.from({ length: 13 }, (_, index) => `plain ${index + 1}`).join('\n');
      const leadingLines = Array.from({ length: 30 }, (_, index) => `lead ${index + 1}`);
      const text = [
        ...leadingLines,
        'outside target',
        '```ts', typedLines, '```',
        '```mermaid', mermaidLines, '```',
        '```math', mathLines, '```',
        '```', plainLines, '```'
      ].join('\n');
      const editor = (window as any).CodeBlockCollapseHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__codeBlockCollapseEditor = editor;
      return { lineCount: editor.view.state.doc.lines };
    });
    await waitForFrames(page);

    const collapsed = await page.evaluate(() => ({
      footerCount: document.querySelectorAll('.meo-code-block-collapse-footer').length,
      collapsedFooterCount: document.querySelectorAll('.meo-code-block-collapse-footer.is-collapsed').length,
      footerText: document.querySelector<HTMLElement>('.meo-code-block-collapse-footer')?.innerText ?? '',
      hiddenLineVisible: Array.from(document.querySelectorAll('.cm-line')).some((line) => line.textContent?.includes('SEARCH_NEEDLE'))
    }));
    if (collapsed.footerCount !== 1 || collapsed.collapsedFooterCount !== 1 || !collapsed.footerText.includes('Show 88 more lines') || collapsed.hiddenLineVisible) {
      throw new Error(`Unexpected collapsed state: ${JSON.stringify(collapsed)}`);
    }

    const anchorBeforeExpand = await page.evaluate(() => {
      const editor = (window as any).__codeBlockCollapseEditor;
      const anchorLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === 'lead 20');
      if (!anchorLine) throw new Error('Scroll anchor line was not rendered');
      editor.view.scrollDOM.scrollTop = Math.max(0, editor.view.lineBlockAt(editor.view.posAtDOM(anchorLine)).top - 8);
      return anchorLine.getBoundingClientRect().top;
    });

    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.meo-code-block-collapse-button')?.click();
    });
    await waitForFrames(page);
    const manualExpanded = await page.evaluate(() => ({
      expandedFooterCount: document.querySelectorAll('.meo-code-block-collapse-floating').length,
      footerText: document.querySelector<HTMLElement>('.meo-code-block-collapse-floating')?.innerText ?? '',
      anchorTop: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === 'lead 20')?.getBoundingClientRect().top ?? null,
      footerBottom: document.querySelector<HTMLElement>('.meo-code-block-collapse-floating')?.getBoundingClientRect().bottom ?? null,
      scrollerBottom: (window as any).__codeBlockCollapseEditor.view.scrollDOM.getBoundingClientRect().bottom
    }));
    if (
      manualExpanded.expandedFooterCount !== 1
      || !manualExpanded.footerText.includes('Collapse code')
      || manualExpanded.anchorTop === null
      || Math.abs(manualExpanded.anchorTop - anchorBeforeExpand) > 1
      || manualExpanded.footerBottom === null
      || manualExpanded.footerBottom > manualExpanded.scrollerBottom + 1
    ) {
      throw new Error(`Manual expansion failed: ${JSON.stringify(manualExpanded)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__codeBlockCollapseEditor;
      const deepPosition = editor.view.state.doc.toString().indexOf('const line70 = 70;');
      if (deepPosition < 0) throw new Error('Long code block fixture was missing its middle line');
      editor.view.scrollDOM.scrollTop = Math.max(0, editor.view.lineBlockAt(deepPosition).top - 80);
    });
    await waitForFrames(page);
    const persistentFooter = await page.evaluate(() => {
      const editor = (window as any).__codeBlockCollapseEditor;
      const deepLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === 'const line70 = 70;');
      if (!deepLine) throw new Error('Long code block did not render its middle lines');
      const footer = document.querySelector<HTMLElement>('.meo-code-block-collapse-floating');
      const scroller = editor.view.scrollDOM;
      if (!footer) throw new Error('Expanded code block footer disappeared');
      return {
        footerTop: footer.getBoundingClientRect().top,
        footerBottom: footer.getBoundingClientRect().bottom,
        scrollerTop: scroller.getBoundingClientRect().top,
        scrollerBottom: scroller.getBoundingClientRect().bottom
      };
    });
    if (
      persistentFooter.footerTop < persistentFooter.scrollerTop - 1
      || persistentFooter.footerBottom > persistentFooter.scrollerBottom + 1
    ) {
      throw new Error(`Expanded footer was not kept visible: ${JSON.stringify(persistentFooter)}`);
    }

    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.meo-code-block-collapse-button')?.click();
    });
    await waitForFrames(page);
    const manuallyCollapsed = await page.evaluate(() => ({
      collapsedFooterCount: document.querySelectorAll('.meo-code-block-collapse-footer.is-collapsed').length,
      hiddenLineVisible: Array.from(document.querySelectorAll('.cm-line')).some((line) => line.textContent?.includes('const line70 = 70;'))
    }));
    if (
      manuallyCollapsed.collapsedFooterCount !== 1
      || manuallyCollapsed.hiddenLineVisible
    ) {
      throw new Error(`Manual collapse failed: ${JSON.stringify(manuallyCollapsed)}`);
    }

    await page.evaluate(() => {
      (window as any).__codeBlockCollapseEditor.findNext('SEARCH_NEEDLE', { focusEditor: false });
    });
    await waitForFrames(page, 12);
    const searchExpanded = await page.evaluate(() => ({
      hiddenLineVisible: Array.from(document.querySelectorAll('.cm-line')).some((line) => line.textContent?.includes('SEARCH_NEEDLE')),
      collapsedFooterCount: document.querySelectorAll('.meo-code-block-collapse-footer.is-collapsed').length
    }));
    if (!searchExpanded.hiddenLineVisible || searchExpanded.collapsedFooterCount !== 0) {
      throw new Error(`Search did not reveal hidden code: ${JSON.stringify(searchExpanded)}`);
    }

    await page.evaluate(() => {
      (window as any).__codeBlockCollapseEditor.findNext('outside target', { focusEditor: false });
    });
    await waitForFrames(page, 12);
    const searchReleased = await page.evaluate(() => ({
      hiddenLineVisible: Array.from(document.querySelectorAll('.cm-line')).some((line) => line.textContent?.includes('SEARCH_NEEDLE')),
      collapsedFooterCount: document.querySelectorAll('.meo-code-block-collapse-footer.is-collapsed').length
    }));
    if (searchReleased.hiddenLineVisible || searchReleased.collapsedFooterCount !== 1) {
      throw new Error(`Search release did not restore the collapsed state: ${JSON.stringify(searchReleased)}`);
    }

    await page.evaluate(() => {
      (window as any).__codeBlockCollapseEditor.findNext('SEARCH_NEEDLE', { focusEditor: false });
    });
    await waitForFrames(page, 12);
    await page.evaluate(() => {
      (window as any).__codeBlockCollapseEditor.setSearchQuery('');
    });
    await waitForFrames(page, 12);
    const clearedSearch = await page.evaluate(() => ({
      hiddenLineVisible: Array.from(document.querySelectorAll('.cm-line')).some((line) => line.textContent?.includes('SEARCH_NEEDLE')),
      collapsedFooterCount: document.querySelectorAll('.meo-code-block-collapse-footer.is-collapsed').length
    }));
    if (clearedSearch.hiddenLineVisible || clearedSearch.collapsedFooterCount !== 1) {
      throw new Error(`Clearing search did not restore the collapsed state: ${JSON.stringify(clearedSearch)}`);
    }

    if (initial.lineCount < 160) throw new Error('The code block collapse fixture was incomplete');
    console.log('code block collapse browser checks passed');
  } finally {
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
