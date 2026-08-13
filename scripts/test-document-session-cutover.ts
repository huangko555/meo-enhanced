import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { darkBuiltInVisuals } from '../src/shared/builtInVisualBaseline';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-document-session-cutover-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-document-session-cutover-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'candidate.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><body><div id="editor"></div></body>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });
    await page.evaluate((theme) => {
      (window as any).__documentSessionCandidate.initialize({
        type: 'init',
        documentId: 'file:///candidate.md',
        text: 'alpha',
        version: 1,
        savedRevision: { version: 1, text: 'alpha' },
        diagnostics: [],
        mode: 'source',
        previewAppearance: 'dark',
        previewSourceColoring: true,
        editorAppearance: 'dark',
        lineNumbers: true,
        gitChangesGutter: false,
        gitDiffLineHighlights: false,
        diffBaselineMode: 'current-edit',
        fixedBaselinePinned: false,
        fixedBaselineActive: false,
        contentMaxWidthEnabled: false,
        longCodeBlockFoldingEnabled: true,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right',
        outlineVisible: false,
        outlineWidth: 260,
        vscodeTheme: null
      });
    }, darkBuiltInVisuals);
    await page.waitForSelector('.cm-editor');

    const initial = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(initial.syncOwner, 'document-session');
    assert.equal(initial.coordinatorStarts, 1);
    assert.equal(initial.legacyCoordinatorStarts, 0);
    assert.equal(initial.editorText, 'alpha');

    await page.click('.cm-content');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('local-one');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());

    let snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.hostRevision.text, 'alpha\nlocal-one');
    assert.equal(snapshot.persistedDraft, null);

    await page.evaluate(() => (window as any).__documentSessionCandidate.holdApplyChanges(true));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('local-two');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    await page.evaluate(() => (window as any).__documentSessionCandidate.externalChange('remote\nalpha\nlocal-one'));
    await page.evaluate(() => (window as any).__documentSessionCandidate.releaseApplyChanges());

    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, 'remote\nalpha\nlocal-one\nlocal-two');
    assert.equal(snapshot.hostRevision.text, snapshot.editorText);
    assert.equal(snapshot.persistedDraft, null);

    await page.evaluate(() => (window as any).__documentSessionCandidate.save());
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.savedText, snapshot.editorText);
    assert.equal(snapshot.messages.some((message: any) => message.type === 'saveDocument'), false);
    assert.equal(snapshot.messages.some((message: any) => message.type === 'saveDocumentRevision'), true);

    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('after-save');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    const savedBeforeFailure = snapshot.savedText;
    await page.evaluate(() => {
      (window as any).__documentSessionCandidate.failNextSave();
      return (window as any).__documentSessionCandidate.save();
    });
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.savedText, savedBeforeFailure);
    assert.equal(snapshot.editorText.endsWith('after-save'), true);

    await page.evaluate(() => (window as any).__documentSessionCandidate.holdApplyChanges(true));
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('protected-draft');
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    await page.evaluate(() => {
      const candidate = (window as any).__documentSessionCandidate;
      const current = candidate.snapshot();
      candidate.failRevisionRequests(2);
      return candidate.replay(current.hostRevision.version, 'contradictory replay');
    });
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText.endsWith('protected-draft'), true);
    assert.equal(snapshot.persistedDraft.endsWith('protected-draft'), true);
    assert.deepEqual(snapshot.notices, ['Could not resynchronize the document. Local edits were kept.']);
    await page.evaluate(() => (window as any).__documentSessionCandidate.releaseApplyChanges());

    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    const beforeStaleReplay = snapshot.editorText;
    await page.evaluate(() => {
      const candidate = (window as any).__documentSessionCandidate;
      const current = candidate.snapshot();
      return candidate.replay(current.hostRevision.version - 1, 'stale text');
    });
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, beforeStaleReplay);

    await page.evaluate(() => (window as any).__documentSessionCandidate.discard());
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, savedBeforeFailure);
    assert.equal(snapshot.hostRevision.text, savedBeforeFailure);
    assert.equal(snapshot.persistedDraft, null);
    assert.equal(snapshot.coordinatorStarts, 1);
    assert.equal(snapshot.legacyCoordinatorStarts, 0);

    console.log('Document Session candidate cutover browser trace passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
