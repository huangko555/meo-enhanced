import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-diff-refresh-'));

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
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const state = await page.evaluate(async () => {
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: '| A |\n| --- |\n| one |\n| changed |\n| three |',
        initialMode: 'live',
        onApplyChanges() {}
      });
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      editor.setGitBaseline({
        available: true,
        tracked: true,
        mode: 'current-edit',
        baseText: '| A |\n| --- |\n| one |\n| old |\n| three |'
      });
      for (let frame = 0; frame < 10; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const result = {
        rows: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table-diff-marker')).map((marker) => ({
          from: marker.dataset.meoLiveBlockStartLine,
          to: marker.dataset.meoLiveBlockEndLine,
          modified: marker.classList.contains('is-modified')
        })),
        renderedRows: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table tbody tr'), (row) => row.dataset.sourceLineNumber)
      };
      editor.destroy();
      return result;
    });
    if (JSON.stringify(state.rows) !== JSON.stringify([{ from: '4', to: '4', modified: true }])) {
      throw new Error(`Table diff refresh lost row markers: ${JSON.stringify(state)}`);
    }
    console.log('table diff refresh regression passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
