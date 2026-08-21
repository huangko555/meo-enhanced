import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-source-lightweight-shiki-'));

const settle = async (page: import('puppeteer-core').Page, milliseconds = 1200): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  await page.evaluate(async () => {
    for (let frame = 0; frame < 6; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  });
};

const styledCodeTokenCount = async (page: import('puppeteer-core').Page): Promise<number> => (
  page.evaluate(() => document.querySelectorAll('.cm-content span[style*="color:"]').length)
);

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-source-lightweight-shiki-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const sourceText = [
      '# Source document',
      '',
      '```typescript',
      'const sourceOnlyValue = 1;',
      'console.log(sourceOnlyValue);',
      '```',
      '',
      'navigation target'
    ].join('\n');

    const initial = await page.evaluate((text) => {
      const harness = (window as any).SourceLightweightShikiHarness;
      harness.applyTheme();
      const editor = harness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
      (window as any).__sourceLightweightEditor = editor;
      const target = text.indexOf('sourceOnlyValue');
      editor.view.dispatch({ selection: { anchor: target, head: target + 'sourceOnlyValue'.length } });
      editor.focus();
      return {
        mode: editor.view.dom.classList.contains('meo-mode-live') ? 'live' : 'source',
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        search: editor.findNext('navigation target', { focusEditor: false }),
        focused: editor.hasFocus(),
        lineNumbers: document.querySelectorAll('.cm-lineNumbers .cm-gutterElement').length
      };
    }, sourceText);
    await settle(page);

    assert.equal(initial.mode, 'source');
    assert.equal(initial.text, sourceText);
    assert.deepEqual(initial.history, { undo: 0, redo: 0 });
    assert.equal(initial.search.found, true);
    assert.equal(initial.focused, true);
    assert.ok(initial.lineNumbers > 1);
    assert.equal(
      await styledCodeTokenCount(page),
      0,
      'Source startup must not run the Live-only Shiki renderer or write its inline token styles'
    );

    await page.evaluate(() => {
      const editor = (window as any).__sourceLightweightEditor;
      editor.setMode('live');
    });
    await page.waitForFunction(
      () => document.querySelectorAll('.cm-content span[style*="color:"]').length > 0,
      { timeout: 10_000 }
    );
    const live = await page.evaluate(() => {
      const editor = (window as any).__sourceLightweightEditor;
      return {
        mode: editor.view.dom.classList.contains('meo-mode-live') ? 'live' : 'source',
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        focused: editor.hasFocus(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        }
      };
    });
    assert.equal(live.mode, 'live');
    assert.equal(live.text, sourceText);
    assert.deepEqual(live.history, initial.history, 'mode changes must not enter Editor History');
    assert.equal(live.focused, true);

    const latestText = [
      '# Latest document',
      '',
      '```python',
      'latest_value = 2',
      'print(latest_value)',
      '```',
      '',
      'latest navigation target'
    ].join('\n');
    const beforeLate = await page.evaluate((text) => {
      const harness = (window as any).SourceLightweightShikiHarness;
      const editor = (window as any).__sourceLightweightEditor;
      editor.setMode('source');
      editor.setText(text);
      const target = text.indexOf('latest_value');
      editor.view.dispatch({ selection: { anchor: target, head: target + 'latest_value'.length } });
      editor.focus();
      harness.applyTheme();
      editor.setMode('live');
      editor.setMode('source');
      return {
        history: editor.getHistoryDepth(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        }
      };
    }, latestText);
    await settle(page);

    const afterLate = await page.evaluate(() => {
      const editor = (window as any).__sourceLightweightEditor;
      return {
        mode: editor.view.dom.classList.contains('meo-mode-live') ? 'live' : 'source',
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        selection: {
          anchor: editor.view.state.selection.main.anchor,
          head: editor.view.state.selection.main.head
        },
        focused: editor.hasFocus(),
        richPresentationCount: document.querySelectorAll([
          '.meo-mermaid-block',
          '.meo-md-math',
          '.meo-md-html-table-shell',
          '.meo-md-html-content',
          '.meo-md-image-img'
        ].join(',')).length
      };
    });
    assert.equal(afterLate.mode, 'source');
    assert.equal(afterLate.text, latestText);
    assert.deepEqual(afterLate.history, beforeLate.history);
    assert.deepEqual(afterLate.selection, beforeLate.selection);
    assert.equal(afterLate.focused, true);
    assert.equal(afterLate.richPresentationCount, 0);
    assert.equal(
      await styledCodeTokenCount(page),
      0,
      'Live-to-Source must reject late Shiki DOM presentation'
    );

    await page.evaluate(() => (window as any).__sourceLightweightEditor.setMode('live'));
    await page.waitForFunction(
      () => document.querySelectorAll('.cm-content span[style*="color:"]').length > 0,
      { timeout: 10_000 }
    );
    const latestLive = await page.evaluate(() => {
      const editor = (window as any).__sourceLightweightEditor;
      return {
        mode: editor.view.dom.classList.contains('meo-mode-live') ? 'live' : 'source',
        text: editor.getText(),
        history: editor.getHistoryDepth(),
        styledLatestValue: Array.from(document.querySelectorAll<HTMLElement>('.cm-content span[style*="color:"]'))
          .some((node) => node.textContent?.includes('latest_value'))
      };
    });
    assert.equal(latestLive.mode, 'live');
    assert.equal(latestLive.text, latestText);
    assert.deepEqual(latestLive.history, beforeLate.history);
    assert.equal(latestLive.styledLatestValue, true, 'Source-to-Live must render the latest Document and theme');

    await page.evaluate(() => {
      const editor = (window as any).__sourceLightweightEditor;
      editor.setMode('source');
      editor.destroy();
    });
    assert.equal(await page.evaluate(() => document.querySelectorAll('.cm-editor').length), 0);
  } finally {
    await browser.close();
  }

  console.log('Source lightweight Shiki production trace passed');
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
