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
  await page.setContent(`<!doctype html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-preview-runtime-test'"></head><body></body>`);
  await page.evaluate(({ runtime, entry }) => {
    for (const source of [runtime, entry]) {
      const script = document.createElement('script');
      script.nonce = 'preview-runtime-test';
      script.textContent = source;
      document.head.appendChild(script);
    }
  }, { runtime, entry });

  const rendered = renderMarkdownToHtml({
    markdownText: '```mermaid\nflowchart LR\n  Start --> Check --> Done\n```',
    markdownFilePath: 'C:/tmp/preview-mermaid.md',
    target: 'html'
  });
  const lightStyles = buildPreviewStyles(defaultThemeSettings, {}, 'light');
  const darkStyles = buildPreviewStyles(defaultThemeSettings, {}, 'dark');
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
  await page.evaluate(({ html, hasMermaid, lightStyles, darkStyles }) => {
    const controller = (window as typeof window & { __previewController?: any }).__previewController;
    controller.handleRendered({
      type: 'previewRendered',
      requestId: '',
      html,
      hasMermaid,
      styles: { light: lightStyles, dark: darkStyles }
    });
  }, { html: rendered.html, hasMermaid: rendered.hasMermaid, lightStyles, darkStyles });

  await page.waitForFunction(
    (startedAt) => ((window as typeof window & { __previewRenderedAt?: number }).__previewRenderedAt ?? 0) > startedAt,
    { timeout: 250 },
    previewStartedAt
  );

  await page.waitForFunction(() => Boolean(
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
      ?.querySelector('.meo-export-mermaid.is-rendered svg')
  ), { timeout: 5000 });
  const mermaidReadyAfterMs = await page.evaluate((startedAt) => performance.now() - startedAt, previewStartedAt);
  if (mermaidReadyAfterMs > 700) {
    throw new Error(`Preview Mermaid was blocked behind hidden Live renders for ${Math.round(mermaidReadyAfterMs)}ms`);
  }
  const { darkNodeFill, darkPanelFill } = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const node = frameDocument?.querySelector<SVGElement>('.meo-export-mermaid.is-rendered .node rect');
    const page = frameDocument?.querySelector<HTMLElement>('.meo-export-page');
    const probe = frameDocument?.createElement('span');
    if (page && probe) {
      probe.style.color = 'var(--meo-code-bg)';
      page.appendChild(probe);
    }
    return {
      darkNodeFill: node ? frameDocument?.defaultView?.getComputedStyle(node).fill ?? '' : '',
      darkPanelFill: probe ? frameDocument?.defaultView?.getComputedStyle(probe).color ?? '' : ''
    };
  });
  if (!darkNodeFill || !darkPanelFill || darkNodeFill !== darkPanelFill) {
    throw new Error(`Dark Preview Mermaid nodes must use ${darkPanelFill}, received ${darkNodeFill}`);
  }
  console.log('Preview Mermaid runtime test passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
