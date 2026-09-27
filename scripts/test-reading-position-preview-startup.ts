import assert from 'node:assert/strict';
import fs from 'node:fs';
import exportRuntime from '../src/export/runtime';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-reading-position-'));

const waitForFrames = async (count = 6): Promise<void> => {
  await new Promise<void>((resolve) => {
    let remaining = count;
    const next = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  });
};

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-webview-viewport-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    for (const scenario of [
      { delay: 0, restore: true, cancel: false },
      { delay: 250, restore: true, cancel: false },
      { delay: 900, restore: true, cancel: false },
      { delay: 900, restore: true, cancel: true },
      { delay: 250, restore: false, cancel: false }
    ]) {
      const page = await browser.newPage();
      await page.exposeFunction('__renderPreview', async (message: any) => {
        if (message.type !== 'requestPreviewRender') return null;
        await new Promise(resolve => setTimeout(resolve, scenario.delay));
        return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true,
          value: exportRuntime.renderPreviewDocument({ markdownText: message.text,
            sourceDocumentPath: 'C:/reading-position.md', uiLanguage: message.uiLanguage, styleEnvironment: message.environment }) } };
      });
      await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
      await page.setContent(`<!doctype html><body><div id="app" class="editor-root">
        <div class="mode-toolbar meo-preload-toolbar" aria-hidden="true"></div>
        <div class="editor-wrapper meo-preload-editor-shell" aria-hidden="true">
          <div class="editor-host"></div>
        </div>
      </div></body>`);
      await page.addStyleTag({
        content: ':root{--vscode-editor-background:#fff;--vscode-editor-foreground:#24292f;--vscode-sideBar-background:#f6f8fa;--vscode-panel-border:#d0d7de;--vscode-toolbar-hoverBackground:#eaeef2}html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}'
      });
      await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
      await page.addScriptTag({ content: `
        window.__hostMessages = [];
        window.acquireVsCodeApi = () => ({
          postMessage(message) { window.__hostMessages.push(message); window.__renderPreview(message).then(response => { if(response)window.dispatchEvent(new MessageEvent('message', {data:response})); }); },
          getState() { return undefined; },
          setState() {}
        });
      ` });
      await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

      const text = Array.from({ length: 320 }, (_, index) => `reading line ${index + 1}`).join('\n\n');
      await page.evaluate(({ documentText, restore }) => {
        window.dispatchEvent(new MessageEvent('message', { data: {
          type: 'init',
          documentId: 'file:///reading-position.md',
          text: documentText,
          version: 1,
          savedRevision: { version: 1, text: documentText },
          diagnostics: [],
          mode: 'preview',
          uiLanguage: 'zh-CN',
          uiLanguagePreference: 'zh-CN',
          automaticUiLanguage: 'en',
          sourceLineNumbers: 'on',
          previewAppearance: 'light',
          previewFontFamily: '',
          previewSourceColoring: true,
          editorAppearance: 'light',
          editorFontSizeMode: 'auto',
          editorFontSize: 14,
          gitChangesGutter: false,
          gitDiffLineHighlights: false,
          gitDiffDetailsVisible: false,
          diffBaselineMode: 'current-edit',
          fixedBaselinePinned: false,
          fixedBaselineActive: false,
          fixedBaselineUpdatedAt: null,
          contentMaxWidthEnabled: false,
          tableStickyHeaderEnabled: true,
          restoreReadingPositionOnOpen: restore,
          readingPositionRestore: { line: 279, lineOffset: 0 },
          findOptions: { wholeWord: false, caseSensitive: false },
          outlinePosition: 'right',
          outlineVisible: false,
          outlineWidth: 260,
          vscodeTheme: null
        }}));
      }, { documentText: text, restore: scenario.restore });
      await page.waitForSelector('.editor-host > .cm-editor');
      if (scenario.cancel) {
        await page.waitForFunction(() => (window as any).__hostMessages.some((message: any) => message.type === 'requestPreviewRender'));
        // Trusted intent while the Host response is pending cancels startup restore.
        await page.click('button[data-mode="preview"]');
      }
      await page.evaluate(waitForFrames, 10);

      await page.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('main.meo-export-doc'));
      await new Promise(resolve => setTimeout(resolve, 1600));
      const restored = await page.evaluate(() => ({
        top: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop,
        targetTop: document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.querySelector('[data-source-line="279"]')!.getBoundingClientRect().top
      }));
      const expectedRestore = scenario.restore && !scenario.cancel;
      if (expectedRestore) {
        assert.ok(restored.top > 100, `Preview lost the remembered position: ${JSON.stringify({scenario, restored})}`);
        assert.ok(Math.abs(restored.targetTop) <= 2, `Remembered paragraph is not at the viewport top: ${JSON.stringify({scenario, restored})}`);
      } else {
        assert.ok(restored.top < 100, `Cancelled/disabled restore moved the viewport: ${JSON.stringify({scenario, restored})}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log('Preview startup remembered position checks passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
