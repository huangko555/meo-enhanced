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
  const point = await page.evaluate((targetValue) => {
    const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
      .find((candidate) => candidate.value === targetValue);
    if (!input) throw new Error(`Missing table input: ${targetValue}`);
    const preview = input.closest('td')!.querySelector<HTMLElement>('.meo-md-html-table-cell-preview')!;
    const bounds = preview.getBoundingClientRect();
    return { x: bounds.left + Math.min(12, bounds.width / 2), y: bounds.top + bounds.height / 2 };
  }, value);
  await page.mouse.click(point.x, point.y);
  await page.evaluate((targetValue) => {
    const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
      .find((candidate) => candidate.value === targetValue)!;
    if (document.activeElement !== input) throw new Error(`Table click did not activate: ${targetValue}`);
    input.setSelectionRange(input.value.length, input.value.length);
  }, value);
  await waitForFrames(page, 8);
}

async function assertPendingCellSurvivesPresentation(page: import('puppeteer-core').Page): Promise<void> {
  await page.evaluate(() => {
    (window as any).__tableVisualEditor?.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__tableVisualEditor = (window as any).EmbeddedInputViewportHarness.createEditor({
      parent: document.getElementById('app')!, initialMode: 'live', onApplyChanges() {},
      text: '# Pending native edit\n\n| Kind | Content |\n| --- | --- |\n| Row | Value |\n\nAfter table.'
    });
  });
  await waitForFrames(page, 12);
  const selector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea[data-table-row="0"][data-table-col="1"]';
  await page.$eval(selector, (input: HTMLTextAreaElement) => { input.focus({ preventScroll: true }); input.setSelectionRange(0, 0); });
  await page.keyboard.type('4');
  await page.evaluate(() => (window as any).__tableVisualEditor.commitTransientEdits());
  await waitForFrames(page, 8);
  await page.keyboard.type('4');
  // The frame refresh reads the accepted document while the native textarea
  // already owns the next edit. getText() would flush that edit and hide this race.
  await page.evaluate(() => {
    const editor = (window as any).__tableVisualEditor, from = editor.view.state.doc.toString().indexOf('4Content');
    editor.setDiagnostics([{ from, to: from + 1, severity: 1, message: 'Late presentation fixture' }]);
  });
  await waitForFrames(page, 4);
  const value = await page.$eval(selector, (input: HTMLTextAreaElement) => ({ value: input.value, start: input.selectionStart,
    end: input.selectionEnd, active: document.activeElement === input }));
  if (value.value !== '44Content' || value.start !== 2 || value.end !== 2 || !value.active) {
    throw new Error(`Late table presentation overwrote a newer native edit: ${JSON.stringify(value)}`);
  }
  await page.evaluate(() => (window as any).__tableVisualEditor.commitTransientEdits());
  if (!(await page.evaluate(() => (window as any).__tableVisualEditor.getText())).includes('44Content')) {
    throw new Error('The surviving native edit did not reach the document');
  }
  for (const scene of [
    { row: 0, col: 1, start: 3, end: 6, insert: '75', key: '' },
    { row: 0, col: 1, start: 2, end: 2, insert: '', key: 'Backspace' },
    { row: 0, col: 1, start: 1, end: 1, insert: '', key: 'Delete' },
    { row: 1, col: 0, start: 1, end: 1, insert: '4'.repeat(70), key: '' },
    { row: 0, col: 1, start: 1, end: 4, insert: '**paste**', key: '' }
  ]) {
    const target = `.meo-md-html-table:not(.meo-md-html-table-sticky-table) textarea[data-table-row="${scene.row}"][data-table-col="${scene.col}"]`;
    const before = await page.$eval(target, (input: HTMLTextAreaElement, scene) => {
      input.focus({ preventScroll: true }); input.setSelectionRange(scene.start, scene.end); return input.value;
    }, scene);
    const from = scene.key === 'Backspace' ? scene.start - 1 : scene.start;
    const to = scene.key === 'Delete' ? scene.end + 1 : scene.end;
    const expected = before.slice(0, from) + scene.insert + before.slice(to), caret = from + scene.insert.length;
    // Deliver the older accepted presentation in the same trusted input task,
    // after the native editor records its draft and before its commit timer can
    // run. A second CDP round trip can otherwise miss the pending-edit race.
    await page.$eval(target, (input: HTMLTextAreaElement, before) => {
      const probe = { baseline: 0, delivered: false, error: '' };
      (window as any).__pendingPresentationProbe = probe;
      input.addEventListener('input', () => {
        const editor = (window as any).__tableVisualEditor;
        const from = editor.view.state.doc.toString().indexOf(before);
        probe.baseline = input.getBoundingClientRect().top;
        if (from < 0) { probe.error = 'Pending edit fixture lost its accepted source'; return; }
        editor.setDiagnostics([{ from, to: from + 1, severity: 1, message: `Late presentation ${from}` }]);
        probe.delivered = true;
      }, { once: true });
    }, before);
    if (scene.key) await page.keyboard.press(scene.key);
    else await page.keyboard.sendCharacter(scene.insert);
    const baseline = await page.evaluate(() => {
      const probe = (window as any).__pendingPresentationProbe;
      if (probe.error || !probe.delivered) throw new Error(probe.error || 'Pending input listener did not deliver the presentation');
      return probe.baseline as number;
    });
    await waitForFrames(page, 4);
    const result = await page.$eval(target, (input: HTMLTextAreaElement) => ({ value: input.value,
      start: input.selectionStart, end: input.selectionEnd, top: input.getBoundingClientRect().top,
      active: document.activeElement === input }));
    if (result.value !== expected || result.start !== caret || result.end !== caret || !result.active
      || Math.abs(result.top - baseline) > 1) throw new Error(`Late presentation damaged ${JSON.stringify(scene)}: ${JSON.stringify(result)}`);
    await page.evaluate(() => (window as any).__tableVisualEditor.commitTransientEdits());
    if (!(await page.evaluate(() => (window as any).__tableVisualEditor.view.state.doc.toString())).includes(expected)) {
      throw new Error('Replacement, deletion or inserted text was not committed');
    }
  }
  const accepted = await page.$eval(selector, (input: HTMLTextAreaElement) => { input.focus({ preventScroll: true }); input.setSelectionRange(0, 0); return input.value; });
  const external = await page.evaluate(accepted => (window as any).__tableVisualEditor.view.state.doc.toString().replace(accepted, 'External'), accepted);
  await page.keyboard.type('X');
  await page.evaluate(external => (window as any).__tableVisualEditor.setText(external), external);
  await waitForFrames(page, 6);
  const externalValue = await page.$eval(selector, (input: HTMLTextAreaElement) => input.value);
  if (externalValue !== 'External') throw new Error(`Explicit external replacement retained an obsolete native edit: ${externalValue}`);
  await page.evaluate(() => (window as any).__tableVisualEditor.commitTransientEdits());
  if (await page.evaluate(() => (window as any).__tableVisualEditor.view.state.doc.toString()) !== external) {
    throw new Error('A discarded native edit resurfaced after external replacement');
  }
  await page.evaluate(() => { (window as any).__tableVisualEditor.destroy(); document.getElementById('app')!.replaceChildren(); });
}

async function assertColumnReflowKeepsActiveCell(page: import('puppeteer-core').Page): Promise<void> {
  await page.setViewport({ width: 1280, height: 760, deviceScaleFactor: 1 });
  const resizeFirstColumn = async (delta: number) => {
    const point = await page.evaluate(() => {
      const handle = document.querySelector<HTMLElement>('table[data-table-column-width] [data-table-resize-column="0"]')!;
      const rect = handle.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.mouse.move(point.x + delta, point.y, { steps: 5 });
    await page.mouse.up();
    await waitForFrames(page, 8);
  };
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
    // Reflow must come from an actual width change. Typing alone no longer
    // triggers incidental column projection after passive observers were fixed.
    await resizeFirstColumn(-60);
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
    await resizeFirstColumn(100);
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

async function assertWrappingCellGrowsDownward(page: import('puppeteer-core').Page): Promise<void> {
  await page.setViewport({ width: 760, height: 360, deviceScaleFactor: 1 });
  const scenarios = [
    { targetTop: 120, text: '继续输入内容以触发自动换行和高度变化' },
    { targetTop: 190, text: '继续输入内容以触发自动换行和高度变化' },
    { targetTop: 280, text: '继续输入内容以触发' }
  ];
  for (const { targetTop, text } of scenarios) {
    await page.evaluate((targetTop) => {
      (window as any).__tableVisualEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      const rows = Array.from({ length: 12 }, () => '|  |  |  |  |  |  |  |');
      const text = [
        ...Array.from({ length: 50 }, (_, index) => `前置正文 ${index + 1}`),
        '',
        '| 类型 | | 类型 |  |  | 内容 | 备注 |',
        '| --- | --- | --- | --- | --- |',
        ...rows,
        '',
        ...Array.from({ length: 50 }, (_, index) => `后置正文 ${index + 1}`)
      ].join('\n');
      const editor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__tableVisualEditor = editor;
      editor.scrollToLine(63, 'center');
      (window as any).__tableWrapTargetTop = targetTop;
    }, targetTop);
    await page.waitForSelector(
      '.meo-md-html-table-shell tbody textarea[data-table-row="10"][data-table-col="3"]'
    );
    await waitForFrames(page, 10);

    await page.evaluate(() => {
      const editor = (window as any).__tableVisualEditor;
      const input = document.querySelector<HTMLTextAreaElement>(
        '.meo-md-html-table-shell tbody textarea[data-table-row="10"][data-table-col="3"]'
      )!;
      const cell = input.closest<HTMLTableCellElement>('td')!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      editor.view.scrollDOM.scrollTop += cell.getBoundingClientRect().top - viewport.top - (window as any).__tableWrapTargetTop;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
    });
    await waitForFrames(page, 8);

    await page.evaluate(() => {
      const editor = (window as any).__tableVisualEditor;
      const input = document.activeElement as HTMLTextAreaElement;
      const cell = input.closest<HTMLTableCellElement>('td')!;
      const table = input.closest<HTMLTableElement>('table')!;
      const cellRect = cell.getBoundingClientRect();
      (window as any).__tableWrapDirectionInitial = {
        cellTop: cellRect.top,
        cellBottom: cellRect.bottom,
        cellHeight: cellRect.height,
        tableTop: table.getBoundingClientRect().top,
        scrollTop: editor.view.scrollDOM.scrollTop
      };
    });
    await page.keyboard.type(text, { delay: 45 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await waitForFrames(page, 12);

    const result = await page.evaluate(() => {
      const editor = (window as any).__tableVisualEditor;
      const input = document.activeElement as HTMLTextAreaElement;
      const cell = input.closest<HTMLTableCellElement>('td')!;
      const table = input.closest<HTMLTableElement>('table')!;
      const initial = (window as any).__tableWrapDirectionInitial;
      const finalRect = cell.getBoundingClientRect();
      return {
        heightDelta: finalRect.height - initial.cellHeight,
        bottomDelta: finalRect.bottom - initial.cellBottom,
        cellTopDelta: finalRect.top - initial.cellTop,
        tableTopDelta: table.getBoundingClientRect().top - initial.tableTop,
        scrollDelta: editor.view.scrollDOM.scrollTop - initial.scrollTop,
        focused: document.activeElement === input
      };
    });
    if (
      result.heightDelta < 10 ||
      Math.abs(result.cellTopDelta) > 2 ||
      Math.abs(result.tableTopDelta) > 2 ||
      Math.abs(result.scrollDelta) > 2 ||
      result.bottomDelta < result.heightDelta - 2 ||
      !result.focused
    ) {
      throw new Error(`A wrapping table cell at ${targetTop}px did not keep its top fixed and grow downward: ${JSON.stringify(result)}`);
    }
  }
}

async function assertForcedLineBreakGrowsDownward(page: import('puppeteer-core').Page): Promise<void> {
  await page.setViewport({ width: 760, height: 360, deviceScaleFactor: 1 });
  for (const targetTop of [80, 160, 250]) {
    await page.evaluate((top) => {
      (window as any).__tableVisualEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      const text = [
        ...Array.from({ length: 30 }, (_, index) => `强制换行前置正文 ${index + 1}`),
        '',
        '| 第一列 | 第二列 | 第三列 |',
        '| --- | --- | --- |',
        '| TARGET | 短内容 | 备注 |',
        '',
        ...Array.from({ length: 30 }, (_, index) => `强制换行后置正文 ${index + 1}`)
      ].join('\n');
      const editor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__tableVisualEditor = editor;
      (window as any).__forcedBreakTargetTop = top;
      editor.scrollToLine(34, 'center');
    }, targetTop);
    await page.waitForFunction(() => Boolean(Array.from(
      document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea')
    ).find((input) => input.value === 'TARGET')));
    await waitForFrames(page, 10);

    const initial = await page.evaluate(() => {
      const editor = (window as any).__tableVisualEditor;
      const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
        .find((candidate) => candidate.value === 'TARGET')!;
      const cell = input.closest<HTMLTableCellElement>('td')!;
      const table = input.closest<HTMLTableElement>('table')!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      editor.view.scrollDOM.scrollTop += (
        cell.getBoundingClientRect().top - viewport.top - (window as any).__forcedBreakTargetTop
      );
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      const rect = cell.getBoundingClientRect();
      return {
        cellTop: rect.top,
        cellBottom: rect.bottom,
        cellHeight: rect.height,
        tableTop: table.getBoundingClientRect().top,
        scrollTop: editor.view.scrollDOM.scrollTop,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom
      };
    });
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    await new Promise((resolve) => setTimeout(resolve, 300));
    await waitForFrames(page, 10);

    const result = await page.evaluate((before) => {
      const editor = (window as any).__tableVisualEditor;
      const input = document.activeElement as HTMLTextAreaElement;
      const cell = input.closest<HTMLTableCellElement>('td')!;
      const table = input.closest<HTMLTableElement>('table')!;
      const rect = cell.getBoundingClientRect();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        value: input.value,
        focused: input.matches('.meo-md-html-table textarea'),
        heightDelta: rect.height - before.cellHeight,
        bottomDelta: rect.bottom - before.cellBottom,
        cellTopDelta: rect.top - before.cellTop,
        tableTopDelta: table.getBoundingClientRect().top - before.tableTop,
        scrollDelta: editor.view.scrollDOM.scrollTop - before.scrollTop,
        cellTop: rect.top,
        cellBottom: rect.bottom,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom
      };
    }, initial);
    const remainsVisible = (
      result.cellTop >= result.viewportTop - 1 &&
      result.cellBottom <= result.viewportBottom + 1
    );
    if (
      !result.focused || !result.value.includes('<br>\n') ||
      result.heightDelta < 10 || !remainsVisible ||
      Math.abs(result.cellTopDelta) > 2 ||
      Math.abs(result.tableTopDelta) > 2 ||
      Math.abs(result.scrollDelta) > 2 ||
      result.bottomDelta < result.heightDelta - 2
    ) {
      throw new Error(`Shift+Enter at ${targetTop}px did not grow the cell downward with a stable visible viewport: ${JSON.stringify(result)}`);
    }
  }
}

async function assertOffscreenCellRevealsOnInput(page: import('puppeteer-core').Page): Promise<void> {
  await page.setViewport({ width: 760, height: 360, deviceScaleFactor: 1 });
  for (const side of ['above', 'below'] as const) {
    await page.evaluate((side) => {
      (window as any).__tableVisualEditor.destroy();
      document.getElementById('app')!.replaceChildren();
      const rows = Array.from({ length: 20 }, (_, index) => `| ${index + 1} | ${index === 10 ? 'TARGET' : ''} |`);
      const text = [
        ...Array.from({ length: 50 }, (_, index) => `前置正文 ${index + 1}`),
        '',
        '| 序号 | 内容 |',
        '| --- | --- |',
        ...rows,
        '',
        ...Array.from({ length: 50 }, (_, index) => `后置正文 ${index + 1}`)
      ].join('\n');
      const editor = (window as any).EmbeddedInputViewportHarness.createEditor({
        parent: document.getElementById('app')!,
        text,
        initialMode: 'live',
        onApplyChanges() {}
      });
      (window as any).__tableVisualEditor = editor;
      (window as any).__tableRevealSide = side;
      editor.scrollToLine(64, 'center');
    }, side);
    await page.waitForFunction(() => Boolean(Array.from(
      document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea')
    ).find((input) => input.value === 'TARGET')));
    await waitForFrames(page, 10);

    const initial = await page.evaluate(() => {
      const editor = (window as any).__tableVisualEditor;
      const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>('.meo-md-html-table textarea'))
        .find((candidate) => candidate.value === 'TARGET')!;
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      const targetTop = (window as any).__tableRevealSide === 'above'
        ? viewport.top - input.getBoundingClientRect().height - 60
        : viewport.bottom + 60;
      editor.view.scrollDOM.scrollTop += input.getBoundingClientRect().top - targetTop;
      input.focus({ preventScroll: true });
      input.setSelectionRange(input.value.length, input.value.length);
      const rect = input.getBoundingClientRect();
      return {
        side: (window as any).__tableRevealSide,
        inputTop: rect.top,
        inputBottom: rect.bottom,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom
      };
    });
    if (
      (side === 'above' && initial.inputBottom >= initial.viewportTop) ||
      (side === 'below' && initial.inputTop <= initial.viewportBottom)
    ) {
      throw new Error(`Offscreen input fixture remained visible: ${JSON.stringify(initial)}`);
    }

    await page.keyboard.type('X');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await waitForFrames(page, 12);

    const result = await page.evaluate(() => {
      const editor = (window as any).__tableVisualEditor;
      const input = document.activeElement as HTMLTextAreaElement;
      const rect = input.getBoundingClientRect();
      const viewport = editor.view.scrollDOM.getBoundingClientRect();
      return {
        value: input.value,
        focused: input.matches('.meo-md-html-table textarea'),
        inputTop: rect.top,
        inputBottom: rect.bottom,
        viewportTop: viewport.top,
        viewportBottom: viewport.bottom
      };
    });
    if (
      !result.focused ||
      result.value !== 'TARGETX' ||
      result.inputBottom <= result.viewportTop ||
      result.inputTop >= result.viewportBottom
    ) {
      throw new Error(`Typing did not reveal the ${side} table cell: ${JSON.stringify(result)}`);
    }
  }
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
    if (process.argv.includes('--pending-presentation-only')) {
      await assertPendingCellSurvivesPresentation(page);
      console.log('pending table input presentation passed');
      return;
    }
    await assertPendingCellSurvivesPresentation(page);
    if (process.argv.includes('--column-reflow-only')) {
      await page.evaluate(() => {
        (window as any).__tableVisualEditor = { destroy() {} };
      });
      await assertColumnReflowKeepsActiveCell(page);
      console.log('table column reflow visual stability passed');
      return;
    }
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

    await assertWrappingCellGrowsDownward(page);
    await assertForcedLineBreakGrowsDownward(page);
    await assertColumnReflowKeepsActiveCell(page);
    await assertOffscreenCellRevealsOnInput(page);
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
