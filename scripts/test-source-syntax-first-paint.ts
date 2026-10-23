import assert from 'node:assert/strict';
import path from 'node:path';
import darkPlus from '@shikijs/themes/dark-plus';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({
  entrypoints: [path.resolve(import.meta.dir, 'test-source-lightweight-shiki-entry.ts')],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
const errors: string[] = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.setViewport({ width: 1100, height: 700 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: path.resolve(import.meta.dir, '../webview/src/styles.css') });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const text = '<table><tr><td>HTML</td></tr></table>\n\n$\\frac{x_1}{2} + \\alpha$\n\n' + Array.from({ length: 40 }, (_, i) =>
    `## Heading ${i}\n\nBody **bold** *italic* \u0060code\u0060\n`).join('\n');
  await page.evaluate(text => {
    const harness = (window as any).SourceLightweightShikiHarness;
    harness.applyTheme();
    (window as any).__editor = harness.createEditor({ parent: document.getElementById('app'), text, initialMode: 'live', onApplyChanges() {} });
  }, text);
  // Allow normal background preparation without making a foreground request.
  await page.waitForFunction(() => (window as any).SourceLightweightShikiHarness.hasSourceTokens((window as any).__editor));
  const first = await page.evaluate(() => {
    (window as any).__editor.setMode('source');
    return document.querySelectorAll('.meo-source-token').length;
  });
  assert.ok(first > 0, 'A prewarmed Live → Source transition must be colored synchronously');
  await page.waitForSelector('.meo-source-token');
  const expected = await page.evaluate(() => document.querySelector('.cm-content')!.innerHTML);
  const returned = await page.evaluate(() => {
    const editor = (window as any).__editor;
    editor.setMode('live');
    editor.setMode('source');
    return document.querySelector('.cm-content')!.innerHTML;
  });
  assert.equal(returned, expected, 'An unchanged mode roundtrip must preserve exact first-paint colors');
  const reapplied = await page.evaluate(() => {
    (window as any).SourceLightweightShikiHarness.applyTheme();
    return document.querySelector('.cm-content')!.innerHTML;
  });
  assert.equal(reapplied, returned, 'Reapplying the same theme must preserve visible syntax');
  await page.evaluate(() => {
    const editor = (window as any).__editor;
    editor.setMode('live');
    editor.setText('## Old revision\n\n**old**');
    editor.setText('## Latest revision\n\n**latest**');
  });
  await page.waitForFunction(() => (window as any).SourceLightweightShikiHarness.hasSourceTokens((window as any).__editor));
  const edited = await page.evaluate(() => {
    (window as any).__editor.setMode('source');
    return [...document.querySelectorAll<HTMLElement>('.meo-source-token')]
      .map(span => [span.textContent, getComputedStyle(span).fontWeight]);
  });
  assert.ok(edited.some(([text, weight]) => text === '## Latest revision' && Number(weight) >= 600), 'Prewarm must color the latest revision');
  // Foreground preparation can run behind a Preview cover, where CM is hidden.
  const preparedHidden = await page.evaluate(async () => {
    const editor = (window as any).__editor;
    editor.setMode('live');
    document.getElementById('app')!.hidden = true;
    editor.view.requestMeasure();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    editor.setText('## Covered revision\n\n*italic*');
    const prepared = await editor.prepareSourceSyntax(() => true);
    editor.setMode('source');
    return { prepared, inView: editor.view.inView, marks: document.querySelectorAll('.meo-source-token').length };
  });
  assert.equal(preparedHidden.inView, false, 'The covered preparation must exercise a measured hidden editor');
  assert.ok(preparedHidden.prepared && preparedHidden.marks > 0, 'Covered cold transitions must prepare Source before reveal');
  const cancelled = await page.evaluate(async () => {
    const editor = (window as any).__editor;
    editor.setMode('live');
    editor.setText('## Cancelled revision');
    return editor.prepareSourceSyntax(() => false);
  });
  assert.equal(cancelled, false, 'Superseded mode intents must stop preparation');
  await page.evaluate(() => (window as any).__editor.destroy());
  assert.deepEqual(errors, []);

  // Exercise the actual mode application and bootstrap, including a cancelled
  // cold request. Hold task boundaries, not the tokenizer or its color output.
  const productionBuild = await Bun.build({
    entrypoints: [path.resolve(import.meta.dir, 'test-preview-reading-surface-production-entry.ts')],
    target: 'browser', format: 'iife'
  });
  if (!productionBuild.success) throw new Error(productionBuild.logs.map(String).join('\n'));
  const production = await browser.newPage();
  production.on('pageerror', error => errors.push(String(error)));
  await production.setViewport({ width: 1100, height: 700 });
  await production.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await production.addStyleTag({ path: path.resolve(import.meta.dir, '../webview/src/styles.css') });
  await production.evaluate(() => {
    (window as any).acquireVsCodeApi = () => ({ getState() {}, setState() {}, postMessage() {} });
    const NativeChannel = MessageChannel;
    (window as any).__hold = true;
    (window as any).__tasks = [];
    (window as any).MessageChannel = class {
      port1: MessagePort;
      port2: MessagePort;
      constructor() {
        const channel = new NativeChannel();
        this.port1 = channel.port1;
        this.port2 = channel.port2;
        Object.defineProperty(this.port1, 'onmessage', { set(listener) {
          channel.port1.addEventListener('message', event => {
            const deliver = () => listener.call(channel.port1, event);
            if ((window as any).__hold) (window as any).__tasks.push(deliver);
            else deliver();
          });
          channel.port1.start();
        } });
      }
    };
    // Also hold background idle work until the Source foreground request.
    (window as any).requestIdleCallback = (run: () => void) => setTimeout(() => {
      if ((window as any).__hold) (window as any).__tasks.push(run);
      else run();
    }, 0);
  });
  await production.addScriptTag({ content: await productionBuild.outputs[0]!.text() });
  await production.evaluate(({ text, theme }) => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///first-paint.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode: 'live', uiLanguage: 'en',
      sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
      editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
      outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
      restoreReadingPositionOnOpen: false, vscodeTheme: theme
    } }));
  }, { text, theme: darkPlus });
  await production.waitForSelector('.cm-editor.meo-mode-live');
  await production.click('button[data-mode="source"]');
  await production.waitForFunction(() => (window as any).__tasks.length > 0);
  assert.ok(await production.$('.cm-editor.meo-mode-live'), 'The old Live view must cover cold Source preparation');
  await production.click('button[data-mode="live"]');
  await production.evaluate(() => {
    (window as any).__hold = false;
    for (const run of (window as any).__tasks.splice(0)) run();
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(await production.$('.cm-editor.meo-mode-live'), 'A cancelled cold request must not switch to Source later');
  await production.evaluate(() => {
    (window as any).__sourceFrames = [];
    const sample = () => {
      const root = document.querySelector('.cm-editor.meo-mode-source .cm-content');
      if (root) {
        let uncolored = 0;
        const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walk.nextNode()) if (walk.currentNode.textContent?.trim()
          && !walk.currentNode.parentElement?.closest('.meo-source-token')) uncolored++;
        (window as any).__sourceFrames.push(uncolored);
      }
      (window as any).__sampleFrame = requestAnimationFrame(sample);
    };
    sample();
  });
  await production.click('button[data-mode="source"]');
  await production.waitForSelector('.cm-editor.meo-mode-source .meo-source-token');
  await production.waitForFunction(() => (window as any).__sourceFrames.length >= 3);
  const samples = await production.evaluate(() => {
    cancelAnimationFrame((window as any).__sampleFrame);
    return (window as any).__sourceFrames as number[];
  });
  assert.ok(samples.every(count => count === 0), 'Every revealed Source frame must contain complete syntax colors');
  assert.deepEqual(errors, []);
  const largeSource = '# Large source budget\n\n' + 'Synthetic paragraph for the source work budget.\n\n'.repeat(5_000);
  const largeSourceResult = await page.evaluate(async text => {
    (window as any).__editor.destroy();
    const harness = (window as any).SourceLightweightShikiHarness;
    const editor = harness.createEditor({ parent: document.getElementById('app'), text, initialMode: 'source', onApplyChanges() {} });
    const prepared = await editor.prepareSourceSyntax(() => true);
    const result = { prepared, text: editor.getText(), fullTokens: harness.hasSourceTokens(editor) };
    editor.destroy();
    return result;
  }, largeSource);
  assert.equal(largeSourceResult.prepared, true, 'large Source must be available without waiting for whole-document tokens');
  assert.equal(largeSourceResult.text, largeSource);
  assert.equal(largeSourceResult.fullTokens, false, 'large Source must use incremental parser coloring instead of full-document TextMate work');
  console.log('Source prewarm, roundtrip, first-paint colors and large-document budget checks passed');
} finally { await closeTestBrowser(browser); }
