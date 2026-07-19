import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-long-code-blocks-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-long-code-blocks-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 720, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-code-background:#292d31; --meo-semantic-mutedForeground:#8b949e; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const languageLines = Array.from({ length: 19 }, (_, index) => `const line${index + 1} = ${index + 1};`);
    const shortLines = Array.from({ length: 18 }, (_, index) => `const short${index + 1} = ${index + 1};`);
    const plainLines = Array.from({ length: 19 }, (_, index) => `plain ${index + 1}`);
    const mermaidLines = Array.from({ length: 19 }, (_, index) => `A${index}-->B${index}`);
    const text = [
      '```js',
      ...languageLines,
      '```',
      '',
      '```',
      ...plainLines,
      '```',
      '',
      '```mermaid',
      ...mermaidLines,
      '```',
      '',
      '```ts',
      ...shortLines,
      '```'
    ].join('\n');

    await page.evaluate((content) => {
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, text);
    await waitForFrames(page);

    const initial = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      expandText: document.querySelector('.meo-md-long-code-placeholder')?.textContent ?? '',
      footerCount: document.querySelectorAll('.meo-md-long-code-footer').length,
      visibleCodeLines: document.querySelectorAll('.meo-md-code-line-numbered').length
    }));
    if (initial.placeholders !== 1) {
      throw new Error(`Expected one collapsed language code block, got ${JSON.stringify(initial)}`);
    }
    if (initial.expandText.trim() !== 'Show 9 more lines') {
      throw new Error(`Unexpected expand label: ${JSON.stringify(initial.expandText)}`);
    }
    const actionUserSelect = await page.$eval(
      '.meo-md-long-code-placeholder .meo-long-code-action',
      (element) => getComputedStyle(element).userSelect
    );
    if (actionUserSelect !== 'none') {
      throw new Error(`Long code action text remains selectable: ${JSON.stringify(actionUserSelect)}`);
    }
    const actionBorderWidth = await page.$eval(
      '.meo-md-long-code-placeholder .meo-long-code-action',
      (element) => getComputedStyle(element).borderTopWidth
    );
    if (actionBorderWidth !== '0px') {
      throw new Error(`Fixed long code action retained an outer border: ${JSON.stringify(actionBorderWidth)}`);
    }
    if (initial.footerCount !== 0) {
      throw new Error(`Collapsed block unexpectedly has an expanded footer: ${JSON.stringify(initial)}`);
    }
    const initialVisibleText = await page.$eval('.cm-content', (element) => element.textContent ?? '');
    if (!initialVisibleText.includes('const line10 = 10;') || initialVisibleText.includes('const line11 = 11;')) {
      throw new Error('Collapsed block did not preserve exactly the first 10 code lines');
    }

    const placeholderWhitespace = await page.$eval('.meo-md-long-code-placeholder', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 12, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(placeholderWhitespace.x, placeholderWhitespace.y);
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 1) {
      throw new Error('Clicking placeholder whitespace unexpectedly expanded the code block');
    }

    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await waitForFrames(page);
    const expanded = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      footerCount: document.querySelectorAll('.meo-md-long-code-footer').length,
      footerText: document.querySelector('.meo-md-long-code-footer')?.textContent ?? ''
    }));
    if (expanded.placeholders !== 0 || expanded.footerCount !== 1 || expanded.footerText.trim() !== 'Show less') {
      throw new Error(`Manual expansion failed: ${JSON.stringify(expanded)}`);
    }
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.selectAll();
    });
    await waitForFrames(page);
    await page.click('.meo-md-long-code-footer .meo-long-code-action');
    await waitForFrames(page);
    const collapsedAgain = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      footerCount: document.querySelectorAll('.meo-md-long-code-footer').length,
      selectionEmpty: (window as any).__longCodeBlocksEditor.view.state.selection.main.empty,
      nativeSelectionText: window.getSelection()?.toString() ?? ''
    }));
    if (
      collapsedAgain.placeholders !== 1 ||
      collapsedAgain.footerCount !== 0 ||
      !collapsedAgain.selectionEmpty ||
      collapsedAgain.nativeSelectionText.includes('Show 9 more lines')
    ) {
      throw new Error(`Manual collapse failed: ${JSON.stringify(collapsedAgain)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const source = editor.view.state.doc.toString();
      const closing = source.lastIndexOf('```');
      editor.view.dispatch({ changes: { from: closing, insert: 'const short19 = 19;\n' } });
    });
    await waitForFrames(page, 12);
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.view.scrollDOM.scrollTop = editor.view.scrollDOM.scrollHeight;
    });
    await waitForFrames(page);
    const grownShortBlock = await page.evaluate(() => ({
      footers: document.querySelectorAll('.meo-md-long-code-footer').length
    }));
    if (grownShortBlock.footers !== 1) {
      throw new Error(`Short-to-long block was auto-collapsed or missing footer: ${JSON.stringify(grownShortBlock)}`);
    }
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.view.scrollDOM.scrollTop = 0;
    });
    await waitForFrames(page);
    const originalBlock = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length
    }));
    if (originalBlock.placeholders !== 1) {
      throw new Error(`Original long block lost its collapsed state: ${JSON.stringify(originalBlock)}`);
    }

    const firstVisibleLine = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll('.meo-md-code-line-numbered'))
        .find((element) => element.textContent?.includes('const line1 = 1;'));
      const rect = line?.getBoundingClientRect();
      return rect ? { x: rect.left + 8, y: rect.top + rect.height / 2 } : null;
    });
    if (!firstVisibleLine) {
      throw new Error('Could not locate a visible line in the collapsed code block');
    }
    await page.mouse.click(firstVisibleLine.x, firstVisibleLine.y);
    await waitForFrames(page);
    const clickExpanded = await page.evaluate(() => ({
      placeholders: document.querySelectorAll('.meo-md-long-code-placeholder').length,
      footers: document.querySelectorAll('.meo-md-long-code-footer').length
    }));
    if (clickExpanded.placeholders !== 0 || clickExpanded.footers !== 1) {
      throw new Error(`Clicking visible code did not expand the block: ${JSON.stringify(clickExpanded)}`);
    }

    const searchBlock = (name: string) => [
      '```js',
      ...Array.from({ length: 24 }, (_, index) => (
        index === 14 ? `const needle = '${name}';` : `const ${name}${index + 1} = ${index + 1};`
      )),
      '```'
    ];
    const searchText = [
      ...searchBlock('first'),
      '',
      ...Array.from({ length: 8 }, (_, index) => `between ${index + 1}`),
      '',
      ...searchBlock('second')
    ].join('\n');
    await page.evaluate((content) => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, searchText);
    await waitForFrames(page);

    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.setSearchQuery('needle');
      editor.findNext('needle', { focusEditor: false });
    });
    await waitForFrames(page);
    if (await page.$eval('.meo-md-long-code-footer', (element) => element.textContent?.trim()) !== 'Show less') {
      throw new Error('Search did not temporarily expand the first matching code block');
    }

    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.findNext('needle', { focusEditor: false });
    });
    await waitForFrames(page);
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.view.scrollDOM.scrollTop = 0;
    });
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-placeholder', (elements) => elements.length) !== 1) {
      throw new Error('Moving search to another block did not collapse the previous temporary expansion');
    }

    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.findPrevious('needle', { focusEditor: false });
    });
    await waitForFrames(page);
    const searchMatchLine = await page.evaluate(() => {
      const match = document.querySelector('.meo-search-match-active');
      const rect = match?.getBoundingClientRect();
      return rect ? { x: rect.left + 2, y: rect.top + rect.height / 2 } : null;
    });
    if (!searchMatchLine) {
      throw new Error('Could not locate the active search match inside the expanded block');
    }
    await page.mouse.click(searchMatchLine.x, searchMatchLine.y);
    await waitForFrames(page);
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.findNext('needle', { focusEditor: false });
    });
    await waitForFrames(page);
    await page.evaluate(() => {
      (window as any).__longCodeBlocksEditor.view.scrollDOM.scrollTop = 0;
    });
    await waitForFrames(page);
    if (await page.$$eval('.meo-md-long-code-footer', (elements) => elements.length) !== 1) {
      throw new Error('Clicking a search-expanded block did not promote it to a manual expansion');
    }

    const tallText = [
      '```js',
      ...Array.from({ length: 100 }, (_, index) => `const tall${index + 1} = ${index + 1};`),
      '```',
      '',
      ...Array.from({ length: 40 }, (_, index) => `after block ${index + 1}`)
    ].join('\n');
    await page.evaluate((content) => {
      const editor = (window as any).__longCodeBlocksEditor;
      editor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__longCodeBlocksEditor = (window as any).LongCodeBlocksHarness.createEditor({
        parent: document.getElementById('app')!,
        text: content,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, tallText);
    await waitForFrames(page);
    const tallFirstLine = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll('.meo-md-code-line-numbered'))
        .find((element) => element.textContent?.includes('const tall1 = 1;'));
      const rect = line?.getBoundingClientRect();
      return rect ? { x: rect.left + 8, y: rect.top + rect.height / 2 } : null;
    });
    if (!tallFirstLine) {
      throw new Error('Could not locate the tall code block');
    }
    const fixedControlCenter = await page.$eval('.meo-md-long-code-placeholder', (element) => {
      const rect = element.getBoundingClientRect();
      return rect.left + rect.width / 2;
    });
    await page.mouse.click(tallFirstLine.x, tallFirstLine.y);
    await waitForFrames(page);
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('const tall5');
      const block = editor.view.lineBlockAt(position);
      editor.view.scrollDOM.scrollTop = Math.max(0, block.top - 20);
    });
    await waitForFrames(page);
    const visibleCollapseScrollTop = await page.$eval('.cm-scroller', (element) => element.scrollTop);
    await page.click('.meo-long-code-floating-action');
    await waitForFrames(page);
    const preservedScrollTop = await page.$eval('.cm-scroller', (element) => element.scrollTop);
    if (Math.abs(preservedScrollTop - visibleCollapseScrollTop) > 1) {
      throw new Error(`Collapsing a still-visible block changed the scroll position: ${JSON.stringify({ visibleCollapseScrollTop, preservedScrollTop })}`);
    }
    await page.click('.meo-md-long-code-placeholder .meo-long-code-action');
    await waitForFrames(page);
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('const tall100');
      const block = editor.view.lineBlockAt(position);
      editor.view.scrollDOM.scrollTop = block.top - editor.view.scrollDOM.clientHeight + 80;
    });
    await waitForFrames(page);
    const fixedFooterState = await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
      const footer = document.querySelector('.meo-md-long-code-footer')?.getBoundingClientRect();
      const floating = document.querySelector<HTMLButtonElement>('.meo-long-code-floating-action');
      return {
        footerVisible: Boolean(footer && footer.bottom >= scroller.top && footer.top <= scroller.bottom),
        floatingVisible: Boolean(floating && !floating.hidden)
      };
    });
    if (!fixedFooterState.footerVisible || fixedFooterState.floatingVisible) {
      throw new Error(`Floating button overlapped the visible fixed footer: ${JSON.stringify(fixedFooterState)}`);
    }
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('const tall50');
      const block = editor.view.lineBlockAt(position);
      editor.view.scrollDOM.scrollTop = block.top - editor.view.scrollDOM.clientHeight / 2;
    });
    await waitForFrames(page);
    const floatingInsideBlock = await page.$eval('.meo-long-code-floating-action', (button: HTMLButtonElement) => !button.hidden);
    if (!floatingInsideBlock) {
      throw new Error('Floating collapse button was not shown while viewport bottom was inside an expanded block');
    }
    const floatingHorizontalOffset = await page.evaluate(() => {
      const floating = document.querySelector('.meo-long-code-floating-action')!.getBoundingClientRect();
      return floating.left + floating.width / 2;
    }).then((floatingCenter) => Math.abs(floatingCenter - fixedControlCenter));
    if (floatingHorizontalOffset > 1) {
      throw new Error(`Floating collapse button was not centered over the code content: ${floatingHorizontalOffset}`);
    }
    await page.click('.meo-long-code-floating-action');
    await waitForFrames(page);
    const collapsedBlockVisible = await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
      const candidates = [
        ...Array.from(document.querySelectorAll('.meo-md-code-line-numbered'))
          .filter((element) => element.textContent?.includes('const tall')),
        document.querySelector('.meo-md-long-code-placeholder')
      ].filter((element): element is Element => Boolean(element));
      return candidates.some((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom >= scroller.top && rect.top <= scroller.bottom;
      });
    });
    if (!collapsedBlockVisible) {
      throw new Error('Collapsing from a deep scroll left the entire code block outside the viewport');
    }
    await page.evaluate(() => {
      const editor = (window as any).__longCodeBlocksEditor;
      const position = editor.view.state.doc.toString().indexOf('after block 20');
      const block = editor.view.lineBlockAt(position);
      editor.view.scrollDOM.scrollTop = block.top - editor.view.scrollDOM.clientHeight / 2;
    });
    await waitForFrames(page);
    const floatingInProse = await page.$eval('.meo-long-code-floating-action', (button: HTMLButtonElement) => !button.hidden);
    if (floatingInProse) {
      throw new Error('Floating collapse button remained visible when viewport bottom moved into prose');
    }

    console.log('long code block checks passed');
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
