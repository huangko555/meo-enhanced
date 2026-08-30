import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-history-rendered-mode-'));

async function waitForFrames(page: any, count = 8): Promise<void> {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function assertPreviewModeSurvivesHistory(
  page: any,
  fixture: {
    readonly kind: 'mermaid' | 'formula';
    readonly text: string;
    readonly button: string;
    readonly block: string;
    readonly controller: string;
    readonly marker: string;
    readonly previewLabel: string;
  }
): Promise<void> {
  await page.evaluate((text) => {
    const previous = (window as any).__historyModeEditor;
    previous?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__historyModeEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text,
      initialMode: 'live',
      onApplyChanges() {}
    });
  }, fixture.text);
  await waitForFrames(page);

  await page.click(fixture.button);
  await waitForFrames(page);
  await page.evaluate(({ blockSelector, controllerProperty }) => {
    const block = document.querySelector<HTMLElement>(blockSelector) as any;
    const controller = block?.[controllerProperty];
    if (!controller) throw new Error(`Missing rendered editor: ${blockSelector}`);
    controller.focusOffset(controller.innerView.state.doc.length);
  }, { blockSelector: fixture.block, controllerProperty: fixture.controller });
  await page.keyboard.type(fixture.marker);
  await waitForFrames(page);

  // Split -> Source -> Preview. History must not change this explicit user choice.
  await page.click(fixture.button);
  await waitForFrames(page);
  await page.click(fixture.button);
  await waitForFrames(page);

  for (const direction of ['undo', 'redo'] as const) {
    const applied = await page.evaluate(async (historyDirection) => (
      (window as any).__historyModeEditor[historyDirection]()
    ), direction);
    if (!applied) throw new Error(`${fixture.kind} ${direction} did not apply`);
    await waitForFrames(page);
    const state = await page.evaluate(({ buttonSelector, blockSelector }) => ({
      modeLabel: document.querySelector<HTMLButtonElement>(buttonSelector)?.getAttribute('aria-label') ?? null,
      editingBlockMounted: Boolean(document.querySelector(blockSelector)),
      activeRole: document.activeElement?.getAttribute('role') ?? null
    }), { buttonSelector: fixture.button, blockSelector: fixture.block });
    if (state.modeLabel !== fixture.previewLabel || state.editingBlockMounted) {
      throw new Error(`${fixture.kind} ${direction} changed Preview into an editing mode: ${JSON.stringify(state)}`);
    }
  }
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-mermaid-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, source: string) {
          return { svg: `<svg width="320" height="120"><text>${source.length}</text></svg>` };
        }
      };
    });

    await assertPreviewModeSurvivesHistory(page, {
      kind: 'mermaid',
      text: ['before', '```mermaid', 'flowchart LR', 'A --> B', '```', 'after'].join('\n'),
      button: '.meo-mermaid-mode-btn',
      block: '.meo-mermaid-editing-block',
      controller: '__meoMermaidEditingController',
      marker: ' HISTORY',
      previewLabel: 'Edit Mermaid in split view'
    });
    await assertPreviewModeSurvivesHistory(page, {
      kind: 'formula',
      text: ['before', '$$', 'x = 1', '$$', 'after'].join('\n'),
      button: '.meo-latex-math-mode-btn',
      block: '.meo-latex-math-editing-block',
      controller: '__meoLatexMathEditingController',
      marker: ' + y',
      previewLabel: 'Edit formula in split view'
    });

    console.log('rendered block Preview mode survives Undo/Redo');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
