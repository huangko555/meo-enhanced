import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-outline-floating-'));

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-outline-floating-dismissal-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    await page.setContent(`<!doctype html><style>
      #root { position: relative; width: 800px; height: 500px; }
      #editor-wrapper { position: relative; width: 100%; height: 440px; }
      #preview-frame { width: 100%; height: 100%; }
    </style><body>
      <main id="root" class="editor-root">
        <button id="outline-toggle">Outline</button>
        <div id="editor-wrapper" class="editor-wrapper">
          <iframe id="preview-frame" srcdoc="<!doctype html><button id='preview-content'>Preview content</button>"></iframe>
        </div>
        <button id="outside">Outside</button>
      </main>
    </body>`);
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      const root = document.getElementById('root')!;
      const editorWrapper = document.getElementById('editor-wrapper')!;
      const outlineButton = document.getElementById('outline-toggle')!;
      const outline = (window as any).OutlineFloatingDismissalHarness.createOutlineController({
        root,
        editorWrapper,
        outlineButton,
        getEditor: () => ({
          getHeadings: () => [
            { text: 'Heading', level: 1, from: 0, line: 1 },
            { text: 'Child', level: 2, from: 10, line: 3 }
          ],
          getViewportAnchorOffset: () => 0,
          getVisibleDocumentRange: () => ({ from: 0, to: 20, fromLine: 1, toLine: 4 }),
          getScrollElement: () => editorWrapper,
          scrollToLine() {}
        })
      });
      editorWrapper.appendChild(outline.sidebar);
      outline.setMode('floating');
      outline.setVisible(true);
      (window as any).__outline = outline;
    });

    const foldIconSize = await page.$eval<SVGElement, { width: string | null; height: string | null }>(
      '.outline-fold-button svg',
      (icon) => ({ width: icon.getAttribute('width'), height: icon.getAttribute('height') })
    );
    assert.deepEqual(foldIconSize, { width: '14', height: '14' }, 'outline fold icon size regressed');
    const resizeIndicatorStyle = await page.$eval('.outline-resizer', async (element) => {
      (element as HTMLElement).style.transition = 'none';
      document.body.classList.add('outline-resizing');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const style = getComputedStyle(element);
      const result = { color: style.backgroundColor, width: style.width };
      document.body.classList.remove('outline-resizing');
      return result;
    });
    assert.equal(
      resizeIndicatorStyle.color,
      'rgb(49, 109, 202)',
      `outline resize indicator color regressed: ${JSON.stringify(resizeIndicatorStyle)}`
    );

    await page.click('.outline-item');
    assert.equal(await page.evaluate(() => (window as any).__outline.isVisible()), false,
      'floating outline remained visible after a heading jump');

    await page.evaluate(() => (window as any).__outline.setVisible(true));
    await page.click('#outside');
    assert.equal(await page.evaluate(() => (window as any).__outline.isVisible()), false,
      'floating outline remained visible after an outside click');

    await page.evaluate(() => (window as any).__outline.setVisible(true));
    const previewFrame = page.frames().find((frame) => frame.parentFrame() === page.mainFrame());
    if (!previewFrame) throw new Error('preview iframe did not load');
    await previewFrame.click('#preview-content');
    assert.equal(await page.evaluate(() => (window as any).__outline.isVisible()), false,
      'floating outline remained visible after clicking Preview content');

    console.log('floating outline dismissal checks passed');
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
