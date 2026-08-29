import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { defaultThemeSettings } from '../src/shared/themeDefaults';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-document-sync-recovery-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-document-sync-recovery-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'webview.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

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
      window.__hostMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return undefined; },
        setState() {}
      });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'webview.js') });
    await page.evaluate((theme) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', text: '1. alpha', version: 1, diagnostics: [], mode: 'live',
        previewAppearance: 'dark', lineNumbers: true, gitChangesGutter: false,
        gitBlameEnabled: false, gitDiffLineHighlights: false, diffBaselineMode: 'current-edit',
        fixedBaselinePinned: false, fixedBaselineActive: false, spellCheckEnabled: false,
        contentMaxWidthEnabled: false, longCodeBlockFoldingEnabled: true,
        vimMode: false, vimKeybindings: [], vimLeader: '\\',
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        theme, shikiCodeBlocks: false, codeTheme: null
      }}));
    }, defaultThemeSettings);
    await page.waitForSelector('.editor-host > .cm-editor');
    await page.click('.cm-line');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('beta');

    await page.waitForFunction(() => (window as any).__hostMessages.some(
      (message: any) => message.type === 'draftChanged' && message.text === '1. alpha\n2. beta'
    ));

    // A stale document snapshot identical to the base the draft was built on
    // (e.g. the panel-activation freshness echo) must not discard keystrokes
    // made inside the publish debounce window.
    await page.evaluate(() => {
      const EditorView = (window as any).__EditorView;
      const editorElement = document.querySelector('.cm-editor');
      const view = EditorView.findFromDOM(editorElement);
      view.dispatch = function (...args: any[]) {
        void args;
        throw new Error('forced ordered-list render failure');
      };
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'docChanged',
        text: '1. alpha',
        version: 1
      }}));
    });

    await page.waitForFunction(() => {
      const EditorView = (window as any).__EditorView;
      const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
      return view.state.doc.toString() === '1. alpha\n2. beta';
    }, { timeout: 2_000 });

    // Give any erroneous reverted flush time to surface before asserting.
    await new Promise(resolve => setTimeout(resolve, 300));
    const staleEchoFinal = await page.evaluate(() => {
      const EditorView = (window as any).__EditorView;
      const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
      return view.state.doc.toString();
    });
    if (staleEchoFinal !== '1. alpha\n2. beta') {
      throw new Error(`stale echo snapshot discarded the pending draft: ${JSON.stringify(staleEchoFinal)}`);
    }

    await page.evaluate(() => {
      const EditorView = (window as any).__EditorView;
      const editorElement = document.querySelector('.cm-editor');
      const view = EditorView.findFromDOM(editorElement);
      view.dispatch = function (...args: any[]) {
        void args;
        throw new Error('forced ordered-list render failure');
      };
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'docChanged',
        text: 'remote\n1. alpha',
        version: 2
      }}));
    });

    const expectedDraft = 'remote\n1. alpha\n2. beta';
    await page.waitForFunction((expected) => (window as any).__hostMessages.some(
      (message: any) => message.type === 'draftChanged' && message.text === expected
    ), { timeout: 2_000 }, expectedDraft);

    console.log('document sync recovery checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
