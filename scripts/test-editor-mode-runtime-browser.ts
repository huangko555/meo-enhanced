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
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><body>
      <div id="mode"></div><div id="search"></div><div id="outline"></div>
      <button id="replace"></button><div id="selection-menu"></div>
      <div id="editor"></div><div id="preview" hidden>Preview</div>
    </body>`);
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });
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

    await page.evaluate(() => (window as any).__editorModeCandidate.request('source', true));
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
      'apply:live', 'apply:source'
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
    assert.equal(snapshot.events.includes('restore:preview:27'), true, 'Preview viewport must cross the Adapter only');

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
