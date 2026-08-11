import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mermaid-source-history-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'mermaid-source-history.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 460, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'mermaid-source-history.js') });
    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg width="320" height="120"><text>${text.length}</text></svg>` };
        }
      };
      (window as any).__mermaidSourceHistoryEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text: ['```mermaid', 'graph TD', 'A --> B', '```'].join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    const positions = await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')! as any;
      const innerView = block.__meoMermaidEditingController.innerView;
      const before = innerView.state.doc.length;
      innerView.dispatch({ changes: { from: before, insert: '\nC --> D' }, selection: { anchor: before + 8 } });
      return { before, after: before + 8 };
    });
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page, 2);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);

    await page.evaluate(() => (window as any).__mermaidSourceHistoryEditor.undo());
    await waitForFrames(page);
    await page.evaluate(() => (window as any).__mermaidSourceHistoryEditor.redo());
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.evaluate((offset) => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')! as any;
      block.__meoMermaidEditingController.focusOffset(offset);
    }, positions.after);

    const readSourcePresentation = () => page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
      const innerView = (block as any)?.__meoMermaidEditingController?.innerView;
      return {
        source: Boolean(block?.classList.contains('is-source')),
        head: innerView?.state.selection.main.head ?? null,
        focused: innerView?.hasFocus ?? false
      };
    });

    assert.deepEqual(await readSourcePresentation(), {
      source: true,
      head: positions.after,
      focused: true
    });

    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await waitForFrames(page);
    const sourceUndo = await readSourcePresentation();

    await page.keyboard.down('Control');
    await page.keyboard.press('y');
    await page.keyboard.up('Control');
    await waitForFrames(page);
    const sourceRedo = await readSourcePresentation();

    assert.deepEqual({ sourceUndo, sourceRedo }, {
      sourceUndo: { source: true, head: positions.before, focused: true },
      sourceRedo: { source: true, head: positions.after, focused: true }
    });

    await page.evaluate(() => (window as any).__mermaidSourceHistoryEditor.destroy());
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  console.log('Mermaid source-mode history regression passed');
}

await main();
