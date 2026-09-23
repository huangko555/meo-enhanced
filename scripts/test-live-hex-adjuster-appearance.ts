import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-hex-adjuster-appearance-'));

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
    for (const appearance of ['dark', 'light'] as const) {
      for (const language of ['en', 'zh-CN'] as const) {
        const page = await browser.newPage();
        const dark = appearance === 'dark';
        await page.setContent(`<html data-editor-appearance="${appearance}"><body class="vscode-${appearance}"><div id="app"></div></body></html>`);
        await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
        await page.addStyleTag({ content: `:root {
          --vscode-editor-background: ${dark ? '#24292f' : '#f7f8fa'};
          --vscode-editor-foreground: ${dark ? '#f0f2f4' : '#22262b'};
          --vscode-editorWidget-background: ${dark ? '#ffffff' : '#20252b'};
          --vscode-editorWidget-foreground: ${dark ? '#24292f' : '#ffffff'};
          --vscode-editor-font-family: monospace;
          --vscode-font-family: sans-serif;
          --vscode-focusBorder: #2680c2;
        }` });
        await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
        const result = await page.evaluate(async (uiLanguage) => {
          const harness = (window as any).TableStabilityHarness;
          const app = document.getElementById('app')!;
          const editor = harness.createEditor({
            parent: app,
            initialMode: 'live',
            uiLanguage,
            text: 'Live colors\nHEX #60A5FA and #60A5FA80',
            onApplyChanges() {}
          });
          for (let index = 0; index < 4; index += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          const swatches = app.querySelectorAll<HTMLButtonElement>('.meo-md-color-swatch-interactive');
          const dialogs = [];
          for (const swatch of swatches) {
            swatch.click();
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const dialog = app.querySelector<HTMLElement>('.meo-hex-color-adjustment')!;
            dialogs.push({
              background: getComputedStyle(dialog).backgroundColor,
              foreground: getComputedStyle(dialog).color,
              sliderCount: dialog.querySelectorAll('input[type="range"]').length,
              visibleSliderCount: Array.from(dialog.querySelectorAll('input[type="range"]'))
                .filter((input) => getComputedStyle(input.closest('label')!).display !== 'none').length,
              opacity: dialog.querySelector<HTMLInputElement>('input[aria-label="Opacity"], input[aria-label="透明度"]')?.value,
              label: dialog.getAttribute('aria-label'),
              horizontalOverflow: dialog.scrollWidth > dialog.clientWidth
            });
          }
          editor.destroy();
          return dialogs;
        }, language);
        await page.close();
        if (result.length !== 2 || result.some((dialog) => dialog.sliderCount !== 4 || dialog.visibleSliderCount !== 4 || dialog.horizontalOverflow)) {
          throw new Error(`${appearance}/${language} must show four fitting sliders for both HEX lengths: ${JSON.stringify(result)}`);
        }
        const expectedLabel = language === 'en' ? 'Color controls for' : '的颜色调整器';
        if (result[0]?.opacity !== '255' || result[1]?.opacity !== '128' ||
          result.some((dialog) => !dialog.label?.includes(expectedLabel))) {
          throw new Error(`${appearance}/${language} opacity and localized labels must match the source: ${JSON.stringify(result)}`);
        }
        const targetBackground = dark ? 'rgb(36, 41, 47)' : 'rgb(247, 248, 250)';
        const targetForeground = dark ? 'rgb(240, 242, 244)' : 'rgb(34, 38, 43)';
        if (result.some((dialog) => dialog.background !== targetBackground || dialog.foreground !== targetForeground)) {
          throw new Error(`${appearance}/${language} popover must follow editor colors, not conflicting widget tokens: ${JSON.stringify(result)}`);
        }
      }
    }
  } finally {
    await browser.close();
  }
  console.log('Live HEX adjuster appearance checks passed');
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
