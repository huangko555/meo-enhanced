import fs from 'node:fs';
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
    const page = await browser.newPage();
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
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return undefined; },
        setState() {}
      });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const text = Array.from({ length: 320 }, (_, index) => `reading line ${index + 1}`).join('\n');
    await page.evaluate((documentText) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init',
        documentId: 'file:///reading-position.md',
        text: documentText,
        version: 1,
        savedRevision: { version: 1, text: documentText },
        diagnostics: [],
        mode: 'live',
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
        restoreReadingPositionOnOpen: true,
        readingPositionRestore: { line: 140, lineOffset: 0 },
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right',
        outlineVisible: false,
        outlineWidth: 260,
        vscodeTheme: null
      }}));
    }, text);
    await page.waitForSelector('.editor-host > .cm-editor');
    await page.evaluate(waitForFrames, 10);

    const restoredLine = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      const top = scroller.getBoundingClientRect().top;
      const visible = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
        .find((line) => line.getBoundingClientRect().bottom > top + 1);
      return Number.parseInt(visible?.textContent?.match(/\d+/)?.[0] ?? '0', 10);
    });
    if (restoredLine < 137 || restoredLine > 143) {
      throw new Error(`Expected the remembered content near line 140, received ${restoredLine}`);
    }

    await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      scroller.scrollTop = scroller.scrollHeight * 0.78;
    });
    await new Promise((resolve) => setTimeout(resolve, 1_350));
    const savedPosition = await page.evaluate(() => (
      (window as typeof window & { __hostMessages: Array<any> }).__hostMessages
        .filter((message) => message.type === 'readingPositionChanged')
        .at(-1)?.position ?? null
    ));
    if (!savedPosition || savedPosition.line < 180) {
      throw new Error(`Idle scrolling did not report a semantic reading anchor: ${JSON.stringify(savedPosition)}`);
    }

    await page.click('[data-action="settings"]');
    const chineseLabel = await page.$eval(
      '[data-action="restoreReadingPosition"] .more-tools-option-label',
      (element) => element.textContent
    );
    if (chineseLabel !== '打开时恢复上一次阅读位置') {
      throw new Error(`Unexpected Chinese reading-position label: ${chineseLabel}`);
    }
    await page.click('[data-action="restoreReadingPosition"]');
    const settingMessage = await page.evaluate(() => (
      (window as typeof window & { __hostMessages: Array<any> }).__hostMessages
        .filter((message) => message.type === 'setRestoreReadingPositionOnOpen')
        .at(-1) ?? null
    ));
    if (JSON.stringify(settingMessage) !== JSON.stringify({
      type: 'setRestoreReadingPositionOnOpen',
      enabled: false
    })) throw new Error(`Setting toggle posted the wrong message: ${JSON.stringify(settingMessage)}`);

    await page.click('[data-ui-language="en"]');
    const englishLabel = await page.$eval(
      '[data-action="restoreReadingPosition"] .more-tools-option-label',
      (element) => element.textContent
    );
    if (englishLabel !== 'Resume from last position') {
      throw new Error(`Unexpected English reading-position label: ${englishLabel}`);
    }
    await page.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'restoreReadingPositionOnOpenChanged', enabled: true
    }})));
    const restoredSetting = await page.$eval(
      '[data-action="restoreReadingPosition"]',
      (button) => [button.classList.contains('is-active'), button.getAttribute('aria-checked')]
    );
    if (JSON.stringify(restoredSetting) !== JSON.stringify([true, 'true'])) {
      throw new Error(`Host setting update was not reflected: ${JSON.stringify(restoredSetting)}`);
    }
  } finally {
    await browser.close();
  }
}

try {
  await main();
  console.log('Reading position production checks passed');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
