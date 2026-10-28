import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import { assessLargeDocument } from '../src/foundation/largeDocument';

const large = process.argv.includes('--large');
const narrow = process.argv.includes('--narrow');
const appearance = narrow ? 'light' : 'dark';
const language = narrow ? 'zh-CN' : 'en';
const markdown = 'Reference[^note].\n\n' + Array.from({ length: large ? 1600 : 30 }, (_, index) =>
  `## Section ${index + 1}\n\n` + 'Reading content for toolbar stability. '.repeat(8)
).join('\n\n') + '\n\n[^note]: Footnote destination.\n';
assert.equal(assessLargeDocument(markdown).windowedPreview, large);
const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const bundle = await build.outputs[0]!.text();
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  await page.setViewport({ width: narrow ? 420 : 1200, height: narrow ? 520 : 760 });
  await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${appearance}"><div id="app"></div></body>`);
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  const documents = new Map<string, ReturnType<typeof createPreviewDocument>>();
  let windowRequests = 0;
  let windowedRender = false;
  await page.exposeFunction('__toolbarStabilityHost', async (message: any) => {
    if (message.type === 'requestPreviewDocument') {
      windowRequests++;
      return { type: 'previewDocumentResult', requestId: message.requestId, documentId: message.documentId,
        result: { ok: true, value: await documents.get(message.documentId)!.run(message.operation) } };
    }
    if (message.type !== 'requestPreviewRender') return null;
    const options = { markdownText: message.text, sourceDocumentPath: 'C:/tmp/toolbar-stability.md',
      uiLanguage: message.uiLanguage, styleEnvironment: message.environment, preset: message.preset };
    windowedRender = Boolean(message.window);
    const parsed = message.window ? createPreviewDocument(message.requestId, options) : undefined;
    if (parsed) documents.set(message.requestId, parsed);
    return { type: 'previewRenderResult', requestId: message.requestId,
      result: { ok: true, value: parsed ? parsed.open(message.window.anchorLine) : exportRuntime.renderPreviewDocument(options) } };
  });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__toolbarStabilityHost(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(({ text, appearance, language }) => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///toolbar-stability.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'preview', uiLanguage: language,
    sourceLineNumbers: 'on', previewAppearance: appearance, previewFontFamily: '', previewSourceColoring: true,
    editorAppearance: appearance, gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, restoreReadingPositionOnOpen: false,
    vscodeTheme: null
  } })), { text: markdown, appearance, language });
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true
    && Boolean(document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('[id="fnref-1"]')));
  // A late or offscreen child must not turn the window shell into a second
  // document scroller. Keep the real Preview and trusted footnote navigation.
  await page.addStyleTag({ content: 'body::after,.editor-root::after{content:"";position:absolute;top:100%;width:1px;height:32px;pointer-events:none}' });
  assert.equal(windowedRender, large, 'production Preview must select the assessed rendering path');
  await page.evaluate(() => {
    const toolbar = document.querySelector<HTMLElement>('.mode-toolbar')!;
    const baseline = toolbar.getBoundingClientRect();
    const trace = (window as any).__toolbarStability = {
      baseline: { top: baseline.top, left: baseline.left, height: baseline.height },
      samples: [] as Array<{ top: number; left: number; height: number; outerScroll: number; bodyScroll: number; rootScroll: number; wrapperScroll: number }>,
      stopped: false
    };
    const sample = () => {
      const box = toolbar.getBoundingClientRect();
      trace.samples.push({ top: box.top, left: box.left, height: box.height,
        outerScroll: document.scrollingElement!.scrollTop, bodyScroll: document.body.scrollTop,
        rootScroll: document.getElementById('app')!.scrollTop,
        wrapperScroll: document.querySelector('.editor-wrapper')!.scrollTop });
      if (!trace.stopped) requestAnimationFrame(sample);
    };
    sample();
  });
  const frame = await (await page.$('.preview-frame'))!.contentFrame();
  assert.ok(frame);
  for (const selector of ['[id="fnref-1"]', '.footnote-index', '[id="fnref-1"]', '.footnote-backref']) {
    await frame.waitForSelector(selector, { visible: true });
    await frame.click(selector);
    const targetSelector = selector === '[id="fnref-1"]' ? '.footnote-item' : '[id="fnref-1"]';
    await page.waitForFunction(targetSelector => {
      const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
      const target = doc.querySelector(targetSelector);
      const rect = target?.getBoundingClientRect();
      return rect && rect.bottom > 0 && rect.top < doc.documentElement.clientHeight;
    }, {}, targetSelector);
    await page.evaluate(async () => {
      for (let index = 0; index < 12; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    });
  }
  const trace = await page.evaluate(() => {
    const trace = (window as any).__toolbarStability;
    trace.stopped = true;
    return trace;
  });
  assert.equal(trace.baseline.top, 0, 'the menu starts at the window top');
  assert.ok(trace.samples.every((sample: any) => Math.abs(sample.top - trace.baseline.top) < 0.5
    && Math.abs(sample.left - trace.baseline.left) < 0.5 && Math.abs(sample.height - trace.baseline.height) < 0.5),
  `footnote navigation moved the toolbar: ${JSON.stringify({ baseline: trace.baseline,
    changed: trace.samples.filter((sample: any) => sample.top !== trace.baseline.top).slice(0, 4) })}`);
  assert.ok(trace.samples.every((sample: any) => sample.outerScroll === 0 && sample.bodyScroll === 0
    && sample.rootScroll === 0 && sample.wrapperScroll === 0), 'only the Preview document may scroll');
  if (large) assert.ok(windowRequests > 0, 'distant footnote navigation must request a production Preview window');
  mkdirSync('tmp/toolbar-stability', { recursive: true });
  await page.screenshot({ path: `tmp/toolbar-stability/${large ? 'windowed' : 'ordinary'}.png` });
  console.log(`PASS ${large ? 'windowed' : 'ordinary'} ${language}/${appearance} Preview footnote roundtrip keeps toolbar geometry (${trace.samples.length} frames)`);
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
