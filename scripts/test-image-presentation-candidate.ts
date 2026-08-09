import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-image-presentation-candidate-'));

async function main(): Promise<void> {
  const productionSources = [
    fs.readFileSync(path.join(repoRoot, 'webview', 'src', 'editor.ts'), 'utf8'),
    fs.readFileSync(path.join(repoRoot, 'webview', 'src', 'helpers', 'images.ts'), 'utf8')
  ].join('\n');
  assert.equal(
    productionSources.includes("application/imagePresentation"),
    false,
    'candidate image presentation application must remain disconnected from production'
  );

  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-image-presentation-candidate-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><div id="image"></div>');
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const result = await page.evaluate(() => {
      const harness = (window as any).ImagePresentationCandidate;
      const candidate = harness.create(document.getElementById('image'));

      candidate.dispatch({ type: 'present', sourceKey: 'old', rawSrc: './old.png' });
      const oldId = candidate.state().presentationId;
      candidate.dispatch({ type: 'present', sourceKey: 'new', rawSrc: './new.png' });
      const newId = candidate.state().presentationId;
      const staleResolve = candidate.dispatch({
        type: 'sourceResolved', presentationId: oldId, resolvedSrc: 'data:image/svg+xml,old'
      });
      candidate.dispatch({
        type: 'sourceResolved', presentationId: newId, resolvedSrc: 'data:image/svg+xml,new'
      });
      const staleLoad = candidate.dispatch({ type: 'imageLoaded', presentationId: oldId });
      candidate.dispatch({ type: 'imageLoaded', presentationId: newId });
      const ready = candidate.snapshot();

      candidate.dispatch({ type: 'present', sourceKey: 'missing', rawSrc: './missing.png' });
      const missingId = candidate.state().presentationId;
      candidate.dispatch({ type: 'sourceFailed', presentationId: missingId });
      const fallback = candidate.snapshot();

      candidate.dispatch({ type: 'present', sourceKey: 'external', rawSrc: './external.png' });
      const externalId = candidate.state().presentationId;
      candidate.dispatch({ type: 'externalDocumentPresented' });
      const externalLate = candidate.dispatch({ type: 'imageLoaded', presentationId: externalId });

      candidate.dispatch({ type: 'present', sourceKey: 'dispose', rawSrc: './dispose.png' });
      const disposeId = candidate.state().presentationId;
      candidate.dispatch({ type: 'dispose' });
      const disposedLate = candidate.dispatch({ type: 'imageLoaded', presentationId: disposeId });

      return {
        counts: harness.counts(),
        staleResolve: staleResolve.length,
        staleLoad: staleLoad.length,
        ready,
        fallback,
        externalLate: externalLate.length,
        disposedLate: disposedLate.length,
        disposedState: candidate.state(),
        legacyDom: document.querySelectorAll('.meo-md-image').length
      };
    });

    assert.deepEqual(result.counts, { applications: 1, legacyWidgets: 0 });
    assert.equal(result.legacyDom, 0);
    assert.equal(result.staleResolve, 0);
    assert.equal(result.staleLoad, 0);
    assert.deepEqual(result.ready, {
      className: 'candidate-image ready',
      text: '',
      src: 'data:image/svg+xml,new'
    });
    assert.deepEqual(result.fallback, {
      className: 'candidate-image fallback',
      text: 'missing',
      src: null
    });
    assert.equal(result.externalLate, 0);
    assert.equal(result.disposedLate, 0);
    assert.deepEqual(result.disposedState, { phase: 'disposed', presentationId: null, sourceKey: null });
    console.log('image presentation candidate Chromium checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
