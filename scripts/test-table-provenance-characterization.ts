import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-provenance-characterization-'));

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
    naming: 'characterization.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 500 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'characterization.js') });

    const baseText = '| A     |\n| ----- |\n| one   |\n| two   |\n| three |';
    await page.evaluate((text) => {
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      editor.setGitBaseline({ available: true, tracked: true, mode: 'current-edit', baseText: text });
      (window as any).__tableProvenanceLegacyEditor = editor;
    }, baseText);
    await waitForFrames(page);

    await page.click('tbody tr:first-child td:first-child textarea');
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>('button[title="Insert row below"]')!
        .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
    });
    await waitForFrames(page);
    const addedMarkerCount = () => page.evaluate(() => (
      document.querySelectorAll('.meo-md-html-table-diff-marker.is-added').length
    ));
    assert.equal(await addedMarkerCount(), 1);

    assert.equal(await page.evaluate(() => (window as any).__tableProvenanceLegacyEditor.undo()), true);
    await waitForFrames(page);
    assert.equal(await addedMarkerCount(), 0);

    assert.equal(await page.evaluate(() => (window as any).__tableProvenanceLegacyEditor.redo()), true);
    await waitForFrames(page);
    assert.equal(await addedMarkerCount(), 1);

    const refreshed = await page.evaluate(() => {
      const editor = (window as any).__tableProvenanceLegacyEditor;
      const current = editor.getText();
      editor.setGitBaseline({ available: true, tracked: true, mode: 'current-edit', baseText: current });
      return current;
    });
    await waitForFrames(page);
    assert.match(refreshed, /\|\s*\|/);
    assert.equal(await addedMarkerCount(), 0);

    await page.evaluate(() => {
      const editor = (window as any).__tableProvenanceLegacyEditor;
      editor.setText('| B |\n| --- |\n| external |');
      editor.destroy();
    });
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Legacy table provenance Chromium characterization passed');
}

await main();
