import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mock } from 'bun:test';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const vscodeWindow: { activeTextEditor: any; visibleTextEditors: any[] } = {
  activeTextEditor: undefined, visibleTextEditors: []
};
mock.module('vscode', () => ({ EndOfLine: { LF: 1, CRLF: 2 }, window: vscodeWindow }));
const { createVscodeViewNavigationAdapter } = await import('../src/host/vscodeViewNavigationAdapter');
const uri = { scheme: 'file', fsPath: 'C:/tmp/tab-reading.md', fragment: '', toString: () => 'file:///tab-reading.md' };
const text = Array.from({ length: 180 }, (_, index) => `Paragraph ${index + 1}: reading position witness.\n`).join('\n');
const hostDocument = { uri, offsetAt: (position: number) => position };
const nativeEditor = { document: hostDocument, selection: { start: 0, end: 0 } };
const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const css = await readFile('webview/src/styles.css', 'utf8');
type ReadingView = 'live' | 'source' | 'preview' | 'linked' | 'independent';
type NativeView = 'first-selection' | 'initial-selection' | 'other-document';
const cases: Array<{ view: ReadingView; native: NativeView; outlineVisible: boolean; preset: string }> = [];
const nativeViews: NativeView[] = ['first-selection', 'initial-selection', 'other-document'];
for (const view of ['live', 'source', 'preview', 'linked', 'independent'] as const) {
  for (const native of nativeViews) cases.push({ view, native, outlineVisible: false, preset: 'default' });
}
for (const preset of ['default', 'github-readme', 'whitey', 'obsidian-minimal', 'newsprint']) {
  for (const view of ['preview', 'linked', 'independent'] as const) {
    for (const native of preset === 'default' ? nativeViews : ['other-document'] as const) {
      cases.push({ view, native, outlineVisible: true, preset });
    }
  }
}
const browser = await launchTestBrowser();
let primaryError: unknown;
const captureSurfaces = () => {
  const surfaces: Array<{ owner: string; top: number; witness: string; offset: number }> = [];
  const capture = (owner: string, scroller: Element, candidates: Element[], viewportTop: number, viewportBottom: number) => {
    const witness = candidates.find(element => {
      const rect = element.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > viewportTop + 2 && rect.top < viewportBottom;
    });
    if (!witness) throw new Error(`${owner} has no visible content`);
    surfaces.push({ owner, top: scroller.scrollTop, witness: witness.textContent!, offset: witness.getBoundingClientRect().top - viewportTop });
  };
  if (document.querySelector<HTMLElement>('#app')!.dataset.mode !== 'preview') {
    const scroller = document.querySelector('.editor-host .cm-scroller')!;
    const rect = scroller.getBoundingClientRect();
    capture('editor', scroller, [...scroller.querySelectorAll('.cm-line')].filter(element => element.textContent?.includes('Paragraph')), rect.top, rect.bottom);
  }
  const preview = document.querySelector<HTMLIFrameElement>('.preview-frame');
  if (preview && !document.querySelector<HTMLElement>('.preview-host')!.hidden) {
    const previewDocument = preview.contentDocument!;
    capture('preview', previewDocument.scrollingElement!, [...previewDocument.querySelectorAll('p')], 0, previewDocument.documentElement.clientHeight);
  }
  return surfaces;
};
try {
  for (const { view, native, outlineVisible, preset } of cases) {
      const initialNative = native === 'initial-selection';
      const label = `${view}: ${native}${outlineVisible ? `, retained with outline (${preset})` : ''}`;
      const page = await browser.newPage();
      let adapter: ReturnType<typeof createVscodeViewNavigationAdapter> | undefined;
      let hidden = false;
      let delayNextVisibility = false;
      let releaseDelayedVisibility: (() => void) | null = null;
      let visibilityHeld!: () => void;
      const heldVisibility = new Promise<void>(resolve => { visibilityHeld = resolve; });
      const visibilityResult = (requestId: string) => {
        const response = { type: 'webviewVisibilityResult', requestId, visible: !hidden };
        if (!delayNextVisibility) return response;
        delayNextVisibility = false;
        return new Promise(resolve => {
          releaseDelayedVisibility = () => resolve(response);
          visibilityHeld();
        });
      };
      try {
        await page.setViewport({ width: 1200, height: 800 });
        // The native clipping container can yield conservative visibility false
        // negatives. Opacity below 1 guarantees that branch in newer browsers too.
        await page.setContent('<!doctype html><style>html,body,#overlay{height:100%;margin:0}#overlay{clip-path:content-box;opacity:.99}#meo{width:100%;height:100%;border:0}#native{display:none;position:fixed;top:0;left:0}</style><input id="native"><div id="overlay"><iframe id="meo"></iframe></div>');
        const frame = await (await page.$('#meo'))!.contentFrame();
        assert.ok(frame);
        page.setDefaultTimeout(5000);
        await frame.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
        await frame.addStyleTag({ content: css });
        let readingObservationHeld!: () => void;
        const heldReadingObservation = new Promise<void>(resolve => { readingObservationHeld = resolve; });
        await page.exposeFunction('__readingObservationHeld', () => readingObservationHeld());
        await frame.addScriptTag({ content: `{
          const OriginalObserver = window.IntersectionObserver;
          window.IntersectionObserver = class extends OriginalObserver {
            constructor(callback, options) {
              super((entries, observer) => {
                if (options?.trackVisibility && window.__holdNextReadingObservation) {
                  window.__holdNextReadingObservation = false;
                  window.__releaseReadingObservation = () => callback(entries, observer);
                  window.parent.__readingObservationHeld();
                } else callback(entries, observer);
              }, options);
            }
          };
        }` });
        await page.exposeFunction('__renderTabPreview', (message: any) => message.type === 'requestWebviewVisibility'
          ? visibilityResult(message.requestId) : message.type === 'requestPreviewRender' ? {
          type: 'previewRenderResult', requestId: message.requestId,
          result: { ok: true, value: exportRuntime.renderPreviewDocument({ markdownText: message.text, sourceDocumentPath: uri.fsPath, uiLanguage: message.uiLanguage, styleEnvironment: message.environment }) }
        } : null);
        await frame.addScriptTag({ content: 'window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.parent.__renderTabPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent("message",{data:response}));});}});' });
        await frame.addScriptTag({ content: `window.__captureTabSurfaces = ${captureSurfaces.toString()};` });
        await frame.addScriptTag({ content: bundle });
        await frame.evaluate(({ text, outlineVisible, preset }) => window.dispatchEvent(new MessageEvent('message', {
          data: {
            type: 'init', documentId: 'file:///tab-reading.md', text, version: 1, savedRevision: { version: 1, text }, diagnostics: [], mode: 'live', uiLanguage: 'en',
            sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true, editorAppearance: 'light', editorFontSizeMode: 'auto', editorFontSize: 14,
            gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false, diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
            contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false }, outlinePosition: 'right', outlineVisible, outlineWidth: outlineVisible ? 340 : 260, previewPreset: preset, restoreReadingPositionOnOpen: false, vscodeTheme: null
          }
        })), { text, outlineVisible, preset });
        await frame.waitForSelector('.cm-editor.meo-mode-live');
        await frame.waitForFunction(() => !document.querySelector('.editor-wrapper')?.classList.contains('meo-preload-editor-shell'));
        assert.equal(await frame.$eval('.preview-preset-control select', element => (element as HTMLSelectElement).value), preset, `${label}: selected preset`);
        vscodeWindow.activeTextEditor = initialNative ? nativeEditor : undefined;
        vscodeWindow.visibleTextEditors = [];
        nativeEditor.selection = { start: 0, end: 0 };
        // Replay Host output that arrives only after the retained Webview returns.
        const queued: unknown[] = [];
        adapter = createVscodeViewNavigationAdapter({
          document: hostDocument as never, documentUri: uri as never, getDocumentFragmentHref: () => null, resolveLocalLinkTarget: async () => null,
          post: async message => { if (hidden) queued.push(message); else await frame.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), message); return true; }
        });
        await adapter.ready();
        if (view !== 'live') {
          const mode = view === 'preview' ? 'preview' : 'source';
          await frame.click(`[data-mode="${mode}"]`);
          await frame.waitForFunction(mode => document.querySelector<HTMLElement>('#app')?.dataset.mode === mode, {}, mode);
        }
        if (view === 'linked' || view === 'independent') {
          await frame.click('.source-preview-button');
          await frame.waitForFunction(() => document.querySelector('.editor-surface')?.hasAttribute('data-source-preview'));
          if (view === 'independent') await frame.click('.source-preview-scroll-sync-button');
        }
        if (view === 'preview' || view === 'linked' || view === 'independent') {
          await frame.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('p'));
        }
        await new Promise(resolve => setTimeout(resolve, 150));
        if (view === 'preview') {
          await frame.evaluate(() => {
            const previewDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
            previewDocument.scrollingElement!.scrollTop = 1100;
          });
        } else {
          await frame.focus('.cm-content');
          const bounds = await frame.$eval('.cm-scroller', element => { const rect = element.getBoundingClientRect(); return { x: rect.x + 200, y: rect.y + 150 }; });
          await page.mouse.move(bounds.x, bounds.y);
          await page.mouse.wheel({ deltaY: 1100 });
        }
        if (view === 'independent') await frame.evaluate(() => {
          document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop = 650;
        });
        await new Promise(resolve => setTimeout(resolve, 250));
        const before = await frame.evaluate(captureSurfaces);
        assert.ok(before.every(surface => surface.top > 500), `${label}: fixture must scroll: ${JSON.stringify(before)}`);
        const parkedReturns = [
          { nativeOffset: 0, width: 300, height: 150, parkBeforeBlur: false },
          { nativeOffset: 180, width: 320, height: 180, parkBeforeBlur: true },
          { nativeOffset: 0, width: 260, height: 130, parkBeforeBlur: true },
          { nativeOffset: 180, width: 300, height: 150, parkBeforeBlur: true }
        ];
        const tabReturns = outlineVisible
          ? ['offscreen', 'visibility'].flatMap(parking => parkedReturns.map(entry => ({ ...entry, parking })))
          : [
            { nativeOffset: 0, parkBeforeBlur: false, parking: 'display' },
            { nativeOffset: 180, parkBeforeBlur: false, parking: 'display' },
            { nativeOffset: 0, parkBeforeBlur: true, parking: 'visibility', width: 300, height: 150 }
          ];
        for (const { nativeOffset, parkBeforeBlur, parking, ...parkedSize } of tabReturns) {
          nativeEditor.selection = { start: nativeOffset, end: nativeOffset };
          hidden = true;
          await page.evaluate(() => { document.getElementById('native')!.style.display = 'block'; });
          if (!parkBeforeBlur) await page.focus('#native');
          await page.evaluate(({ parking, width, height }) => {
            const retained = document.getElementById('meo')!;
            // VS Code can retain the Webview with visibility:hidden while its
            // rectangle still intersects the viewport. Moving it offscreen
            // alone misses the outline collapsing Preview in that hidden frame.
            if (parking !== 'display') {
              Object.assign(retained.style, {
                position: 'absolute', left: parking === 'offscreen' ? '-10000px' : '0px',
                visibility: parking === 'visibility' ? 'hidden' : '',
                width: `${width}px`, height: `${height}px`
              });
              // Mouse tab switches can lay out the parked frame before blur.
              // Force that layout rather than letting the later focus hide it.
              const preview = (retained as HTMLIFrameElement).contentDocument!
                .querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
              void preview.documentElement.clientWidth;
            }
            else retained.style.display = 'none';
          }, { parking, ...parkedSize } as { parking: string; width?: number; height?: number });
          if (parkBeforeBlur) await page.focus('#native');
          const switchedEditor = native === 'other-document'
            ? { ...nativeEditor, document: { ...hostDocument, uri: { ...uri, toString: () => 'file:///other.md' } } }
            : nativeEditor;
          vscodeWindow.activeTextEditor = switchedEditor;
          vscodeWindow.visibleTextEditors = [switchedEditor];
          await adapter.revealSelectionForEditor(switchedEditor as never);
          await adapter.revealCurrentEditorSelection();
          await new Promise(resolve => setTimeout(resolve, 100));
          await page.evaluate(() => {
            document.getElementById('native')!.style.display = 'none';
            Object.assign(document.getElementById('meo')!.style, { display: '', position: '', left: '', visibility: '', width: '', height: '' });
          });
          vscodeWindow.activeTextEditor = undefined;
          vscodeWindow.visibleTextEditors = [];
          await page.focus('#meo');
          hidden = false;
          await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'webviewVisibilityChanged', visible: true } })));
          for (const data of queued.splice(0)) await frame.evaluate(data => window.dispatchEvent(new MessageEvent('message', { data })), data);
          await adapter.flush();
          await frame.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: { type: 'docChanged', text, version: 1 } })), text);
          await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'focusEditor' } })));
          const after = await frame.evaluate(async () => {
            const samples: ReturnType<typeof captureSurfaces>[] = [];
            for (let count = 0; count < 12; count++) {
              await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
              samples.push((window as any).__captureTabSurfaces());
            }
            return samples;
          });
          assert.ok(after.every(surfaces => surfaces.length === before.length && surfaces.every((surface, index) => {
            const expected = before[index]!;
            return surface.owner === expected.owner && surface.witness === expected.witness
              && Math.abs(surface.top - expected.top) <= 1 && Math.abs(surface.offset - expected.offset) <= 1;
          })), `${label}, ${parking}, native offset ${nativeOffset}: tab return lost reading position, before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`);
        }
        if (outlineVisible) {
          for (const [width, height] of [[1000,700],[600,350],[300,150],[301,150],[300,151],[1200,800]]) {
            await page.setViewport({ width: width!, height: height! });
            await frame.waitForFunction(() => {
              const rect = document.getElementById('app')!.getBoundingClientRect();
              return Math.abs(rect.width - innerWidth) <= 1 && Math.abs(rect.height - innerHeight) <= 1;
            });
          }
        }
        if (view === 'preview' && native === 'other-document' && outlineVisible && preset === 'default') {
          await frame.evaluate(() => { (window as any).__holdNextReadingObservation = true; });
          await page.setViewport({ width: 1000, height: 700 });
          await Promise.race([heldReadingObservation, new Promise((_, reject) => setTimeout(() => reject(new Error('Missing reading observation')), 3000))]);
          await page.setViewport({ width: 900, height: 650 });
          await frame.waitForFunction(() => document.getElementById('app')!.getBoundingClientRect().width === 900);
          await frame.evaluate(() => { (window as any).__releaseReadingObservation(); });
          await frame.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          assert.equal(await frame.$eval('#app', element => element.getBoundingClientRect().width), 900,
            'A delayed observation must not suppress the final visible resize');
          delayNextVisibility = true;
          await page.setViewport({ width: 300, height: 150 });
          await Promise.race([heldVisibility, new Promise((_, reject) => setTimeout(() => reject(new Error('Missing visibility request')), 3000))]);
          await page.setViewport({ width: 900, height: 650 });
          await frame.waitForFunction(() => document.getElementById('app')!.getBoundingClientRect().width === 900);
          hidden = true;
          await frame.evaluate(() => window.dispatchEvent(new MessageEvent('message', { data: { type: 'webviewVisibilityChanged', visible: false } })));
          await page.evaluate(() => { document.getElementById('meo')!.style.visibility = 'hidden'; });
          await page.setViewport({ width: 300, height: 150 });
          releaseDelayedVisibility!();
          await frame.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
          assert.equal(await frame.$eval('#app', element => element.getBoundingClientRect().width), 900,
            'A late visible reply must not authorize the same size after the panel has been hidden');
          hidden = false;
        }
        console.log(`PASS ${label}: ${tabReturns.length} tab returns retained visible content and viewport on every sampled frame`);
      } catch (error) { throw new Error(label, { cause: error }); }
      finally { adapter?.dispose(); await page.close(); }
  }
} catch (error) { primaryError = error; throw error; }
finally { if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
