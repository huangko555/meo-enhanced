import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-stability-'));

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

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-editor-stability-entry.ts')],
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
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:monospace; --meo-font-source-weight:400; --meo-font-source-size:14px; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const markerLines = [
      '**还有什么：**大客户给的',
      '*还有什么：*大客户给的',
      '~~还有什么：~~大客户给的',
      '**What now:**customer text',
      '*What now;*customer text',
      '~~What now?~~customer text',
      '中文，**粗体一**',
      '中文。`代码一`',
      '中文：~~删除一~~',
      'English. **bold two**',
      'English: `code two`'
    ];
    const bodyLines = Array.from({ length: 100 }, (_, index) => `稳定锚点 ${index + 1}`);
    const headingStrikeLine = '# 标题里的 ~~删除线~~';
    const source = [...markerLines, headingStrikeLine, '', ...bodyLines].join('\n');
    await page.evaluate((text) => {
      (window as any).__editor = (window as any).EditorStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, source);
    await waitForFrames(page);

    const headingStrikeSelectionColors = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('标题里的'));
      const strike = line?.querySelector<HTMLElement>('.meo-md-strike') ?? null;
      const heading = line?.querySelector<HTMLElement>('.meo-md-heading-content') ?? null;
      if (!strike || !heading) return null;
      const normal = getComputedStyle(strike);
      const selected = getComputedStyle(strike, '::selection');
      const headingStyle = getComputedStyle(heading);
      return {
        normalColor: normal.color,
        normalTextFillColor: normal.webkitTextFillColor,
        normalTextDecorationLine: normal.textDecorationLine,
        selectionColor: selected.color,
        selectionTextFillColor: selected.webkitTextFillColor,
        headingColor: headingStyle.color,
        headingTextFillColor: headingStyle.webkitTextFillColor
      };
    });
    if (
      !headingStrikeSelectionColors ||
      headingStrikeSelectionColors.normalColor !== headingStrikeSelectionColors.headingColor ||
      headingStrikeSelectionColors.normalTextFillColor !== headingStrikeSelectionColors.headingTextFillColor ||
      headingStrikeSelectionColors.normalTextDecorationLine !== 'line-through' ||
      headingStrikeSelectionColors.selectionColor !== headingStrikeSelectionColors.headingColor ||
      headingStrikeSelectionColors.selectionTextFillColor !== headingStrikeSelectionColors.headingTextFillColor
    ) {
      throw new Error(`Selected heading strike changed foreground color: ${JSON.stringify(headingStrikeSelectionColors)}`);
    }

    const headingStrikePoint = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('标题里的'));
      const strike = line?.querySelector<HTMLElement>('.meo-md-strike') ?? null;
      const rect = strike?.getBoundingClientRect();
      return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
    });
    if (!headingStrikePoint) throw new Error('Could not locate heading strike for marker color test');
    await page.mouse.click(headingStrikePoint.x, headingStrikePoint.y);
    await waitForFrames(page, 3);
    const headingStrikeMarkerColors = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('标题里的'));
      const syntaxMarker = line?.querySelector<HTMLElement>('.meo-md-marker-active:not(.meo-md-strike-marker-active)') ?? null;
      const strikeMarkers = Array.from(line?.querySelectorAll<HTMLElement>('.meo-md-strike-marker-active') ?? []);
      if (!syntaxMarker || strikeMarkers.length !== 2) return null;
      const syntax = getComputedStyle(syntaxMarker);
      return {
        syntaxColor: syntax.color,
        syntaxTextFillColor: syntax.webkitTextFillColor,
        strikeMarkers: strikeMarkers.map((marker) => {
          const style = getComputedStyle(marker);
          return {
            color: style.color,
            textFillColor: style.webkitTextFillColor,
            textDecorationLine: style.textDecorationLine,
            className: marker.className,
            parentClassName: marker.parentElement?.className ?? ''
          };
        })
      };
    });
    if (
      !headingStrikeMarkerColors ||
      headingStrikeMarkerColors.strikeMarkers.some((marker) => (
        marker.color !== headingStrikeMarkerColors.syntaxColor ||
        marker.textFillColor !== headingStrikeMarkerColors.syntaxTextFillColor ||
        marker.textDecorationLine !== 'none' ||
        marker.parentClassName.includes('meo-md-strike')
      ))
    ) {
      throw new Error(`Heading strike markers did not use Markdown syntax color: ${JSON.stringify(headingStrikeMarkerColors)}`);
    }

    const markerLabels = [
      '还有什么：', '还有什么：', '还有什么：',
      'What now:', 'What now;', 'What now?',
      '粗体一', '代码一', '删除一', 'bold two', 'code two'
    ];
    for (const [index, label] of markerLabels.entries()) {
      const point = await page.evaluate(({ target, lineIndex }) => {
        const line = document.querySelectorAll<HTMLElement>('.cm-line')[lineIndex];
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const offset = node.textContent?.indexOf(target) ?? -1;
          if (offset < 0) continue;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + target.length);
          const rect = range.getBoundingClientRect();
          return { x: rect.left + Math.min(4, rect.width / 2), y: rect.top + rect.height / 2 };
        }
        return null;
      }, { target: label, lineIndex: index });
      if (!point) throw new Error(`Could not find marker test text: ${label}`);
      await page.mouse.click(point.x, point.y);
      await waitForFrames(page, 3);
      const state = await page.evaluate((lineIndex) => {
        const line = document.querySelectorAll<HTMLElement>('.cm-line')[lineIndex];
        const active = line?.querySelectorAll<HTMLElement>('.meo-md-marker-active, .meo-md-code-marker-active, .meo-md-strike-marker-active') ?? [];
        return {
          lineText: line?.textContent ?? '',
          visibleMarkers: Array.from(active).filter((marker) => getComputedStyle(marker).display !== 'none').length
        };
      }, index);
      if (state.visibleMarkers < 2) {
        throw new Error(`Markdown markers did not reveal after punctuation: ${JSON.stringify(state)}`);
      }
      if (index > 0) {
        const previousVisible = await page.evaluate((lineIndex) => {
          const line = document.querySelectorAll<HTMLElement>('.cm-line')[lineIndex];
          return Array.from(line.querySelectorAll<HTMLElement>('.meo-md-marker-active, .meo-md-code-marker-active, .meo-md-strike-marker-active'))
            .some((marker) => getComputedStyle(marker).display !== 'none');
        }, index - 1);
        if (previousVisible) throw new Error(`Markdown markers stayed visible on inactive line ${index}`);
      }
    }

    await page.evaluate(() => (window as any).__editor.scrollToLine(76, 'top'));
    await waitForFrames(page);
    const beforeTop = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('稳定锚点 70'));
      return line?.getBoundingClientRect().top ?? null;
    });
    if (beforeTop === null) throw new Error('Could not locate viewport anchor before external update');

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setText(['后台新增 1', '后台新增 2', '后台新增 3', editor.getText()].join('\n'));
    });
    await waitForFrames(page);
    const after = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('稳定锚点 70'));
      return {
        top: line?.getBoundingClientRect().top ?? null,
        text: (window as any).__editor.getText()
      };
    });
    if (!after.text.startsWith('后台新增 1\n后台新增 2\n后台新增 3\n')) {
      throw new Error('External document update was not applied');
    }
    if (after.top === null || Math.abs(after.top - beforeTop) > 1) {
      throw new Error(`External update moved the viewport anchor: ${beforeTop} -> ${after.top}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setText(editor.getText()
        .replace('稳定锚点 10', '后台改写锚点 10')
        .replace('稳定锚点 90', '后台改写锚点 90'));
    });
    await waitForFrames(page);
    const afterDisjointEdits = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('稳定锚点 70'));
      const editor = (window as any).__editor;
      const position = editor.getText().indexOf('稳定锚点 70');
      return {
        top: line?.getBoundingClientRect().top ?? null,
        position,
        blockTop: editor.view.lineBlockAt(position).top,
        scrollTop: editor.view.scrollDOM.scrollTop,
        topVisible: editor.getTopVisiblePosition()
      };
    });
    if (afterDisjointEdits.top === null || Math.abs(afterDisjointEdits.top - beforeTop) > 1) {
      throw new Error(`Disjoint external edits moved unchanged viewport content: ${beforeTop} -> ${JSON.stringify(afterDisjointEdits)}`);
    }

    const replacementFixture = Array.from({ length: 120 }, (_, index) => `replacement line ${index + 1}`).join('\n');
    await page.evaluate((text) => {
      (window as any).__editor.setText(text);
    }, replacementFixture);
    await waitForFrames(page);
    const replacementPosition = await page.evaluate(() => (window as any).__editor.getTopVisiblePosition());
    if (replacementPosition.line < 65 || replacementPosition.line > 85) {
      throw new Error(`Whole-document external update lost the nearby viewport: ${JSON.stringify(replacementPosition)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.revealSelection(editor.getText().length, editor.getText().length, {
        focusEditor: false,
        align: 'none'
      });
    });
    await waitForFrames(page);
    const afterPreservedReveal = await page.evaluate(() => (window as any).__editor.getTopVisiblePosition());
    if (Math.abs(afterPreservedReveal.line - replacementPosition.line) > 1) {
      throw new Error(`Background selection reveal moved the viewport: ${JSON.stringify({ before: replacementPosition, after: afterPreservedReveal })}`);
    }

    if (process.env.MEO_TEST_VIEWPORT_ONLY === '1') {
      console.log('external update viewport stability checks passed');
      return;
    }

    const lineJumpFixture = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
    lineJumpFixture[124] = '| A | B |';
    lineJumpFixture[125] = '| --- | --- |';
    lineJumpFixture[126] = '| target | value |';
    await page.evaluate((text) => {
      const editor = (window as any).__editor;
      editor.setText(text);
      editor.scrollToLine(374, 'top');
    }, lineJumpFixture.join('\n'));
    await waitForFrames(page);
    await page.evaluate(() => (window as any).__editor.scrollToLine(127, 'upper'));
    await waitForFrames(page);
    const lineJump = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const line = editor.view.state.doc.lineAt(editor.view.state.selection.main.anchor);
      const active = document.activeElement;
      return {
        selectedLine: line.number,
        sourceLine: active?.closest('tr')?.dataset.sourceLineNumber ?? null,
        isTableInput: active instanceof HTMLTextAreaElement
      };
    });
    if (
      lineJump.selectedLine !== 127 ||
      lineJump.sourceLine !== '127' ||
      !lineJump.isTableInput
    ) {
      throw new Error(`Line jump from 374 to table row 127 failed: ${JSON.stringify(lineJump)}`);
    }

    const outlineJump = await page.evaluate(() => {
      const root = document.createElement('div');
      const editorWrapper = document.createElement('div');
      editorWrapper.className = 'editor-wrapper';
      const outlineButton = document.createElement('button');
      root.append(editorWrapper, outlineButton);
      document.body.appendChild(root);
      let headings = [
        { text: '7. Overview', level: 2, from: 20, line: 3 },
        { text: '7.4 Target', level: 3, from: 100, line: 10 }
      ];
      const scrolledLines: number[] = [];
      const editorApi = {
        getHeadings: () => headings,
        getViewportAnchorOffset: () => 0,
        getVisibleDocumentRange: () => ({ from: 20, to: 300, fromLine: 3, toLine: 20 }),
        getScrollElement: () => editorWrapper,
        scrollToLine: (line: number) => scrolledLines.push(line),
        moveHeadingSection: () => false
      };
      const outline = (window as any).EditorStabilityHarness.createOutlineController({
        root,
        editorWrapper,
        outlineButton,
        getEditor: () => editorApi
      });
      editorWrapper.appendChild(outline.sidebar);
      editorWrapper.style.setProperty('--meo-background', 'rgb(12, 34, 56)');
      editorWrapper.style.setProperty('--meo-outline-background', 'rgb(1, 2, 3)');
      outline.setVisible(true);
      outline.refresh();
      outline.setMode('fixed');
      const fixedBackground = getComputedStyle(outline.sidebar).backgroundColor;
      outline.setMode('floating');
      const floatingBackground = getComputedStyle(outline.sidebar).backgroundColor;
      const visibleItems = Array.from(outline.sidebar.querySelectorAll<HTMLButtonElement>('.outline-item.is-visible'));
      const visibleClassState = visibleItems.map((item) => ({
        title: item.title,
        first: item.classList.contains('is-visible-first')
      }));
      const resizer = outline.sidebar.querySelector<HTMLElement>('.outline-resizer')!;
      let wheelBubbled = false;
      root.addEventListener('wheel', () => {
        wheelBubbled = true;
      });
      const wheelAllowed = resizer.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 100 }));
      const resizerWidth = getComputedStyle(resizer).width;

      // Simulate a background edit that moved the target heading while the visible
      // outline still carries its previous line number. Line 10 is now a nearby
      // ordered-list item in the real document.
      headings = [
        { text: '7. Overview', level: 2, from: 20, line: 3 },
        { text: '7.4 Target', level: 3, from: 260, line: 20 }
      ];
      const target = Array.from(outline.sidebar.querySelectorAll<HTMLButtonElement>('.outline-item'))
        .find((item) => item.title === '7.4 Target');
      target?.click();
      root.remove();
      return {
        fixedBackground,
        floatingBackground,
        scrolledLines,
        visibleClassState,
        wheelAllowed,
        wheelBubbled,
        resizerWidth
      };
    });
    if (outlineJump.scrolledLines.at(-1) !== 20) {
      throw new Error(`Stale outline item jumped to nearby ordered-list line: ${JSON.stringify(outlineJump)}`);
    }
    if (
      outlineJump.visibleClassState.length !== 2 ||
      outlineJump.visibleClassState[0]?.first !== true ||
      outlineJump.visibleClassState[1]?.first !== false
    ) {
      throw new Error(`Visible outline range did not mark only its first title: ${JSON.stringify(outlineJump.visibleClassState)}`);
    }
    if (outlineJump.wheelAllowed || outlineJump.wheelBubbled) {
      throw new Error(`Outline resize handle did not block wheel input: ${JSON.stringify(outlineJump)}`);
    }
    if (outlineJump.resizerWidth !== '12px') {
      throw new Error(`Outline divider or scrollbar styling was not applied: ${JSON.stringify(outlineJump)}`);
    }
    if (
      outlineJump.fixedBackground !== 'rgb(12, 34, 56)' ||
      outlineJump.floatingBackground !== outlineJump.fixedBackground
    ) {
      throw new Error(`Floating outline background differed from fixed mode: ${JSON.stringify(outlineJump)}`);
    }

    console.log('editor marker and viewport stability browser tests passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
