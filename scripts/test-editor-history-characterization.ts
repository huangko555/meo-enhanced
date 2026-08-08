import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-history-characterization-'));

async function waitForFrames(page: any, count = 8): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function snapshot(page: any) {
  return page.evaluate(() => {
    const editor = (window as any).__historyCharacterizationEditor;
    const view = editor.view;
    const head = view.state.selection.main.head;
    const coords = view.coordsAtPos(head);
    const viewport = view.scrollDOM.getBoundingClientRect();
    return {
      text: view.state.doc.toString(),
      head,
      focused: view.hasFocus,
      targetVisible: Boolean(coords && coords.bottom > viewport.top && coords.top < viewport.bottom),
      history: editor.getHistoryDepth()
    };
  });
}

async function typeAtDocumentEnd(page: any, text: string): Promise<void> {
  await page.evaluate(() => {
    const editor = (window as any).__historyCharacterizationEditor;
    const end = editor.view.state.doc.length;
    editor.view.dispatch({ selection: { anchor: end } });
    editor.view.focus();
  });
  await page.keyboard.type(text);
  await waitForFrames(page);
}

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 500 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const original = Array.from({ length: 100 }, (_, index) => `history line ${index + 1}`).join('\n');
    await page.evaluate((text) => {
      (window as any).__historyCharacterizationEditor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
    }, original);
    await waitForFrames(page);

    await typeAtDocumentEnd(page, ' SOURCE_EDIT');
    const sourceEdited = await snapshot(page);
    if (!sourceEdited.text.endsWith(' SOURCE_EDIT') || sourceEdited.history.undo < 1) {
      throw new Error(`Source edit did not enter native history: ${JSON.stringify(sourceEdited)}`);
    }

    await page.evaluate(() => (window as any).__historyCharacterizationEditor.setMode('live'));
    await typeAtDocumentEnd(page, ' LIVE_EDIT');
    const liveEdited = await snapshot(page);
    if (!liveEdited.text.endsWith(' SOURCE_EDIT LIVE_EDIT') || liveEdited.history.undo < 2) {
      throw new Error(`Live edit did not continue native history: ${JSON.stringify(liveEdited)}`);
    }

    await page.evaluate(() => (window as any).__historyCharacterizationEditor.undo());
    await waitForFrames(page);
    const liveUndo = await snapshot(page);
    if (!liveUndo.text.endsWith(' SOURCE_EDIT') || liveUndo.text.includes('LIVE_EDIT') || !liveUndo.focused || !liveUndo.targetVisible) {
      throw new Error(`Live undo did not restore text/focus/viewport: ${JSON.stringify(liveUndo)}`);
    }

    await page.evaluate(() => (window as any).__historyCharacterizationEditor.setMode('source'));
    await page.evaluate(() => (window as any).__historyCharacterizationEditor.undo());
    await waitForFrames(page);
    const sourceUndo = await snapshot(page);
    if (sourceUndo.text !== original || !sourceUndo.focused || !sourceUndo.targetVisible) {
      throw new Error(`Mode switch broke Source history continuity: ${JSON.stringify(sourceUndo)}`);
    }

    await page.evaluate(() => (window as any).__historyCharacterizationEditor.redo());
    await waitForFrames(page);
    await page.evaluate(() => (window as any).__historyCharacterizationEditor.setMode('live'));
    await page.evaluate(() => (window as any).__historyCharacterizationEditor.redo());
    await waitForFrames(page);
    const crossModeRedo = await snapshot(page);
    if (!crossModeRedo.text.endsWith(' SOURCE_EDIT LIVE_EDIT') || !crossModeRedo.focused || !crossModeRedo.targetVisible) {
      throw new Error(`Mode switch broke redo continuity: ${JSON.stringify(crossModeRedo)}`);
    }

    await typeAtDocumentEnd(page, ' RAPID_EDIT');
    await page.evaluate(() => (window as any).__historyCharacterizationEditor.undo());
    await waitForFrames(page);
    const rapidUndo = await snapshot(page);
    if (rapidUndo.text.includes('RAPID_EDIT') || !rapidUndo.focused || !rapidUndo.targetVisible) {
      throw new Error(`Rapid edit undo lost text/focus/viewport: ${JSON.stringify(rapidUndo)}`);
    }

    const externalBoundary = await page.evaluate(() => {
      const editor = (window as any).__historyCharacterizationEditor;
      const text = editor.getText();
      const before = editor.getHistoryDepth();
      editor.setText(`${text}\nEXTERNAL_PRESENTATION`);
      editor.setText(text);
      return { before, after: editor.getHistoryDepth(), text: editor.getText() };
    });
    if (
      externalBoundary.text !== rapidUndo.text ||
      externalBoundary.before.undo !== externalBoundary.after.undo ||
      externalBoundary.before.redo !== externalBoundary.after.redo
    ) {
      throw new Error(`External Document presentation polluted UI history: ${JSON.stringify(externalBoundary)}`);
    }

    await page.evaluate(() => (window as any).__historyCharacterizationEditor.destroy());
    console.log('Editor history characterization checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
