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
      const editor = (window as any).EditorStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: 'mispelled word\nsecond line\nthird line',
        initialMode: 'source',
        initialDiagnostics: [{
          from: 0, to: 9, severity: 1, message: 'Unknown word', source: 'spell', code: 'unknown'
        }],
        onApplyChanges() {},
        onSelectionChange(state: unknown) { selectionStates.push(state); },
        postDiagnosticSuggestionsMessage(message: any) {
          requests.push({ requestId: message.requestId, diagnostic: message });
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
    if (secondClick.requests.length !== 1 || typeof secondClick.requests[0].requestId !== 'string') {
      throw new Error(`second diagnostic click did not start exactly one request: ${JSON.stringify(secondClick)}`);
    }

    const ready = await page.evaluate(async () => {
      const harness = (window as any).__diagnosticHarness;
      const before = harness.selectionStates.length;
      const request = harness.requests[0];
      harness.editor.acceptDiagnosticSuggestionsResult({
        type: 'diagnosticSuggestionsResult',
        requestId: request.requestId,
        from: 0,
        to: 9,
        result: { ok: true, value: { suggestions: ['misspelled', 'misapplied'] } }
      });
      await Promise.resolve();
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
      harness.editor.acceptDiagnosticSuggestionsResult({
        type: 'diagnosticSuggestionsResult',
        requestId: harness.requests[0].requestId,
        from: 0,
        to: 9,
        result: { ok: true, value: { suggestions: ['stale result'] } }
      });
      return harness.selectionStates.slice(before);
    });
    if ((invalidated as any[]).some((state) => state?.diagnosticSuggestions)) {
      throw new Error(`diagnostics replacement accepted a stale result: ${JSON.stringify(invalidated)}`);
    }

    await page.click('.meo-diagnostic', { button: 'right' });
    const directRequest = await page.evaluate(() => (window as any).__diagnosticHarness.requests.at(-1));
    if (typeof directRequest?.requestId !== 'string' || directRequest.requestId === secondClick.requests[0].requestId) {
      throw new Error(`context menu did not request suggestions directly: ${JSON.stringify(directRequest)}`);
    }

    const failure = await page.evaluate(async () => {
      const harness = (window as any).__diagnosticHarness;
      const before = harness.selectionStates.length;
      const request = harness.requests.at(-1);
      const accepted = harness.editor.acceptDiagnosticSuggestionsResult({
        type: 'diagnosticSuggestionsResult',
        requestId: request.requestId,
        from: 0,
        to: 9,
        result: { ok: false, error: { code: 'operation-failed', message: 'failed' } }
      });
      await Promise.resolve();
      return { accepted, updates: harness.selectionStates.slice(before) };
    });
    if (!failure.accepted || (failure.updates as any[]).some((state) => state?.diagnosticSuggestions)) {
      throw new Error(`failed request changed the suggestion presentation: ${JSON.stringify(failure)}`);
    }

    await page.click('.meo-diagnostic', { button: 'right' });
    const empty = await page.evaluate(async () => {
      const harness = (window as any).__diagnosticHarness;
      const before = harness.selectionStates.length;
      const request = harness.requests.at(-1);
      const accepted = harness.editor.acceptDiagnosticSuggestionsResult({
        type: 'diagnosticSuggestionsResult',
        requestId: request.requestId,
        from: 0,
        to: 9,
        result: { ok: true, value: { suggestions: [] } }
      });
      await Promise.resolve();
      return { accepted, updates: harness.selectionStates.slice(before) };
    });
    if (!empty.accepted || (empty.updates as any[]).some((state) => state?.diagnosticSuggestions)) {
      throw new Error(`empty result changed the suggestion presentation: ${JSON.stringify(empty)}`);
    }

    await page.click('.meo-diagnostic', { button: 'right' });

    const externalInvalidation = await page.evaluate(() => {
      const harness = (window as any).__diagnosticHarness;
      harness.editor.setText('mispelled word\nsecond line\nthird line');
      const before = harness.selectionStates.length;
      harness.editor.acceptDiagnosticSuggestionsResult({
        type: 'diagnosticSuggestionsResult',
        requestId: harness.requests.at(-1).requestId,
        from: 0,
        to: 9,
        result: { ok: true, value: { suggestions: ['late external result'] } }
      });
      return harness.selectionStates.slice(before);
    });
    if ((externalInvalidation as any[]).some((state) => state?.diagnosticSuggestions)) {
      throw new Error(`external presentation accepted a stale result: ${JSON.stringify(externalInvalidation)}`);
    }

    await page.click('.meo-diagnostic', { button: 'right' });
    const changedExternal = await page.evaluate(async () => {
      const harness = (window as any).__diagnosticHarness;
      const request = harness.requests.at(-1);
      const before = harness.selectionStates.length;
      harness.editor.setText('mispelled word\nsecond line\nthird line\nexternal change');
      const accepted = harness.editor.acceptDiagnosticSuggestionsResult({
        type: 'diagnosticSuggestionsResult',
        requestId: request.requestId,
        from: 0,
        to: 9,
        result: { ok: true, value: { suggestions: ['late changed result'] } }
      });
      await Promise.resolve();
      return { accepted, updates: harness.selectionStates.slice(before) };
    });
    if (changedExternal.accepted || (changedExternal.updates as any[]).some((state) => state?.diagnosticSuggestions)) {
      throw new Error(`changed external presentation accepted a stale result: ${JSON.stringify(changedExternal)}`);
    }

    await page.click('.meo-diagnostic', { button: 'right' });
    const modeInvalidation = await page.evaluate(async () => {
      const harness = (window as any).__diagnosticHarness;
      const request = harness.requests.at(-1);
      harness.editor.setMode('live');
      const accepted = harness.editor.acceptDiagnosticSuggestionsResult({
        type: 'diagnosticSuggestionsResult',
        requestId: request.requestId,
        from: 0,
        to: 9,
        result: { ok: true, value: { suggestions: ['late mode result'] } }
      });
      await Promise.resolve();
      return { accepted, states: harness.selectionStates.slice(-3) };
    });
    if (modeInvalidation.accepted || (modeInvalidation.states as any[]).some((state) => state?.diagnosticSuggestions)) {
      throw new Error(`mode change accepted a stale result: ${JSON.stringify(modeInvalidation)}`);
    }

    await page.evaluate(() => {
      const original = window.setTimeout.bind(window);
      (window as any).__diagnosticOriginalSetTimeout = window.setTimeout;
      window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: any[]) => (
        original(handler, timeout === 15_000 ? 0 : timeout, ...args)
      )) as typeof window.setTimeout;
    });
    await page.click('.meo-diagnostic', { button: 'right' });
    const timedOut = await page.evaluate(async () => {
      const harness = (window as any).__diagnosticHarness;
      const before = harness.selectionStates.length;
      await new Promise((resolve) => window.setTimeout(resolve, 20));
      window.setTimeout = (window as any).__diagnosticOriginalSetTimeout;
      return {
        updates: harness.selectionStates.slice(before),
        requestCount: harness.requests.length
      };
    });
    if ((timedOut.updates as any[]).some((state) => state?.diagnosticSuggestions)) {
      throw new Error(`timeout changed the suggestion presentation: ${JSON.stringify(timedOut)}`);
    }

    await page.click('.meo-diagnostic', { button: 'right' });
    const disposed = await page.evaluate(() => {
      const harness = (window as any).__diagnosticHarness;
      const request = harness.requests.at(-1);
      harness.editor.destroy();
      return harness.editor.acceptDiagnosticSuggestionsResult({
        type: 'diagnosticSuggestionsResult',
        requestId: request.requestId,
        from: 0,
        to: 9,
        result: { ok: true, value: { suggestions: ['late dispose result'] } }
      });
    });
    if (disposed) throw new Error('destroyed production Editor accepted a late suggestion response');

    await page.evaluate(() => {
      const states: unknown[] = [];
      const editor = (window as any).EditorStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: 'mispelled word',
        initialMode: 'source',
        initialDiagnostics: [{
          from: 0, to: 9, severity: 1, message: 'Unknown word', source: 'spell'
        }],
        onApplyChanges() {},
        onSelectionChange(state: unknown) { states.push(state); },
        postDiagnosticSuggestionsMessage() { throw new Error('post failed'); }
      });
      (window as any).__diagnosticThrowingHarness = { editor, states };
    });
    await page.waitForSelector('.meo-diagnostic');
    await page.click('.meo-diagnostic');
    await page.click('.meo-diagnostic');
    const postFailure = await page.evaluate(async () => {
      await Promise.resolve();
      const harness = (window as any).__diagnosticThrowingHarness;
      const result = {
        suggestions: harness.states.filter((state: any) => state?.diagnosticSuggestions).length,
        markerCount: document.querySelectorAll('.meo-diagnostic').length
      };
      harness.editor.destroy();
      return result;
    });
    if (postFailure.suggestions !== 0 || postFailure.markerCount !== 1) {
      throw new Error(`post failure changed production diagnostics: ${JSON.stringify(postFailure)}`);
    }
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
