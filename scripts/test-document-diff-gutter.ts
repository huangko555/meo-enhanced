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
    const content = document.querySelector<HTMLElement>('.cm-line');
    if (!stripe || !content) return null;

    const lineNumberRange = document.createRange();
    if (lineNumber) lineNumberRange.selectNodeContents(lineNumber);
    const stripeRect = stripe.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const marker = stripe.parentElement!;
    return {
      lineNumberTextRight: lineNumber ? lineNumberRange.getBoundingClientRect().right : null,
      stripeLeft: stripeRect.left,
      stripeRight: stripeRect.right,
      contentLeft: contentRect.left,
      markerPointerEvents: getComputedStyle(marker).pointerEvents
    };
  });
  if (
    !geometry ||
    geometry.stripeLeft < 0 ||
    geometry.markerPointerEvents !== 'none' ||
    (geometry.lineNumberTextRight !== null && geometry.stripeLeft - geometry.lineNumberTextRight < 4) ||
    Math.abs(geometry.contentLeft - geometry.stripeRight - 5) > 1
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
        { length: Math.max(0, Math.floor(row.left) - Math.ceil(row.connectionStart)) },
        (_, offset) => {
          // Sample full pixels, excluding antialiasing at fractional edges.
          const x = Math.ceil(row.connectionStart) + offset;
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

async function assertDetailRowAlignment(page: Page, label: string): Promise<void> {
  const mismatches = await page.evaluate(() => (['original', 'current'] as const).flatMap((kind) => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>(`.meo-git-diff-${kind}-line`));
    const selectors = [`.meo-git-diff-sign-gutter-cell.is-${kind}`];
    if (document.querySelector('.cm-lineNumbers')) selectors.push(`.cm-lineNumbers .meo-git-diff-${kind}-gutter-row`);
    return selectors.flatMap((selector) => {
      const gutters = Array.from(document.querySelectorAll<HTMLElement>(selector));
      return rows.flatMap((row, index) => {
        const content = row.getBoundingClientRect();
        const gutter = gutters[index]?.getBoundingClientRect();
        return !gutter || Math.abs(content.top - gutter.top) > 1 || Math.abs(content.height - gutter.height) > 1
          ? [{ kind, selector, index, content: { top: content.top, height: content.height }, gutter: gutter && { top: gutter.top, height: gutter.height } }]
          : [];
      });
    });
  }));
  if (mismatches.length) throw new Error(`${label} detail gutters were misaligned: ${JSON.stringify(mismatches)}`);
}

async function assertConstrainedContentMatchesWindow(page: Page): Promise<void> {
  for (const mode of ['live', 'source'] as const) {
    for (const numbers of ['on', 'off'] as const) {
      for (const details of mode === 'source' ? [false, true] : [false]) {
        await page.evaluate(({ mode, numbers, details }) => {
          const editor = (window as any).__editor;
          editor.setMode(mode);
          editor.setSourceLineNumbers(numbers);
          editor.setSearchQuery('current');
          (window as any).EditorStabilityHarness.setGitDiffDetailsVisible(editor, details);
        }, { mode, numbers, details });
        const layouts: Array<Record<string, number[]>> = [];
        for (const constrained of [false, true]) {
          await page.setViewport({ width: constrained ? 1400 : 800, height: 500, deviceScaleFactor: 1 });
          await page.evaluate((enabled) => {
            document.documentElement.classList.toggle('meo-content-max-width-enabled', enabled);
            if (enabled) document.documentElement.style.setProperty('--meo-content-max-width', '800px');
            else document.documentElement.style.removeProperty('--meo-content-max-width');
            (window as any).__editor.refreshLayout();
          }, constrained);
          await waitForFrames(page, 8);
          if (!details) await assertCompactMarkerPlacement(page, mode);
          layouts.push(await page.evaluate(() => {
            const root = document.querySelector('.cm-editor')!.getBoundingClientRect();
            const gutter = document.querySelector('.cm-gutters')!.getBoundingClientRect();
            const scroller = document.querySelector('.cm-scroller')!.getBoundingClientRect();
            if (Math.abs(scroller.right - window.innerWidth) > 1) {
              throw new Error(`Scrollbar moved away from the window edge: ${scroller.right} vs ${window.innerWidth}`);
            }
            for (const [selector, inset] of [['.meo-git-overview-ruler', 10], ['.meo-search-overview-ruler', 3]] as const) {
              const ruler = document.querySelector(selector)!;
              if (!ruler.children.length || Math.abs(window.innerWidth - ruler.getBoundingClientRect().right - inset) > 1) {
                throw new Error(`${selector} did not keep its markers at the window edge`);
              }
            }
            const selectors = ['.cm-gutters', '.cm-content', '.cm-line',
              '.cm-lineNumbers .cm-gutterElement', '.meo-git-gutter-stripe',
              '.meo-git-diff-original-line', '.meo-git-diff-sign'];
            return Object.fromEntries(selectors.map((selector) => [selector,
              Array.from(document.querySelectorAll(selector)).flatMap((element) => {
                const rect = element.getBoundingClientRect();
                return [rect.left - gutter.left, rect.top - root.top, rect.width, rect.height];
              })]));
          }));
        }
        for (const selector of Object.keys(layouts[0])) {
          const normal = layouts[0][selector];
          const constrained = layouts[1][selector];
          if (normal.length !== constrained.length
            || normal.some((value, index) => Math.abs(value - constrained[index]) > 0.75)) {
            throw new Error(`${mode}, numbers ${numbers}, details ${details}: limited viewport differs from a real 800px window for ${selector}: ${JSON.stringify({ normal, constrained })}`);
          }
        }
      }
    }
  }
  await page.evaluate(() => {
    (window as any).__editor.setSourceLineNumbers('on');
    (window as any).__editor.setSearchQuery('');
    document.documentElement.classList.remove('meo-content-max-width-enabled');
    document.documentElement.style.removeProperty('--meo-content-max-width');
  });
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

    const inactiveDiffSettings = await page.evaluate(() => {
      const harness = (window as any).EditorStabilityHarness;
      const editor = harness.createEditor({ parent: document.getElementById('app')!,
        text: 'first\nchanged\nlast', initialMode: 'live', onApplyChanges() {} });
      try {
        editor.setGitBaseline({ available: true, tracked: true, mode: 'current-edit',
          baseText: 'first\noriginal\nlast' });
        const liveState = editor.view.state;
        harness.setGitDiffDetailsVisible(editor, true);
        harness.setGitDiffLineHighlightsEnabled(editor, true);
        const unchangedLiveState = editor.view.state === liveState;
        editor.setMode('source');
        const sourceDetails = editor.view.dom.classList.contains('meo-git-diff-details-visible');
        const sourceHighlights = !!editor.view.dom.querySelector('.meo-diff-changed-line');
        editor.setMode('live');
        const nextLiveState = editor.view.state;
        harness.setGitDiffDetailsVisible(editor, false);
        harness.setGitDiffLineHighlightsEnabled(editor, false);
        const unchangedNextLiveState = editor.view.state === nextLiveState;
        editor.setMode('source');
        return { unchangedLiveState, unchangedNextLiveState, sourceDetails, sourceHighlights,
          hiddenDetails: !editor.view.dom.classList.contains('meo-git-diff-details-visible'),
          hiddenHighlights: !editor.view.dom.querySelector('.meo-diff-changed-line'),
          unchangedText: editor.view.state.doc.toString() === 'first\nchanged\nlast' };
      } finally { editor.destroy(); document.getElementById('app')!.replaceChildren(); }
    });
    if (Object.values(inactiveDiffSettings).some(value => !value)) {
      throw Error(`Inactive diff settings must avoid Live transactions and apply on Source entry: ${JSON.stringify(inactiveDiffSettings)}`);
    }

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

    await assertConstrainedContentMatchesWindow(page);
    await page.setViewport({ width: 1400, height: 500, deviceScaleFactor: 1 });
    await waitForFrames(page, 12);
    const widthFixture = await page.evaluate(() => {
      const current = (window as any).__editor.getText() as string;
      const original = current.split('\n');
      original[1] = document.querySelector('.meo-git-diff-original-content')!.textContent!;
      const currentLines = current.split('\n');
      currentLines[1] += '\n\n\n  current continuation';
      const preceding = '<a href="./markdown-render-test.md#html-jump-target" title="打开当前文件并跳转">相对文件锚点</a>';
      currentLines.splice(1, 0, preceding);
      original.splice(1, 0, preceding);
      return { current: currentLines.join('\n'), original: original.join('\n') };
    });
    for (const scrollable of [false, true]) {
      await page.evaluate(({ fixture, overflow }) => {
        const editor = (window as any).__editor;
        const suffix = overflow ? '\nunchanged'.repeat(60) : '';
        document.documentElement.style.setProperty('--meo-user-editor-font-size', overflow ? '18px' : '14px');
        editor.setText(fixture.current + suffix);
        editor.setGitBaseline({ available: true, tracked: true, mode: 'current-edit', baseText: fixture.original + suffix });
        editor.refreshLayout();
      }, { fixture: widthFixture, overflow: scrollable });
      await waitForFrames(page, 8);
      for (const lineNumbers of ['on', 'off'] as const) {
        await page.evaluate((value) => (window as any).__editor.setSourceLineNumbers(value), lineNumbers);
        await waitForFrames(page, 4);
        await assertDetailRowAlignment(page, `scrollable ${scrollable}, number-only toggle ${lineNumbers}`);
        for (const enabled of [true, false, true]) {
          await page.evaluate((constrained) => {
            document.documentElement.classList.toggle('meo-content-max-width-enabled', constrained);
            if (constrained) document.documentElement.style.setProperty('--meo-content-max-width', '800px');
            else document.documentElement.style.removeProperty('--meo-content-max-width');
            (window as any).__editor.refreshLayout();
          }, enabled);
          await waitForFrames(page, 8);
          const label = `scrollable ${scrollable}, line numbers ${lineNumbers}, constrained width ${enabled}`;
          await assertDetailRowAlignment(page, label);
          const gap = await page.evaluate(() => (
            document.querySelector('.cm-line')!.getBoundingClientRect().left
            - document.querySelector('.cm-gutters')!.getBoundingClientRect().right
          ));
          if (Math.abs(gap) > 1) throw new Error(`${label} separated gutters from content by ${gap}px`);
          await assertDetailBackgroundContinuity(page, label);
          if (scrollable) {
            await page.evaluate(() => { document.querySelector('.cm-scroller')!.scrollTop = 8; });
            await waitForFrames(page, 4);
            await assertDetailRowAlignment(page, `${label}, after scrolling`);
            await assertDetailBackgroundContinuity(page, `${label}, after scrolling`);
            await page.evaluate(() => { document.querySelector('.cm-scroller')!.scrollTop = 0; });
            await waitForFrames(page, 4);
          }
        }
      }
    }
    await page.evaluate(() => {
      (window as any).__editor.setSourceLineNumbers('on');
      document.documentElement.classList.remove('meo-content-max-width-enabled');
      document.documentElement.style.removeProperty('--meo-content-max-width');
      document.documentElement.style.removeProperty('--meo-user-editor-font-size');
    });
    await page.setViewport({ width: 900, height: 500, deviceScaleFactor: 1 });
    await waitForFrames(page, 4);

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
        contentLeft: document.querySelector<HTMLElement>('.cm-line')?.getBoundingClientRect().left ?? null
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
    const passiveDeletionMarker = await marker.evaluate((element) => ({
      pointerEvents: getComputedStyle(element).pointerEvents,
      tooltipCount: document.querySelectorAll('.meo-deletion-tooltip, .meo-modified-tooltip').length
    }));
    if (passiveDeletionMarker.pointerEvents !== 'none' || passiveDeletionMarker.tooltipCount !== 0) {
      throw new Error(`Deleted marker retained pointer interaction: ${JSON.stringify(passiveDeletionMarker)}`);
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
    const originalStripeWidth = await modifiedMarker!.$eval(
      '.meo-git-gutter-stripe',
      (element) => element.getBoundingClientRect().width
    );
    await page.mouse.move(modifiedRect.x + modifiedRect.width / 2, modifiedRect.y + modifiedRect.height / 2);
    await waitForFrames(page, 2);
    const modifiedHoverState = await modifiedMarker!.evaluate((element) => ({
      pointerEvents: getComputedStyle(element).pointerEvents,
      stripeWidth: element.querySelector<HTMLElement>('.meo-git-gutter-stripe')?.getBoundingClientRect().width ?? 0,
      tooltipCount: document.querySelectorAll('.meo-deletion-tooltip, .meo-modified-tooltip').length
    }));
    if (
      modifiedHoverState.pointerEvents !== 'none' ||
      Math.abs(modifiedHoverState.stripeWidth - originalStripeWidth) > 0.1 ||
      modifiedHoverState.tooltipCount !== 0
    ) {
      throw new Error(`Modified marker retained hover behavior: ${JSON.stringify(modifiedHoverState)}`);
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
    for (const mode of ['source', 'live'] as const) {
      for (const numbers of ['off', 'on'] as const) {
        await page.evaluate(({ mode, numbers }) => {
          const editor = (window as any).__editor;
          editor.setMode(mode);
          editor.setSourceLineNumbers(numbers);
          editor.setText('first line\nsecond line');
          editor.setGitBaseline({
            available: true,
            tracked: true,
            mode: 'current-edit',
            baseText: 'first line\nprevious line'
          });
        }, { mode, numbers });
        await waitForFrames(page, 4);
        const selectionGeometry = await page.evaluate(() => {
          const editor = (window as any).__editor;
          const lineOne = editor.view.state.doc.line(1);
          const lineTwo = editor.view.state.doc.line(2);
          const lineOneRect = editor.view.coordsAtPos(lineOne.from);
          const lineTwoRect = editor.view.coordsAtPos(lineTwo.from);
          const documentEnd = editor.view.coordsAtPos(editor.view.state.doc.length);
          if (!lineOneRect || !lineTwoRect || !documentEnd) return null;
          return {
            leadingX: lineTwoRect.left - 4,
            lineOneY: (lineOneRect.top + lineOneRect.bottom) / 2,
            lineTwoY: (lineTwoRect.top + lineTwoRect.bottom) / 2,
            documentEndX: documentEnd.left + 1,
            documentLength: editor.view.state.doc.length,
            lineTwoFrom: lineTwo.from
          };
        });
        if (!selectionGeometry) throw new Error(`${mode}, numbers ${numbers}: selection geometry was unavailable`);

        await page.mouse.click(selectionGeometry.leadingX, selectionGeometry.lineTwoY);
        await waitForFrames(page, 2);
        const clickSelection = await page.evaluate(() => (window as any).__editor.view.state.selection.main.toJSON());
        if (
          clickSelection.anchor !== selectionGeometry.lineTwoFrom ||
          clickSelection.head !== selectionGeometry.lineTwoFrom
        ) {
          throw new Error(`${mode}, numbers ${numbers}: leading-gap click did not place the caret at line start: ${JSON.stringify({ selectionGeometry, clickSelection })}`);
        }

        await page.mouse.move(selectionGeometry.leadingX, selectionGeometry.lineOneY);
        await page.mouse.down();
        await page.mouse.move(selectionGeometry.documentEndX, selectionGeometry.lineTwoY, { steps: 4 });
        const dragCursor = await page.evaluate(({ x, y }) => {
          const target = document.elementFromPoint(x, y);
          return {
            target: target instanceof HTMLElement ? getComputedStyle(target).cursor : null,
            editor: getComputedStyle(document.querySelector<HTMLElement>('.cm-editor')!).cursor
          };
        }, { x: selectionGeometry.documentEndX, y: selectionGeometry.lineTwoY });
        await page.mouse.up();
        await waitForFrames(page, 2);
        const dragSelection = await page.evaluate(() => {
          const selection = (window as any).__editor.view.state.selection.main;
          return { from: selection.from, to: selection.to };
        });
        if (
          dragSelection.from !== 0 ||
          dragSelection.to !== selectionGeometry.documentLength ||
          dragCursor.target !== 'text' ||
          dragCursor.editor !== 'text'
        ) {
          throw new Error(`${mode}, numbers ${numbers}: leading-gap drag was not a text selection: ${JSON.stringify({ dragSelection, dragCursor })}`);
        }
      }
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

    for (const mode of ['source', 'live'] as const) {
      for (const numbers of ['off', 'on'] as const) {
        for (const limited of [false, true]) {
          await page.mouse.move(700, 450);
          await page.evaluate(({ mode, numbers, limited }) => {
            const editor = (window as any).__editor;
            editor.setMode(mode);
            editor.setSourceLineNumbers(numbers);
            document.documentElement.classList.toggle('meo-content-max-width-enabled', limited);
            document.documentElement.style.setProperty('--meo-content-max-width', limited ? '800px' : '100%');
            editor.refreshLayout();
          }, { mode, numbers, limited });
          await waitForFrames(page, 4);
          const triangle = await page.$eval('.meo-git-gutter-marker.is-deleted', (marker) => {
            const rect = marker.getBoundingClientRect();
            const style = getComputedStyle(marker, '::after');
            const left = rect.left + Number.parseFloat(style.left);
            const right = left + Number.parseFloat(style.borderLeftWidth);
            return { left, right, y: rect.top,
              gap: document.querySelector('.cm-line')!.getBoundingClientRect().left - right };
          });
          if (triangle.left < 0 || Math.abs(triangle.gap - 4) > 1) {
            throw new Error(`${mode}, numbers ${numbers}, limited ${limited}: deletion marker misplaced: ${JSON.stringify(triangle)}`);
          }
        }
      }
    }
    await page.mouse.move(700, 450);
    await page.evaluate(() => {
      (window as any).__editor.setMode('source');
      document.documentElement.classList.remove('meo-content-max-width-enabled');
      document.documentElement.style.removeProperty('--meo-content-max-width');
      (window as any).__editor.refreshLayout();
    });
    await waitForFrames(page, 4);

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
    console.log('document diff gutter checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
