import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { darkBuiltInVisuals } from '../src/shared/builtInVisualBaseline';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-ordered-list-sync-'));

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
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><body><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar"></div>
      <div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div>
    </div></body>`);
    await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.__hostText = '';
      window.__hostVersion = 1;
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          if (message.type !== 'applyChanges') return;
          let nextText = window.__hostText;
          for (const change of [...message.changes].reverse()) {
            nextText = nextText.slice(0, change.from) + change.insert + nextText.slice(change.to);
          }
          const nextVersion = ++window.__hostVersion;
          setTimeout(() => {
            window.__hostText = nextText;
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'applied', version: nextVersion } }));
            window.dispatchEvent(new MessageEvent('message', { data: { type: 'docChanged', text: nextText, version: nextVersion } }));
          }, 140);
        },
        getState() { return undefined; },
        setState() {}
      });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'webview.js') });
    await page.evaluate((theme) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///ordered.md', text: '', version: 1,
        savedRevision: { version: 1, text: '' }, diagnostics: [], mode: 'live',
        uiLanguage: 'en', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'dark', gitChangesGutter: false,
        gitDiffLineHighlights: false, diffBaselineMode: 'current-edit',
        fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        vscodeTheme: null
      }}));
    }, darkBuiltInVisuals);
    await page.waitForSelector('.editor-host > .cm-editor');
    await page.click('.cm-content');

    const items = ['alpha', 'beta', 'gamma', 'delta'];
    for (const [index, item] of items.entries()) {
      if (index === 0) {
        await page.keyboard.type(`1. ${item}`);
      } else {
        await page.keyboard.press('Enter');
        await page.keyboard.type(item);
      }
      const expectedText = await page.evaluate(() => (
        Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .map((line) => line.textContent ?? '')
          .join('\n')
      ));
      await page.waitForFunction(
        (text) => (window as any).__hostText === text,
        {},
        expectedText
      );
    }

    await page.waitForFunction(() => (window as any).__hostText.includes('4. delta'), { timeout: 4_000 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const result = await page.evaluate(() => ({
      hostText: (window as any).__hostText as string,
      editorText: Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).map((line) => line.textContent ?? '').join('\n'),
      noticeVisible: (() => {
        const notice = document.querySelector<HTMLElement>('.editor-notice');
        return Boolean(notice && !notice.hidden && notice.classList.contains('is-visible'));
      })()
    }));
    const expected = '1. alpha\n2. beta\n3. gamma\n4. delta';
    if (result.hostText !== expected || result.editorText !== expected || result.noticeVisible) {
      throw new Error(`Ordered-list sync lost progress or showed a failure notice: ${JSON.stringify(result)}`);
    }

    console.log('ordered-list host sync checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
