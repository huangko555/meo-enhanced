import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-empty-quote-caret-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(root, 'scripts', 'test-list-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><style>html,body{margin:0}#host{width:680px;height:400px}</style><div id="host"></div>');
    await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root{--meo-background:#fff;--meo-foreground:#24292f;--meo-font-live:Arial;--meo-font-live-size:16px;--meo-semantic-blockquoteBorder:#888;--meo-semantic-blockquoteForeground:#555;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px}' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const settle = () => page.evaluate(async () => {
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });

    for (const quote of ['> text', '> ', '>', '> > ', '>>', '> > > ', '>>>', '> > > > ', '>   >  ', '  >\t>\t']) {
      await page.evaluate((quote) => {
        const editor = (window as any).ListEditingHarness.createEditor({
          parent: document.getElementById('host')!,
          text: `Before\n\n${quote}\n\nAfter`, initialMode: 'live', onApplyChanges() {}
        });
        (window as any).__quoteEditor = editor;
        editor.focus();
      }, quote);
      await settle();
      try {
        for (let click = 0; click < 2; click += 1) {
          const point = await page.evaluate(() => {
            const line = document.querySelectorAll<HTMLElement>('#host .cm-line')[2]!;
            const rect = line.getBoundingClientRect();
            return { x: rect.left + 200, y: (rect.top + rect.bottom) / 2 };
          });
          await page.mouse.click(point.x, point.y);
          await settle();
          const result = await page.evaluate(() => {
            const editor = (window as any).__quoteEditor;
            const line = editor.view.state.doc.line(3);
            return { head: editor.view.state.selection.main.head, expected: line.to };
          });
          assert.equal(result.head, result.expected, `click ${click + 1} in ${JSON.stringify(quote)} must reach the quoted content start`);
        }
        const markerClick = await page.evaluate(() => {
          const editor = (window as any).__quoteEditor;
          const marker = document.querySelector<HTMLElement>('#host .meo-md-quote-marker-active')!;
          const rect = marker.getBoundingClientRect();
          const x = rect.left + 1;
          const y = (rect.top + rect.bottom) / 2;
          return { x, y, expected: editor.view.posAtCoords({ x, y }) };
        });
        await page.mouse.click(markerClick.x, markerClick.y);
        await settle();
        const markerHead = await page.evaluate(() => (window as any).__quoteEditor.view.state.selection.main.head);
        assert.equal(markerHead, markerClick.expected, `clicking a visible marker in ${JSON.stringify(quote)} must preserve the clicked position`);
        await page.mouse.move(markerClick.x, markerClick.y);
        await page.mouse.down();
        const dragEnd = await page.evaluate(() => {
          const line = document.querySelectorAll<HTMLElement>('#host .cm-line')[4]!;
          const rect = line.getBoundingClientRect();
          return { x: rect.left + 200, y: (rect.top + rect.bottom) / 2 };
        });
        await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 5 });
        const dragged = await page.evaluate(() => {
          const selection = (window as any).__quoteEditor.view.state.selection.main;
          return { anchor: selection.anchor, head: selection.head, empty: selection.empty };
        });
        await page.mouse.up();
        await settle();
        const released = await page.evaluate(() => {
          const selection = (window as any).__quoteEditor.view.state.selection.main;
          return { anchor: selection.anchor, head: selection.head, empty: selection.empty };
        });
        assert.equal(dragged.empty, false, `dragging from ${JSON.stringify(quote)} to the next paragraph must select text`);
        assert.deepEqual(released, dragged, 'releasing a drag must preserve its selection');
        await page.evaluate(() => {
          const editor = (window as any).__quoteEditor;
          editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(1).to } });
        });
        await page.keyboard.down('Shift');
        await page.mouse.click(markerClick.x + 200, markerClick.y);
        await page.keyboard.up('Shift');
        await settle();
        const extended = await page.evaluate(() => {
          const editor = (window as any).__quoteEditor;
          return { anchor: editor.view.state.selection.main.anchor, empty: editor.view.state.selection.main.empty,
            expected: editor.view.state.doc.line(1).to };
        });
        assert.equal(extended.anchor, extended.expected, 'Shift-click must preserve the original anchor');
        assert.equal(extended.empty, false, 'Shift-click must extend the selection');
        await page.evaluate(() => (window as any).__quoteEditor.setMode('source'));
        await settle();
        const sourceClick = await page.evaluate(() => {
          const editor = (window as any).__quoteEditor;
          const coords = editor.view.coordsAtPos(editor.view.state.doc.line(3).from)!;
          return { x: coords.left + 1, y: (coords.top + coords.bottom) / 2,
            expected: editor.view.posAtCoords({ x: coords.left + 1, y: (coords.top + coords.bottom) / 2 }) };
        });
        await page.mouse.click(sourceClick.x, sourceClick.y);
        await settle();
        const sourceHead = await page.evaluate(() => (window as any).__quoteEditor.view.state.selection.main.head);
        assert.equal(sourceHead, sourceClick.expected, 'Source mode must retain ordinary coordinate placement');
        assert.equal(await page.evaluate(() => (window as any).__quoteEditor.getText()), `Before\n\n${quote}\n\nAfter`, 'pointer interactions must not alter the quote');
      } finally {
        await page.evaluate(() => (window as any).__quoteEditor.destroy());
      }
    }
    console.log('empty quote caret Chromium checks passed: nesting, whitespace, repeated clicks, markers, dragging, Shift-click and Source mode');
  } finally {
    await browser.close();
  }
}

await main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
