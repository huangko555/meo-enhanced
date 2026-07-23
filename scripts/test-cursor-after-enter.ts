import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-cursor-after-enter-'));

async function main(): Promise<void> {
  const webviewBuild = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-ime-composition-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'webview.js'
  });
  if (!webviewBuild.success) throw new Error(webviewBuild.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const trailingLines = Array.from({ length: 1_499 }, (_, index) => `长文档行 ${index + 2}`);
    const initialText = ['普通正文', ...trailingLines].join('\n');
    const syncedPage = await browser.newPage();
    await syncedPage.setContent(`<!doctype html><body><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar"></div>
      <div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div>
    </div></body>`);
    await syncedPage.addStyleTag({ content: 'html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column}' });
    await syncedPage.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await syncedPage.addScriptTag({ content: `
      window.__hostText = ${JSON.stringify(initialText)};
      window.__hostVersion = 1;
      window.__applyCount = 0;
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          if (message.type !== 'applyChanges') return;
          let nextText = window.__hostText;
          for (const change of [...message.changes].reverse()) {
            nextText = nextText.slice(0, change.from) + change.insert + nextText.slice(change.to);
          }
          const nextVersion = ++window.__hostVersion;
          window.__applyCount += 1;
          setTimeout(() => {
            window.__hostText = nextText;
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'applied', version: nextVersion } }));
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'docChanged', text: nextText, version: nextVersion } }));
          }, 20);
        },
        getState() { return undefined; },
        setState() {}
      });
    ` });
    await syncedPage.addScriptTag({ path: path.join(tempDir, 'webview.js') });
    await syncedPage.evaluate(({ theme, text }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', text, version: 1, diagnostics: [], mode: 'live',
        previewAppearance: 'dark', lineNumbers: true, gitChangesGutter: false,
        gitBlameEnabled: false, gitDiffLineHighlights: false, diffBaselineMode: 'current-edit',
        fixedBaselineActive: false, spellCheckEnabled: false, contentMaxWidthEnabled: false,
        vimMode: false, vimKeybindings: [], vimLeader: '\\',
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        theme, shikiCodeBlocks: false, codeTheme: null
      }}));
    }, { theme: defaultThemeSettings, text: initialText });
    await syncedPage.waitForSelector('.editor-host > .cm-editor');

    await syncedPage.click('.cm-line');
    await syncedPage.keyboard.press('End');
    let editablePrefix = '普通正文';
    for (let iteration = 0; iteration < 5; iteration += 1) {
      const previousApplyCount = await syncedPage.evaluate(() => (window as any).__applyCount as number);
      await syncedPage.keyboard.press('Enter');
      await syncedPage.waitForFunction(
        (count) => (window as any).__applyCount > count,
        { timeout: 2_000 },
        previousApplyCount
      );
      await syncedPage.keyboard.type('1234567890');
      editablePrefix += '\n1234567890';
      const syncedExpected = [editablePrefix, ...trailingLines].join('\n');
      await new Promise((resolve) => setTimeout(resolve, 350));
      const syncedState = await syncedPage.evaluate(() => {
        const selection = document.getSelection();
        return {
          hostText: (window as any).__hostText,
          anchorText: selection?.anchorNode?.textContent ?? null,
          anchorOffset: selection?.anchorOffset ?? null,
          scrollTop: document.querySelector<HTMLElement>('.cm-scroller')?.scrollTop ?? null
        };
      });
      if (
        syncedState.hostText !== syncedExpected
        || syncedState.anchorText !== '1234567890'
        || syncedState.anchorOffset !== 10
        || syncedState.scrollTop === null
        || syncedState.scrollTop > 5_000
      ) {
        throw new Error(`Cursor moved during overlapped host sync: ${JSON.stringify({ iteration, expected: syncedExpected, ...syncedState })}`);
      }
    }
    console.log('cursor-after-enter stress checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
