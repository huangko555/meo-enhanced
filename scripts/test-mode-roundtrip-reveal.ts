import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const tableStartLine = 1131;
const lines = Array.from({ length: 2005 }, (_, index) => `Reading line ${index + 1}`);
lines[1124] = '> A quote above the table';
lines[1125] = '> **Emphasized quote** with `inline code`';
lines[1126] = '';
lines[1127] = '## Table styles';
lines[1128] = '';
lines[1129] = '';
lines[1130] = '| Scenario | Plain content | Mixed content | Comparison |';
lines[1131] = '| --- | --- | --- | --- |';
lines[1132] = '| Basic | Updated ordinary text | **Bold**, *italic*, ~~strike~~ | `code` |';
lines[1133] = '| Bold | code `sample` | **Bold with `code`** | **Bold and *italic*** |';
lines[1134] = '| Italic | plain text | *Italic with `code`* | *Italic and **bold*** |';
lines[1135] = '| Mixed | ordinary text | ***Mixed with `code`*** | ~~old~~ new |';
lines[1136] = '| Blank | | | |';
lines[1137] = '| Link | [ordinary](https://example.com) | **[bold link](https://example.com)** | *[italic link](https://example.com)* |';
lines[1138] = '| New | `diff-row` | **New row data** | Pending |';
lines[1139] = '';
lines[1140] = '## Content after the table';
const markdown = lines.join('\n');

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 900 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.exposeFunction('__renderRoundtripPreview', async (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    return {
      type: 'previewRenderResult', requestId: message.requestId,
      result: { ok: true, value: exportRuntime.renderPreviewDocument({
        markdownText: message.text,
        sourceDocumentPath: 'C:/tmp/roundtrip.md',
        uiLanguage: message.uiLanguage,
        styleEnvironment: message.environment
      }) }
    };
  });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderRoundtripPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate((text) => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///roundtrip.md', text, version: 1,
      savedRevision: { version: 1, text }, diagnostics: [], mode: 'live', uiLanguage: 'en',
      sourceLineNumbers: 'on', previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
      editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
      outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
      restoreReadingPositionOnOpen: false, vscodeTheme: null
    } }));
  }, markdown);
  await page.waitForSelector('.cm-editor.meo-mode-live');
  await page.evaluate(async (line) => {
    const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
    scroller.scrollTop = scroller.scrollHeight * line / 2005;
    await new Promise(resolve => setTimeout(resolve, 300));
    const table = document.querySelector<HTMLElement>(
      `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${line}"]`
    );
    if (table) scroller.scrollTop += table.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 100;
  }, tableStartLine);
  await page.waitForFunction((line) => Boolean(document.querySelector(
    `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${line}"]`
  )), {}, tableStartLine);
  await page.click('button[data-mode="source"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'source');
  await page.click('button[data-mode="preview"]');
  await page.waitForFunction(() => document.querySelector<HTMLElement>('.preview-status')?.hidden === true);

  // The real table widget schedules row sizing on a frame. Delay that callback
  // to model a busy VS Code Webview and make premature Live reveal deterministic.
  await page.evaluate(() => {
    const original = window.requestAnimationFrame.bind(window);
    (window as any).__delayedTableLayouts = 0;
    window.requestAnimationFrame = (callback) => {
      if ((new Error().stack ?? '').includes('scheduleLayout')) {
        (window as any).__delayedTableLayouts += 1;
        return original(() => window.setTimeout(() => callback(performance.now()), 350));
      }
      return original(callback);
    };
    const samples: Array<{ height: number | null; top: number | null; revealed: boolean; content: boolean }> = [];
    (window as any).__roundtripSamples = samples;
    const sample = () => {
      const table = document.querySelector<HTMLElement>(
        '.meo-md-html-table-shell[data-meo-rendered-block-start-line="1131"]'
      );
      const scroller = document.querySelector<HTMLElement>('.cm-scroller');
      const scrollerRect = scroller?.getBoundingClientRect();
      samples.push({
        height: table?.getBoundingClientRect().height ?? null,
        top: table?.getBoundingClientRect().top ?? null,
        revealed: document.querySelector<HTMLElement>('.preview-host')?.hidden === true,
        content: Boolean(scrollerRect && Array.from(document.querySelectorAll<HTMLElement>('.cm-line'))
          .some(line => { const rect = line.getBoundingClientRect();
            return rect.height > 0 && rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom; }))
      });
      if (samples.length < 90) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.click('button[data-mode="live"]');
  await new Promise(resolve => setTimeout(resolve, 1000));
  const result = await page.evaluate(() => ({
    delayed: (window as any).__delayedTableLayouts as number,
    samples: (window as any).__roundtripSamples as Array<{
      height: number | null; top: number | null; revealed: boolean; content: boolean
    }>
  }));
  assert.ok(result.delayed > 0, 'the real table layout callback must be delayed');
  const revealed = result.samples.filter(sample => sample.revealed);
  assert.ok(revealed.length >= 3 && revealed[0]!.height !== null, 'Live table must become visible');
  assert.ok(revealed.every(sample => sample.content), 'Live must not expose a blank editor frame');
  assert.ok(revealed.every(sample => sample.height === revealed[0]!.height),
    `Live table expanded after reveal: ${JSON.stringify(revealed.map(sample => sample.height))}`);
  assert.ok(revealed.every(sample => Math.abs((sample.top ?? 0) - (revealed[0]!.top ?? 0)) <= 1),
    'Live table must not jump after reveal');
  console.log('Preview to Live roundtrip reveals settled table and visible content');
} catch (error) {
  primaryError = error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
