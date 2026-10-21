import { enterMermaidSource, setMermaidLayout } from './history-mermaid-chromium';
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

async function assertLayoutSurvivesHistory(
  page: any,
  fixture: {
    readonly kind: 'mermaid' | 'formula';
    readonly text: string;
    readonly button: string;
    readonly block: string;
    readonly marker: string;
    readonly layout: 'stacked' | 'side-by-side';
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

  await setMermaidLayout(page, '__historyModeEditor', 2, fixture.layout);
  await enterMermaidSource(page, '__historyModeEditor', 2, 'end');
  await page.keyboard.type(fixture.marker);
  await waitForFrames(page);
  const edited = await page.evaluate(() => (window as any).__historyModeEditor.getText());
  await setMermaidLayout(page, '__historyModeEditor', 2, 'preview');

  for (const direction of ['undo', 'redo'] as const) {
    const applied = await page.evaluate(async (historyDirection) => (
      (window as any).__historyModeEditor[historyDirection]()
    ), direction);
    if (!applied) throw new Error(`${fixture.kind} ${direction} did not apply`);
    await waitForFrames(page);
    const state = await page.evaluate(({ buttonSelector, blockSelector }) => ({
      modeLabel: document.querySelector<HTMLButtonElement>(buttonSelector)?.closest<HTMLElement>('.meo-mermaid-toolbar')?.dataset.meoMermaidMode ?? null,
      editingBlockMounted: Boolean(document.querySelector(blockSelector)),
      activeRole: document.activeElement?.getAttribute('role') ?? null,
      side: !!document.querySelector('.meo-mermaid-inline-preview'),
      text: (window as any).__historyModeEditor.getText(),
      focused: (window as any).__historyModeEditor.view.hasFocus
    }), { buttonSelector: fixture.button, blockSelector: fixture.block });
    if (state.modeLabel !== 'edit' || !state.editingBlockMounted || !state.focused || state.side !== (fixture.layout === 'side-by-side') || state.text !== (direction === 'undo' ? fixture.text : edited)) {
      throw new Error(`${fixture.kind} ${direction} did not restore native source with the selected layout: ${JSON.stringify(state)}`);
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

    for (const layout of ['stacked', 'side-by-side'] as const) await assertLayoutSurvivesHistory(page, {
      kind: 'mermaid',
      text: ['before', '```mermaid', 'flowchart LR', 'A --> B', '```', 'after'].join('\n'),
      button: '.meo-mermaid-mode-btn',
      block: '.meo-mermaid-editing-preview',
      marker: ' HISTORY',
      layout
    });
    // Math presentation follows the document caret, tested in test-display-math-editing.

    console.log('native Mermaid history restores source and preserves both layouts');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
