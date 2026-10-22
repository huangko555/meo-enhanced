import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';
import type { Page } from 'puppeteer-core';

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-table-responsive-'));
const entry = path.join(temporary, 'entry.ts');
fs.writeFileSync(entry, `
  import { createEditor } from ${JSON.stringify(path.resolve(import.meta.dir, 'test-editor-factory.ts'))};
  import { applyBuiltInVisualBaseline } from ${JSON.stringify(path.resolve(import.meta.dir, '../webview/src/helpers/theme.ts'))};
  (window as any).mount = (text: string) => {
    applyBuiltInVisualBaseline('dark');
    (window as any).editor = createEditor({parent: document.getElementById('app')!, text, initialMode: 'live', onApplyChanges() {}});
  };
`);
const description = '这一列是较长的中文说明。空间不足时，希望主要由说明列换行，编号和状态仍保持易读，不要因为平均分配宽度而被挤成一字一行。';
const fixture = [
  '| 编号 | 状态 | 说明 |', '| --- | --- | --- |',
  `| A01 | 完成 | ${description} |`, '',
  '| 类别 | 内容 | 备注 |', '| --- | --- | --- |', `| 路径 | ${'table_width_example_'.repeat(20)} | 长路径 |`
].join('\n');
const selector = '.meo-md-html-table:not(.meo-md-html-table-sticky-table)';

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  // Preview's ResizeObserver schedules its projection on the iframe's clock.
  // Outer-document frames alone can sample the previous wrapper width.
  await page.evaluate(async () => {
    const host = document.querySelector<HTMLElement>('.preview-host');
    const frame = document.querySelector<HTMLIFrameElement>('.preview-frame');
    if (!host || host.hidden || host.inert || !host.getClientRects().length || !frame?.contentWindow) return;
    const view = frame.contentWindow;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Preview document frame clock did not settle')), 5000);
      let remaining = 3;
      const tick = () => {
        if (--remaining === 0) { clearTimeout(timeout); resolve(); }
        else view.requestAnimationFrame(tick);
      };
      view.requestAnimationFrame(tick);
    });
  });
}

async function dragColumn(page: Page, column: number, delta: number): Promise<void> {
  const handle = `${selector}:first-of-type thead th:nth-child(${column + 1}) [data-table-resize-column]`;
  await page.$eval(handle, node => node.scrollIntoView({ block: 'center' }));
  await settle(page);
  const point = await page.$eval(handle, node => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(point.x, point.y);
  await page.mouse.down();
  try {
    await page.mouse.move(point.x + delta, point.y, { steps: 12 });
  } finally {
    await page.mouse.up();
  }
  await settle(page);
}

async function exerciseUi(browser: Awaited<ReturnType<typeof launchTestBrowser>>): Promise<void> {
  const build = await Bun.build({ entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'], target: 'browser', format: 'iife' });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const empty = ['| 编号 | | 说明 | 备注 |', '| --- | --- | --- | --- |', `| A01 | | ${description} | |`, '| A02 | | | 待补充 |', '| | | | |'].join('\n');
  const alternate = ['| 类型 | 内容 | 标记 | 日期 |', '| --- | --- | --- | --- |', `| 混排 | ${description.repeat(2)} | 是 | 10-17 |`].join('\n');
  const labels = Array.from({ length: 12 }, (_, index) => String(index + 1));
  const many = `| ${labels.join(' | ')} |\n| ${labels.map(() => '---').join(' | ')} |\n| ${labels.map(() => '内容').join(' | ')} |`;
  const text = ['# Tables', '', '## Description at right', '', fixture, '', '## Empty column', '', empty, '',
    '## Description in middle', '', alternate, '', '## Many columns', '', many, '', '## HTML tables', '',
    `<table id="html-long"><thead><tr><th>编号</th><th>状态</th><th>说明</th></tr></thead><tbody><tr><td>H01</td><td>完成</td><td>${description}</td></tr></tbody></table>`, '',
    `<table id="html-merged"><thead><tr><th rowspan="2">分组</th><th colspan="2">检查内容</th></tr><tr><th>项目</th><th>说明</th></tr></thead><tbody><tr><td rowspan="2">编辑</td><td>短内容</td><td>${description}</td></tr><tr><td>恢复</td><td>${description}</td></tr></tbody></table>`, '',
    `<table id="html-many"><thead><tr>${labels.map(label => `<th>${label}</th>`).join('')}</tr></thead><tbody><tr>${labels.map(() => '<td>内容</td>').join('')}</tr></tbody></table>`
  ].join('\n');
  let checked = 0;
  for (const theme of ['dark', 'light'] as const) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.setViewport({ width: 1600, height: 1000 });
    await page.setContent(`<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-${theme}"><div id="app"></div></body>`);
    await page.addStyleTag({ path: 'webview/src/styles.css' });
    await page.exposeFunction('__renderTables', (message: any) => message.type === 'requestPreviewRender' ? {
      type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value: exportRuntime.renderPreviewDocument({
        markdownText: message.text, sourceDocumentPath: 'C:/table-responsive.md', uiLanguage: 'en',
        styleEnvironment: message.environment, preset: message.preset, contentWidth: message.contentWidth
      }) }
    } : null);
    await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){return {sourcePreviewScrollSyncEnabled:false}},setState(){},postMessage(message){window.__renderTables(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
    await page.addScriptTag({ content: await build.outputs[0].text() });
    await page.evaluate(({ text, theme }) => window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///table-responsive.md', text, version: 1, savedRevision: { version: 1, text },
      diagnostics: [], mode: 'live', uiLanguage: 'en', sourceLineNumbers: 'on',
      previewAppearance: theme, previewFontFamily: '', previewSourceColoring: false, previewShowComments: false,
      editorAppearance: theme, gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
      outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
      vscodeTheme: { name: 'fixture', type: theme, colors: {}, tokenColors: [] }
    } })), { text, theme });
    await page.waitForSelector(selector);
    const seen = new Map<string, number[]>();
    const check = async (surface: string, stage: string) => {
      await settle(page);
      const tables = await page.evaluate(surface => {
        const frameDocument = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument;
        const doc = surface === 'live' ? document : frameDocument!;
        const elements = doc.querySelectorAll<HTMLTableElement>(surface === 'live'
          ? '.meo-md-html-table:not(.meo-md-html-table-sticky-table), .meo-md-html-content table'
          : '.meo-table-scroll > table, .meo-export-html-block table');
        return Array.from(elements).filter(table => table.getClientRects().length > 0).map(table => {
          const wrapper = table.closest<HTMLElement>('.meo-md-html-table-wrap, .meo-md-html-content, .meo-table-scroll, .meo-export-html-block')!;
          const headers = Array.from(table.rows[0].cells).map(cell => cell.textContent?.trim());
          return {
            key: table.id || headers.join('/'), headers,
            widths: Array.from(table.rows[0].cells).map(cell => cell.getBoundingClientRect().width),
            available: wrapper.clientWidth, total: table.getBoundingClientRect().width,
            overhang: table.getBoundingClientRect().right - wrapper.getBoundingClientRect().right,
            scroll: wrapper.scrollWidth - wrapper.clientWidth,
            overflowX: getComputedStyle(wrapper).overflowX,
            fixed: table.style.tableLayout === 'fixed',
            sticky: table.closest('.meo-md-html-table-shell')?.querySelector<HTMLTableElement>('.meo-md-html-table-sticky-table')
              ? Array.from(table.closest('.meo-md-html-table-shell')!.querySelectorAll<HTMLElement>('.meo-md-html-table-sticky-table colgroup > col')).map(col => Number.parseFloat(col.style.width)) : null
          };
        });
      }, surface);
      assert.ok(tables.length > 0, `${theme}/${surface}/${stage}: tables must be present`);
      for (const table of tables) {
        const context = JSON.stringify({ theme, surface, stage, table });
        assert.ok(table.fixed && table.widths.every(width => width > 0) && table.overhang <= 1, context);
        // Below one glyph per track, paint can exceed a cell by a few pixels.
        // The automatic layout must still fit and must not enable a scrollbar.
        assert.ok(table.scroll <= 1 || ['clip', 'hidden'].includes(table.overflowX), context);
        if (table.sticky) assert.ok(table.sticky.every((width, index) => Math.abs(width - table.widths[index]) < 1), context);
        if (table.available >= 450 && table.headers.join('/') === '编号/状态/说明') {
          assert.ok(table.widths[2] > table.widths[1] * 2, context);
        }
        if (table.available >= 450 && table.headers.join('/') === '编号//说明/备注') {
          assert.ok(table.widths[2] > table.widths[1] * 2 && table.widths[1] <= Math.max(100, table.total * 0.2), context);
        }
        const key = `${surface}:${table.key}:${Math.round(table.available)}`;
        const previous = seen.get(key);
        if (previous) assert.ok(table.widths.every((width, index) => Math.abs(width - previous[index]) < 2), `Same container must restore automatic widths: ${context}; previous=${previous}`);
        else seen.set(key, table.widths);
        checked++;
      }
    };
    for (const surface of ['live', 'preview', 'source+preview']) {
      await page.click(`button[data-mode="${surface === 'source+preview' ? 'source' : surface}"]`);
      await page.waitForFunction(mode => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === mode, {}, surface === 'source+preview' ? 'source' : surface);
      if (surface === 'source+preview') await page.click('.source-preview-button');
      if (surface !== 'live') await page.waitForFunction(() => !document.querySelector<HTMLElement>('.preview-host')!.inert
        && document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.querySelector('table')?.style.tableLayout === 'fixed');
      for (const width of [1600, 1200, 900, 720, 480, 360, 480, 720, 900, 1200, 1600]) {
        await page.setViewport({ width, height: 1000 });
        await check(surface, `window-${width}`);
      }
      // Exercise actual outline buttons rather than dispatching layout events.
      await page.click('[data-action="outline-right"]');
      await check(surface, 'outline-open');
      await page.click('.outline-item[data-tooltip="Empty column"]');
      await check(surface, 'outline-navigate-empty');
      await page.click('[data-action="outline-right"]');
      await check(surface, 'outline-close');
      await page.click('[data-action="outline-right"]');
      await page.click('.outline-item[data-tooltip="Description at right"]');
      await check(surface, 'outline-navigate-back');
      await page.click('[data-action="outline-right"]');
      await check(surface, 'outline-restore');
      await page.click('[data-action="outline-right"]');
      await page.click('.outline-header-button[data-action="toggle-mode"]');
      await check(surface, 'floating-outline-open');
      await page.click('[data-action="outline-right"]');
      await check(surface, 'floating-outline-close');
      await page.click('[data-action="outline-right"]');
      await page.click('.outline-header-button[data-action="toggle-mode"]');
      await page.click('[data-action="outline-right"]');
      await check(surface, 'fixed-outline-restore');
    }
    fs.mkdirSync(path.resolve('tmp'), { recursive: true });
    await page.click('button[data-mode="live"]');
    await page.click('[data-action="outline-right"]');
    await page.click('.outline-item[data-tooltip="Description at right"]');
    await page.click('[data-action="outline-right"]');
    await settle(page);
    const firstWidths = () => page.$eval(selector, table => Array.from((table as HTMLTableElement).rows[0].cells).map(cell => cell.getBoundingClientRect().width));
    const before = await firstWidths();
    await dragColumn(page, 0, 80);
    const manual = await firstWidths();
    assert.ok(manual[0] > before[0] + 50, 'UI drag must change the first table');
    for (let toggle = 0; toggle < 4; toggle++) {
      await page.click('[data-action="outline-right"]');
      await settle(page);
      const actual = await firstWidths();
      assert.ok(actual.every((width, index) => Math.abs(width - manual[index]) < 2), 'Manual columns that fit must remain fixed while the outline opens/closes');
    }
    assert.deepEqual(errors, [], `${theme}: browser errors`);
    await page.screenshot({ path: path.resolve(`tmp/table-responsive-${theme}.png`) });
    await page.close();
  }
  console.log(`Responsive production UI: ${checked} table states across themes, continuous window resizing, outline navigation and Source/Live/Preview passed`);
}

try {
  const build = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'iife' });
  assert.ok(build.success, build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  let primaryError: unknown;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1450, height: 1400 });
    await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><body class="vscode-dark"><div id="app"></div></body>');
    await page.addStyleTag({ path: path.resolve('webview/src/styles.css') });
    await page.addScriptTag({ content: await build.outputs[0].text() });
    await page.evaluate(text => (window as any).mount(text), fixture);
    await page.waitForFunction(selector => document.querySelectorAll(`${selector}[style*="table-layout: fixed"]`).length === 2, {}, selector);
    const geometry = () => page.$$eval(selector, tables => tables.map(node => {
      const table = node as HTMLTableElement;
      return {
        widths: Array.from(table.rows[0].cells).map(cell => cell.getBoundingClientRect().width),
        available: table.parentElement!.clientWidth,
        total: table.getBoundingClientRect().width
      };
    }));
    const wide = (await geometry())[0];
    const boundary = Math.ceil(wide.total + 1450 - wide.available);
    for (const width of [900, 240, 600]) {
      await page.setViewport({ width, height: 1400 });
      await settle(page);
      const actual = await geometry();
      if (width >= 600) {
        assert.ok(actual[0].widths[2] > actual[0].widths[1] * 2, `Description must remain wider than status after resize: ${JSON.stringify({ width, actual })}`);
      }
    }
    let previous: Awaited<ReturnType<typeof geometry>> | null = null;
    for (let width = boundary + 40; width >= boundary - 40; width -= 2) {
      await page.setViewport({ width, height: 1400 });
      await settle(page);
      const current = await geometry();
      if (previous) assert.ok(current[0].widths.every((value, index) => value <= previous![0].widths[index] + 1),
        `Shrinking the window must not suddenly enlarge a column: ${JSON.stringify({ width, previous, current })}`);
      previous = current;
    }
    await page.setViewport({ width: 1450, height: 1400 });
    await settle(page);
    const initial = await geometry();
    for (const [column, delta] of [[0, 220], [0, -1000], [1, 2000], [2, -1000], [2, 2000]]) {
      const before = await geometry();
      await dragColumn(page, column, delta);
      const manual = await geometry();
      assert.ok(manual[0].widths.every(width => width > 0) && manual[0].total <= manual[0].available + 1, JSON.stringify({ column, delta, manual }));
      if (column === 0) assert.ok(delta > 0
        ? manual[0].widths[0] > before[0].widths[0] + 100
        : manual[0].widths[0] < before[0].widths[0] - 100, 'Dragging must actually change the active column');
      assert.ok(manual[1].widths.every((width, index) => Math.abs(width - initial[1].widths[index]) < 2), 'Dragging must not change another table');
      for (const width of [600, 360, 720, 1450]) {
        await page.setViewport({ width, height: 1400 });
        await settle(page);
        const constrained = await geometry();
        assert.ok(constrained[0].widths.every(value => value > 0) && constrained[0].total <= constrained[0].available + 1, JSON.stringify({ column, delta, width, constrained }));
      }
      const restored = await geometry();
      await page.setViewport({ width: 600, height: 1400 });
      await settle(page);
      await page.setViewport({ width: 1450, height: 1400 });
      await settle(page);
      const repeated = await geometry();
      assert.ok(repeated[0].widths.every((width, index) => Math.abs(width - restored[0].widths[index]) < 2), 'Manual width restoration must not drift on repeated window resizing');
      await page.evaluate(() => (window as any).editor.setMode('source'));
      await page.evaluate(() => (window as any).editor.setMode('live'));
      await settle(page);
      const remounted = await geometry();
      assert.ok(remounted[0].widths.every((width, index) => Math.abs(width - repeated[0].widths[index]) < 2), 'Mode changes must preserve manual column intent');
    }
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), fixture, 'Width presentation must not modify Markdown');
    await page.evaluate(() => (window as any).editor.destroy());
    await page.evaluate(text => (window as any).mount(text), fixture);
    await settle(page);
    const beforeEditing = await geometry();
    await page.click(`${selector}:first-of-type tbody tr:first-child td:nth-child(3)`);
    await page.keyboard.press('End');
    await page.keyboard.type(' editing-width-stability');
    await settle(page);
    assert.ok(await page.evaluate(() => (window as any).editor.getText().includes('editing-width-stability')), 'Editing check must reach a real table cell');
    const afterEditing = await geometry();
    assert.ok(afterEditing[0].widths.every((width, index) => Math.abs(width - beforeEditing[0].widths[index]) < 2), 'Typing must not repeatedly redistribute columns');
    await page.evaluate(() => (window as any).editor.destroy());
    await page.close();
    await exerciseUi(browser);
  } catch (error) {
    primaryError = error;
  } finally {
    if (primaryError === undefined) await closeTestBrowser(browser);
    else await closeTestBrowser(browser, primaryError);
  }
  console.log('Responsive table width lifecycle passed');
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
