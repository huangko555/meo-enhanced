import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildPreviewStyles } from '../src/export/exportStyles';
import { createPreviewMermaidRenderer } from '../webview/src/helpers/previewMermaid';
import {
  MermaidDiagramResourceUnavailableError,
  type MermaidDiagramRenderResources
} from '../webview/src/application/mermaidDiagramRenderResources';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-preview-mermaid-runtime-'));

let releaseFirstPreview!: () => void;
const firstPreviewGate = new Promise<void>((resolve) => { releaseFirstPreview = resolve; });
let previewResourceRequests = 0;
const previewResources = {
  acquireGroup: () => ({
    runExclusive: async () => {
      previewResourceRequests += 1;
      if (previewResourceRequests === 1) await firstPreviewGate;
    },
    end() {}
  })
} as MermaidDiagramRenderResources;
const previewRenderer = createPreviewMermaidRenderer(previewResources);
const emptyFrame = {
  defaultView: null,
  querySelectorAll: () => []
} as unknown as Document;
const previewRequests = [
  previewRenderer.render(emptyFrame, 'dark'),
  previewRenderer.render(emptyFrame, 'light'),
  previewRenderer.render(emptyFrame, 'dark')
];
await new Promise((resolve) => setTimeout(resolve, 0));
if (previewResourceRequests !== 1) {
  releaseFirstPreview();
  throw new Error(`Rapid Preview theme switches must coalesce to the latest render (requests=${previewResourceRequests})`);
}
releaseFirstPreview();
await Promise.all(previewRequests);
const rejectedPreviewRenderer = createPreviewMermaidRenderer({
  acquireGroup: () => ({
    runExclusive: () => Promise.reject(
      new MermaidDiagramResourceUnavailableError('Mermaid render queue capacity exceeded')
    ),
    end() {}
  })
} as MermaidDiagramRenderResources);
await rejectedPreviewRenderer.render(emptyFrame, 'dark');
const reportedPreviewErrors: unknown[] = [];
const failedPreviewRenderer = createPreviewMermaidRenderer({
  acquireGroup: () => ({
    runExclusive: () => Promise.reject(new Error('runtime failed')),
    end() {}
  })
} as MermaidDiagramRenderResources, (error) => reportedPreviewErrors.push(error));
await failedPreviewRenderer.render(emptyFrame, 'dark');
if (!(reportedPreviewErrors[0] instanceof Error)
  || reportedPreviewErrors[0].message !== 'runtime failed') {
  throw new Error('Unexpected Preview Mermaid failures must be reported');
}
const browser = await launchTestBrowser();

try {
  const extensionSource = fs.readFileSync(path.join(repoRoot, 'src', 'extension.ts'), 'utf8');
  if (!extensionSource.includes('data-meo-mermaid-src="${mermaidRuntimeUri}"')
    || !extensionSource.includes('data-meo-script-nonce="${nonce}"')
    || !extensionSource.includes('${preloadMermaid ? `<script nonce="${nonce}" src="${mermaidRuntimeUri}"></script>` : \'\'}')) {
    throw new Error('Mermaid must support on-demand loading and preserve preloading for existing diagrams');
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
  let runtimeRequests = 0;
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.url() !== 'https://meo-runtime.invalid/mermaid.min.js') return void request.continue();
    runtimeRequests += 1;
    void request.respond(runtimeRequests === 1
      ? {status: 503, body: 'Temporarily unavailable'}
      : {status: 200, contentType: 'text/javascript', body: runtime});
  });
  await page.setContent(`<!doctype html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' data:; font-src data:; script-src 'nonce-preview-runtime-test'"></head><body></body>`);
  await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
  await page.addStyleTag({ content: ':root { --meo-font-live: "Sarasa Term SC", "Cascadia Mono", Consolas, monospace; --meo-font-live-size: 15px; --meo-code-background: #20252b; --meo-foreground: #d8dee9; --meo-surface-background: #20252b; } .cm-line { white-space: pre; }' });
  await page.evaluate(entry => {
    document.body.dataset.meoMermaidSrc = 'https://meo-runtime.invalid/mermaid.min.js';
    document.body.dataset.meoScriptNonce = 'preview-runtime-test';
    const script = document.createElement('script');
    script.nonce = 'preview-runtime-test';
    script.textContent = entry;
    document.head.appendChild(script);
  }, entry);
  if (runtimeRequests !== 0) throw new Error('Creating the editor must not load an unused Mermaid runtime');
  const failedLoads = await page.evaluate(async () => {
    const load = (window as any).__loadMermaidRuntime;
    return (await Promise.allSettled([load(), load()])).map(result => result.status);
  });
  if (runtimeRequests !== 1 || failedLoads.some(status => status !== 'rejected')) {
    throw new Error('Concurrent failed loads must share one request and reject both callers');
  }
  const sharedRuntime = await page.evaluate(async () => {
    const load = (window as any).__loadMermaidRuntime;
    const [first, second] = await Promise.all([load(), load()]);
    return first === second && typeof first.render === 'function';
  });
  if (!sharedRuntime || runtimeRequests !== 2) throw new Error('Retry must load one CSP-authorized runtime shared by concurrent callers');
  const invalidMermaidLeaked = await page.evaluate(() => (
    (window as typeof window & { __probeInvalidMermaidCleanup?: () => Promise<boolean> })
      .__probeInvalidMermaidCleanup?.()
  ));
  if (invalidMermaidLeaked !== false) {
    throw new Error('Invalid Mermaid rendering leaked a syntax-error SVG into the document body');
  }
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
    previewFontFamily: '',
    editorBackgroundColor: '#20252b',
    editorForegroundColor: '#d8dee9'
  };
  const lightStyles = buildPreviewStyles(styleEnvironment, 'light');
  const darkStyles = buildPreviewStyles(styleEnvironment, 'dark');
  const liveSvg = await page.evaluate(async () => {
    const renderLiveMermaid = (window as typeof window & { __renderLiveMermaid?: () => Promise<string> })
      .__renderLiveMermaid;
    return renderLiveMermaid?.() ?? '';
  });
  if (!liveSvg.includes('<svg')) {
    throw new Error('Live Mermaid must render before switching to Preview');
  }
  await page.evaluate(() => {
    const renderEditorMermaid = (window as typeof window & { __renderEditorMermaid?: (source: string) => HTMLElement })
      .__renderEditorMermaid;
    renderEditorMermaid?.([
      'flowchart LR',
      '  A[列表项列表项列表项列表项列表项] --> B[Mermaid]',
      '  B --> C[保持缩进]'
    ].join('\n'));
  });
  await page.waitForSelector('.cm-editor .meo-mermaid-block .nodeLabel');
  const editorLongLabelLayout = await page.evaluate(() => {
    const label = Array.from(document.querySelectorAll<HTMLElement>('.cm-editor .nodeLabel'))
      .find((element) => element.textContent?.includes('列表项列表项'));
    const paragraph = label?.querySelector<HTMLElement>('p') ?? label;
    const range = label ? document.createRange() : null;
    if (label && range) range.selectNodeContents(label);
    const labelBox = range?.getBoundingClientRect();
    const clippingBox = label?.closest<SVGForeignObjectElement>('foreignObject')?.getBoundingClientRect();
    return labelBox && clippingBox
      ? {
          label: { left: labelBox.left, top: labelBox.top, right: labelBox.right, bottom: labelBox.bottom },
          clipping: { left: clippingBox.left, top: clippingBox.top, right: clippingBox.right, bottom: clippingBox.bottom },
          font: label ? getComputedStyle(label).font : '',
          clippingOverflow: label?.closest<SVGForeignObjectElement>('foreignObject')
            ? getComputedStyle(label.closest<SVGForeignObjectElement>('foreignObject')!).overflow
            : '',
          lineCount: range?.getClientRects().length ?? 0,
          whiteSpace: paragraph ? getComputedStyle(paragraph).whiteSpace : '',
          overflowWrap: paragraph ? getComputedStyle(paragraph).overflowWrap : '',
          wordBreak: paragraph ? getComputedStyle(paragraph).wordBreak : '',
          html: label?.innerHTML ?? ''
        }
      : null;
  });
  if (
    !editorLongLabelLayout ||
    !editorLongLabelLayout.font.includes('Sarasa Term SC') ||
    editorLongLabelLayout.clippingOverflow === 'visible' ||
    editorLongLabelLayout.lineCount < 2 ||
    editorLongLabelLayout.whiteSpace !== 'normal' ||
    editorLongLabelLayout.overflowWrap !== 'anywhere' ||
    editorLongLabelLayout.label.left < editorLongLabelLayout.clipping.left - 0.5 ||
    editorLongLabelLayout.label.top < editorLongLabelLayout.clipping.top - 0.5 ||
    editorLongLabelLayout.label.right > editorLongLabelLayout.clipping.right + 0.5 ||
    editorLongLabelLayout.label.bottom > editorLongLabelLayout.clipping.bottom + 0.5
  ) {
    throw new Error(`Editor Mermaid node label is clipped: ${JSON.stringify(editorLongLabelLayout)}`);
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
    controller.acceptRenderResponse({
      type: 'previewRenderResult',
      requestId,
      result: { ok: true, value: { html, hasMermaid, styles: { light: lightStyles, dark: darkStyles } } }
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
  const previewDragState = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const diagram = frameDocument?.querySelector<HTMLElement>('.meo-export-mermaid.is-rendered:not(.is-math)');
    const wrapper = diagram?.querySelector<HTMLElement>('.meo-export-mermaid-svg');
    if (!diagram || !wrapper) return null;
    diagram.dispatchEvent(new PointerEvent('pointerdown', {
      button: 0, pointerId: 71, clientX: 40, clientY: 40, bubbles: true, cancelable: true
    }));
    diagram.dispatchEvent(new PointerEvent('pointermove', {
      button: 0, pointerId: 71, clientX: 72, clientY: 64, bubbles: true, cancelable: true
    }));
    diagram.dispatchEvent(new PointerEvent('pointerup', {
      button: 0, pointerId: 71, clientX: 72, clientY: 64, bubbles: true, cancelable: true
    }));
    return {
      cursor: diagram.style.cursor,
      panFlag: diagram.dataset.mermaidPan ?? null,
      transform: wrapper.style.transform
    };
  });
  if (!previewDragState || previewDragState.cursor || previewDragState.panFlag || previewDragState.transform) {
    throw new Error(`Preview Mermaid must remain static on pointer drag: ${JSON.stringify(previewDragState)}`);
  }
  const previewMathFont = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const katex = frameDocument?.querySelector<HTMLElement>('.meo-export-mermaid.is-math .katex');
    return katex ? frameDocument?.defaultView?.getComputedStyle(katex).fontFamily ?? '' : '';
  });
  if (!previewMathFont.includes('KaTeX_Main')) {
    throw new Error(`Preview iframe did not receive KaTeX styles: ${previewMathFont}`);
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
  const stalePreview = await page.evaluate(({ oldText, html, lightStyles, darkStyles }) => {
    const controller = (window as typeof window & { __previewController?: any }).__previewController;
    const messages = (window as typeof window & {
      __previewMessages?: Array<{ type?: string; requestId?: string }>;
      __queueSlowLiveOperations?: (count: number, delayMs: number) => void;
    });
    const mermaidRequestsBefore = (messages as typeof messages & { __previewMermaidRequests?: number })
      .__previewMermaidRequests ?? 0;
    messages.__queueSlowLiveOperations?.(1, 400);
    controller.requestRender(oldText, { restoreLine: 1 });
    const requestId = messages.__previewMessages
      ?.findLast((message) => message.type === 'requestPreviewRender')?.requestId ?? '';
    controller.acceptRenderResponse({
      type: 'previewRenderResult',
      requestId,
      result: { ok: true, value: { html, hasMermaid: true, styles: { light: lightStyles, dark: darkStyles } } }
    });
    return { requestId, mermaidRequestsBefore };
  }, { oldText: `${markdownText}\n<!-- stale-mermaid-frame -->`, html: rendered.html, lightStyles, darkStyles });
  if (!stalePreview.requestId) throw new Error('Stale Mermaid frame request was not created');
  await page.waitForFunction((requestsBefore) => (
    (window as typeof window & { __previewMermaidRequests?: number }).__previewMermaidRequests ?? 0
  ) > requestsBefore, {}, stalePreview.mermaidRequestsBefore);
  const replacementText = 'replacement without Mermaid';
  const latestRequestId = await page.evaluate(({ text, lightStyles, darkStyles }) => {
    const controller = (window as typeof window & { __previewController?: any }).__previewController;
    const messages = (window as typeof window & { __previewMessages?: Array<{ type?: string; requestId?: string }> })
      .__previewMessages ?? [];
    controller.requestRender(text);
    const requestId = messages.findLast((message) => message.type === 'requestPreviewRender')?.requestId ?? '';
    controller.acceptRenderResponse({
      type: 'previewRenderResult',
      requestId,
      result: {
        ok: true,
        value: {
          html: `<div data-latest-preview data-source-line="1" data-source-end-line="120">${'<p>latest frame</p>'.repeat(120)}</div>`,
          hasMermaid: false,
          styles: { light: lightStyles, dark: darkStyles }
        }
      }
    });
    return requestId;
  }, { text: replacementText, lightStyles, darkStyles });
  if (!latestRequestId || latestRequestId === stalePreview.requestId) {
    throw new Error('Latest Preview request did not supersede the stale Mermaid frame');
  }
  await page.waitForFunction(() => Boolean(
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
      ?.querySelector('[data-latest-preview]')
  ));
  const latestScrollTop = await page.evaluate(async () => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    if (!frameDocument?.scrollingElement) return -1;
    frameDocument.scrollingElement.scrollTop = 300;
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    return frameDocument.scrollingElement.scrollTop;
  });
  if (Math.abs(latestScrollTop - 300) > 2) {
    throw new Error(`Stale Preview Mermaid completion changed the latest viewport: ${latestScrollTop}`);
  }
  const appearanceDuringLoad = await page.evaluate(({ text, html, lightStyles, darkStyles }) => {
    const controller = (window as typeof window & { __previewController?: any }).__previewController;
    const testWindow = window as typeof window & {
      __previewMessages?: Array<{ type?: string; requestId?: string }>;
      __previewMermaidRequests?: number;
    };
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const mermaidRequestsBefore = testWindow.__previewMermaidRequests ?? 0;
    frame.addEventListener('load', () => controller.setAppearance('dark'), { capture: true, once: true });
    controller.requestRender(text);
    const requestId = testWindow.__previewMessages
      ?.findLast((message) => message.type === 'requestPreviewRender')?.requestId ?? '';
    controller.acceptRenderResponse({
      type: 'previewRenderResult',
      requestId,
      result: { ok: true, value: { html, hasMermaid: true, styles: { light: lightStyles, dark: darkStyles } } }
    });
    return { requestId, mermaidRequestsBefore };
  }, {
    text: `${markdownText}\n<!-- appearance-during-load -->`,
    html: rendered.html,
    lightStyles,
    darkStyles
  });
  if (!appearanceDuringLoad.requestId) throw new Error('Appearance-during-load request was not created');
  await page.waitForFunction((requestsBefore) => (
    (window as typeof window & { __previewMermaidRequests?: number }).__previewMermaidRequests ?? 0
  ) > requestsBefore, { timeout: 2000 }, appearanceDuringLoad.mermaidRequestsBefore);
  await page.waitForFunction(() => Boolean(
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
      ?.querySelector('.meo-export-mermaid.is-rendered svg')
  ));
  const disposingPreview = await page.evaluate(({ text, html, lightStyles, darkStyles }) => {
    const controller = (window as typeof window & { __previewController?: any }).__previewController;
    const testWindow = window as typeof window & {
      __previewMessages?: Array<{ type?: string; requestId?: string }>;
      __previewMermaidRequests?: number;
      __queueSlowLiveOperations?: (count: number, delayMs: number) => void;
    };
    const mermaidRequestsBefore = testWindow.__previewMermaidRequests ?? 0;
    testWindow.__queueSlowLiveOperations?.(1, 400);
    controller.requestRender(text, { restoreLine: 1 });
    const requestId = testWindow.__previewMessages
      ?.findLast((message) => message.type === 'requestPreviewRender')?.requestId ?? '';
    controller.acceptRenderResponse({
      type: 'previewRenderResult',
      requestId,
      result: { ok: true, value: { html, hasMermaid: true, styles: { light: lightStyles, dark: darkStyles } } }
    });
    return { requestId, mermaidRequestsBefore };
  }, {
    text: `${markdownText}\n<!-- disposed-mermaid-frame -->`,
    html: rendered.html,
    lightStyles,
    darkStyles
  });
  if (!disposingPreview.requestId) throw new Error('Disposed Mermaid frame request was not created');
  await page.waitForFunction((requestsBefore) => (
    (window as typeof window & { __previewMermaidRequests?: number }).__previewMermaidRequests ?? 0
  ) > requestsBefore, {}, disposingPreview.mermaidRequestsBefore);
  const disposedViewport = await page.evaluate(async () => {
    const controller = (window as typeof window & { __previewController?: any }).__previewController;
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    if (!frameDocument?.scrollingElement) return -1;
    frameDocument.scrollingElement.scrollTop = 300;
    controller.dispose();
    const afterDispose = frameDocument.scrollingElement.scrollTop;
    await new Promise((resolve) => window.setTimeout(resolve, 900));
    return { afterDispose, afterCompletion: frameDocument.scrollingElement.scrollTop };
  });
  if (Math.abs(disposedViewport.afterCompletion - disposedViewport.afterDispose) > 2) {
    throw new Error(`Disposed Preview Mermaid completion changed the viewport: ${JSON.stringify(disposedViewport)}`);
  }
  console.log('Preview Mermaid runtime test passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
