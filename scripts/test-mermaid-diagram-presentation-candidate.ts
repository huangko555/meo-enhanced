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

  const bundle = fs.readFileSync(path.join(tempDir, 'bundle.js'), 'utf8');
  assert.equal(bundle.includes('mermaidEditingStateField'), false);
  assert.equal(bundle.includes('MermaidEditingController'), false);
  assert.equal(bundle.includes('MermaidDiagramWidget'), false);
  assert.equal(bundle.includes('mermaidDiagram.ts'), false);

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html>
      <input id="focus" value="kept">
      <div id="scroll" style="height:40px;overflow:auto"><div style="height:200px"></div></div>
      <div id="a"></div><div id="b"></div>`);
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const result = await page.evaluate(() => {
      const harness = (window as any).MermaidDiagramPresentationCandidate;
      const focus = document.getElementById('focus') as HTMLInputElement;
      const scroll = document.getElementById('scroll') as HTMLElement;
      focus.focus();
      focus.setSelectionRange(1, 3);
      scroll.scrollTop = 70;

      const a = harness.create(document.getElementById('a'));
      const b = harness.create(document.getElementById('b'));
      const oldId = a.present('graph TD\nA-->B', 'light', 'default');
      const replacementId = a.present('graph TD\nA-->C', 'dark', 'strict');
      a.complete({
        type: 'renderSucceeded', presentationId: oldId, svg: '<svg data-value="old"></svg>'
      });
      a.complete({
        type: 'renderSucceeded', presentationId: replacementId, svg: '<svg data-value="new"></svg>'
      });

      const bId = b.present('invalid', 'dark', 'strict');
      b.complete({ type: 'renderFailed', presentationId: bId, error: 'parse error' });
      const recoveredId = b.present('graph TD\nB-->C', 'dark', 'strict');
      b.complete({
        type: 'renderSucceeded', presentationId: recoveredId, svg: '<svg data-value="recovered"></svg>'
      });
      b.externalDocumentPresented();
      b.complete({
        type: 'renderSucceeded', presentationId: recoveredId, svg: '<svg data-value="late"></svg>'
      });
      b.dispose();

      return {
        aState: a.state(),
        aHtml: document.getElementById('a')?.innerHTML,
        bState: b.state(),
        bHtml: document.getElementById('b')?.innerHTML,
        aRenderKeys: a.effects()
          .filter((effect: any) => effect.type === 'renderDiagram')
          .map((effect: any) => [effect.source, effect.themeKey, effect.configKey]),
        activeId: document.activeElement?.id,
        selection: [focus.selectionStart, focus.selectionEnd],
        scrollTop: scroll.scrollTop
      };
    });

    assert.equal(result.aState.phase, 'ready');
    assert.match(result.aHtml ?? '', /data-value="new"/);
    assert.doesNotMatch(result.aHtml ?? '', /data-value="old"/);
    assert.deepEqual(result.aRenderKeys, [
      ['graph TD\nA-->B', 'light', 'default'],
      ['graph TD\nA-->C', 'dark', 'strict']
    ]);
    assert.equal(result.bState.phase, 'disposed');
    assert.equal(result.bHtml, '');
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
