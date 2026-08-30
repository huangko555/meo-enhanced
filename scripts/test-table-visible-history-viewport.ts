import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-visible-history-viewport-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-live-embedded-input-viewport-entry.ts')],
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
    await page.setViewport({ width: 1000, height: 600, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b1f23;--meo-surface-background:#24292e;--meo-semantic-mutedForeground:#8b949e;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      const lines = [
        ...Array.from({ length: 80 }, (_, index) => `Before ${index + 1}`),
        '# Table history',
        '',
        '| Row | A | B | C | D |',
        '| ---: | --- | --- | --- | --- |',
        ...Array.from({ length: 12 }, (_, index) => {
          const row = String(index + 1).padStart(2, '0');
          return `| ${row} | A${row} | B${row} | C${row} | D${row} |`;
        }),
        '',
        ...Array.from({ length: 80 }, (_, index) => `After ${index + 1}`)
      ];
      (window as any).__tableHistoryEditor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!,
        text: lines.join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__tableHistoryEditor.scrollToLine(90, 'center');
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table tbody tr').length === 12);

    await page.evaluate(() => {
      const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
        .find((candidate) => candidate.value === 'D12');
      if (!input) throw new Error('Missing D12 input');
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
    await page.keyboard.type('__EARLIER__');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.evaluate(() => (window as any).__tableHistoryEditor.commitTransientEdits());
    await waitForFrames(page, 12);

    await page.evaluate(() => {
      const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
        .find((candidate) => candidate.value === 'C08');
      if (!input) throw new Error('Missing C08 input');
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
    await page.keyboard.type('__HISTORY__');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.evaluate(() => (window as any).__tableHistoryEditor.commitTransientEdits());
    await waitForFrames(page, 12);

    const prepareVisibleHistory = async () => {
      await page.evaluate(() => {
        const editor = (window as any).__tableHistoryEditor;
        const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
          .find((candidate) => candidate.value.startsWith('C08'));
        if (!input) throw new Error('Missing C08 history input');
        const viewport = editor.view.scrollDOM.getBoundingClientRect();
        const rect = input.getBoundingClientRect();
        editor.view.scrollDOM.scrollTop += rect.top - viewport.top - 425;
        const afterLine = editor.getText().indexOf('After 1');
        editor.view.dispatch({ selection: { anchor: afterLine } });
        editor.view.focus();
      });
      await waitForFrames(page, 10);
      return page.evaluate(() => {
        const editor = (window as any).__tableHistoryEditor;
        const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
          .find((candidate) => candidate.value.startsWith('C08'));
        const viewport = editor.view.scrollDOM.getBoundingClientRect();
        const rect = input?.getBoundingClientRect() ?? null;
        return {
          scrollTop: editor.view.scrollDOM.scrollTop,
          targetTop: rect?.top ?? null,
          visible: Boolean(rect && rect.bottom > viewport.top && rect.top < viewport.bottom)
        };
      });
    };

    const beforeUndo = await prepareVisibleHistory();
    const undoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.undo());
    if (!undoApplied) throw new Error('Table history undo was not applied');
    await page.waitForFunction(() => (window as any).__tableHistoryEditor.getText().includes('| 08 | A08 | B08 | C08 | D08 |'));
    await waitForFrames(page, 15);
    const afterUndo = await page.evaluate(() => {
      const editor = (window as any).__tableHistoryEditor;
      const active = document.activeElement;
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        targetTop: active instanceof HTMLTextAreaElement ? active.getBoundingClientRect().top : null,
        focusedValue: active instanceof HTMLTextAreaElement ? active.value : null
      };
    });

    const beforeRedo = await prepareVisibleHistory();
    const redoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.redo());
    if (!redoApplied) throw new Error('Table history redo was not applied');
    await page.waitForFunction(() => (window as any).__tableHistoryEditor.getText().includes('C08__HISTORY__'));
    await waitForFrames(page, 15);
    const afterRedo = await page.evaluate(() => {
      const editor = (window as any).__tableHistoryEditor;
      const active = document.activeElement;
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        targetTop: active instanceof HTMLTextAreaElement ? active.getBoundingClientRect().top : null,
        focusedValue: active instanceof HTMLTextAreaElement ? active.value : null
      };
    });

    const evidence = { beforeUndo, afterUndo, beforeRedo, afterRedo };
    if (
      !beforeUndo.visible || !beforeRedo.visible ||
      afterUndo.focusedValue !== 'C08' || afterRedo.focusedValue !== 'C08__HISTORY__' ||
      Math.abs(afterUndo.scrollTop - beforeUndo.scrollTop) > 2 ||
      Math.abs(afterRedo.scrollTop - beforeRedo.scrollTop) > 2 ||
      afterUndo.targetTop === null || beforeUndo.targetTop === null ||
      afterRedo.targetTop === null || beforeRedo.targetTop === null ||
      Math.abs(afterUndo.targetTop - beforeUndo.targetTop) > 2 ||
      Math.abs(afterRedo.targetTop - beforeRedo.targetTop) > 2
    ) {
      throw new Error(`Visible table history moved the viewport: ${JSON.stringify(evidence)}`);
    }

    await page.evaluate(() => {
      const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
        .find((candidate) => candidate.value === 'C08__HISTORY__');
      if (!input) throw new Error('Missing C08 immediate-history input');
      input.focus({ preventScroll: true });
      input.setSelectionRange(3, 3);
      const editor = (window as any).__tableHistoryEditor;
      (window as any).__tableImmediateHistoryTrace = [];
      const sample = () => {
        const active = document.activeElement;
        (window as any).__tableImmediateHistoryTrace.push({
          scrollTop: editor.view.scrollDOM.scrollTop,
          focusedValue: active instanceof HTMLTextAreaElement ? active.value : null,
          selectionStart: active instanceof HTMLTextAreaElement ? active.selectionStart : null
        });
        if ((window as any).__tableImmediateHistoryTrace.length < 80) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.type('X');
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => (
      (window as any).__tableHistoryEditor.getText().includes('| 08 | A08 | B08 | C08__HISTORY__ | D08 |')
    ));
    await waitForFrames(page, 24);
    const immediateUndo = await page.evaluate(() => {
      const editor = (window as any).__tableHistoryEditor;
      const active = document.activeElement;
      const trace = (window as any).__tableImmediateHistoryTrace as Array<{
        scrollTop: number;
        focusedValue: string | null;
        selectionStart: number | null;
      }>;
      return {
        activeValue: active instanceof HTMLTextAreaElement ? active.value : null,
        selectionStart: active instanceof HTMLTextAreaElement ? active.selectionStart : null,
        scrollSpan: Math.max(...trace.map((sample) => sample.scrollTop))
          - Math.min(...trace.map((sample) => sample.scrollTop)),
        trace
      };
    });
    if (
      immediateUndo.activeValue !== 'C08__HISTORY__' ||
      immediateUndo.selectionStart !== 3 ||
      immediateUndo.scrollSpan > 2
    ) {
      throw new Error(`Immediate table keyboard undo lost its caret or bounced: ${JSON.stringify(immediateUndo)}`);
    }

    await page.evaluate(() => {
      const editor = (window as any).__tableHistoryEditor;
      (window as any).__tableImmediateHistoryTrace = [];
      const sample = () => {
        const active = document.activeElement;
        (window as any).__tableImmediateHistoryTrace.push({
          scrollTop: editor.view.scrollDOM.scrollTop,
          focusedValue: active instanceof HTMLTextAreaElement ? active.value : null,
          selectionStart: active instanceof HTMLTextAreaElement ? active.selectionStart : null
        });
        if ((window as any).__tableImmediateHistoryTrace.length < 80) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.down('Control');
    await page.keyboard.press('y');
    await page.keyboard.up('Control');
    await page.waitForFunction(() => (
      (window as any).__tableHistoryEditor.getText().includes('| 08 | A08 | B08 | C08X__HISTORY__ | D08 |')
    ));
    await waitForFrames(page, 24);
    const immediateRedo = await page.evaluate(() => {
      const editor = (window as any).__tableHistoryEditor;
      const active = document.activeElement;
      const trace = (window as any).__tableImmediateHistoryTrace as Array<{
        scrollTop: number;
        focusedValue: string | null;
        selectionStart: number | null;
      }>;
      return {
        activeValue: active instanceof HTMLTextAreaElement ? active.value : null,
        selectionStart: active instanceof HTMLTextAreaElement ? active.selectionStart : null,
        scrollSpan: Math.max(...trace.map((sample) => sample.scrollTop))
          - Math.min(...trace.map((sample) => sample.scrollTop)),
        trace
      };
    });
    if (
      immediateRedo.activeValue !== 'C08X__HISTORY__' ||
      immediateRedo.selectionStart !== 4 ||
      immediateRedo.scrollSpan > 2
    ) {
      throw new Error(`Immediate table keyboard redo lost its caret or bounced: ${JSON.stringify(immediateRedo)}`);
    }

    await page.keyboard.type('Z');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.evaluate(() => (window as any).__tableHistoryEditor.commitTransientEdits());
    await waitForFrames(page, 8);
    const clippedBeforeUndo = await page.evaluate(() => {
      const editor = (window as any).__tableHistoryEditor;
      const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
        .find((candidate) => candidate.value === 'C08XZ__HISTORY__');
      if (!input) throw new Error('Missing clipped C08 history input');
      input.focus({ preventScroll: true });
      input.setSelectionRange(5, 5);
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const rect = input.getBoundingClientRect();
      editor.view.scrollDOM.scrollTop += rect.top - viewport.bottom + 2;
      const clippedRect = input.getBoundingClientRect();
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        inputTop: clippedRect.top,
        inputBottom: clippedRect.bottom,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom
      };
    });
    const clippedUndoApplied = await page.evaluate(() => (window as any).__tableHistoryEditor.undo());
    if (!clippedUndoApplied) throw new Error('Clipped table history undo was not applied');
    await page.waitForFunction(() => (
      (window as any).__tableHistoryEditor.getText().includes('| 08 | A08 | B08 | C08X__HISTORY__ | D08 |')
    ));
    await waitForFrames(page, 16);
    const clippedAfterUndo = await page.evaluate(() => {
      const editor = (window as any).__tableHistoryEditor;
      const active = document.activeElement;
      const rect = active instanceof HTMLTextAreaElement ? active.getBoundingClientRect() : null;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        activeValue: active instanceof HTMLTextAreaElement ? active.value : null,
        bottomGap: rect ? viewport.bottom - rect.bottom : null,
        contextMargin: Math.min(editor.view.defaultLineHeight * 2.5, viewport.height * 0.2),
        selectionStart: active instanceof HTMLTextAreaElement ? active.selectionStart : null,
        scrollTop: editor.view.scrollDOM.scrollTop,
        inputTop: rect?.top ?? null,
        inputBottom: rect?.bottom ?? null,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom,
        caretVisible: Boolean(
          rect &&
          rect.top <= viewport.bottom - 20 &&
          rect.bottom >= viewport.top + 20
        )
      };
    });
    if (
      clippedBeforeUndo.inputTop >= clippedBeforeUndo.viewportBottom ||
      clippedBeforeUndo.inputBottom <= clippedBeforeUndo.viewportBottom ||
      clippedAfterUndo.activeValue !== 'C08X__HISTORY__' ||
      clippedAfterUndo.selectionStart !== 4 ||
      !clippedAfterUndo.caretVisible ||
      clippedAfterUndo.bottomGap === null ||
      clippedAfterUndo.bottomGap < clippedAfterUndo.contextMargin - 2
    ) {
      throw new Error(`Clipped table history did not reveal its restored caret: ${JSON.stringify({
        clippedBeforeUndo,
        clippedAfterUndo
      })}`);
    }

    console.log('visible table history viewport regression passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
