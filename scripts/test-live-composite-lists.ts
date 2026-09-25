import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-composite-lists-'));
const source = [
  '- [ ] plain task',
  '> - [ ] quoted task alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu',
  '> 1. first quoted ordered',
  '> 99. second quoted ordered',
  '> > - [x] nested quoted task',
  '- parent',
  '  > - [ ] task in quote in list',
  '- > quote in list',
  '  - nested **bold** item',
  '- > - [ ] same-line nested task',
  '> - > 1. same-line quoted ordered'
].join('\n');

async function main(): Promise<void> {
  const build = await Bun.build({
    entrypoints: [path.join(root, 'scripts', 'test-list-editing-entry.ts')],
    outdir: tempDir,
    target: 'browser',
    format: 'iife',
    naming: 'bundle.js'
  });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));

  const browser = await launchTestBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><div id="host"></div><div id="table-host"></div><div id="nested-table-host"></div><div id="edit-host"></div>');
    await page.addStyleTag({ path: path.join(root, 'webview', 'src', 'styles.css') });
    await page.addStyleTag({ content: ':root { --meo-semantic-blockquoteBorder: #777; --meo-semantic-blockquoteForeground: #444; }' });
    await page.addStyleTag({ content: '#host { width: 280px; } #host .cm-editor { width: 280px; } #host .cm-gutters { display: none; }' });
    await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
    const result = await page.evaluate(async (markdown) => {
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('host')!,
        text: markdown,
        initialMode: 'live',
        uiLanguage: 'zh-CN',
        onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const lines = Array.from(document.querySelectorAll<HTMLElement>('#host .cm-line'));
      const items = lines.map((line) => ({
        text: line.innerText,
        checkbox: line.querySelectorAll('.meo-task-checkbox').length,
        listMarker: line.querySelectorAll('.meo-md-list-marker').length,
        quote: line.classList.contains('meo-md-quote'),
        list: line.classList.contains('meo-md-list-line')
      }));
      const quotedBody = Array.from(lines[1]!.childNodes).find((node) => node.textContent?.includes('quoted task'))!;
      const textNode = quotedBody.nodeType === Node.TEXT_NODE ? quotedBody : quotedBody.firstChild!;
      const bodyRange = document.createRange();
      bodyRange.setStart(textNode, textNode.textContent!.indexOf('quoted task'));
      bodyRange.setEnd(textNode, textNode.textContent!.length);
      const bodyRects = Array.from(bodyRange.getClientRects()).filter((rect) => rect.width > 1);
      const quotedAlignment = {
        count: bodyRects.length,
        first: bodyRects[0]?.left ?? NaN,
        continuation: bodyRects[1]?.left ?? NaN
      };
      const checkbox = lines[1]!.querySelector<HTMLInputElement>('.meo-task-checkbox');
      checkbox?.click();
      const afterToggle = editor.getText();
      await editor.undo();
      const afterUndo = editor.getText();
      editor.destroy();
      const tableSource = [
        '| Content |',
        '| --- |',
        '| - [ ] plain<br>> - [x] quoted task<br>> 3. ordered<br>> 9. next<br>- **bold** item<br>- > - [ ] same-line task<br>- parent<br>  > - [x] task in list quote<br>> > 2) deeper ordered |'
      ].join('\n');
      const tableEditor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('table-host')!, text: tableSource,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const cell = document.querySelector<HTMLElement>(
        '#table-host tbody td .meo-md-html-table-cell-preview'
      )!;
      const table = {
        listItems: cell.querySelectorAll('li').length,
        quotes: cell.querySelectorAll('blockquote').length,
        checkboxes: cell.querySelectorAll('input[type=checkbox]').length,
        quoteBorder: Number.parseFloat(getComputedStyle(cell.querySelector('blockquote')!).borderLeftWidth),
        checkboxDisplay: getComputedStyle(cell.querySelector('input[type=checkbox]')!).display,
        text: cell.innerText,
        source: tableEditor.getText()
      };
      tableEditor.destroy();
      const nestedTableSource = [
        '- containing table', '',
        '  | Name | Value |', '  | --- | --- |', '  | visible nested cell | yes |'
      ].join('\n');
      const nestedTableEditor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('nested-table-host')!, text: nestedTableSource,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const nestedTable = {
        cells: document.querySelectorAll('#nested-table-host .meo-md-html-table-cell-preview').length,
        text: document.getElementById('nested-table-host')!.innerText,
        source: nestedTableEditor.getText()
      };
      nestedTableEditor.destroy();
      return { items, quotedAlignment, afterToggle, afterUndo, table, tableSource, nestedTable, nestedTableSource };
    }, source);

    assert.equal(result.items.length, 11);
    assert.equal(result.items[0]?.checkbox, 1);
    assert.equal(result.items[1]?.checkbox, 1, 'quoted task must render an interactive checkbox');
    assert.equal(result.items[2]?.listMarker, 1, 'quoted ordered item must render its number');
    assert.equal(result.items[3]?.listMarker, 1, 'the next quoted ordered item must render its number');
    assert.equal(result.items[4]?.checkbox, 1, 'nested quoted task must render a checkbox');
    assert.equal(result.items[6]?.checkbox, 1, 'task inside a quote inside a list must render a checkbox');
    assert.ok(result.items[7]?.quote && result.items[7]?.list, 'list item containing a quote needs both styles');
    assert.equal(result.items[8]?.listMarker, 1);
    assert.equal(result.items[9]?.checkbox, 1, 'same-line list and quote nesting must show its task');
    assert.equal(result.items[10]?.listMarker, 2, 'same-line nested lists must show both markers');
    for (const [index, expected] of [
      'plain task', 'quoted task', 'first quoted ordered', 'second quoted ordered',
      'nested quoted task', 'parent', 'task in quote in list', 'quote in list', 'nested bold item',
      'same-line nested task', 'same-line quoted ordered'
    ].entries()) {
      assert.ok(result.items[index]?.text.includes(expected), `line ${index + 1} lost its content`);
    }
    assert.ok(result.quotedAlignment.count >= 2, 'quoted task must wrap in the narrow editor');
    assert.ok(Math.abs(result.quotedAlignment.first - result.quotedAlignment.continuation) <= 1,
      `quoted list continuation is misaligned: ${JSON.stringify(result.quotedAlignment)}`);
    assert.equal(result.afterToggle, source.replace('> - [ ] quoted task', '> - [x] quoted task'));
    assert.equal(result.afterUndo, source);
    assert.equal(result.table.listItems, 10, 'table cell must retain every nested list item');
    assert.equal(result.table.quotes, 5, 'table cell must display each quote container');
    assert.equal(result.table.checkboxes, 4, 'table cell must display task markers as checkboxes');
    assert.ok(result.table.quoteBorder > 0 && result.table.checkboxDisplay !== 'none',
      'table-cell quote and task styles must be visible');
    assert.ok(result.table.text.includes('quoted task') && result.table.text.includes('bold item'));
    assert.ok(result.table.text.indexOf('plain') < result.table.text.indexOf('quoted task')
      && result.table.text.indexOf('quoted task') < result.table.text.indexOf('bold item')
      && result.table.text.indexOf('bold item') < result.table.text.indexOf('task in list quote'),
    'table-cell containers must keep source order');
    assert.equal(result.table.source, result.tableSource);
    assert.ok(result.nestedTable.cells >= 2 && result.nestedTable.text.includes('visible nested cell'));
    assert.equal(result.nestedTable.source, result.nestedTableSource);

    const sameLine = await page.evaluate(async () => {
      const source = [
        '- 1. bullet then ordered',
        '1. - ordered then bullet',
        '- 1. - three list markers',
        '- 1. [ ] task after two lists',
        '> - 1. quote then two lists',
        '- > 1. list quote ordered',
        '1. > - [x] ordered quote task',
        '- 1. - 2. [ ] five markers',
        '- [ ] 1. task first keeps ordered text'
      ].join('\n');
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('host')!, text: source,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const items = Array.from(document.querySelectorAll<HTMLElement>('#host .cm-line')).map((line) => ({
        text: line.innerText,
        markers: line.querySelectorAll('.meo-md-list-marker').length,
        checkboxes: line.querySelectorAll('.meo-task-checkbox').length,
        markerRects: Array.from(line.querySelectorAll<HTMLElement>('.meo-md-list-marker'))
          .map((marker) => ({ left: marker.getBoundingClientRect().left, right: marker.getBoundingClientRect().right }))
      }));
      editor.destroy();
      return items;
    });
    assert.deepEqual(sameLine.map((line) => line.markers), [2, 2, 3, 1, 2, 2, 1, 3, 0],
      `same-line list markers must all render: ${JSON.stringify(sameLine)}`);
    assert.equal(sameLine[3]?.checkboxes, 1);
    assert.equal(sameLine[6]?.checkboxes, 1);
    assert.equal(sameLine[7]?.checkboxes, 1);
    assert.equal(sameLine[8]?.checkboxes, 1);
    for (const line of sameLine) {
      for (let index = 1; index < line.markerRects.length; index += 1) {
        assert.ok(line.markerRects[index].left >= line.markerRects[index - 1].right - 1,
          `same-line markers overlap: ${JSON.stringify(line)}`);
      }
    }
    for (const text of [
      'bullet then ordered', 'ordered then bullet', 'three list markers', 'task after two lists',
      'quote then two lists', 'list quote ordered', 'ordered quote task', 'five markers',
      '1. task first keeps ordered text'
    ]) {
      assert.ok(sameLine.some((line) => line.text.includes(text)), `same-line content lost: ${text}`);
    }

    const sameLineTable = await page.evaluate(async () => {
      const source = '| Items |\n| --- |\n| - 1. forward<br>1. - reverse<br>> - 1. quoted<br>- 1. [ ] task<br>- [ ] 1. task first<br>- > 1. list quote<br>1. - [x] reverse task |';
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('table-host')!, text: source,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const cell = document.querySelector<HTMLElement>('#table-host tbody td .meo-md-html-table-cell-preview')!;
      const result = {
        listItems: cell.querySelectorAll('li').length,
        checkboxes: cell.querySelectorAll('input[type=checkbox]').length,
        text: cell.innerText,
        source: editor.getText()
      };
      editor.destroy();
      return result;
    });
    assert.equal(sameLineTable.listItems, 13, 'table cell must retain every parsed same-line nested list');
    assert.equal(sameLineTable.checkboxes, 3);
    assert.ok(['forward', 'reverse', 'quoted', 'task first', 'list quote', 'reverse task']
      .every((text) => sameLineTable.text.includes(text)));
    assert.equal(sameLineTable.source, '| Items |\n| --- |\n| - 1. forward<br>1. - reverse<br>> - 1. quoted<br>- 1. [ ] task<br>- [ ] 1. task first<br>- > 1. list quote<br>1. - [x] reverse task |');

    await page.evaluate(() => {
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('edit-host')!, text: '> - [ ] task',
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      (window as any).__compositeEdit = editor;
      editor.view.focus();
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    });
    await page.keyboard.press('Enter');
    const liveEnter = await page.evaluate(() => {
      const editor = (window as any).__compositeEdit;
      const text = editor.getText();
      editor.destroy();
      return text;
    });
    assert.equal(liveEnter, '> - [ ] task\n> - [ ] ', 'Enter must continue the quoted task list');

    await page.evaluate(() => {
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('edit-host')!,
        text: '| Items |\n| --- |\n| > - [ ] task |',
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      (window as any).__compositeTableEdit = editor;
      const input = document.querySelector<HTMLTextAreaElement>('#edit-host tbody textarea')!;
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    await page.keyboard.down('Shift');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Shift');
    const tableEnter = await page.evaluate(() => {
      const editor = (window as any).__compositeTableEdit;
      const value = document.querySelector<HTMLTextAreaElement>('#edit-host tbody textarea')!.value;
      editor.destroy();
      return value;
    });
    assert.ok(tableEnter.endsWith('<br>\n> - [ ] '), `Enter must continue the quoted table-cell task: ${tableEnter}`);

    await page.evaluate(() => {
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('edit-host')!, text: '> - [ ] ',
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      (window as any).__emptyCompositeEdit = editor;
      editor.view.focus();
      editor.view.dispatch({ selection: { anchor: editor.view.state.doc.length } });
    });
    await page.keyboard.press('Enter');
    const emptyExit = await page.evaluate(() => {
      const editor = (window as any).__emptyCompositeEdit;
      const text = editor.getText();
      editor.destroy();
      return text;
    });
    assert.equal(emptyExit, '> ', 'empty quoted task must exit the list and keep the quote');

    const quoteTable = await page.evaluate(async () => {
      const source = '> | A | B |\n> | --- | --- |\n> | visible quote cell | yes |';
      const editor = (window as any).ListEditingHarness.createEditor({
        parent: document.getElementById('edit-host')!, text: source,
        initialMode: 'live', uiLanguage: 'zh-CN', onApplyChanges() {}
      });
      (window as any).__quoteTableEdit = editor;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const result = {
        cells: document.querySelectorAll('#edit-host .meo-md-html-table-cell-preview').length,
        text: document.getElementById('edit-host')!.innerText,
        source: editor.getText()
      };
      return { ...result, expectedSource: source };
    });
    assert.ok(quoteTable.cells >= 2 && quoteTable.text.includes('visible quote cell'));
    assert.equal(quoteTable.source, quoteTable.expectedSource);
    await page.click('#edit-host tbody tr:first-child td:first-child textarea');
    await page.keyboard.press('End');
    await page.keyboard.type(' edited');
    await page.keyboard.press('Escape');
    const editedQuoteTable = await page.evaluate(async () => {
      const editor = (window as any).__quoteTableEdit;
      const text = editor.getText();
      await editor.undo();
      const undone = editor.getText();
      await editor.redo();
      const redone = editor.getText();
      editor.destroy();
      return { text, undone, redone };
    });
    const editedSource = quoteTable.expectedSource.replace('visible quote cell', 'visible quote cell edited');
    assert.equal(editedQuoteTable.text, editedSource);
    assert.equal(editedQuoteTable.undone, quoteTable.expectedSource);
    assert.equal(editedQuoteTable.redone, editedSource);
    console.log('live composite list checks passed');
  } finally {
    await browser.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();
