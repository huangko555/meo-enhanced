import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-colors-'));

async function main() {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-table-stability-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) {
    throw new Error(build.logs.map(String).join('\n'));
  }

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><button id="outside">outside</button><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const result = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const editor = harness.createEditor({
        parent: app,
        initialMode: 'live',
        text: [
          '| Colors | Tag | Protected |',
          '| --- | --- | --- |',
          '| #f00 rgba(51, 153, 255, 0.55) | #todo #abc/tag | `#0f0` |'
        ].join('\n'),
        onApplyChanges() {}
      });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }

      const previews = document.querySelectorAll<HTMLElement>('tbody .meo-md-html-table-cell-preview');
      const swatchTitles = (root: ParentNode) => Array.from(
        root.querySelectorAll<HTMLElement>('.meo-md-color-swatch'),
        (swatch) => swatch.title
      );
      const tagTexts = (root: ParentNode) => Array.from(
        root.querySelectorAll<HTMLElement>('.meo-md-tag'),
        (tag) => tag.textContent
      );
      const initial = {
        colors: swatchTitles(previews[0]),
        colorTags: tagTexts(previews[0]),
        tags: tagTexts(previews[1]),
        protectedColors: previews[2].querySelectorAll('.meo-md-color-swatch').length
      };

      const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!;
      input.focus();
      input.value = '#00ff00 #todo';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('outside')!.focus();
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const preview = document.querySelector<HTMLElement>('tbody .meo-md-html-table-cell-preview')!;
      const updated = {
        colors: swatchTitles(preview),
        tags: tagTexts(preview)
      };
      editor.destroy();
      return { initial, updated };
    });

    const expectedInitial = {
      colors: ['#f00', 'rgba(51, 153, 255, 0.55)'],
      colorTags: [],
      tags: ['#todo', '#abc/tag'],
      protectedColors: 0
    };
    if (JSON.stringify(result.initial) !== JSON.stringify(expectedInitial)) {
      throw new Error(`Table colors were not rendered separately from tags: ${JSON.stringify(result.initial)}`);
    }
    if (JSON.stringify(result.updated) !== JSON.stringify({ colors: ['#00ff00'], tags: ['#todo'] })) {
      throw new Error(`Edited table colors were not refreshed: ${JSON.stringify(result.updated)}`);
    }
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table color swatch checks passed');
