import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-search-overview-'));

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
    await page.setViewport({ width: 900, height: 420 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: `
      :root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-inset-background:#2a2d2f; }
      html, body, #app { height: 100%; margin: 0; }
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const waitFrames = async (count = 6) => {
        for (let index = 0; index < count; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      const before = Array.from({ length: 18 }, (_, index) => `before ${index + 1}`);
      const rows = Array.from({ length: 10 }, (_, index) => (
        `| ${index + 1} | ${index === 7 ? 'overview-needle' : `row ${index + 1}`} |`
      ));
      const after = Array.from({ length: 36 }, (_, index) => `after ${index + 1}`);
      const editor = (window as any).TableStabilityHarness.createEditor({
        parent: document.getElementById('app')!,
        text: [...before, '', '| A | B |', '| --- | --- |', ...rows, '', ...after].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      await waitFrames();

      const tableRows = Array.from(document.querySelectorAll<HTMLTableRowElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table) tbody tr'
      ));
      tableRows[3].style.height = '220px';
      window.dispatchEvent(new Event('resize'));
      await waitFrames();
      editor.setSearchQuery('overview-needle');
      await waitFrames();

      const matchedRow = tableRows[7];
      const scroller = editor.view.scrollDOM as HTMLElement;
      const ruler = document.querySelector<HTMLElement>('.meo-search-overview-ruler')!;
      const marker = ruler.querySelector<HTMLElement>('.meo-search-overview-ruler-marker')!;
      const scrollRect = scroller.getBoundingClientRect();
      const rowRect = matchedRow.getBoundingClientRect();
      const rowTop = scroller.scrollTop + rowRect.top - scrollRect.top;
      const expectedTop = Math.round((rowTop / scroller.scrollHeight) * ruler.clientHeight);
      const actualTop = Number.parseFloat(marker.style.top);
      const state = {
        expectedTop,
        actualTop,
        delta: Math.abs(expectedTop - actualTop),
        scrollHeight: scroller.scrollHeight,
        trackHeight: ruler.clientHeight
      };
      editor.destroy();
      return state;
    });

    if (result.delta > 2) {
      throw new Error(`Search overview marker did not follow rendered row geometry: ${JSON.stringify(result)}`);
    }
    console.log('search overview ruler checks passed');
  } finally {
    await browser.close();
  }
}

main()
  .finally(() => fs.rmSync(tempDir, { recursive: true, force: true }))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
