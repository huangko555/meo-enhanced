import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const repoRoot = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-input-visual-stability-'));

async function waitForFrames(page: import('puppeteer-core').Page, count = 6): Promise<void> {
  await page.evaluate(async (frameCount) => {
    for (let index = 0; index < frameCount; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function focusCell(page: import('puppeteer-core').Page, value: string): Promise<void> {
  await page.evaluate((targetValue) => {
    const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
      .find((candidate) => candidate.value === targetValue);
    if (!input) throw new Error(`Missing table input: ${targetValue}`);
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
  }, value);
  await waitForFrames(page, 8);
}

async function assertColumnReflowKeepsActiveCell(page: import('puppeteer-core').Page): Promise<void> {
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  let unwrappedCases = 0;
  for (const repeats of [2, 3, 4, 5]) {
    await page.evaluate((repeats) => {
      (window as any).__tableVisualEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      const description = `1. 准备 - 检查材料 - 确认环境2. 执行 1. 第一阶段 2. 第二阶段 [参考链接](https://example.com/)${'L'.repeat(repeats * 16)}`;
      const text = [
        ...Array.from({ length: 80 }, () => 'Table reflow spacer.'), '',
        '| 类型 | 单元格内容 |', '| --- | --- |',
        '| 嵌套无序列表 | - 一级 A- 二级 A.1 - 二级 1. A.2- 一级 B |',
        `| 混合嵌套列表 | ${description} |`, '',
        ...Array.from({ length: 80 }, () => 'Table reflow tail.')
      ].join('\n');
      const editor = (window as any).EmbeddedInputViewportHarness.createEditor({ parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {} });
      (window as any).__tableVisualEditor = editor;
      editor.scrollToLine(85, 'center');
    }, repeats);
    await waitForFrames(page, 16);
    await focusCell(page, '混合嵌套列表');
    await page.evaluate(() => {
      const input = document.activeElement as HTMLTextAreaElement;
      const row = input.closest('tr')!;
      const previous = row.previousElementSibling!;
      (window as any).__columnReflowProbe = { input, previous, beforeHeight: previous.getBoundingClientRect().height, tops: [input.getBoundingClientRect().top], sampling: true };
      const sample = () => {
        const probe = (window as any).__columnReflowProbe;
        if (!probe.sampling) return;
        probe.tops.push(input.getBoundingClientRect().top);
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.type('X');
    await new Promise(resolve => setTimeout(resolve, 500));
    await waitForFrames(page, 12);
    const result = await page.evaluate(() => {
      const probe = (window as any).__columnReflowProbe;
      probe.sampling = false;
      return { heightDelta: probe.previous.getBoundingClientRect().height - probe.beforeHeight, topSpan: Math.max(...probe.tops) - Math.min(...probe.tops), focused: probe.input.isConnected && probe.input === document.activeElement, value: probe.input.value };
    });
    if (result.heightDelta < -10) unwrappedCases++;
    if (!result.focused || result.value !== '混合嵌套列表X' || result.topSpan > 2) throw new Error(`Column reflow moved active cell: ${JSON.stringify({ repeats, ...result })}`);
  }
  if (!unwrappedCases) throw new Error('Column reflow fixture did not unwrap an earlier row');
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
    await page.setViewport({ width: 1000, height: 650, deviceScaleFactor: 1 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
    await page.addStyleTag({ path: path.join(repoRoot, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({
      content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b1f23;--meo-surface-background:#24292e;--meo-semantic-mutedForeground:#8b949e;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}'
    });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    await page.evaluate(() => {
      const text = [
        '# Long table',
        '',
        '| Feature | Long description | Example | Result |',
        '| --- | --- | --- | --- |',
        '| Long Chinese | 这是一段很长很长的中文说明文字，用来测试表格列宽、自动换行、输入后高度变化以及撤销重做时的布局稳定性。 | 原始值 LONG-CN | Pending |',
        '| Long English | This is a deliberately long English sentence for testing elastic table width, wrapping, resizing, undo and redo behavior. | `const width = 320` | Ready |',
        '| Link | 一个带有较长文字的链接 | [very long link text example](https://example.com/undo-redo/table) | Done |',
        '| Mixed | **粗体**、*斜体*、~~删除~~、`代码` | #mixed/table | Mixed |'
      ].join('\n');
      (window as any).__tableVisualEditor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
    });
    await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table textarea').length >= 20);

    await focusCell(page, 'Pending');
    await page.keyboard.type('__FIRST_EDIT__');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await page.evaluate(() => (window as any).__tableVisualEditor.commitTransientEdits());
    await waitForFrames(page, 12);

    await focusCell(page, 'Mixed');
    await page.evaluate(() => {
      const editor = (window as any).__tableVisualEditor;
      (window as any).__tableVisualTrace = [];
      const sample = () => {
        const active = document.activeElement;
        const rect = active instanceof HTMLTextAreaElement ? active.getBoundingClientRect() : null;
        const shell = active instanceof HTMLTextAreaElement
          ? active.closest<HTMLElement>('.meo-md-html-table-shell')
          : null;
        const table = active instanceof HTMLTextAreaElement ? active.closest<HTMLTableElement>('table') : null;
        (window as any).__tableVisualTrace.push({
          top: rect?.top ?? null,
          scrollTop: editor.view.scrollDOM.scrollTop,
          activeTag: active?.tagName ?? null,
          value: active instanceof HTMLTextAreaElement ? active.value : null,
          shellClass: shell?.className ?? null,
          tableTop: table?.getBoundingClientRect().top ?? null,
          tableHeight: table?.getBoundingClientRect().height ?? null
        });
        if ((window as any).__tableVisualTrace.length < 90) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.type('__SECOND_EDIT__');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await page.evaluate(() => (window as any).__tableVisualEditor.commitTransientEdits());
    await waitForFrames(page, 15);

    const result = await page.evaluate(() => {
      const editor = (window as any).__tableVisualEditor;
      const samples = (window as any).__tableVisualTrace as Array<{
        top: number | null;
        scrollTop: number;
        activeTag: string | null;
        value: string | null;
        shellClass: string | null;
        tableTop: number | null;
        tableHeight: number | null;
      }>;
      const tops = samples.map((sample) => sample.top).filter((value): value is number => value !== null);
      const scrolls = samples.map((sample) => sample.scrollTop);
      const active = document.activeElement;
      const sourceLines = editor.getText().split('\n');
      const transitions = samples.filter((sample, index) => (
        index === 0 || sample.top !== samples[index - 1]?.top || sample.tableHeight !== samples[index - 1]?.tableHeight
      )).map((sample, index) => ({ index, ...sample }));
      return {
        topSpan: tops.length ? Math.max(...tops) - Math.min(...tops) : null,
        scrollSpan: scrolls.length ? Math.max(...scrolls) - Math.min(...scrolls) : null,
        activeTags: [...new Set(samples.map((sample) => sample.activeTag))],
        focused: active instanceof HTMLTextAreaElement,
        value: active instanceof HTMLTextAreaElement ? active.value : null,
        sourceLine: sourceLines.find((line: string) => line.includes('SECOND_EDIT')) ?? null,
        transitions
      };
    });
    if (
      result.topSpan === null || result.topSpan > 2 ||
      result.scrollSpan === null || result.scrollSpan > 2 ||
      !result.focused || result.value !== 'Mixed__SECOND_EDIT__' ||
      !result.sourceLine?.includes('Mixed__SECOND_EDIT__')
    ) {
      throw new Error(`Table input moved while the caret remained visible: ${JSON.stringify(result)}`);
    }

    await assertColumnReflowKeepsActiveCell(page);
    console.log('table input visual stability regression passed');
  } catch (error) {
    primaryError = error;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
}

await main();
