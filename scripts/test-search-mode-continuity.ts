import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import exportRuntime from '../src/export/runtime';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({
  entrypoints: ['scripts/test-search-mode-continuity-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 650 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.exposeFunction('__renderSearchPreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    return { type: 'previewRenderResult', requestId: message.requestId, result: { ok: true,
      value: exportRuntime.renderPreviewDocument({ markdownText: message.text,
        sourceDocumentPath: 'C:/search-continuity.md', uiLanguage: message.uiLanguage,
        styleEnvironment: message.environment }) } };
  });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderSearchPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const text = Array.from({ length: 90 }, (_, index) => [
    `## Section ${index}`, '',
    index % 15 === 0 ? `needle target ${index}` : 'Ordinary paragraph with several words.', '',
    index === 35 ? '| A | B |\n| --- | --- |\n| long table | ' + 'wrapped text '.repeat(140) + ' |\n' : ''
  ].join('\n')).join('\n') + '\n[Source-only match](needle://target)\n';
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///search-continuity.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'live', uiLanguage: 'en',
    sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
    editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
    restoreReadingPositionOnOpen: false, vscodeTheme: null
  } })), text);
  await page.waitForSelector('.editor-host > .cm-editor');
  await page.click('[data-action="find"]');
  await page.evaluate(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>('.find-input');
    inputs[0]!.value = 'needle';
    inputs[0]!.dispatchEvent(new Event('input', { bubbles: true }));
    inputs[1]!.value = 'replacement';
    for (const option of document.querySelectorAll<HTMLButtonElement>('.find-option-button')) option.click();
  });
  // Navigate to a middle hit before switching. No mode switch may perform another find.
  await page.focus('.find-input');
  for (let index = 0; index < 3; index += 1) await page.keyboard.press('Enter');
  const durations: number[] = [];
  for (const mode of ['source', 'preview', 'live', 'preview', 'source', 'live']) {
    const firstFrame = await page.evaluate(async mode => {
      const start = performance.now();
      document.querySelector<HTMLButtonElement>(`button[data-mode="${mode}"]`)!.click();
      return new Promise<{ visible: boolean; query: string; elapsed: number }>(resolve => requestAnimationFrame(() => {
        resolve({ visible: document.querySelector('.find-panel')!.classList.contains('is-visible'),
          query: document.querySelector<HTMLInputElement>('.find-input')!.value, elapsed: performance.now() - start });
      }));
    }, mode);
    assert.equal(firstFrame.visible, true, `${mode}: switching must keep Find open on its first frame`);
    assert.equal(firstFrame.query, 'needle', `${mode}: switching must retain the query`);
    await page.waitForFunction(mode => {
      const editor = document.querySelector<HTMLElement>('.editor-host');
      const preview = document.querySelector<HTMLElement>('.preview-host');
      return document.querySelector<HTMLElement>('#app')?.dataset.mode === mode
        && (mode === 'preview' ? !preview?.hidden && Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-preview-search-match'))
          : !editor?.hidden && !editor?.inert && Boolean(editor?.querySelector(`.meo-mode-${mode}`)));
    }, {}, mode);
    await page.waitForFunction(mode => document.querySelector('.find-status')?.textContent ===
      (mode === 'preview' ? '6 matches' : '7 matches'), {}, mode);
    const state = await page.evaluate(mode => {
      const inputs = document.querySelectorAll<HTMLInputElement>('.find-input');
      return { replacement: inputs[1]!.value, replaceDisabled: inputs[1]!.disabled,
        enabledOptions: document.querySelectorAll('.find-option-button.is-active').length,
        status: document.querySelector('.find-status')!.textContent };
    }, mode);
    assert.equal(state.replacement, 'replacement');
    assert.equal(state.replaceDisabled, mode === 'preview');
    assert.equal(state.enabledOptions, 2);
    durations.push(firstFrame.elapsed);
    if (mode === 'preview') {
      await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')
        ?.contentDocument?.querySelector('.meo-preview-search-match.is-active')
        ?.closest('[data-source-line]')?.textContent?.includes('target 30'));
      await page.waitForFunction(() => Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')
        ?.contentDocument?.querySelector('.meo-preview-search-overview-ruler-marker')));
      const geometry = await page.evaluate(() => {
        const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
        const scroll = doc.scrollingElement!;
        const ruler = doc.querySelector<HTMLElement>('.meo-preview-search-overview-ruler')!;
        const marks = Array.from(doc.querySelectorAll<HTMLElement>('.meo-preview-search-match'));
        const markers = Array.from(ruler.children) as HTMLElement[];
        return { count: marks.length, markers: markers.map(marker => Number.parseFloat(marker.style.top)),
          expected: [...new Set(marks.map(mark => Math.min(ruler.clientHeight - 3,
            Math.max(0, Math.round((mark.getBoundingClientRect().top + scroll.scrollTop) / scroll.scrollHeight * ruler.clientHeight)))))] };
      });
      assert.equal(geometry.count, 6);
      assert.deepEqual(geometry.markers, geometry.expected, 'Preview markers must follow rendered positions');
    }
  }
  // Preview navigation transfers its current hit without moving the editor selection.
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')
    ?.contentDocument?.querySelector('.meo-preview-search-match.is-active')));
  await page.focus('.find-input');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')
    ?.contentDocument?.querySelector('.meo-preview-search-match.is-active')
    ?.closest('[data-source-line]')?.textContent?.includes('target 45'));
  const navigationStayedVisible = await page.evaluate(async () => {
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame')!;
    for (let index = 0; index < 4; index += 1) await new Promise(resolve => requestAnimationFrame(resolve));
    const rect = frame.contentDocument!.querySelector('.meo-preview-search-match.is-active')!.getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= frame.contentWindow!.innerHeight;
  });
  assert.equal(navigationStayedVisible, true, 'Late mode restoration must not override explicit search navigation');
  await page.setViewport({ width: 700, height: 500 });
  await page.waitForFunction(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const scroll = doc.scrollingElement!;
    const ruler = doc.querySelector<HTMLElement>('.meo-preview-search-overview-ruler')!;
    const expected = [...new Set(Array.from(doc.querySelectorAll<HTMLElement>('.meo-preview-search-match'))
      .map(mark => Math.min(ruler.clientHeight - 3, Math.max(0,
        Math.round((mark.getBoundingClientRect().top + scroll.scrollTop) / scroll.scrollHeight * ruler.clientHeight)))))];
    const actual = Array.from(ruler.children).map(marker => Number.parseFloat((marker as HTMLElement).style.top));
    return expected.length > 0 && JSON.stringify(expected) === JSON.stringify(actual);
  });
  await mkdir('.local/search-view-continuity', { recursive: true });
  await page.screenshot({ path: '.local/search-view-continuity/preview-search.png' });
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector('.find-status')?.textContent === '7 matches');
  await page.focus('.find-replace-row .find-input');
  await page.keyboard.press('Enter');
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
    return doc?.body.textContent?.includes('replacement target 45');
  });
  assert.equal(await page.evaluate(() => document.querySelector<HTMLIFrameElement>('.preview-frame')
    ?.contentDocument?.body.textContent?.includes('needle target 30')), true,
    'Replace must use the transferred current hit, preserving the former editor hit');

  // A delayed search handoff cannot reopen a dismissed panel after rapid switches.
  await page.evaluate(() => {
    for (const mode of ['preview', 'source', 'live', 'preview']) {
      document.querySelector<HTMLButtonElement>('button[data-mode="' + mode + '"]')!.click();
    }
    document.querySelector<HTMLButtonElement>('.find-close-button')!.click();
  });
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')?.hidden);
  await page.waitForFunction(() => !document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('.meo-preview-search-match'));
  const largeMatchCount = await page.evaluate(async () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument!;
    const { createPreviewSearchController, previewSearchStyles } = (window as any).PreviewSearchHarness;
    const style = doc.createElement('style');
    style.textContent = previewSearchStyles;
    doc.head.append(style);
    const root = doc.createElement('main');
    root.className = 'meo-export-doc';
    root.dataset.sourceLine = '1';
    root.textContent = 'needle '.repeat(6000);
    doc.body.append(root);
    const controller = createPreviewSearchController({
      getDocument: () => doc, isVisible: () => true, onResultsChanged() {}, focus() {}
    });
    const waitForMatches = async () => {
      const deadline = performance.now() + 10000;
      while (controller.adapter.isSearchPending()) {
        if (performance.now() > deadline) throw new Error('Large Preview search did not finish');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    try {
      controller.adapter.setSearchQuery('needle');
      controller.surfaceReady();
      await waitForMatches();
      if (controller.adapter.countMatches() !== 6000) throw new Error('Initial large match count is wrong');
      controller.adapter.setSearchQuery('other');
      await new Promise(resolve => setTimeout(resolve, 0));
      // Interrupt cleanup between its batches, then resume with a new query.
      controller.surfaceHidden();
      controller.adapter.setSearchQuery('needle');
      controller.surfaceReady();
      await waitForMatches();
      const count = doc.querySelectorAll('.meo-preview-search-match').length;
      if (doc.querySelector('.meo-preview-search-match .meo-preview-search-match')) throw new Error('Nested stale highlights survived cancellation');
      if (count !== 6000 || controller.adapter.countMatches() !== 6000) throw new Error('Cancelled matching left stale or missing marks: ' + count);
      controller.adapter.setSearchQuery('');
      if (doc.querySelector('.meo-preview-search-match')) throw new Error('Clear left large-search marks');
      return count;
    } finally {
      controller.dispose();
      frame.remove();
    }
  });
  assert.equal(largeMatchCount, 6000);
  console.log(`Search survived all 6 mode transitions; first-frame times ${JSON.stringify(durations.map(Math.round))} ms; Preview geometry, current hit, replacement, resize, dismissal and 6000-match cancellation passed`);
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
