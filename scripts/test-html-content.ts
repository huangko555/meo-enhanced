import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-html-content-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main() {
  const rendered = renderMarkdownToHtml({
    markdownText: [
      '<p align="center" style="color:red" onclick="return false">',
      '  <a href="#target">English</a> · <strong>简体中文</strong>',
      '</p>',
      '',
      '<p><a href="javascript:alert(1)">Unsafe link</a></p>',
      '',
      'Inline <kbd>Ctrl</kbd> and <strong>bold</strong>.',
      '',
      '<details open><summary>Existing details</summary><p>Body</p></details>',
      '',
      '<section>Unsupported HTML</section>'
    ].join('\n'),
    markdownFilePath: path.join(tempDir, 'source.md'),
    target: 'html'
  }).html;
  if (
    !rendered.includes('<p align="center">') ||
    !rendered.includes('<a href="#target">English</a>') ||
    !rendered.includes('<strong>简体中文</strong>') ||
    rendered.includes('onclick=') ||
    rendered.includes('style="color:red"') ||
    rendered.includes('javascript:') ||
    !rendered.includes('<kbd>Ctrl</kbd>') ||
    !rendered.includes('<strong>bold</strong>') ||
    !rendered.includes('<details open><summary>Existing details</summary><p>Body</p></details>') ||
    !rendered.includes('&lt;section&gt;Unsupported HTML&lt;/section&gt;')
  ) {
    throw new Error(`Preview/export HTML policy was inconsistent: ${rendered}`);
  }

  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-html-content-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 920, height: 1600, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0} blockquote{background:#24292e}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#f7f8fa; --meo-foreground:#1f2328; --meo-border:#c8d1dc; --meo-color-base03:#c8d1dc; --meo-semantic-kbdBackground:#eef2f6; --meo-semantic-kbdBorder:#8c959f; --meo-semantic-blockquoteBorder:#8c959f; --meo-semantic-blockquoteForeground:#57606a; --meo-semantic-tableBorder:#c8d1dc; --meo-semantic-tableHeaderBackground:#e3e9f0; --meo-semantic-inlineCodeBackground:#eff1f3; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:"Courier New"; --meo-font-source-weight:500; --meo-font-source-size:14px; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const source = [
      ...Array.from({ length: 20 }, (_, index) => `prelude ${index + 1}`),
      'Inline <strong>bold</strong>, <u>underlined</u>, and <a href="https://example.com">external</a>.',
      '',
      '<p align="center">',
      '  <a href="#html-target">English</a> ·',
      '  <a href="https://example.com/docs">Docs</a> ·',
      '  <strong>简体中文</strong>',
      '</p>',
      '',
      '<div id="html-target">',
      '  <p title="target">HTML target</p>',
      '</div>',
      '',
      '<p style="color:red" onclick="return false">Safe visible text</p>',
      '',
      '<section><p>Unsupported source remains visible</p></section>',
      '',
      '<details open>',
      '  <summary><strong>Rich summary</strong> <kbd>Enter</kbd></summary>',
      '  <p>Rendered details body with <mark>highlight</mark>.</p>',
      '</details>',
      '',
      '<blockquote>',
      '  <p><strong>HTML quote:</strong> quoted text.</p>',
      '</blockquote>',
      '',
      '<table>',
      '  <thead><tr><th>Type</th><th>Result</th></tr></thead>',
      '  <tbody><tr><td>HTML</td><td>Rendered</td></tr></tbody>',
      '</table>',
      '',
      '<p align="center">',
      '  <a href="https://example.com/image"><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n5QAAAAASUVORK5CYII=" alt="Nested image" width="40"></a>',
      '  <br>',
      '  <strong>Image caption</strong>',
      '</p>',
      '',
      '<p><kbd>Ctrl</kbd> <code>inline()</code></p>',
      '',
      '<p>Compact paragraph one.</p>',
      '',
      '<p>Compact paragraph two.</p>',
      '',
      '<div title="> <script>">',
      '  <p>Quoted tag attribute text</p>',
      '</div>',
      '',
      ...Array.from({ length: 80 }, (_, index) => `tail ${index + 1}`)
    ].join('\n');

    await page.evaluate((text) => {
      (window as any).__openedHtmlLinks = [];
      (window as any).__htmlSelectionState = { visible: false };
      (window as any).__htmlContentEditor = (window as any).HtmlContentHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {},
        onSelectionChange(state: any) {
          (window as any).__htmlSelectionState = state;
        },
        onOpenLink(href: string) {
          (window as any).__openedHtmlLinks.push(href);
        }
      });
      (window as any).__htmlContentEditor.scrollToLine(23, 'center');
    }, source);
    await waitForFrames(page, 12);

    const initial = await page.evaluate(() => {
      const editor = (window as any).__htmlContentEditor;
      const block = document.querySelector<HTMLElement>('.meo-md-html-block[data-meo-html-from]');
      const blockStyle = block ? getComputedStyle(block) : null;
      const inlineStrong = document.querySelector<HTMLElement>('.meo-md-html-strong');
      const inlineUnderline = document.querySelector<HTMLElement>('.meo-md-html-u');
      const unsupportedLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('Unsupported source remains visible'));
      const safeBlock = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-block'))
        .find((element) => element.textContent?.includes('Safe visible text'));
      const details = document.querySelector<HTMLElement>('.meo-md-html-block details');
      const quote = document.querySelector<HTMLElement>('.meo-md-html-block blockquote');
      const table = document.querySelector<HTMLElement>('.meo-md-html-block table');
      const tableHeader = table?.querySelector<HTMLElement>('th') ?? null;
      const image = document.querySelector<HTMLElement>('.meo-md-html-block .meo-md-image');
      const kbd = document.querySelector<HTMLElement>('.meo-md-html-block kbd');
      const compactBlocks = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-block'))
        .filter((element) => element.textContent?.includes('Compact paragraph'));
      const quotedAttributeBlock = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-block'))
        .find((element) => element.textContent?.includes('Quoted tag attribute text'));
      const sourceButton = block?.querySelector<HTMLElement>('.meo-md-html-source-toggle') ?? null;
      const content = block?.querySelector<HTMLElement>('.meo-md-html-content') ?? block;
      const sourceButtonStyle = sourceButton ? getComputedStyle(sourceButton) : null;
      const blockLinks = block ? Array.from(block.querySelectorAll<HTMLElement>('.meo-md-html-link')) : [];
      const sourceButtonRect = sourceButton?.getBoundingClientRect() ?? null;
      const contentRect = content?.getBoundingClientRect() ?? null;
      const scrollerRect = editor.view.scrollDOM.getBoundingClientRect();
      const visibleZeroHeightLineNumbers = Array.from(
        document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')
      ).filter((element) => {
        const style = getComputedStyle(element);
        return /^\d+$/.test(element.textContent?.trim() ?? '') &&
          element.getBoundingClientRect().height < 1 &&
          style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          style.color !== 'rgba(0, 0, 0, 0)';
      }).map((element) => element.textContent?.trim() ?? '');
      return {
        source: editor.view.state.doc.toString(),
        blockText: block?.textContent ?? '',
        blockTop: block?.getBoundingClientRect().top ?? null,
        blockBackground: blockStyle?.backgroundColor ?? '',
        blockBorderTop: blockStyle?.borderTopWidth ?? '',
        blockAlign: blockStyle?.textAlign ?? '',
        blockWhiteSpace: blockStyle?.whiteSpace ?? '',
        blockLinkButtons: block?.querySelectorAll('.meo-md-link-open-btn').length ?? 0,
        inlineStrongText: inlineStrong?.textContent ?? '',
        inlineUnderlineText: inlineUnderline?.textContent ?? '',
        inlineUnderlineDecoration: inlineUnderline ? getComputedStyle(inlineUnderline).textDecorationLine : '',
        inlineLinkButtons: document.querySelectorAll('.meo-md-html-inline-link-button').length,
        unsupportedText: unsupportedLine?.textContent ?? '',
        unsupportedWarning: Boolean(unsupportedLine?.querySelector('.meo-md-html-warning')),
        safeStyle: safeBlock?.querySelector<HTMLElement>('p')?.getAttribute('style') ?? null,
        safeOnclick: safeBlock?.querySelector<HTMLElement>('p')?.getAttribute('onclick') ?? null,
        sourceToggleCount: document.querySelectorAll('.meo-md-html-source-toggle').length,
        detailsRendered: Boolean(details?.textContent?.includes('Rendered details body')),
        detailsSourceVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent?.includes('<details open>')),
        quoteBorderWidth: quote ? getComputedStyle(quote).borderLeftWidth : '',
        quoteBackground: quote ? getComputedStyle(quote).backgroundColor : '',
        tableCellCount: table?.querySelectorAll('th, td').length ?? 0,
        tableHeaderBackground: tableHeader ? getComputedStyle(tableHeader).backgroundColor : '',
        imageControls: image?.querySelectorAll('.meo-md-image-controls button').length ?? 0,
        kbdBackground: kbd ? getComputedStyle(kbd).backgroundColor : '',
        compactGap: compactBlocks.length === 2
          ? compactBlocks[1].getBoundingClientRect().top - compactBlocks[0].getBoundingClientRect().bottom
          : null,
        quotedAttributeRendered: Boolean(quotedAttributeBlock),
        sourceButtonSameRow: Boolean(
          sourceButtonRect && contentRect &&
          sourceButtonRect.top < contentRect.bottom && sourceButtonRect.bottom > contentRect.top
        ),
        sourceButtonOutsideContent: Boolean(
          sourceButtonRect && contentRect && sourceButtonRect.left >= contentRect.right + 4
        ),
        sourceButtonInsideViewport: Boolean(sourceButtonRect && sourceButtonRect.right <= scrollerRect.right + 1),
        sourceButtonTopDelta: sourceButtonRect && contentRect ? sourceButtonRect.top - contentRect.top : null,
        sourceButtonBackground: sourceButtonStyle?.backgroundColor ?? '',
        htmlActionRailOffset: blockStyle
          ? Number.parseFloat(blockStyle.getPropertyValue('--meo-html-action-rail-offset'))
          : null,
        editorInlineEndPadding: Number.parseFloat(getComputedStyle(editor.view.contentDOM).paddingRight),
        collapsedAdjacentBlankLines: document.querySelectorAll('.meo-md-html-adjacent-blank-line').length,
        visibleZeroHeightLineNumbers,
        linkLineTops: blockLinks.map((link) => Math.round(link.getBoundingClientRect().top)),
        htmlRenderedBlock: (window as any).HtmlContentHarness.getLiveRenderedBlocks(editor.view.state)
          .find((candidate: any) => candidate.kind === 'html' && candidate.startLine === 23) ?? null,
        scrollTop: editor.view.scrollDOM.scrollTop
      };
    });

    if (
      !initial.blockText.includes('English') ||
      !initial.blockText.includes('简体中文') ||
      initial.blockText.includes('<p') ||
      initial.blockAlign !== 'center' ||
      initial.blockWhiteSpace !== 'normal' ||
      initial.blockBackground !== 'rgba(0, 0, 0, 0)' ||
      initial.blockBorderTop !== '0px' ||
      initial.blockLinkButtons !== 2 ||
      initial.inlineStrongText !== 'bold' ||
      initial.inlineUnderlineText !== 'underlined' ||
      initial.inlineUnderlineDecoration !== 'underline' ||
      initial.inlineLinkButtons !== 1 ||
      !initial.unsupportedText.includes('<section>') ||
      !initial.unsupportedWarning ||
      initial.safeStyle !== null ||
      initial.safeOnclick !== null ||
      initial.sourceToggleCount < 3 ||
      !initial.detailsRendered ||
      initial.detailsSourceVisible ||
      initial.quoteBorderWidth === '0px' ||
      initial.quoteBackground !== 'rgba(0, 0, 0, 0)' ||
      initial.tableCellCount !== 4 ||
      initial.tableHeaderBackground !== 'rgb(227, 233, 240)' ||
      initial.imageControls < 3 ||
      initial.kbdBackground !== 'rgb(238, 242, 246)' ||
      initial.compactGap === null || initial.compactGap < 20 || initial.compactGap > 30 ||
      !initial.quotedAttributeRendered ||
      !initial.sourceButtonSameRow ||
      !initial.sourceButtonOutsideContent ||
      !initial.sourceButtonInsideViewport ||
      initial.sourceButtonTopDelta === null || Math.abs(initial.sourceButtonTopDelta) > 1 ||
      initial.sourceButtonBackground === 'rgba(0, 0, 0, 0)' ||
      initial.htmlActionRailOffset === null ||
      initial.editorInlineEndPadding < initial.htmlActionRailOffset ||
      initial.collapsedAdjacentBlankLines !== 0 ||
      initial.visibleZeroHeightLineNumbers.length !== 0 ||
      initial.linkLineTops.length !== 2 ||
      Math.max(...initial.linkLineTops) - Math.min(...initial.linkLineTops) > 1 ||
      initial.htmlRenderedBlock?.lineNumberHiddenFrom !== 24 ||
      initial.htmlRenderedBlock?.lineNumberHiddenTo !== 27 ||
      initial.source !== source
    ) {
      throw new Error(`Initial HTML document-flow rendering was incorrect: ${JSON.stringify(initial)}`);
    }

    await page.hover('.meo-md-html-block[data-meo-html-from] .meo-md-html-source-toggle');
    const hoveredBlockRange = await page.$eval('.meo-md-html-block[data-meo-html-from]', (element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, boxShadow: style.boxShadow };
    });
    if (hoveredBlockRange.background === 'rgba(0, 0, 0, 0)' && hoveredBlockRange.boxShadow === 'none') {
      throw new Error(`Hovering the HTML source button did not reveal its content range: ${JSON.stringify(hoveredBlockRange)}`);
    }

    const selectionPoints = await page.$eval('.meo-md-html-block[data-meo-html-from] .meo-md-html-link', (element) => {
      const text = element.firstChild;
      if (!text) return null;
      const start = document.createRange();
      start.setStart(text, 0);
      start.setEnd(text, 1);
      const end = document.createRange();
      end.setStart(text, Math.max(0, (text.textContent?.length ?? 1) - 1));
      end.setEnd(text, text.textContent?.length ?? 1);
      const startRect = start.getBoundingClientRect();
      const endRect = end.getBoundingClientRect();
      return {
        startX: startRect.left + 1,
        startY: startRect.top + startRect.height / 2,
        endX: endRect.right - 1,
        endY: endRect.top + endRect.height / 2
      };
    });
    if (!selectionPoints) throw new Error('Could not locate rendered HTML text for selection test');
    await page.evaluate(() => {
      const editor = (window as any).__htmlContentEditor;
      editor.view.dispatch({ selection: { anchor: 0, head: 7 } });
    });
    await waitForFrames(page, 2);
    await page.mouse.move(selectionPoints.startX, selectionPoints.startY);
    await page.mouse.down();
    await page.mouse.move(selectionPoints.endX, selectionPoints.endY, { steps: 8 });
    await page.mouse.up();
    const selectedPreviewText = await page.evaluate(() => window.getSelection()?.toString() ?? '');
    if (!selectedPreviewText.includes('English')) {
      throw new Error(`Rendered HTML text could not be selected: ${JSON.stringify(selectedPreviewText)}`);
    }
    const selectionMenuState = await page.evaluate(() => (window as any).__htmlSelectionState);
    if (selectionMenuState?.visible !== false) {
      throw new Error(`HTML native selection left the Markdown formatting menu visible: ${JSON.stringify(selectionMenuState)}`);
    }
    await page.evaluate(() => window.getSelection()?.removeAllRanges());

    const detailsBeforeToggle = await page.$eval('.meo-md-html-block details', (element) => ({
      open: (element as HTMLDetailsElement).open,
      top: element.closest('.meo-md-html-block')?.getBoundingClientRect().top ?? null
    }));
    await page.click('.meo-md-html-block details > summary');
    await waitForFrames(page, 8);
    const detailsAfterCollapse = await page.$eval('.meo-md-html-block details', (element) => ({
      open: (element as HTMLDetailsElement).open,
      top: element.closest('.meo-md-html-block')?.getBoundingClientRect().top ?? null,
      bodyVisible: (element.querySelector('p')?.getBoundingClientRect().height ?? 0) > 0
    }));
    if (
      !detailsBeforeToggle.open ||
      detailsAfterCollapse.open ||
      detailsAfterCollapse.bodyVisible ||
      detailsBeforeToggle.top === null ||
      detailsAfterCollapse.top === null ||
      Math.abs(detailsAfterCollapse.top - detailsBeforeToggle.top) > 1
    ) {
      throw new Error(`Rendered details did not collapse in place: ${JSON.stringify({ detailsBeforeToggle, detailsAfterCollapse })}`);
    }
    await page.click('.meo-md-html-block details > summary');
    await waitForFrames(page, 8);

    const blockRect = await page.$eval('.meo-md-html-block[data-meo-html-from]', (element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left + 8, y: rect.top + Math.min(10, rect.height / 2) };
    });
    await page.mouse.click(blockRect.x, blockRect.y);
    await waitForFrames(page, 4);
    const afterOrdinaryClick = await page.evaluate(() => {
      const editor = (window as any).__htmlContentEditor;
      return {
        blockVisible: Boolean(document.querySelector('.meo-md-html-block[data-meo-html-from]')),
        scrollTop: editor.view.scrollDOM.scrollTop
      };
    });
    if (!afterOrdinaryClick.blockVisible || Math.abs(afterOrdinaryClick.scrollTop - initial.scrollTop) > 1) {
      throw new Error(`Ordinary HTML preview click changed mode or viewport: ${JSON.stringify(afterOrdinaryClick)}`);
    }

    const sourceButton = await page.$('.meo-md-html-block[data-meo-html-from] .meo-md-html-source-toggle');
    if (!sourceButton) throw new Error('HTML source toggle was not rendered');
    await sourceButton.click();
    await waitForFrames(page, 10);
    const editing = await page.evaluate(() => {
      const editor = (window as any).__htmlContentEditor;
      const sourceLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('<p align="center">'));
      const sourceControl = document.querySelector<HTMLElement>('.meo-md-html-source-control');
      const sourceLineRect = sourceLine?.getBoundingClientRect() ?? null;
      const sourceControlRect = sourceControl?.getBoundingClientRect() ?? null;
      const sourceRangeLines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line.meo-md-html-source-range'));
      return {
        sourceVisible: Boolean(sourceLine),
        previewControlVisible: Boolean(sourceControl),
        blockVisible: Boolean(Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-block'))
          .find((element) => element.textContent?.includes('English'))),
        scrollTop: editor.view.scrollDOM.scrollTop,
        selectedLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
        sourceRangeLineCount: sourceRangeLines.length,
        sourceRangeStart: sourceRangeLines[0]?.classList.contains('meo-md-html-source-range-start') ?? false,
        sourceRangeEnd: sourceRangeLines.at(-1)?.classList.contains('meo-md-html-source-range-end') ?? false,
        sourceRangeBackgrounds: sourceRangeLines.map((line) => getComputedStyle(line).backgroundColor),
        sourceControlSameRow: Boolean(
          sourceLineRect && sourceControlRect &&
          sourceControlRect.top < sourceLineRect.bottom && sourceControlRect.bottom > sourceLineRect.top
        ),
        sourceControlOutsideRange: Boolean(
          sourceLineRect && sourceControlRect && sourceControlRect.left >= sourceLineRect.right + 4
        ),
        sourceControlTopDelta: sourceLineRect && sourceControlRect
          ? sourceControlRect.top - sourceLineRect.top
          : null
      };
    });
    if (
      !editing.sourceVisible ||
      !editing.previewControlVisible ||
      editing.blockVisible ||
      editing.selectedLine !== 23 ||
      editing.sourceRangeLineCount !== 5 ||
      !editing.sourceRangeStart ||
      !editing.sourceRangeEnd ||
      editing.sourceRangeBackgrounds.some((background) => background === 'rgba(0, 0, 0, 0)') ||
      !editing.sourceControlSameRow ||
      !editing.sourceControlOutsideRange ||
      editing.sourceControlTopDelta === null || Math.abs(editing.sourceControlTopDelta) > 1 ||
      Math.abs(editing.scrollTop - initial.scrollTop) > 1
    ) {
      throw new Error(`HTML source mode did not open in place: ${JSON.stringify({ initial, editing })}`);
    }

    const sourceEditPoint = await page.evaluate(() => {
      const editor = (window as any).__htmlContentEditor;
      const position = editor.view.state.doc.toString().indexOf('English') + 'English'.length;
      const coords = editor.view.coordsAtPos(position);
      return coords ? { x: coords.left, y: (coords.top + coords.bottom) / 2 } : null;
    });
    if (!sourceEditPoint) throw new Error('Could not locate editable HTML source text');
    await page.mouse.click(sourceEditPoint.x, sourceEditPoint.y);
    await page.keyboard.type('X');
    await waitForFrames(page, 3);
    const sourceAfterTyping = await page.evaluate(() => {
      const editor = (window as any).__htmlContentEditor;
      return {
        text: editor.view.state.doc.toString(),
        sourceControlVisible: Boolean(document.querySelector('.meo-md-html-source-control'))
      };
    });
    if (!sourceAfterTyping.text.includes('EnglishX') || !sourceAfterTyping.sourceControlVisible) {
      throw new Error(`HTML source was not editable in place: ${JSON.stringify(sourceAfterTyping)}`);
    }
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await waitForFrames(page, 3);

    await page.keyboard.press('Escape');
    await waitForFrames(page, 10);
    const afterEscape = await page.evaluate(() => {
      const editor = (window as any).__htmlContentEditor;
      const block = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-block'))
        .find((element) => element.textContent?.includes('English'));
      return {
        blockVisible: Boolean(block),
        blockTop: block?.getBoundingClientRect().top ?? null,
        scrollTop: editor.view.scrollDOM.scrollTop
      };
    });
    if (
      !afterEscape.blockVisible ||
      initial.blockTop === null ||
      afterEscape.blockTop === null ||
      Math.abs(afterEscape.blockTop - initial.blockTop) > 1 ||
      Math.abs(afterEscape.scrollTop - initial.scrollTop) > 1
    ) {
      throw new Error(`Escape did not restore HTML preview in place: ${JSON.stringify({ initial, afterEscape })}`);
    }

    await page.evaluate(() => (window as any).__htmlContentEditor.scrollToLine(24, 'upper'));
    await waitForFrames(page, 10);
    const revealedInnerLine = await page.evaluate(() => {
      const editor = (window as any).__htmlContentEditor;
      return {
        selectedLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
        sourceVisible: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some((line) => line.textContent?.includes('English') && line.textContent?.includes('<a')),
        htmlRenderedBlock: (window as any).HtmlContentHarness.getLiveRenderedBlocks(editor.view.state)
          .find((candidate: any) => candidate.kind === 'html' && candidate.startLine === 23) ?? null
      };
    });
    if (
      revealedInnerLine.selectedLine !== 24 ||
      !revealedInnerLine.sourceVisible ||
      revealedInnerLine.htmlRenderedBlock !== null
    ) {
      throw new Error(`Jumping to an inner HTML line did not reveal exact source: ${JSON.stringify(revealedInnerLine)}`);
    }

    await page.evaluate(() => (window as any).__htmlContentEditor.revealSelection(
      (window as any).__htmlContentEditor.view.state.doc.line(
        (window as any).__htmlContentEditor.view.state.doc.lines - 20
      ).from,
      undefined,
      { focusEditor: true, align: 'nearest' }
    ));
    await waitForFrames(page, 8);
    await page.evaluate(() => (window as any).__htmlContentEditor.scrollToLine(23, 'center'));
    await waitForFrames(page, 8);
    const afterLeavingSource = await page.evaluate(() => ({
      blockVisible: Boolean(Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-block'))
        .find((element) => element.textContent?.includes('English'))),
      sourceControlVisible: Boolean(document.querySelector('.meo-md-html-source-control'))
    }));
    if (!afterLeavingSource.blockVisible || afterLeavingSource.sourceControlVisible) {
      throw new Error(`Leaving the HTML source range did not restore preview: ${JSON.stringify(afterLeavingSource)}`);
    }

    const externalButton = await page.$('.meo-md-html-inline-link-button');
    if (!externalButton) throw new Error('Always-visible inline HTML link button was not rendered');
    await externalButton.click();
    await waitForFrames(page, 2);
    const openedLinks = await page.evaluate(() => (window as any).__openedHtmlLinks);
    if (JSON.stringify(openedLinks) !== JSON.stringify(['https://example.com'])) {
      throw new Error(`HTML link button did not use the existing link path: ${JSON.stringify(openedLinks)}`);
    }

    console.log('HTML content browser tests passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
