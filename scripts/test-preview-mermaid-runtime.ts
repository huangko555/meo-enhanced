import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildPreviewStyles } from '../src/export/exportStyles';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-mermaid-runtime-'));
const browser = await launchTestBrowser();

try {
  const extensionSource = fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8');
  const runtimeScript = '<script nonce="${nonce}" src="${mermaidRuntimeUri}"></script>';
  const runtimeScriptIndex = extensionSource.indexOf(runtimeScript);
  const webviewEntryIndex = extensionSource.indexOf('<script type="module" nonce="${nonce}" src="${scriptUri}"></script>');
  if (runtimeScriptIndex < 0 || webviewEntryIndex < 0 || runtimeScriptIndex > webviewEntryIndex) {
    throw new Error('The Webview must preload Mermaid before its module entry');
  }

  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, 'test-preview-mermaid-runtime-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    external: ['mermaid']
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const runtime = fs.readFileSync(path.join(repoRoot, 'webview', 'dist', 'mermaid.min.js'), 'utf8');
  const entry = fs.readFileSync(path.join(tempDir, 'test-preview-mermaid-runtime-entry.js'), 'utf8');
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' data:; font-src data:; script-src 'nonce-preview-runtime-test'"></head><body></body>`);
  await page.evaluate(({ runtime, entry }) => {
    for (const source of [runtime, entry]) {
      const script = document.createElement('script');
      script.nonce = 'preview-runtime-test';
      script.textContent = source;
      document.head.appendChild(script);
    }
  }, { runtime, entry });
  const katexCss = fs.readFileSync(path.join(repoRoot, 'webview', 'dist', 'katex', 'katex-embedded.css'), 'utf8');
  await page.evaluate(async (css) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `data:text/css,${encodeURIComponent(css)}`;
    await new Promise<void>((resolve, reject) => {
      link.addEventListener('load', () => resolve(), { once: true });
      link.addEventListener('error', () => reject(new Error('Failed to load KaTeX test stylesheet')), { once: true });
      document.head.appendChild(link);
    });
    document.body.dataset.meoKatexSrc = link.href;
  }, katexCss);

  const markdownText = [
    '```mermaid',
    'flowchart LR',
    '  Start --> Check --> Done',
    '```',
    '',
    '```mermaid',
    '$$',
    '\\frac{a}{b}',
    '$$',
    '```',
    '',
    '独立公式：$E = mc^2$',
    '',
    '$$',
    '\\int_{-\\infty}^{\\infty} e^{-x^2}\\,dx = \\sqrt{\\pi}',
    '$$'
  ].join('\n');
  const rendered = renderMarkdownToHtml({
    markdownText,
    markdownFilePath: 'C:/tmp/preview-mermaid.md',
    target: 'html'
  });
  const styleEnvironment = {
    editorBackgroundColor: '#20252b',
    editorForegroundColor: '#d8dee9'
  };
  const lightStyles = buildPreviewStyles(defaultThemeSettings, styleEnvironment, 'light');
  const darkStyles = buildPreviewStyles(defaultThemeSettings, styleEnvironment, 'dark');
  const liveSvg = await page.evaluate(async () => {
    const renderLiveMermaid = (window as typeof window & { __renderLiveMermaid?: () => Promise<string> })
      .__renderLiveMermaid;
    return renderLiveMermaid?.() ?? '';
  });
  if (!liveSvg.includes('<svg')) {
    throw new Error('Live Mermaid must render before switching to Preview');
  }
  await page.evaluate(async () => {
    (window as typeof window & { __queueSlowLiveOperations?: (count: number, delayMs: number) => void })
      .__queueSlowLiveOperations?.(3, 300);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    (window as typeof window & { __previewRenderedAt?: number }).__previewRenderedAt = 0;
  });
  const previewStartedAt = await page.evaluate(() => performance.now());
  const previewRequestId = await page.evaluate((text) => {
    const controller = (window as typeof window & { __previewController?: any }).__previewController;
    controller.preload(text);
    const messages = (window as typeof window & { __previewMessages?: Array<{ type?: string; requestId?: string }> })
      .__previewMessages ?? [];
    return messages.findLast((message) => message.type === 'requestPreviewRender')?.requestId ?? '';
  }, markdownText);
  if (!previewRequestId) throw new Error('Live mode did not preload Preview');
  await page.evaluate(({ requestId, html, hasMermaid, lightStyles, darkStyles }) => {
    const controller = (window as typeof window & { __previewController?: any }).__previewController;
    controller.handleRendered({
      type: 'previewRendered',
      requestId,
      html,
      hasMermaid,
      styles: { light: lightStyles, dark: darkStyles }
    });
  }, { requestId: previewRequestId, html: rendered.html, hasMermaid: rendered.hasMermaid, lightStyles, darkStyles });

  await page.waitForFunction(
    (startedAt) => ((window as typeof window & { __previewRenderedAt?: number }).__previewRenderedAt ?? 0) > startedAt,
    { timeout: 250 },
    previewStartedAt
  );

  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    return Boolean(
      frameDocument?.querySelectorAll('.meo-export-mermaid.is-rendered svg').length === 2 &&
      frameDocument.querySelector('.meo-export-mermaid.is-math .katex')
    );
  }, { timeout: 5000 });
  await page.evaluate(() => {
    (window as typeof window & { __previewController?: any }).__previewController?.setVisible(true);
  });
  const previewMathFont = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const katex = frameDocument?.querySelector<HTMLElement>('.meo-export-mermaid.is-math .katex');
    return katex ? frameDocument?.defaultView?.getComputedStyle(katex).fontFamily ?? '' : '';
  });
  if (!previewMathFont.includes('KaTeX_Main')) {
    throw new Error(`Preview iframe did not receive KaTeX styles: ${previewMathFont}`);
  }
  const displayMathLayout = await page.evaluate(async () => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const formula = frameDocument?.querySelector<HTMLElement>('.meo-export-math-display');
    if (!formula) return null;
    await frameDocument?.fonts.load('19px KaTeX_Size2');
    const largeOperator = formula.querySelector<HTMLElement>('.op-symbol.large-op');
    const style = frameDocument.defaultView?.getComputedStyle(formula);
    const operatorStyle = largeOperator
      ? frameDocument.defaultView?.getComputedStyle(largeOperator)
      : null;
    return {
      overflowX: style?.overflowX ?? '',
      paddingTop: Number.parseFloat(style?.paddingTop ?? '0'),
      paddingBottom: Number.parseFloat(style?.paddingBottom ?? '0'),
      clientWidth: formula.clientWidth,
      scrollWidth: formula.scrollWidth,
      height: formula.getBoundingClientRect().height,
      fontsLoaded: frameDocument?.fonts.check('16px KaTeX_Size2') ?? false,
      operatorFont: operatorStyle?.fontFamily ?? '',
      operatorHeight: largeOperator?.getBoundingClientRect().height ?? 0
    };
  });
  if (
    !displayMathLayout ||
    !['hidden', 'clip'].includes(displayMathLayout.overflowX) ||
    displayMathLayout.paddingTop <= 0 ||
    displayMathLayout.paddingBottom <= 0 ||
    displayMathLayout.clientWidth <= 0 ||
    displayMathLayout.height > 120 ||
    !displayMathLayout.fontsLoaded ||
    !displayMathLayout.operatorFont.includes('KaTeX_Size2') ||
    displayMathLayout.operatorHeight <= 0
  ) {
    throw new Error(`Preview display math layout is unstable: ${JSON.stringify(displayMathLayout)}`);
  }
  const mermaidReadyAfterMs = await page.evaluate((startedAt) => performance.now() - startedAt, previewStartedAt);
  if (mermaidReadyAfterMs > 700) {
    throw new Error(`Preview Mermaid was blocked behind hidden Live renders for ${Math.round(mermaidReadyAfterMs)}ms`);
  }
  const { darkNodeFill, darkNodeText, darkPaletteFill, darkPaletteText } = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const node = frameDocument?.querySelector<SVGElement>('.meo-export-mermaid.is-rendered .node rect');
    const nodeLabel = frameDocument?.querySelector<HTMLElement>('.meo-export-mermaid.is-rendered .nodeLabel');
    const page = frameDocument?.querySelector<HTMLElement>('.meo-export-page');
    const fillProbe = frameDocument?.createElement('span');
    const textProbe = frameDocument?.createElement('span');
    if (page && fillProbe && textProbe) {
      fillProbe.style.color = 'var(--meo-mermaid-node-background)';
      textProbe.style.color = 'var(--meo-mermaid-foreground)';
      page.append(fillProbe, textProbe);
    }
    const normalizeColor = (value: string) => {
      const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\)$/i.exec(value);
      return srgb
        ? `rgb(${srgb.slice(1).map((channel) => Math.round(Number(channel) * 255)).join(', ')})`
        : value;
    };
    return {
      darkNodeFill: node ? frameDocument?.defaultView?.getComputedStyle(node).fill ?? '' : '',
      darkNodeText: nodeLabel ? frameDocument?.defaultView?.getComputedStyle(nodeLabel).color ?? '' : '',
      darkPaletteFill: fillProbe ? normalizeColor(frameDocument?.defaultView?.getComputedStyle(fillProbe).color ?? '') : '',
      darkPaletteText: textProbe ? frameDocument?.defaultView?.getComputedStyle(textProbe).color ?? '' : ''
    };
  });
  if (
    !darkNodeFill || !darkPaletteFill || darkNodeFill !== darkPaletteFill ||
    !darkNodeText || !darkPaletteText || darkNodeText !== darkPaletteText
  ) {
    throw new Error(`Dark Preview Mermaid palette mismatch: ${JSON.stringify({ darkNodeFill, darkNodeText, darkPaletteFill, darkPaletteText })}`);
  }
  const cachedSwitch = await page.evaluate((text) => {
    const controller = (window as typeof window & { __previewController?: any }).__previewController;
    const messages = (window as typeof window & { __previewMessages?: Array<{ type?: string }> }).__previewMessages ?? [];
    const before = messages.filter((message) => message.type === 'requestPreviewRender').length;
    controller.setVisible(true);
    controller.requestRender(text, { restoreLine: 1 });
    return {
      before,
      after: messages.filter((message) => message.type === 'requestPreviewRender').length,
      rendered: Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
        ?.querySelector('.meo-export-mermaid.is-rendered svg'))
    };
  }, markdownText);
  if (!cachedSwitch.rendered || cachedSwitch.after !== cachedSwitch.before) {
    throw new Error(`First Live-to-Preview switch did not use the prepared document: ${JSON.stringify(cachedSwitch)}`);
  }
  await page.evaluate(() => {
    (window as typeof window & { __previewController?: any }).__previewController.setAppearance('light');
  });
  await page.waitForFunction((darkFill) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const node = frameDocument?.querySelector<SVGElement>('.meo-export-mermaid.is-rendered .node rect');
    return Boolean(node && frameDocument?.defaultView?.getComputedStyle(node).fill !== darkFill);
  }, {}, darkNodeFill);
  const lightPalette = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const page = frameDocument?.querySelector<HTMLElement>('.meo-export-page');
    const readPaletteColor = (name: string) => {
      const probe = frameDocument?.createElement('span');
      if (!page || !probe) return '';
      probe.style.color = `var(${name})`;
      page.appendChild(probe);
      const value = frameDocument.defaultView?.getComputedStyle(probe).color ?? '';
      probe.remove();
      return value;
    };
    const node = frameDocument?.querySelector<SVGElement>('.meo-export-mermaid.is-rendered .node rect');
    const label = frameDocument?.querySelector<HTMLElement>('.meo-export-mermaid.is-rendered .nodeLabel');
    return {
      nodeFill: node ? frameDocument?.defaultView?.getComputedStyle(node).fill ?? '' : '',
      nodeText: label ? frameDocument?.defaultView?.getComputedStyle(label).color ?? '' : '',
      paletteFill: readPaletteColor('--meo-mermaid-node-background'),
      paletteText: readPaletteColor('--meo-mermaid-foreground')
    };
  });
  if (
    !lightPalette.nodeFill || lightPalette.nodeFill !== lightPalette.paletteFill ||
    !lightPalette.nodeText || lightPalette.nodeText !== lightPalette.paletteText
  ) {
    throw new Error(`Light Preview Mermaid palette mismatch: ${JSON.stringify(lightPalette)}`);
  }
  console.log('Preview Mermaid runtime test passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
