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
  const styles = buildPreviewStyles(defaultThemeSettings, {}, 'light');
  const liveSvg = await page.evaluate(async () => {
    const renderLiveMermaid = (window as typeof window & { __renderLiveMermaid?: () => Promise<string> })
      .__renderLiveMermaid;
    return renderLiveMermaid?.() ?? '';
  });
  if (!liveSvg.includes('<svg')) {
    throw new Error('Live Mermaid must render before switching to Preview');
  }
  await page.evaluate(({ html, hasMermaid, styles }) => {
    const controller = (window as typeof window & { __previewController?: any }).__previewController;
    controller.handleRendered({
      type: 'previewRendered',
      requestId: '',
      html,
      hasMermaid,
      styles: { light: styles, dark: styles }
    });
  }, { html: rendered.html, hasMermaid: rendered.hasMermaid, styles });

  await page.waitForFunction(() => Boolean(
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument
      ?.querySelector('.meo-export-mermaid.is-rendered svg')
  ), { timeout: 5000 });
  console.log('Preview Mermaid runtime test passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
