import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { darkBuiltInVisuals } from '../src/shared/builtInVisualBaseline';

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
  const syncedPage = await browser.newPage();
  try {
    const trailingLines = Array.from({ length: 1_499 }, (_, index) => `长文档行 ${index + 2}`);
    const initialText = ['普通正文', ...trailingLines].join('\n');
    await syncedPage.setContent(`<!doctype html><body><div id="app" class="editor-root">
      <div class="mode-toolbar meo-preload-toolbar"></div>
      <div class="editor-wrapper meo-preload-editor-shell"><div class="editor-host"></div></div>
    </div></body>`);
    await syncedPage.addStyleTag({ content: 'html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column}' });
    await syncedPage.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await syncedPage.evaluate(() => {
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
        type: 'init', documentId: 'file:///cursor.md', text, version: 1,
        savedRevision: { version: 1, text }, diagnostics: [], mode: 'live',
        uiLanguage: 'en', sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'dark', gitChangesGutter: false,
        gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit',
        fixedBaselinePinned: false, fixedBaselineActive: false, contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        vscodeTheme: null
      }}));
    }, { theme: darkBuiltInVisuals, text: initialText });
    await syncedPage.waitForSelector('.editor-host > .cm-editor');
    await syncedPage.evaluate(() => {
      const snapshot = () => {
        const host = document.querySelector<HTMLElement>('.editor-host');
        const loading = document.querySelector<HTMLElement>('.editor-loading');
        const content = document.querySelector<HTMLElement>('.cm-content');
        const hit = (window as any).__visibleEditorHit(content);
        return {
          loadingHidden: loading?.hidden ?? null, hostInert: host?.inert ?? null,
          documentHasFocus: document.hasFocus(),
          activeElement: document.activeElement?.className ?? document.activeElement?.tagName ?? null,
          contentConnected: content?.isConnected ?? false,
          hitElement: hit instanceof HTMLElement ? `${hit.tagName}.${hit.className}` : hit?.nodeName ?? null,
          hitContent: Boolean(hit && content && (hit === content || content.contains(hit)))
        };
      };
      (window as any).__inputAdmissionTrace = { initial: snapshot(), startedAt: performance.now() };
    });
    // Mounting the CodeMirror DOM is intentionally earlier than admitting native
    // input. Keep the first Enter cold, but prove it reaches the exposed editor
    // rather than the opaque startup cover.
    await syncedPage.waitForFunction(() => {
      const host = document.querySelector<HTMLElement>('.editor-host');
      const loading = document.querySelector<HTMLElement>('.editor-loading');
      const content = document.querySelector<HTMLElement>('.cm-content');
      if (!host || !loading || !content || host.inert || !loading.hidden) return false;
      const hit = (window as any).__visibleEditorHit(content);
      return Boolean(hit && (hit === content || content.contains(hit)));
    });
    await syncedPage.evaluate(() => {
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
    console.log('[input-admission:cursor-after-enter]', JSON.stringify(await syncedPage.evaluate(() => (window as any).__inputAdmissionTrace)));

    await syncedPage.click('.cm-line');
    await syncedPage.waitForFunction(() => {
      const content = document.querySelector<HTMLElement>('.cm-content');
      return Boolean(content && document.activeElement === content && content.closest('.cm-focused'));
    });
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
  } catch (error) {
    console.error('[input-admission:cursor-after-enter]', await syncedPage.evaluate(() => {
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
        applyCount: (window as any).__applyCount ?? null,
        admission: (window as any).__inputAdmissionTrace ?? null
      };
    }));
    throw error;
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
