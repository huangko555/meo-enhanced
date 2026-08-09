import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mermaid-presentation-candidate-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-diagram-presentation-candidate-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <input id="focus" value="kept">
      <div id="scroll" style="height:40px;overflow:auto"><div style="height:200px"></div></div>
      <div id="a"><button data-control>zoom</button><div data-diagram-body></div></div>
      <div id="b"><button data-control>fullscreen</button><div data-diagram-body></div></div>`);
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const result = await page.evaluate(async () => {
      const harness = (window as any).MermaidDiagramPresentationCandidate;
      const environment = harness.createEnvironment();
      const focus = document.getElementById('focus') as HTMLInputElement;
      const scroll = document.getElementById('scroll') as HTMLElement;
      focus.focus();
      focus.setSelectionRange(1, 3);
      scroll.scrollTop = 70;
      const a = environment.create(document.getElementById('a'));
      const b = environment.create(document.getElementById('b'));

      a.present('graph TD\nshared');
      b.present('graph TD\nshared');
      await Promise.all([a.whenIdle(), b.whenIdle()]);

      a.present('graph TD\nslow-old');
      await new Promise((resolve) => setTimeout(resolve, 1));
      a.present('graph TD\nnew');
      const preview = environment.runPreview('high');
      await Promise.all([a.whenIdle(), preview]);

      b.present('invalid');
      await b.whenIdle();
      const errorHtml = document.querySelector('#b [data-diagram-body]')?.innerHTML;
      b.present('graph TD\nrecovered', 'dark', 'strict');
      await b.whenIdle();
      b.externalDocumentPresented();
      const externalHtml = document.querySelector('#b [data-diagram-body]')?.innerHTML;

      environment.refreshTheme();
      a.present('graph TD\nshared');
      await a.whenIdle();
      const aHtml = document.querySelector('#a [data-diagram-body]')?.innerHTML;
      b.present('graph TD\nslow-dispose');
      const bBeforeDispose = document.querySelector('#b [data-diagram-body]')?.innerHTML;
      b.dispose();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const bAfterDispose = document.querySelector('#b [data-diagram-body]')?.innerHTML;
      const controls = Array.from(document.querySelectorAll('[data-control]'))
        .map((element) => element.textContent);
      const stats = environment.stats();
      a.dispose();
      environment.dispose();
      return {
        aHtml,
        bBeforeDispose,
        bAfterDispose,
        errorHtml,
        externalHtml,
        controls,
        stats,
        activeId: document.activeElement?.id,
        selection: [focus.selectionStart, focus.selectionEnd],
        scrollTop: scroll.scrollTop
      };
    });

    assert.match(result.aHtml ?? '', /data-source="graph TD\nshared"/);
    assert.match(result.bBeforeDispose ?? '', /meo-mermaid-loading/);
    assert.equal(result.bAfterDispose, result.bBeforeDispose);
    assert.doesNotMatch(result.bAfterDispose ?? '', /meo-mermaid-svg-wrapper/);
    assert.match(result.errorHtml ?? '', /meo-mermaid-error-badge/);
    assert.equal(result.externalHtml, '');
    assert.deepEqual(result.controls, ['zoom', 'fullscreen']);
    assert.equal(result.stats.applicationCount, 2);
    assert.equal(result.stats.runtimeCount, 2);
    assert.equal(result.stats.adapterCount, 2);
    assert.equal(result.stats.poolCount, 1);
    assert.equal(result.stats.maxActiveRenders, 1);
    assert.equal(
      result.stats.events.filter((event: string) => event === 'render:graph TD\nshared').length,
      2,
      'same key is shared before theme refresh and rendered once again after invalidation'
    );
    const slowIndex = result.stats.events.indexOf('render:graph TD\nslow-old');
    const previewIndex = result.stats.events.indexOf('preview:high');
    const newIndex = result.stats.events.indexOf('render:graph TD\nnew');
    assert.ok(slowIndex >= 0 && previewIndex > slowIndex && newIndex > previewIndex);
    assert.equal(result.activeId, 'focus');
    assert.deepEqual(result.selection, [1, 3]);
    assert.equal(result.scrollTop, 70);
    console.log('Mermaid diagram presentation Chromium candidate passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
