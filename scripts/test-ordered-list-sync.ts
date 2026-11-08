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
      window.__hostText = '';
      window.__hostVersion = 1;
      window.__orderedHostTrace = [];
      window.__orderedHostSequence = 0;
      window.__orderedSummary = text => ({ length: text.length, lines: text.split('\\n').length, tail: text.split('\\n').at(-1) });
      window.acquireVsCodeApi = () => ({
        postMessage(message) {
          if (message.type !== 'applyChanges') return;
          const sequence = ++window.__orderedHostSequence;
          const receivedVersion = window.__hostVersion;
          let nextText = window.__hostText;
          for (const change of [...message.changes].reverse()) {
            nextText = nextText.slice(0, change.from) + change.insert + nextText.slice(change.to);
          }
          const nextVersion = ++window.__hostVersion;
          window.__orderedHostTrace.push({
            sequence, phase: 'received', baseVersion: message.baseVersion ?? null,
            currentVersion: receivedVersion, scheduledVersion: nextVersion,
            next: window.__orderedSummary(nextText)
          });
          setTimeout(() => {
            const beforeText = window.__hostText;
            const beforeVersion = window.__hostVersion;
            window.__hostText = nextText;
            window.__orderedHostTrace.push({
              sequence, phase: 'callback-write', baseVersion: message.baseVersion ?? null,
              currentVersion: beforeVersion, scheduledVersion: nextVersion,
              before: window.__orderedSummary(beforeText), after: window.__orderedSummary(nextText)
            });
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
    console.log('[input-admission:ordered-list-sync]', JSON.stringify(await page.evaluate(() => (window as any).__inputAdmissionTrace)));
    await page.click('.cm-content');
    await page.waitForFunction(() => {
      const content = document.querySelector<HTMLElement>('.cm-content');
      return Boolean(content && document.activeElement === content && content.closest('.cm-focused'));
    });

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
        { timeout: 2_000 },
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
    console.log('[ordered-list-sync-trace]', JSON.stringify(await page.evaluate(() => ({
      trace: (window as any).__orderedHostTrace,
      currentVersion: (window as any).__hostVersion,
      hostText: (window as any).__orderedSummary((window as any).__hostText)
    }))));

    console.log('ordered-list host sync checks passed');
  } catch (error) {
    console.error('[ordered-list-sync-trace]', await page.evaluate(() => ({
      trace: ((window as any).__orderedHostTrace ?? []).slice(-20),
      hostText: (window as any).__orderedSummary?.((window as any).__hostText),
      editorText: (window as any).__orderedSummary?.(Array.from(document.querySelectorAll<HTMLElement>('.cm-line')).map((line) => line.textContent ?? '').join('\\n')),
      loadingHidden: document.querySelector<HTMLElement>('.editor-loading')?.hidden ?? null,
      hostInert: document.querySelector<HTMLElement>('.editor-host')?.inert ?? null,
      activeElement: document.activeElement?.className ?? document.activeElement?.tagName ?? null,
      admission: (window as any).__inputAdmissionTrace ?? null
    })));
    throw error;
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
