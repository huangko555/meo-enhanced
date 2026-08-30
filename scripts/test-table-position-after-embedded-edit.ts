import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-position-after-embedded-edit-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 6): Promise<void> {
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
    await page.setViewport({ width: 1100, height: 700, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b1f23;--meo-surface-background:#24292e;--meo-semantic-mutedForeground:#8b949e;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      const text = [
        '# Embedded edit before table',
        '',
        '```mermaid',
        'flowchart LR',
        '  A[Start] --> B[Done]',
        '```',
        '',
        '| ID | Status |',
        '| --- | --- |',
        '| 1 | Ready |',
        '| 2 | Done |'
      ].join('\n');
      (window as any).__tablePositionEditor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await page.waitForFunction(() => Boolean(document.querySelector('.meo-mermaid-mode-btn')));
    await page.waitForFunction(() => Boolean(document.querySelector('.meo-md-html-table textarea')));

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const split = await page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>('.meo-mermaid-mode-btn');
        if (!button) throw new Error('Missing Mermaid mode button');
        if (button.getAttribute('aria-label') === 'Show Mermaid code only') return true;
        button.click();
        return false;
      });
      if (split) break;
      await waitForFrames(page, 8);
    }
    await page.waitForFunction(() => Boolean(document.querySelector('.meo-mermaid-editing-block.is-split .cm-content')));
    await page.evaluate(() => {
      const content = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-split .cm-content');
      if (!content) throw new Error('Missing Mermaid split source editor');
      const range = document.createRange();
      range.selectNodeContents(content);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      content.focus({ preventScroll: true });
    });
    await page.keyboard.press('Enter');
    await page.keyboard.type('%% INSERTED_BEFORE_TABLE');
    await page.waitForFunction(() => (
      (window as any).__tablePositionEditor.getText().includes('%% INSERTED_BEFORE_TABLE')
    ));
    await waitForFrames(page, 10);

    const before = await page.evaluate(() => {
      const editor = (window as any).__tablePositionEditor;
      const lines = editor.getText().split('\n');
      const actualLine = lines.findIndex((line: string) => line === '| 1 | Ready |') + 1;
      const row = Array.from(document.querySelectorAll<HTMLElement>('.meo-md-html-table tbody tr'))
        .find((candidate) => Array.from(candidate.querySelectorAll<HTMLTextAreaElement>('textarea'))
          .some((input) => input.value === 'Ready'));
      const input = Array.from(row?.querySelectorAll<HTMLTextAreaElement>('textarea') ?? [])
        .find((candidate) => candidate.value === 'Ready');
      if (!input) throw new Error('Missing Ready table input');
      const wrap = input.closest<HTMLElement>('.meo-md-html-table-wrap');
      const table = input.closest<HTMLTableElement>('table');
      const domPosition = wrap ? editor.view.posAtDOM(wrap, 0) : -1;
      const tableFrom = Number(table?.dataset.tableFrom);
      const renderedLineBeforeFocus = Number(row?.dataset.sourceLineNumber);
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      return {
        actualLine,
        renderedLineBeforeFocus,
        renderedLine: Number(row?.dataset.sourceLineNumber),
        domLine: domPosition >= 0 ? editor.view.state.doc.lineAt(domPosition).number : null,
        tableFromLine: Number.isFinite(tableFrom) ? editor.view.state.doc.lineAt(tableFrom).number : null,
        shellStart: Number(input.closest<HTMLElement>('.meo-md-html-table-shell')?.dataset.meoRenderedBlockStartLine),
        mermaidLastLine: lines[lines.findIndex((line: string) => line === '```' && lines.indexOf('```mermaid') < lines.indexOf(line)) - 1]
      };
    });
    await page.keyboard.type('__TABLE_EDIT__');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.evaluate(() => (window as any).__tablePositionEditor.commitTransientEdits());
    await waitForFrames(page, 10);

    const after = await page.evaluate(() => {
      const editor = (window as any).__tablePositionEditor;
      const text = editor.getText();
      const lines = text.split('\n');
      const active = document.activeElement;
      return {
        text,
        tableLine: lines.find((line: string) => line.includes('| 1 |')) ?? null,
        mermaidMarkerLine: lines.find((line: string) => line.includes('INSERTED_BEFORE_TABLE')) ?? null,
        focused: active instanceof HTMLTextAreaElement,
        value: active instanceof HTMLTextAreaElement ? active.value : null,
        renderedLine: active instanceof HTMLTextAreaElement
          ? Number(active.closest('tr')?.dataset.sourceLineNumber)
          : null
      };
    });
    if (
      before.renderedLineBeforeFocus !== before.actualLine ||
      before.renderedLine !== before.actualLine ||
      after.tableLine !== '| 1 | Ready__TABLE_EDIT__ |' ||
      after.mermaidMarkerLine?.trim() !== '%% INSERTED_BEFORE_TABLE' ||
      !after.focused || after.value !== 'Ready__TABLE_EDIT__' ||
      after.renderedLine !== before.actualLine
    ) {
      throw new Error(`Table edit used a stale position after embedded input: ${JSON.stringify({ before, after: {
        tableLine: after.tableLine,
        mermaidMarkerLine: after.mermaidMarkerLine,
        focused: after.focused,
        value: after.value,
        renderedLine: after.renderedLine
      } })}`);
    }

    console.log('table position after embedded edit regression passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
