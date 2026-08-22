import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-mode-runtime-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-editor-mode-runtime-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'candidate.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const createPage = async () => {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><body>
      <button id="live-mode">Live</button><button id="source-mode">Source</button>
      <button id="preview-mode">Preview</button>
      <div id="mode"></div><div id="search"></div><div id="outline"></div>
      <button id="replace"></button><div id="selection-menu"></div>
      <div id="editor"></div><div id="preview" hidden>Preview</div>
    </body>`);
      await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
      await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });
      return page;
    };

    const preemptionPage = await createPage();
    await preemptionPage.evaluate(() => {
      void (window as any).__editorModeCandidate.initializeWithHeldMount();
    });
    await preemptionPage.waitForFunction(() => (
      (window as any).__editorModeCandidate.snapshot().events.includes('mount-wait:live')
    ));
    await preemptionPage.click('#source-mode');
    await preemptionPage.waitForSelector('.cm-editor');
    await preemptionPage.evaluate(() => (window as any).__editorModeCandidate.releaseMount());
    await preemptionPage.evaluate(() => (window as any).__editorModeCandidate.whenIdle());
    const preempted = await preemptionPage.evaluate(() => (window as any).__editorModeCandidate.snapshot());
    assert.equal(preempted.state.mode, 'source');
    assert.deepEqual(
      preempted.editorCreateModes,
      ['source'],
      'a stale Live mount must be aborted before production createEditor starts heavy Live resources'
    );
    assert.equal(preempted.events.includes('mount-aborted:live'), true);
    await preemptionPage.close();

    const adoptionPage = await createPage();
    await adoptionPage.evaluate(() => (window as any).__editorModeCandidate.initialize());
    await adoptionPage.waitForSelector('.cm-editor');
    const adoptionStart = await adoptionPage.evaluate(() => (
      (window as any).__editorModeCandidate.snapshot().events.length
    ));
    await adoptionPage.evaluate(() => (window as any).__editorModeCandidate.adoptAutomaticSource());
    const adopted = await adoptionPage.evaluate((start) => {
      const snapshot = (window as any).__editorModeCandidate.snapshot();
      return { ...snapshot, adoptionEvents: snapshot.events.slice(start) };
    }, adoptionStart);
    assert.equal(adopted.state.mode, 'source');
    assert.equal(adopted.editorMode, 'source');
    assert.deepEqual(
      adopted.adoptionEvents.filter((event: string) => event.startsWith('apply:')),
      ['apply:source:captured'],
      'same-tick manual adoption must reuse the queued automatic Source apply'
    );
    assert.ok(
      adopted.adoptionEvents.indexOf('apply:source:captured')
        < adopted.adoptionEvents.indexOf('persist:source:source')
    );
    assert.ok(
      adopted.adoptionEvents.indexOf('persist:source:source')
        < adopted.adoptionEvents.indexOf('post:source')
    );
    assert.match(adopted.persisted, /"mode":"source"/);
    await adoptionPage.close();

    const page = await createPage();
    await page.evaluate(() => (window as any).__editorModeCandidate.initialize());
    await page.waitForSelector('.cm-editor');

    let snapshot = await page.evaluate(() => (window as any).__editorModeCandidate.snapshot());
    assert.equal(snapshot.runtimeStarts, 1);
    assert.equal(snapshot.legacyModeCoordinatorStarts, 0);
    assert.equal(snapshot.mountAttempts, 2, 'candidate must recover one transient lazy-mount failure');
    assert.equal(snapshot.state.mode, 'live', 'local preference must win over Host Init');
    assert.equal(snapshot.state.editorMount, 'mounted');
    assert.equal(snapshot.editorMounted, true);
    assert.equal(snapshot.notices.includes('mount-retry'), true);
    assert.match(snapshot.persisted, /"mode":"live"/);
    assert.ok(snapshot.events.indexOf('persist:live:live') < snapshot.events.indexOf('post:live'));

    const originalText = snapshot.text;
    await page.evaluate(() => (window as any).__editorModeCandidate.focusEditor());
    await page.keyboard.type('history-marker');
    await page.waitForFunction(() => (
      (window as any).__editorModeCandidate.snapshot().text !== '# Editor Mode\n\nalpha\nbeta\ngamma'
    ));
    const editedText = await page.evaluate(() => (window as any).__editorModeCandidate.snapshot().text);

    await page.keyboard.down('Alt');
    await page.keyboard.down('Shift');
    await page.keyboard.press('KeyM');
    await page.keyboard.up('Shift');
    await page.keyboard.up('Alt');
    await page.evaluate(() => (window as any).__editorModeCandidate.whenIdle());
    snapshot = await page.evaluate(() => (window as any).__editorModeCandidate.snapshot());
    assert.equal(snapshot.state.mode, 'source');
    assert.equal(snapshot.editorMode, 'source');
    assert.equal(snapshot.editorVisible, true);
    assert.equal(snapshot.searchOwner, 'editor');
    assert.equal(snapshot.outlineOwner, 'editor');
    assert.equal(snapshot.replaceEnabled, true);
    assert.equal(snapshot.editorFocused, true);

    await page.evaluate(() => (window as any).__editorModeCandidate.request('live'));
    snapshot = await page.evaluate(() => (window as any).__editorModeCandidate.snapshot());
    assert.equal(snapshot.state.mode, 'source', 'incompatible Live must fall back to Source');
    assert.equal(snapshot.notices.includes('live-fallback'), true);
    assert.deepEqual(snapshot.events.filter((event: string) => event.startsWith('apply:')).slice(-2), [
      'apply:live:captured', 'apply:source:captured'
    ]);

    await page.evaluate(() => (window as any).__editorModeCandidate.request('live'));
    await page.evaluate(() => (window as any).__editorModeCandidate.request('preview'));
    snapshot = await page.evaluate(() => (window as any).__editorModeCandidate.snapshot());
    assert.equal(snapshot.state.mode, 'preview');
    assert.equal(snapshot.state.lastEditableMode, 'live');
    assert.equal(snapshot.previewVisible, true);
    assert.equal(snapshot.editorVisible, false);
    assert.equal(snapshot.searchOwner, 'preview');
    assert.equal(snapshot.outlineOwner, 'preview');
    assert.equal(snapshot.replaceEnabled, false);

    await page.evaluate(() => (window as any).__editorModeCandidate.toggle(true));
    snapshot = await page.evaluate(() => (window as any).__editorModeCandidate.snapshot());
    assert.equal(snapshot.state.mode, 'live');
    assert.equal(snapshot.editorVisible, true);
    assert.equal(snapshot.editorFocused, true);
    assert.equal(
      snapshot.events.includes('apply:live:captured'),
      true,
      'opaque viewport token must share the editable-mode transaction'
    );

    await page.evaluate(() => (window as any).__editorModeCandidate.undo());
    snapshot = await page.evaluate(() => (window as any).__editorModeCandidate.snapshot());
    assert.equal(snapshot.text, originalText, 'mode round-trips must not enter native document history');
    await page.evaluate(() => (window as any).__editorModeCandidate.redo());
    snapshot = await page.evaluate(() => (window as any).__editorModeCandidate.snapshot());
    assert.equal(snapshot.text, editedText, 'redo must remain continuous after UI, keyboard, and public setMode paths');

    await page.evaluate(() => {
      const candidate = (window as any).__editorModeCandidate;
      return Promise.all([candidate.request('source'), candidate.request('preview')]);
    });
    snapshot = await page.evaluate(() => (window as any).__editorModeCandidate.snapshot());
    assert.equal(snapshot.state.mode, 'preview', 'rapid inputs must keep serialized order');

    await page.evaluate(() => (window as any).__editorModeCandidate.dispose());
    await page.evaluate(() => (window as any).__editorModeCandidate.request('source'));
    snapshot = await page.evaluate(() => (window as any).__editorModeCandidate.snapshot());
    assert.equal(snapshot.disposed, true);
    assert.equal(snapshot.state.lifecycle, 'disposed');
    assert.equal(snapshot.events.filter((event: string) => event === 'dispose').length, 1);
    assert.deepEqual(snapshot.errors, []);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Editor Mode Chromium + CodeMirror candidate trace passed');
}

await main();
