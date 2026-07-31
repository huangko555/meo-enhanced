import exportRuntime from '../src/export/runtime';
import { fitBlockMathForPdf } from '../src/export/pdfRenderer';
import { defaultThemeSettings } from '../src/shared/themeDefaults';
import { launchTestBrowser } from './browser-test-helpers';
import fs from 'node:fs';
import path from 'node:path';

const wideFormula = [
  '\\operatorname{score}',
  '= \\alpha \\cdot \\operatorname{readability}',
  '+ \\beta \\cdot \\operatorname{stability}',
  '+ \\gamma \\cdot \\operatorname{consistency},',
  '\\qquad',
  '\\alpha + \\beta + \\gamma = 1000000000000000000000000000000000000000'
].join('\n');
const katexStylesHref = `data:text/css;base64,${Buffer.from(
  fs.readFileSync(path.resolve('node_modules/katex/dist/katex.min.css'), 'utf8')
).toString('base64')}`;
const baseOptions = {
  markdownText: `$$\n${wideFormula} = 0\n$$`,
  sourceDocumentPath: 'C:/tmp/source.md',
  outputFilePath: 'C:/tmp/export.html',
  htmlImageMode: 'embedded' as const,
  theme: defaultThemeSettings,
  appearance: 'dark' as const,
  styleEnvironment: {
    editorBackgroundColor: '#20252b',
    editorForegroundColor: '#d8dee9',
    codeBlockBackgroundColor: '#171b20',
    sideBarBackgroundColor: '#252b32',
    panelBorderColor: '#474b50'
  },
  mermaidRuntimeSrc: 'mermaid.min.js',
  katexStylesHref,
  baseHref: 'file:///C:/tmp/',
  title: 'Wide formula export'
};

const browser = await launchTestBrowser();
try {
  for (const target of ['html', 'pdf'] as const) {
    const rendered = exportRuntime.renderExportHtmlDocument({ ...baseOptions, target });
    const page = await browser.newPage();
    await page.setViewport({ width: 420, height: 720, deviceScaleFactor: 1 });
    await page.setContent(rendered.htmlDocument, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__MEO_EXPORT_READY__ === true);
    await page.evaluate(() => document.fonts.ready);
    if (target === 'pdf') {
      const unclippedLayout = await page.evaluate(() => {
        const root = document.querySelector<HTMLElement>('.meo-export-math-fenced-display')!;
        const canvas = root.querySelector<HTMLElement>(':scope > .meo-export-math-canvas')!;
        while (canvas.firstChild) {
          root.insertBefore(canvas.firstChild, canvas);
        }
        canvas.remove();
        const rootRect = root.getBoundingClientRect();
        const baseRects = Array.from(root.querySelectorAll<HTMLElement>('.katex-html .base'))
          .map((element) => element.getBoundingClientRect());
        return {
          rootLeft: rootRect.left,
          rootRight: rootRect.right,
          contentLeft: Math.min(...baseRects.map((rect) => rect.left)),
          contentRight: Math.max(...baseRects.map((rect) => rect.right))
        };
      });
      if (
        unclippedLayout.contentLeft >= unclippedLayout.rootLeft - 1 &&
        unclippedLayout.contentRight <= unclippedLayout.rootRight + 1
      ) {
        throw new Error(`PDF regression fixture did not reproduce clipping without the export math runtime: ${JSON.stringify(unclippedLayout)}`);
      }
      await fitBlockMathForPdf(page);
      const pdfViewport = page.viewport();
      if (!pdfViewport || pdfViewport.width !== 793 || pdfViewport.height !== 1122) {
        throw new Error(`PDF fit did not use the A4 layout viewport: ${JSON.stringify(pdfViewport)}`);
      }
    }

    const layout = await page.evaluate(() => {
      const viewport = document.querySelector<HTMLElement>('.meo-export-math-fenced-display')!;
      const formula = viewport.querySelector<HTMLElement>('.katex')!;
      const formulaHtml = viewport.querySelector<HTMLElement>('.katex-html')!;
      const viewportRect = viewport.getBoundingClientRect();
      const viewportStyle = getComputedStyle(viewport);
      const contentLeftBoundary = viewportRect.left + Number.parseFloat(viewportStyle.paddingLeft);
      const contentRightBoundary = viewportRect.right - Number.parseFloat(viewportStyle.paddingRight);
      const formulaRect = formula.getBoundingClientRect();
      const formulaHtmlRect = formulaHtml.getBoundingClientRect();
      const contentRects = Array.from(viewport.querySelectorAll<HTMLElement>('.katex-html .base'))
        .map((element) => element.getBoundingClientRect());
      const contentLeft = Math.min(...contentRects.map((rect) => rect.left));
      const contentRight = Math.max(...contentRects.map((rect) => rect.right));
      return {
        viewportWidth: viewportRect.width,
        viewportScrollWidth: viewport.scrollWidth,
        formulaWidth: formulaRect.width,
        formulaScrollWidth: formula.scrollWidth,
        formulaHtmlWidth: formulaHtmlRect.width,
        formulaHtmlScrollWidth: formulaHtml.scrollWidth,
        contentWidth: contentRight - contentLeft,
        fits: contentLeft >= contentLeftBoundary - 1 && contentRight <= contentRightBoundary + 1,
        documentOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        exportTarget: document.documentElement.dataset.meoExportTarget
      };
    });

    if (target === 'html') {
      const finalizedHtml = await page.evaluate(() => {
        document.querySelectorAll('script[data-meo-export-runtime], script[data-meo-export-mermaid-runtime]')
          .forEach((node) => node.remove());
        return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
      });
      const reopenedPage = await browser.newPage();
      await reopenedPage.setViewport({ width: 320, height: 720, deviceScaleFactor: 1 });
      await reopenedPage.setContent(finalizedHtml, { waitUntil: 'domcontentloaded' });
      await reopenedPage.waitForFunction(() => (window as any).__MEO_EXPORT_MATH_READY__ instanceof Promise);
      await reopenedPage.evaluate(() => (window as any).__MEO_EXPORT_MATH_READY__);
      const reopenedFits = await reopenedPage.evaluate(() => {
        const viewport = document.querySelector<HTMLElement>('.meo-export-math-fenced-display')!;
        const formula = viewport.querySelector<HTMLElement>('.katex-html')!;
        const viewportRect = viewport.getBoundingClientRect();
        const formulaRect = formula.getBoundingClientRect();
        return formulaRect.left >= viewportRect.left - 1 && formulaRect.right <= viewportRect.right + 1;
      });
      await reopenedPage.close();
      if (!reopenedFits) {
        throw new Error('Finalized HTML export stopped fitting the block formula after reopening at a narrower width');
      }
    }

    await page.close();
    if (layout.viewportWidth <= 0 || !layout.fits || layout.documentOverflow || layout.exportTarget !== target) {
      throw new Error(`${target.toUpperCase()} export clipped the block formula: ${JSON.stringify(layout)}`);
    }
  }

  console.log('Export block formula layout checks passed');
} finally {
  await browser.close();
}
