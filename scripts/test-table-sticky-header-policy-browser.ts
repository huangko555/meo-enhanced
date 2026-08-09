import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const entryPath = path.join(repoRoot, 'scripts', 'test-table-sticky-header-policy-entry.ts');
const entrySource = fs.readFileSync(entryPath, 'utf8');
assert.equal(entrySource.includes('../webview/src/editor/tableStickyHeaderPolicy'), true);
assert.equal(entrySource.includes('../webview/src/editor.ts'), false);
assert.equal(entrySource.includes('../webview/src/index.ts'), false);
assert.equal(entrySource.includes('../webview/src/helpers/tables'), false);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-sticky-header-policy-'));

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
    await page.setViewport({ width: 640, height: 420 });
    await page.setContent(`<!doctype html>
      <style>
        #scroller { position: relative; width: 300px; height: 200px; overflow: auto; }
        #content { width: 500px; }
        #spacer { height: 60px; }
        table { width: 480px; height: 360px; border-collapse: collapse; }
        thead { height: 32px; }
        #tail { height: 220px; }
      </style>
      <div id="scroller"><div id="content"><div id="spacer"></div>
      <table><thead><tr><th>A</th><th>B</th></tr></thead><tbody>
      ${Array.from({ length: 12 }, (_, index) => `<tr><td>${index}</td><td>row</td></tr>`).join('')}
      </tbody></table><div id="tail"></div></div></div>`);
    await page.addScriptTag({ path: path.join(tempDir, 'candidate.js') });

    const result = await page.evaluate(() => {
      const candidate = (window as any).TableStickyHeaderPolicyCandidate;
      const scroller = document.getElementById('scroller')!;
      const table = document.querySelector<HTMLTableElement>('table')!;
      const header = table.tHead!;
      const input = (controlsHeight: number) => {
        const scrollerRect = scroller.getBoundingClientRect();
        const tableRect = table.getBoundingClientRect();
        const headerRect = header.getBoundingClientRect();
        return {
          scroller: {
            top: scrollerRect.top,
            left: scrollerRect.left,
            right: scrollerRect.right,
            height: scrollerRect.height
          },
          table: {
            top: tableRect.top,
            left: tableRect.left,
            right: tableRect.right,
            bottom: tableRect.bottom,
            height: tableRect.height,
            width: tableRect.width
          },
          header: { top: headerRect.top, height: headerRect.height },
          controlsHeight
        };
      };

      const beforeThreshold = candidate.policy.layout(input(0));
      scroller.scrollTop = 80;
      scroller.scrollLeft = 50;
      const visible = candidate.policy.layout(input(0));
      const withControls = candidate.policy.layout(input(31));
      scroller.scrollTop = 420;
      const afterTable = candidate.policy.layout(input(0));
      return {
        instances: candidate.instances,
        beforeThreshold,
        visible,
        withControls,
        afterTable,
        scrollerWidth: scroller.getBoundingClientRect().width
      };
    });

    assert.equal(result.instances, 1);
    assert.deepEqual(result.beforeThreshold, { visible: false, reason: 'before-threshold' });
    assert.equal(result.visible.visible, true);
    if (result.visible.visible) {
      assert.ok(Math.abs(result.visible.width - result.scrollerWidth) <= 2);
      assert.equal(result.visible.controlsHeight, 0);
      assert.equal(result.visible.translateX, -50);
    }
    assert.equal(result.withControls.visible, true);
    if (result.withControls.visible && result.visible.visible) {
      assert.equal(result.withControls.controlsHeight, 31);
      assert.equal(result.withControls.height - result.visible.height, 31);
    }
    assert.deepEqual(result.afterTable, { visible: false, reason: 'insufficient-content' });
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table sticky header policy Chromium candidate trace passed');
