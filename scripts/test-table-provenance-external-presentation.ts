import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-provenance-external-'));

async function waitForFrames(page: any, count = 6): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'external-presentation.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'external-presentation.js') });

    const baseText = '| A     |\n| ----- |\n| one   |\n| two   |\n| three |';
    await page.evaluate((text) => {
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}
      });
      editor.setGitBaseline({ available: true, tracked: true, mode: 'current-edit', baseText: text });
      (window as any).__externalPresentationEditor = editor;
    }, baseText);
    await waitForFrames(page);

    await page.click('tbody tr:first-child td:first-child textarea');
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    });
    await waitForFrames(page);
    await page.click('tbody tr:first-child td:first-child textarea');
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('button[title="Delete row"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    });
    await waitForFrames(page);

    const before = await page.evaluate(() => ({
      provenance: (window as any).TableStabilityHarness.getTableProvenanceSnapshot(),
      insertedMarkers: document.querySelectorAll('.meo-md-html-table-diff-marker.is-added').length,
      deletedMarkers: document.querySelectorAll('.meo-md-html-table-diff-marker.is-deleted').length
    }));
    assert.equal(before.provenance.lifecycle, 'active');
    assert.equal(before.provenance.legacyInstalled, false);
    assert.equal(before.provenance.inserted.length, 1);
    assert.equal(before.provenance.deleted.length, 1);
    assert.equal(before.insertedMarkers, 1);
    assert.equal(before.deletedMarkers, 1);

    await page.evaluate(() => {
      const editor = (window as any).__externalPresentationEditor;
      editor.setText(editor.getText());
    });
    await waitForFrames(page);

    const afterEqualPresentation = await page.evaluate(() => (
      (window as any).TableStabilityHarness.getTableProvenanceSnapshot()
    ));
    assert.deepEqual(afterEqualPresentation.inserted, []);
    assert.deepEqual(
      afterEqualPresentation.deleted,
      [],
      'an equal-text external presentation must still invalidate the old scope'
    );

    await page.evaluate((text) => (window as any).__externalPresentationEditor.setText(text), baseText);
    await waitForFrames(page);
    const afterChangedPresentation = await page.evaluate(() => ({
      provenance: (window as any).TableStabilityHarness.getTableProvenanceSnapshot(),
      insertedMarkers: document.querySelectorAll('.meo-md-html-table-diff-marker.is-added').length,
      deletedMarkers: document.querySelectorAll('.meo-md-html-table-diff-marker.is-deleted').length
    }));
    assert.deepEqual(afterChangedPresentation.provenance.inserted, []);
    assert.deepEqual(afterChangedPresentation.provenance.deleted, []);
    assert.equal(afterChangedPresentation.insertedMarkers, 0);
    assert.equal(afterChangedPresentation.deletedMarkers, 0);

    await page.evaluate(() => (window as any).__externalPresentationEditor.destroy());
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('external Document presentation clears table provenance');
