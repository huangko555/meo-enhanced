import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-editor-history-production-'));

async function waitForFrames(page: any, count = 8): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'production.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 460, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'production.js') });
    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg width="320" height="120"><text>${text.length}</text></svg>` };
        }
      };
      const text = Array.from({ length: 90 }, (_, index) => `production history line ${index + 1}`).join('\n');
      (window as any).__historyProductionEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'source',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    const publicReplay = await page.evaluate(async () => {
      const editor = (window as any).__historyProductionEditor;
      const view = editor.view;
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: ' PUBLIC_EDIT' }, selection: { anchor: end + 12 } });
      const replay = editor.undo();
      const promiseLike = typeof replay?.then === 'function';
      const applied = await replay;
      return {
        promiseLike,
        applied,
        text: view.state.doc.toString(),
        focused: view.hasFocus,
        head: view.state.selection.main.head
      };
    });
    assert.equal(publicReplay.promiseLike, true, 'public undo must return the Runtime completion Promise');
    assert.equal(publicReplay.applied, true);
    assert.equal(publicReplay.text.includes('PUBLIC_EDIT'), false);
    assert.equal(publicReplay.focused, true);
    assert.equal(publicReplay.head, publicReplay.text.length);

    const keymapConsumed = await page.evaluate(() => {
      const editor = (window as any).__historyProductionEditor;
      const view = editor.view;
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: ' KEYMAP_EDIT' }, selection: { anchor: end + 12 } });
      view.focus();
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'z'
      });
      const dispatched = view.contentDOM.dispatchEvent(event);
      return !dispatched && event.defaultPrevented;
    });
    assert.equal(keymapConsumed, true, 'keymap runner must synchronously consume the browser event');
    await waitForFrames(page);
    assert.equal(
      await page.evaluate(() => (window as any).__historyProductionEditor.getText().includes('KEYMAP_EDIT')),
      false
    );

    while (await page.evaluate(() => (window as any).__historyProductionEditor.undo())) {
      // Exhaust native history through the public asynchronous contract.
    }
    const boundaryConsumed = await page.evaluate(() => {
      const editor = (window as any).__historyProductionEditor;
      const event = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        key: 'z'
      });
      const dispatched = editor.view.contentDOM.dispatchEvent(event);
      return !dispatched && event.defaultPrevented;
    });
    assert.equal(boundaryConsumed, true, 'native no-op boundary must still be consumed synchronously');
    await waitForFrames(page);
    assert.equal(await page.evaluate(() => (window as any).__historyProductionEditor.undo()), false);

    const frozenFingerprint = await page.evaluate(async () => {
      const previous = (window as any).__historyProductionEditor;
      previous.destroy();
      document.getElementById('app')!.replaceChildren();
      const editor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: ['```mermaid', 'graph TD', 'A --> B', '```'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__historyProductionEditor = editor;
      return true;
    });
    assert.equal(frozenFingerprint, true);
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    const positions = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')! as any;
      const innerView = block.__meoMermaidEditingController.innerView;
      const before = innerView.state.doc.length;
      innerView.dispatch({ changes: { from: before, insert: '\nC --> D' }, selection: { anchor: before + 8 } });
      return { before, after: before + 8 };
    });
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page, 2);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);

    const readBlock = () => page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
      return {
        split: Boolean(block?.classList.contains('is-split')),
        source: Boolean(block?.classList.contains('is-source')),
        head: innerView?.state.selection.main.head ?? null,
        focused: innerView?.hasFocus ?? false
      };
    });
    await page.evaluate(() => (window as any).__historyProductionEditor.undo());
    await waitForFrames(page);
    const previewUndo = await readBlock();
    await page.evaluate(() => (window as any).__historyProductionEditor.redo());
    await waitForFrames(page);
    const splitRedo = await readBlock();
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.evaluate((offset) => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')! as any;
      block.__meoMermaidEditingController.focusOffset(offset);
    }, positions.after);
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await waitForFrames(page);
    const sourceUndo = await readBlock();
    await page.keyboard.down('Control');
    await page.keyboard.press('y');
    await page.keyboard.up('Control');
    await waitForFrames(page);
    const sourceRedo = await readBlock();

    assert.deepEqual({ positions, previewUndo, splitRedo, sourceUndo, sourceRedo }, {
      positions: { before: 16, after: 24 },
      previewUndo: { split: true, source: false, head: 16, focused: true },
      splitRedo: { split: true, source: false, head: 24, focused: true },
      sourceUndo: { split: true, source: false, head: 16, focused: true },
      sourceRedo: { split: true, source: false, head: 24, focused: true }
    });

    await page.evaluate(() => (window as any).__historyProductionEditor.destroy());
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Editor History production Chromium trace passed with frozen LEG-TEST-001 fingerprint');
}

await main();
