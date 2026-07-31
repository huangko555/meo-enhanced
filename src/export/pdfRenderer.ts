import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { findPdfBrowserExecutablePath } from './browserDiscovery';

export type HeadlessExportOptions = {
  htmlDocument: string;
  browserExecutablePath?: string;
  puppeteerRuntimeModulePath?: string;
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

export async function renderPdfFromHtmlExport(options: RenderPdfExportOptions): Promise<void> {
  await withPreparedExportPage(options, { exportTarget: 'pdf' }, async (page) => {
    await page.pdf({
      path: options.outputPdfPath,
      printBackground: true,
      format: 'A4',
      margin: {
        top: '0in',
        right: '0in',
        bottom: '0in',
        left: '0in'
      }
    });
  });
}

export async function fitBlockMathForPdf(page: any): Promise<void> {
  await page.setViewport(PDF_VIEWPORT);
  const failures = await page.evaluate(async () => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>('.meo-export-math-fenced-display'));

    const fit = (root: HTMLElement) => {
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
      canvas.style.width = 'max-content';
      canvas.style.maxWidth = 'none';
      canvas.style.zoom = '1';
      canvas.style.fontSize = '1em';
      const display = canvas.querySelector<HTMLElement>(':scope > .katex-display');
      if (display) {
        display.style.width = 'max-content';
        display.style.maxWidth = 'none';
      }

      const naturalWidth = canvas.getBoundingClientRect().width || canvas.scrollWidth;
      const rootStyle = getComputedStyle(root);
      const horizontalPadding = Number.parseFloat(rootStyle.paddingLeft) + Number.parseFloat(rootStyle.paddingRight);
      const availableWidth = Math.max(0, root.clientWidth - horizontalPadding);
      const fitScale = naturalWidth > 0 && availableWidth > 0
        ? Math.min(1, availableWidth / naturalWidth)
        : 1;

      canvas.style.fontSize = `${fitScale}em`;
      const uncorrectedWidth = canvas.getBoundingClientRect().width;
      const targetWidth = naturalWidth * fitScale;
      const residualScale = uncorrectedWidth > 0
        ? Math.min(1, targetWidth / uncorrectedWidth)
        : 1;
      canvas.style.zoom = String(residualScale);
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

export async function finalizeHtmlExportInHeadlessBrowser(options: HeadlessExportOptions): Promise<string> {
  return withPreparedExportPage(options, { exportTarget: 'html' }, async (page) => {
    const serialized = await page.evaluate(() => {
      document.querySelectorAll('script[data-meo-export-runtime], script[data-meo-export-mermaid-runtime]').forEach((node) => {
        node.remove();
      });
      document.querySelectorAll('.meo-export-mermaid').forEach((node) => {
        node.removeAttribute('data-source-b64');
      });
      document.documentElement.removeAttribute('data-meo-export-target');
      document.body.removeAttribute('data-meo-export-target');

      try {
        delete window.__MEO_EXPORT_READY__;
        delete window.__MEO_EXPORT_ERROR__;
      } catch {
        // Ignore delete failures.
      }

      return '<!DOCTYPE html>\n' + document.documentElement.outerHTML;
    });

    return String(serialized);
  });
}

async function withPreparedExportPage<T>(
  options: HeadlessExportOptions,
  runtimeOptions: {
    exportTarget: 'html' | 'pdf';
  },
  action: (page: any) => Promise<T>
): Promise<T> {
  const timeoutMs = Math.max(1000, options.timeoutMs ?? 30000);
  const browserExecutablePath = await findPdfBrowserExecutablePath(options.browserExecutablePath);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meo-export-'));
  const tempHtmlPath = path.join(tempDir, 'render.html');

  let browser: any = null;
  try {
    await fs.writeFile(tempHtmlPath, options.htmlDocument, 'utf8');
    const puppeteer = await loadBundledPuppeteerRuntime(options.puppeteerRuntimeModulePath);

    browser = await puppeteer.launch({
      executablePath: browserExecutablePath,
      headless: true,
      args: [
        '--allow-file-access-from-files',
        '--disable-web-security',
        '--no-first-run',
        '--no-default-browser-check'
      ]
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(timeoutMs);
    page.setDefaultTimeout(timeoutMs);
    await page.emulateMediaType('screen');

    await page.goto(pathToFileURL(tempHtmlPath).toString(), {
      waitUntil: 'domcontentloaded'
    });

    if (runtimeOptions.exportTarget === 'pdf') {
      await page.evaluate(() => {
        document.documentElement.setAttribute('data-meo-export-target', 'pdf');
        document.body.setAttribute('data-meo-export-target', 'pdf');
      });
    } else {
      await page.evaluate(() => {
        document.documentElement.removeAttribute('data-meo-export-target');
        document.body.removeAttribute('data-meo-export-target');
      });
    }

    await page.waitForFunction(() => (window as any).__MEO_EXPORT_READY__ === true, {
      timeout: timeoutMs
    });
    await page.evaluate(async () => {
      const refitMath = (window as any).__MEO_EXPORT_REFIT_MATH__;
      if (typeof refitMath === 'function') {
        await refitMath();
      }
    });
    if (runtimeOptions.exportTarget === 'pdf') {
      await fitBlockMathForPdf(page);
    }

    return await action(page);
  } finally {
    if (browser) {
      await browser.close().catch(() => undefined);
    }
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function loadBundledPuppeteerRuntime(explicitRuntimePath?: string): Promise<any> {
  if (!puppeteerRuntimePromise) {
    const runtimePath = explicitRuntimePath || path.join(__dirname, 'puppeteer-runtime.js');
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
