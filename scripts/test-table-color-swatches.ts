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
          `| #f00 #0f08 #336699 #33669988 rgba(51, 153, 255, 0.55) hsl(210 100% 60%) red linear-gradient(#fff, #000) | #todo #abc/tag | \`#0f0\` HTTPS://example.com/?color=#abc //example.com/?color=#abc [section]( #abc) ${String.fromCharCode(92)}${String.fromCharCode(96).repeat(2)}#0a0${String.fromCharCode(96)} #0b0 |`
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
        protectedColors: previews[2].querySelectorAll('.meo-md-color-swatch').length,
        protectedColorTitles: swatchTitles(previews[2])
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
      colors: ['#f00', '#0f08', '#336699', '#33669988'],
      colorTags: [],
      tags: ['#todo', '#abc/tag'],
      protectedColors: 1,
      protectedColorTitles: ['#0b0']
    };
    if (JSON.stringify(result.initial) !== JSON.stringify(expectedInitial)) {
      throw new Error(`Table colors were not rendered separately from tags: ${JSON.stringify(result.initial)}`);
    }
    if (JSON.stringify(result.updated) !== JSON.stringify({ colors: ['#00ff00'], tags: ['#todo'] })) {
      throw new Error(`Edited table colors were not refreshed: ${JSON.stringify(result.updated)}`);
    }

    const liveResult = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      app.replaceChildren();
      const text = [
        'Live swatches',
        'HEX #abc #abcd #aabbcc #aabbccdd',
        'Plain rgb(1 2 3) rgba(1 2 3 / 40%) hsl(120 50% 40%) hsla(120 50% 40% / .5) red linear-gradient(#fff, #000)',
        'Links https://example.com/#abc HTTPS://example.com/?color=#abc //example.com/?color=#abc [section](#abc) [spaced]( #abc) tag #abc/tag code `#fff`',
        '',
        'Unmatched ` inline marker',
        '',
        'After unmatched #010203',
        `${String.fromCharCode(92)}${String.fromCharCode(96).repeat(2)}#0a0${String.fromCharCode(96)} #0b0`
      ].join('\n');
      let applyCount = 0;
      const editor = harness.createEditor({
        parent: app,
        initialMode: 'live',
        text,
        onApplyChanges() { applyCount += 1; }
      });
      for (let index = 0; index < 3; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const swatches = Array.from(app.querySelectorAll<HTMLElement>('.meo-md-color-swatch'));
      const before = editor.getText();
      swatches[0]?.click();
      const result = {
        colors: swatches.map((swatch) => swatch.title),
        roles: swatches.map((swatch) => swatch.getAttribute('role')),
        interactiveDescendants: swatches.reduce(
          (count, swatch) => count + swatch.querySelectorAll('input, button, select, textarea').length,
          0
        ),
        textUnchanged: editor.getText() === before,
        applyCount
      };
      editor.destroy();
      return result;
    });
    if (JSON.stringify(liveResult.colors) !== JSON.stringify(['#abc', '#abcd', '#aabbcc', '#aabbccdd', '#010203', '#0b0'])
      || liveResult.roles.some((role) => role !== 'img')
      || liveResult.interactiveDescendants !== 0
      || !liveResult.textUnchanged
      || liveResult.applyCount !== 0) {
      throw new Error(`Live HEX swatches must be read-only and exclusive: ${JSON.stringify(liveResult)}`);
    }

    const blockBoundaryResult = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const app = document.getElementById('app')!;
      const backtick = String.fromCharCode(96);
      const cases = [
        `# Heading ${backtick}\nParagraph #abc ${backtick}`,
        `open ${backtick}\n# Heading #abc\nclose ${backtick}`
      ];
      const results: string[][] = [];
      for (const text of cases) {
        app.replaceChildren();
        const editor = harness.createEditor({ parent: app, initialMode: 'live', text, onApplyChanges() {} });
        for (let index = 0; index < 3; index += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        results.push(Array.from(app.querySelectorAll<HTMLElement>('.meo-md-color-swatch'), (swatch) => swatch.title));
        editor.destroy();
      }
      return results;
    });
    if (JSON.stringify(blockBoundaryResult) !== JSON.stringify([['#abc'], ['#abc']])) {
      throw new Error(`Live Markdown block boundaries diverged from Preview: ${JSON.stringify(blockBoundaryResult)}`);
    }
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
console.log('table color swatch checks passed');
