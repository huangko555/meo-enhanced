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
  let nextPreviewRenderDelayMs = 0;
  await page.exposeFunction('__renderSourceSidePreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    previewRenderCount += 1;
    const delayMs = nextPreviewRenderDelayMs;
    nextPreviewRenderDelayMs = 0;
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
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
  await page.exposeFunction('__delayNextSourceSidePreviewRender', (delayMs: number) => {
    nextPreviewRenderDelayMs = Math.max(0, delayMs);
  });
  await page.exposeFunction('__getSourceSidePreviewRenderCount', () => previewRenderCount);
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

  const refreshScrollTop = await page.$eval('.cm-scroller', element => element.scrollTop);
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const frameDocument = frame.contentDocument!;
    const firstText = frameDocument.querySelector('.meo-export-doc')?.firstChild;
    if (firstText) {
      const range = frameDocument.createRange();
      range.selectNodeContents(firstText);
      const selection = frameDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const probe = {
      frameHiddenTransitions: 0,
      editorScrollTops: [] as number[]
    };
    new MutationObserver((records) => {
      if (
        frame.style.visibility === 'hidden' ||
        records.some(record => record.oldValue?.includes('visibility: hidden'))
      ) probe.frameHiddenTransitions += 1;
    }).observe(frame, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    document.querySelector<HTMLElement>('.cm-scroller')!.addEventListener('scroll', () => {
      probe.editorScrollTops.push(document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop);
    }, { passive: true });
    (window as typeof window & { __sourcePreviewContinuityProbe?: typeof probe }).__sourcePreviewContinuityProbe = probe;
  });
  const sourceBounds = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.click(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2
  );
  const renderCountBeforeContinuityEdit = previewRenderCount;
  await page.evaluate(() => (
    (window as typeof window & { __delayNextSourceSidePreviewRender(delayMs: number): Promise<void> })
      .__delayNextSourceSidePreviewRender(500)
  ));
  await page.keyboard.type('CONTINUITY');
  await page.waitForFunction(async count => (
    await (window as typeof window & { __getSourceSidePreviewRenderCount(): Promise<number> })
      .__getSourceSidePreviewRenderCount()
  ) > count, {}, renderCountBeforeContinuityEdit);
  const inFlightPresentation = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    const status = document.querySelector<HTMLElement>('.preview-status')!;
    return {
      frameVisibility: frame.style.visibility,
      oldFrameStillVisible: frame.contentDocument?.body.textContent?.includes('Section 140'),
      statusHidden: status.hidden
    };
  });
  await page.waitForFunction(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body.textContent?.includes('CONTINUITY')
  ), { timeout: 3000 });
  await page.waitForFunction(() => {
    const root = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement;
    return root?.dataset.meoPreviewHorizontalOverflow === 'contained';
  });
  const continuity = await page.evaluate((beforeScrollTop) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: { frameHiddenTransitions: number; editorScrollTops: number[] };
    }).__sourcePreviewContinuityProbe;
    const editorScrollTop = document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop;
    return {
      ...probe,
      editorScrollDelta: editorScrollTop - beforeScrollTop,
      documentOverflow: frameDocument.documentElement.scrollWidth - frameDocument.documentElement.clientWidth,
      bodyOverflow: frameDocument.body.scrollWidth - frameDocument.body.clientWidth,
      horizontalOverflowMode: frameDocument.documentElement.dataset.meoPreviewHorizontalOverflow,
      horizontalScrollbarHeight: frameDocument.defaultView!
        .getComputedStyle(frameDocument.documentElement, '::-webkit-scrollbar').height
    };
  }, refreshScrollTop);
  assert.deepEqual(inFlightPresentation, {
    frameVisibility: '',
    oldFrameStillVisible: true,
    statusHidden: true
  }, 'An existing Preview must remain unobstructed while its replacement renders');
  assert.equal(continuity.frameHiddenTransitions, 0, 'Preview updates must never hide the current frame');
  assert.ok(Math.abs(continuity.editorScrollDelta) <= 2, JSON.stringify(continuity));
  assert.ok(continuity.documentOverflow <= 1 && continuity.bodyOverflow <= 1, JSON.stringify(continuity));
  assert.equal(continuity.horizontalOverflowMode, 'contained');
  assert.equal(continuity.horizontalScrollbarHeight, '0px');

  await page.evaluate(() => {
    const frameWindow = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!;
    const wide = frameWindow.document.createElement('div');
    wide.dataset.testGenuineHorizontalOverflow = 'true';
    wide.style.width = '1800px';
    wide.style.height = '1px';
    frameWindow.document.querySelector('.meo-export-doc')!.append(wide);
    frameWindow.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement
      .dataset.meoPreviewHorizontalOverflow === 'scrollable'
  ));
  const genuineOverflow = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return {
      overflow: frameDocument.documentElement.scrollWidth - frameDocument.documentElement.clientWidth,
      scrollbarHeight: frameDocument.defaultView!
        .getComputedStyle(frameDocument.documentElement, '::-webkit-scrollbar').height
    };
  });
  assert.ok(genuineOverflow.overflow > 500, JSON.stringify(genuineOverflow));
  assert.equal(genuineOverflow.scrollbarHeight, '10px');
  await page.evaluate(() => {
    const frameWindow = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!;
    frameWindow.document.querySelector('[data-test-genuine-horizontal-overflow]')?.remove();
    frameWindow.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => (
    document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.documentElement
      .dataset.meoPreviewHorizontalOverflow === 'contained'
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
  await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        frameHiddenTransitions: number;
        editorScrollTops: number[];
        previewScrollTops?: number[];
      };
    }).__sourcePreviewContinuityProbe;
    probe.editorScrollTops = [];
    probe.previewScrollTops = [];
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    frameDocument.addEventListener('scroll', () => {
      probe.previewScrollTops!.push(frameDocument.scrollingElement!.scrollTop);
    }, { passive: true });
  });
  await page.mouse.move(frameBounds.x + frameBounds.width / 2, frameBounds.y + frameBounds.height / 2);
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.wheel({ deltaY: 120 });
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await page.waitForFunction(previous => (
    Math.abs(document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop - previous) > 100
  ), { timeout: 3000 }, editorScrollBefore);
  const selectionAfter = await page.evaluate(() => {
    const selection = document.getSelection();
    return selection ? { anchorOffset: selection.anchorOffset, focusOffset: selection.focusOffset } : null;
  });
  assert.deepEqual(selectionAfter, selectionBefore, 'Preview-driven scroll must not move Source selection');
  const scrollTrace = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: { editorScrollTops: number[]; previewScrollTops?: number[] };
    }).__sourcePreviewContinuityProbe;
    return { editor: probe.editorScrollTops, preview: probe.previewScrollTops ?? [] };
  });
  const hasReverseStep = (values: number[]) => values.some((value, index) => (
    index > 0 && value < values[index - 1] - 1
  ));
  assert.equal(hasReverseStep(scrollTrace.preview), false, JSON.stringify(scrollTrace));
  assert.equal(hasReverseStep(scrollTrace.editor), false, JSON.stringify(scrollTrace));

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
