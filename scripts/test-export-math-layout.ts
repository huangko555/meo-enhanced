import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import exportRuntime from '../src/export/runtime';
import { launchTestBrowser } from './browser-test-helpers';

const longDisplayFormula = `\\operatorname{displayfit}+${'1234567890+'.repeat(80)}0`;
const fencedControlFormula = 'x^2 + y^2 = z^2';
const katexStylesHref = `data:text/css;base64,${Buffer.from(
  fs.readFileSync(path.resolve('node_modules/katex/dist/katex.min.css'), 'utf8')
).toString('base64')}`;
const rendered = exportRuntime.renderExportHtmlDocument({
  readingSnapshot: {
    snapshotId: 'math-layout',
    text: [
      'Inline baseline $x + 1$ remains prose.',
      '',
      `$$${longDisplayFormula}$$`,
      '',
      '$$',
      fencedControlFormula,
      '$$',
      '',
      'Selection before [safe link](https://example.com/safe) selection after.',
      '',
      'BROKEN_MATH_SENTINEL $\\frac{'
    ].join('\n'),
    appearance: 'dark',
    environment: {
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

type ExportMathRuntimeWindow = typeof window & {
  __MEO_EXPORT_READY__?: boolean;
  __MEO_EXPORT_REFIT_MATH__?: () => Promise<void>;
};

const browser = await launchTestBrowser();
try {
  for (const deviceScaleFactor of [1, 2]) {
    for (const width of [420, 1200]) {
      for (const zoom of [0.8, 1, 1.25]) {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width, height: 720, deviceScaleFactor });
          await page.setContent(rendered.htmlDocument, { waitUntil: 'domcontentloaded' });
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
            const selectionParagraph = Array.from(document.querySelectorAll<HTMLParagraphElement>('p'))
              .find((paragraph) => paragraph.textContent?.includes('Selection before'))!;
            const safeLink = selectionParagraph.querySelector<HTMLAnchorElement>('a')!;
            const range = document.createRange();
            range.selectNodeContents(selectionParagraph);
            const selection = getSelection()!;
            selection.removeAllRanges();
            selection.addRange(range);
            safeLink.focus({ preventScroll: true });
            const selectionText = selection.toString().replace(/\s+/g, ' ').trim();
            const copied = document.execCommand('copy');
            return {
              roots: roots.map(inspectRoot),
              documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
              pageOverflow: pageRoot.scrollWidth - pageRoot.clientWidth,
              pageWithinViewport: pageRect.left >= -1 && pageRect.right <= innerWidth + 1,
              inline: (() => {
                const root = document.querySelector<HTMLElement>('.meo-export-math-inline')!;
                const style = getComputedStyle(root);
                return {
                  canvasCount: root.querySelectorAll(':scope > .meo-export-math-canvas').length,
                  display: style.display,
                  verticalAlign: style.verticalAlign,
                  text: root.textContent
                };
              })(),
              selection: {
                text: selectionText,
                copied,
                focused: document.activeElement === safeLink,
                href: safeLink.href
              },
              controls: document.querySelectorAll('.meo-latex-math-zoom-controls, [aria-label*="fullscreen" i]').length,
              brokenFallbackVisible: document.body.textContent?.includes('BROKEN_MATH_SENTINEL') ?? false
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
          assert.equal(layout.inline.canvasCount, 0);
          assert.equal(layout.inline.display, 'inline-flex');
          assert.equal(layout.inline.verticalAlign, 'baseline');
          assert.ok(layout.inline.text?.includes('x+1'));
          assert.deepEqual(layout.selection, {
            text: 'Selection before safe link selection after.',
            copied: true,
            focused: true,
            href: 'https://example.com/safe'
          });
          assert.equal(layout.controls, 0);
          assert.equal(layout.brokenFallbackVisible, true);
          assert.ok(displays.every((root) => root.draggable === null));
        } finally {
          await page.close();
        }
      }
    }
  }

  const refitPage = await browser.newPage();
  try {
    await refitPage.setViewport({ width: 420, height: 720, deviceScaleFactor: 1 });
    await refitPage.setContent(rendered.htmlDocument, { waitUntil: 'domcontentloaded' });
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
    await axisScalePage.setContent(rendered.htmlDocument, { waitUntil: 'domcontentloaded' });
    await axisScalePage.waitForFunction(() => (window as ExportMathRuntimeWindow).__MEO_EXPORT_READY__ === true);
    const axisScaleLayout = await axisScalePage.evaluate(async () => {
      const ancestor = document.querySelector<HTMLElement>('.meo-export-page')!;
      ancestor.style.transform = 'scale(0.8)';
      ancestor.style.transformOrigin = 'top left';
      await (window as ExportMathRuntimeWindow).__MEO_EXPORT_REFIT_MATH__?.();
      const root = document.querySelector<HTMLElement>('.meo-export-math-display:not(.meo-export-math-fenced-display)')!;
      const rootRect = root.getBoundingClientRect();
      const contentRects = Array.from(root.querySelectorAll<HTMLElement>('.katex-html .base'))
        .map((base) => base.getBoundingClientRect());
      return {
        scale: rootRect.width / root.offsetWidth,
        fits: Math.min(...contentRects.map((rect) => rect.left)) >= rootRect.left - 1
          && Math.max(...contentRects.map((rect) => rect.right)) <= rootRect.right + 1,
        clipping: [getComputedStyle(root).overflowX, getComputedStyle(root).overflowY]
          .some((value) => value === 'hidden' || value === 'clip')
      };
    });
    assert.ok(Math.abs(axisScaleLayout.scale - 0.8) <= 0.01, JSON.stringify(axisScaleLayout));
    assert.equal(axisScaleLayout.fits, true, JSON.stringify(axisScaleLayout));
    assert.equal(axisScaleLayout.clipping, false, JSON.stringify(axisScaleLayout));
  } finally {
    await axisScalePage.close();
  }

  for (const invalidGeometry of ['zero', 'nonfinite', 'nonfinite-natural', 'negative', 'nonaxis'] as const) {
    const page = await browser.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    try {
      await page.setViewport({ width: 420, height: 720, deviceScaleFactor: 1 });
      await page.setContent(rendered.htmlDocument, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => (window as ExportMathRuntimeWindow).__MEO_EXPORT_READY__ === true);
      const invalidResult = await page.evaluate(async (kind) => {
        const root = document.querySelector<HTMLElement>('.meo-export-math-display:not(.meo-export-math-fenced-display)')!;
        const canvas = root.querySelector<HTMLElement>(':scope > .meo-export-math-canvas')!;
        const stablePresentation = { fontSize: canvas.style.fontSize, zoom: canvas.style.zoom };
        if (kind === 'zero') {
          Object.defineProperty(root, 'offsetWidth', { configurable: true, get: () => 0 });
        } else if (kind === 'negative') {
          Object.defineProperty(root, 'clientWidth', { configurable: true, get: () => -1 });
        } else if (kind === 'nonfinite') {
          const originalRect = root.getBoundingClientRect.bind(root);
          root.getBoundingClientRect = () => ({ ...originalRect(), width: Number.NaN } as DOMRect);
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
      }, invalidGeometry);
      assert.deepEqual(invalidResult.presentationAfter, invalidResult.stablePresentation, JSON.stringify({ invalidGeometry, invalidResult }));
      assert.equal(invalidResult.invalidCss, false, JSON.stringify({ invalidGeometry, invalidResult }));
      assert.equal(invalidResult.clipping, false, JSON.stringify({ invalidGeometry, invalidResult }));
      assert.equal(invalidResult.contentVisible, true, JSON.stringify({ invalidGeometry, invalidResult }));
      assert.deepEqual(pageErrors, [], JSON.stringify({ invalidGeometry, pageErrors }));
    } finally {
      await page.close();
    }
  }

  console.log('Standalone HTML display formula layout checks passed');
} finally {
  await browser.close();
}
