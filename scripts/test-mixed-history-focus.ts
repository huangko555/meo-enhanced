import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-mixed-history-focus-'));

async function waitForFrames(page: any, count = 6) {
  await page.evaluate(async (frameCount: number) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function pressHistoryShortcut(page: any, key: 'z' | 'y') {
  await page.keyboard.down('Control');
  await page.keyboard.press(key);
  await page.keyboard.up('Control');
  await waitForFrames(page);
}

async function main() {
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
    await page.setViewport({ width: 900, height: 420, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      (window as any).mermaid = {
        initialize() {},
        async render(_id: string, text: string) {
          return { svg: `<svg width="320" height="120"><text>${text.length}</text></svg>` };
        }
      };
      const filler = (label: string) => Array.from({ length: 18 }, (_, index) => `${label} ${index + 1}`);
      const text = [
        'BODY_TARGET',
        ...filler('before table'),
        '| Name | Value |',
        '| --- | --- |',
        '| row | TABLE_TARGET |',
        ...filler('before code'),
        '```ts',
        'const CODE_TARGET = true;',
        '```',
        ...filler('before mermaid'),
        '```mermaid',
        'graph TD',
        'A --> B',
        '```',
        ...filler('before math'),
        '$$',
        'x = 1',
        '$$',
        ...filler('before tail'),
        'TAIL_TARGET'
      ].join('\n');
      (window as any).__mixedHistoryEditor = (window as any).MermaidEditingHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await waitForFrames(page);

    await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      const view = editor.view;
      const appendToLine = (needle: string, insert: string) => {
        for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
          const line = view.state.doc.line(lineNumber);
          if (line.text.includes(needle)) {
            view.dispatch({ changes: { from: line.to, insert }, selection: { anchor: line.to + insert.length } });
            return;
          }
        }
        throw new Error(`Missing line: ${needle}`);
      };
      appendToLine('BODY_TARGET', ' BODY_EDIT');
    });
    await waitForFrames(page);

    await page.evaluate(() => {
      const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('tbody textarea'))
        .find((candidate) => candidate.value === 'TABLE_TARGET')!;
      input.focus();
      input.value = 'TABLE_EDIT';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'TABLE_EDIT' }));
      (window as any).__mixedHistoryEditor.commitTransientEdits();
    });
    await waitForFrames(page);
    const committedTableLines = await page.evaluate(() => (
      (window as any).__mixedHistoryEditor.getText().split('\n').filter((line: string) => line.includes('|'))
    ));
    if (
      !committedTableLines.includes('| row | TABLE_EDIT |') ||
      !committedTableLines.includes('| --- | --- |')
    ) {
      throw new Error(`Table cell edit was committed to the wrong source row: ${JSON.stringify(committedTableLines)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      const view = editor.view;
      for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        if (line.text.includes('CODE_TARGET')) {
          view.dispatch({ changes: { from: line.to, insert: ' CODE_EDIT' }, selection: { anchor: line.to + 10 } });
          return;
        }
      }
    });
    await waitForFrames(page);

    await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      for (let lineNumber = 1; lineNumber <= editor.view.state.doc.lines; lineNumber += 1) {
        if (editor.view.state.doc.line(lineNumber).text === '```mermaid') {
          editor.scrollToLine(lineNumber, 'center');
          return;
        }
      }
    });
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);
    await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')! as any;
      const innerView = block.__meoMermaidEditingController.innerView;
      const from = innerView.state.doc.length;
      innerView.dispatch({ changes: { from, insert: '\nC --> D' }, selection: { anchor: from + 8 } });
    });
    await waitForFrames(page);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page, 2);
    await page.click('.meo-mermaid-mode-btn');
    await waitForFrames(page);

    await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      for (let lineNumber = 1; lineNumber <= editor.view.state.doc.lines; lineNumber += 1) {
        if (editor.view.state.doc.line(lineNumber).text === '$$') {
          editor.scrollToLine(lineNumber, 'center');
          return;
        }
      }
    });
    await waitForFrames(page);
    await page.click('.meo-latex-math-mode-btn');
    await waitForFrames(page);
    await page.evaluate(() => {
      const block = document.querySelector<HTMLElement>('.meo-latex-math-editing-block')! as any;
      const innerView = block.__meoLatexMathEditingController.innerView;
      const from = innerView.state.doc.length;
      innerView.dispatch({ changes: { from, insert: '\ny = 2' }, selection: { anchor: from + 6 } });
    });
    await waitForFrames(page);
    await page.click('.meo-latex-math-mode-btn');
    await waitForFrames(page, 2);
    await page.click('.meo-latex-math-mode-btn');
    await waitForFrames(page);

    await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      const view = editor.view;
      for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber += 1) {
        const line = view.state.doc.line(lineNumber);
        if (line.text.includes('TAIL_TARGET')) {
          view.dispatch({ changes: { from: line.to, insert: ' TAIL_EDIT' }, selection: { anchor: line.to + 10 } });
          view.focus();
          return;
        }
      }
    });
    await waitForFrames(page);

    await pressHistoryShortcut(page, 'z');
    await pressHistoryShortcut(page, 'z');
    const afterSecondUndo = await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      const button = document.querySelector<HTMLButtonElement>('.meo-latex-math-mode-btn');
      const rect = button?.getBoundingClientRect();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        text: editor.view.state.doc.toString(),
        mode: button?.getAttribute('aria-label') ?? null,
        outerFocused: editor.view.hasFocus,
        targetVisible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom)
      };
    });
    if (
      afterSecondUndo.text.includes('y = 2') ||
      afterSecondUndo.mode !== 'Edit formula in split view' ||
      !afterSecondUndo.outerFocused || !afterSecondUndo.targetVisible
    ) {
      throw new Error(`Second mixed undo did not restore the formula Preview target: ${JSON.stringify(afterSecondUndo)}`);
    }

    await pressHistoryShortcut(page, 'z');
    const afterThirdUndo = await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      const button = document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn');
      const rect = button?.getBoundingClientRect();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        text: editor.view.state.doc.toString(),
        mode: button?.getAttribute('aria-label') ?? null,
        outerFocused: editor.view.hasFocus,
        mermaidVisible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom),
        activeClass: (document.activeElement as HTMLElement | null)?.className?.toString() ?? null
      };
    });
    if (
      afterThirdUndo.text.includes('C --> D') ||
      afterThirdUndo.mode !== 'Edit Mermaid in split view' ||
      !afterThirdUndo.outerFocused ||
      !afterThirdUndo.mermaidVisible
    ) {
      throw new Error(`Third mixed undo did not restore the Mermaid Preview target: ${JSON.stringify(afterThirdUndo)}`);
    }

    const readOuterLineFocus = (needle: string) => page.evaluate((lineNeedle) => {
      const editor = (window as any).__mixedHistoryEditor;
      const view = editor.view;
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const coords = view.coordsAtPos(head);
      const viewport = view.scrollDOM.getBoundingClientRect();
      return {
        text: view.state.doc.toString(),
        focused: view.hasFocus,
        selectedLine: line.text,
        targetSelected: line.text.includes(lineNeedle),
        targetVisible: Boolean(coords && coords.bottom > viewport.top && coords.top < viewport.bottom)
      };
    }, needle);

    await pressHistoryShortcut(page, 'z');
    const afterCodeUndo = await readOuterLineFocus('CODE_TARGET');
    if (afterCodeUndo.text.includes('CODE_EDIT') || !afterCodeUndo.focused || !afterCodeUndo.targetSelected || !afterCodeUndo.targetVisible) {
      throw new Error(`Mixed undo did not focus the code change: ${JSON.stringify(afterCodeUndo)}`);
    }

    await pressHistoryShortcut(page, 'z');
    const afterTableUndo = await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      const input = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
      const rect = input?.getBoundingClientRect();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        text: editor.view.state.doc.toString(),
        value: input?.value ?? null,
        focused: Boolean(input),
        targetVisible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom)
      };
    });
    if (afterTableUndo.text.includes('TABLE_EDIT') || afterTableUndo.value !== 'TABLE_TARGET' || !afterTableUndo.focused || !afterTableUndo.targetVisible) {
      throw new Error(`Mixed undo did not focus the table change: ${JSON.stringify(afterTableUndo)}`);
    }

    await pressHistoryShortcut(page, 'z');
    const afterBodyUndo = await readOuterLineFocus('BODY_TARGET');
    if (afterBodyUndo.text.includes('BODY_EDIT') || !afterBodyUndo.focused || !afterBodyUndo.targetSelected || !afterBodyUndo.targetVisible) {
      throw new Error(`Mixed undo did not focus the body change: ${JSON.stringify(afterBodyUndo)}`);
    }

    await pressHistoryShortcut(page, 'y');
    const afterBodyRedo = await readOuterLineFocus('BODY_TARGET');
    if (!afterBodyRedo.text.includes('BODY_EDIT') || !afterBodyRedo.focused || !afterBodyRedo.targetSelected || !afterBodyRedo.targetVisible) {
      throw new Error(`Mixed redo did not focus the body change: ${JSON.stringify(afterBodyRedo)}`);
    }

    await pressHistoryShortcut(page, 'y');
    const afterTableRedo = await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      const input = document.activeElement instanceof HTMLTextAreaElement ? document.activeElement : null;
      const rect = input?.getBoundingClientRect();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        text: editor.view.state.doc.toString(),
        value: input?.value ?? null,
        focused: Boolean(input),
        targetVisible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom)
      };
    });
    if (!afterTableRedo.text.includes('TABLE_EDIT') || afterTableRedo.value !== 'TABLE_EDIT' || !afterTableRedo.focused || !afterTableRedo.targetVisible) {
      throw new Error(`Mixed redo did not focus the table change: ${JSON.stringify(afterTableRedo)}`);
    }

    await pressHistoryShortcut(page, 'y');
    const afterCodeRedo = await readOuterLineFocus('CODE_TARGET');
    if (!afterCodeRedo.text.includes('CODE_EDIT') || !afterCodeRedo.focused || !afterCodeRedo.targetSelected || !afterCodeRedo.targetVisible) {
      throw new Error(`Mixed redo did not focus the code change: ${JSON.stringify(afterCodeRedo)}`);
    }

    await pressHistoryShortcut(page, 'y');
    const afterMermaidRedo = await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      const button = document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn');
      const rect = button?.getBoundingClientRect();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        text: editor.view.state.doc.toString(),
        mode: button?.getAttribute('aria-label') ?? null,
        outerFocused: editor.view.hasFocus,
        targetVisible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom)
      };
    });
    if (
      !afterMermaidRedo.text.includes('C --> D') ||
      afterMermaidRedo.mode !== 'Edit Mermaid in split view' ||
      !afterMermaidRedo.outerFocused || !afterMermaidRedo.targetVisible
    ) {
      throw new Error(`Mixed redo did not restore the Mermaid Preview target: ${JSON.stringify(afterMermaidRedo)}`);
    }

    await pressHistoryShortcut(page, 'y');
    const afterMathRedo = await page.evaluate(() => {
      const editor = (window as any).__mixedHistoryEditor;
      const button = document.querySelector<HTMLButtonElement>('.meo-latex-math-mode-btn');
      const rect = button?.getBoundingClientRect();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        text: editor.view.state.doc.toString(),
        mode: button?.getAttribute('aria-label') ?? null,
        outerFocused: editor.view.hasFocus,
        targetVisible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom)
      };
    });
    if (
      !afterMathRedo.text.includes('y = 2') ||
      afterMathRedo.mode !== 'Edit formula in split view' ||
      !afterMathRedo.outerFocused || !afterMathRedo.targetVisible
    ) {
      throw new Error(`Mixed redo did not restore the formula Preview target: ${JSON.stringify(afterMathRedo)}`);
    }

    await pressHistoryShortcut(page, 'y');
    const afterTailRedo = await readOuterLineFocus('TAIL_TARGET');
    if (!afterTailRedo.text.includes('TAIL_EDIT') || !afterTailRedo.focused || !afterTailRedo.targetSelected || !afterTailRedo.targetVisible) {
      throw new Error(`Mixed redo did not focus the tail change: ${JSON.stringify(afterTailRedo)}`);
    }

    console.log('mixed history focus checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
