import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-layout-stability-'));

async function waitForFrames(page: Page, count = 10): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-live-layout-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-mutedForeground:#8b949e; --meo-semantic-tableBorder:#3e444d; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:monospace; --meo-font-source-weight:400; --meo-font-source-size:14px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const source = [
      ...Array.from({ length: 80 }, (_, index) => `before ${index + 1}`),
      '<details>',
      '<summary>Visible summary</summary>',
      ...Array.from({ length: 6 }, (_, index) => `details body ${index + 1}`),
      '</details>',
      ...Array.from({ length: 60 }, (_, index) => `stable anchor ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__editor = (window as any).LiveLayoutStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, source);
    await waitForFrames(page);
    await page.evaluate(() => (window as any).__editor.scrollToLine(82, 'top'));
    await waitForFrames(page);

    const beforeTop = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const summaryLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('Visible summary'))!;
      const anchorLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('stable anchor 2'))!;
      const scrollerTop = scroller.getBoundingClientRect().top;
      scroller.scrollTop += summaryLine.getBoundingClientRect().top - scrollerTop + 8;
      return anchorLine.getBoundingClientRect().top;
    });

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const anchor = editor.getText().indexOf('<details>');
      (window as any).LiveLayoutStabilityHarness.toggleCollapsibleSection(editor.view, anchor);
    });
    await waitForFrames(page);

    const afterTop = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find((line) => line.textContent?.includes('stable anchor 2'))?.getBoundingClientRect().top ?? null);
    if (afterTop === null || Math.abs(afterTop - beforeTop) > 1) {
      throw new Error(`Expanding details moved unchanged viewport content: ${beforeTop} -> ${afterTop}`);
    }

    const quoteSource = [
      ...Array.from({ length: 80 }, (_, index) => `before quote ${index + 1}`),
      `> ${'wrapping quoted content '.repeat(18)}`,
      ...Array.from({ length: 60 }, (_, index) => `quote anchor ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      const editor = (window as any).__editor;
      editor.setText(text);
      editor.scrollToLine(81, 'top');
    }, quoteSource);
    await waitForFrames(page);
    const quoteAnchorBeforeTop = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const scroller = editor.view.scrollDOM as HTMLElement;
      const quoteLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('wrapping quoted content'))!;
      const anchorLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('quote anchor 1'))!;
      const scrollerTop = scroller.getBoundingClientRect().top;
      scroller.scrollTop += quoteLine.getBoundingClientRect().top - scrollerTop + 8;
      const quotePosition = editor.getText().indexOf('>') + 1;
      editor.view.dispatch({ selection: { anchor: quotePosition } });
      editor.view.focus();
      return anchorLine.getBoundingClientRect().top;
    });
    await page.keyboard.press('Backspace');
    const quoteAfter = await page.evaluate(async () => {
      const editor = (window as any).__editor;
      const tops: Array<number | null> = [];
      for (let index = 0; index < 12; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const anchorLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .find((line) => line.textContent?.includes('quote anchor 1'));
        tops.push(anchorLine?.getBoundingClientRect().top ?? null);
      }
      return { text: editor.getText(), top: tops.at(-1) ?? null, tops };
    });
    if (quoteAfter.text.includes(`> ${'wrapping quoted content '.repeat(18)}`)) {
      throw new Error('Backspace did not remove the blockquote marker');
    }
    if (quoteAfter.top === null || Math.abs(quoteAfter.top - quoteAnchorBeforeTop) > 1) {
      throw new Error(`Removing a blockquote marker moved unchanged viewport content: ${quoteAnchorBeforeTop} -> ${quoteAfter.top}; frames=${JSON.stringify(quoteAfter.tops)}`);
    }

    const tableSource = [
      ...Array.from({ length: 80 }, (_, index) => `before table ${index + 1}`),
      '| Name | Description |',
      '| --- | --- |',
      `| Alpha | ${'long table content '.repeat(8)} |`,
      '| Beta | Short |',
      ...Array.from({ length: 60 }, (_, index) => `table anchor ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      const editor = (window as any).__editor;
      editor.setText(text);
      editor.view.dispatch({ selection: { anchor: editor.getText().length } });
      const tablePosition = editor.getText().indexOf('| Name |');
      editor.view.scrollDOM.scrollTop = editor.view.lineBlockAt(tablePosition).top + 8;
    }, tableSource);
    await waitForFrames(page);
    const tableBefore = await page.evaluate(() => ({
      shellTop: document.querySelector('.meo-md-html-table-shell')?.getBoundingClientRect().top ?? null,
      followingTop: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('table anchor 1'))?.getBoundingClientRect().top ?? null
    }));
    if (tableBefore.shellTop === null || tableBefore.followingTop === null) {
      throw new Error('Could not locate the table and its following viewport content');
    }
    const firstTableInput = await page.$('.meo-md-html-table-shell tbody textarea');
    if (!firstTableInput) throw new Error('Could not locate an editable Live table cell');
    await firstTableInput.click();
    await firstTableInput.type(' edited');
    await waitForFrames(page);
    const tableAfter = await page.evaluate(() => ({
      shellTop: document.querySelector('.meo-md-html-table-shell')?.getBoundingClientRect().top ?? null,
      followingTop: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('table anchor 1'))?.getBoundingClientRect().top ?? null
    }));
    if (
      tableAfter.shellTop === null || Math.abs(tableAfter.shellTop - tableBefore.shellTop) > 1 ||
      tableAfter.followingTop === null || tableAfter.followingTop < tableBefore.followingTop
    ) {
      throw new Error(`Editing a table did not grow downward in place: ${JSON.stringify({ tableBefore, tableAfter })}`);
    }

    console.log('live layout stability browser tests passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
