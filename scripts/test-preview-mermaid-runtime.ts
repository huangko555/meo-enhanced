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
  const build = await Bun.build({
    entrypoints: [path.join(import.meta.dir, 'test-preview-mermaid-runtime-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const runtime = fs.readFileSync(path.join(repoRoot, 'webview', 'dist', 'mermaid.min.js'), 'utf8');
  const runtimeSrc = `data:text/javascript;base64,${Buffer.from(runtime).toString('base64')}`;
  const page = await browser.newPage();
  await page.setContent('<!doctype html><body></body>');
  await page.evaluate((src) => {
    document.body.dataset.meoMermaidSrc = src;
    document.body.dataset.meoScriptNonce = 'preview-runtime-test';
  }, runtimeSrc);
  await page.addScriptTag({ path: path.join(tempDir, 'test-preview-mermaid-runtime-entry.js') });
  await page.evaluate(() => {
    const csp = document.createElement('meta');
    csp.httpEquiv = 'Content-Security-Policy';
    csp.content = "default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-preview-runtime-test'";
    document.head.append(csp);
  });

  const rendered = renderMarkdownToHtml({
    markdownText: '```mermaid\nflowchart LR\n  Start --> Check --> Done\n```',
    markdownFilePath: 'C:/tmp/preview-mermaid.md',
    target: 'html'
  });
  const styles = buildPreviewStyles(defaultThemeSettings, {}, 'light');
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
