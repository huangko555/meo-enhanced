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

  const compactComplexBlock = [
    '<details>',
    '<summary>Compact complex block</summary>',
    ...Array.from({ length: 36 }, (_, index) => `<p>Collapsed source row ${index + 1}</p>`),
    '</details>'
  ].join('\n');
  const narrowTable = [
    '| A | Content-heavy column | C | D | E | F | G | H | I |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    '| 1 | This column needs materially more room than the compact labels | 3 | 4 | 5 | 6 | 7 | 8 | 9 |'
  ].join('\n');
  const text = [
    'Intro paragraph for formatting continuity.',
    `### Long heading ${'6'.repeat(180)}`,
    '',
    `Ordinary paragraph ${'7'.repeat(220)}`,
    '',
    `- Ordinary list item ${'unbroken'.repeat(55)}`,
    ...Array.from({ length: 22 }, (_, index) => (
      `## Section ${index + 1}\n\nParagraph ${index + 1} with enough text to exercise semantic linked scrolling.`
    )),
    compactComplexBlock,
    narrowTable,
    ...Array.from({ length: 118 }, (_, index) => {
      const section = index + 23;
      return `## Section ${section}\n\nParagraph ${section} with enough text to exercise semantic linked scrolling.`;
    })
  ].join('\n\n');
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
      && preview?.contentDocument?.body.textContent?.includes('Section 140')
      && getComputedStyle(document.querySelector<HTMLElement>('.preview-host')!).visibility !== 'hidden';
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
  const tableFit = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const wrapper = frameDocument.querySelector<HTMLElement>('.meo-table-scroll')!;
    const columns = Array.from(wrapper.querySelectorAll<HTMLTableColElement>('col'));
    return {
      overflow: wrapper.scrollWidth - wrapper.clientWidth,
      overflowX: getComputedStyle(wrapper).overflowX,
      widths: columns.map(column => column.getBoundingClientRect().width)
    };
  });
  assert.ok(tableFit.overflow <= 1, JSON.stringify(tableFit));
  assert.ok(tableFit.overflowX === 'clip' || tableFit.overflowX === 'hidden', JSON.stringify(tableFit));
  assert.ok(tableFit.widths[1] > tableFit.widths[0], JSON.stringify(tableFit));

  const compactBlockStartLine = text.slice(0, text.indexOf('<details>')).split('\n').length;
  await page.click('.line-jump-input');
  await page.keyboard.type(String(compactBlockStartLine));
  await page.keyboard.press('Enter');
  await new Promise(resolve => setTimeout(resolve, 120));
  const compactBlockTrace = await page.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const positions: number[] = [];
    for (let frame = 0; frame < 150; frame += 1) {
      scroller.scrollTop += 6;
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      positions.push(frameDocument.scrollingElement!.scrollTop);
    }
    return positions;
  });
  const compactBlockReverseSteps = compactBlockTrace.filter((position, index) => (
    index > 0 && position < compactBlockTrace[index - 1] - 1
  ));
  assert.equal(
    compactBlockReverseSteps.length,
    0,
    `Compact complex blocks must not make linked Preview reverse: ${JSON.stringify(compactBlockTrace)}`
  );

  const countBeforeTyping = previewRenderCount;
  await page.keyboard.down('Control');
  await page.keyboard.down('Shift');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await page.keyboard.up('Control');
  await page.keyboard.type('**Intro**');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(previewRenderCount, countBeforeTyping, 'Preview refresh must yield during active typing');
  await page.waitForFunction(() => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
    return frame?.contentDocument?.querySelector('strong')?.textContent === 'Intro';
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
      editorScrollTops: [] as number[],
      previewScrollTops: [] as number[],
      previewFrames: [] as Array<{
        editorScrollTop: number;
        scrollTop: number;
        sourceLine: number | null;
        anchorTop: number | null;
      }>,
      samplePreviewFrames: false,
      stablePreviewNode: frameDocument.querySelector<HTMLElement>('h2')
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
    frameDocument.addEventListener('scroll', () => {
      probe.previewScrollTops.push(frameDocument.scrollingElement!.scrollTop);
    }, { passive: true });
    const samplePreviewFrame = () => {
      if (!probe.samplePreviewFrames) return;
      const currentDocument = frame.contentDocument;
      const scrollTop = currentDocument?.scrollingElement?.scrollTop ?? 0;
      const anchor = Array.from(currentDocument?.querySelectorAll<HTMLElement>('[data-source-line]') ?? [])
        .find((element) => element.getBoundingClientRect().bottom > 0);
      probe.previewFrames.push({
        editorScrollTop: document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop,
        scrollTop,
        sourceLine: anchor ? Number(anchor.dataset.sourceLine) : null,
        anchorTop: anchor?.getBoundingClientRect().top ?? null
      });
      requestAnimationFrame(samplePreviewFrame);
    };
    (probe as typeof probe & { startPreviewFrameSampling(): void; stopPreviewFrameSampling(): void })
      .startPreviewFrameSampling = () => {
        probe.previewScrollTops = [];
        probe.previewFrames = [];
        probe.samplePreviewFrames = true;
        requestAnimationFrame(samplePreviewFrame);
      };
    (probe as typeof probe & { startPreviewFrameSampling(): void; stopPreviewFrameSampling(): void })
      .stopPreviewFrameSampling = () => { probe.samplePreviewFrames = false; };
    (window as typeof window & { __sourcePreviewContinuityProbe?: typeof probe }).__sourcePreviewContinuityProbe = probe;
  });
  const sourceBounds = await page.$eval('.cm-scroller', element => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  await page.mouse.click(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + 24
  );
  await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: { startPreviewFrameSampling(): void };
    }).__sourcePreviewContinuityProbe;
    probe.startPreviewFrameSampling();
  });
  await page.mouse.move(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2
  );
  for (let index = 0; index < 6; index += 1) {
    await page.mouse.wheel({ deltaY: 120 });
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await new Promise(resolve => setTimeout(resolve, 120));
  const sourceDrivenFrames = await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        previewFrames: Array<{ editorScrollTop: number; scrollTop: number }>;
        stopPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.stopPreviewFrameSampling();
    return probe.previewFrames;
  });
  const sourceFollowerLagFrames = sourceDrivenFrames.filter((frame, index) => {
    if (index === 0) return false;
    const previous = sourceDrivenFrames[index - 1];
    return Math.abs(frame.editorScrollTop - previous.editorScrollTop) > 1
      && Math.abs(frame.scrollTop - previous.scrollTop) <= 1;
  });
  assert.equal(
    sourceFollowerLagFrames.length,
    0,
    `Source-driven linked scrolling must update Preview in the same sampled frame: ${JSON.stringify(sourceDrivenFrames)}`
  );
  const sourceDrivenPreviewReverseSteps = sourceDrivenFrames.filter((frame, index) => (
    index > 0 && frame.scrollTop < sourceDrivenFrames[index - 1].scrollTop - 1
  ));
  assert.equal(
    sourceDrivenPreviewReverseSteps.length,
    0,
    `Source-driven Preview must remain monotonic through compact complex blocks: ${JSON.stringify(sourceDrivenFrames)}`
  );
  await page.mouse.click(
    sourceBounds.x + sourceBounds.width / 2,
    sourceBounds.y + sourceBounds.height / 2
  );
  await new Promise(resolve => setTimeout(resolve, 40));
  const continuityScrollTop = await page.$eval('.cm-scroller', element => element.scrollTop);
  await page.evaluate(() => {
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: { startPreviewFrameSampling(): void };
    }).__sourcePreviewContinuityProbe;
    probe.startPreviewFrameSampling();
  });
  const renderCountBeforeContinuityEdit = previewRenderCount;
  await page.evaluate(() => (
    (window as typeof window & { __delayNextSourceSidePreviewRender(delayMs: number): Promise<void> })
      .__delayNextSourceSidePreviewRender(500)
  ));
  const continuityEdit = 'CONTINUITY';
  await page.keyboard.type(continuityEdit);
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
  await new Promise(resolve => setTimeout(resolve, 100));
  const continuity = await page.evaluate((beforeScrollTop) => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const probe = (window as typeof window & {
      __sourcePreviewContinuityProbe: {
        frameHiddenTransitions: number;
        editorScrollTops: number[];
        previewScrollTops: number[];
        previewFrames: Array<{
          editorScrollTop: number;
          scrollTop: number;
          sourceLine: number | null;
          anchorTop: number | null;
        }>;
        stablePreviewNode: HTMLElement | null;
        stopPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.stopPreviewFrameSampling();
    const editorScrollTop = document.querySelector<HTMLElement>('.cm-scroller')!.scrollTop;
    return {
      ...probe,
      stablePreviewNodePreserved: probe.stablePreviewNode?.isConnected === true
        && frameDocument.querySelector('h2') === probe.stablePreviewNode,
      editorScrollDelta: editorScrollTop - beforeScrollTop,
      documentOverflow: frameDocument.documentElement.scrollWidth - frameDocument.documentElement.clientWidth,
      bodyOverflow: frameDocument.body.scrollWidth - frameDocument.body.clientWidth,
      horizontalScrollbarHeight: frameDocument.defaultView!
        .getComputedStyle(frameDocument.documentElement, '::-webkit-scrollbar').height
    };
  }, continuityScrollTop);
  assert.deepEqual(inFlightPresentation, {
    frameVisibility: '',
    oldFrameStillVisible: true,
    statusHidden: true
  }, 'An existing Preview must remain unobstructed while its replacement renders');
  assert.equal(continuity.frameHiddenTransitions, 0, 'Preview updates must never hide the current frame');
  assert.equal(continuity.stablePreviewNodePreserved, true, 'Unchanged Preview blocks must survive a live update');
  assert.ok(Math.abs(continuity.editorScrollDelta) <= 2, JSON.stringify(continuity));
  assert.ok(continuity.previewFrames.length >= 2, JSON.stringify(continuity));
  assert.ok(continuity.previewFrames.every(frame => frame.sourceLine !== null), JSON.stringify(continuity));
  const previewScrollRange = Math.max(...continuity.previewFrames.map(frame => frame.scrollTop))
    - Math.min(...continuity.previewFrames.map(frame => frame.scrollTop));
  assert.ok(previewScrollRange <= 1, JSON.stringify(continuity));
  assert.ok(continuity.documentOverflow <= 1 && continuity.bodyOverflow <= 1, JSON.stringify(continuity));
  assert.equal(continuity.horizontalScrollbarHeight, '0px');

  await page.evaluate(() => {
    const frameWindow = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!;
    const wide = frameWindow.document.createElement('div');
    wide.className = 'meo-export-html-block';
    wide.dataset.testGenuineHorizontalOverflow = 'true';
    const content = frameWindow.document.createElement('div');
    content.style.width = '1800px';
    content.style.height = '1px';
    wide.append(content);
    frameWindow.document.querySelector('.meo-export-doc')!.append(wide);
    frameWindow.dispatchEvent(new Event('resize'));
  });
  await page.waitForFunction(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    const overflow = frameDocument?.querySelector<HTMLElement>('[data-test-genuine-horizontal-overflow]');
    return Boolean(overflow && overflow.scrollWidth - overflow.clientWidth > 500);
  });
  const genuineOverflow = await page.evaluate(() => {
    const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const localScroller = frameDocument.querySelector<HTMLElement>('[data-test-genuine-horizontal-overflow]')!;
    return {
      rootOverflow: frameDocument.documentElement.scrollWidth - frameDocument.documentElement.clientWidth,
      rootScrollbarHeight: frameDocument.defaultView!
        .getComputedStyle(frameDocument.documentElement, '::-webkit-scrollbar').height,
      localOverflow: localScroller.scrollWidth - localScroller.clientWidth,
      localOverflowX: frameDocument.defaultView!.getComputedStyle(localScroller).overflowX
    };
  });
  assert.ok(genuineOverflow.localOverflow > 500, JSON.stringify(genuineOverflow));
  assert.equal(genuineOverflow.localOverflowX, 'auto');
  assert.ok(genuineOverflow.rootOverflow <= 1, JSON.stringify(genuineOverflow));
  assert.equal(genuineOverflow.rootScrollbarHeight, '0px');
  await page.evaluate(() => {
    const frameWindow = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentWindow!;
    frameWindow.document.querySelector('[data-test-genuine-horizontal-overflow]')?.remove();
    frameWindow.dispatchEvent(new Event('resize'));
  });

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
        startPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.editorScrollTops = [];
    probe.previewScrollTops = [];
    probe.startPreviewFrameSampling();
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
      __sourcePreviewContinuityProbe: {
        editorScrollTops: number[];
        previewScrollTops?: number[];
        previewFrames: Array<{ editorScrollTop: number; scrollTop: number }>;
        stopPreviewFrameSampling(): void;
      };
    }).__sourcePreviewContinuityProbe;
    probe.stopPreviewFrameSampling();
    return {
      editor: probe.editorScrollTops,
      preview: probe.previewScrollTops ?? [],
      frames: probe.previewFrames
    };
  });
  const hasReverseStep = (values: number[]) => values.some((value, index) => (
    index > 0 && value < values[index - 1] - 1
  ));
  assert.equal(hasReverseStep(scrollTrace.preview), false, JSON.stringify(scrollTrace));
  assert.equal(hasReverseStep(scrollTrace.editor), false, JSON.stringify(scrollTrace));
  const previewFollowerLagFrames = scrollTrace.frames.filter((frame, index) => {
    if (index === 0) return false;
    const previous = scrollTrace.frames[index - 1];
    return Math.abs(frame.scrollTop - previous.scrollTop) > 5
      && Math.abs(frame.editorScrollTop - previous.editorScrollTop) <= 1;
  });
  assert.equal(
    previewFollowerLagFrames.length,
    0,
    `Preview-driven linked scrolling must update Source in the same sampled frame: ${JSON.stringify(scrollTrace.frames)}`
  );

  await page.click('button[data-mode="live"]');
  await page.waitForFunction(() => (
    document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live'
    && document.querySelector<HTMLElement>('.preview-host')?.hidden === true
  ));
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.evaluate(() => {
    const samples: Array<{ hidden: boolean; scrollTop: number }> = [];
    let remaining = 24;
    const sample = () => {
      const host = document.querySelector<HTMLElement>('.preview-host')!;
      const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument;
      samples.push({
        hidden: host.hidden || getComputedStyle(host).visibility === 'hidden',
        scrollTop: frameDocument?.scrollingElement?.scrollTop ?? 0
      });
      remaining -= 1;
      if (remaining > 0) requestAnimationFrame(sample);
    };
    (window as typeof window & { __sourceSplitEntrySamples?: typeof samples }).__sourceSplitEntrySamples = samples;
    requestAnimationFrame(sample);
  });
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source');
  await new Promise(resolve => setTimeout(resolve, 450));
  const splitEntrySamples = await page.evaluate(() => (
    (window as typeof window & {
      __sourceSplitEntrySamples: Array<{ hidden: boolean; scrollTop: number }>;
    }).__sourceSplitEntrySamples
  ));
  const visibleSplitEntryPositions = splitEntrySamples
    .filter(sample => !sample.hidden)
    .map(sample => sample.scrollTop);
  assert.ok(visibleSplitEntryPositions.length >= 2, JSON.stringify(splitEntrySamples));
  assert.ok(
    Math.max(...visibleSplitEntryPositions) - Math.min(...visibleSplitEntryPositions) <= 1,
    `A split Preview must be at its final position before its first visible frame: ${JSON.stringify(splitEntrySamples)}`
  );

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
