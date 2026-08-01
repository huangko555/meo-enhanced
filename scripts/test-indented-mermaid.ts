import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-indented-mermaid-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 720, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#24292f;--meo-code-background:#f6f8fa;--meo-surface-background:#fff;--meo-color-base05:#0969da;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:500;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      (window as any).__renderedMermaidSource = null;
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, source: string) {
          (window as any).__renderedMermaidSource = source;
          return { svg: '<svg viewBox="0 0 120 60"><text x="4" y="20">nested</text></svg>' };
        }
      };
      const fence = String.fromCharCode(96).repeat(3);
      const text = [
        '## 5. 嵌套结构',
        '',
        '- 发布准备',
        '',
        '  - 流程概览',
        '',
        `    ${fence}mermaid`,
        '    flowchart LR',
        '      Draft[编写内容] --> Review[审阅改动]',
        '      Review --> Preview[检查预览]',
        '      Preview --> Publish[发布文档]',
        `    ${fence}`
      ].join('\n');
      (window as any).__indentedMermaidEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });

    await page.evaluate(async () => {
      for (let index = 0; index < 12; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const state = await page.evaluate(() => ({
      previewCount: document.querySelectorAll('.meo-mermaid-block').length,
      toolbarCount: document.querySelectorAll('.meo-mermaid-toolbar').length,
      source: (window as any).__renderedMermaidSource,
      visibleSource: Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .some((line) => line.textContent?.includes('flowchart LR'))
    }));
    if (
      state.previewCount !== 1 ||
      state.toolbarCount !== 1 ||
      state.visibleSource ||
      state.source !== [
        'flowchart LR',
        '  Draft[编写内容] --> Review[审阅改动]',
        '  Review --> Preview[检查预览]',
        '  Preview --> Publish[发布文档]'
      ].join('\n')
    ) {
      throw new Error(`Indented Mermaid did not use the normal render path: ${JSON.stringify(state)}`);
    }

    console.log('Indented Mermaid checks passed');
  } finally {
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
