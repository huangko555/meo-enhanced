import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-embedded-input-viewport-'));
const controlledMermaid = process.argv.includes('--controlled-mermaid');

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(
      repoRoot,
      'scripts',
      controlledMermaid
        ? 'test-mermaid-editing-entry.ts'
        : 'test-live-embedded-input-viewport-entry.ts'
    )],
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
    const failures: string[] = [];
    await page.setViewport({ width: 900, height: 520, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b1f23;--meo-surface-background:#24292e;--meo-semantic-mutedForeground:#8b949e;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate((useControlledMermaid) => {
      if (useControlledMermaid) {
        (window as any).mermaid = {
          initialize() {},
          async render(_id: string, text: string) {
            await new Promise<void>((resolve) => setTimeout(resolve, 8));
            return {
              svg: `<svg width="720" height="400" viewBox="0 0 720 400"><text x="10" y="30">${text.length}</text></svg>`
            };
          }
        };
      }
      const text = [
        ...Array.from({ length: 250 }, (_, index) => `前置正文 ${index + 1}`),
        '# Mermaid',
        '```mermaid',
        'sequenceDiagram',
        '  participant U as User',
        '  participant E as Editor',
        '  U->>E: Edit baseline',
        '  U->>E: Undo',
        '  E-->>U: Restore baseline',
        '  U->>E: Redo',
        '  E-->>U: Restore edit',
        '```',
        ...Array.from({ length: 12 }, (_, index) => `中间正文 ${index + 1}`),
        '# 表格',
        '| ID | 名称 | 状态 |',
        '| --- | --- | --- |',
        '| 1 | Alpha | Ready |',
        '| 2 | Bravo | Editing |',
        '| 3 | Charlie | Done |',
        ...Array.from({ length: 80 }, (_, index) => `后置正文 ${index + 1}`)
      ].join('\n');
      const harness = useControlledMermaid
        ? (window as any).MermaidEditingHarness
        : (window as any).EmbeddedInputViewportHarness;
      (window as any).__embeddedEditor = harness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__embeddedEditor.scrollToLine(252, 'center');
    }, controlledMermaid);
    await page.waitForSelector('.meo-mermaid-block svg');

    await page.evaluate(async () => {
      const editor = (window as any).__embeddedEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block, .meo-mermaid-block')!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      editor.view.scrollDOM.scrollTop += block.getBoundingClientRect().top - viewport.top - 96;
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      (window as any).__modeScrollTrace = [editor.view.scrollDOM.scrollTop];
      (window as any).__modeButtonTopTrace = [
        document.querySelector<HTMLElement>('.meo-mermaid-mode-btn')!.getBoundingClientRect().top
      ];
    });
    for (let index = 0; index < 12; index += 1) {
      await page.click('.meo-mermaid-mode-btn');
      await page.evaluate(async () => {
        const editor = (window as any).__embeddedEditor;
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          (window as any).__modeScrollTrace.push(editor.view.scrollDOM.scrollTop);
          (window as any).__modeButtonTopTrace.push(
            document.querySelector<HTMLElement>('.meo-mermaid-mode-btn')!.getBoundingClientRect().top
          );
        }
      });
    }
    const modeTrace = await page.evaluate(() => (window as any).__modeScrollTrace as number[]);
    const modeButtonTopTrace = await page.evaluate(() => (window as any).__modeButtonTopTrace as number[]);
    const modeSpan = Math.max(...modeTrace) - Math.min(...modeTrace);
    const modeButtonTopSpan = Math.max(...modeButtonTopTrace) - Math.min(...modeButtonTopTrace);
    if (modeSpan > 0.5 || modeButtonTopSpan > 0.5) {
      failures.push(`Repeated Mermaid mode changes moved the viewport: ${JSON.stringify({
        modeSpan,
        modeButtonTopSpan,
        modeTrace,
        modeButtonTopTrace
      })}`);
    }

    await page.evaluate(async () => {
      const editor = (window as any).__embeddedEditor;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const currentBlock = document.querySelector<HTMLElement>('.meo-mermaid-editing-block');
        if (currentBlock?.classList.contains('is-split')) break;
        document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn')!.click();
        for (let frame = 0; frame < 3; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      }
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-split')!;
      const innerView = (block as any).__meoMermaidEditingController.innerView;
      const target = innerView.state.doc.toString().indexOf('Restore edit') + 'Restore edit'.length;
      innerView.dispatch({ selection: { anchor: target } });
      innerView.focus();
      const caret = innerView.coordsAtPos(target);
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      if (!caret) throw new Error('Could not measure Mermaid source caret');
      editor.view.scrollDOM.scrollTop += caret.bottom - viewport.bottom + 8;
      for (let frame = 0; frame < 4; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      (window as any).__mermaidInputScrollTrace = [editor.view.scrollDOM.scrollTop];
      const sample = () => {
        (window as any).__mermaidInputScrollTrace.push(editor.view.scrollDOM.scrollTop);
        if ((window as any).__mermaidInputScrollTrace.length < 80) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.type('===', { delay: 70 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const mermaidInput = await page.evaluate(() => {
      const editor = (window as any).__embeddedEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')!;
      const innerView = (block as any).__meoMermaidEditingController.innerView;
      const trace = (window as any).__mermaidInputScrollTrace as number[];
      return {
        trace,
        span: Math.max(...trace) - Math.min(...trace),
        focused: innerView.hasFocus,
        text: innerView.state.doc.toString()
      };
    });
    if (mermaidInput.span > 1 || !mermaidInput.focused || !mermaidInput.text.includes('Restore edit===')) {
      failures.push(`Typing at the Mermaid tail moved the viewport or lost input: ${JSON.stringify(mermaidInput)}`);
    }

    const mermaidTopBefore = await page.evaluate(() => {
      const editor = (window as any).__embeddedEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')!;
      const innerView = (block as any).__meoMermaidEditingController.innerView;
      innerView.dispatch({ selection: { anchor: 0 } });
      innerView.focus();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const caret = innerView.coordsAtPos(0);
      if (!caret) throw new Error('Could not measure Mermaid top caret');
      editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: 60, bubbles: true }));
      editor.view.scrollDOM.scrollTop += caret.top - viewport.top + 3;
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        caretTop: innerView.coordsAtPos(0)?.top ?? null,
        viewportTop: viewport.top,
        lineHeight: editor.view.defaultLineHeight
      };
    });
    await page.keyboard.type('X');
    await page.evaluate(async () => {
      for (let index = 0; index < 10; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    const mermaidTopAfter = await page.evaluate(() => {
      const editor = (window as any).__embeddedEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block')!;
      const innerView = (block as any).__meoMermaidEditingController.innerView;
      const caret = innerView.coordsAtPos(innerView.state.selection.main.head);
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        caretTop: caret?.top ?? null,
        viewportTop: viewport.top,
        lineHeight: editor.view.defaultLineHeight
      };
    });
    if (
      mermaidTopBefore.caretTop === null || mermaidTopAfter.caretTop === null ||
      mermaidTopBefore.caretTop >= mermaidTopBefore.viewportTop ||
      mermaidTopAfter.caretTop < mermaidTopAfter.viewportTop + mermaidTopAfter.lineHeight - 2 ||
      mermaidTopAfter.scrollTop < mermaidTopBefore.scrollTop - mermaidTopAfter.lineHeight - 10
    ) {
      failures.push(`Mermaid source did not use minimal top reveal: ${JSON.stringify({
        mermaidTopBefore,
        mermaidTopAfter
      })}`);
    }

    await page.evaluate(async () => {
      const editor = (window as any).__embeddedEditor;
      const button = document.querySelector<HTMLElement>('.meo-mermaid-mode-btn')!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { deltaY: -60, bubbles: true }));
      editor.view.scrollDOM.scrollTop += button.getBoundingClientRect().top - viewport.top - 96;
      for (let index = 0; index < 4; index += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
      (window as any).__postInputModeTrace = [{
        scrollTop: editor.view.scrollDOM.scrollTop,
        buttonTop: document.querySelector<HTMLElement>('.meo-mermaid-mode-btn')!.getBoundingClientRect().top
      }];
    });
    for (let index = 0; index < 12; index += 1) {
      await page.click('.meo-mermaid-mode-btn');
      await page.evaluate(async () => {
        const editor = (window as any).__embeddedEditor;
        for (let frame = 0; frame < 4; frame += 1) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          (window as any).__postInputModeTrace.push({
            scrollTop: editor.view.scrollDOM.scrollTop,
            buttonTop: document.querySelector<HTMLElement>('.meo-mermaid-mode-btn')!.getBoundingClientRect().top
          });
        }
      });
    }
    const postInputModeTrace = await page.evaluate(() => (
      (window as any).__postInputModeTrace as Array<{ scrollTop: number; buttonTop: number }>
    ));
    const postInputScrollSpan = Math.max(...postInputModeTrace.map((sample) => sample.scrollTop))
      - Math.min(...postInputModeTrace.map((sample) => sample.scrollTop));
    const postInputButtonSpan = Math.max(...postInputModeTrace.map((sample) => sample.buttonTop))
      - Math.min(...postInputModeTrace.map((sample) => sample.buttonTop));
    if (postInputScrollSpan > 0.5 || postInputButtonSpan > 0.5) {
      failures.push(`Mermaid mode changes after source input moved the viewport: ${JSON.stringify({
        postInputScrollSpan,
        postInputButtonSpan,
        postInputModeTrace
      })}`);
    }

    await page.evaluate(async () => {
      const editor = (window as any).__embeddedEditor;
      const tablePosition = editor.getText().indexOf('| ID | 名称 | 状态 |');
      editor.view.scrollDOM.scrollTop = editor.view.lineBlockAt(tablePosition).top - 120;
      for (let frame = 0; frame < 6; frame += 1) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    });
    await page.waitForSelector('.meo-md-html-table-shell tbody tr:nth-child(2) td:nth-child(3) textarea');
    await page.click('.meo-md-html-table-shell tbody tr:nth-child(2) td:nth-child(3) textarea');
    await page.keyboard.press('End');
    await page.evaluate(() => {
      const editor = (window as any).__embeddedEditor;
      (window as any).__tableScrollTrace = [editor.view.scrollDOM.scrollTop];
      (window as any).__tableFocusTrace = [];
      const sample = () => {
        (window as any).__tableScrollTrace.push(editor.view.scrollDOM.scrollTop);
        const active = document.activeElement;
        (window as any).__tableFocusTrace.push({
          tag: active?.tagName ?? null,
          tableRow: active instanceof HTMLTextAreaElement ? active.dataset.tableRow ?? null : null,
          tableCol: active instanceof HTMLTextAreaElement ? active.dataset.tableCol ?? null : null
        });
        if ((window as any).__tableScrollTrace.length < 120) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.type('12345678901234567890', { delay: 70 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const tableInput = await page.evaluate(() => {
      const editor = (window as any).__embeddedEditor;
      const lines = editor.getText().split('\n');
      const header = lines.findIndex((line: string) => line === '| ID | 名称 | 状态 |');
      const scrollTrace = (window as any).__tableScrollTrace as number[];
      return {
        delimiter: lines[header + 1],
        target: lines[header + 3],
        scrollSpan: Math.max(...scrollTrace) - Math.min(...scrollTrace),
        scrollTrace,
        focusTrace: (window as any).__tableFocusTrace,
        activeTag: document.activeElement?.tagName ?? null
      };
    });
    if (
      tableInput.delimiter !== '| --- | --- | --- |' ||
      !tableInput.target.includes('Editing12345678901234567890') ||
      tableInput.scrollSpan > 1 ||
      tableInput.focusTrace.some((sample: { tag: string | null }) => sample.tag !== 'TEXTAREA')
    ) {
      failures.push(`Continuous table input corrupted structure, focus, or viewport: ${JSON.stringify(tableInput)}`);
    }

    if (failures.length) throw new Error(failures.join('\n'));

    console.log('embedded input viewport regression test passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
