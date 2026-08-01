import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-image-layout-'));

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
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root { --meo-background:#24292e; --meo-foreground:#e6edf3; --meo-caret:#e6edf3; --meo-semantic-imageBackground:#2a3a52; --meo-semantic-imageBorder:#474b50; --meo-semantic-imageFallbackForeground:#e6edf3; }'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const initial = await page.evaluate(async () => {
      const harness = (window as any).TableStabilityHarness;
      const svg = (color: string, width: number, height: number) => (
        `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${color}"/></svg>`)}`
      );
      harness.setImageSrcResolver((url: string) => {
        if (url.includes('missing')) return '';
        if (url.includes('wide')) return Promise.resolve(svg('#c33', 800, 450));
        return svg('#73c', 256, 256);
      });
      const editor = harness.createEditor({
        parent: document.getElementById('app')!,
        text: 'before\n![missing](missing.jpg) [![wide](wide.avif)](#after-target)![logo](logo.png)\nafter target',
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__imageLayoutEditor = editor;
      const openedLinks: string[] = [];
      editor.view.dom.addEventListener('meo-open-link', (event: Event) => {
        const href = (event as CustomEvent<{ href?: string }>).detail?.href;
        if (href) openedLinks.push(href);
      });
      for (let index = 0; index < 12; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      const loaded = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-image-img'));
      const wide = loaded.find((image) => image.getBoundingClientRect().width > image.getBoundingClientRect().height);
      if (!wide) throw new Error('Wide image did not render in the reproduction fixture');
      const openLink = wide.closest<HTMLElement>('.meo-md-image')
        ?.querySelector<HTMLButtonElement>('button[title="Jump within document"]');
      if (!openLink) throw new Error('Linked image did not render its document jump button');
      openLink.dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));
      const rect = wide.getBoundingClientRect();
      return {
        imageCount: loaded.length,
        fallbackCount: document.querySelectorAll('.meo-md-image-fallback').length,
        openedLinks,
        widePoint: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      };
    });

    await page.mouse.click(initial.widePoint.x, initial.widePoint.y);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const expanded = await page.evaluate(() => {
      const editor = (window as any).__imageLayoutEditor;
      const lines = Array.from(document.querySelectorAll<HTMLElement>('.cm-line'));
      const sourceLine = lines.find((line) => line.textContent?.includes('![missing]'));
      const afterLine = lines.find((line) => line.textContent?.includes('after target'));
      if (!sourceLine || !afterLine) throw new Error('Expected source and following line were not rendered');
      const afterRect = afterLine.getBoundingClientRect();
      const x = afterRect.left + Math.min(40, Math.max(4, afterRect.width / 2));
      const y = afterRect.top + afterRect.height / 2;
      const target = document.elementFromPoint(x, y) as HTMLElement | null;
      const mappedPosition = editor.view.posAtCoords({ x, y });
      return {
        afterPoint: { x, y },
        hitClass: target?.className ?? '',
        hitText: target?.textContent ?? '',
        mappedLine: mappedPosition === null ? null : editor.view.state.doc.lineAt(mappedPosition).number,
        domLine: editor.view.state.doc.lineAt(editor.view.posAtDOM(afterLine)).number,
        sourceRect: sourceLine.getBoundingClientRect().toJSON(),
        afterRect: afterRect.toJSON(),
        widgetRects: Array.from(document.querySelectorAll<HTMLElement>('.meo-md-image')).map((element) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, fallback: element.classList.contains('meo-md-image-fallback') };
        })
      };
    });

    await page.mouse.click(expanded.afterPoint.x, expanded.afterPoint.y);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const afterClick = await page.evaluate(() => {
      const editor = (window as any).__imageLayoutEditor;
      return {
        selectedLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
        sourceStillExpanded: Array.from(document.querySelectorAll('.cm-line'))
          .some((line) => line.textContent?.includes('wide.avif'))
      };
    });

    const failures: string[] = [];
    if (initial.imageCount !== 2 || initial.fallbackCount !== 1) {
      failures.push(`fixture rendered ${initial.imageCount} images and ${initial.fallbackCount} fallbacks`);
    }
    if (initial.openedLinks.length !== 1 || initial.openedLinks[0] !== '#after-target') {
      failures.push(`linked image opened ${JSON.stringify(initial.openedLinks)} instead of #after-target`);
    }
    if (afterClick.selectedLine !== 3 || afterClick.sourceStillExpanded) {
      failures.push(
        `click below images hit ${JSON.stringify(expanded.hitClass)} ${JSON.stringify(expanded.hitText.slice(0, 40))}; `
        + `coords mapped to line ${expanded.mappedLine}, DOM mapped to line ${expanded.domLine}, `
        + `selection stayed on line ${afterClick.selectedLine}; source=${JSON.stringify(expanded.sourceRect)}, `
        + `after=${JSON.stringify(expanded.afterRect)}, rects=${JSON.stringify(expanded.widgetRects)}`
      );
    }
    if (failures.length) throw new Error(failures.join('\n'));
    console.log('image layout checks passed');
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
