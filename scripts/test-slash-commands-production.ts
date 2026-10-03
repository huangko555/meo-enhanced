import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';

const build = await Bun.build({ entrypoints: ['scripts/test-editing-features-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser(), page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error' && message.text().includes('plugin crashed')) errors.push(message.text()) });
try {
  await page.setViewport({ width: 1000, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const prepare = async (mode: string, text = '', pos = text.length, input = {}) => {
    await page.evaluate(({ mode, text, pos, input }) => {
      const g = window as any; g.editor?.destroy();
      g.editor = g.EditingFeaturesHarness.createEditor({ parent: document.getElementById('app')!, text, initialMode: mode, initialInputAssistance: input, onApplyChanges() {} });
      g.editor.view.dispatch({ selection: { anchor: pos } }); g.editor.view.focus();
    }, { mode, text, pos, input: { ...defaultInputAssistance, ...input } });
  };
  const text = () => page.evaluate(() => (window as any).editor.getText());
  const open = () => page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 3000 });
  const closed = async () => { await new Promise(resolve => setTimeout(resolve, 100)); await page.waitForFunction(() => !document.querySelector('.meo-input-suggestions:not([hidden])'), { timeout: 1000 }); };
  const waitText = (expected: string) => page.waitForFunction(expected => (window as any).editor.getText() === expected, { timeout: 4000 }, expected);
  for (const mode of ['source', 'live']) {
    await prepare(mode); await page.keyboard.type('/'); await open();
    const ime = await page.createCDPSession();
    await ime.send('Input.imeSetComposition', { text: 'bold', selectionStart: 4, selectionEnd: 4 });
    await page.waitForFunction(() => Array.from(document.querySelectorAll('.meo-input-suggestion')).every(row => row.textContent?.includes('Bold')) && document.querySelectorAll('.meo-input-suggestion').length === 2);
    for (const key of [' ', 'Enter', 'ArrowDown', 'ArrowUp', 'Escape']) {
      assert.equal(await page.evaluate(key => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true });
        document.activeElement!.dispatchEvent(event); return event.defaultPrevented;
      }, key), false, 'preedit keys remain owned by the IME: ' + key);
      await waitText('/bold');
    }
    await page.evaluate(() => document.querySelector<HTMLButtonElement>('.meo-input-suggestion')!.click()); await waitText('/bold');
    await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await waitText('/'); await open();
    await ime.send('Input.imeSetComposition', { text: 'bold', selectionStart: 4, selectionEnd: 4 });
    await ime.send('Input.insertText', { text: 'bold' }); await open();
    await page.keyboard.press('Enter'); await waitText('****');
    await ime.send('Input.imeSetComposition', { text: 'italic', selectionStart: 6, selectionEnd: 6 });
    await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await waitText('****'); await closed();
    await prepare(mode); await page.keyboard.type('/'); await open();
    await ime.send('Input.imeSetComposition', { text: 'bold', selectionStart: 4, selectionEnd: 4 });
    await ime.send('Input.insertText', { text: '中文' }); await closed(); await waitText('/中文');
    await ime.detach();
    await prepare(mode, '正文'); await page.keyboard.type('/b'); await open();
    await page.keyboard.press('Enter'); await waitText('正文****');
    await page.keyboard.type('word'); await waitText('正文**word**');
    for (const [query, empty, filled] of [
      ['b', '****', '**word**'], ['i', '**', '*word*'], ['bi', '******', '***word***'],
      ['strike', '~~~~', '~~word~~'], ['mark', '====', '==word=='], ['sub', '~~', '~word~'], ['sup', '^^', '^word^'],
      ['ic', '``', '`word`'], ['math', '$$', '$word$']
    ] as const) {
      await prepare(mode); await page.keyboard.type('/' + query); await open(); await page.keyboard.press('Enter'); await waitText(empty);
      await page.keyboard.type('word'); await waitText(filled); await page.keyboard.press('Tab'); await page.keyboard.type('Z'); await waitText(filled + 'Z');
    }
    const breakTable = '| A | B |\n| --- | --- |\n| word | x |';
    await prepare(mode, breakTable, breakTable.indexOf('word') + 4);
    if (mode === 'live') {
      await page.waitForSelector('tbody textarea'); await page.click('tbody textarea');
      await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).setSelectionRange(4, 4));
    }
    await page.keyboard.type('/br'); await open(); await page.keyboard.press('Enter'); await page.keyboard.type('next');
    await page.evaluate(() => (window as any).editor.getTextForSave());
    await waitText(breakTable.replace('word', 'word<br>next'));
    for (const [query, expected] of [['h1', '# '], ['h2', '## '], ['h3', '### '], ['h4', '#### '], ['h5', '##### '], ['h6', '###### '], ['quote', '> '], ['ol', '1. '], ['ul', '- '], ['todo', '- [ ] '], ['hr', '---'], ['code', '```\n\n```'], ['br', '  \n'], ['def', '<dl>\n<dt>Term</dt>\n<dd>Definition</dd>\n</dl>'], ['equation', '$$\n\n$$']] as const) {
      await prepare(mode); await page.keyboard.type('/' + query); await open(); await page.keyboard.press('Enter'); await waitText(expected);
      if (query === 'equation') { await page.keyboard.type('x^2'); await waitText('$$\nx^2\n$$'); }
      if (query === 'def') {
        const html = renderMarkdownToHtml({ markdownText: await text(), markdownFilePath: 'fixture.md', target: 'html' }).html;
        assert.ok(html.includes('<dl>') && html.includes('<dt>Term</dt>') && html.includes('<dd>Definition</dd>'), 'definition list renders with its semantics');
      }
    }
    for (const [source, empty, filled] of [
      ['- ', '- $$\n  \n  $$', '- $$\n  x^2\n  $$'],
      ['> ', '> $$\n> \n> $$', '> $$\n> x^2\n> $$']
    ]) {
      await prepare(mode, source); await page.keyboard.type('/equation'); await open(); await page.keyboard.press('Enter'); await waitText(empty);
      await page.keyboard.type('x^2'); await waitText(filled);
      assert.ok(renderMarkdownToHtml({ markdownText: await text(), markdownFilePath: 'fixture.md', target: 'html' }).html.includes('katex'), 'nested formulas also render on reading surfaces');
    }
    for (const [query, expected] of [['js', 'javascript'], ['ts', 'typescript'], ['py', 'python'], ['java', 'java'], ['go', 'go'], ['rust', 'rust'], ['sh', 'shell'], ['json', 'json'], ['sql', 'sql'], ['html', 'html'], ['css', 'css']]) {
      await prepare(mode); await page.keyboard.type('/' + query); await open(); await page.keyboard.press('Enter'); await waitText('```' + expected + '\n\n```');
      await page.keyboard.type('sample'); await waitText('```' + expected + '\nsample\n```');
    }
    for (const [query, expected, fields] of [
      ['link', '[text](url)', ['text', 'url']], ['linktitle', '[text](url "title")', ['text', 'url', 'title']],
      ['img', '![alt](url)', ['alt', 'url']], ['imgtitle', '![alt](url "title")', ['alt', 'url', 'title']],
      ['url', '<https://example.com>', ['https://example.com']]
    ] as const) {
      await prepare(mode); await page.keyboard.type('/' + query); await open(); await page.keyboard.press('Enter'); await waitText(expected);
      for (let index = 0; index < fields.length; index++) {
        assert.equal(await page.evaluate(() => { const g = window as any, range = g.editor.view.state.selection.main; return g.editor.view.state.sliceDoc(range.from, range.to); }), fields[index]);
        await page.keyboard.type('value' + index); await page.keyboard.press('Tab');
      }
      await page.keyboard.type('Z'); assert.ok((await text()).endsWith('Z'), query + ': Tab exits the template');
    }
    await prepare(mode, '- keep'); await page.keyboard.type('/def'); await open(); await page.keyboard.press('Enter');
    for (const [index, field] of ['Term', 'Definition'].entries()) {
      assert.equal(await page.evaluate(() => { const g = window as any, range = g.editor.view.state.selection.main; return g.editor.view.state.sliceDoc(range.from, range.to); }), field, mode + ': fields account for list indentation');
      await page.keyboard.type('value' + index); await page.keyboard.press('Tab');
    }
    await waitText('- keep\n  \n  <dl>\n  <dt>value0</dt>\n  <dd>value1</dd>\n  </dl>');
    await prepare(mode, '# Title '); await page.keyboard.type('/id'); await open(); await page.keyboard.press('Enter'); await waitText('# Title <a id="anchor"></a>');
    await page.keyboard.type('custom'); await waitText('# Title <a id="custom"></a>');
    assert.equal(await page.evaluate(() => { const g = window as any; return g.EditingFeaturesHarness.findDocumentFragmentPosition(g.editor.view.state, '#custom'); }), 8);
    await prepare(mode); await page.keyboard.type('/b'); await open();
    await page.keyboard.press('Escape'); await closed(); await page.keyboard.type('old'); await closed(); await waitText('/bold');
    await page.keyboard.press('Enter'); assert.ok((await text()).startsWith('/bold\n'));
    await prepare(mode); await page.keyboard.type('/b'); await open();
    await page.evaluate(() => { const e = (window as any).editor; e.view.dispatch({ selection: { anchor: 0 } }); e.view.dispatch({ selection: { anchor: 2 } }); }); await closed();
    await prepare(mode, '/bold'); await closed();
    await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowRight'); await closed();
    await prepare(mode); await page.evaluate(() => {
      const g = window as any, data = new DataTransfer(); data.setData('text/plain', '/bold');
      g.editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }); await closed(); await waitText('/bold');
    for (const invalid of [' ', '.', '-', '_', '中', '/']) {
      await prepare(mode); await page.keyboard.type('/b'); await open(); await page.keyboard.type(invalid); await closed(); await waitText('/b' + invalid);
    }
    await prepare(mode); await page.keyboard.type('/xyz'); await closed(); await page.keyboard.press('Escape'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace'); await closed();
    for (const [source, pos] of [['`text`', 3], ['```js\ncode\n```', 9], ['    code', 7], ['$x^2$', 3], ['$$\nx\n$$', 4], ['[x](url)', 7], ['[x](url "title")', 12], ['<div>text</div>', 8], ['<!-- note -->', 7], ['---\na: b\n---\n', 7], ['https:', 6]] as const) {
      await prepare(mode, source, pos);
      if (mode === 'live' && source.startsWith('$$')) {
        await page.click('.meo-latex-math-mode-btn');
        await page.waitForSelector('.meo-latex-math-editing-block.is-split .cm-content');
        await page.click('.meo-latex-math-editing-block.is-split .cm-content'); await page.keyboard.press('End');
      }
      await page.keyboard.type('/b'); await closed();
      assert.ok((await text()).includes('/b'), source + ': slash remains literal');
    }
    for (const [source, pos] of [['## title', 8], ['**word**', 4], ['^word^', 3], ['~word~', 3], ['[label](url)', 4], ['| A | B |\n| --- | --- |\n| word | x |', 28]] as const) {
      await prepare(mode, source, pos);
      if (mode === 'live' && source.startsWith('| A | B |')) {
        await page.waitForSelector('tbody textarea'); await page.click('tbody textarea');
        await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).setSelectionRange(2, 2));
      }
      await page.keyboard.type('/b'); await open();
      const choices = await page.$$eval('.meo-input-suggestion', rows => rows.map(row => (row as HTMLElement).dataset.command));
      assert.ok(choices.includes('bold'));
      assert.ok(!choices.includes('table') && !choices.includes('codeBlock') && !choices.includes('heading2'), source + ': only applicable inline commands');
    }
    await prepare(mode, '', 0, { slash: false }); await page.keyboard.type('/b'); await closed(); await waitText('/b');
    await prepare(mode); await page.keyboard.type('/b'); await open(); await page.evaluate(input => (window as any).editor.setInputAssistance(input), { ...defaultInputAssistance, slash: false }); await closed(); await waitText('/b');
    await prepare(mode, 'before after', 6); await page.keyboard.type('/h2'); await open(); await page.keyboard.press('Enter'); await waitText('before\n\n## \n\n after');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('before/h2 after');
    await page.evaluate(() => (window as any).editor.redo()); await waitText('before\n\n## \n\n after');
    await closed();
    await prepare(mode); await page.keyboard.type('/table'); await open(); await page.keyboard.press('Enter');
    await waitText('|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |');
    if (mode === 'live') await page.waitForFunction(() => document.activeElement instanceof HTMLTextAreaElement && document.activeElement.dataset.tableRow === '0');
    await page.keyboard.type('Header'); await waitText('| Header |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |');
    await prepare(mode); await page.keyboard.type('/table3x4'); await open(); await page.keyboard.press('Enter');
    await waitText('|  |  |  |  |\n| --- | --- | --- | --- |\n|  |  |  |  |\n|  |  |  |  |\n|  |  |  |  |');
    const defaultTable = '|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |';
    for (const [source, pos, expected] of [
      ['- keep', 0, defaultTable + '\n\n- keep'],
      ['> keep', 0, defaultTable + '\n\n> keep'],
      ['keep text', 9, 'keep text\n\n' + defaultTable],
      ['before\n\nnext', 7, 'before\n\n' + defaultTable + '\n\nnext'],
      ['before\n\n\nnext', 7, 'before\n\n' + defaultTable + '\n\nnext'],
      ['- [ ] ', 6, '- [ ] \n  \n' + defaultTable.split('\n').map(line => '  ' + line).join('\n')],
      ['- [ ] keep', 10, '- [ ] keep\n  \n' + defaultTable.split('\n').map(line => '  ' + line).join('\n')],
      ['- keep', 6, '- keep\n  \n' + defaultTable.split('\n').map(line => '  ' + line).join('\n')],
      ['> keep', 6, '> keep\n> \n' + defaultTable.split('\n').map(line => '> ' + line).join('\n')],
      ['> - keep', 8, '> - keep\n>   \n' + defaultTable.split('\n').map(line => '>   ' + line).join('\n')]
    ] as const) {
      await prepare(mode, source, pos); await page.evaluate(() => (window as any).editor.executeCommand('insertTable')); await waitText(expected);
      const html = renderMarkdownToHtml({ markdownText: await text(), markdownFilePath: 'fixture.md', target: 'html' }).html;
      assert.ok(html.includes('<table'), source + ': inserted table remains a real Markdown table');
      await page.evaluate(() => (window as any).editor.undo()); await waitText(source);
    }
    await prepare(mode, 'first\nsecond'); await page.evaluate(() => { const e = (window as any).editor; e.view.dispatch({ selection: { anchor: 2, head: 12 } }); e.insertFormat('table'); }); await waitText('first\nsecond\n\n' + defaultTable);
    for (const [source, pos] of [['```\ncode\n```', 6], ['$x^2$', 3], ['| A | B |\n| --- | --- |\n| x | y |', 26]] as const) {
      await prepare(mode, source, pos); await page.evaluate(() => (window as any).editor.insertFormat('table')); await waitText(source);
    }
    for (const [cols, rows] of [[0, 2], [3, 0], [11, 2], [2, 11], [1.5, 2]]) {
      await prepare(mode, 'keep'); await page.evaluate(({ cols, rows }) => (window as any).editor.insertFormat('table', { cols, rows }), { cols, rows }); await waitText('keep');
    }
    await prepare(mode);
    const dimensions = await page.evaluate(() => {
      const g = window as any, results: { rows: number; cols: number; height: number; widths: number[]; empty: boolean }[] = [];
      for (let rows = 1; rows <= 10; rows++) for (let cols = 1; cols <= 10; cols++) {
        g.editor.setText('', true); g.editor.view.focus(); g.editor.insertFormat('table', { rows, cols });
        const table = g.EditingFeaturesHarness.parseMarkdownTable(g.editor.getText());
        results.push({ rows, cols, height: table?.cells.length ?? -1, widths: table?.cells.map((row: string[]) => row.length) ?? [], empty: table?.cells.every((row: string[]) => row.every(value => value === '')) ?? false });
      }
      return results;
    });
    assert.equal(dimensions.length, 100);
    for (const { rows, cols, height, widths, empty } of dimensions) {
      assert.equal(height, rows + 1, mode + ': data rows plus header'); assert.ok(widths.every(width => width === cols)); assert.equal(empty, true);
    }
    for (const query of ['table0x3', 'table11x2', 'table2x', '3x0', 'table3', '100x100']) {
      await prepare(mode); await page.keyboard.type('/' + query); await closed(); await page.keyboard.press('Enter'); assert.ok((await text()).startsWith('/' + query + '\n'), 'invalid dimensions never execute a default');
    }

  }
  const table = '| A | B |\n| --- | --- |\n|  | x |';
  await prepare('live', table, 0);
  await page.waitForSelector('tbody textarea');
  await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.focus(); input.setSelectionRange(0, 0); });
  await page.keyboard.type('/b'); await open(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), '****');
  await page.keyboard.type('word');
  await page.evaluate(() => (window as any).editor.getTextForSave()); await waitText(table.replace('|  | x |', '| **word** | x |'));
  const prepareCell = async (value = '', pos = value.length) => {
    await prepare('live', table.replace('|  | x |', '| ' + value + ' | x |'), 0);
    await page.waitForSelector('tbody textarea'); await page.click('tbody textarea');
    await page.evaluate(pos => (document.activeElement as HTMLTextAreaElement).setSelectionRange(pos, pos), pos);
  };
  await prepareCell(); await page.keyboard.type('/b'); await open();
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-controls')), await page.$eval('.meo-input-suggestions', e => e.id), 'the native input owns its candidate accessibility relationship');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), '******', 'native arrow selection remains stable after keyup');
  await page.evaluate(() => (window as any).editor.undo()); await waitText(table.replace('|  | x |', '| /b | x |'));
  await page.evaluate(() => (window as any).editor.redo()); await waitText(table.replace('|  | x |', '| ****** | x |'));
  await prepareCell(); await page.keyboard.type('/linktitle'); await open(); await page.keyboard.press('Enter');
  for (const [index, field] of ['text', 'url', 'title'].entries()) {
    assert.equal(await page.evaluate(() => { const input = document.activeElement as HTMLTextAreaElement; return input.value.slice(input.selectionStart, input.selectionEnd); }), field);
    await page.keyboard.type('value' + index); await page.keyboard.press('Tab');
  }
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), '[value0](value1 "value2")');
  await prepareCell('``a`b``'); await page.keyboard.type('/b'); await open(); await page.keyboard.press('Escape'); await closed();
  await prepareCell('`word`', 3); await page.keyboard.type('/b'); await closed();
  await prepareCell(); await page.keyboard.type('/table'); await closed();
  assert.equal(await page.evaluate(() => (window as any).editor.executeCommand('insertTable')), false);
  await prepareCell(); await page.keyboard.type('/'); await open();
  const nativeIme = await page.createCDPSession();
  await nativeIme.send('Input.imeSetComposition', { text: 'bold', selectionStart: 4, selectionEnd: 4 });
  await page.waitForFunction(() => document.querySelectorAll('.meo-input-suggestion').length === 2);
  for (const key of [' ', 'Enter', 'ArrowDown', 'Escape']) assert.equal(await page.evaluate(key => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true }); document.activeElement!.dispatchEvent(event); return event.defaultPrevented;
  }, key), false, 'native IME owns ' + key);
  await nativeIme.send('Input.insertText', { text: 'bold' }); await open(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), '****'); await nativeIme.detach();
  assert.deepEqual(errors, []);
  console.log('Slash commands production contracts passed');
} catch (error) {
  console.error('Slash failure:', await page.evaluate(() => ({ text: (window as any).editor?.getText(), active: document.activeElement?.outerHTML.slice(0, 300), popup: document.querySelector('.meo-input-suggestions')?.outerHTML })));
  throw error;
} finally { await closeTestBrowser(browser); }
