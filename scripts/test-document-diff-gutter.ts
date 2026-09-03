import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-document-diff-gutter-'));

async function waitForFrames(page: Page, count = 4): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function assertCompactMarkerPlacement(page: Page, mode: 'source' | 'live'): Promise<void> {
  const geometry = await page.evaluate(() => {
    const stripe = document.querySelector<HTMLElement>(
      '.meo-git-gutter-marker:is(.is-added, .is-modified) .meo-git-gutter-stripe'
    );
    const lineNumber = Array.from(
      document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')
    ).find((element) => element.textContent?.trim());
    const content = document.querySelector<HTMLElement>('.cm-content');
    if (!stripe || !lineNumber || !content) return null;

    const lineNumberRange = document.createRange();
    lineNumberRange.selectNodeContents(lineNumber);
    const stripeRect = stripe.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    return {
      lineNumberTextRight: lineNumberRange.getBoundingClientRect().right,
      stripeLeft: stripeRect.left,
      stripeRight: stripeRect.right,
      contentLeft: contentRect.left
    };
  });
  if (
    !geometry ||
    geometry.stripeLeft - geometry.lineNumberTextRight < 4 ||
    geometry.contentLeft - geometry.stripeRight < 4
  ) {
    throw new Error(`${mode} compact change marker was not separated from both line numbers and content: ${JSON.stringify(geometry)}`);
  }
}

async function assertDetailBackgroundContinuity(page: Page, label: string): Promise<void> {
  const layout = await page.evaluate(() => {
    const hasLineNumbers = document.querySelector('.cm-lineNumbers') !== null;
    const signGutter = document.querySelector<HTMLElement>('.cm-gutter.meo-git-diff-sign-gutter');
    const resolvedPixel = (background: string): number[] => {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      const context = canvas.getContext('2d')!;
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--meo-background').trim();
      context.fillRect(0, 0, 1, 1);
      context.fillStyle = background;
      context.fillRect(0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data);
    };
    const collect = (kind: 'current' | 'original') => {
      const rows = Array.from(document.querySelectorAll<HTMLElement>(
        kind === 'current' ? '.meo-git-diff-current-line' : '.meo-git-diff-original-line'
      ));
      const gutterRows = Array.from(document.querySelectorAll<HTMLElement>(
        `.cm-lineNumbers .meo-git-diff-${kind}-gutter-row`
      ));
      return rows.map((row, index) => {
        const rect = row.getBoundingClientRect();
        const lineHeight = Number.parseFloat(getComputedStyle(row).lineHeight);
        const visualRows = Math.max(1, Math.round(rect.height / lineHeight));
        const connectionStart = hasLineNumbers
          ? gutterRows[index]?.getBoundingClientRect().right ?? rect.left
          : signGutter?.getBoundingClientRect().right ?? rect.left;
        return {
          kind,
          index,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          lineHeight,
          visualRows,
          connectionStart,
          expected: resolvedPixel(getComputedStyle(row).backgroundColor)
        };
      });
    };
    return [...collect('current'), ...collect('original')];
  });
  const screenshot = await page.screenshot({ encoding: 'base64' });
  const mismatches = await page.evaluate(async ({ imageData, rows }) => {
    const image = new Image();
    image.src = `data:image/png;base64,${imageData}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(image, 0, 0);
    const pixel = (x: number, y: number): number[] => (
      Array.from(context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data)
    );
    return rows.flatMap((row) => Array.from({ length: row.visualRows }, (_, visualIndex) => {
      const y = Math.min(row.bottom - 2, row.top + row.lineHeight * (visualIndex + 0.5));
      const expected = row.expected;
      const wrong = Array.from(
        { length: Math.max(0, Math.ceil(row.left) - Math.floor(row.connectionStart)) },
        (_, offset) => {
          const x = Math.floor(row.connectionStart) + offset;
          const actual = pixel(x, y);
          return JSON.stringify(actual) === JSON.stringify(expected) ? null : { x, actual };
        }
      ).filter((value) => value !== null);
      return wrong.length > 0 ? [{ ...row, visualIndex, expected, wrong }] : [];
    }).flat());
  }, { imageData: screenshot, rows: layout });
  if (mismatches.length > 0) {
    throw new Error(`${label} detail backgrounds were discontinuous: ${JSON.stringify(mismatches)}`);
  }
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
    await page.setViewport({ width: 900, height: 500, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-font-source:monospace; --meo-font-source-weight:400; --meo-font-source-size:14px; --git-deleted:#e05252; }' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      document.querySelector<HTMLElement>('#app')!.classList.add('editor-host');
      const editor = (window as any).EditorStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: 'first\nlast',
        initialMode: 'source',
        onApplyChanges() {}
      });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nremoved one\nremoved two\nlast'
      });
      (window as any).__editor = editor;
    });
    await waitForFrames(page);

    await page.evaluate(() => {
      const harness = (window as any).EditorStabilityHarness;
      const editor = (window as any).__editor;
      editor.setText('first\ncurrent value\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\noriginal value\nlast'
      });
      harness.setGitDiffLineHighlightsEnabled(editor, true);
      const selection = 'first\n'.length;
      editor.revealSelection(selection, selection, { focus: false });
    });
    await waitForFrames(page, 4);
    await assertCompactMarkerPlacement(page, 'source');
    await page.evaluate(() => (window as any).__editor.setMode('live'));
    await waitForFrames(page, 4);
    await assertCompactMarkerPlacement(page, 'live');
    await page.evaluate(() => (window as any).__editor.setMode('source'));
    await waitForFrames(page, 4);
    const compactLayoutBaseline = await page.evaluate(() => ({
      contentLeft: document.querySelector<HTMLElement>('.meo-diff-changed-line')!.getBoundingClientRect().left,
      lineNumberLeft: document.querySelector<HTMLElement>('.cm-lineNumbers .cm-gutterElement:nth-child(3)')
        ?.getBoundingClientRect().left ?? null,
      lineNumberRight: document.querySelector<HTMLElement>('.cm-lineNumbers .cm-gutterElement:nth-child(3)')
        ?.getBoundingClientRect().right ?? null,
      standardGutterWidth: document.querySelector<HTMLElement>('.cm-gutter.meo-git-gutter')!
        .getBoundingClientRect().width
    }));
    await page.evaluate(() => {
      const harness = (window as any).EditorStabilityHarness;
      harness.setGitDiffDetailsVisible((window as any).__editor, true);
    });
    await waitForFrames(page, 4);
    const detailedModifiedGeometry = await page.evaluate(() => {
      const oldContent = document.querySelector<HTMLElement>('.meo-git-diff-original-content');
      const oldSign = document.querySelector<HTMLElement>('.meo-git-diff-sign.is-original');
      const currentLine = document.querySelector<HTMLElement>('.meo-diff-changed-line');
      const currentSign = document.querySelector<HTMLElement>('.meo-git-diff-sign.is-current');
      const currentLineNumber = document.querySelector<HTMLElement>(
        '.cm-lineNumbers .meo-git-diff-current-gutter-row'
      );
      const originalLineNumber = document.querySelector<HTMLElement>(
        '.cm-lineNumbers .meo-git-diff-original-gutter-row'
      );
      const currentSignCell = currentSign?.closest<HTMLElement>('.cm-gutterElement') ?? null;
      const originalSignCell = oldSign?.closest<HTMLElement>('.cm-gutterElement') ?? null;
      const standardGutter = document.querySelector<HTMLElement>('.cm-gutter.meo-git-gutter');
      const standardGutterMarker = standardGutter?.querySelector<HTMLElement>('.meo-git-gutter-marker.is-modified')
        ?? null;
      const currentStandardGutterRow = standardGutter?.querySelector<HTMLElement>(
        '.meo-git-diff-current-gutter-row'
      ) ?? null;
      const originalStandardGutterRow = standardGutter?.querySelector<HTMLElement>(
        '.meo-git-diff-original-gutter-row'
      ) ?? null;
      const signGutter = document.querySelector<HTMLElement>('.cm-gutter.meo-git-diff-sign-gutter');
      const overviewMarker = document.querySelector<HTMLElement>('.meo-git-overview-ruler-marker.is-modified');
      const expectedAddedBackground = document.createElement('span');
      expectedAddedBackground.style.backgroundColor = 'color-mix(in srgb, var(--git-added) 12%, transparent)';
      const expectedDeletedBackground = document.createElement('span');
      expectedDeletedBackground.style.backgroundColor = 'color-mix(in srgb, var(--git-deleted) 12%, transparent)';
      document.body.append(expectedAddedBackground, expectedDeletedBackground);
      const expectedCurrentBackground = getComputedStyle(expectedAddedBackground).backgroundColor;
      const expectedOriginalBackground = getComputedStyle(expectedDeletedBackground).backgroundColor;
      expectedAddedBackground.remove();
      expectedDeletedBackground.remove();
      return {
        oldContentLeft: oldContent?.getBoundingClientRect().left ?? null,
        currentContentLeft: currentLine?.getBoundingClientRect().left ?? null,
        oldSignCenter: oldSign ? oldSign.getBoundingClientRect().left + oldSign.getBoundingClientRect().width / 2 : null,
        currentSignCenter: currentSign
          ? currentSign.getBoundingClientRect().left + currentSign.getBoundingClientRect().width / 2
          : null,
        currentUsesPlusIcon: currentSign?.querySelector('svg.lucide-plus') !== null,
        originalUsesMinusIcon: oldSign?.querySelector('svg.lucide-minus') !== null,
        currentBackground: currentLine ? getComputedStyle(currentLine).backgroundColor : null,
        expectedCurrentBackground,
        originalBackground: oldContent
          ? getComputedStyle(oldContent.closest<HTMLElement>('.meo-git-diff-original-line')!).backgroundColor
          : null,
        expectedOriginalBackground,
        currentLineNumberBackground: currentLineNumber ? getComputedStyle(currentLineNumber).backgroundColor : null,
        originalLineNumberBackground: originalLineNumber ? getComputedStyle(originalLineNumber).backgroundColor : null,
        currentSignCellBackground: currentSignCell ? getComputedStyle(currentSignCell).backgroundColor : null,
        originalSignCellBackground: originalSignCell ? getComputedStyle(originalSignCell).backgroundColor : null,
        currentLineNumberBackgroundImage: currentLineNumber
          ? getComputedStyle(currentLineNumber).backgroundImage
          : null,
        originalLineNumberBackgroundImage: originalLineNumber
          ? getComputedStyle(originalLineNumber).backgroundImage
          : null,
        currentStandardGutterBackground: currentStandardGutterRow
          ? getComputedStyle(currentStandardGutterRow).backgroundColor
          : null,
        originalStandardGutterBackground: originalStandardGutterRow
          ? getComputedStyle(originalStandardGutterRow).backgroundColor
          : null,
        currentGapFill: currentLine ? getComputedStyle(currentLine).boxShadow : null,
        originalGapFill: oldContent
          ? getComputedStyle(oldContent.closest<HTMLElement>('.meo-git-diff-original-line')!).boxShadow
          : null,
        currentLineNumberLeft: currentLineNumber?.getBoundingClientRect().left ?? null,
        currentLineNumberRight: currentLineNumber?.getBoundingClientRect().right ?? null,
        currentLineNumberTextLeft: currentLineNumber?.firstChild
          ? (() => {
              const range = document.createRange();
              range.selectNodeContents(currentLineNumber);
              return range.getBoundingClientRect().left;
            })()
          : null,
        currentSignLeft: currentSign?.getBoundingClientRect().left ?? null,
        currentSignRight: currentSign?.getBoundingClientRect().right ?? null,
        currentIsActive: currentLine?.classList.contains('cm-activeLine') ?? false,
        standardGutterWidth: standardGutter?.getBoundingClientRect().width ?? null,
        standardGutterMarkerVisibility: standardGutterMarker
          ? getComputedStyle(standardGutterMarker).visibility
          : null,
        signGutterWidth: signGutter?.getBoundingClientRect().width ?? null,
        overviewMarkerColor: overviewMarker ? getComputedStyle(overviewMarker).backgroundColor : null,
      };
    });
    if (
      detailedModifiedGeometry.oldContentLeft === null ||
      detailedModifiedGeometry.currentContentLeft === null ||
      Math.abs(detailedModifiedGeometry.oldContentLeft - detailedModifiedGeometry.currentContentLeft) > 1 ||
      detailedModifiedGeometry.oldSignCenter === null ||
      detailedModifiedGeometry.currentSignCenter === null ||
      Math.abs(detailedModifiedGeometry.oldSignCenter - detailedModifiedGeometry.currentSignCenter) > 1 ||
      !detailedModifiedGeometry.currentUsesPlusIcon ||
      !detailedModifiedGeometry.originalUsesMinusIcon ||
      !detailedModifiedGeometry.currentIsActive ||
      detailedModifiedGeometry.currentBackground !== detailedModifiedGeometry.expectedCurrentBackground ||
      detailedModifiedGeometry.originalBackground !== detailedModifiedGeometry.expectedOriginalBackground ||
      detailedModifiedGeometry.currentSignCellBackground !== detailedModifiedGeometry.expectedCurrentBackground ||
      detailedModifiedGeometry.originalSignCellBackground !== detailedModifiedGeometry.expectedOriginalBackground ||
      detailedModifiedGeometry.currentStandardGutterBackground !== detailedModifiedGeometry.expectedCurrentBackground ||
      detailedModifiedGeometry.originalStandardGutterBackground !== detailedModifiedGeometry.expectedOriginalBackground ||
      detailedModifiedGeometry.currentGapFill === 'none' ||
      detailedModifiedGeometry.originalGapFill === 'none' ||
      Math.abs(detailedModifiedGeometry.currentContentLeft - compactLayoutBaseline.contentLeft) > 1 ||
      detailedModifiedGeometry.standardGutterWidth !== compactLayoutBaseline.standardGutterWidth ||
      detailedModifiedGeometry.standardGutterWidth !== 3 ||
      detailedModifiedGeometry.standardGutterMarkerVisibility !== 'hidden' ||
      detailedModifiedGeometry.signGutterWidth === null ||
      detailedModifiedGeometry.signGutterWidth !== 0 ||
      detailedModifiedGeometry.currentLineNumberLeft === null ||
      detailedModifiedGeometry.currentLineNumberRight === null ||
      detailedModifiedGeometry.currentLineNumberTextLeft === null ||
      detailedModifiedGeometry.currentSignLeft === null ||
      detailedModifiedGeometry.currentSignRight === null ||
      detailedModifiedGeometry.currentSignLeft <= detailedModifiedGeometry.currentLineNumberLeft ||
      detailedModifiedGeometry.currentSignRight >= detailedModifiedGeometry.currentLineNumberTextLeft ||
      !detailedModifiedGeometry.currentLineNumberBackgroundImage?.includes('linear-gradient') ||
      !detailedModifiedGeometry.originalLineNumberBackgroundImage?.includes('linear-gradient') ||
      detailedModifiedGeometry.overviewMarkerColor !== 'rgb(49, 122, 231)'
    ) {
      throw new Error(`Detailed modified rows were not aligned or signed: ${JSON.stringify(detailedModifiedGeometry)}`);
    }
    await assertDetailBackgroundContinuity(page, 'markers-on modified');
    await page.evaluate(() => {
      (window as any).__editor.setGitGutterVisible(false);
    });
    await waitForFrames(page, 3);
    await assertDetailBackgroundContinuity(page, 'markers-off modified');
    await page.evaluate(() => {
      (window as any).__editor.setGitGutterVisible(true);
    });
    await waitForFrames(page, 3);

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const current = `  <a href="${'current-path/'.repeat(18)}">current link</a>`;
      const original = `  <a href="${'original-path/'.repeat(18)}">original link</a>`;
      editor.setText(`first\n${current}\nlast`);
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: `first\n${original}\nlast`
      });
    });
    await waitForFrames(page, 4);
    const wrappedDetailGeometry = await page.evaluate(() => {
      const textLeft = (root: HTMLElement): number | null => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const lefts: number[] = [];
        while (walker.nextNode()) {
          const text = walker.currentNode;
          if (!text.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(text);
          lefts.push(...Array.from(range.getClientRects(), (rect) => rect.left));
        }
        return lefts.length > 0 ? Math.min(...lefts) : null;
      };
      const currentLine = document.querySelector<HTMLElement>('.meo-git-diff-current-line')!;
      const originalLine = document.querySelector<HTMLElement>('.meo-git-diff-original-line')!;
      const originalContent = originalLine.querySelector<HTMLElement>('.meo-git-diff-original-content')!;
      const currentSign = document.querySelector<HTMLElement>('.meo-git-diff-sign.is-current')!;
      const originalSign = document.querySelector<HTMLElement>('.meo-git-diff-sign.is-original')!;
      const currentLineNumber = document.querySelector<HTMLElement>(
        '.cm-lineNumbers .meo-git-diff-current-gutter-row'
      )!;
      const originalLineNumber = document.querySelector<HTMLElement>(
        '.cm-lineNumbers .meo-git-diff-original-gutter-row'
      )!;
      const unchangedLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === 'first')!;
      const currentSignRect = currentSign.getBoundingClientRect();
      const originalSignRect = originalSign.getBoundingClientRect();
      const currentLineNumberRect = currentLineNumber.getBoundingClientRect();
      const originalLineNumberRect = originalLineNumber.getBoundingClientRect();
      const textBounds = (element: HTMLElement): DOMRect => {
        const range = document.createRange();
        range.selectNodeContents(element.firstElementChild ?? element);
        return range.getBoundingClientRect();
      };
      return {
        currentTextLeft: textLeft(currentLine),
        originalTextLeft: textLeft(originalContent),
        unchangedTextLeft: textLeft(unchangedLine),
        currentLineNumberLeft: currentLineNumberRect.left,
        currentLineNumberRight: currentLineNumberRect.right,
        currentLineNumberTextLeft: textBounds(currentLineNumber).left,
        originalLineNumberLeft: originalLineNumberRect.left,
        originalLineNumberRight: originalLineNumberRect.right,
        originalLineNumberTextLeft: textBounds(originalLineNumber).left,
        currentSignLeft: currentSignRect.left,
        currentSignRight: currentSignRect.right,
        originalSignLeft: originalSignRect.left,
        originalSignRight: originalSignRect.right,
        currentIconCount: currentSign.querySelectorAll('svg.lucide-plus').length,
        originalIconCount: originalSign.querySelectorAll('svg.lucide-minus').length
      };
    });
    if (
      wrappedDetailGeometry.currentTextLeft === null ||
      wrappedDetailGeometry.originalTextLeft === null ||
      wrappedDetailGeometry.unchangedTextLeft === null ||
      Math.abs(wrappedDetailGeometry.currentTextLeft - wrappedDetailGeometry.unchangedTextLeft) > 1 ||
      Math.abs(wrappedDetailGeometry.originalTextLeft - wrappedDetailGeometry.unchangedTextLeft) > 1 ||
      wrappedDetailGeometry.currentSignLeft <= wrappedDetailGeometry.currentLineNumberLeft ||
      wrappedDetailGeometry.originalSignLeft <= wrappedDetailGeometry.originalLineNumberLeft ||
      wrappedDetailGeometry.currentSignRight >= wrappedDetailGeometry.currentLineNumberTextLeft ||
      wrappedDetailGeometry.originalSignRight >= wrappedDetailGeometry.originalLineNumberTextLeft ||
      wrappedDetailGeometry.currentSignRight > wrappedDetailGeometry.currentTextLeft + 1 ||
      wrappedDetailGeometry.originalSignRight > wrappedDetailGeometry.originalTextLeft + 1 ||
      wrappedDetailGeometry.currentIconCount !== 1 ||
      wrappedDetailGeometry.originalIconCount !== 1
    ) {
      throw new Error(`Wrapped detail markers overlapped source text: ${JSON.stringify(wrappedDetailGeometry)}`);
    }
    await page.evaluate(() => {
      (window as any).__editor.setGitGutterVisible(false);
    });
    await waitForFrames(page, 3);
    await assertDetailBackgroundContinuity(page, 'markers-off wrapped modified');
    await page.evaluate(() => {
      (window as any).__editor.setGitGutterVisible(true);
    });
    await waitForFrames(page, 3);

    await page.evaluate(() => {
      const harness = (window as any).EditorStabilityHarness;
      const editor = (window as any).__editor;
      harness.setGitDiffDetailsVisible(editor, false);
      editor.setSourceLineNumbers('off');
      editor.setText('first\ncurrent without line numbers\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\noriginal without line numbers\nlast'
      });
    });
    await waitForFrames(page, 4);
    const noLineNumbersBaseline = await page.evaluate(() => ({
      contentLeft: document.querySelector<HTMLElement>('.meo-diff-changed-line')!.getBoundingClientRect().left,
      contentRight: document.querySelector<HTMLElement>('.meo-diff-changed-line')!.getBoundingClientRect().right,
      scrollerRight: document.querySelector<HTMLElement>('.cm-scroller')!.getBoundingClientRect().right,
      signGutterWidth: document.querySelector<HTMLElement>('.cm-gutter.meo-git-diff-sign-gutter')!
        .getBoundingClientRect().width
    }));
    await page.evaluate(() => {
      const harness = (window as any).EditorStabilityHarness;
      harness.setGitDiffDetailsVisible((window as any).__editor, true);
    });
    await waitForFrames(page, 4);
    const noLineNumbersDetails = await page.evaluate(() => {
      const current = document.querySelector<HTMLElement>('.meo-git-diff-current-line')!;
      const currentRow = current.getBoundingClientRect();
      const original = document.querySelector<HTMLElement>('.meo-git-diff-original-content')!;
      const originalRow = original.closest<HTMLElement>('.meo-git-diff-original-line')!;
      const signGutter = document.querySelector<HTMLElement>('.cm-gutter.meo-git-diff-sign-gutter')!;
      const gutterRight = signGutter.getBoundingClientRect().right;
      const shadowOffset = (element: HTMLElement): number => {
        const match = getComputedStyle(element).boxShadow.match(/(-?\d+(?:\.\d+)?)px 0px/);
        return Math.abs(Number(match?.[1] ?? 0));
      };
      const visibleSigns = Array.from(document.querySelectorAll<HTMLElement>('.meo-git-diff-sign'))
        .filter((sign) => getComputedStyle(sign).display !== 'none');
      const currentSign = document.querySelector<HTMLElement>('.meo-git-diff-sign.is-current');
      const originalSign = document.querySelector<HTMLElement>('.meo-git-diff-sign.is-original');
      return {
        hasLineNumberGutter: document.querySelector('.cm-lineNumbers') !== null,
        currentText: current.textContent,
        originalText: original.textContent,
        currentLeft: currentRow.left,
        currentRight: currentRow.right,
        originalLeft: original.getBoundingClientRect().left,
        originalRight: original.getBoundingClientRect().right,
        currentBackgroundGap: currentRow.left - gutterRight,
        originalBackgroundGap: originalRow.getBoundingClientRect().left - gutterRight,
        gutterRight,
        currentTop: currentRow.top,
        currentHeight: currentRow.height,
        currentGapFill: shadowOffset(current),
        originalGapFill: shadowOffset(originalRow),
        visibleSigns: visibleSigns.length,
        plusIcon: currentSign?.querySelector('svg.lucide-plus') !== null,
        minusIcon: originalSign?.querySelector('svg.lucide-minus') !== null,
        signGutterWidth: document.querySelector<HTMLElement>('.cm-gutter.meo-git-diff-sign-gutter')!
          .getBoundingClientRect().width
      };
    });
    const noLineNumbersScreenshot = await page.screenshot({ encoding: 'base64' });
    const noLineNumbersPixels = await page.evaluate(async ({ screenshot, gap, body }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${screenshot}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixel = ({ x, y }: { x: number; y: number }): number[] => (
        Array.from(context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data)
      );
      return {
        gap: Array.from(
          { length: Math.max(0, Math.ceil(gap.to) - Math.floor(gap.from)) },
          (_, index) => pixel({ x: Math.floor(gap.from) + index, y: gap.y })
        ),
        body: pixel(body)
      };
    }, {
      screenshot: noLineNumbersScreenshot,
      gap: {
        from: noLineNumbersDetails.gutterRight,
        to: noLineNumbersDetails.currentLeft,
        y: noLineNumbersDetails.currentTop + noLineNumbersDetails.currentHeight / 2
      },
      body: {
        x: noLineNumbersDetails.currentRight - 8,
        y: noLineNumbersDetails.currentTop + noLineNumbersDetails.currentHeight / 2
      }
    });
    if (
      noLineNumbersDetails.hasLineNumberGutter ||
      noLineNumbersDetails.currentText !== 'current without line numbers' ||
      noLineNumbersDetails.originalText !== 'original without line numbers' ||
      Math.abs(noLineNumbersDetails.currentLeft - noLineNumbersBaseline.contentLeft) > 1 ||
      Math.abs(noLineNumbersDetails.originalLeft - noLineNumbersBaseline.contentLeft) > 1 ||
      noLineNumbersDetails.currentRight > noLineNumbersBaseline.scrollerRight + 1 ||
      noLineNumbersDetails.originalRight > noLineNumbersBaseline.scrollerRight + 1 ||
      noLineNumbersDetails.currentGapFill < noLineNumbersDetails.currentBackgroundGap - 0.5 ||
      noLineNumbersDetails.originalGapFill < noLineNumbersDetails.originalBackgroundGap - 0.5 ||
      noLineNumbersPixels.gap.some((pixel) => (
        JSON.stringify(pixel) !== JSON.stringify(noLineNumbersPixels.body)
      )) ||
      noLineNumbersBaseline.signGutterWidth !== 18 ||
      noLineNumbersDetails.signGutterWidth !== 18 ||
      noLineNumbersDetails.visibleSigns !== 2 ||
      !noLineNumbersDetails.plusIcon ||
      !noLineNumbersDetails.minusIcon
    ) {
      throw new Error(`Detailed rows broke without line numbers: ${JSON.stringify({
        baseline: noLineNumbersBaseline,
        details: noLineNumbersDetails,
        pixels: noLineNumbersPixels
      })}`);
    }
    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const current = '这是一段较长的中文文本，用来测试换行、行高、宽度和滚动体验。'.repeat(7);
      const original = '这是一段较长的中文文本，用来验证无行号时旧内容的换行和背景连续性。'.repeat(7);
      editor.setText(`first\n${current}\nlast`);
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: `first\n${original}\nlast`
      });
    });
    await waitForFrames(page, 5);
    const wrappedNoLineGeometry = await page.evaluate(() => {
      const gutterRight = document.querySelector<HTMLElement>('.cm-gutter.meo-git-diff-sign-gutter')!
        .getBoundingClientRect().right;
      const geometry = (element: HTMLElement) => {
        const rect = element.getBoundingClientRect();
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        const rows = Math.max(1, Math.round(rect.height / lineHeight));
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          lineHeight,
          rows
        };
      };
      return {
        gutterRight,
        current: geometry(document.querySelector<HTMLElement>('.meo-git-diff-current-line')!),
        original: geometry(document.querySelector<HTMLElement>('.meo-git-diff-original-line')!)
      };
    });
    const wrappedNoLineScreenshot = await page.screenshot({ encoding: 'base64' });
    const wrappedNoLinePixels = await page.evaluate(async ({ screenshot, layout }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${screenshot}`;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const pixel = (x: number, y: number): number[] => (
        Array.from(context.getImageData(Math.floor(x), Math.floor(y), 1, 1).data)
      );
      const samples = (row: typeof layout.current) => {
        const expected = pixel(row.right - 8, row.bottom - 2);
        const gaps = Array.from({ length: row.rows }, (_, index) => pixel(
          (layout.gutterRight + row.left) / 2,
          Math.min(row.bottom - 2, row.top + row.lineHeight * (index + 0.5))
        ));
        return { expected, gaps };
      };
      return {
        current: samples(layout.current),
        original: samples(layout.original)
      };
    }, { screenshot: wrappedNoLineScreenshot, layout: wrappedNoLineGeometry });
    if (
      wrappedNoLinePixels.current.gaps.some((pixel) => (
        JSON.stringify(pixel) !== JSON.stringify(wrappedNoLinePixels.current.expected)
      )) ||
      wrappedNoLinePixels.original.gaps.some((pixel) => (
        JSON.stringify(pixel) !== JSON.stringify(wrappedNoLinePixels.original.expected)
      ))
    ) {
      throw new Error(`Wrapped no-line-number backgrounds were discontinuous: ${JSON.stringify(wrappedNoLinePixels)}`);
    }
    await page.evaluate(() => {
      (window as any).__editor.setGitGutterVisible(false);
    });
    await waitForFrames(page, 3);
    await assertDetailBackgroundContinuity(page, 'markers-off wrapped modified without line numbers');
    await page.evaluate(() => {
      (window as any).__editor.setGitGutterVisible(true);
    });
    await waitForFrames(page, 3);
    await page.evaluate(() => {
      (window as any).__editor.setSourceLineNumbers('on');
    });
    await waitForFrames(page, 4);

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const prefix = Array.from({ length: 1574 }, (_, index) => `unchanged ${index + 1}`);
      editor.setText([...prefix, 'current four digit line', 'last'].join('\n'));
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: [...prefix, 'original four digit line', 'last'].join('\n')
      });
      const offset = prefix.join('\n').length + 1;
      editor.revealSelection(offset, offset, { focus: false });
    });
    await waitForFrames(page, 6);
    const fourDigitGeometry = await page.evaluate(() => {
      const sign = document.querySelector<HTMLElement>('.meo-git-diff-sign.is-current')!;
      const lineNumberCell = document.querySelector<HTMLElement>(
        '.cm-lineNumbers .meo-git-diff-current-gutter-row'
      )!;
      const range = document.createRange();
      range.selectNodeContents(lineNumberCell);
      return {
        signRight: sign.getBoundingClientRect().right,
        lineNumberLeft: range.getBoundingClientRect().left
      };
    });
    if (fourDigitGeometry.lineNumberLeft - fourDigitGeometry.signRight < 4) {
      throw new Error(`Four-digit line number overlapped the diff icon: ${JSON.stringify(fourDigitGeometry)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setText('first\nadded one\nadded two\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nlast'
      });
    });
    await waitForFrames(page, 4);
    const detailedAddition = await page.evaluate(() => {
      const changedLines = Array.from(document.querySelectorAll<HTMLElement>('.meo-git-diff-current-line'));
      const unchangedLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === 'first');
      return {
        plusIcons: document.querySelectorAll('.meo-git-diff-sign.is-current svg.lucide-plus').length,
        minusIcons: document.querySelectorAll('.meo-git-diff-sign.is-original svg.lucide-minus').length,
        originalRows: document.querySelectorAll('.meo-git-diff-original-line').length,
        changedLines: changedLines.map((line) => line.textContent),
        changedLefts: changedLines.map((line) => line.getBoundingClientRect().left),
        unchangedLeft: unchangedLine?.getBoundingClientRect().left ?? null,
        overviewColor: getComputedStyle(
          document.querySelector<HTMLElement>('.meo-git-overview-ruler-marker.is-added')!
        ).backgroundColor
      };
    });
    if (
      detailedAddition.plusIcons !== 2 ||
      detailedAddition.minusIcons !== 0 ||
      detailedAddition.originalRows !== 0 ||
      JSON.stringify(detailedAddition.changedLines) !== JSON.stringify(['added one', 'added two']) ||
      detailedAddition.unchangedLeft === null ||
      detailedAddition.changedLefts.some((left) => Math.abs(left - detailedAddition.unchangedLeft!) > 1) ||
      detailedAddition.overviewColor !== 'rgb(74, 158, 130)'
    ) {
      throw new Error(`Detailed addition rendering regressed: ${JSON.stringify(detailedAddition)}`);
    }
    await assertDetailBackgroundContinuity(page, 'markers-on addition');
    await page.evaluate(() => {
      (window as any).__editor.setGitGutterVisible(false);
    });
    await waitForFrames(page, 3);
    await assertDetailBackgroundContinuity(page, 'markers-off addition');
    await page.evaluate(() => {
      (window as any).__editor.setGitGutterVisible(true);
    });
    await waitForFrames(page, 3);

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setText('first\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nremoved one\nremoved two\nlast'
      });
    });
    await waitForFrames(page, 4);
    const detailedDeletion = await page.evaluate(() => {
      const unchangedLine = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.textContent === 'first');
      const oldContents = Array.from(document.querySelectorAll<HTMLElement>('.meo-git-diff-original-content'));
      return {
        minusIcons: document.querySelectorAll('.meo-git-diff-sign.is-original svg.lucide-minus').length,
        plusIcons: document.querySelectorAll('.meo-git-diff-sign.is-current svg.lucide-plus').length,
        contents: oldContents.map((content) => content.textContent),
        contentLefts: oldContents.map((content) => content.getBoundingClientRect().left),
        unchangedLeft: unchangedLine?.getBoundingClientRect().left ?? null,
        overviewColor: getComputedStyle(
          document.querySelector<HTMLElement>('.meo-git-overview-ruler-marker.is-deleted')!
        ).backgroundColor
      };
    });
    if (
      detailedDeletion.minusIcons !== 2 ||
      detailedDeletion.plusIcons !== 0 ||
      JSON.stringify(detailedDeletion.contents) !== JSON.stringify(['removed one', 'removed two']) ||
      detailedDeletion.unchangedLeft === null ||
      detailedDeletion.contentLefts.some((left) => Math.abs(left - detailedDeletion.unchangedLeft!) > 1) ||
      detailedDeletion.overviewColor !== 'rgb(224, 82, 82)'
    ) {
      throw new Error(`Detailed deletion rendering regressed: ${JSON.stringify(detailedDeletion)}`);
    }
    await assertDetailBackgroundContinuity(page, 'markers-on deletion');
    await page.evaluate(() => {
      (window as any).__editor.setGitGutterVisible(false);
    });
    await waitForFrames(page, 3);
    await assertDetailBackgroundContinuity(page, 'markers-off deletion');
    await page.evaluate(() => {
      (window as any).__editor.setGitGutterVisible(true);
    });
    await waitForFrames(page, 3);
    await page.evaluate(() => {
      const harness = (window as any).EditorStabilityHarness;
      const editor = (window as any).__editor;
      harness.setGitDiffDetailsVisible(editor, false);
      harness.setGitDiffLineHighlightsEnabled(editor, false);
      editor.setText('first\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nremoved one\nremoved two\nlast'
      });
    });
    await waitForFrames(page, 4);

    const narrowViewportGutterGeometry = await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('#app')!.getBoundingClientRect();
      const guttersElement = document.querySelector<HTMLElement>('.cm-gutters')!;
      const lineNumber = guttersElement.querySelector<HTMLElement>(
        '.cm-lineNumbers > .cm-gutterElement'
      )!;
      const gutters = guttersElement.getBoundingClientRect();
      return {
        offset: gutters.left - host.left,
        transform: getComputedStyle(guttersElement).transform,
        lineNumberPaddingRight: getComputedStyle(lineNumber).paddingRight
      };
    });
    if (
      Math.abs(narrowViewportGutterGeometry.offset) > 0.1 ||
      narrowViewportGutterGeometry.transform !== 'none' ||
      narrowViewportGutterGeometry.lineNumberPaddingRight !== '10px'
    ) {
      throw new Error(`Narrow-view gutter reintroduced a composited offset: ${JSON.stringify(narrowViewportGutterGeometry)}`);
    }

    const marker = await page.$('.meo-git-gutter-marker.is-deleted');
    if (!marker) throw new Error('Deleted gap marker was not rendered');
    const markerState = await marker.evaluate((element) => ({
      from: (element as HTMLElement).dataset.meoBaselineFromLine,
      to: (element as HTMLElement).dataset.meoBaselineToLine,
      visibility: getComputedStyle(element).visibility
    }));
    if (markerState.from !== '2' || markerState.to !== '3' || markerState.visibility !== 'visible') {
      throw new Error(`Deleted gap range was incorrect: ${JSON.stringify(markerState)}`);
    }

    const rect = await marker.boundingBox();
    if (!rect) throw new Error('Deleted gap marker had no layout box');
    const deletionGeometry = await marker.evaluate((element) => {
      const markerRect = element.getBoundingClientRect();
      const triangleStyle = getComputedStyle(element, '::after');
      const triangleLeft = markerRect.left + (Number.parseFloat(triangleStyle.left) || 0);
      const triangleRight = triangleLeft + (Number.parseFloat(triangleStyle.borderLeftWidth) || 0);
      const lineNumber = Array.from(
        document.querySelectorAll<HTMLElement>('.cm-lineNumbers .cm-gutterElement')
      ).find((candidate) => candidate.textContent?.trim());
      const lineNumberRange = document.createRange();
      if (lineNumber) lineNumberRange.selectNodeContents(lineNumber);
      return {
        triangleLeft,
        triangleRight,
        triangleY: markerRect.top,
        lineNumberTextRight: lineNumber ? lineNumberRange.getBoundingClientRect().right : null,
        contentLeft: document.querySelector<HTMLElement>('.cm-content')?.getBoundingClientRect().left ?? null
      };
    });
    if (
      deletionGeometry.lineNumberTextRight === null ||
      deletionGeometry.contentLeft === null ||
      deletionGeometry.triangleLeft - deletionGeometry.lineNumberTextRight < 4 ||
      deletionGeometry.contentLeft - deletionGeometry.triangleRight < 4
    ) {
      throw new Error(`Source deletion marker was not centered between line numbers and content: ${JSON.stringify(deletionGeometry)}`);
    }
    await page.mouse.move(
      (deletionGeometry.triangleLeft + deletionGeometry.triangleRight) / 2,
      deletionGeometry.triangleY
    );
    await waitForFrames(page, 2);
    const tooltip = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.meo-deletion-tooltip');
      return {
        hidden: root?.hidden,
        text: root?.textContent ?? ''
      };
    });
    if (tooltip.hidden || !tooltip.text.includes('removed one') || !tooltip.text.includes('removed two')) {
      throw new Error(`Deleted content tooltip was incorrect: ${JSON.stringify(tooltip)}`);
    }

    await page.evaluate(() => {
      (window as any).__editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nlast'
      });
    });
    await waitForFrames(page);
    if (await page.$('.meo-git-gutter-marker.is-deleted')) {
      throw new Error('Deleted marker remained after the baseline matched the document');
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setMode('source');
      editor.setText('first\ncurrent value\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\noriginal value\nlast'
      });
    });
    await waitForFrames(page, 4);
    const modifiedMarker = await page.$('.meo-git-gutter-marker.is-modified');
    const modifiedRect = await modifiedMarker?.boundingBox();
    if (!modifiedRect) throw new Error('Modified marker had no layout box');
    await page.mouse.move(modifiedRect.x + modifiedRect.width / 2, modifiedRect.y + modifiedRect.height / 2);
    await waitForFrames(page, 2);
    const modifiedTooltip = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.meo-modified-tooltip');
      return { hidden: root?.hidden, text: root?.textContent ?? '' };
    });
    if (modifiedTooltip.hidden || !modifiedTooltip.text.includes('original value')) {
      throw new Error(`Modified content tooltip was incorrect: ${JSON.stringify(modifiedTooltip)}`);
    }
    await page.mouse.move(modifiedRect.x - 2, modifiedRect.y + modifiedRect.height / 2);
    await waitForFrames(page, 2);
    const modifiedHoverState = await modifiedMarker!.evaluate((element) => ({
      stripeWidth: element.querySelector<HTMLElement>('.meo-git-gutter-stripe')?.getBoundingClientRect().width ?? 0,
      tooltipVisible: !document.querySelector<HTMLElement>('.meo-modified-tooltip')?.hidden
    }));
    if (modifiedHoverState.stripeWidth <= modifiedRect.width || !modifiedHoverState.tooltipVisible) {
      throw new Error(`Modified marker did not retain its existing expanded hover behavior: ${JSON.stringify(modifiedHoverState)}`);
    }

    await page.evaluate(() => {
      (window as any).__editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nsaved value\nlast'
      });
    });
    await waitForFrames(page, 2);
    const staleModifiedTooltipVisible = await page.$eval(
      '.meo-modified-tooltip',
      (element) => !(element as HTMLElement).hidden
    );
    if (staleModifiedTooltipVisible) {
      throw new Error('Modified tooltip remained visible after the diff baseline changed');
    }
    await page.mouse.move(modifiedRect.x + modifiedRect.width / 2, modifiedRect.y + modifiedRect.height / 2);
    await waitForFrames(page, 2);
    const refreshedModifiedTooltipText = await page.$eval(
      '.meo-modified-tooltip',
      (element) => element.textContent ?? ''
    );
    if (!refreshedModifiedTooltipText.includes('saved value') || refreshedModifiedTooltipText.includes('original value')) {
      throw new Error(`Modified tooltip did not refresh after the baseline changed: ${refreshedModifiedTooltipText}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setMode('source');
      editor.setText('before\nLONG\n\n\nHEADING\n\nafter');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'before\n\n\nLONG\n\nHEADING\n\nafter'
      });
    });
    await waitForFrames(page, 4);
    const blankLineMoveMarkers = await page.evaluate(() => ({
      added: document.querySelectorAll('.meo-git-gutter-marker.is-added').length,
      modified: document.querySelectorAll('.meo-git-gutter-marker.is-modified').length,
      deleted: Array.from(document.querySelectorAll<HTMLElement>('.meo-git-gutter-marker.is-deleted')).map((marker) => ({
        from: marker.dataset.meoBaselineFromLine,
        to: marker.dataset.meoBaselineToLine
      }))
    }));
    if (
      blankLineMoveMarkers.added !== 1 ||
      blankLineMoveMarkers.modified !== 0 ||
      blankLineMoveMarkers.deleted.length !== 1 ||
      blankLineMoveMarkers.deleted[0]?.from !== '2' ||
      blankLineMoveMarkers.deleted[0]?.to !== '3'
    ) {
      throw new Error(`Blank-line edits displaced an unchanged text anchor: ${JSON.stringify(blankLineMoveMarkers)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const baselineLines = Array.from({ length: 1201 }, (_, index) => `stable ${index}`);
      const currentLines = [...baselineLines];
      currentLines[600] = 'changed 600';
      editor.setText(currentLines.join('\n'));
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: baselineLines.join('\n')
      });
      editor.scrollToLine(601, 'center');
    });
    await waitForFrames(page, 4);
    const longDocumentMarkers = await page.evaluate(() => ({
      added: document.querySelectorAll('.meo-git-gutter-marker.is-added').length,
      modified: document.querySelectorAll('.meo-git-gutter-marker.is-modified').length,
      deleted: document.querySelectorAll('.meo-git-gutter-marker.is-deleted').length
    }));
    if (JSON.stringify(longDocumentMarkers) !== JSON.stringify({ added: 0, modified: 1, deleted: 0 })) {
      throw new Error(`Long-document changes disappeared from the gutter: ${JSON.stringify(longDocumentMarkers)}`);
    }
    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setMode('live');
      editor.scrollToLine(601, 'center');
    });
    await waitForFrames(page, 8);
    const longLiveDocumentMarkers = await page.evaluate(() => ({
      added: document.querySelectorAll('.meo-git-gutter-marker.is-added').length,
      modified: document.querySelectorAll('.meo-git-gutter-marker.is-modified').length,
      deleted: document.querySelectorAll('.meo-git-gutter-marker.is-deleted').length
    }));
    if (JSON.stringify(longLiveDocumentMarkers) !== JSON.stringify({ added: 0, modified: 1, deleted: 0 })) {
      throw new Error(`Long-document changes disappeared from the Live gutter: ${JSON.stringify(longLiveDocumentMarkers)}`);
    }

    // A baseline refresh is also an external decoration mutation. It must not
    // move the reading position while the live parser and block widgets settle.
    const beforeBaselineRefresh = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const position = editor.getTopVisiblePosition();
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        topLine: position.line,
        topLineOffset: position.lineOffset
      };
    });
    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const baselineLines = Array.from({ length: 1201 }, (_, index) => `baseline ${index + 1}`);
      baselineLines[600] = 'changed 600';
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: baselineLines.join('\n')
      });
    });
    await waitForFrames(page, 10);
    const afterBaselineRefresh = await page.evaluate(() => {
      const editor = (window as any).__editor;
      const position = editor.getTopVisiblePosition();
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        topLine: position.line,
        topLineOffset: position.lineOffset
      };
    });
    if (
      beforeBaselineRefresh.topLine !== afterBaselineRefresh.topLine ||
      Math.abs(beforeBaselineRefresh.topLineOffset - afterBaselineRefresh.topLineOffset) > 1 ||
      Math.abs(beforeBaselineRefresh.scrollTop - afterBaselineRefresh.scrollTop) > 1
    ) {
      throw new Error(`Refreshing the Git baseline moved the live document viewport: ${JSON.stringify({
        before: beforeBaselineRefresh,
        after: afterBaselineRefresh
      })}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const text = '| Name |\n| --- |\n| kept one |\n| kept two |\n\nafter';
      editor.setText(text);
      editor.revealSelection(text.length, text.length, { focus: false });
      editor.setMode('live');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: '| Name |\n| --- |\n| removed one |\n| kept one |\n| removed two |\n| kept two |\n\nafter'
      });
    });
    await waitForFrames(page, 8);
    const liveMarkers = await page.$$('.meo-git-gutter-marker.is-deleted');
    if (liveMarkers.length !== 2) {
      throw new Error(`Live table deletion rendered ${liveMarkers.length} row markers instead of two`);
    }
    const liveTooltipTexts: string[] = [];
    for (const liveMarker of liveMarkers) {
      const liveRect = await liveMarker.boundingBox();
      if (!liveRect) throw new Error('Live deleted row marker had no layout box');
      await page.mouse.move(liveRect.x + 1, liveRect.y + 1);
      await waitForFrames(page, 2);
      liveTooltipTexts.push(await page.$eval('.meo-deletion-tooltip', (element) => element.textContent ?? ''));
    }
    const liveTooltipText = liveTooltipTexts.join('\n');
    if (!liveTooltipText.includes('removed one') || !liveTooltipText.includes('removed two')) {
      throw new Error(`Live deleted row tooltips omitted a deletion gap: ${liveTooltipText}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const text = '```mermaid\nflowchart LR\nA --> B\nC --> D\n```\n\nafter';
      editor.setText(text);
      editor.revealSelection(text.length, text.length, { focus: false });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: '```mermaid\nflowchart LR\nA --> B\nB --> C\nC --> D\n```\n\nafter'
      });
    });
    await waitForFrames(page, 8);
    const mermaidDeletionMarkers = await page.$$('.meo-git-gutter-marker.is-deleted');
    if (mermaidDeletionMarkers.length !== 1) {
      throw new Error(`Live Mermaid deletion rendered ${mermaidDeletionMarkers.length} markers instead of one`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const text = '```mermaid\nflowchart LR\nA --> C\nC --> E\n```\n\nafter';
      editor.setText(text);
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: '```mermaid\nflowchart LR\nA --> B\nC --> D\n```\n\nafter'
      });
    });
    await waitForFrames(page, 8);
    const liveModifiedMarker = await page.$('.meo-git-gutter-marker.is-modified');
    const liveModifiedRect = await liveModifiedMarker?.boundingBox();
    if (!liveModifiedRect) throw new Error('Live Mermaid modified marker had no layout box');
    await page.mouse.move(
      liveModifiedRect.x + liveModifiedRect.width / 2,
      liveModifiedRect.y + liveModifiedRect.height / 2
    );
    await waitForFrames(page, 2);
    const liveModifiedTooltip = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.meo-modified-tooltip');
      return { hidden: root?.hidden, text: root?.textContent ?? '' };
    });
    if (
      liveModifiedTooltip.hidden ||
      !liveModifiedTooltip.text.includes('A --> B\nC --> D') ||
      liveModifiedTooltip.text.includes('A --> B\n…\nC --> D')
    ) {
      throw new Error(`Live modified tooltip omitted original source: ${JSON.stringify(liveModifiedTooltip)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      const text = '$$\na\nc\n$$\n\nafter';
      editor.setText(text);
      editor.revealSelection(text.length, text.length, { focus: false });
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: '$$\na\nb\nc\n$$\n\nafter'
      });
    });
    await waitForFrames(page, 8);
    const mathDeletionMarkers = await page.$$('.meo-git-gutter-marker.is-deleted');
    if (mathDeletionMarkers.length !== 1) {
      throw new Error(`Live display-math deletion rendered ${mathDeletionMarkers.length} markers instead of one`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setMode('source');
      editor.setText('first\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nremoved one\nremoved two\nlast'
      });
    });
    await waitForFrames(page, 4);
    const sourceMarker = await page.$('.meo-git-gutter-marker.is-deleted');
    const sourceRect = await sourceMarker?.boundingBox();
    if (!sourceRect) throw new Error('Source deleted marker had no layout box for hit-area check');
    const sourceTriangle = await sourceMarker!.evaluate((element) => {
      const markerRect = element.getBoundingClientRect();
      const style = getComputedStyle(element, '::after');
      const left = Number.parseFloat(style.left) || 0;
      const width = Number.parseFloat(style.borderLeftWidth) || 0;
      return {
        left: markerRect.left + left,
        right: markerRect.left + left + width,
        width,
        y: markerRect.top
      };
    });
    await page.mouse.move(sourceRect.x + 80, sourceRect.y + 1);
    await page.mouse.move(sourceTriangle.right + 1, sourceTriangle.y);
    await waitForFrames(page, 2);
    const rightOutsideTooltipVisible = await page.$eval('.meo-deletion-tooltip', (element) => !(element as HTMLElement).hidden);
    if (rightOutsideTooltipVisible) {
      throw new Error('Deleted content tooltip extended past the visible triangle on the right');
    }
    await page.mouse.move(sourceRect.x - 6, sourceRect.y + 1);
    await waitForFrames(page, 2);
    const expandedHitTooltipVisible = await page.$eval('.meo-deletion-tooltip', (element) => !(element as HTMLElement).hidden);
    if (!expandedHitTooltipVisible) {
      throw new Error('Deleted content tooltip hit area did not extend beyond the visible triangle');
    }
    const expandedTriangle = await sourceMarker!.evaluate((element) => {
      const markerRect = element.getBoundingClientRect();
      const style = getComputedStyle(element, '::after');
      const left = markerRect.left + (Number.parseFloat(style.left) || 0);
      const width = Number.parseFloat(style.borderLeftWidth) || 0;
      return { left, right: left + width, width };
    });
    if (expandedTriangle.width <= sourceTriangle.width) {
      throw new Error(`Deleted triangle did not expand on hover: ${sourceTriangle.width} -> ${expandedTriangle.width}`);
    }
    if (expandedTriangle.left >= sourceTriangle.left || Math.abs(expandedTriangle.right - sourceTriangle.right) > 0.1) {
      throw new Error(`Deleted triangle did not expand leftward with a fixed tip: ${JSON.stringify({
        before: sourceTriangle,
        after: expandedTriangle
      })}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__editor;
      editor.setText('first\nmiddle\nlast');
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: 'first\nremoved upper\nmiddle\nremoved lower\nlast'
      });
      const editorRoot = document.querySelector<HTMLElement>('.cm-editor');
      if (editorRoot) {
        editorRoot.style.transform = 'scaleY(0.5)';
        editorRoot.style.transformOrigin = 'top left';
      }
    });
    await waitForFrames(page, 4);
    const adjacentMarkers = await page.evaluate(() => Array.from(
      document.querySelectorAll<HTMLElement>('.meo-git-gutter-marker.is-deleted')
    ).map((marker) => {
      const rect = marker.getBoundingClientRect();
      const style = getComputedStyle(marker, '::after');
      const triangleLeft = rect.left + (Number.parseFloat(style.left) || 0);
      const triangleWidth = Number.parseFloat(style.borderLeftWidth) || 0;
      return { triangleLeft, triangleWidth, top: rect.top };
    }).sort((left, right) => left.top - right.top));
    if (adjacentMarkers.length !== 2) {
      throw new Error(`Adjacent deletions rendered ${adjacentMarkers.length} markers instead of two`);
    }
    const lowerMarker = adjacentMarkers[1];
    await page.mouse.move(
      lowerMarker.triangleLeft + lowerMarker.triangleWidth / 2,
      lowerMarker.top - 4
    );
    await waitForFrames(page, 2);
    const adjacentTooltipText = await page.$eval('.meo-deletion-tooltip', (element) => element.textContent ?? '');
    if (!adjacentTooltipText.includes('removed lower') || adjacentTooltipText.includes('removed upper')) {
      throw new Error(`Overlapping deletion hit areas selected the wrong marker: ${adjacentTooltipText}`);
    }

    console.log('document diff gutter checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
