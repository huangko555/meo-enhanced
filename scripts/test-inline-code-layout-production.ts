import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import { buildExportStyles, buildPreviewStyles } from '../src/export/exportStyles';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-inline-code-layout-'));
const markdown = [
  'Paragraph `abc` after.',
  '',
  '> Quote `abc` after.',
  '',
  '- List `abc` after.',
  '',
  '# Heading `abc`',
  '',
  '**Bold `abc`** and [link `abc`](#target).',
  '',
  'Two ticks ``a`b`` and three ticks ```a``b```.',
  '',
  'HTML <code>abc</code> after.',
  '',
  '| `abc` | Header |',
  '| --- | --- |',
  '| `abc` | Cell |',
  '',
  '<div><code>abc</code><pre><code>block</code></pre></div>',
  '',
  '```text',
  'block `abc`',
  '```',
  '',
  'Caret rests here.'
].join('\n');

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let frame = 0; frame < 4; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
}

async function measure(page: Page, selector: string) {
  return page.$$eval(selector, elements => elements.filter(element => element.getBoundingClientRect().width > 0).map(element => {
    const style = getComputedStyle(element);
    const markers = Array.from(element.querySelectorAll<HTMLElement>(
      '.meo-md-code-marker, .meo-md-code-marker-active'
    ));
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let contentWidth = 0;
    let content = '';
    while (walker.nextNode()) {
      if (walker.currentNode.parentElement?.closest('.meo-md-code-marker, .meo-md-code-marker-active')) continue;
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      contentWidth += range.getBoundingClientRect().width;
      content += walker.currentNode.textContent;
    }
    return {
      content,
      html: element.outerHTML,
      width: element.getBoundingClientRect().width,
      contentWidth,
      fontSize: parseFloat(style.fontSize),
      paddingLeft: parseFloat(style.paddingLeft),
      paddingRight: parseFloat(style.paddingRight),
      markerWidths: markers.map(marker => marker.getBoundingClientRect().width),
      table: !!element.closest('table'),
      htmlCode: element.tagName === 'CODE' && !element.classList.contains('meo-md-inline-code')
    };
  }));
}

function assertCompact(samples: Awaited<ReturnType<typeof measure>>, context: string): void {
  assert.ok(samples.length >= 10, `${context}: missing inline-code contexts`);
  for (const sample of samples) {
    assert.ok(sample.markerWidths.every(width => width === 0),
      `${context}: hidden delimiters occupy width: ${sample.html}`);
    assert.ok(Math.abs(sample.paddingLeft / sample.fontSize - 0.25) < 0.002
      && Math.abs(sample.paddingRight / sample.fontSize - 0.25) < 0.002,
    `${context}: inconsistent padding: ${JSON.stringify(sample)}`);
    assert.ok(Math.abs(sample.width - sample.contentWidth - sample.paddingLeft - sample.paddingRight) < 0.5,
      `${context}: unexpected reserved width: ${JSON.stringify(sample)}`);
  }
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts/test-inline-code-layout-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  try {
    for (const appearance of ['light', 'dark'] as const) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 1 });
      await page.setContent('<!doctype html><style>:root{--vscode-editor-font-family:Consolas,monospace;--vscode-editor-font-size:20px;--vscode-editor-font-weight:400}html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
      await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
      await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
      await page.evaluate(({ text, appearance }) => {
        const w = window as any;
        w.InlineCodeLayoutHarness.applyBuiltInVisualBaseline(appearance);
        w.inlineCodeEditor = w.InlineCodeLayoutHarness.createEditor({
          parent: document.getElementById('app')!, text, initialMode: 'live',
          uiLanguage: 'en', onApplyChanges() {}
        });
        w.inlineCodeEditor.view.dispatch({ selection: { anchor: text.length } });
      }, { text: markdown, appearance });
      await settle(page);
      const selector = '.meo-md-inline-code, .meo-md-html-inline code, .meo-md-html-content code:not(pre code)';
      const samples = await measure(page, selector);
      assert.ok(samples.some(sample => sample.table), 'Native table code must be measured');
      assert.ok(samples.some(sample => sample.htmlCode), 'Rendered HTML code must be measured');
      assertCompact(samples, `Live ${appearance}`);

      // Click while the source delimiters are collapsed, then edit against the source offsets.
      const contentStart = markdown.indexOf('abc');
      const click = await page.evaluate(position => {
        const view = (window as any).inlineCodeEditor.view;
        const rect = view.coordsAtPos(position);
        if (!rect) throw new Error('Missing inline-code click coordinates');
        return { x: rect.left + 0.1, y: (rect.top + rect.bottom) / 2 };
      }, contentStart + 1);
      await page.mouse.click(click.x, click.y);
      await settle(page);
      assert.equal(await page.evaluate(() => (window as any).inlineCodeEditor.view.state.selection.main.head), contentStart + 1);
      const active = await page.$eval('.meo-md-inline-code', code => Array.from(
        code.querySelectorAll('.meo-md-code-marker-active'), marker => marker.getBoundingClientRect().width
      ));
      assert.equal(active.length, 2);
      assert.ok(active.every(width => width > 0), 'Editing must reveal both source delimiters');
      await page.keyboard.type('X');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.press('ArrowLeft');
      await page.keyboard.type('Y');
      await settle(page);
      const edited = await page.evaluate(() => (window as any).inlineCodeEditor.view.state.doc.toString());
      assert.equal(edited, markdown.replace('`abc`', 'Y`aXbc`'), 'Caret navigation must preserve delimiter boundaries');
      await page.evaluate(() => {
        const view = (window as any).inlineCodeEditor.view;
        view.dispatch({ selection: { anchor: view.state.doc.length } });
      });
      await settle(page);
      assertCompact(await measure(page, selector), `Live ${appearance} after editing`);

      await page.setViewport({ width: 360, height: 1400, deviceScaleFactor: 1 });
      const wrapped = 'Before `' + 'wrapped code words '.repeat(16) + '` after.\n\nCaret rests here.';
      await page.evaluate(text => {
        const view = (window as any).inlineCodeEditor.view;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: text.length } });
      }, wrapped);
      await settle(page);
      const wrapState = await page.$eval('.meo-md-inline-code', code => {
        const style = getComputedStyle(code);
        return {
          fragments: code.getClientRects().length,
          decoration: style.boxDecorationBreak,
          markerWidths: Array.from(code.querySelectorAll('.meo-md-code-marker'), marker => marker.getBoundingClientRect().width)
        };
      });
      assert.ok(wrapState.fragments > 1, 'Long inline code must wrap');
      assert.equal(wrapState.decoration, 'clone', 'Wrapped fragments must retain the same padding');
      assert.ok(wrapState.markerWidths.every(width => width === 0));
      await page.evaluate(() => (window as any).inlineCodeEditor.setMode('source'));
      await page.waitForSelector('.cm-editor.meo-mode-source');
      await settle(page);
      const sourceState = await page.evaluate(() => {
        const view = (window as any).inlineCodeEditor.view;
        const text = view.state.doc.toString();
        const marker = text.indexOf('`');
        return {
          text,
          markerWidth: view.coordsAtPos(marker + 1).left - view.coordsAtPos(marker).left,
          padding: Array.from(view.dom.querySelectorAll('.meo-md-inline-code'),
            (code: Element) => getComputedStyle(code).padding)
        };
      });
      assert.equal(sourceState.text, wrapped, 'Source mode must preserve the raw code delimiters');
      assert.ok(sourceState.markerWidth > 0, 'Source delimiters must keep their normal width');
      assert.ok(sourceState.padding.every((padding: string) => padding === '0px'), 'Source must not receive reading padding');
      await page.close();

      const html = renderMarkdownToHtml({ markdownText: markdown, markdownFilePath: 'inline-code-layout.md', target: 'html' }).html;
      const environment = { previewFontFamily: 'Consolas', previewThemeIsolation: true, editorFontSizePx: 20, editorFontFamily: 'Consolas' };
      for (const [surface, styles] of [
        ['Preview', buildPreviewStyles(environment, appearance)],
        ['HTML export', buildExportStyles(environment, appearance)]
      ]) {
        const reading = await browser.newPage();
        await reading.setViewport({ width: 1100, height: 1400, deviceScaleFactor: 1 });
        await reading.setContent(`<!doctype html><style>${styles}</style><div class="meo-export-page"><main class="meo-export-doc">${html}</main></div>`);
        await settle(reading);
        assertCompact(await measure(reading, 'code:not(pre code)'), `${surface} ${appearance}`);
        const blocks = await reading.$$eval('pre code', codes => codes.map(code => ({
          text: code.textContent, padding: getComputedStyle(code).padding
        })));
        assert.ok(blocks.some(block => block.text?.includes('block')));
        assert.ok(blocks.every(block => block.padding === '0px'), 'Reading code blocks must not receive inline padding');
        await reading.close();
      }
    }
    console.log('Inline-code reading widths, editing boundaries and wrapped fragments passed in both themes.');
  } finally {
    await browser.close();
  }
}

try {
  await main();
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
