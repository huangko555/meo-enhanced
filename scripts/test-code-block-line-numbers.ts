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

async function readOuterLineNumberAlignment(
  page: Page,
  lineNumbers: readonly number[]
): Promise<Array<{ lineNumber: number; markerText: string | null; offset: number | null }>> {
  const results: Array<{ lineNumber: number; markerText: string | null; offset: number | null }> = [];
  for (const lineNumber of lineNumbers) {
    await page.evaluate((targetLine) => {
      (window as any).__codeBlockLineNumbersEditor.scrollToLine(targetLine, 'center');
    }, lineNumber);
    await waitForFrames(page, 4);
    results.push(await page.evaluate((targetLine) => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const line = editor.view.state.doc.line(targetLine);
      const coords = editor.view.coordsAtPos(line.from);
      const outerGutter = editor.view.scrollDOM.querySelector<HTMLElement>(':scope > .cm-gutters');
      const marker = Array.from(
        outerGutter?.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement') ?? []
      ).find((element) => (
        getComputedStyle(element).visibility !== 'hidden' &&
        element.textContent?.trim() === String(targetLine)
      ));
      if (!coords || !marker) {
        return { lineNumber: targetLine, markerText: marker?.textContent?.trim() ?? null, offset: null };
      }
      const markerRect = marker.getBoundingClientRect();
      return {
        lineNumber: targetLine,
        markerText: marker.textContent?.trim() ?? null,
        offset: markerRect.top + markerRect.height / 2 - (coords.top + coords.bottom) / 2
      };
    }, lineNumber));
  }
  return results;
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
      content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-code-background:#292d31; --meo-semantic-mutedForeground:#8b949e; --vscode-editor-font-family:monospace; --vscode-editor-font-size:14px; --vscode-editor-line-height:20px; }'
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
        '$$',
        '\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi} + a deliberately long formula tail that must wrap in the split source pane',
        '$$',
        '',
        '    indented one',
        '    indented two',
        '',
        '```js',
        'tail one',
        'tail two'
      ].join('\n');
      const editorHost = document.getElementById('app')!;
      editorHost.className = 'editor-host';
      (window as any).__codeBlockLineNumbersEditor = (window as any).CodeBlockLineNumbersHarness.createEditor({
        parent: editorHost,
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
          .some((line) => line.textContent?.includes('graph TD') || line.textContent?.includes('A-->B')),
        outerGutterTransform: getComputedStyle(document.querySelector<HTMLElement>(
          '.editor-host > .cm-editor > .cm-scroller > .cm-gutters'
        )!).transform,
        outerLineNumberPaddingRight: getComputedStyle(document.querySelector<HTMLElement>(
          '.editor-host > .cm-editor > .cm-scroller > .cm-gutters > .cm-lineNumbers > .cm-gutterElement'
        )!).paddingRight
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
    if (result.outerGutterTransform !== 'none' || result.outerLineNumberPaddingRight !== '10px') {
      throw new Error(`Outer gutter still uses a composited transform offset: ${JSON.stringify(result)}`);
    }

    const renderedBlockGutters = await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const gutterElements = Array.from(document.querySelectorAll<HTMLElement>(
        '.cm-lineNumbers .cm-gutterElement.meo-rendered-block-preview-line-number'
      ));
      return Array.from(document.querySelectorAll<HTMLElement>(
        '.meo-rendered-block-preview[data-meo-rendered-block-kind]'
      )).map((block) => {
        const startLine = block.dataset.meoRenderedBlockStartLine ?? '';
        const blockRect = block.getBoundingClientRect();
        const marker = gutterElements.find((candidate) => (
          candidate.textContent?.trim() === startLine
          && getComputedStyle(candidate).visibility !== 'hidden'
          && candidate.getBoundingClientRect().height > 0
        ));
        const markerText = marker?.firstChild ?? null;
        const markerTextRange = markerText ? document.createRange() : null;
        if (markerText && markerTextRange) markerTextRange.selectNodeContents(markerText);
        const markerTextRect = markerTextRange?.getBoundingClientRect() ?? null;
        return {
          kind: block.dataset.meoRenderedBlockKind ?? '',
          startLine,
          hasAlignedStartLineNumber: Boolean(marker),
          textTopOffset: markerTextRect
            ? markerTextRect.top - blockRect.top
            : null
        };
      });
    });
    const renderedBlockFailures: string[] = [];
    if (
      renderedBlockGutters.length !== 2 ||
      renderedBlockGutters.some((block) => (
        !block.hasAlignedStartLineNumber ||
        block.textTopOffset === null ||
        Math.abs(block.textTopOffset) > 4
      ))
    ) {
      throw new Error(
        `Rendered Mermaid or math preview did not show its starting line number: ${JSON.stringify(renderedBlockGutters)}`
      );
    }

    const atomicPreviewState = await page.evaluate(() => {
      const read = (kind: 'mermaid' | 'math') => {
        const shell = document.querySelector<HTMLElement>(
          `.meo-rendered-block-preview[data-meo-rendered-block-kind="${kind}"]`
        );
        const toolbarSelector = kind === 'mermaid'
          ? '.meo-mermaid-toolbar'
          : '.meo-latex-math-toolbar';
        const toolbar = document.querySelector<HTMLElement>(toolbarSelector);
        const openingFence = toolbar?.closest<HTMLElement>('.cm-line.meo-md-code-block-start') ?? null;
        let next = shell?.parentElement?.nextElementSibling as HTMLElement | null;
        let closingFence: HTMLElement | null = null;
        while (next && !next.classList.contains('meo-md-code-block-start')) {
          if (next.classList.contains('meo-md-code-block-end')) {
            closingFence = next;
            break;
          }
          next = next.nextElementSibling as HTMLElement | null;
        }
        return {
          shell: Boolean(shell),
          openingFencePresent: Boolean(openingFence),
          closingFencePresent: Boolean(closingFence),
          openingFencePointerEvents: openingFence ? getComputedStyle(openingFence).pointerEvents : null,
          closingFencePointerEvents: closingFence ? getComputedStyle(closingFence).pointerEvents : null
        };
      };
      return { mermaid: read('mermaid'), math: read('math') };
    });
    if (
      !atomicPreviewState.mermaid.shell || !atomicPreviewState.math.shell ||
      atomicPreviewState.mermaid.openingFencePresent ||
      atomicPreviewState.mermaid.closingFencePresent ||
      atomicPreviewState.math.openingFencePresent ||
      atomicPreviewState.math.closingFencePresent
    ) {
      throw new Error(
        `Rendered preview exposed clickable fence rows instead of one atomic block: ${JSON.stringify(atomicPreviewState)}`
      );
    }

    const latexPreviewToggle = await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('.meo-latex-math-mode-btn');
      const toolbar = button?.closest<HTMLElement>('.meo-latex-math-toolbar') ?? null;
      button?.click();
      return {
        exists: Boolean(button),
        connected: button?.isConnected ?? false,
        disabled: button?.disabled ?? null,
        mode: toolbar?.dataset.meoLatexMathMode ?? null,
        anchor: toolbar?.dataset.meoBlockFrom ?? null
      };
    });
    await waitForFrames(page, 2);
    if (!await page.$('.meo-latex-math-editing-block')) {
      throw new Error(`Latex preview toolbar did not enter split mode: ${JSON.stringify(latexPreviewToggle)}`);
    }
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')?.click();
    });
    await waitForFrames(page, 8);
    const splitLineNumbers = await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const readInner = (selector: string, startLine: number) => {
        const root = document.querySelector<HTMLElement>(selector);
        const gutters = Array.from(root?.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement') ?? [])
          .filter((element) => getComputedStyle(element).visibility !== 'hidden')
          .map((element) => element.textContent?.trim() ?? '')
          .filter(Boolean);
        const content = Array.from(root?.querySelectorAll<HTMLElement>('.cm-content .cm-line') ?? [])
          .map((element) => element.textContent ?? '');
        const firstGutter = Array.from(root?.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement') ?? [])
          .find((element) => element.textContent?.trim() === '1');
        const firstLine = root?.querySelector<HTMLElement>('.cm-content .cm-line') ?? null;
        const textTop = (node: Node | null): number | null => {
          if (!node) return null;
          const range = document.createRange();
          range.selectNodeContents(node);
          return range.getBoundingClientRect().top;
        };
        return {
          gutters,
          content,
          startLine,
          firstLineTextOffset: firstGutter && firstLine
            ? (textTop(firstGutter) ?? 0) - (textTop(firstLine) ?? 0)
            : null
        };
      };
      const outerGutter = editor.view.scrollDOM.querySelector<HTMLElement>(':scope > .cm-gutters');
      const outerNumbers = Array.from(
        outerGutter?.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement') ?? []
      ).map((element) => element.textContent?.trim() ?? '').filter(Boolean);
      const readOuterContentLines = (selector: string, contentStartLine: number) => {
        const innerMarkers = Array.from(
          document.querySelector<HTMLElement>(selector)
            ?.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement') ?? []
        ).filter((element) => (
          getComputedStyle(element).visibility !== 'hidden'
          && element.getBoundingClientRect().height > 0
          && Boolean(element.textContent?.trim())
        ));
        const outerMarkers = Array.from(
          outerGutter?.querySelectorAll<HTMLElement>('.meo-rendered-block-document-line-number') ?? []
        ).filter((element) => (
          getComputedStyle(element).visibility !== 'hidden'
          && element.getBoundingClientRect().height > 0
        ));
        return innerMarkers.map((innerMarker, index) => {
          const lineNumber = contentStartLine + index;
          const outerMarker = outerMarkers.find((candidate) => (
            candidate.textContent?.trim() === String(lineNumber)
          ));
          return {
            lineNumber,
            offset: outerMarker
              ? outerMarker.getBoundingClientRect().top - innerMarker.getBoundingClientRect().top
              : null
          };
        });
      };
      const readOuterStartLine = (startLine: number, blockSelector: string) => {
        const candidates = Array.from(
          outerGutter?.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement') ?? []
        ).filter((element) => (
          element.textContent?.trim() === String(startLine)
          && getComputedStyle(element).visibility !== 'hidden'
          && element.getBoundingClientRect().height > 0
        ));
        const marker = candidates[0] ?? null;
        const coords = editor.view.coordsAtPos(editor.view.state.doc.line(startLine).from);
        if (!marker || !coords) return null;
        const markerRect = marker.getBoundingClientRect();
        return {
          candidateCount: candidates.length,
          height: markerRect.height,
          markerClass: marker.className,
          sourceTopOffset: markerRect.top - coords.top,
          blockTopOffset: markerRect.top - coords.top
        };
      };
      return {
        outerNumbers,
        mermaid: readInner('.meo-mermaid-source-editor', 20),
        math: readInner('.meo-latex-math-source-editor', 25),
        mermaidDocumentLines: readOuterContentLines('.meo-mermaid-source-editor', 21),
        mathDocumentLines: readOuterContentLines('.meo-latex-math-source-editor', 26),
        outerMermaidStart: readOuterStartLine(20, '.meo-mermaid-editing-block'),
        outerMathStart: readOuterStartLine(25, '.meo-latex-math-editing-block')
      };
    });
    if (
      !splitLineNumbers.outerNumbers.includes('20') ||
      !splitLineNumbers.outerNumbers.includes('25') ||
      JSON.stringify(splitLineNumbers.mermaid.gutters) !== JSON.stringify(['1', '2']) ||
      JSON.stringify(splitLineNumbers.math.gutters) !== JSON.stringify(['1']) ||
      splitLineNumbers.mermaidDocumentLines.some((line) => line.offset === null || Math.abs(line.offset) > 1) ||
      splitLineNumbers.mathDocumentLines.some((line) => line.offset === null || Math.abs(line.offset) > 1) ||
      splitLineNumbers.math.firstLineTextOffset === null ||
      Math.abs(splitLineNumbers.math.firstLineTextOffset) > 1 ||
      splitLineNumbers.outerMermaidStart === null ||
      splitLineNumbers.outerMathStart === null ||
      splitLineNumbers.outerMermaidStart.candidateCount !== 1 ||
      splitLineNumbers.outerMathStart.candidateCount !== 1 ||
      splitLineNumbers.outerMermaidStart.height < 1 ||
      splitLineNumbers.outerMathStart.height < 1 ||
      splitLineNumbers.outerMermaidStart.sourceTopOffset === null ||
      splitLineNumbers.outerMathStart.sourceTopOffset === null
    ) {
      renderedBlockFailures.push(`split line numbers: ${JSON.stringify(splitLineNumbers)}`);
    }
    const splitOuterAlignment = await readOuterLineNumberAlignment(page, [23, 24, 27, 28]);
    if (splitOuterAlignment.some((item) => item.offset === null || Math.abs(item.offset) > 1)) {
      throw new Error(`Split rendered-block outer line numbers were misaligned: ${JSON.stringify(splitOuterAlignment)}`);
    }

    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.meo-latex-math-mode-btn')?.click();
    });
    await waitForFrames(page, 2);
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')?.click();
    });
    await waitForFrames(page, 8);
    const sourceBlockLineNumbers = await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const outerGutter = editor.view.scrollDOM.querySelector<HTMLElement>(':scope > .cm-gutters');
      const readOuterContentLines = (selector: string, contentStartLine: number) => {
        const innerMarkers = Array.from(document.querySelectorAll<HTMLElement>(
          `${selector} .cm-lineNumbers > .cm-gutterElement`
        )).filter((element) => (
          getComputedStyle(element).visibility !== 'hidden'
          && element.getBoundingClientRect().height > 0
          && Boolean(element.textContent?.trim())
        ));
        const outerMarkers = Array.from(
          outerGutter?.querySelectorAll<HTMLElement>('.meo-rendered-block-document-line-number') ?? []
        ).filter((element) => (
          getComputedStyle(element).visibility !== 'hidden'
          && element.getBoundingClientRect().height > 0
        ));
        return innerMarkers.map((innerMarker, index) => {
          const lineNumber = contentStartLine + index;
          const outerMarker = outerMarkers.find((candidate) => (
            candidate.textContent?.trim() === String(lineNumber)
          ));
          return {
            lineNumber,
            offset: outerMarker
              ? outerMarker.getBoundingClientRect().top - innerMarker.getBoundingClientRect().top
              : null
          };
        });
      };
      return {
        mermaid: Array.from(document.querySelectorAll<HTMLElement>(
        '.meo-mermaid-source-editor .cm-lineNumbers > .cm-gutterElement'
      )).filter((element) => getComputedStyle(element).visibility !== 'hidden')
        .map((element) => element.textContent?.trim() ?? '').filter(Boolean),
        math: Array.from(document.querySelectorAll<HTMLElement>(
        '.meo-latex-math-source-editor .cm-lineNumbers > .cm-gutterElement'
      )).filter((element) => getComputedStyle(element).visibility !== 'hidden')
          .map((element) => element.textContent?.trim() ?? '').filter(Boolean),
        mermaidDocumentLines: readOuterContentLines('.meo-mermaid-source-editor', 21),
        mathDocumentLines: readOuterContentLines('.meo-latex-math-source-editor', 26)
      };
    });
    if (
      JSON.stringify(sourceBlockLineNumbers.mermaid) !== JSON.stringify(['1', '2']) ||
      JSON.stringify(sourceBlockLineNumbers.math) !== JSON.stringify(['1']) ||
      sourceBlockLineNumbers.mermaidDocumentLines.some((line) => line.offset === null || Math.abs(line.offset) > 1) ||
      sourceBlockLineNumbers.mathDocumentLines.some((line) => line.offset === null || Math.abs(line.offset) > 1)
    ) {
      renderedBlockFailures.push(`source inner line numbers: ${JSON.stringify(sourceBlockLineNumbers)}`);
    }
    const sourceOuterStarts = await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const outerGutter = editor.view.scrollDOM.querySelector<HTMLElement>(':scope > .cm-gutters');
      const read = (lineNumber: number, _selector: string) => {
        const marker = Array.from(
          outerGutter?.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement') ?? []
        ).find((element) => (
          element.textContent?.trim() === String(lineNumber)
          && getComputedStyle(element).visibility !== 'hidden'
          && element.getBoundingClientRect().height > 0
        ));
        const coords = editor.view.coordsAtPos(editor.view.state.doc.line(lineNumber).from);
        if (!marker || !coords) return null;
        const markerRect = marker.getBoundingClientRect();
        return { lineNumber, blockTopOffset: markerRect.top - coords.top };
      };
      return {
        mermaid: read(20, '.meo-mermaid-editing-block'),
        math: read(25, '.meo-latex-math-editing-block')
      };
    });
    if (
      sourceOuterStarts.mermaid === null ||
      sourceOuterStarts.math === null ||
      Math.abs(sourceOuterStarts.mermaid.blockTopOffset) > 4 ||
      Math.abs(sourceOuterStarts.math.blockTopOffset) > 4
    ) {
      renderedBlockFailures.push(`source outer line numbers: ${JSON.stringify(sourceOuterStarts)}`);
    }
    const sourceOuterAlignment = await readOuterLineNumberAlignment(page, [23, 24, 27, 28]);
    if (sourceOuterAlignment.some((item) => item.offset === null || Math.abs(item.offset) > 1)) {
      throw new Error(`Source rendered-block outer line numbers were misaligned: ${JSON.stringify(sourceOuterAlignment)}`);
    }

    if (renderedBlockFailures.length > 0) {
      throw new Error(`Rendered-block line-number failures:\n${renderedBlockFailures.join('\n')}`);
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
    await page.waitForFunction(() => {
      const states = Array.from(document.querySelectorAll<HTMLElement>('.meo-code-block-actions'))
        .map((toolbar) => ({
          hovered: toolbar.classList.contains('is-block-hovered'),
          opacity: Number.parseFloat(getComputedStyle(toolbar).opacity)
        }));
      return states.filter((state) => state.hovered && state.opacity >= 0.99).length === 1
        && states.filter((state) => state.opacity >= 0.99).length === 1;
    });
    const hoveredActionState = await page.$$eval('.meo-code-block-actions', (toolbars) => (
      toolbars.map((toolbar) => ({
        hovered: toolbar.classList.contains('is-block-hovered'),
        opacity: Number.parseFloat(getComputedStyle(toolbar).opacity)
      }))
    ));
    if (
      hoveredActionState.filter((state) => state.hovered && state.opacity >= 0.99).length !== 1 ||
      hoveredActionState.filter((state) => state.opacity >= 0.99).length !== 1
    ) {
      throw new Error(`Hover did not reveal only the matching code block actions: ${JSON.stringify(hoveredActionState)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      editor.setText(`${editor.view.state.doc.toString()}\n`);
    });
    await waitForFrames(page);
    await page.mouse.move(1, 1);
    const syncedCodeLine = await page.$eval(
      '.meo-md-code-line-numbered[data-meo-code-line-number="10"]',
      (line) => {
        const rect = line.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    );
    await page.mouse.move(syncedCodeLine.x, syncedCodeLine.y);
    await waitForFrames(page);
    const hoveredAfterExternalSync = await page.$$eval('.meo-code-block-actions', (toolbars) => (
      toolbars.filter((toolbar) => (
        toolbar.classList.contains('is-block-hovered') && Number.parseFloat(getComputedStyle(toolbar).opacity) >= 0.99
      )).length
    ));
    if (hoveredAfterExternalSync !== 1) {
      throw new Error('External text sync disabled code block hover actions');
    }

    await page.click('.meo-code-block-actions .meo-select-all-code-btn');
    const selectedCode = await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const selection = editor.view.state.selection.main;
      const toolbar = document.querySelector<HTMLElement>('.meo-code-block-actions');
      return {
        anchor: selection.anchor,
        from: selection.from,
        head: selection.head,
        text: editor.view.state.doc.sliceString(selection.from, selection.to),
        to: selection.to,
        toolbarHovered: toolbar?.classList.contains('is-block-hovered') ?? false,
        toolbarOpacity: toolbar ? Number.parseFloat(getComputedStyle(toolbar).opacity) : null,
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
    if (!selectedCode.toolbarHovered || selectedCode.toolbarOpacity === null || selectedCode.toolbarOpacity < 0.99) {
      throw new Error(`Code block actions disappeared after selection: ${JSON.stringify(selectedCode)}`);
    }
    if (JSON.stringify(selectedCode.controls) !== JSON.stringify(['all', 'copy'])) {
      throw new Error(`Unexpected code block action order: ${JSON.stringify(selectedCode.controls)}`);
    }

    const latexModeTopTrace = await page.evaluate(async () => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const text = [
        ...Array.from({ length: 506 }, (_, index) => `filler ${index + 1}`),
        'Block formula:',
        '',
        '$$',
        '\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}',
        '$$',
        '',
        'tail'
      ].join('\n');
      editor.view.dispatch({
        changes: { from: 0, to: editor.view.state.doc.length, insert: text }
      });
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      editor.scrollToLine(509, 'center');
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      document.querySelector<HTMLButtonElement>('.meo-latex-math-mode-btn')?.click();
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const readTop = () => document.querySelector<HTMLElement>(
        '.meo-latex-math-mode-btn'
      )?.getBoundingClientRect().top ?? null;
      const trace = [readTop()];
      document.querySelector<HTMLButtonElement>('.meo-latex-math-mode-btn')?.click();
      trace.push(readTop());
      for (let frame = 0; frame < 5; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        trace.push(readTop());
      }
      return trace;
    });
    const measuredLatexModeTops = latexModeTopTrace.filter((top): top is number => top !== null);
    if (
      measuredLatexModeTops.length !== latexModeTopTrace.length ||
      Math.max(...measuredLatexModeTops) - Math.min(...measuredLatexModeTops) > 1
    ) {
      throw new Error(`Latex split-to-source transition exposed a moving toolbar frame: ${JSON.stringify(latexModeTopTrace)}`);
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

    await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      editor.destroy();
      document.getElementById('app')!.replaceChildren();
      (window as any).__codeBlockLineNumbersEditor = (window as any).CodeBlockLineNumbersHarness.createEditor({
        parent: document.getElementById('app')!,
        text: ['# Heading 1', '## Heading 2', '### Heading 3', '#### Heading 4', '##### Heading 5', '###### Heading 6', 'Body'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page, 8);
    const headingLineNumberOffsets = await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const outerGutter = editor.view.scrollDOM.querySelector<HTMLElement>(':scope > .cm-gutters');
      return Array.from({ length: 6 }, (_, index) => {
        const lineNumber = index + 1;
        const line = Array.from(editor.view.contentDOM.querySelectorAll<HTMLElement>(':scope > .cm-line'))
          .find((candidate) => candidate.classList.contains(`meo-md-h${lineNumber}`));
        const marker = Array.from(
          outerGutter?.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement') ?? []
        ).find((candidate) => candidate.textContent?.trim() === String(lineNumber));
        const markerText = marker?.firstChild ?? null;
        if (!line || !marker || !markerText) return { lineNumber, offset: null };
        const lineRect = line.getBoundingClientRect();
        const markerRect = marker.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(markerText);
        const markerTextRect = range.getBoundingClientRect();
        return {
          lineNumber,
          offset: markerTextRect.top + markerTextRect.height / 2 - (lineRect.top + lineRect.height / 2),
          lineHeight: lineRect.height,
          markerHeight: markerRect.height,
          markerTextHeight: markerTextRect.height,
          alignItems: getComputedStyle(marker).alignItems
        };
      });
    });
    if (headingLineNumberOffsets.some((item) => item.offset === null || Math.abs(item.offset) > 1)) {
      throw new Error(`Heading line numbers were not vertically centered: ${JSON.stringify(headingLineNumberOffsets)}`);
    }
    const bodyLineAlignment = await page.evaluate(() => {
      const editor = (window as any).__codeBlockLineNumbersEditor;
      const outerGutter = editor.view.scrollDOM.querySelector<HTMLElement>(':scope > .cm-gutters');
      const marker = Array.from(
        outerGutter?.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement') ?? []
      ).find((candidate) => candidate.textContent?.trim() === '7');
      return marker ? {
        alignItems: getComputedStyle(marker).alignItems,
        headingClass: marker.classList.contains('meo-md-heading-line-number')
      } : null;
    });
    if (!bodyLineAlignment || bodyLineAlignment.alignItems !== 'flex-start' || bodyLineAlignment.headingClass) {
      throw new Error(`Body line number inherited heading alignment: ${JSON.stringify(bodyLineAlignment)}`);
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
