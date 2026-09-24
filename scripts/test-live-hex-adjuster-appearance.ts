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
          --vscode-button-background: ${dark ? '#0e639c' : '#2e7d32'};
          --vscode-button-foreground: ${dark ? '#ffffff' : '#24292f'};
          --vscode-button-hoverBackground: ${dark ? '#1177bb' : '#388e3c'};
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
          (window as any).__hexAppearanceEditor = editor;
          for (let index = 0; index < 4; index += 1) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          }
          const swatches = app.querySelectorAll<HTMLButtonElement>('.meo-md-color-swatch-interactive');
          const dialogs = [];
          for (const swatch of swatches) {
            swatch.click();
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            const dialog = app.querySelector<HTMLElement>('.meo-hex-color-adjustment')!;
            const newValue = dialog.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-value')!;
            const preview = dialog.querySelector<HTMLElement>('.meo-hex-color-adjustment-preview')!;
            const fills = dialog.querySelectorAll<HTMLElement>('.meo-hex-color-adjustment-preview-fill');
            const previewBounds = preview.getBoundingClientRect();
            const originalBounds = fills[0]!.getBoundingClientRect();
            const newBounds = fills[1]!.getBoundingClientRect();
            const originalBackgroundBefore = getComputedStyle(fills[0]!).backgroundColor;
            const newBackgroundBefore = getComputedStyle(fills[1]!).backgroundColor;
            const hue = dialog.querySelector<HTMLInputElement>('.meo-hex-color-adjustment-hue')!;
            hue.value = String((Number(hue.value) + 60) % 360);
            hue.dispatchEvent(new Event('input', { bubbles: true }));
            const toolbarProbe = document.createElement('div');
            toolbarProbe.className = 'meo-md-html-table-context-menu';
            editor.view.dom.appendChild(toolbarProbe);
            dialogs.push({
              background: getComputedStyle(dialog).backgroundColor,
              foreground: getComputedStyle(dialog).color,
              border: getComputedStyle(dialog).borderTopColor,
              toolbarBackground: getComputedStyle(toolbarProbe).backgroundColor,
              toolbarBorder: getComputedStyle(toolbarProbe).borderTopColor,
              width: dialog.getBoundingClientRect().width,
              height: dialog.getBoundingClientRect().height,
              applyBackground: getComputedStyle(dialog.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')!).backgroundColor,
              applyForeground: getComputedStyle(dialog.querySelector<HTMLButtonElement>('.meo-hex-color-adjustment-apply')!).color,
              sliderCount: dialog.querySelectorAll('input[type="range"]').length,
              visibleSliderCount: Array.from(dialog.querySelectorAll('input[type="range"]'))
                .filter((input) => getComputedStyle(input.closest('label')!).display !== 'none').length,
              opacity: dialog.querySelector<HTMLInputElement>('input[aria-label="Opacity"], input[aria-label="透明度"]')?.value,
              label: dialog.getAttribute('aria-label'),
              previewFillCount: fills.length,
              splitWidths: [originalBounds.width, newBounds.width],
              splitGap: newBounds.left - originalBounds.right,
              previewWidth: previewBounds.width,
              newValueBefore: swatch.dataset.colorValue,
              newValueAfter: newValue.value,
              originalBackgroundBefore,
              originalBackgroundAfter: getComputedStyle(fills[0]!).backgroundColor,
              newBackgroundBefore,
              newBackgroundAfter: getComputedStyle(fills[1]!).backgroundColor,
              horizontalOverflow: dialog.scrollWidth > dialog.clientWidth
            });
            toolbarProbe.remove();
          }
          return dialogs;
        }, language);
        const screenshotDir = process.env.MEO_HEX_SCREENSHOT_DIR;
        if (screenshotDir) {
          fs.mkdirSync(screenshotDir, { recursive: true });
          const clip = await page.evaluate(() => {
            const rect = document.querySelector('.meo-hex-color-adjustment')!.getBoundingClientRect();
            return { x: Math.max(0, rect.x - 12), y: Math.max(0, rect.y - 12),
              width: rect.width + 24, height: rect.height + 24 };
          });
          await page.screenshot({
            path: path.join(screenshotDir, `${appearance}-${language}.png`), clip
          });
        }
        await page.evaluate(() => (window as any).__hexAppearanceEditor.destroy());
        await page.close();
        if (result.length !== 2 || result.some((dialog) => dialog.sliderCount !== 4 || dialog.visibleSliderCount !== 4 ||
          dialog.horizontalOverflow || dialog.width > 324 || dialog.height > 270)) {
          throw new Error(`${appearance}/${language} must show four fitting sliders in a compact popover: ${JSON.stringify(result)}`);
        }
        const expectedLabel = language === 'en' ? 'Color controls for' : '的颜色调整器';
        if (result[0]?.opacity !== '255' || result[1]?.opacity !== '128' ||
          result.some((dialog) => !dialog.label?.includes(expectedLabel))) {
          throw new Error(`${appearance}/${language} opacity and localized labels must match the source: ${JSON.stringify(result)}`);
        }
        if (result.some((dialog) => dialog.previewFillCount !== 2 ||
          dialog.splitWidths.some((width) => Math.abs(width - (dialog.previewWidth - 2) / 2) > 0.5) ||
          Math.abs(dialog.splitGap) > 0.5 ||
          dialog.newValueAfter === dialog.newValueBefore ||
          dialog.originalBackgroundAfter !== dialog.originalBackgroundBefore ||
          dialog.newBackgroundAfter === dialog.newBackgroundBefore)) {
          throw new Error(`${appearance}/${language} must preserve the original sample while updating the new sample: ${JSON.stringify(result)}`);
        }
        const editorBackground = dark ? 'rgb(36, 41, 47)' : 'rgb(247, 248, 250)';
        const targetForeground = dark ? 'rgb(240, 242, 244)' : 'rgb(34, 38, 43)';
        if (result.some((dialog) => dialog.background !== dialog.toolbarBackground ||
          dialog.border !== dialog.toolbarBorder || dialog.background === editorBackground ||
          dialog.foreground !== targetForeground)) {
          throw new Error(`${appearance}/${language} popover must share the table toolbar surface: ${JSON.stringify(result)}`);
        }
        const luminance = (color: string) => {
          const channels = color.match(/[\d.]+/g)?.slice(0, 3).map(Number);
          if (!channels || channels.length !== 3) throw new Error(`Cannot parse ${color}`);
          const [red, green, blue] = channels.map((channel) => {
            const normalized = channel / 255;
            return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        };
        const contrast = (foreground: string, background: string) => {
          const values = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
          return (values[0]! + 0.05) / (values[1]! + 0.05);
        };
        if (result.some((dialog) => contrast(dialog.applyForeground, dialog.applyBackground) < 4.5)) {
          throw new Error(`${appearance}/${language} Apply label must reach 4.5:1 contrast: ${JSON.stringify(result)}`);
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
