import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';
import { setMermaidLayout, type MermaidTestLayout } from './history-mermaid-chromium';

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
      for (const mode of (kind === 'mermaid' ? ['stacked', 'side-by-side', 'preview'] : ['editing', 'reading']) as string[]) {
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
          const settle = async (lineNumber: number, state: string) => {
            if (kind === 'mermaid') {
              await setMermaidLayout(page, '__historyMatrixEditor', lineNumber, state as MermaidTestLayout);
              return;
            }
            await page.evaluate(lineNumber => {
              const editor = (window as any).__historyMatrixEditor;
              editor.scrollToLine(lineNumber, 'center');
              editor.revealSelection(0, 0, { focusEditor: true, align: 'none' });
            }, lineNumber);
            await page.waitForSelector('.meo-math-copy-actions');
            if (state === 'editing') {
              await page.click('.meo-md-math-fenced-display .katex');
              await page.waitForSelector('.meo-math-source-actions');
              await page.click('.meo-math-copy-actions [aria-label="Select formula source"]');
              await page.waitForSelector('.meo-math-live-result');
              assert.equal(await page.evaluate(() => {
                const view = (window as any).__historyMatrixEditor.view;
                return view.state.doc.lineAt(view.state.selection.main.from).number;
              }), lineNumber + 1, 'Relocated formula action must select the current document source');
            } else {
              assert.equal(await page.$('.meo-math-source-line'), null, 'Reading formula must hide document source');
              assert.equal(await page.$('.meo-math-copy-actions .meo-select-all-code-btn'), null,
                'Reading formula must hide source selection actions');
            }
          };
          await settle(103, mode);
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
          await settle(104, kind === 'math' ? (mode === 'editing' ? 'reading' : 'editing') : mode === 'side-by-side' ? 'stacked' : 'side-by-side');
          assert.equal(await page.evaluate(async () => (window as any).__historyMatrixEditor.undo()), true);
          await settle(103, mode);
        } finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }
  console.log('Rendered toolbar line identity survives equal-length edits and undo in all block modes');
}

await main().finally(() => fs.rmSync(tempDir, { recursive: true, force: true }));
