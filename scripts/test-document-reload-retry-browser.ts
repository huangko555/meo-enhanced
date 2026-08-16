import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-document-reload-retry-'));
const editorModulePath = path.join(repoRoot, 'webview', 'src', 'editor.ts').replaceAll('\\', '/');

async function waitForFrames(page: any, count = 12): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-webview-viewport-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js',
    plugins: [{
      name: 'document-reload-editor-failure-seam',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/editor$/ }, () => (
          { path: 'document-reload-test-editor', namespace: 'reload-test' }
        ));
        builder.onLoad({ filter: /.*/, namespace: 'reload-test' }, () => ({
          loader: 'ts',
          contents: `
            import { createEditor as createRealEditor } from ${JSON.stringify(editorModulePath)};
            export function createEditor(options: Parameters<typeof createRealEditor>[0]) {
              const editor = createRealEditor(options);
              const originalSetText = editor.setText.bind(editor);
              const originalRestoreTopLine = editor.restoreTopLine?.bind(editor);
              let failuresRemaining = 0;
              let injectedFailures = 0;
              let reloadRestoreCalls = 0;
              const resetHistoryCalls: boolean[] = [];
              editor.setText = (text: string, resetHistory = false) => {
                resetHistoryCalls.push(resetHistory);
                if (failuresRemaining > 0) {
                  failuresRemaining -= 1;
                  injectedFailures += 1;
                  throw new Error('forced transient reload presentation failure');
                }
                return originalSetText(text, resetHistory);
              };
              if (originalRestoreTopLine) {
                editor.restoreTopLine = (...args: Parameters<typeof originalRestoreTopLine>) => {
                  reloadRestoreCalls += 1;
                  return originalRestoreTopLine(...args);
                };
              }
              (window as any).__documentReloadRetry = {
                editor,
                resetHistoryCalls,
                failNextSetText(count = 1) { failuresRemaining = count; },
                get injectedFailures() { return injectedFailures; },
                get reloadRestoreCalls() { return reloadRestoreCalls; }
              };
              return editor;
            }
          `
        }));
      }
    }]
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 460, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><body><div id="app"></div></body>');
    await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0}#app{display:flex;flex-direction:column}' });
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ content: `
      window.__hostMessages = [];
      window.acquireVsCodeApi = () => ({
        postMessage(message) { window.__hostMessages.push(message); },
        getState() { return undefined; },
        setState() {}
      });
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const initialText = Array.from({ length: 100 }, (_, index) => `initial line ${index + 1}`).join('\n');
    await page.evaluate((text) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'init', documentId: 'file:///reload-retry.md', text, version: 1,
        savedRevision: { version: 1, text }, diagnostics: [], mode: 'live',
        previewAppearance: 'dark', previewSourceColoring: true, editorAppearance: 'dark',
        gitChangesGutter: false, gitDiffLineHighlights: false,
        diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
        contentMaxWidthEnabled: false, longCodeBlockFoldingEnabled: true,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
        vscodeTheme: null
      }}));
    }, initialText);
    await page.waitForFunction(() => Boolean((window as any).__documentReloadRetry));
    await waitForFrames(page);

    const position = await page.evaluate(async () => {
      const seam = (window as any).__documentReloadRetry;
      const editor = seam.editor;
      const end = editor.view.state.doc.length;
      editor.view.dispatch({ changes: { from: end, insert: '\nLOCAL_TEXT_TO_DISCARD' } });
      editor.view.scrollDOM.scrollTop = 900;
      editor.view.scrollDOM.dispatchEvent(new Event('scroll'));
      for (let index = 0; index < 12; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      seam.failNextSetText(2);
      const current = editor.getTopVisiblePosition();
      return {
        topLine: current.line,
        topLineOffset: current.lineOffset,
        historyDepth: editor.getHistoryDepth()
      };
    });
    assert.ok(position && position.topLine > 1);
    assert.ok(position.historyDepth.undo > 0, 'the discarded local edit must begin in ordinary history');

    const diskText = Array.from({ length: 100 }, (_, index) => `disk line ${index + 1}`).join('\n');
    await page.evaluate(({ text, topLine, topLineOffset }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'documentReloadedFromDisk', version: 2, text, topLine, topLineOffset
      }}));
    }, { text: diskText, topLine: position.topLine, topLineOffset: position.topLineOffset });
    await page.waitForFunction((text) => (
      (window as any).__documentReloadRetry.editor.getText() === text
    ), {}, diskText);
    await waitForFrames(page);

    const result = await page.evaluate(async () => {
      const seam = (window as any).__documentReloadRetry;
      return {
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode,
        text: seam.editor.getText(),
        historyDepth: seam.editor.getHistoryDepth(),
        undoApplied: await seam.editor.undo(),
        position: seam.editor.getTopVisiblePosition(),
        injectedFailures: seam.injectedFailures,
        reloadRestoreCalls: seam.reloadRestoreCalls,
        resetHistoryCalls: [...seam.resetHistoryCalls]
      };
    });
    assert.equal(result.injectedFailures, 2, 'the production seam must reach the Source fallback');
    assert.deepEqual(result.resetHistoryCalls.slice(-3), [true, true, true], 'every disk-reload retry must reset history');
    assert.equal(result.mode, 'source', 'two Live failures must use the existing Source fallback');
    assert.equal(result.text, diskText);
    assert.equal(result.historyDepth.undo, 0, 'a successful retry must reset native Editor History');
    assert.equal(result.undoApplied, false, 'normal undo must not recover discarded pre-reload text');
    assert.ok(Math.abs(result.position.line - position.topLine) <= 1, 'reload retry must restore the viewport');
    assert.equal(result.reloadRestoreCalls, 1, 'the successful final presentation must restore exactly once');

    await page.click('.mode-button[data-mode="live"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live');
    const failedPresentation = await page.evaluate(async () => {
      const seam = (window as any).__documentReloadRetry;
      const editor = seam.editor;
      const end = editor.view.state.doc.length;
      editor.view.dispatch({ changes: { from: end, insert: '\nLOCAL_TEXT_KEPT_AFTER_PRESENTATION_FAILURE' } });
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      seam.failNextSetText(3);
      return {
        text: editor.getText(),
        historyDepth: editor.getHistoryDepth(),
        reloadRestoreCalls: seam.reloadRestoreCalls
      };
    });
    const rejectedDiskText = `${diskText}\nDISK_TEXT_THAT_MUST_NOT_BE_PRESENTED`;
    await page.evaluate(({ text, topLine, topLineOffset }) => {
      window.dispatchEvent(new MessageEvent('message', { data: {
        type: 'documentReloadedFromDisk', version: 3, text, topLine, topLineOffset
      }}));
    }, { text: rejectedDiskText, topLine: position.topLine, topLineOffset: position.topLineOffset });
    await page.waitForFunction(() => (
      (window as any).__documentReloadRetry.injectedFailures === 5
      && document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source'
    ));
    await waitForFrames(page);
    const failedResult = await page.evaluate(async () => {
      const seam = (window as any).__documentReloadRetry;
      return {
        text: seam.editor.getText(),
        historyDepth: seam.editor.getHistoryDepth(),
        undoApplied: await seam.editor.undo(),
        reloadRestoreCalls: seam.reloadRestoreCalls,
        mode: document.querySelector<HTMLElement>('#app')?.dataset.mode
      };
    });
    assert.equal(failedResult.mode, 'source', 'the established Live failure fallback must remain in Source');
    assert.equal(failedResult.text, failedPresentation.text, 'a failed Source fallback must keep local text visible');
    assert.ok(failedResult.historyDepth.undo > 0, 'a failed Source fallback must keep local Editor History');
    assert.equal(failedResult.undoApplied, true, 'the local edit must remain recoverable after presentation failure');
    assert.equal(
      failedResult.reloadRestoreCalls,
      failedPresentation.reloadRestoreCalls,
      'a failed final presentation must not restore the reload viewport'
    );

    console.log('Document reload retry Chromium trace passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
