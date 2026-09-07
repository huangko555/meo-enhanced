import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { getUiStrings, type UiLanguage } from '../webview/src/application/uiLanguage';
import { launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-live-ui-language-'));

async function waitForFrames(page: Page, count = 8): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

function expectedLabels(language: UiLanguage, mermaidLine: number, formulaLine: number) {
  const strings = getUiStrings(language);
  return {
    openLink: strings.openLink,
    footnote: strings.jumpToFootnote(1),
    footnoteBack: strings.jumpToFootnoteReference(1),
    codeActions: [strings.selectAllCode, strings.copyCode, strings.selectAllCode, strings.copyCode],
    longCode: strings.showMoreCode(9),
    longCodeFloating: strings.showLessCode,
    imageActions: [strings.openLink, strings.openWithSystemApp, strings.fullscreenImage],
    task: strings.markTaskComplete,
    alert: strings.alertLabel('NOTE'),
    html: strings.showHtmlSource,
    merge: [strings.acceptCurrent, strings.acceptIncoming, strings.acceptBoth],
    tableControls: [
      strings.tableActions,
      strings.tableInsert,
      strings.tableMove,
      strings.tableAlign,
      strings.tableDelete,
      strings.tableBack,
      strings.insertRowAbove,
      strings.insertRowBelow,
      strings.insertColumnLeft,
      strings.insertColumnRight,
      strings.tableBack,
      strings.moveRowUp,
      strings.moveRowDown,
      strings.moveColumnLeft,
      strings.moveColumnRight,
      strings.tableBack,
      strings.alignColumnLeft,
      strings.alignColumnCenter,
      strings.alignColumnRight,
      strings.tableBack,
      strings.deleteRow,
      strings.deleteColumn
    ],
    mermaidControls: strings.mermaidBlockControls(mermaidLine),
    mermaidMode: strings.editMermaidSplit,
    formulaControls: strings.formulaBlockControls(formulaLine),
    formulaMode: strings.editFormulaSplit,
    color: strings.colorLabel('#ff0000')
  };
}

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(repoRoot, 'scripts', 'test-list-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 2000, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><body><main id="editor-host"></main></body>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: `
      :root { --vscode-editor-font-family: monospace; --vscode-editor-font-size: 14px; --vscode-editor-line-height: 20px; }
      body { margin: 0; }
      #editor-host { width: 1100px; height: 1800px; }
      #editor-host .cm-editor { height: 100%; }
    ` });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    const longCode = Array.from({ length: 19 }, (_, index) => `const long${index + 1} = ${index + 1};`);
    const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
    const lines = [
      ...Array.from({ length: 10 }, (_, index) => `leading prose ${index + 1}`),
      '',
      '[Open](https://example.com)',
      '',
      '<details>',
      '<summary>More</summary>',
      'Body',
      '</details>',
      '',
      'Footnote[^1]',
      '',
      '[^1]: note',
      '',
      `- [ ] task`,
      '',
      `[![Pixel](${pixel})](https://example.com)`,
      '',
      '```ts',
      'const value = 1;',
      '```',
      '',
      '```js',
      ...longCode,
      '```',
      '',
      '```mermaid',
      'graph TD',
      'A-->B',
      '```',
      '',
      '$$',
      'x^2',
      '$$',
      '',
      '> [!NOTE]',
      '> note',
      '',
      'Color #ff0000',
      '',
      '<div>HTML</div>',
      '',
      '<<<<<<< Current',
      'current',
      '=======',
      'incoming',
      '>>>>>>> Incoming',
      '',
      '| A | B |',
      '| --- | --- |',
      '| one | two |',
      '',
      ...Array.from({ length: 80 }, (_, index) => `trailing prose ${index + 1}`)
    ];
    const text = lines.join('\n');
    const mermaidLine = lines.indexOf('```mermaid') + 1;
    const formulaLine = lines.indexOf('$$') + 1;

    await page.evaluate((source) => {
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('editor-host')!,
        text: source,
        initialMode: 'live',
        uiLanguage: 'zh-CN',
        onApplyChanges() {}
      });
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
      editor.restoreTopLine(1, 0, { syncCursor: false, force: true });
      (window as any).__liveUiLanguageEditor = editor;
    }, text);
    await page.waitForFunction(() => (
      document.querySelectorAll('.meo-code-block-actions [aria-label]').length >= 4
      && Boolean(document.querySelector('.meo-md-long-code-placeholder .meo-long-code-action'))
      && Boolean(document.querySelector('.meo-mermaid-mode-btn'))
      && Boolean(document.querySelector('.meo-latex-math-mode-btn'))
      && Boolean(document.querySelector('.meo-md-html-source-toggle'))
      && Boolean(document.querySelector('.meo-md-html-table-context-menu'))
    ));
    await waitForFrames(page);

    const result = await page.evaluate(async () => {
      const editor = (window as any).__liveUiLanguageEditor;
      const pointer = (button: HTMLButtonElement) => button.dispatchEvent(new PointerEvent('pointerdown', {
        button: 0,
        bubbles: true,
        cancelable: true
      }));
      const readLabel = (selector: string) => document.querySelector<HTMLElement>(selector)?.getAttribute('aria-label') ?? null;
      const readLabels = (selector: string) => Array.from(
        document.querySelectorAll<HTMLElement>(selector),
        (element) => element.getAttribute('aria-label')
      );
      const read = () => ({
        openLink: readLabel('.meo-md-link-open-btn'),
        footnote: readLabel('.meo-md-footnote-ref'),
        footnoteBack: readLabel('.meo-md-footnote-backref'),
        codeActions: readLabels('.meo-code-block-actions [aria-label]'),
        longCode: readLabel('.meo-md-long-code-placeholder .meo-long-code-action'),
        longCodeFloating: readLabel('.meo-long-code-floating-action'),
        imageActions: readLabels('.meo-md-image-controls [aria-label]'),
        task: readLabel('.meo-task-checkbox'),
        alert: document.querySelector('.meo-md-alert-label')?.textContent ?? null,
        html: readLabel('.meo-md-html-source-toggle:not(.meo-md-details-source-toggle)'),
        merge: Array.from(document.querySelectorAll<HTMLElement>('.meo-merge-action-btn'), (button) => button.textContent),
        tableControls: [
          readLabel('.meo-md-html-table-context-trigger'),
          ...readLabels('.meo-md-html-table-context-menu button[aria-label]')
        ],
        mermaidControls: readLabel('.meo-mermaid-toolbar'),
        mermaidMode: readLabel('.meo-mermaid-mode-btn'),
        formulaControls: readLabel('.meo-latex-math-toolbar'),
        formulaMode: readLabel('.meo-latex-math-mode-btn'),
        color: readLabel('.meo-md-color-swatch')
      });

      editor.view.scrollDOM.scrollTop = 120;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const tableTrigger = document.querySelector<HTMLButtonElement>('.meo-md-html-table-context-trigger')!;
      pointer(tableTrigger);
      pointer(document.querySelector<HTMLButtonElement>('[data-context-panel-target="insert"]')!);
      const gutter = editor.view.dom.querySelector<HTMLElement>('.cm-gutters')!;
      const lineNumberNodes = Array.from(gutter.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'));
      const tableLineNumbers = gutter.querySelector<HTMLElement>('.meo-md-html-table-line-numbers');
      const mutationRecords: MutationRecord[] = [];
      const observer = new MutationObserver((records) => mutationRecords.push(...records));
      observer.observe(gutter, { childList: true, subtree: true });
      const before = {
        labels: read(),
        scrollTop: editor.view.scrollDOM.scrollTop,
        selection: editor.view.state.selection.toJSON(),
        history: editor.getHistoryDepth(),
        text: editor.getText(),
        tableMenuOpen: tableTrigger.getAttribute('aria-expanded'),
        tablePanel: document.querySelector<HTMLElement>('.meo-md-html-table-context-menu')?.dataset.activePanel
      };
      editor.setUiLanguage('en');
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      observer.disconnect();
      const nextLineNumberNodes = Array.from(gutter.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'));
      const after = {
        labels: read(),
        scrollTop: editor.view.scrollDOM.scrollTop,
        selection: editor.view.state.selection.toJSON(),
        history: editor.getHistoryDepth(),
        text: editor.getText(),
        tableMenuOpen: document.querySelector('.meo-md-html-table-context-trigger')?.getAttribute('aria-expanded'),
        tablePanel: document.querySelector<HTMLElement>('.meo-md-html-table-context-menu')?.dataset.activePanel,
        stableLineNumbers: lineNumberNodes.length === nextLineNumberNodes.length
          && lineNumberNodes.every((node, index) => node === nextLineNumberNodes[index]),
        stableTableLineNumbers: tableLineNumbers === gutter.querySelector('.meo-md-html-table-line-numbers'),
        replacedGutterNodes: mutationRecords.reduce(
          (count, record) => count + record.addedNodes.length + record.removedNodes.length,
          0
        ),
        gutterMutations: mutationRecords.map((record) => ({
          target: (record.target as HTMLElement).className ?? record.target.nodeName,
          added: Array.from(record.addedNodes, (node) => (node as HTMLElement).className ?? node.nodeName),
          removed: Array.from(record.removedNodes, (node) => (node as HTMLElement).className ?? node.nodeName)
        }))
      };
      editor.destroy();
      return { before, after };
    });

    assert.deepEqual(result.before.labels, expectedLabels('zh-CN', mermaidLine, formulaLine));
    assert.deepEqual(
      result.after.labels.tableControls,
      expectedLabels('en', mermaidLine, formulaLine).tableControls,
      'table menu labels did not update in place'
    );
    assert.equal(result.before.tableMenuOpen, 'true');
    assert.equal(result.after.tableMenuOpen, 'true', 'language switch closed the open table menu');
    assert.equal(result.before.tablePanel, 'insert');
    assert.equal(result.after.tablePanel, 'insert', 'language switch reset the active table submenu');
    assert.ok(Math.abs(result.after.scrollTop - result.before.scrollTop) <= 1, 'language switch moved the Live viewport');
    assert.deepEqual(result.after.selection, result.before.selection, 'language switch changed the editor selection');
    assert.deepEqual(result.after.history, result.before.history, 'language switch changed undo/redo history');
    assert.equal(result.after.text, result.before.text, 'language switch changed document content');
    assert.equal(result.after.stableLineNumbers, true, 'language switch replaced ordinary line number nodes');
    assert.equal(result.after.stableTableLineNumbers, true, 'language switch replaced table-projected line numbers');
    assert.equal(
      result.after.replacedGutterNodes,
      0,
      `language switch mutated gutter structure: ${JSON.stringify(result.after.gutterMutations)}`
    );
    console.log('Live UI language switch checks passed');
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
