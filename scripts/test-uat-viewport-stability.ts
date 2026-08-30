import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-uat-viewport-stability-'));

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
    await page.setViewport({ width: 1100, height: 650, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b1f23;--meo-surface-background:#24292e;--meo-semantic-mutedForeground:#8b949e;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });

    await page.evaluate(() => {
      const lines = [
        ...Array.from({ length: 257 }, (_, index) => `验收前置行 ${index + 1}`),
        '# 10. Mermaid',
        '',
        '## 10.1 流程图',
        '',
        '```mermaid',
        'flowchart LR',
        '  A[Baseline A] --> B{Choose}',
        '  B -->|Undo| C[Restore]',
        '  B -->|Redo| D[Reapply]',
        '  C --> E[Done]',
        '  D --> E',
        '```',
        '',
        '## 10.2 时序图',
        '',
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
        '',
        '# 11. 表格一：基础编辑',
        '',
        '| ID | 名称 | 状态 |',
        '| --- | --- | --- |',
        '| 1 | Alpha | Ready |',
        '| 2 | Bravo | Editing |',
        '| 3 | Charlie | Done |',
        '',
        '# 12. 表格二：对齐与行内格式',
        '',
        '| 左对齐说明 | 居中标签 | 右对齐数值 |',
        '| :--- | :---: | ---: |',
        '| 普通文字 | **Bold** | 100.25 |',
        '| [链接](https://example.com) | `inline code` | 200.50 |',
        '| ~~旧值~~ 新值 | #table/tag | 300.75 |',
        '',
        '# 13. 表格三：多行多列编辑区',
        '',
        '| 行 | A 列 | B 列 | C 列 | D 列 |',
        '| ---: | --- | --- | --- | --- |',
        ...Array.from({ length: 12 }, (_, index) => {
          const row = String(index + 1).padStart(2, '0');
          return `| ${row} | A${row} | B${row} | C${row} | D${row} |`;
        }),
        '',
        '# 14. 后续内容',
        ...Array.from({ length: 80 }, (_, index) => `验收后置行 ${index + 1}`)
      ];
      if (lines[272] !== '```mermaid' || !lines[287]?.includes('Alpha') || !lines[314]?.includes('D12')) {
        throw new Error(`UAT fixture line contract failed: ${JSON.stringify({
          line273: lines[272],
          line288: lines[287],
          line315: lines[314]
        })}`);
      }
      (window as any).__uatEditor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!,
        text: lines.join('\n'),
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__uatEditor.scrollToLine(273, 'center');
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-mermaid-mode-btn').length === 2);
    await page.waitForFunction(() => document.querySelectorAll('.meo-mermaid-block svg').length >= 1);

    const clickSecondMermaidMode = async () => {
      await page.evaluate(() => {
        document.querySelectorAll<HTMLButtonElement>('.meo-mermaid-mode-btn')[1]!.click();
      });
      await waitForFrames(page, 5);
    };

    // preview -> split -> source
    await clickSecondMermaidMode();
    await clickSecondMermaidMode();
    await page.evaluate(() => {
      const editor = (window as any).__uatEditor;
      const block = document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-source')!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      editor.view.scrollDOM.scrollTop += block.getBoundingClientRect().top - viewport.top - 120;
    });
    await waitForFrames(page, 5);
    const sourceSettled = await page.evaluate(() => {
      const editor = (window as any).__uatEditor;
      const button = document.querySelectorAll<HTMLElement>('.meo-mermaid-mode-btn')[1]!;
      return {
        scrollTop: editor.view.scrollDOM.scrollTop,
        buttonTop: button.getBoundingClientRect().top,
        source: Boolean(document.querySelector<HTMLElement>('.meo-mermaid-editing-block.is-source'))
      };
    });
    await page.evaluate(() => {
      const editor = (window as any).__uatEditor;
      (window as any).__sourcePreviewTrace = [];
      const sample = () => {
        const button = document.querySelectorAll<HTMLElement>('.meo-mermaid-mode-btn')[1];
        (window as any).__sourcePreviewTrace.push({
          scrollTop: editor.view.scrollDOM.scrollTop,
          buttonTop: button?.getBoundingClientRect().top ?? null
        });
        if ((window as any).__sourcePreviewTrace.length < 120) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
      document.querySelectorAll<HTMLButtonElement>('.meo-mermaid-mode-btn')[1]!.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const sourcePreviewTrace = await page.evaluate(() => (
      (window as any).__sourcePreviewTrace as Array<{ scrollTop: number; buttonTop: number | null }>
    ));
    const sourcePreviewScrollSpan = Math.max(...sourcePreviewTrace.map((sample) => sample.scrollTop))
      - Math.min(...sourcePreviewTrace.map((sample) => sample.scrollTop));
    const sourcePreviewButtonTops = sourcePreviewTrace
      .map((sample) => sample.buttonTop)
      .filter((value): value is number => value !== null);
    const sourcePreviewButtonSpan = Math.max(...sourcePreviewButtonTops) - Math.min(...sourcePreviewButtonTops);
    const sourcePreviewFocus = await page.evaluate(() => {
      const button = document.querySelectorAll<HTMLButtonElement>('.meo-mermaid-mode-btn')[1]!;
      return { activeSecondModeButton: document.activeElement === button, activeTag: document.activeElement?.tagName ?? null };
    });
    if (
      !sourceSettled.source || sourcePreviewScrollSpan > 0.5 || sourcePreviewButtonSpan > 0.5 ||
      !sourcePreviewFocus.activeSecondModeButton
    ) {
      throw new Error(`Second Mermaid source-to-preview moved the viewport: ${JSON.stringify({
        sourceSettled,
        sourcePreviewScrollSpan,
        sourcePreviewButtonSpan,
        sourcePreviewFocus,
        sourcePreviewTrace
      })}`);
    }

    const editTableCell = async (tableIndex: number, rowIndex: number, colIndex: number, insert: string) => {
      const tableStartLine = [286, 294, 302][tableIndex]!;
      await waitForFrames(page, 10);
      await page.evaluate(({ tableStart, row }) => {
        const editor = (window as any).__uatEditor;
        const shell = document.querySelector<HTMLElement>(
          `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${tableStart}"]`
        )!;
        const targetRow = shell.querySelectorAll<HTMLElement>('tbody tr')[row]!;
        const viewport = editor.view.scrollDOM.getBoundingClientRect();
        editor.view.scrollDOM.scrollTop += targetRow.getBoundingClientRect().top - viewport.top - 180;
      }, { tableStart: tableStartLine, row: rowIndex });
      await waitForFrames(page, 5);
      const point = await page.evaluate(({ tableStart, row, col }) => {
        const input = document.querySelector<HTMLElement>(
          `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${tableStart}"]`
        )!
          .querySelectorAll<HTMLElement>('tbody tr')[row]!
          .querySelectorAll<HTMLTextAreaElement>('textarea')[col]!;
        const rect = input.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }, { tableStart: tableStartLine, row: rowIndex, col: colIndex });
      await page.mouse.click(point.x, point.y);
      await page.keyboard.press('End');
      const before = await page.evaluate(() => {
        const editor = (window as any).__uatEditor;
        const active = document.activeElement as HTMLTextAreaElement;
        const wrap = active.closest<HTMLElement>('.meo-md-html-table-wrap');
        let domLine: number | null = null;
        try {
          const position = wrap ? editor.view.posAtDOM(wrap, 0) : -1;
          domLine = position >= 0 ? editor.view.state.doc.lineAt(position).number : null;
        } catch {}
        return {
          scrollTop: editor.view.scrollDOM.scrollTop,
          sourceLine: active.closest('tr')?.dataset.sourceLineNumber ?? null,
          value: active.value,
          domLine,
          tableFrom: active.closest<HTMLTableElement>('table')?.dataset.tableFrom ?? null,
          shellStart: active.closest<HTMLElement>('.meo-md-html-table-shell')?.dataset.meoRenderedBlockStartLine ?? null,
          dataRow: active.dataset.tableRow ?? null
        };
      });
      for (const character of insert) {
        await page.keyboard.type(character);
        await new Promise((resolve) => setTimeout(resolve, 320));
        await waitForFrames(page, 3);
      }
      const after = await page.evaluate(({ table, row, col }) => {
        const editor = (window as any).__uatEditor;
        const active = document.activeElement;
        return {
          scrollTop: editor.view.scrollDOM.scrollTop,
          activeTextarea: active instanceof HTMLTextAreaElement,
          sourceLine: active instanceof HTMLTextAreaElement
            ? active.closest('tr')?.dataset.sourceLineNumber ?? null
            : null,
          value: active instanceof HTMLTextAreaElement ? active.value : null,
          activeTag: active?.tagName ?? null,
          selectionLine: editor.view.state.doc.lineAt(editor.view.state.selection.main.head).number,
          shellStarts: Array.from(
            document.querySelectorAll<HTMLElement>('.meo-md-html-table-shell'),
            (shell) => shell.dataset.meoRenderedBlockStartLine ?? null
          ),
          targetCount: document.querySelectorAll(
            `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${table === 2 ? 302 : 286}"] textarea[data-table-row="${row + 1}"][data-table-col="${col}"]`
          ).length,
          sourceLines: table === 2
            ? Array.from({ length: 5 }, (_, index) => editor.view.state.doc.line(311 + index).text)
            : []
        };
      }, { table: tableIndex, row: rowIndex, col: colIndex });
      return { before, after };
    };

    const line288 = await editTableCell(0, 0, 2, '8');
    const line289 = await editTableCell(0, 1, 2, '9');
    const line315 = await editTableCell(2, 11, 4, 'XYZ');
    if (
      line288.before.sourceLine !== '288' || line288.after.sourceLine !== '288' ||
      line289.before.sourceLine !== '289' || line289.after.sourceLine !== '289' ||
      line315.before.sourceLine !== '315' || line315.after.sourceLine !== '315' ||
      !line288.after.activeTextarea || !line289.after.activeTextarea || !line315.after.activeTextarea ||
      !line288.after.value?.endsWith('8') || !line289.after.value?.endsWith('9') || !line315.after.value?.endsWith('XYZ') ||
      Math.abs(line288.after.scrollTop - line288.before.scrollTop) > 0.5 ||
      Math.abs(line289.after.scrollTop - line289.before.scrollTop) > 0.5 ||
      Math.abs(line315.after.scrollTop - line315.before.scrollTop) > 0.5
    ) {
      throw new Error(`UAT table input moved viewport or changed rows: ${JSON.stringify({ line288, line289, line315 })}`);
    }

    console.log('UAT viewport stability regression test passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
