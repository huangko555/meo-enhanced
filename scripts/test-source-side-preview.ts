import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser',
  format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 760 });
  let previewRenderCount = 0;
  await page.exposeFunction('__renderSourceSidePreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    previewRenderCount += 1;
    return {
      type: 'previewRenderResult',
      requestId: message.requestId,
      result: {
        ok: true,
        value: exportRuntime.renderPreviewDocument({
          markdownText: message.text,
          sourceDocumentPath: 'C:/tmp/source-side-preview.md',
          uiLanguage: message.uiLanguage,
          styleEnvironment: message.environment
        })
      }
    };
  });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderSourceSidePreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });

  const text = Array.from({ length: 140 }, (_, index) => (
    `## Section ${index + 1}\n\nParagraph ${index + 1} with enough text to exercise semantic linked scrolling.`
  )).join('\n\n');
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///source-side-preview.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'source', uiLanguage: 'en',
    uiLanguagePreference: 'auto', automaticUiLanguage: 'en', sourceLineNumbers: 'on',
    previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
    editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
    gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
    restoreReadingPositionOnOpen: false, vscodeTheme: null
  } })), text);
  await page.waitForSelector('.cm-content');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.source-preview-button')?.offsetParent !== null);
  const preloadCount = previewRenderCount;

  await page.click('.source-preview-button');
  await page.waitForFunction(() => {
    const preview = document.querySelector<HTMLIFrameElement>('.preview-frame');
    return document.querySelector('.editor-surface')?.hasAttribute('data-source-preview')
      && preview?.contentDocument?.body.textContent?.includes('Section 140');
  });
  const layout = await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('.editor-host')!;
    const preview = document.querySelector<HTMLElement>('.preview-host')!;
    const button = document.querySelector<HTMLButtonElement>('.source-preview-button')!;
    return {
      editorWidth: editor.getBoundingClientRect().width,
      previewWidth: preview.getBoundingClientRect().width,
      editorVisible: !editor.hidden,
      previewVisible: !preview.hidden,
      pressed: button.getAttribute('aria-pressed'),
      focusedInEditor: editor.contains(document.activeElement)
    };
  });
  assert.equal(layout.editorVisible, true);
  assert.equal(layout.previewVisible, true);
  assert.equal(layout.pressed, 'true');
  assert.equal(layout.focusedInEditor, true, 'Opening side Preview should restore editor focus');
  assert.ok(Math.abs(layout.editorWidth - layout.previewWidth) <= 2, JSON.stringify(layout));

  const countBeforeTyping = previewRenderCount;
  await page.keyboard.type('XYZ');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(previewRenderCount, countBeforeTyping, 'Preview refresh must yield during active typing');
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
    return frame?.contentDocument?.body.textContent?.includes('XYZ');
  }, { timeout: 3000 });
  assert.equal(previewRenderCount, countBeforeTyping + 1, 'A typing burst should coalesce to one render');

  await page.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    scroller.scrollTop = 1800;
  });
  await page.waitForFunction(() => (
    (document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.scrollingElement?.scrollTop ?? 0) > 200
  ));

  const selectionBefore = await page.evaluate(() => {
    const selection = document.getSelection();
    return selection ? { anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset } : null;
  });
  const frameBounds = await page.$eval('.preview-frame', frame => {
    const rect = frame.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const editorScrollBefore = await page.$eval('.cm-scroller', element => element.scrollTop);
  await page.mouse.move(frameBounds.x + frameBounds.width / 2, frameBounds.y + frameBounds.height / 2);
  await page.mouse.wheel({ deltaY: 700 });
  await page.waitForFunction(previous => (
    Math.abs(document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop - previous) > 100
  ), { timeout: 3000 }, editorScrollBefore);
  const selectionAfter = await page.evaluate(() => {
    const selection = document.getSelection();
    return selection ? { anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset } : null;
  });
  assert.deepEqual(selectionAfter, selectionBefore, 'Preview-driven scroll must not move Source selection');

  await page.click('.source-preview-button');
  const closed = await page.evaluate(() => ({
    split: document.querySelector('.editor-surface')?.hasAttribute('data-source-preview'),
    previewHidden: document.querySelector<HTMLElement>('.preview-host')?.hidden,
    editorHidden: document.querySelector<HTMLElement>('.editor-host')?.hidden
  }));
  assert.deepEqual(closed, { split: false, previewHidden: true, editorHidden: false });
  const closedRenderCount = previewRenderCount;
  await page.keyboard.type('OFF');
  await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(previewRenderCount, closedRenderCount, 'Closed side Preview must add no typing work');
  assert.ok(preloadCount >= 1, 'The fixture should exercise the existing hidden preload path');
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}

console.log('Source side Preview checks passed');
