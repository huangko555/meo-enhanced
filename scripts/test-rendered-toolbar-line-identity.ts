import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { runHistoryRenderedBlockChromiumInteraction } from './history-rendered-block-interaction-chromium';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-toolbar-line-identity-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts/test-mermaid-editing-entry.ts')],
    outdir: tempDir, target: 'browser', format: 'iife', naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  try {
    for (const kind of ['mermaid', 'math'] as const) {
      for (const mode of ['source', 'split', 'preview'] as const) {
        const page = await browser.newPage();
        try {
          await page.setViewport({ width: 920, height: 600 });
          await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
          await page.addStyleTag({ path: path.join(repoRoot, 'webview/src/styles.css') });
          await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
          await page.evaluate((renderer) => {
            (window as any).mermaid = {
              initialize() {},
              async render() { return { svg: '<svg width="360" height="140"></svg>' }; }
            };
            const block = renderer === 'mermaid'
              ? ['```mermaid', 'graph TD', 'A-->B', '```']
              : ['$$', 'x^2', '$$'];
            (window as any).__historyMatrixEditor = (window as any).MermaidEditingHarness.createEditor({
              parent: document.getElementById('app'),
              text: ['x', ...Array.from({ length: 100 }, () => 'gap'), '', ...block].join('\n'),
              initialMode: 'live', onApplyChanges() {}
            });
          }, kind);
          await runHistoryRenderedBlockChromiumInteraction(page,
            { kind, lineNumber: 103, targetMode: mode }, '__historyMatrixEditor');
          const originalLength = await page.evaluate(() => {
            const editor = (window as any).__historyMatrixEditor;
            editor.revealSelection(0, 1, { focusEditor: true, align: 'upper' });
            return editor.getText().length;
          });
          // Equal length keeps block offsets unchanged while its line identity changes.
          await page.keyboard.press('Enter');
          // Leave the previous hover point before approaching the relocated
          // control; a same-coordinate mouse move need not produce pointerenter.
          await page.mouse.move(0, 0);
          const shiftedLength = await page.evaluate(() => (window as any).__historyMatrixEditor.getText().length);
          assert.equal(shiftedLength, originalLength);
          await runHistoryRenderedBlockChromiumInteraction(page,
            { kind, lineNumber: 104, targetMode: mode === 'split' ? 'source' : 'split' }, '__historyMatrixEditor');
          assert.equal(await page.evaluate(async () => (window as any).__historyMatrixEditor.undo()), true);
          await runHistoryRenderedBlockChromiumInteraction(page,
            { kind, lineNumber: 103, targetMode: mode }, '__historyMatrixEditor');
        } finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }
  console.log('Rendered toolbar line identity survives equal-length edits and undo in all block modes');
}

await main().finally(() => fs.rmSync(tempDir, { recursive: true, force: true }));
