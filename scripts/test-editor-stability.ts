import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-stability-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function countRenderedHeadingStrikePixels(page: Page): Promise<{ heading: number; foreground: number }> {
  const rect = await page.evaluate(() => {
    const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
      .find((candidate) => candidate.textContent?.includes('标题里的'));
    const strike = line?.querySelector<HTMLElement>('.meo-md-strike') ?? null;
    const bounds = strike?.getBoundingClientRect();
    return bounds ? { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height } : null;
  });
  if (!rect) throw new Error('Could not capture selected heading strike pixels');
  const png = await page.screenshot({
    clip: {
      x: Math.max(0, Math.floor(rect.x)),
      y: Math.max(0, Math.floor(rect.y)),
      width: Math.max(1, Math.ceil(rect.width)),
      height: Math.max(1, Math.ceil(rect.height))
    },
    encoding: 'base64'
  });
  return page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = {
      heading: [121, 184, 255],
      foreground: [230, 237, 243]
    };
    const counts = { heading: 0, foreground: 0 };
    for (let offset = 0; offset < pixels.length; offset += 4) {
      for (const [name, color] of Object.entries(colors) as Array<[keyof typeof counts, number[]]>) {
        const distance = Math.hypot(
          pixels[offset] - color[0],
          pixels[offset + 1] - color[1],
          pixels[offset + 2] - color[2]
        );
        if (distance < 36) counts[name] += 1;
      }
    }
    return counts;
  }, png);
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

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#202223; --meo-foreground:#e6edf3; --meo-semantic-markdownSyntax:#8b949e; --meo-semantic-mutedForeground:#8b949e; --meo-semantic-tableBorder:#3e444d; --meo-font-live:Arial; --meo-font-live-weight:400; --meo-font-live-size:16px; --meo-font-source:monospace; --meo-font-source-weight:400; --meo-font-source-size:14px; } .cm-editor .meo-md-strike::selection { color: var(--meo-foreground); -webkit-text-fill-color: var(--meo-foreground); }'
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
    const headingStrikeLine = '# 标题里的 **粗体 `内`** ~~删除中的 *斜体*~~ `外`';
    const source = [...markerLines, headingStrikeLine, '', ...bodyLines].join('\n');
    await page.evaluate((text) => {
      (window as any).__editor = (window as any).EditorStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, source);
    const frontmatterProperties = await page.evaluate(() => {
      const host = document.createElement('div');
      host.style.width = '760px';
      document.body.appendChild(host);
      const text = [
        '---',
        'title: Properties preview',
        'tags: [Markdown, Editor]',
        'metadata:',
        '  owner: Example',
        '  - https://example.com/docs',
        '---',
        '# Body'
      ].join('\n');
      const editor = (window as any).EditorStabilityHarness.createEditor({
        parent: host,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });

      editor.view.dispatch({ selection: { anchor: text.length } });
      const opening = host.querySelector<HTMLElement>('.meo-md-frontmatter-opening');
      const initial = {
        text: editor.getText(),
        hasOpening: Boolean(opening),
        hasClosing: Boolean(host.querySelector('.meo-md-frontmatter-closing')),
        label: host.querySelector<HTMLElement>('.meo-code-language-label')?.textContent ?? '',
        pills: host.querySelectorAll('.meo-md-frontmatter-pill').length,
        cardShadow: opening ? getComputedStyle(opening).boxShadow : 'none'
      };

      const tagsOffset = text.indexOf('[Markdown, Editor]') + 2;
      editor.view.dispatch({ selection: { anchor: tagsOffset } });
      const activeTagsLine = Array.from(host.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent?.includes('tags:'));
      const active = {
        pills: host.querySelectorAll('.meo-md-frontmatter-pill').length,
        lineText: activeTagsLine?.textContent ?? ''
      };

      const editOffset = editor.getText().indexOf('Example') + 'Example'.length;
      editor.view.dispatch({ changes: { from: editOffset, to: editOffset, insert: ' Updated' } });
      const editedText = editor.getText();
      editor.setMode('source');
      const sourceMode = {
        text: editor.getText(),
        liveBoundaries: host.querySelectorAll('.meo-md-frontmatter-boundary').length,
        delimiters: host.querySelectorAll('.meo-md-frontmatter-delimiter-line').length
      };

      editor.destroy();
      host.remove();
      return { initial, active, editedText, sourceMode };
    });
    if (
      !frontmatterProperties.initial.hasOpening
      || !frontmatterProperties.initial.hasClosing
      || frontmatterProperties.initial.label !== 'Properties'
      || frontmatterProperties.initial.pills !== 2
      || frontmatterProperties.initial.cardShadow === 'none'
    ) {
      throw new Error(`Live Frontmatter did not render as Properties: ${JSON.stringify(frontmatterProperties.initial)}`);
    }
    if (
      frontmatterProperties.active.pills !== 0
      || !frontmatterProperties.active.lineText.includes('[Markdown, Editor]')
      || !frontmatterProperties.editedText.includes('owner: Example Updated')
    ) {
      throw new Error(`Live Frontmatter was not directly editable: ${JSON.stringify(frontmatterProperties)}`);
    }
    if (
      frontmatterProperties.sourceMode.text !== frontmatterProperties.editedText
      || frontmatterProperties.sourceMode.liveBoundaries !== 0
      || frontmatterProperties.sourceMode.delimiters !== 2
    ) {
      throw new Error(`Source mode Frontmatter was changed by Properties rendering: ${JSON.stringify(frontmatterProperties.sourceMode)}`);
    }
    const lineInputStyle = await page.evaluate(() => {
      const input = document.createElement('input');
      input.className = 'line-jump-input';
      input.placeholder = 'Line';
      document.body.appendChild(input);
      const style = getComputedStyle(input);
      const result = {
        placeholderAlignment: getComputedStyle(input, '::placeholder').textAlign,
        borderWidth: style.borderTopWidth,
        borderColor: style.borderTopColor
      };
      input.remove();
      return result;
    });
    if (lineInputStyle.placeholderAlignment !== 'center') {
      throw new Error(`Line jump placeholder was not centered: ${lineInputStyle.placeholderAlignment}`);
    }
    if (lineInputStyle.borderWidth !== '1px' || lineInputStyle.borderColor !== 'rgb(84, 89, 94)') {
      throw new Error(`Line jump input did not use the 1px gray border: ${JSON.stringify(lineInputStyle)}`);
    }
    const genericFocusOutline = await page.evaluate(() => {
      const button = document.createElement('button');
      button.textContent = 'focus probe';
      document.body.appendChild(button);
      button.focus();
      const style = getComputedStyle(button);
      const result = { style: style.outlineStyle, width: style.outlineWidth };
      button.remove();
      return result;
    });
    if (genericFocusOutline.style !== 'none' && genericFocusOutline.width !== '0px') {
      throw new Error(`Generic focused control retained a browser outline: ${JSON.stringify(genericFocusOutline)}`);
    }
    await waitForFrames(page);

    const headingSelectionDrag = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('标题里的'));
      if (!line) return null;
      const pointForText = (target: string, atEnd: boolean) => {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const offset = node.textContent?.indexOf(target) ?? -1;
          if (offset < 0) continue;
          const range = document.createRange();
          range.setStart(node, offset);
          range.setEnd(node, offset + target.length);
          const rect = range.getBoundingClientRect();
          return { x: atEnd ? rect.right - 1 : rect.left + 1, y: rect.top + rect.height / 2 };
        }
        return null;
      };
      const start = pointForText('斜体', false);
      const end = pointForText('外', true);
      return start && end ? { start, end } : null;
    });
    if (!headingSelectionDrag) throw new Error('Could not locate mixed heading selection endpoints');
    await page.mouse.move(headingSelectionDrag.start.x, headingSelectionDrag.start.y);
    await page.mouse.down();
    await page.mouse.move(headingSelectionDrag.end.x, headingSelectionDrag.end.y, { steps: 8 });
    await page.mouse.up();
    await waitForFrames(page, 3);

    const headingStrikeSelectionColors = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('标题里的'));
      const strike = line?.querySelector<HTMLElement>('.meo-md-strike') ?? null;
      const nestedEmMarker = line?.querySelector<HTMLElement>(
        '.meo-md-strike :is(.meo-md-em-marker, .meo-md-em-marker-active)'
      ) ?? null;
      const nestedEmMarkerText = nestedEmMarker?.firstElementChild as HTMLElement | null;
      const heading = line?.querySelector<HTMLElement>('.meo-md-heading-content') ?? null;
      if (!strike || !nestedEmMarkerText || !heading) return null;
      const normal = getComputedStyle(strike);
      const selected = getComputedStyle(strike, '::selection');
      const markerNormal = getComputedStyle(nestedEmMarkerText);
      const markerSelected = getComputedStyle(nestedEmMarkerText, '::selection');
      const headingStyle = getComputedStyle(heading);
      return {
        normalColor: normal.color,
        normalTextFillColor: normal.webkitTextFillColor,
        normalTextDecorationLine: normal.textDecorationLine,
        selectionColor: selected.color,
        selectionTextFillColor: selected.webkitTextFillColor,
        markerColor: markerNormal.color,
        markerTextFillColor: markerNormal.webkitTextFillColor,
        markerSelectionColor: markerSelected.color,
        markerSelectionTextFillColor: markerSelected.webkitTextFillColor,
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
      headingStrikeSelectionColors.selectionTextFillColor !== headingStrikeSelectionColors.headingTextFillColor ||
      headingStrikeSelectionColors.markerSelectionColor !== headingStrikeSelectionColors.markerTextFillColor ||
      headingStrikeSelectionColors.markerSelectionTextFillColor !== headingStrikeSelectionColors.markerTextFillColor
    ) {
      throw new Error(`Selected heading strike changed foreground color: ${JSON.stringify(headingStrikeSelectionColors)}`);
    }

    const headingStrikePixelCounts = await countRenderedHeadingStrikePixels(page);
    if (headingStrikePixelCounts.heading <= headingStrikePixelCounts.foreground) {
      throw new Error(`Selected heading strike rendered as foreground white: ${JSON.stringify(headingStrikePixelCounts)}`);
    }

    const headingStrikeMarkerColors = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('标题里的'));
      const syntaxMarker = line?.querySelector<HTMLElement>('.meo-md-marker-active:not(.meo-md-strike-marker-active)') ?? null;
      const strongMarkers = Array.from(line?.querySelectorAll<HTMLElement>('.meo-md-strong-marker-active') ?? []);
      const emMarkers = Array.from(line?.querySelectorAll<HTMLElement>('.meo-md-em-marker-active') ?? []);
      const strikeMarkers = Array.from(line?.querySelectorAll<HTMLElement>('.meo-md-strike-marker-active') ?? []);
      if (!syntaxMarker || strongMarkers.length !== 2 || emMarkers.length !== 2 || strikeMarkers.length !== 2) return null;
      const strong = getComputedStyle(strongMarkers[0]);
      const markerState = (marker: HTMLElement) => {
        const style = getComputedStyle(marker);
        const textElement = Array.from(marker.querySelectorAll<HTMLElement>('span')).at(-1) ?? marker;
        const textStyle = getComputedStyle(textElement);
        return {
          inlineStyle: marker.getAttribute('style') ?? '',
          color: style.color,
          textFillColor: style.webkitTextFillColor,
          fontStyle: style.fontStyle,
          textDecorationLine: style.textDecorationLine,
          textElementColor: textStyle.color,
          textElementTextFillColor: textStyle.webkitTextFillColor,
          textElementFontStyle: textStyle.fontStyle,
          textElementFontWeight: textStyle.fontWeight,
          textElementTextDecorationLine: textStyle.textDecorationLine,
          className: marker.className,
          parentClassName: marker.parentElement?.className ?? '',
          strikeAncestorClassName: marker.closest('.meo-md-strike')?.className ?? ''
        };
      };
      const syntaxMarkerState = markerState(syntaxMarker);
      return {
        syntaxMarkerState,
        strongMarkerStyle: strongMarkers[0].getAttribute('style') ?? '',
        strongMarkerColor: strong.color,
        strongMarkerTextFillColor: strong.webkitTextFillColor,
        strongMarkers: strongMarkers.map(markerState),
        emMarkers: emMarkers.map(markerState),
        strikeMarkers: strikeMarkers.map(markerState)
      };
    });
    if (
      !headingStrikeMarkerColors ||
      [...headingStrikeMarkerColors.strongMarkers, ...headingStrikeMarkerColors.emMarkers, ...headingStrikeMarkerColors.strikeMarkers]
        .some((marker) => (
        marker.inlineStyle !== headingStrikeMarkerColors.strongMarkerStyle ||
        marker.color !== headingStrikeMarkerColors.strongMarkerColor ||
        marker.textFillColor !== headingStrikeMarkerColors.strongMarkerTextFillColor ||
        marker.color !== headingStrikeMarkerColors.syntaxMarkerState.color ||
        marker.textFillColor !== headingStrikeMarkerColors.syntaxMarkerState.textFillColor ||
        marker.fontStyle !== 'normal' ||
        marker.textDecorationLine !== 'none' ||
        marker.textElementColor !== headingStrikeMarkerColors.strongMarkers[0].textElementColor ||
        marker.textElementTextFillColor !== headingStrikeMarkerColors.syntaxMarkerState.textElementTextFillColor ||
        marker.textElementFontStyle !== headingStrikeMarkerColors.syntaxMarkerState.textElementFontStyle ||
        marker.textElementFontWeight !== headingStrikeMarkerColors.syntaxMarkerState.textElementFontWeight ||
        marker.textElementTextDecorationLine !== headingStrikeMarkerColors.syntaxMarkerState.textElementTextDecorationLine
      ))
    ) {
      throw new Error(`Inline style markers did not match Markdown syntax presentation: ${JSON.stringify(headingStrikeMarkerColors)}`);
    }

    const inlineCodeMarkerStyles = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('标题里的'));
      const markers = Array.from(line?.querySelectorAll<HTMLElement>('.meo-md-code-marker-active') ?? []);
      if (markers.length !== 4) return null;
      return markers.map((marker) => {
        const textElement = Array.from(marker.querySelectorAll<HTMLElement>('span')).at(-1) ?? marker;
        const style = getComputedStyle(textElement);
        return {
          color: style.color,
          textFillColor: style.webkitTextFillColor,
          fontStyle: style.fontStyle,
          fontWeight: style.fontWeight,
          textDecorationLine: style.textDecorationLine
        };
      });
    });
    if (
      !inlineCodeMarkerStyles ||
      inlineCodeMarkerStyles.slice(0, 2).some((style) => (
        JSON.stringify(style) !== JSON.stringify(inlineCodeMarkerStyles[2])
      )) ||
      JSON.stringify(inlineCodeMarkerStyles[2]) !== JSON.stringify(inlineCodeMarkerStyles[3])
    ) {
      throw new Error(`Nested inline-code markers did not match standalone markers: ${JSON.stringify(inlineCodeMarkerStyles)}`);
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
        {
          text: '7. Overview bold',
          inlineSegments: [
            { text: '7. Overview ', strong: false, emphasis: false, strikethrough: false },
            { text: 'bold', strong: true, emphasis: false, strikethrough: false }
          ],
          level: 1,
          from: 20,
          line: 3
        },
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
      const firstOutlineItem = outline.sidebar.querySelector<HTMLElement>('.outline-level-1')!;
      const firstOutlineStrong = firstOutlineItem.querySelector<HTMLElement>('strong')!;
      const outlineWeights = {
        normal: getComputedStyle(firstOutlineItem).fontWeight,
        strong: getComputedStyle(firstOutlineStrong).fontWeight
      };

      // Simulate a background edit that moved the target heading while the visible
      // outline still carries its previous line number. Line 10 is now a nearby
      // ordered-list item in the real document.
      headings = [
        { text: '7. Overview bold', level: 1, from: 20, line: 3 },
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
        resizerWidth,
        outlineWeights
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
    if (outlineJump.outlineWeights.normal !== '400' || Number(outlineJump.outlineWeights.strong) <= 400) {
      throw new Error(`Outline base and explicit strong weights were not distinct: ${JSON.stringify(outlineJump.outlineWeights)}`);
    }
    if (
      outlineJump.fixedBackground !== 'rgb(12, 34, 56)' ||
      outlineJump.floatingBackground !== outlineJump.fixedBackground
    ) {
      throw new Error(`Floating outline background differed from fixed mode: ${JSON.stringify(outlineJump)}`);
    }

    await page.evaluate((text) => {
      (window as any).__editor.setText(text);
    }, '# 标题普通 **粗体 *粗斜* `粗码`** *斜体 `斜码`* `独码`');
    await waitForFrames(page);
    const inlineStyleComposition = await page.evaluate(() => {
      const line = document.querySelector<HTMLElement>('.cm-line');
      if (!line) return null;
      const textStyle = (target: string) => {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.includes(target) || !(node.parentElement instanceof HTMLElement)) continue;
          const style = getComputedStyle(node.parentElement);
          return {
            fontFamily: style.fontFamily,
            fontStyle: style.fontStyle,
            fontWeight: style.fontWeight,
            textDecorationLine: style.textDecorationLine
          };
        }
        return null;
      };
      return {
        heading: textStyle('标题普通'),
        strong: textStyle('粗体'),
        strongEm: textStyle('粗斜'),
        strongCode: textStyle('粗码'),
        em: textStyle('斜体'),
        emCode: textStyle('斜码'),
        standaloneCode: textStyle('独码')
      };
    });
    if (
      !inlineStyleComposition?.heading ||
      !inlineStyleComposition.strong ||
      !inlineStyleComposition.strongEm ||
      !inlineStyleComposition.strongCode ||
      !inlineStyleComposition.em ||
      !inlineStyleComposition.emCode ||
      !inlineStyleComposition.standaloneCode ||
      Number(inlineStyleComposition.heading.fontWeight) !== 400 ||
      Number(inlineStyleComposition.strong.fontWeight) <= Number(inlineStyleComposition.heading.fontWeight) ||
      inlineStyleComposition.strongEm.fontWeight !== inlineStyleComposition.strong.fontWeight ||
      inlineStyleComposition.strongEm.fontStyle !== 'italic' ||
      inlineStyleComposition.strongCode.fontWeight !== inlineStyleComposition.strong.fontWeight ||
      inlineStyleComposition.strongCode.fontFamily !== inlineStyleComposition.standaloneCode.fontFamily ||
      inlineStyleComposition.emCode.fontStyle !== inlineStyleComposition.em.fontStyle ||
      inlineStyleComposition.emCode.fontFamily !== inlineStyleComposition.standaloneCode.fontFamily ||
      inlineStyleComposition.strongCode.textDecorationLine !== 'none'
    ) {
      throw new Error(`Live inline styles did not compose by property: ${JSON.stringify(inlineStyleComposition)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setText('anchor\n**粗体**\n[普通链接](https://example.com/path)\n![示例](https://example.invalid/image.png)\ntail');
      editor.view.dispatch({ selection: { anchor: 0 } });
    });
    await waitForFrames(page, 3);
    const activateStaleTableInteraction = () => page.evaluate(() => {
      const editor = (window as any).__editor;
      const staleOwner = document.createElement('div');
      staleOwner.className = 'meo-md-html-table-shell';
      editor.view.dom.dispatchEvent(new CustomEvent('meo-table-interaction', {
        detail: { active: true, owner: staleOwner }
      }));
    });
    await activateStaleTableInteraction();
    const boldPoint = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('粗体'))!;
      const text = Array.from(line.childNodes).find((node) => node.textContent?.includes('粗体'))!;
      const range = document.createRange();
      range.selectNodeContents(text);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.click(boldPoint.x, boldPoint.y);
    await waitForFrames(page, 3);
    const boldMarkerVisible = await page.evaluate(() => {
      const marker = document.querySelector<HTMLElement>('.meo-md-strong-marker-active');
      return Boolean(marker && getComputedStyle(marker).display !== 'none');
    });
    if (!boldMarkerVisible) throw new Error('Inline Markdown markers did not recover from stale table interaction');

    await activateStaleTableInteraction();
    await waitForFrames(page, 3);
    const ordinaryLinkPoint = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('普通链接'))!;
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const offset = node.textContent?.indexOf('普通链接') ?? -1;
        if (offset < 0) continue;
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + 4);
        const rect = range.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
      throw new Error('Could not locate ordinary Markdown link label');
    });
    await page.mouse.click(ordinaryLinkPoint.x, ordinaryLinkPoint.y);
    await waitForFrames(page, 3);
    const ordinaryLinkState = await page.evaluate(() => {
      const line = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((candidate) => candidate.textContent?.includes('普通链接'));
      return {
        text: line?.textContent ?? '',
        hiddenUrlCount: line?.querySelectorAll('.meo-md-link-url-hidden').length ?? 0,
        tableInteractionActive: document.querySelector('.cm-editor')?.classList.contains('meo-table-interaction-active') ?? false
      };
    });
    if (ordinaryLinkState.hiddenUrlCount !== 0) {
      throw new Error(`Ordinary Markdown link did not recover from stale table interaction: ${JSON.stringify(ordinaryLinkState)}`);
    }

    await activateStaleTableInteraction();
    await page.click('.meo-md-image');
    await waitForFrames(page, 3);
    const imageSourceState = await page.evaluate(() => ({
      selectionHead: (window as any).__editor.view.state.selection.main.head,
      lines: Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).map((line) => ({
        innerText: line.innerText,
        textContent: line.textContent ?? ''
      }))
    }));
    if (
      !imageSourceState.lines.some((line) => line.innerText.includes('![示例](https://example.invalid/image.png)'))
    ) {
      throw new Error(`Markdown image source did not recover from stale table interaction: ${JSON.stringify(imageSourceState)}`);
    }

    console.log('editor marker and viewport stability browser tests passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
