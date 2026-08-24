import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const entryPath = path.join(repoRoot, 'scripts', 'test-table-column-width-policy-entry.ts');
const entrySource = fs.readFileSync(entryPath, 'utf8');
assert.equal(entrySource.includes('../webview/src/editor/tableColumnWidthPolicy'), true);
assert.equal(entrySource.includes('../webview/src/editor.ts'), false);
assert.equal(entrySource.includes('../webview/src/index.ts'), false);
assert.equal(entrySource.includes('../webview/src/helpers/tables'), false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-column-width-policy-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [entryPath],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'candidate.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 600, height: 400 });
    await page.setContent(`<!doctype html>
      <style>
        #wrap { width: 300px; }
        table { border-collapse: collapse; table-layout: fixed; width: 300px; }
        th { box-sizing: border-box; min-width: 0; padding: 0; border: 0; }
      </style>
      <div id="wrap"><table><colgroup><col><col><col></colgroup>
      <thead><tr><th>A</th><th>B</th><th>C</th></tr></thead></table></div>`);
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });

    const result = await page.evaluate(() => {
      const candidate = (window as any).TableColumnWidthPolicyCandidate;
      const table = document.querySelector<HTMLTableElement>('table')!;
      const columns = Array.from(table.querySelectorAll<HTMLTableColElement>('col'));
      const measured = Array.from(table.querySelectorAll<HTMLElement>('th'))
        .map((cell) => cell.getBoundingClientRect().width);
      const resized = candidate.policy.resize({
        widths: measured,
        minimumWidths: [20, 20, 20],
        elastic: true,
        column: 0,
        requestedDelta: 150,
        maximumTotalWidth: document.getElementById('wrap')!.clientWidth
      });
      table.style.width = `${resized.totalWidth}px`;
      resized.widths.forEach((width: number, index: number) => {
        columns[index].style.width = `${width}px`;
      });
      const renderedAfterResize = Array.from(table.querySelectorAll<HTMLElement>('th'))
        .map((cell) => cell.getBoundingClientRect().width);

      const projected = candidate.policy.project({
        widths: resized.widths,
        minimumWidths: [20, 20, 20],
        preserveWidthIntent: false,
        initialTotalWidth: 360,
        elastic: true,
        defaultWidthWasCapped: false,
        availableWidth: 240
      });
      table.style.width = `${projected.totalWidth}px`;
      projected.widths.forEach((width: number, index: number) => {
        columns[index].style.width = `${width}px`;
      });
      const renderedAfterProjection = Array.from(table.querySelectorAll<HTMLElement>('th'))
        .map((cell) => cell.getBoundingClientRect().width);
      return {
        instances: candidate.instances,
        measured,
        resized: resized.widths,
        renderedAfterResize,
        projected: projected.widths,
        renderedAfterProjection
      };
    });

    assert.equal(result.instances, 1);
    assert.deepEqual(result.measured.map(Math.round), [100, 100, 100]);
    assert.deepEqual(result.resized.map(Math.round), [250, 25, 25]);
    assert.deepEqual(result.renderedAfterResize.map(Math.round), [250, 25, 25]);
    assert.deepEqual(result.projected.map(Math.round), [193, 24, 24]);
    assert.deepEqual(result.renderedAfterProjection.map(Math.round), [193, 24, 24]);
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table column width policy Chromium candidate trace passed');

