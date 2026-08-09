import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-diagnostic-suggestion-runtime-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-diagnostic-suggestion-runtime-entry.ts')],
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
    const lines = ['mispelled alpha and typoo beta', ...Array.from({ length: 80 }, (_, index) => `line ${index}`)];
    await page.setContent('<!doctype html><style>html,body{height:100%;margin:0}#app{height:260px}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((text) => {
      const handle = (window as any).DiagnosticSuggestionCandidate.create(document.getElementById('app'), text);
      handle.setDiagnostics([
        { from: 0, to: 9, severity: 1, message: 'First unknown', source: 'spell' },
        { from: 20, to: 25, severity: 1, message: 'Second unknown', source: 'spell' }
      ]);
      (window as any).__diagnosticCandidate = handle;
    }, lines.join('\n'));
    await page.waitForSelector('.meo-diagnostic');

    const diagnostics = await page.$$('.meo-diagnostic');
    if (diagnostics.length !== 2) throw new Error(`expected two diagnostic marks, received ${diagnostics.length}`);
    await diagnostics[0].click();
    let requestCount = await page.evaluate(() => (window as any).__diagnosticCandidate.requests().length);
    if (requestCount !== 0) throw new Error(`first click requested suggestions: ${requestCount}`);
    await diagnostics[0].click();
    requestCount = await page.evaluate(() => (window as any).__diagnosticCandidate.requests().length);
    if (requestCount !== 1) throw new Error(`second click did not request once: ${requestCount}`);

    const beforePresentation = await page.evaluate(() => {
      const handle = (window as any).__diagnosticCandidate;
      const editor = document.querySelector('.cm-editor');
      const scroll = document.querySelector<HTMLElement>('.cm-scroller');
      return {
        focusInside: editor?.contains(document.activeElement) ?? false,
        selection: document.getSelection()?.toString() ?? '',
        scrollTop: scroll?.scrollTop ?? 0,
        accepted: handle.acceptSuccess(0, ['misspelled'])
      };
    });
    await page.evaluate(() => (window as any).__diagnosticCandidate.whenIdle());
    const ready = await page.evaluate(() => ({
      menuVisible: document.querySelector('.selection-inline-menu')?.classList.contains('is-visible') ?? false,
      suggestion: document.querySelector('.selection-inline-suggestion')?.textContent ?? '',
      focusInside: document.querySelector('.cm-editor')?.contains(document.activeElement) ?? false,
      selection: document.getSelection()?.toString() ?? '',
      scrollTop: document.querySelector<HTMLElement>('.cm-scroller')?.scrollTop ?? 0,
      counts: (window as any).__diagnosticCandidate.counts()
    }));
    if (!beforePresentation.accepted || !ready.menuVisible || ready.suggestion !== 'misspelled') {
      throw new Error(`success was not presented: ${JSON.stringify({ beforePresentation, ready })}`);
    }
    if (ready.focusInside !== beforePresentation.focusInside
      || ready.selection !== beforePresentation.selection
      || ready.scrollTop !== beforePresentation.scrollTop) {
      throw new Error(`menu projection changed interaction state: ${JSON.stringify({ beforePresentation, ready })}`);
    }
    if (ready.counts.legacyCoordinators !== 0
      || ready.counts.applications !== 1 || ready.counts.runtimes !== 1 || ready.counts.adapters !== 1) {
      throw new Error(`candidate instance ownership was incorrect: ${JSON.stringify(ready.counts)}`);
    }

    await diagnostics[0].click({ button: 'right' });
    requestCount = await page.evaluate(() => (window as any).__diagnosticCandidate.requests().length);
    if (requestCount !== 1) throw new Error(`presented diagnostic requested again: ${requestCount}`);

    await page.evaluate(() => {
      const handle = (window as any).__diagnosticCandidate;
      handle.setDiagnostics([{ from: 20, to: 25, severity: 1, message: 'Second unknown', source: 'spell' }]);
    });
    const hiddenAfterReplacement = await page.evaluate(() => (
      !document.querySelector('.selection-inline-menu')?.classList.contains('is-visible')
    ));
    if (!hiddenAfterReplacement) throw new Error('diagnostics replacement did not hide the suggestion menu');
    if (await page.evaluate(() => (window as any).__diagnosticCandidate.acceptSuccess(0, ['stale']))) {
      throw new Error('diagnostics replacement accepted a stale completion');
    }

    const remainingDiagnostic = await page.$('.meo-diagnostic');
    if (!remainingDiagnostic) throw new Error('replacement diagnostic mark missing');
    await remainingDiagnostic.click({ button: 'right' });
    await page.evaluate(() => (window as any).__diagnosticCandidate.externalDocumentPresented());
    await page.evaluate(() => (window as any).__diagnosticCandidate.whenIdle());
    if (await page.evaluate(() => (window as any).__diagnosticCandidate.acceptSuccess(1, ['late external']))) {
      throw new Error('external presentation accepted a stale completion');
    }

    await page.evaluate(() => {
      const handle = (window as any).__diagnosticCandidate;
      handle.setDiagnostics([
        { from: 0, to: 9, severity: 1, message: 'First unknown', source: 'spell' },
        { from: 20, to: 25, severity: 1, message: 'Second unknown', source: 'spell' }
      ]);
    });
    const refreshedDiagnostics = await page.$$('.meo-diagnostic');
    await refreshedDiagnostics[0].click({ button: 'right' });
    await refreshedDiagnostics[1].click({ button: 'right' });
    const rapid = await page.evaluate(async () => {
      const handle = (window as any).__diagnosticCandidate;
      const requests = handle.requests();
      const firstAccepted = handle.acceptSuccess(2, ['stale first']);
      const secondAccepted = handle.acceptSuccess(3, ['second ready']);
      await handle.whenIdle();
      return {
        requestCount: requests.length,
        firstAccepted,
        secondAccepted,
        suggestion: document.querySelector('.selection-inline-suggestion')?.textContent ?? ''
      };
    });
    if (rapid.requestCount !== 4 || rapid.firstAccepted || !rapid.secondAccepted || rapid.suggestion !== 'second ready') {
      throw new Error(`rapid correlation was incorrect: ${JSON.stringify(rapid)}`);
    }

    await refreshedDiagnostics[0].click({ button: 'right' });
    await page.evaluate(() => (window as any).__diagnosticCandidate.presentationChanged());
    if (await page.evaluate(() => (window as any).__diagnosticCandidate.acceptFailure(4))) {
      throw new Error('mode change accepted a stale failure');
    }

    await refreshedDiagnostics[0].click({ button: 'right' });
    await page.evaluate(async () => {
      const handle = (window as any).__diagnosticCandidate;
      await handle.whenIdle();
    });
    const timeoutState = await page.evaluate(() => (window as any).__diagnosticCandidate.state());
    if (timeoutState.pending !== null) throw new Error(`timeout did not restore idle: ${JSON.stringify(timeoutState)}`);

    await refreshedDiagnostics[1].click({ button: 'right' });
    await page.evaluate(() => (window as any).__diagnosticCandidate.dispose());
    if (await page.evaluate(() => (window as any).__diagnosticCandidate.acceptSuccess(6, ['late dispose']))) {
      throw new Error('disposed candidate accepted a late completion');
    }

    console.log('Diagnostic suggestion Runtime + CodeMirror Chromium candidate trace passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
