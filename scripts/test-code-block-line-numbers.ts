import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-code-line-numbers-'));

async function waitForFrames(page: Page, count = 6): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-code-block-line-numbers-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 520, height: 700, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-code-background:#292d31; --meo-semantic-mutedForeground:#8b949e; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      const text = [
        '```ts',
        'const first = 1;',
        '',
        'const third = "a long logical line that wraps without gaining another number";',
        'line four',
        'line five',
        'line six',
        'line seven',
        'line eight',
        'line nine',
        'line ten',
        'line eleven',
        'line twelve',
        '```',
        '',
        '```',
        'plain text',
        '```',
        '',
        '```mermaid',
        'graph TD',
        'A-->B',
        '```',
        '',
        '    indented one',
        '    indented two',
        '',
        '```js',
        'tail one',
        'tail two'
      ].join('\n');
      (window as any).__codeBlockLineNumbersEditor = (window as any).CodeBlockLineNumbersHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    const result = await page.evaluate(() => {
      const lines = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-code-line-numbered'));
      const doubleDigitLine = lines.find((line) => line.dataset.meoCodeLineNumber === '10')!;
      const pseudoStyle = getComputedStyle(doubleDigitLine, '::before');
      const lineStyle = getComputedStyle(doubleDigitLine);
      const probe = document.createElement('span');
      probe.style.position = 'fixed';
      probe.style.visibility = 'hidden';
      probe.style.font = lineStyle.font;
      probe.textContent = '10';
      document.body.appendChild(probe);
      const requiredNumberWidth = probe.getBoundingClientRect().width;
      probe.remove();
      const declaredWidth = Number.parseFloat(pseudoStyle.width);
      const availableNumberWidth = pseudoStyle.boxSizing === 'border-box'
        ? declaredWidth
          - Number.parseFloat(pseudoStyle.paddingLeft)
          - Number.parseFloat(pseudoStyle.paddingRight)
          - Number.parseFloat(pseudoStyle.borderLeftWidth)
          - Number.parseFloat(pseudoStyle.borderRightWidth)
        : declaredWidth;
      return {
        numbers: lines.map((line) => line.dataset.meoCodeLineNumber ?? ''),
        text: lines.map((line) => line.textContent ?? ''),
        pseudoContent: lines.map((line) => getComputedStyle(line, '::before').content),
        availableNumberWidth,
        requiredNumberWidth,
        mermaidNumbered: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-code-line-numbered'))
          .some((line) => line.textContent?.includes('graph TD') || line.textContent?.includes('A-->B'))
      };
    });

    const expectedNumbers = [
      ...Array.from({ length: 12 }, (_, index) => String(index + 1)),
      '1', '1', '2', '1', '2'
    ];
    if (JSON.stringify(result.numbers) !== JSON.stringify(expectedNumbers)) {
      throw new Error(`Unexpected code line numbers: ${JSON.stringify(result.numbers)}`);
    }
    if (result.text[1] !== '') {
      throw new Error(`Empty code line was not preserved: ${JSON.stringify(result.text)}`);
    }
    if (result.pseudoContent.some((content) => content === 'none' || content === 'normal')) {
      throw new Error(`Code line number pseudo-elements were not rendered: ${JSON.stringify(result.pseudoContent)}`);
    }
    if (result.availableNumberWidth + 0.25 < result.requiredNumberWidth) {
      throw new Error(
        `Two-digit code line number was clipped: ${result.availableNumberWidth}px available, ${result.requiredNumberWidth}px required`
      );
    }
    if (result.mermaidNumbered) {
      throw new Error('Rendered Mermaid source received code line numbers');
    }

    const hiddenActionOpacities = await page.$$eval('.meo-code-block-actions', (toolbars) => (
      toolbars.map((toolbar) => getComputedStyle(toolbar).opacity)
    ));
    if (hiddenActionOpacities.some((opacity) => opacity !== '0')) {
      throw new Error(`Code block actions were visible before hover: ${JSON.stringify(hiddenActionOpacities)}`);
    }

    const middleCodeLine = await page.$eval(
      '.meo-md-code-line-numbered[data-meo-code-line-number="10"]',
      (line) => {
        const rect = line.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    );
    await page.mouse.move(middleCodeLine.x, middleCodeLine.y);
    await waitForFrames(page);
    const hoveredActionState = await page.$$eval('.meo-code-block-actions', (toolbars) => (
      toolbars.map((toolbar) => ({
        hovered: toolbar.classList.contains('is-block-hovered'),
        opacity: getComputedStyle(toolbar).opacity
      }))
    ));
    if (
      hoveredActionState.filter((state) => state.hovered && state.opacity === '1').length !== 1 ||
      hoveredActionState.filter((state) => state.opacity === '1').length !== 1
    ) {
      throw new Error(`Hover did not reveal only the matching code block actions: ${JSON.stringify(hoveredActionState)}`);
    }

    await page.click('.meo-code-block-actions .meo-select-all-code-btn');
    const selectedCode = await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const selection = editor.view.state.selection.main;
      return {
        anchor: selection.anchor,
        from: selection.from,
        head: selection.head,
        text: editor.view.state.doc.sliceString(selection.from, selection.to),
        to: selection.to,
        controls: Array.from(document.querySelector('.meo-code-block-actions')?.children ?? [])
          .map((element) => element.textContent)
      };
    });
    const expectedSelectedCode = [
      'const first = 1;',
      '',
      'const third = "a long logical line that wraps without gaining another number";',
      'line four',
      'line five',
      'line six',
      'line seven',
      'line eight',
      'line nine',
      'line ten',
      'line eleven',
      'line twelve'
    ].join('\n');
    if (selectedCode.text !== expectedSelectedCode) {
      throw new Error(`Select all included the wrong fenced-code range: ${JSON.stringify(selectedCode.text)}`);
    }
    if (selectedCode.head !== selectedCode.from || selectedCode.anchor !== selectedCode.to) {
      throw new Error(`Select all left the cursor at the code block end: ${JSON.stringify(selectedCode)}`);
    }
    if (JSON.stringify(selectedCode.controls) !== JSON.stringify(['all', 'copy'])) {
      throw new Error(`Unexpected code block action order: ${JSON.stringify(selectedCode.controls)}`);
    }

    await page.evaluate(() => {
      (window as any).__codeBlockLineNumbersEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      const content = Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`);
      const text = ['```ts', ...content, '```'].join('\n');
      (window as any).__codeBlockLineNumbersEditor = (window as any).CodeBlockLineNumbersHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page, 8);
    const longBlockScrollBefore = await page.evaluate(() => (
      (window as any).__codeBlockLineNumbersEditor.view.scrollDOM.scrollTop
    ));
    await page.click('.meo-code-block-actions .meo-select-all-code-btn');
    await waitForFrames(page, 2);
    const longBlockSelection = await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const selection = editor.view.state.selection.main;
      return {
        anchor: selection.anchor,
        from: selection.from,
        head: selection.head,
        scrollTop: editor.view.scrollDOM.scrollTop,
        to: selection.to
      };
    });
    if (
      longBlockSelection.head !== longBlockSelection.from ||
      longBlockSelection.anchor !== longBlockSelection.to ||
      Math.abs(longBlockSelection.scrollTop - longBlockScrollBefore) > 1
    ) {
      throw new Error(`Selecting a long code block moved away from its start: ${JSON.stringify({ longBlockScrollBefore, longBlockSelection })}`);
    }
    await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      editor.view.scrollDOM.scrollTop = editor.view.scrollDOM.scrollHeight;
    });
    await waitForFrames(page, 12);

    const fourDigitResult = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-code-line-numbered'))
        .find((candidate) => candidate.dataset.meoCodeLineNumber === '1000');
      if (!line) return null;
      const pseudoStyle = getComputedStyle(line, '::before');
      const lineStyle = getComputedStyle(line);
      const probe = document.createElement('span');
      probe.style.position = 'fixed';
      probe.style.visibility = 'hidden';
      probe.style.font = lineStyle.font;
      probe.textContent = '1000';
      document.body.appendChild(probe);
      const requiredNumberWidth = probe.getBoundingClientRect().width;
      probe.remove();
      const declaredWidth = Number.parseFloat(pseudoStyle.width);
      const availableNumberWidth = pseudoStyle.boxSizing === 'border-box'
        ? declaredWidth
          - Number.parseFloat(pseudoStyle.paddingLeft)
          - Number.parseFloat(pseudoStyle.paddingRight)
          - Number.parseFloat(pseudoStyle.borderLeftWidth)
          - Number.parseFloat(pseudoStyle.borderRightWidth)
        : declaredWidth;
      return { availableNumberWidth, requiredNumberWidth };
    });
    if (!fourDigitResult) {
      throw new Error('Four-digit code line number 1000 was not rendered');
    }
    if (fourDigitResult.availableNumberWidth + 0.25 < fourDigitResult.requiredNumberWidth) {
      throw new Error(
        `Four-digit code line number was clipped: ${fourDigitResult.availableNumberWidth}px available, ${fourDigitResult.requiredNumberWidth}px required`
      );
    }
    console.log('code block line number checks passed');
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
