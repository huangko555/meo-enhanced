import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { darkBuiltInVisuals } from '../src/shared/builtInVisualBaseline';

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
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><body><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar"></div>
      <div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div>
    </div></body>`);
    await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.evaluate(() => {
      (window as any).__visibleEditorHit = (content: HTMLElement | null) => {
        const scroller = content?.closest<HTMLElement>('.cm-scroller');
        if (!content || !scroller) return null;
        const contentRect = content.getBoundingClientRect(), viewport = scroller.getBoundingClientRect();
        const left = Math.max(Math.ceil(contentRect.left), Math.ceil(viewport.left), 0);
        const top = Math.max(Math.ceil(contentRect.top), Math.ceil(viewport.top), 0);
        const right = Math.min(Math.floor(contentRect.right), Math.floor(viewport.right), window.innerWidth);
        const bottom = Math.min(Math.floor(contentRect.bottom), Math.floor(viewport.bottom), window.innerHeight);
        if (left >= right || top >= bottom) return null;
        return document.elementFromPoint(left + Math.min(8, right - left - 1), top + Math.min(8, bottom - top - 1));
      };
    });
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
        type: 'init', documentId: 'file:///recovery.md', text: '1. alpha', version: 1,
        savedRevision: { version: 1, text: '1. alpha' }, diagnostics: [], mode: 'live',
        uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'dark', gitChangesGutter: false,
        gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
        fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        vscodeTheme: null
      }}));
    }, darkBuiltInVisuals);
    await page.waitForSelector('.editor-host > .cm-editor');
    await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('.editor-host');
      const loading = document.querySelector<HTMLElement>('.editor-loading');
      const content = document.querySelector<HTMLElement>('.cm-content');
      const hit = (window as any).__visibleEditorHit(content);
      (window as any).__inputAdmissionTrace = {
        startedAt: performance.now(), initial: {
          loadingHidden: loading?.hidden ?? null, hostInert: host?.inert ?? null,
          documentHasFocus: document.hasFocus(),
          activeElement: document.activeElement?.className ?? document.activeElement?.tagName ?? null,
          contentConnected: content?.isConnected ?? false,
          hitElement: hit instanceof HTMLElement ? `${hit.tagName}.${hit.className}` : hit?.nodeName ?? null,
          hitContent: Boolean(hit && content && (hit === content || content.contains(hit)))
        }
      };
    });
    await page.waitForFunction(() => {
      const host = document.querySelector<HTMLElement>('.editor-host');
      const loading = document.querySelector<HTMLElement>('.editor-loading');
      const content = document.querySelector<HTMLElement>('.cm-content');
      if (!host || !loading || !content || host.inert || !loading.hidden) return false;
      const hit = (window as any).__visibleEditorHit(content);
      return Boolean(hit && (hit === content || content.contains(hit)));
    });
    await page.evaluate(() => {
      const trace = (window as any).__inputAdmissionTrace;
      const host = document.querySelector<HTMLElement>('.editor-host');
      const loading = document.querySelector<HTMLElement>('.editor-loading');
      const content = document.querySelector<HTMLElement>('.cm-content');
      const hit = (window as any).__visibleEditorHit(content);
      trace.ready = {
        elapsedMs: Math.round(performance.now() - trace.startedAt),
        loadingHidden: loading?.hidden ?? null, hostInert: host?.inert ?? null,
        documentHasFocus: document.hasFocus(),
        activeElement: document.activeElement?.className ?? document.activeElement?.tagName ?? null,
        contentConnected: content?.isConnected ?? false,
        hitElement: hit instanceof HTMLElement ? `${hit.tagName}.${hit.className}` : hit?.nodeName ?? null,
        hitContent: Boolean(hit && content && (hit === content || content.contains(hit)))
      };
    });
    console.log('[input-admission:document-sync-recovery]', JSON.stringify(await page.evaluate(() => (window as any).__inputAdmissionTrace)));
    await page.click('.cm-line');
    await page.waitForFunction(() => {
      const content = document.querySelector<HTMLElement>('.cm-content');
      return Boolean(content && document.activeElement === content && content.closest('.cm-focused'));
    });
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('beta');

    await page.waitForFunction(() => (window as any).__hostMessages.some(
      (message: any) => message.type === 'draftChanged' && message.text === '1. alpha\n2. beta'
    ));

    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'externalFileStatusChanged',
        status: 'modified-while-dirty'
      }}));
    });
    await page.waitForSelector('.editor-notice-action[data-action="save-copy"]');
    await page.locator('.editor-notice-action[data-action="save-copy"]').click();
    await page.waitForFunction(() => (window as any).__hostMessages.some(
      (message: any) => message.type === 'saveDocumentCopy'
    ));
    const copyRequest = await page.evaluate(() => (window as any).__hostMessages.find(
      (message: any) => message.type === 'saveDocumentCopy'
    ));
    if (copyRequest.text !== '1. alpha\n2. beta') {
      throw new Error('Save Copy did not capture the unsaved editor draft');
    }
    await page.evaluate((requestId) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'documentCopyResult', requestId,
        result: { ok: true, value: { status: 'saved' } }
      }}));
    }, copyRequest.requestId);
    await page.waitForFunction(() => document.querySelector('.editor-notice')?.getAttribute('aria-busy') !== 'true');
    if (await page.$eval('.editor-notice', banner => (banner as HTMLElement).hidden)) {
      throw new Error('Saving a copy must not dismiss the unresolved external change');
    }
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'externalFileStatusChanged',
        status: 'current'
      }}));
    });
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'externalFileStatusChanged',
        status: 'unreadable-while-dirty'
      }}));
    });
    await page.waitForFunction(() => document.querySelector('.editor-notice-title')?.textContent === 'Could not verify disk version');
    if (!await page.$('.editor-notice-action[data-action="save-copy"]')) {
      throw new Error('Unreadable disk warning did not provide Save Copy');
    }
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'externalFileStatusChanged',
        status: 'current'
      }}));
    });
    await page.evaluate(() => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'docChanged',
        text: '1. alpha',
        version: 1
      }}));
    });
    await new Promise(resolve => setTimeout(resolve, 300));
    const textAfterStaleEcho = await page.evaluate(() => {
      const EditorView = (window as any).__EditorView;
      const editorElement = document.querySelector('.cm-editor');
      return EditorView.findFromDOM(editorElement).state.doc.toString();
    });
    if (textAfterStaleEcho !== '1. alpha\n2. beta') {
      throw new Error(
        `stale host echo discarded pending Live input: ${JSON.stringify(textAfterStaleEcho)}`
      );
    }

    await page.evaluate(() => {
      const EditorView = (window as any).__EditorView;
      const editorElement = document.querySelector('.cm-editor');
      const view = EditorView.findFromDOM(editorElement);
      const originalDispatch = view.dispatch.bind(view);
      (window as any).__restoreDispatch = () => { view.dispatch = originalDispatch; };
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

    await page.waitForSelector('.editor-notice-action[data-action="retry-document-update"]');
    await page.evaluate(() => (window as any).__restoreDispatch());
    await page.locator('.editor-notice-action[data-action="retry-document-update"]').click();
    await page.waitForFunction((expected) => {
      const editorElement = document.querySelector('.cm-editor');
      const view = (window as any).__EditorView.findFromDOM(editorElement);
      return view.state.doc.toString() === expected;
    }, { timeout: 2_000 }, expectedDraft);
    if (!await page.$eval('.editor-notice', banner => (banner as HTMLElement).hidden)) {
      throw new Error('successful document update retry did not clear the failure notice');
    }

    console.log('document sync recovery checks passed');
  } catch (error) {
    console.error('[input-admission:document-sync-recovery]', await page.evaluate(() => {
      const host = document.querySelector<HTMLElement>('.editor-host');
      const loading = document.querySelector<HTMLElement>('.editor-loading');
      const content = document.querySelector<HTMLElement>('.cm-content');
      const hit = (window as any).__visibleEditorHit(content);
      return {
        loadingHidden: loading?.hidden ?? null,
        hostInert: host?.inert ?? null,
        documentHasFocus: document.hasFocus(),
        activeElement: document.activeElement?.className ?? document.activeElement?.tagName ?? null,
        contentConnected: content?.isConnected ?? false,
        contentFocused: document.activeElement === content,
        hitElement: hit instanceof HTMLElement ? `${hit.tagName}.${hit.className}` : hit?.nodeName ?? null,
        admission: (window as any).__inputAdmissionTrace ?? null,
        messages: ((window as any).__hostMessages ?? []).slice(-8).map((message: any) => ({
          type: message.type,
          textLength: typeof message.text === 'string' ? message.text.length : undefined
        }))
      };
    }));
    throw error;
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
