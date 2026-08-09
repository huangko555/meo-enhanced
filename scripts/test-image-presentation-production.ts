import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-image-presentation-production-'));

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
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const svg = (label: string, color: string) => (
        `data:image/svg+xml,${encodeURIComponent(
          `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="80"><rect width="160" height="80" fill="${color}"/><text x="8" y="42">${label}</text></svg>`
        )}`
      );
      const pending = new Map<string, (value: string) => void>();
      harness.setImageSrcResolver((url: string) => {
        if (url.includes('missing')) return '';
        if (url.includes('late')) {
          return new Promise<string>((resolve) => pending.set(url, resolve));
        }
        return svg(url, '#68a');
      });

      const editor = harness.createEditor({
        parent: document.getElementById('app')!,
        text: 'before\n![old](late-old.png)\nafter',
        initialMode: 'live',
        onApplyChanges() {}
      });
      const settle = async () => {
        for (let index = 0; index < 12; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };
      await settle();
      const initialFallbacks = document.querySelectorAll('.meo-md-image-fallback').length;

      editor.setText('before\n![new](new.png)\n![missing](missing.png)\nafter');
      pending.get('late-old.png')?.(svg('late-old', '#a66'));
      await settle();
      const afterExternal = {
        text: editor.getText(),
        images: Array.from(document.querySelectorAll<HTMLImageElement>('.meo-md-image-img'))
          .map((image) => image.getAttribute('src') ?? ''),
        fallbacks: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-image-fallback'))
          .map((node) => node.textContent ?? '')
      };

      editor.setMode('source');
      const sourceVisibleImages = document.querySelectorAll('.meo-md-image-img').length;
      editor.setMode('live');
      await settle();
      const afterModeRoundTrip = {
        text: editor.getText(),
        imageCount: document.querySelectorAll('.meo-md-image-img').length,
        fallbackCount: document.querySelectorAll('.meo-md-image-fallback').length
      };

      editor.setText('![destroy](late-destroy.png)');
      await settle();
      editor.destroy();
      pending.get('late-destroy.png')?.(svg('late-destroy', '#6a6'));
      await settle();

      return {
        initialFallbacks,
        afterExternal,
        sourceVisibleImages,
        afterModeRoundTrip,
        editorDomAfterDestroy: document.querySelectorAll('.cm-editor').length,
        imageDomAfterDestroy: document.querySelectorAll('.meo-md-image-img').length
      };
    });

    assert.equal(result.initialFallbacks, 1, 'unresolved image should expose the Markdown fallback');
    assert.equal(result.afterExternal.text, 'before\n![new](new.png)\n![missing](missing.png)\nafter');
    assert.equal(result.afterExternal.images.length, 1, 'external presentation should expose only the new image');
    assert.equal(result.afterExternal.images.some((src) => src.includes('late-old')), false);
    assert.deepEqual(result.afterExternal.fallbacks, ['![missing](missing.png)']);
    assert.equal(result.sourceVisibleImages, 0, 'Source mode should not expose rendered image widgets');
    assert.deepEqual(result.afterModeRoundTrip, {
      text: 'before\n![new](new.png)\n![missing](missing.png)\nafter',
      imageCount: 1,
      fallbackCount: 1
    });
    assert.equal(result.editorDomAfterDestroy, 0);
    assert.equal(result.imageDomAfterDestroy, 0, 'late image completion must not recreate visible DOM after destroy');
    console.log('image presentation production characterization passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
