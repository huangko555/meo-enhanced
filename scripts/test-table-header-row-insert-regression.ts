import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-header-row-insert-'));

async function main(): Promise<void> {
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
    await page.setViewport({ width: 1000, height: 700 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const lines = Array.from({ length: 27 }, (_, index) => `line ${index + 1}`);
      lines[24] = '---';
      lines[25] = '';
      lines[26] = '';
      lines.push(
        '| 类型 | | 类型 |  |  | 内容 | 备注 |',
        '| --- | --- | --- | --- | --- |',
        '|  |  |  |  |  |  |  |',
        '|  |  |  |  |  |  |  |',
        '| 链接 |  |  | [VS Code](https://code.visualstudio.com/) | #table/tag |',
        '| 强调 |  |  | **粗体**、*斜体*、~~删除线~~ | `inline code` |'
      );
      const editor = harness.createEditor({
        parent: document.getElementById('app')!,
        text: lines.join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      const waitUntil = async (predicate: () => boolean, label: string) => {
        const deadline = performance.now() + 5_000;
        while (!predicate()) {
          if (performance.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      await waitUntil(() => Boolean(document.querySelector('.meo-md-html-table-shell')), 'table');

      for (const lineNumber of [25, 22]) {
        const position = editor.view.state.doc.line(lineNumber).to;
        editor.view.dispatch({ changes: { from: position, insert: '字' } });
        await waitUntil(() => editor.view.state.doc.line(lineNumber).text.endsWith('字'), `line ${lineNumber} edit`);
      }

      const headerInput = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-shell thead textarea'
      )!;
      headerInput.focus();
      headerInput.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      const trigger = document.querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger')!;
      trigger.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      const insertBelow = document.querySelector<HTMLButtonElement>(
        '.meo-md-html-table-context-btn[data-command="insert-row-below"]'
      )!;
      insertBelow.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true, cancelable: true }));
      await waitUntil(() => editor.view.state.doc.lines === lines.length + 1, 'inserted row');

      const text = editor.view.state.doc.toString();
      const tableLines = text.split('\n').slice(27, 33);
      editor.destroy();
      return { text, tableLines };
    });

    assert.match(
      result.tableLines.slice(0, 3).join('\n'),
      /^\| 类型 .*\n\| --- .*\n\|\s+\|/,
      `A row inserted below a selected header must stay below the delimiter:\n${result.tableLines.join('\n')}`
    );
    console.log('Table header row-insert regression passed.');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
