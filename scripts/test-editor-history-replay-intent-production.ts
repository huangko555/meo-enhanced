import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { darkBuiltInVisuals } from '../src/shared/builtInVisualBaseline';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-history-replay-intent-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-document-session-cutover-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'production.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 420, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#editor{height:100%;margin:0}</style><div id="editor"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'production.js') });

    const initialText = Array.from({ length: 120 }, (_, index) => `history replay line ${index + 1}`).join('\n');
    await page.evaluate(({ text, theme }) => {
      (window as any).__documentSessionCandidate.initialize({
        type: 'init',
        documentId: 'file:///history-replay-intent.md',
        text,
        version: 1,
        savedRevision: { version: 1, text },
        diagnostics: [],
        mode: 'source',
        uiLanguage: 'en',
        previewAppearance: 'dark',
        previewFontFamily: '',
        previewSourceColoring: true,
        editorAppearance: 'dark',
        gitChangesGutter: false,
        gitDiffLineHighlights: false,
        diffBaselineMode: 'current-edit',
        fixedBaselinePinned: false,
        fixedBaselineActive: false,
        contentMaxWidthEnabled: false,
        findOptions: { wholeWord: false, caseSensitive: false },
        outlinePosition: 'right',
        outlineVisible: false,
        outlineWidth: 260,
        vscodeTheme: null
      });
    }, { text: initialText, theme: darkBuiltInVisuals });
    await page.waitForSelector('.cm-editor');
    await page.click('.cm-content');
    await page.keyboard.down('Control');
    await page.keyboard.press('End');
    await page.keyboard.up('Control');

    const additions = 'abcdefghijklmnopqrst';
    for (const addition of additions) {
      await page.keyboard.type(addition);
      await new Promise((resolve) => setTimeout(resolve, 550));
      await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    }

    let snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, initialText + additions);
    assert.equal(snapshot.hostRevision.text, initialText + additions);
    assert.equal(snapshot.hostRevision.version, 21);
    assert.equal(snapshot.focused, true);

    await page.keyboard.down('Control');
    try {
      for (let index = additions.length - 1; index >= 0; index -= 1) {
        await page.keyboard.down('z');
        const expected = initialText + additions.slice(0, index);
        await page.waitForFunction((text) => (
          (window as any).__documentSessionCandidate.snapshot().hostRevision.text === text
        ), {}, expected);
      }
      await page.keyboard.up('z');
    } finally {
      await page.keyboard.up('Control');
    }

    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, initialText);
    assert.equal(snapshot.hostRevision.text, initialText);
    assert.equal(snapshot.hostRevision.version, 41);
    assert.equal(snapshot.focused, true);

    await page.keyboard.down('Control');
    try {
      for (let count = 1; count <= additions.length; count += 1) {
        await page.keyboard.down('y');
        const expected = initialText + additions.slice(0, count);
        await page.waitForFunction((text) => (
          (window as any).__documentSessionCandidate.snapshot().hostRevision.text === text
        ), {}, expected);
      }
      await page.keyboard.up('y');
    } finally {
      await page.keyboard.up('Control');
    }

    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, initialText + additions);
    assert.equal(snapshot.hostRevision.text, initialText + additions);
    assert.equal(snapshot.hostRevision.version, 61);
    assert.equal(snapshot.focused, true);

    const redoCaretProbe = 'Q';
    await page.keyboard.type(redoCaretProbe);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, initialText + additions + redoCaretProbe);
    assert.equal(snapshot.hostRevision.text, initialText + additions + redoCaretProbe);
    assert.equal(snapshot.hostRevision.version, 62);
    assert.equal(await page.evaluate(() => (window as any).__documentSessionCandidate.undo()), true);
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, initialText + additions);
    assert.equal(snapshot.hostRevision.text, initialText + additions);
    assert.equal(snapshot.hostRevision.version, 63);

    const lateRestore = await page.evaluate(async () => {
      const candidate = (window as any).__documentSessionCandidate;
      const scroller = document.querySelector<HTMLElement>('.cm-scroller')!;
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
      const applied = await candidate.undo();

      // This wheel is newer than the replay. Any RAF/layout work retained by the
      // replay must not reveal the old target again.
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -120 }));
      const scrollSamples: number[] = [scroller.scrollTop];
      for (let frame = 0; frame < 8; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        scrollSamples.push(scroller.scrollTop);
      }
      await candidate.whenIdle();
      return {
        applied,
        scrollSamples,
        snapshot: candidate.snapshot()
      };
    });

    assert.equal(lateRestore.applied, true);
    assert.equal(lateRestore.snapshot.editorText, initialText + additions.slice(0, -1));
    assert.equal(lateRestore.snapshot.hostRevision.text, initialText + additions.slice(0, -1));
    assert.equal(lateRestore.snapshot.hostRevision.version, 64);
    assert.equal(lateRestore.snapshot.focused, true);
    assert.ok(
      lateRestore.scrollSamples.every((scrollTop: number) => scrollTop < 1),
      `older replay restore overrode the newer wheel interaction: ${JSON.stringify(lateRestore.scrollSamples)}`
    );

    const lateCaretProbe = 'R';
    await page.keyboard.type(lateCaretProbe);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await page.evaluate(() => (window as any).__documentSessionCandidate.whenIdle());
    snapshot = await page.evaluate(() => (window as any).__documentSessionCandidate.snapshot());
    assert.equal(snapshot.editorText, initialText + additions.slice(0, -1) + lateCaretProbe);
    assert.equal(snapshot.hostRevision.text, initialText + additions.slice(0, -1) + lateCaretProbe);
    assert.equal(snapshot.hostRevision.version, 65);

    await page.evaluate(() => (window as any).__documentSessionCandidate.destroy());
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Editor History replay intent production trace passed (20 undo + 20 redo + late interaction)');
}

await main();
