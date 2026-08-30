import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-rendered-content-history-'));

async function waitForFrames(page: any, count = 6): Promise<void> {
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
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const baseline = [
      ...Array.from({ length: 120 }, (_, index) => `before block ${index + 1}`),
      '```mermaid',
      'flowchart LR',
      '  A --> B',
      '```',
      '',
      '```typescript',
      ...Array.from({ length: 28 }, (_, index) => (
        index === 14 ? 'const baselineCode = 1;' : `const codeLine${index + 1} = ${index + 1};`
      )),
      '```',
      ...Array.from({ length: 120 }, (_, index) => `after block ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, source: string) {
          return { svg: `<svg width="320" height="120"><text>${source.length}</text></svg>` };
        }
      };
      (window as any).__historyEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, baseline);
    await waitForFrames(page);

    await page.evaluate(() => (window as any).__historyEditor.scrollToLine(121, 'center'));
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')! as any;
      const innerView = block.__meoMermaidEditingController.innerView;
      block.__meoMermaidEditingController.focusOffset(innerView.state.doc.length);
    });
    await page.keyboard.type(' MERMAID_EDIT');
    await waitForFrames(page);
    const afterMermaid = await page.evaluate(() => (window as any).__historyEditor.getText());

    await page.evaluate(() => {
      const editor = (window as any).__historyEditor;
      const target = editor.getText().indexOf('baselineCode') + 'baselineCode'.length;
      editor.scrollToLine(editor.view.state.doc.lineAt(target).number, 'center');
      editor.view.dispatch({ selection: { anchor: target } });
      editor.view.focus();
    });
    await page.keyboard.type('_CODE_EDIT');
    await waitForFrames(page);
    const afterCode = await page.evaluate(() => (window as any).__historyEditor.getText());

    const history = await page.evaluate(async () => {
      const editor = (window as any).__historyEditor;
      const snapshots: string[] = [];
      const receipts: boolean[] = [];
      for (const direction of ['undo', 'undo', 'redo', 'redo'] as const) {
        receipts.push(await editor[direction]());
        snapshots.push(editor.getText());
      }
      return { receipts, snapshots };
    });
    const expected = [afterMermaid, baseline, afterMermaid, afterCode];
    if (
      history.receipts.some((receipt) => !receipt)
      || JSON.stringify(history.snapshots) !== JSON.stringify(expected)
    ) {
      throw new Error(`Rendered-content Undo/Redo did not restore exact snapshots: ${JSON.stringify({
        baseline, afterMermaid, afterCode, history, expected
      })}`);
    }

    const codeUndoApplied = await page.evaluate(() => (window as any).__historyEditor.undo());
    if (!codeUndoApplied) throw new Error('Code undo before clipped Mermaid history was not applied');
    await page.waitForFunction((expectedText) => (
      (window as any).__historyEditor.getText() === expectedText
    ), {}, afterMermaid);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const modeLabel = await page.$eval('.meo-mermaid-mode-btn', (button) => button.getAttribute('aria-label'));
      if (modeLabel === 'Edit Mermaid in split view') break;
      await page.click('.meo-mermaid-mode-btn');
      await waitForFrames(page, 3);
    }
    await page.waitForSelector('.meo-mermaid-block');
    const clippedBeforeMermaidUndo = await page.evaluate(() => {
      const editor = (window as any).__historyEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-block');
      if (!block) throw new Error('Missing Mermaid preview before clipped undo');
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const rect = block.getBoundingClientRect();
      editor.view.scrollDOM.scrollTop += rect.top - viewport.bottom + 26;
      const clippedRect = block.getBoundingClientRect();
      return {
        top: clippedRect.top,
        bottom: clippedRect.bottom,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
        visibleHeight: Math.min(clippedRect.bottom, viewport.bottom) - Math.max(clippedRect.top, viewport.top)
      };
    });
    const mermaidUndoApplied = await page.evaluate(() => (window as any).__historyEditor.undo());
    if (!mermaidUndoApplied) throw new Error('Clipped Mermaid undo was not applied');
    await page.waitForFunction(() => !(window as any).__historyEditor.getText().includes('MERMAID_EDIT'));
    await waitForFrames(page, 16);
    const clippedAfterMermaidUndo = await page.evaluate(() => {
      const editor = (window as any).__historyEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-block');
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const rect = block?.getBoundingClientRect() ?? null;
      return {
        top: rect?.top ?? null,
        bottom: rect?.bottom ?? null,
        height: rect?.height ?? null,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
        visibleHeight: rect
          ? Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top)
          : 0
      };
    });
    const requiredVisibleHeight = Math.min(clippedAfterMermaidUndo.height ?? 0, 96);
    if (
      clippedBeforeMermaidUndo.visibleHeight < 20 ||
      clippedBeforeMermaidUndo.visibleHeight > 32 ||
      clippedAfterMermaidUndo.visibleHeight < requiredVisibleHeight
    ) {
      throw new Error(`Clipped Mermaid history did not reveal the changed block: ${JSON.stringify({
        clippedBeforeMermaidUndo,
        clippedAfterMermaidUndo,
        requiredVisibleHeight
      })}`);
    }

    const formulaBaseline = [
      ...Array.from({ length: 120 }, (_, index) => `before formula ${index + 1}`),
      '$$',
      '\\begin{aligned}',
      'a_1 &= 1 \\\\',
      'a_2 &= 2 \\\\',
      'a_3 &= 3 \\\\',
      'a_4 &= 4 \\\\',
      'a_5 &= 5 \\\\',
      'a_6 &= 6 \\\\',
      'a_7 &= 7 \\\\',
      'a_8 &= 8',
      '\\end{aligned}',
      '$$',
      ...Array.from({ length: 120 }, (_, index) => `after formula ${index + 1}`)
    ].join('\n');
    await page.evaluate((text) => {
      (window as any).__historyEditor.destroy();
      const app = document.getElementById('app')!;
      app.replaceChildren();
      (window as any).__historyEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: app,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    }, formulaBaseline);
    await page.evaluate(() => (window as any).__historyEditor.scrollToLine(121, 'center'));
    await page.waitForSelector('.meo-latex-math-mode-btn');
    await page.click('.meo-latex-math-mode-btn');
    await page.waitForSelector('.meo-latex-math-editing-block');
    await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block')! as any;
      const innerView = block.__meoLatexMathEditingController.innerView;
      block.__meoLatexMathEditingController.focusOffset(innerView.state.doc.length);
    });
    await page.keyboard.type(' + FORMULA_EDIT');
    await page.waitForFunction(() => (window as any).__historyEditor.getText().includes('FORMULA_EDIT'));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const modeLabel = await page.$eval('.meo-latex-math-mode-btn', (button) => button.getAttribute('aria-label'));
      if (modeLabel === 'Edit formula in split view') break;
      await page.click('.meo-latex-math-mode-btn');
      await waitForFrames(page, 3);
    }
    await page.waitForSelector('.meo-md-math-fenced-display');
    const clippedBeforeFormulaUndo = await page.evaluate(() => {
      const editor = (window as any).__historyEditor;
      const block = document.querySelector<HTMLElement>('.meo-md-math-fenced-display');
      if (!block) throw new Error('Missing formula preview before clipped undo');
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const rect = block.getBoundingClientRect();
      editor.view.scrollDOM.scrollTop += rect.top - viewport.bottom + 26;
      const clippedRect = block.getBoundingClientRect();
      return {
        visibleHeight: Math.min(clippedRect.bottom, viewport.bottom) - Math.max(clippedRect.top, viewport.top)
      };
    });
    const formulaUndoApplied = await page.evaluate(() => (window as any).__historyEditor.undo());
    if (!formulaUndoApplied) throw new Error('Clipped formula undo was not applied');
    await page.waitForFunction(() => !(window as any).__historyEditor.getText().includes('FORMULA_EDIT'));
    await waitForFrames(page, 16);
    const clippedAfterFormulaUndo = await page.evaluate(() => {
      const editor = (window as any).__historyEditor;
      const block = document.querySelector<HTMLElement>('.meo-md-math-fenced-display');
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const rect = block?.getBoundingClientRect() ?? null;
      return {
        height: rect?.height ?? null,
        visibleHeight: rect
          ? Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top)
          : 0
      };
    });
    const requiredFormulaVisibleHeight = Math.min(clippedAfterFormulaUndo.height ?? 0, 96);
    if (
      clippedBeforeFormulaUndo.visibleHeight < 20 ||
      clippedBeforeFormulaUndo.visibleHeight > 32 ||
      clippedAfterFormulaUndo.visibleHeight < requiredFormulaVisibleHeight
    ) {
      throw new Error(`Clipped formula history did not reveal the changed block: ${JSON.stringify({
        clippedBeforeFormulaUndo,
        clippedAfterFormulaUndo,
        requiredFormulaVisibleHeight
      })}`);
    }
    console.log('rendered content history roundtrip passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
