import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-body-history-'));
const build = await Bun.build({
  entrypoints: [path.join(repoRoot, 'scripts/test-table-body-history-shortcut-entry.ts')],
  outdir, target: 'browser', format: 'iife', naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 600, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
  await page.addScriptTag({ path: path.join(outdir, 'bundle.js') });

  const key = async (letter: 'z' | 'y') => {
    await page.keyboard.down('Control');
    await page.keyboard.press(letter);
    await page.keyboard.up('Control');
    await new Promise((resolve) => setTimeout(resolve, 350));
  };

  for (const kind of ['header', 'cell'] as const) {
    const text = [
      ...Array.from({ length: 8 }, (_, i) => `Before ${i}`),
      '| Header #EF4444 | Value |',
      '| --- | --- |',
      '| Body | #EF4444 |',
      ...Array.from({ length: 130 }, (_, i) => `After ${i}`)
    ].join('\n');
    await page.evaluate(async (fixture) => {
      (window as any).__editor?.destroy();
      document.getElementById('app')!.replaceChildren();
      const harness = (window as any).TableBodyHistoryHarness;
      const editor = harness.createEditor({
        parent: document.getElementById('app')!, initialMode: 'live', text: fixture, onApplyChanges() {}
      });
      (window as any).__editor = editor;
      (window as any).__fallbackCount = 0;
      const onShortcut = (event: KeyboardEvent) => harness.handleEditorShortcut(event, {
        editor, editableMode: 'live', editorSurfaceActive: true,
        requestSave() {}, openFindPanel() {}, requestMode() {}
      });
      (window as any).__onShortcut && window.removeEventListener('keydown', (window as any).__onShortcut, true);
      (window as any).__onFallback && document.removeEventListener('keydown', (window as any).__onFallback, true);
      const onFallback = (event: KeyboardEvent) => {
        if (!event.ctrlKey || event.defaultPrevented || !['z', 'y'].includes(event.key.toLowerCase())) return;
        // VS Code's TextDocument undo/redo can sync text without Editor History navigation.
        const source = editor.view.state.doc.toString();
        editor.setText(event.key.toLowerCase() === 'z'
          ? source.replace('#F04346', '#EF4444')
          : source.replace('#EF4444', '#F04346'));
        (window as any).__fallbackCount += 1;
        event.preventDefault();
      };
      window.addEventListener('keydown', onShortcut, true);
      document.addEventListener('keydown', onFallback, true);
      (window as any).__onShortcut = onShortcut;
      (window as any).__onFallback = onFallback;
      for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, text);

    const targetLine = kind === 'header' ? 9 : 11;
    await page.click(`${kind === 'header' ? 'thead' : 'tbody'} button.meo-md-color-swatch-interactive[data-color-value="#EF4444"]`);
    await page.evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value')!;
      input.value = '#F04346';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('.meo-hex-color-adjustment-apply');

    const moveAwayAndLoseFocus = async () => page.evaluate(async () => {
      const view = (window as any).__editor.view;
      view.contentDOM.focus({ preventScroll: true });
      view.contentDOM.blur();
      view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
      for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      view.scrollDOM.scrollTop = view.scrollDOM.scrollHeight;
      for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    const capture = () => page.evaluate((lineNumber) => {
      const editor = (window as any).__editor;
      const view = editor.view;
      const input = document.querySelector<HTMLTextAreaElement>(
        `tr[data-source-line-number="${lineNumber}"] textarea[data-table-col="${lineNumber === 9 ? 0 : 1}"]`
      );
      const viewport = view.scrollDOM.getBoundingClientRect();
      const rect = input?.getBoundingClientRect();
      return {
        line: view.state.doc.line(lineNumber).text,
        active: document.activeElement?.tagName,
        visible: Boolean(rect && rect.top < viewport.bottom && rect.bottom > viewport.top),
        fallbackCount: (window as any).__fallbackCount,
        scrollTop: view.scrollDOM.scrollTop
      };
    }, targetLine);

    await moveAwayAndLoseFocus();
    const beforeUndo = await capture();
    assert.equal(beforeUndo.active, 'BODY');
    assert.equal(beforeUndo.visible, false, `${kind}: target remained visible at scrollTop ${beforeUndo.scrollTop}`);
    await key('z');
    const afterUndo = await capture();
    assert.match(afterUndo.line, /#EF4444/);
    assert.equal(afterUndo.fallbackCount, 0, `${kind}: host fallback handled Undo`);
    assert.equal(afterUndo.visible, true, `${kind}: Undo changed text without revealing table target`);

    await moveAwayAndLoseFocus();
    const beforeRedo = await capture();
    assert.equal(beforeRedo.active, 'BODY');
    assert.equal(beforeRedo.visible, false);
    await key('y');
    const afterRedo = await capture();
    assert.match(afterRedo.line, /#F04346/);
    assert.equal(afterRedo.fallbackCount, 0, `${kind}: host fallback handled Redo`);
    assert.equal(afterRedo.visible, true, `${kind}: Redo changed text without revealing table target`);
    console.log(`${kind}: detached-focus Undo/Redo revealed the edited table row`);
  }
  await page.close();
} finally {
  await browser.close();
  fs.rmSync(outdir, { recursive: true, force: true });
}
