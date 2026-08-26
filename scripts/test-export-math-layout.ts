import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import exportRuntime from '../src/export/runtime';
import { launchTestBrowser } from './browser-test-helpers';

const longDisplayFormula = `\\operatorname{displayfit}+${'1234567890+'.repeat(80)}0`;
const longInlineFormula = `\\mathrm{${Array.from(
  { length: 192 },
  (_, index) => `INLINE${String(index).padStart(3, '0')}`
).join('')}}`;
const mediumInlineFormula = `\\mathrm{${Array.from(
  { length: 8 },
  (_, index) => `MEDIUM${String(index).padStart(2, '0')}`
).join('')}}`;
const fencedControlFormula = 'x^2 + y^2 = z^2';
const katexStylesHref = `data:text/css;base64,${Buffer.from(
  fs.readFileSync(path.resolve('node_modules/katex/dist/katex.min.css'), 'utf8')
).toString('base64')}`;
const rendered = exportRuntime.renderExportHtmlDocument({
  readingSnapshot: {
    snapshotId: 'math-layout',
    text: [
      'Short prefix $x + 1$ short suffix.',
      '',
      `Medium prefix $${mediumInlineFormula}$ medium suffix.`,
      '',
      `Prefix prose wraps before [safe link](https://example.com/safe) and $${longInlineFormula}$ then suffix prose wraps after the formula.`,
      '',
      `$$${longDisplayFormula}$$`,
      '',
      '$$',
      fencedControlFormula,
      '$$',
      '',
      'BROKEN_INLINE_SENTINEL $\\frac{'
    ].join('\n'),
    appearance: 'dark',
    environment: {
      previewFontFamily: '',
      editorBackgroundColor: '#20252b',
      editorForegroundColor: '#d8dee9',
      codeBlockBackgroundColor: '#171b20',
      sideBarBackgroundColor: '#252b32',
      panelBorderColor: '#474b50'
    }
  },
  sourceDocumentPath: 'C:/tmp/source.md',
  outputFilePath: 'C:/tmp/export.html',
  target: 'html',
  katexStylesHref,
  baseHref: 'file:///C:/tmp/',
  title: 'Display formula export'
});
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-export-inline-math-'));
const renderedPath = path.join(temp, 'math-layout.html');
fs.writeFileSync(renderedPath, rendered.htmlDocument, 'utf8');
const renderedUrl = pathToFileURL(renderedPath).href;

type ExportMathRuntimeWindow = typeof window & {
  __MEO_EXPORT_READY__?: boolean;
  __MEO_EXPORT_REFIT_MATH__?: () => Promise<void>;
};

const browser = await launchTestBrowser();
try {
  await browser.defaultBrowserContext().overridePermissions('file://', ['clipboard-read', 'clipboard-write']);
  for (const deviceScaleFactor of [1, 2]) {
    for (const width of [420, 1200]) {
      for (const zoom of [0.8, 1, 1.25]) {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width, height: 720, deviceScaleFactor });
          await page.goto(renderedUrl, { waitUntil: 'domcontentloaded' });
          await page.waitForFunction(() => (window as ExportMathRuntimeWindow).__MEO_EXPORT_READY__ === true);
          await page.evaluate(async (value) => {
            document.documentElement.style.zoom = String(value);
            await (window as ExportMathRuntimeWindow).__MEO_EXPORT_REFIT_MATH__?.();
          }, zoom);

          const layout = await page.evaluate(async () => {
            const pageRoot = document.querySelector<HTMLElement>('.meo-export-doc')!;
            const pageRect = pageRoot.getBoundingClientRect();
            const roots = Array.from(document.querySelectorAll<HTMLElement>('.meo-export-math'));
            const inspectRoot = (root: HTMLElement) => {
              const rootRect = root.getBoundingClientRect();
              const style = getComputedStyle(root);
              const bases = Array.from(root.querySelectorAll<HTMLElement>('.katex-html .base'));
              const baseRects = bases.map((base) => base.getBoundingClientRect());
              const contentLeft = baseRects.length > 0 ? Math.min(...baseRects.map((rect) => rect.left)) : rootRect.left;
              const contentRight = baseRects.length > 0 ? Math.max(...baseRects.map((rect) => rect.right)) : rootRect.right;
              const contentLeftBoundary = rootRect.left + Number.parseFloat(style.paddingLeft);
              const contentRightBoundary = rootRect.right - Number.parseFloat(style.paddingRight);
              const clippingAncestors: string[] = [];
              for (let current: HTMLElement | null = root; current; current = current.parentElement) {
                const currentStyle = getComputedStyle(current);
                if ([currentStyle.overflowX, currentStyle.overflowY].some((value) => value === 'hidden' || value === 'clip')) {
                  clippingAncestors.push(`${current.tagName.toLowerCase()}.${current.className}:${currentStyle.overflowX}/${currentStyle.overflowY}`);
                }
              }
              return {
                inline: root.classList.contains('meo-export-math-inline'),
                fenced: root.classList.contains('meo-export-math-fenced-display'),
                display: root.classList.contains('meo-export-math-display'),
                canvasCount: root.querySelectorAll(':scope > .meo-export-math-canvas').length,
                contentWithinRoot: contentLeft >= contentLeftBoundary - 1 && contentRight <= contentRightBoundary + 1,
                contentWithinPage: contentLeft >= pageRect.left - 1 && contentRight <= pageRect.right + 1,
                rootWithinPage: rootRect.left >= pageRect.left - 1 && rootRect.right <= pageRect.right + 1,
                scrollOverflow: root.scrollWidth - root.clientWidth,
                overflowX: style.overflowX,
                clippingAncestors,
                draggable: root.getAttribute('draggable')
              };
            };
            const shortParagraph = Array.from(document.querySelectorAll<HTMLParagraphElement>('p'))
              .find((paragraph) => paragraph.textContent?.includes('Short prefix'))!;
            const longParagraph = Array.from(document.querySelectorAll<HTMLParagraphElement>('p'))
              .find((paragraph) => paragraph.textContent?.includes('Prefix prose wraps before'))!;
            const shortInline = shortParagraph.querySelector<HTMLElement>('.meo-export-math-inline')!;
            const longInline = longParagraph.querySelector<HTMLElement>('.meo-export-math-inline')!;
            const installBaselineProbe = (root: HTMLElement, side: 'before' | 'after') => {
              const probe = document.createElement('span');
              probe.dataset.mathBaselineProbe = side;
              probe.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;';
              root[side === 'before' ? 'before' : 'after'](probe);
              return probe;
            };
            const shortBefore = installBaselineProbe(shortInline, 'before');
            const shortAfter = installBaselineProbe(shortInline, 'after');
            const longBefore = installBaselineProbe(longInline, 'before');
            const longAfter = installBaselineProbe(longInline, 'after');
            const textFragments = (node: Node | null) => {
              if (!node) return [];
              const textRange = document.createRange();
              textRange.selectNodeContents(node);
              return Array.from(textRange.getClientRects()).map((rect) => ({
                left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom
              }));
            };
            const safeLink = longParagraph.querySelector<HTMLAnchorElement>('a')!;
            const range = document.createRange();
            range.selectNodeContents(longParagraph);
            const selection = getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            safeLink.focus({ preventScroll: true });
            const normalizeSelection = (value: string) => value.replace(/[\u200b\u2060]/g, '').replace(/\s+/g, ' ').trim();
            const selectionText = normalizeSelection(selection.toString());
            const copied = document.execCommand('copy');
            const clipboardText = normalizeSelection(await navigator.clipboard.readText());
            const inspectInline = (root: HTMLElement, before: HTMLElement, after: HTMLElement) => {
              const inspected = inspectRoot(root);
              const canvas = root.querySelector<HTMLElement>(':scope > .meo-export-math-canvas');
              const paragraph = root.closest('p')!;
              return {
                ...inspected,
                computedDisplay: getComputedStyle(root).display,
                verticalAlign: getComputedStyle(root).verticalAlign,
                canvasFontSize: canvas?.style.fontSize ?? '',
                canvasZoom: canvas?.style.zoom ?? '',
                rootBoxes: Array.from(root.getClientRects()).map((rect) => ({
                  left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom
                })),
                rangeFragments: textFragments(root),
                prefixFragments: textFragments(paragraph.firstChild),
                suffixFragments: textFragments(paragraph.lastChild),
                baselineBefore: before.getBoundingClientRect().bottom,
                baselineAfter: after.getBoundingClientRect().bottom,
                paragraphText: paragraph.textContent
              };
            };
            return {
              roots: roots.map(inspectRoot),
              documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
              pageOverflow: pageRoot.scrollWidth - pageRoot.clientWidth,
              pageWithinViewport: pageRect.left >= -1 && pageRect.right <= innerWidth + 1,
              inline: {
                short: inspectInline(shortInline, shortBefore, shortAfter),
                long: inspectInline(longInline, longBefore, longAfter)
              },
              selection: {
                text: selectionText,
                clipboardText,
                copied,
                focused: document.activeElement === safeLink,
                href: safeLink.href
              },
              controls: document.querySelectorAll('.meo-latex-math-zoom-controls, [aria-label*="fullscreen" i]').length,
              brokenFallbackVisible: document.body.textContent?.includes('BROKEN_INLINE_SENTINEL') ?? false
            };
          });

          const displays = layout.roots.filter((root) => root.display);
          const sameLine = displays.find((root) => !root.fenced)!;
          const fenced = displays.find((root) => root.fenced)!;
          assert.equal(fenced.canvasCount, 1, JSON.stringify({ width, zoom, deviceScaleFactor, fenced }));
          assert.equal(fenced.contentWithinRoot, true, JSON.stringify({ width, zoom, deviceScaleFactor, fenced }));
          assert.equal(sameLine.canvasCount, 1, JSON.stringify({ width, zoom, deviceScaleFactor, sameLine }));
          assert.equal(sameLine.contentWithinRoot, true, JSON.stringify({ width, zoom, deviceScaleFactor, sameLine }));
          assert.ok(displays.every((root) => root.contentWithinPage && root.rootWithinPage), JSON.stringify(layout));
          assert.ok(displays.every((root) => root.scrollOverflow <= 1 && !/(auto|scroll)/.test(root.overflowX)), JSON.stringify(layout));
          assert.ok(displays.every((root) => root.clippingAncestors.length === 0), JSON.stringify(layout));
          assert.ok(layout.documentOverflow <= 1 && layout.bodyOverflow <= 1 && layout.pageOverflow <= 1, JSON.stringify(layout));
          assert.equal(layout.pageWithinViewport, true, JSON.stringify(layout));
          assert.equal(layout.inline.short.canvasCount, 0);
          assert.equal(layout.inline.short.computedDisplay, 'inline-flex');
          assert.equal(layout.inline.short.verticalAlign, 'baseline');
          assert.equal(layout.inline.short.canvasFontSize, '');
          assert.equal(layout.inline.short.canvasZoom, '');
          assert.equal(layout.inline.short.rootBoxes.length, 1);
          assert.ok(layout.inline.short.rangeFragments.length > 0);
          assert.ok(Math.abs(layout.inline.short.baselineBefore - layout.inline.short.baselineAfter) <= 0.01, JSON.stringify(layout.inline.short));
          assert.equal(layout.inline.long.contentWithinRoot, true, JSON.stringify({ width, zoom, deviceScaleFactor, inline: layout.inline.long }));
          assert.equal(layout.inline.long.contentWithinPage, true, JSON.stringify({ width, zoom, deviceScaleFactor, inline: layout.inline.long }));
          assert.equal(layout.inline.long.canvasCount, 1, JSON.stringify({ width, zoom, deviceScaleFactor, inline: layout.inline.long }));
          assert.equal(layout.inline.long.computedDisplay, 'inline-flex');
          assert.equal(layout.inline.long.verticalAlign, 'baseline');
          assert.equal(layout.inline.long.rootBoxes.length, 1, JSON.stringify(layout.inline.long));
          assert.ok(layout.inline.long.rangeFragments.length > 0, JSON.stringify(layout.inline.long));
          assert.ok(layout.inline.long.prefixFragments.length > 0 && layout.inline.long.suffixFragments.length > 0, JSON.stringify(layout.inline.long));
          assert.ok(layout.inline.long.prefixFragments[0].top <= layout.inline.long.rangeFragments[0].top, JSON.stringify(layout.inline.long));
          assert.ok(layout.inline.long.rangeFragments[0].top <= layout.inline.long.suffixFragments.at(-1)!.top, JSON.stringify(layout.inline.long));
          assert.equal(layout.inline.long.scrollOverflow <= 1, true, JSON.stringify(layout.inline.long));
          assert.deepEqual(layout.inline.long.clippingAncestors, []);
          assert.equal(layout.inline.long.draggable, null);
          assert.equal(layout.selection.text, layout.selection.clipboardText);
          assert.equal(layout.selection.copied, true);
          assert.equal(layout.selection.focused, true);
          assert.equal(layout.selection.href, 'https://example.com/safe');
          assert.equal((layout.selection.text.match(/INLINE000/g) ?? []).length, 1, layout.selection.text);
          assert.equal((layout.selection.text.match(/INLINE191/g) ?? []).length, 1, layout.selection.text);
          assert.ok(layout.selection.text.startsWith('Prefix prose wraps before safe link and'));
          assert.ok(layout.selection.text.endsWith('then suffix prose wraps after the formula.'));
          assert.equal(layout.controls, 0);
          assert.equal(layout.brokenFallbackVisible, true);
          assert.ok(displays.every((root) => root.draggable === null));
        } finally {
          await page.close();
        }
      }
    }
  }

  const lifecyclePage = await browser.newPage();
  try {
    await lifecyclePage.setViewport({ width: 1200, height: 720, deviceScaleFactor: 1 });
    await lifecyclePage.goto(renderedUrl, { waitUntil: 'domcontentloaded' });
    await lifecyclePage.waitForFunction(() => (window as ExportMathRuntimeWindow).__MEO_EXPORT_READY__ === true);
    const initialNative = await lifecyclePage.evaluate(() => {
      const paragraph = Array.from(document.querySelectorAll<HTMLParagraphElement>('p'))
        .find((candidate) => candidate.textContent?.includes('Medium prefix'))!;
      const root = paragraph.querySelector<HTMLElement>('.meo-export-math-inline')!;
      const before = document.createElement('span');
      const after = document.createElement('span');
      before.style.cssText = after.style.cssText = 'display:inline-block;width:0;height:0;padding:0;margin:0;border:0;';
      root.before(before);
      root.after(after);
      return {
        html: root.innerHTML,
        className: root.className,
        canvasCount: root.querySelectorAll(':scope > .meo-export-math-canvas').length,
        baselineDelta: Math.abs(before.getBoundingClientRect().bottom - after.getBoundingClientRect().bottom),
        displayControllers: document.querySelectorAll('.meo-export-math-display > .meo-export-math-canvas').length
      };
    });
    assert.equal(initialNative.canvasCount, 0, JSON.stringify(initialNative));
    assert.equal(initialNative.className, 'meo-export-math meo-export-math-inline', JSON.stringify(initialNative));
    assert.ok(initialNative.html.startsWith('<span class="katex"'), JSON.stringify(initialNative));
    assert.ok(initialNative.baselineDelta <= 0.01, JSON.stringify(initialNative));
    assert.equal(initialNative.displayControllers, 2, JSON.stringify(initialNative));

    await lifecyclePage.setViewport({ width: 420, height: 720, deviceScaleFactor: 1 });
    await lifecyclePage.evaluate(() => (window as ExportMathRuntimeWindow).__MEO_EXPORT_REFIT_MATH__?.());
    const narrowed = await lifecyclePage.evaluate(async () => {
      await (window as ExportMathRuntimeWindow).__MEO_EXPORT_REFIT_MATH__?.();
      const paragraph = Array.from(document.querySelectorAll<HTMLParagraphElement>('p'))
        .find((candidate) => candidate.textContent?.includes('Medium prefix'))!;
      const root = paragraph.querySelector<HTMLElement>('.meo-export-math-inline')!;
      const rootRect = root.getBoundingClientRect();
      const baseRects = Array.from(root.querySelectorAll<HTMLElement>('.katex-html .base'))
        .map((base) => base.getBoundingClientRect());
      return {
        canvasCount: root.querySelectorAll(':scope > .meo-export-math-canvas').length,
        fits: Math.min(...baseRects.map((rect) => rect.left)) >= rootRect.left - 1
          && Math.max(...baseRects.map((rect) => rect.right)) <= rootRect.right + 1,
        pageOverflow: document.querySelector<HTMLElement>('.meo-export-doc')!.scrollWidth
          - document.querySelector<HTMLElement>('.meo-export-doc')!.clientWidth
      };
    });
    assert.deepEqual(narrowed, { canvasCount: 1, fits: true, pageOverflow: 0 }, JSON.stringify(narrowed));
  } finally {
    await lifecyclePage.close();
  }

  const refitPage = await browser.newPage();
  try {
    await refitPage.setViewport({ width: 420, height: 720, deviceScaleFactor: 1 });
    await refitPage.goto(renderedUrl, { waitUntil: 'domcontentloaded' });
    await refitPage.waitForFunction(() => (window as ExportMathRuntimeWindow).__MEO_EXPORT_READY__ === true);
    await refitPage.setViewport({ width: 320, height: 720, deviceScaleFactor: 1 });
    await refitPage.evaluate(() => (window as ExportMathRuntimeWindow).__MEO_EXPORT_REFIT_MATH__?.());
    const refitAtNarrowerWidth = await refitPage.evaluate(() => {
      const roots = Array.from(document.querySelectorAll<HTMLElement>('.meo-export-math-display'));
      return roots.length === 2 && roots.every((root) => {
        const rootRect = root.getBoundingClientRect();
        const contentRects = Array.from(root.querySelectorAll<HTMLElement>('.katex-html .base'))
          .map((base) => base.getBoundingClientRect());
        return root.querySelectorAll(':scope > .meo-export-math-canvas').length === 1
          && Math.min(...contentRects.map((rect) => rect.left)) >= rootRect.left - 1
          && Math.max(...contentRects.map((rect) => rect.right)) <= rootRect.right + 1;
      });
    });
    assert.equal(refitAtNarrowerWidth, true, 'Standalone HTML refit stopped fitting display math at a narrower width');
  } finally {
    await refitPage.close();
  }

  const axisScalePage = await browser.newPage();
  try {
    await axisScalePage.setViewport({ width: 420, height: 720, deviceScaleFactor: 1 });
    await axisScalePage.goto(renderedUrl, { waitUntil: 'domcontentloaded' });
    await axisScalePage.waitForFunction(() => (window as ExportMathRuntimeWindow).__MEO_EXPORT_READY__ === true);
    const axisScaleLayout = await axisScalePage.evaluate(async () => {
      const ancestor = document.querySelector<HTMLElement>('.meo-export-page')!;
      ancestor.style.transform = 'scale(0.8)';
      ancestor.style.transformOrigin = 'top left';
      await (window as ExportMathRuntimeWindow).__MEO_EXPORT_REFIT_MATH__?.();
      const roots = [
        document.querySelector<HTMLElement>('.meo-export-math-display:not(.meo-export-math-fenced-display)')!,
        document.querySelector<HTMLElement>('.meo-export-math-inline:has(> .meo-export-math-canvas)')!
      ];
      return {
        scale: roots[0].getBoundingClientRect().width / roots[0].offsetWidth,
        fits: roots.map((root) => {
          const rootRect = root.getBoundingClientRect();
          const contentRects = Array.from(root.querySelectorAll<HTMLElement>('.katex-html .base'))
            .map((base) => base.getBoundingClientRect());
          return Math.min(...contentRects.map((rect) => rect.left)) >= rootRect.left - 1
            && Math.max(...contentRects.map((rect) => rect.right)) <= rootRect.right + 1;
        }),
        clipping: roots.some((root) => [getComputedStyle(root).overflowX, getComputedStyle(root).overflowY]
          .some((value) => value === 'hidden' || value === 'clip'))
      };
    });
    assert.ok(Math.abs(axisScaleLayout.scale - 0.8) <= 0.01, JSON.stringify(axisScaleLayout));
    assert.deepEqual(axisScaleLayout.fits, [true, true], JSON.stringify(axisScaleLayout));
    assert.equal(axisScaleLayout.clipping, false, JSON.stringify(axisScaleLayout));
  } finally {
    await axisScalePage.close();
  }

  for (const layoutKind of ['display', 'inline'] as const) {
    for (const invalidGeometry of ['zero', 'nonfinite', 'nonfinite-natural', 'negative', 'nonaxis'] as const) {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
      await page.setViewport({ width: 420, height: 720, deviceScaleFactor: 1 });
      await page.goto(renderedUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => (window as ExportMathRuntimeWindow).__MEO_EXPORT_READY__ === true);
      const invalidResult = await page.evaluate(async ({ kind, layout }) => {
        const root = document.querySelector<HTMLElement>(layout === 'inline'
          ? '.meo-export-math-inline:has(> .meo-export-math-canvas)'
          : '.meo-export-math-display:not(.meo-export-math-fenced-display)')!;
        const canvas = root.querySelector<HTMLElement>(':scope > .meo-export-math-canvas')!;
        const measurementRoot = layout === 'inline' ? root.parentElement! : root;
        const stablePresentation = { fontSize: canvas.style.fontSize, zoom: canvas.style.zoom };
        if (kind === 'zero') {
          Object.defineProperty(measurementRoot, 'offsetWidth', { configurable: true, get: () => 0 });
        } else if (kind === 'negative') {
          Object.defineProperty(measurementRoot, 'clientWidth', { configurable: true, get: () => -1 });
        } else if (kind === 'nonfinite') {
          const originalRect = measurementRoot.getBoundingClientRect.bind(measurementRoot);
          measurementRoot.getBoundingClientRect = () => ({ ...originalRect(), width: Number.NaN } as DOMRect);
        } else if (kind === 'nonfinite-natural') {
          const originalRect = canvas.getBoundingClientRect.bind(canvas);
          canvas.getBoundingClientRect = () => ({ ...originalRect(), width: Number.NaN } as DOMRect);
          Object.defineProperty(canvas, 'scrollWidth', { configurable: true, get: () => Number.NaN });
        } else {
          document.querySelector<HTMLElement>('.meo-export-page')!.style.transform = 'rotate(3deg)';
        }
        await (window as ExportMathRuntimeWindow).__MEO_EXPORT_REFIT_MATH__?.();
        const styleText = `${canvas.style.fontSize};${canvas.style.zoom};${root.style.cssText}`;
        const rootStyle = getComputedStyle(root);
        return {
          stablePresentation,
          presentationAfter: { fontSize: canvas.style.fontSize, zoom: canvas.style.zoom },
          invalidCss: /(?:NaN|Infinity)/i.test(styleText),
          clipping: [rootStyle.overflowX, rootStyle.overflowY]
            .some((value) => value === 'hidden' || value === 'clip'),
          contentVisible: (root.textContent?.trim().length ?? 0) > 0 && getComputedStyle(canvas).display !== 'none'
        };
      }, { kind: invalidGeometry, layout: layoutKind });
      assert.deepEqual(invalidResult.presentationAfter, invalidResult.stablePresentation, JSON.stringify({ layoutKind, invalidGeometry, invalidResult }));
      assert.equal(invalidResult.invalidCss, false, JSON.stringify({ layoutKind, invalidGeometry, invalidResult }));
      assert.equal(invalidResult.clipping, false, JSON.stringify({ layoutKind, invalidGeometry, invalidResult }));
      assert.equal(invalidResult.contentVisible, true, JSON.stringify({ layoutKind, invalidGeometry, invalidResult }));
      assert.deepEqual(pageErrors, [], JSON.stringify({ layoutKind, invalidGeometry, pageErrors }));
    } finally {
      await page.close();
    }
  }
  }

  console.log('Standalone HTML display formula layout checks passed');
} finally {
  await browser.close();
  fs.rmSync(temp, { recursive: true, force: true });
}
