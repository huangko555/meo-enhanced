import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-diagnostic-suggestion-characterization-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-editor-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 420, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      const requests: Array<{ requestId: string; diagnostic: unknown }> = [];
      const selectionStates: unknown[] = [];
      let sequence = 0;
      const editor = (window as any).EditorStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: 'mispelled word\nsecond line\nthird line',
        initialMode: 'source',
        initialDiagnostics: [{
          from: 0, to: 9, severity: 1, message: 'Unknown word', source: 'spell', code: 'unknown'
        }],
        onApplyChanges() {},
        onSelectionChange(state: unknown) { selectionStates.push(state); },
        onRequestDiagnosticSuggestions(diagnostic: unknown) {
          const requestId = `request-${++sequence}`;
          requests.push({ requestId, diagnostic });
          return requestId;
        }
      });
      (window as any).__diagnosticHarness = { editor, requests, selectionStates };
    });
    await page.waitForSelector('.meo-diagnostic');

    await page.click('.meo-diagnostic');
    const firstClickRequests = await page.evaluate(() => (window as any).__diagnosticHarness.requests.length);
    if (firstClickRequests !== 0) throw new Error(`first diagnostic click requested suggestions: ${firstClickRequests}`);

    await page.click('.meo-diagnostic');
    const secondClick = await page.evaluate(() => ({
      requests: (window as any).__diagnosticHarness.requests,
      selection: (window as any).__diagnosticHarness.editor.view.state.selection.main.toJSON(),
      scrollTop: (window as any).__diagnosticHarness.editor.view.scrollDOM.scrollTop
    }));
    if (secondClick.requests.length !== 1 || secondClick.requests[0].requestId !== 'request-1') {
      throw new Error(`second diagnostic click did not start exactly one request: ${JSON.stringify(secondClick)}`);
    }

    const ready = await page.evaluate(() => {
      const harness = (window as any).__diagnosticHarness;
      const before = harness.selectionStates.length;
      harness.editor.showDiagnosticSuggestions('request-1', {
        from: 0, to: 9, suggestions: ['misspelled', 'misapplied']
      });
      return {
        updates: harness.selectionStates.slice(before),
        selection: harness.editor.view.state.selection.main.toJSON(),
        scrollTop: harness.editor.view.scrollDOM.scrollTop
      };
    });
    const suggestionUpdate = (ready.updates as any[]).find((state) => state?.diagnosticSuggestions);
    if (suggestionUpdate?.diagnosticSuggestions?.map((item: any) => item.text).join('|') !== 'misspelled|misapplied') {
      throw new Error(`suggestion result was not presented: ${JSON.stringify(ready)}`);
    }
    if (JSON.stringify(ready.selection) !== JSON.stringify(secondClick.selection) || ready.scrollTop !== secondClick.scrollTop) {
      throw new Error(`suggestion presentation changed selection or viewport: ${JSON.stringify({ secondClick, ready })}`);
    }

    await page.click('.meo-diagnostic', { button: 'right' });
    const requestsAfterPresentedRepeat = await page.evaluate(() => (window as any).__diagnosticHarness.requests.length);
    if (requestsAfterPresentedRepeat !== 1) {
      throw new Error(`presented diagnostic started a duplicate request: ${requestsAfterPresentedRepeat}`);
    }

    const invalidated = await page.evaluate(() => {
      const harness = (window as any).__diagnosticHarness;
      harness.editor.setDiagnostics([{
        from: 0, to: 9, severity: 1, message: 'Replacement diagnostic', source: 'spell'
      }]);
      const before = harness.selectionStates.length;
      harness.editor.showDiagnosticSuggestions('request-1', {
        from: 0, to: 9, suggestions: ['stale result']
      });
      return harness.selectionStates.slice(before);
    });
    if ((invalidated as any[]).some((state) => state?.diagnosticSuggestions)) {
      throw new Error(`diagnostics replacement accepted a stale result: ${JSON.stringify(invalidated)}`);
    }

    await page.click('.meo-diagnostic', { button: 'right' });
    const directRequest = await page.evaluate(() => (window as any).__diagnosticHarness.requests.at(-1));
    if (directRequest?.requestId !== 'request-2') {
      throw new Error(`context menu did not request suggestions directly: ${JSON.stringify(directRequest)}`);
    }

    const externalInvalidation = await page.evaluate(() => {
      const harness = (window as any).__diagnosticHarness;
      harness.editor.setText('mispelled word\nsecond line\nthird line');
      const before = harness.selectionStates.length;
      harness.editor.showDiagnosticSuggestions('request-2', {
        from: 0, to: 9, suggestions: ['late external result']
      });
      return harness.selectionStates.slice(before);
    });
    if ((externalInvalidation as any[]).some((state) => state?.diagnosticSuggestions)) {
      throw new Error(`external presentation accepted a stale result: ${JSON.stringify(externalInvalidation)}`);
    }

    await page.evaluate(() => (window as any).__diagnosticHarness.editor.destroy());
    console.log('Diagnostic suggestion production characterization checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
