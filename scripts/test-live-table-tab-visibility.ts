import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser',
  format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

type TableGeometry = {
  readonly tableWidth: number;
  readonly shellWidth: number;
  readonly columnWidths: readonly number[];
  readonly projectedWidths: readonly string[];
};

const readGeometry = async (page: import('puppeteer-core').Page): Promise<TableGeometry> => page.$eval(
  '.meo-md-html-table:not(.meo-md-html-table-sticky-table)',
  (table: HTMLTableElement) => ({
    tableWidth: table.getBoundingClientRect().width,
    shellWidth: table.closest<HTMLElement>('.meo-md-html-table-shell')!.getBoundingClientRect().width,
    columnWidths: Array.from(table.querySelectorAll<HTMLElement>('thead th'))
      .map(cell => cell.getBoundingClientRect().width),
    projectedWidths: Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup > col'))
      .map(column => column.style.width)
  })
);

const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(String(error)));
  await page.setViewport({ width: 220, height: 760, deviceScaleFactor: 1 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){return null},setState(){},postMessage(){}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });

  const table = [
    '| 指标 | 检查内容 |',
    '| --- | --- |',
    '| 用户返工 | 需要删除、重写、重排和重做的页面数量 |',
    '| 成品纯净度 | 是否出现生成规则、资料清单和内部工作语言 |',
    '| 事实准确性 | 是否出现无资料支撑的项目事实 |',
    '| 内容组织 | 是否符合汇报对象、时长和重点 |',
    '| 模板遵循 | 是否复制模板页面并保持其视觉关系 |',
    '| 资料利用 | 关键图纸、图片和数据是否出现在合适位置 |',
    '| 占位价值 | 占位是否明确、必要且方便替换 |',
    '| 执行成本 | 模型上下文、调用次数、模板处理时间和失败重试成本 |'
  ].join('\n');
  const text = [
    '# Live table visibility fixture',
    '',
    table,
    '',
    'after'
  ].join('\n');
  await page.evaluate(documentText => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'init', documentId: 'file:///live-table-tab-visibility.md', text: documentText, version: 1,
      savedRevision: { version: 1, text: documentText }, diagnostics: [], mode: 'live', uiLanguage: 'zh-CN',
      uiLanguagePreference: 'auto', automaticUiLanguage: 'zh-CN', sourceLineNumbers: 'on',
      previewAppearance: 'dark', previewFontFamily: '', previewSourceColoring: true,
      editorAppearance: 'dark', editorFontSizeMode: 'auto', editorFontSize: 14,
      gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
      diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
      contentMaxWidthEnabled: true, findOptions: { wholeWord: false, caseSensitive: false },
      outlinePosition: 'right', outlineVisible: false, outlineWidth: 260,
      restoreReadingPositionOnOpen: false, vscodeTheme: null
    } }));
  }, text);
  try {
    await page.waitForSelector('.cm-content', { timeout: 5000 });
  } catch (error) {
    throw new Error(`Live editor fixture did not mount: ${JSON.stringify({ pageErrors })}`, { cause: error });
  }
  try {
    await page.waitForFunction(() => (
      document.querySelector<HTMLElement>('#app')?.dataset.mode === 'live'
      && document.querySelector(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table)[data-table-column-width-owner="adapter"]'
      ) !== null
    ), { polling: 'raf', timeout: 5000 });
  } catch (error) {
    const state = await page.evaluate(() => ({
      mode: document.querySelector<HTMLElement>('#app')?.dataset.mode ?? null,
      text: document.querySelector('.cm-content')?.textContent ?? null,
      tables: document.querySelectorAll('.meo-md-html-table').length,
      renderedBlocks: document.querySelectorAll('[data-meo-rendered-block-start-line]').length
    }));
    throw new Error(`Live table fixture did not mount: ${JSON.stringify(state)}`, { cause: error });
  }
  await page.$eval('.meo-md-html-table-shell', element => element.scrollIntoView({ block: 'center' }));
  await page.evaluate(() => new Promise<void>(resolve => {
    let frames = 12;
    const next = () => {
      frames -= 1;
      if (frames === 0) resolve();
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }));
  const duringNarrowMount = await readGeometry(page);
  await page.setViewport({ width: 1200, height: 760, deviceScaleFactor: 1 });
  await page.evaluate(() => new Promise<void>(resolve => {
    let frames = 12;
    const next = () => {
      frames -= 1;
      if (frames === 0) resolve();
      else requestAnimationFrame(next);
    };
    requestAnimationFrame(next);
  }));
  const before = await readGeometry(page);
  const naturalAfterRecovery = await page.$eval(
    '.meo-md-html-table:not(.meo-md-html-table-sticky-table)',
    (table: HTMLTableElement) => {
      const clone = table.cloneNode(true) as HTMLTableElement;
      clone.removeAttribute('data-table-column-width');
      clone.style.position = 'absolute';
      clone.style.visibility = 'hidden';
      clone.style.width = 'fit-content';
      clone.style.maxWidth = '100%';
      clone.style.minWidth = '0';
      clone.style.tableLayout = 'auto';
      clone.querySelectorAll<HTMLTableColElement>('colgroup > col')
        .forEach(column => { column.style.width = ''; });
      table.parentElement!.append(clone);
      const geometry = {
        tableWidth: clone.getBoundingClientRect().width,
        columnWidths: Array.from(clone.querySelectorAll<HTMLElement>('thead th'))
          .map(cell => cell.getBoundingClientRect().width)
      };
      clone.remove();
      return geometry;
    }
  );
  assert.ok(
    duringNarrowMount.tableWidth < before.tableWidth - 100,
    JSON.stringify({ duringNarrowMount, before })
  );
  assert.ok(
    before.columnWidths[1]! >= naturalAfterRecovery.columnWidths[1]! - 1,
    JSON.stringify({ before, naturalAfterRecovery })
  );

  const inactivePage = await browser.newPage();
  await inactivePage.setContent('<!doctype html><p>inactive tab</p>');
  await inactivePage.bringToFront();
  await page.waitForFunction(() => document.hidden, { timeout: 5000 });
  await page.bringToFront();
  await page.waitForFunction(() => !document.hidden, { timeout: 5000 });
  await inactivePage.close();

  const frames = await page.evaluate(async () => {
    const samples: Array<{
      tableWidth: number;
      shellWidth: number;
      columnWidths: number[];
      projectedWidths: string[];
    }> = [];
    for (let frame = 0; frame < 24; frame += 1) {
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const table = document.querySelector<HTMLTableElement>(
        '.meo-md-html-table:not(.meo-md-html-table-sticky-table)'
      )!;
      samples.push({
        tableWidth: table.getBoundingClientRect().width,
        shellWidth: table.closest<HTMLElement>('.meo-md-html-table-shell')!.getBoundingClientRect().width,
        columnWidths: Array.from(table.querySelectorAll<HTMLElement>('thead th'))
          .map(cell => cell.getBoundingClientRect().width),
        projectedWidths: Array.from(table.querySelectorAll<HTMLTableColElement>('colgroup > col'))
          .map(column => column.style.width)
      });
    }
    return samples;
  });
  const after = frames.at(-1)!;
  assert.ok(
    after.columnWidths.every((width, index) => Math.abs(width - before.columnWidths[index]!) <= 1),
    `Returning from another tab changed automatic Live table widths: ${JSON.stringify({ before, frames })}`
  );

  console.log('Live table tab visibility width checks passed');
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  try {
    await closeTestBrowser(browser);
  } catch (error) {
    if (!primaryError) throw error;
  }
}
