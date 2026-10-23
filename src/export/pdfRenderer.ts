import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findPdfBrowserExecutablePath } from './browserDiscovery';
import { DEFAULT_PDF_MARGIN_MM } from './pdfStyles';

export type HeadlessExportOptions = {
  htmlDocument: string;
  browserExecutablePath?: string;
  puppeteerRuntimeModulePath: string;
  timeoutMs?: number;
};

export type RenderPdfExportOptions = HeadlessExportOptions & {
  outputPdfPath: string;
};

let puppeteerRuntimePromise: Promise<any> | null = null;

const CSS_PIXELS_PER_INCH = 96;
const MILLIMETERS_PER_INCH = 25.4;
const A4_WIDTH_MM = 210;
const A4_HEIGHT_MM = 297;
const PDF_VIEWPORT = {
  // Chromium lays out page.pdf() against the paper width, not its default 800px viewport.
  // Round down so the fit pass is never wider than the final A4 layout.
  width: Math.floor((A4_WIDTH_MM / MILLIMETERS_PER_INCH) * CSS_PIXELS_PER_INCH),
  height: Math.floor((A4_HEIGHT_MM / MILLIMETERS_PER_INCH) * CSS_PIXELS_PER_INCH),
  deviceScaleFactor: 1
};

type PdfPageMargins = { top: number; right: number; bottom: number; left: number };

/** Resolve @page margins with the browser's CSS cascade, including print media and CSS variables. */
async function resolvePdfPageMargins(page: any): Promise<PdfPageMargins> {
  return page.evaluate(({ defaultMargin, width, height }: { defaultMargin: number; width: number; height: number }) => {
    const selector = '.meo-pdf-margin-probe';
    const pageRules = (rules: CSSRuleList): string => Array.from(rules).map(rule => {
      if (rule.type === CSSRule.PAGE_RULE) {
        const pageRule = rule as CSSPageRule;
        if (pageRule.selectorText) return '';
        // Variable shorthands can leave longhands empty until computed-value resolution.
        const declarations = ['margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left'].map(property => {
          const value = pageRule.style.getPropertyValue(property);
          const priority = pageRule.style.getPropertyPriority(property);
          return value ? `${property}:${value}${priority ? ' !important' : ''};` : '';
        }).join('');
        return declarations ? `${selector}{${declarations}}` : '';
      }
      if ('cssRules' in rule) {
        const nested = pageRules((rule as CSSGroupingRule).cssRules);
        return nested ? `${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{${nested}}` : '';
      }
      return '';
    }).join('\n');
    const style = document.createElement('style');
    style.textContent = `@layer meo-pdf-default { ${selector}{margin:${defaultMargin}mm;} }\n` + Array.from(document.styleSheets).map(sheet => {
      try { return pageRules(sheet.cssRules); } catch { return ''; }
    }).join('\n');
    const container = document.createElement('div');
    container.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;height:0;';
    const probe = document.createElement('div');
    probe.className = selector.slice(1);
    probe.style.fontSize = getComputedStyle(document.documentElement).fontSize;
    container.append(probe);
    document.head.append(style);
    document.body.append(container);
    try {
      // Page percentages use the corresponding paper dimension, unlike ordinary vertical margins.
      container.style.width = `${height}mm`;
      const vertical = getComputedStyle(probe);
      const top = Number.parseFloat(vertical.marginTop);
      const bottom = Number.parseFloat(vertical.marginBottom);
      container.style.width = `${width}mm`;
      const horizontal = getComputedStyle(probe);
      const right = Number.parseFloat(horizontal.marginRight);
      const left = Number.parseFloat(horizontal.marginLeft);
      const fallback = defaultMargin * 96 / 25.4;
      const usable = (value: number) => Number.isFinite(value) && value >= 0 ? value : fallback;
      return { top: usable(top), right: usable(right), bottom: usable(bottom), left: usable(left) };
    } finally {
      container.remove();
      style.remove();
    }
  }, { defaultMargin: DEFAULT_PDF_MARGIN_MM, width: A4_WIDTH_MM, height: A4_HEIGHT_MM });
}

export async function renderPdfFromHtmlExport(options: RenderPdfExportOptions): Promise<void> {
  await withPreparedExportPage(options, async (page, margins) => {
    await page.pdf({
      path: options.outputPdfPath,
      printBackground: true,
      format: 'A4',
      preferCSSPageSize: true,
      margin: {
        top: `${margins.top}px`,
        right: `${margins.right}px`,
        bottom: `${margins.bottom}px`,
        left: `${margins.left}px`
      }
    });
  });
}

export async function materializeDocxBodyFromHtmlExport(options: HeadlessExportOptions): Promise<string> {
  return withPreparedExportPage(options, async (page) => {
    await page.evaluate(() => {
      const root = document.querySelector('.meo-export-doc')!;
      const transparent = (color: string) => color === 'transparent'
        || /^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/.test(color) || /\/\s*0(?:\.0+)?\s*\)$/.test(color);
      const entries = Array.from(root.querySelectorAll<HTMLElement>('*')).map(element => {
        const style = getComputedStyle(element);
        return { element, excluded: element.hidden || style.display === 'none' || Number(style.opacity) === 0,
          visible: style.visibility !== 'hidden' && style.visibility !== 'collapse',
          textVisible: parseFloat(style.fontSize) > 0 && !transparent(style.color),
          backgroundVisible: !transparent(style.backgroundColor) };
      });
      for (const { element, excluded, visible, textVisible, backgroundVisible } of entries) {
        if (!root.contains(element)) continue;
        if (excluded || !visible && element.matches('img,svg,hr,br')) { element.remove(); continue; }
        if (element instanceof HTMLDetailsElement && !element.open) {
          for (const child of Array.from(element.childNodes)) {
            if (!(child instanceof HTMLElement && child.tagName === 'SUMMARY')) child.remove();
          }
        }
        if (!visible || !textVisible) {
          for (const child of Array.from(element.childNodes)) if (child.nodeType === Node.TEXT_NODE) child.remove();
        }
        if (!backgroundVisible) {
          element.style.removeProperty('background'); element.style.removeProperty('background-color');
        }
      }
    });
    const handles = await page.$$('.meo-export-mermaid.is-rendered, .meo-export-math-display, img');
    for (const [index, handle] of handles.entries()) {
      const bounds = await handle.boundingBox();
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) continue;
      let data: string;
      try {
        data = await handle.screenshot({ type: 'png', encoding: 'base64', omitBackground: true });
      } catch (error) {
        const descriptor = await handle.evaluate((element: Element) => (
          `${element.tagName.toLowerCase()}.${Array.from(element.classList).join('.')}`
        )).catch(() => `element-${index + 1}`);
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Word export could not capture ${descriptor}: ${message}`, { cause: error });
      }
      await handle.evaluate((element: Element, captured: { pngBase64: string; width: number; height: number }) => {
        const image = document.createElement('img');
        image.src = `data:image/png;base64,${captured.pngBase64}`;
        image.alt = element instanceof HTMLImageElement
          ? element.alt
          : element.getAttribute('data-source') ?? '';
        image.setAttribute('data-meo-docx-materialized', '');
        if (element.classList.contains('meo-export-mermaid') && !element.classList.contains('is-math')) {
          // Word cannot split a drawing across pages. Match docxRuntime's A4 / 20mm
          // margins, retaining space for the image paragraph and its spacing.
          const maximumHeight = ((297 - 40) / 25.4) * 96 - 32;
          const maximumWidth = ((210 - 40) / 25.4) * 96;
          const scale = Math.min(1, maximumWidth / captured.width, maximumHeight / captured.height);
          image.width = Math.floor(captured.width * scale);
          image.height = Math.floor(captured.height * scale);
        }
        element.replaceWith(image);
      }, { pngBase64: data, width: bounds.width, height: bounds.height });
    }
    return page.$eval('.meo-export-doc', (element: Element) => element.outerHTML);
  }, 'docx');
}

export async function preparePdfPagination(page: any, pageHeight = PDF_VIEWPORT.height): Promise<void> {
  await page.evaluate((pageHeight: number) => {
    const documentRoot = document.querySelector<HTMLElement>('.meo-export-doc');
    if (!documentRoot) return;

    const numberFromStyle = (value: string): number => Number.parseFloat(value) || 0;
    const outerHeight = (element: HTMLElement): number => {
      const style = getComputedStyle(element);
      return element.getBoundingClientRect().height
        + numberFromStyle(style.marginTop)
        + numberFromStyle(style.marginBottom);
    };
    const rootStyle = getComputedStyle(documentRoot);
    const contentHeight = Math.max(
      1,
      pageHeight - numberFromStyle(rootStyle.paddingTop) - numberFromStyle(rootStyle.paddingBottom)
    );
    const maximumKeepTogetherHeight = contentHeight * 0.55;

    for (const item of Array.from(documentRoot.querySelectorAll<HTMLElement>('li'))) {
      const containsComplexBlock = item.querySelector(
        ':scope > :is(pre, blockquote, table, img, .meo-export-mermaid, .meo-export-math-display, ul, ol), '
        + ':scope > * :is(pre, blockquote, table, img, .meo-export-mermaid, .meo-export-math-display, ul, ol)'
      ) !== null;
      if (containsComplexBlock || outerHeight(item) > maximumKeepTogetherHeight) {
        item.setAttribute('data-meo-pdf-allow-break', '');
      }
    }

    for (const block of Array.from(
      documentRoot.querySelectorAll<HTMLElement>('pre, blockquote, table')
    )) {
      if (outerHeight(block) > maximumKeepTogetherHeight) {
        block.setAttribute('data-meo-pdf-allow-break', '');
      }
    }

    for (const diagram of Array.from(
      documentRoot.querySelectorAll<HTMLElement>('.meo-export-mermaid.is-rendered:not(.is-math)')
    )) {
      const preceding = diagram.previousElementSibling as HTMLElement | null;
      const description = preceding?.matches('p') && outerHeight(preceding) <= contentHeight * 0.15
        ? preceding : null;
      const heading = (description?.previousElementSibling ?? preceding) as HTMLElement | null;
      const graphic = diagram.querySelector('.meo-export-mermaid-svg > svg') as SVGSVGElement | null;
      if (!graphic) continue;

      const graphicHeight = graphic.getBoundingClientRect().height;
      const hasHeading = heading?.matches('h1, h2, h3, h4, h5, h6');
      const fixedPairHeight = (hasHeading ? outerHeight(heading!) + (description ? outerHeight(description) : 0) : 0)
        + outerHeight(diagram) - graphicHeight;
      const maximumGraphicHeight = Math.max(1, Math.floor(contentHeight - fixedPairHeight - 8));
      if (hasHeading) {
        diagram.setAttribute('data-meo-pdf-heading-pair', '');
        description?.setAttribute('data-meo-pdf-heading-description', '');
      }
      if (graphicHeight > maximumGraphicHeight) {
        graphic.style.maxHeight = `${maximumGraphicHeight}px`;
        graphic.style.width = 'auto';
      }
    }
  }, pageHeight);
}

export async function fitBlockMathForPdf(page: any, viewport = PDF_VIEWPORT): Promise<void> {
  await page.setViewport(viewport);
  const failures = await page.evaluate(async () => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>('.meo-export-math-fenced-display'));

    const fit = (root: HTMLElement) => {
      const reflow = !root.querySelector('.katex-html > .tag');
      root.classList.toggle('meo-math-nowrap', !reflow);
      let canvas = Array.from(root.children).find((child) => (
        child.classList.contains('meo-export-math-canvas')
      )) as HTMLElement | undefined;
      if (!canvas) {
        canvas = document.createElement('div');
        canvas.className = 'meo-export-math-canvas';
        while (root.firstChild) {
          canvas.appendChild(root.firstChild);
        }
        root.appendChild(canvas);
      }

      canvas.style.position = 'relative';
      canvas.style.flex = '0 0 auto';
      canvas.style.width = reflow ? '100%' : 'max-content';
      canvas.style.maxWidth = 'none';
      canvas.style.zoom = '1';
      canvas.style.fontSize = '1em';
      const display = canvas.querySelector<HTMLElement>(':scope > .katex-display');
      if (display) {
        display.style.width = reflow ? 'auto' : 'max-content';
        display.style.maxWidth = 'none';
      }

      const unbreakableWidth = () => Math.max(0, ...Array.from(canvas!.querySelectorAll<HTMLElement>('.katex-html > .base, .katex-html > .tag'))
        .map(base => { const style = getComputedStyle(base);
          return base.getBoundingClientRect().width + (Number.parseFloat(style.marginLeft) || 0) + (Number.parseFloat(style.marginRight) || 0); }));
      const naturalWidth = (reflow ? unbreakableWidth() : canvas.getBoundingClientRect().width) || canvas.scrollWidth;
      const rootStyle = getComputedStyle(root);
      const horizontalPadding = Number.parseFloat(rootStyle.paddingLeft) + Number.parseFloat(rootStyle.paddingRight);
      const availableWidth = Math.max(0, root.clientWidth - horizontalPadding);
      const fitScale = naturalWidth > 0 && availableWidth > 0
        ? Math.min(1, availableWidth / naturalWidth)
        : 1;

      canvas.style.fontSize = `${fitScale}em`;
      const uncorrectedWidth = reflow ? unbreakableWidth() || canvas.getBoundingClientRect().width : canvas.getBoundingClientRect().width;
      const targetWidth = naturalWidth * fitScale;
      const residualScale = uncorrectedWidth > 0
        ? Math.min(1, targetWidth / uncorrectedWidth)
        : 1;
      canvas.style.zoom = String(residualScale);
      if (reflow) canvas.style.width = `${100 / residualScale}%`;
    };

    if (document.fonts?.ready) {
      await document.fonts.ready;
    }
    roots.forEach(fit);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    roots.forEach(fit);

    return roots.flatMap((root, index) => {
      const canvas = root.querySelector<HTMLElement>(':scope > .meo-export-math-canvas');
      if (!canvas) {
        return [{ index, reason: 'missing canvas' }];
      }
      const rootRect = root.getBoundingClientRect();
      const rootStyle = getComputedStyle(root);
      const contentLeftBoundary = rootRect.left + Number.parseFloat(rootStyle.paddingLeft);
      const contentRightBoundary = rootRect.right - Number.parseFloat(rootStyle.paddingRight);
      const contentRects = Array.from(canvas.querySelectorAll<HTMLElement>('.katex-html .base'))
        .map((element) => element.getBoundingClientRect());
      const contentLeft = contentRects.length > 0
        ? Math.min(...contentRects.map((rect) => rect.left))
        : canvas.getBoundingClientRect().left;
      const contentRight = contentRects.length > 0
        ? Math.max(...contentRects.map((rect) => rect.right))
        : canvas.getBoundingClientRect().right;
      const fits = contentLeft >= contentLeftBoundary - 1 && contentRight <= contentRightBoundary + 1;
      return fits ? [] : [{
        index,
        reason: 'overflow',
        rootWidth: rootRect.width,
        contentWidth: contentRight - contentLeft,
        leftOverflow: Math.max(0, contentLeftBoundary - contentLeft),
        rightOverflow: Math.max(0, contentRight - contentRightBoundary)
      }];
    });
  });

  if (failures.length > 0) {
    throw new Error(`PDF block formula layout did not fit: ${JSON.stringify(failures)}`);
  }
}

async function withPreparedExportPage<T>(
  options: HeadlessExportOptions,
  action: (page: any, margins: PdfPageMargins) => Promise<T>,
  target: 'pdf' | 'docx' = 'pdf'
): Promise<T> {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30000);
  const browserExecutablePath = await findPdfBrowserExecutablePath(options.browserExecutablePath);
  const browserArgs = [
    '--allow-file-access-from-files',
    '--disable-web-security',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-sandbox'
  ];
  if (process.platform === 'win32' && path.basename(browserExecutablePath).toLowerCase() === 'msedge.exe') {
    browserArgs.push('--edge-skip-compat-layer-relaunch');
  }
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meo-export-'));
  const tempHtmlPath = path.join(tempDir, 'render.html');

  let browser: any = null;
  let operationFailed = false;
  let stage = 'launching the browser';
  try {
    await fs.writeFile(tempHtmlPath, options.htmlDocument, 'utf8');
    const puppeteer = await loadBundledPuppeteerRuntime(options.puppeteerRuntimeModulePath);

    browser = await puppeteer.launch({
      executablePath: browserExecutablePath,
      userDataDir: path.join(tempDir, 'browser-profile'),
      headless: true,
      timeout: timeoutMs,
      args: browserArgs
    });

    stage = 'loading the rendered document';
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(timeoutMs);
    page.setDefaultTimeout(timeoutMs);
    await page.emulateMediaType(target === 'pdf' ? 'print' : 'screen');

    await page.goto(pathToFileURL(tempHtmlPath).toString(), {
      waitUntil: 'domcontentloaded'
    });

    await page.evaluate((exportTarget: string) => {
      document.documentElement.setAttribute('data-meo-export-target', exportTarget);
      document.body.setAttribute('data-meo-export-target', exportTarget);
    }, target);

    const margins = target === 'pdf' ? await resolvePdfPageMargins(page) : { top: 0, right: 0, bottom: 0, left: 0 };
    const viewport = {
      ...PDF_VIEWPORT,
      width: Math.max(1, Math.floor(PDF_VIEWPORT.width - margins.left - margins.right)),
      height: Math.max(1, Math.floor(PDF_VIEWPORT.height - margins.top - margins.bottom))
    };
    if (target === 'pdf') await page.setViewport(viewport);

    stage = 'waiting for diagrams, formulas, and images';
    await page.waitForFunction(() => (window as any).__MEO_EXPORT_READY__ === true, {
      timeout: timeoutMs
    });
    const renderError = await page.evaluate(() => (window as any).__MEO_EXPORT_ERROR__);
    if (renderError) {
      throw new Error(`Export render failed: ${String(renderError)}`);
    }
    await page.evaluate(async () => {
      const refitMath = (window as any).__MEO_EXPORT_REFIT_MATH__;
      if (typeof refitMath === 'function') {
        await refitMath();
      }
    });
    stage = 'preparing the final document';
    if (target === 'pdf') {
      await fitBlockMathForPdf(page, viewport);
      await preparePdfPagination(page, viewport.height);
    }

    stage = 'writing the export';
    return await action(page, margins);
  } catch (error) {
    operationFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Export browser failed while ${stage}: ${message}`, { cause: error });
  } finally {
    const cleanupErrors: unknown[] = [];
    if (browser) {
      await browser.close().catch((error: unknown) => cleanupErrors.push(error));
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch((error) => cleanupErrors.push(error));
    if (!operationFailed && cleanupErrors.length > 0) {
      throw cleanupErrors[0];
    }
  }
}

async function loadBundledPuppeteerRuntime(runtimePath: string): Promise<any> {
  if (!puppeteerRuntimePromise) {
    const runtimeUrl = pathToFileURL(runtimePath).toString();
    puppeteerRuntimePromise = import(runtimeUrl)
      .then((mod: any) => unwrapPuppeteerRuntime(mod))
      .catch((error) => {
        puppeteerRuntimePromise = null;
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load PDF export runtime (${runtimePath}). Run the extension build to regenerate it. ${message}`);
      });
  }

  return puppeteerRuntimePromise;
}

function unwrapPuppeteerRuntime(mod: any): any {
  let current = mod;
  for (let i = 0; i < 5; i += 1) {
    if (current && typeof current.launch === 'function') {
      return current;
    }
    if (!current || typeof current !== 'object' || !('default' in current)) {
      break;
    }
    current = current.default;
  }

  throw new Error('Loaded PDF export runtime does not expose a Puppeteer-compatible `launch()` function.');
}
