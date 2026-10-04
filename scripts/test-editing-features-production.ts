import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
import type { LinkCandidate } from '../src/protocol/editorServices';
import { parseDelimitedTable, serializeDelimitedTable, splitMarkdownTableRow, parseMarkdownTable } from '../webview/src/application/delimitedTable';

for (const delimiter of [',', '\t'] as const) {
  const cells = [['a,b', '"quote"', ''], ['line\nnext', 'a\tb', ' a ']];
  assert.deepEqual(parseDelimitedTable(serializeDelimitedTable(cells, delimiter), delimiter), cells);
  assert.equal(parseDelimitedTable('"unterminated', delimiter), null);
  assert.equal(parseDelimitedTable('"x"oops' + delimiter + 'y', delimiter), null);
  assert.deepEqual(parseDelimitedTable('a' + delimiter + 'b\r\nx\r\n', delimiter), [['a', 'b'], ['x', '']]);
  assert.equal(parseDelimitedTable(('a' + delimiter).repeat(10_001), delimiter), null);
}
assert.deepEqual(splitMarkdownTableRow('| a\\|b | c\\\\|'), ['a\\|b', 'c\\\\']);
assert.equal(parseMarkdownTable('| A | B |\n| --- | invalid |'), null);
const build = await Bun.build({ entrypoints: ['scripts/test-editing-features-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
const page = await browser.newPage();
const errors: string[] = [];
page.on('console', message => { if (message.type() === 'error' && message.text().includes('CodeMirror plugin crashed')) errors.push(message.text()); });
page.on('pageerror', error => errors.push(error instanceof Error ? error.stack ?? String(error) : String(error)));
try {
  await page.setViewport({ width: 1000, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const prepare = async (mode: string, text = '', from = text.length, to = from, input = {}, links?: string | readonly LinkCandidate[]) => {
    await page.evaluate(({ mode, text, from, to, input, links }) => {
      const global = window as any;
      global.releaseLinks = null; global.editor?.destroy();
      global.editor = global.EditingFeaturesHarness.createEditor({ parent: document.getElementById('app')!, text, initialMode: mode, initialInputAssistance: input,
        requestLinkCandidates: links === 'hold' ? () => new Promise(resolve => { global.releaseLinks = resolve; }) : links ? async () => typeof links === 'string' ? [{ label: links, insert: links, detail: 'fixture' }] : links : undefined, onApplyChanges() {} });
      global.editor.view.dispatch({ selection: { anchor: from, head: to } }); global.editor.view.focus();
    }, { mode, text, from, to, input: { ...defaultInputAssistance, ...input }, links });
  };
  const text = () => page.evaluate(() => (window as any).editor.getText());
  const command = (command: string) => page.evaluate(command => (window as any).editor.executeCommand(command), command);
  const paste = (text: string, html = '', custom = '') => page.evaluate(({ text, html, custom }) => {
    const clipboard = new DataTransfer(); clipboard.setData('text/plain', text);
    if (html) clipboard.setData('text/html', html);
    if (custom) clipboard.setData('application/x-meo-table-cells+json', custom);
    const event = new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true });
    (window as any).editor.view.contentDOM.dispatchEvent(event); return event.defaultPrevented;
  }, { text, html, custom });
  const waitText = async (expected: string) => {
    try { await page.waitForFunction(expected => (window as any).editor.getText() === expected, { timeout: 4000 }, expected); }
    catch { throw new Error(JSON.stringify({ expected, actual: await text() })); }
  };
  const openCell = async () => {
    await page.waitForSelector('tbody textarea');
    await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.focus(); input.setSelectionRange(0, input.value.length); });
  };
  const cell = () => page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value);
  const table = '| A | B |\n| --- | --- |\n|  | x |';
  const session = await page.createCDPSession();
  for (const mode of ['source', 'live']) {
    await prepare(mode);
    await session.send('Input.imeSetComposition', { text: '（', selectionStart: 1, selectionEnd: 1 });
    assert.equal(await text(), '（', 'preedit must not be paired');
    await session.send('Input.insertText', { text: '（' });
    await waitText('（）');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('');
    await prepare(mode);
    await session.send('Input.imeSetComposition', { text: '（）', selectionStart: 1, selectionEnd: 1 });
    await session.send('Input.insertText', { text: '（）' }); await waitText('（）');
    for (const ticks of ['```', '````']) {
      await prepare(mode); await page.keyboard.type(ticks); assert.equal(await text(), ticks, 'typing a Markdown fence keeps the literal delimiter');
      await page.keyboard.type('js'); assert.equal(await text(), ticks + 'js');
    }
    await prepare(mode, '\\'); await page.keyboard.type('('); assert.equal(await text(), '\\(');
    await prepare(mode, '\\\\'); await page.keyboard.type('('); assert.equal(await text(), '\\\\()');
    await prepare(mode, 'a b');
    await page.evaluate(() => { const global = window as any; global.editor.view.dispatch({ selection: global.EditingFeaturesHarness.EditorSelection.create([global.EditingFeaturesHarness.EditorSelection.range(0, 1), global.EditingFeaturesHarness.EditorSelection.range(2, 3)]) }); });
    await page.keyboard.type('（'); assert.equal(await text(), '（a） （b）');
    for (const [left, right] of [['*', '*'], ['_', '_'], ['~', '~'], ['<', '>'], ['$', '$'], ['^', '^'], ['=', '=']]) {
      await prepare(mode, 'a b');
      await page.evaluate(() => { const g = window as any; g.editor.view.dispatch({ selection: g.EditingFeaturesHarness.EditorSelection.create([g.EditingFeaturesHarness.EditorSelection.range(1, 0), g.EditingFeaturesHarness.EditorSelection.range(2, 3)]) }); });
      await page.keyboard.type(left); assert.equal(await text(), left + 'a' + right + ' ' + left + 'b' + right);
      assert.deepEqual(await page.evaluate(() => (window as any).editor.view.state.selection.ranges.map((range: any) => range.toJSON())), [{ anchor: 2, head: 1 }, { anchor: 5, head: 6 }]);
      await page.evaluate(() => (window as any).editor.undo()); await waitText('a b');
      await page.evaluate(() => (window as any).editor.redo()); await waitText(left + 'a' + right + ' ' + left + 'b' + right);
      for (const [document, from, to] of [['```\nword\n```', 4, 8], ['`word`', 1, 5]] as const) {
        await prepare(mode, document, from, to); await page.keyboard.type(left);
        assert.equal(await text(), document.slice(0, from) + left + 'word' + right + document.slice(to), 'selection surrounding also works in code contexts');
      }
      for (const second of [[3, 3], [2, 3]]) {
        await prepare(mode, 'a  b', 0);
        await page.evaluate(second => { const g = window as any; g.editor.view.dispatch({ selection: g.EditingFeaturesHarness.EditorSelection.create([g.EditingFeaturesHarness.EditorSelection.range(0, 1), g.EditingFeaturesHarness.EditorSelection.range(second[0], second[1])]) }); }, second);
        await page.keyboard.type(left); assert.equal(await text(), left + (second[0] === second[1] ? '  ' : ' ') + left + 'b', 'native mixed or whitespace selections all use ordinary replacement');
      }
    }
    for (const marker of ['*', '^', '=']) {
      await prepare(mode, 'word', 0, 4);
      await session.send('Input.imeSetComposition', { text: marker, selectionStart: 1, selectionEnd: 1 });
      assert.equal(await text(), marker, 'selected IME preedit is not surrounded');
      await session.send('Input.insertText', { text: marker }); await waitText(marker + 'word' + marker);
      await page.evaluate(() => (window as any).editor.undo()); await waitText('word');
    }
    await prepare(mode); await page.keyboard.type('(');
    await page.evaluate(() => { const editor = (window as any).editor; editor.setText('()', false); editor.view.dispatch({ selection: { anchor: 1 } }); editor.view.focus(); });
    await page.keyboard.type(')'); assert.equal(await text(), '())', 'external presentation clears pair provenance');
    await prepare(mode); assert.equal(await paste('A\tB\n1\t2'), true); assert.equal(await text(), '| A | B |\n| --- | --- |\n| 1 | 2 |');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('');
    await prepare(mode, '', 0, 0, { convertTables: false, pasteHtml: false }); await paste('A\tB'); assert.equal(await text(), 'A\tB');
    await prepare(mode, '', 0, 0, { convertTables: false }); await paste('A\tB', '<table><tr><td>A</td><td>B</td></tr></table>'); assert.equal(await text(), 'A\tB');
    await prepare(mode); await paste('word\tv', '<table><tr><td><strong>word</strong></td><td>v</td></tr></table>'); assert.equal(await text(), '| **word** | v |\n| --- | --- |');
    await prepare(mode, '', 0, 0, { pasteHtml: false }); await paste('word\tv', '<table><tr><td><strong>word</strong></td><td>v</td></tr></table>'); assert.equal(await text(), '| word | v |\n| --- | --- |');
    await prepare(mode, '```\n\n```', 4); await paste('A\tB', '<b>bold</b>'); assert.equal(await text(), '```\nA\tB\n```');
    await prepare(mode, 'word', 0, 4); assert.equal(await paste('https://example.test/a(b)'), true); assert.equal(await text(), '[word](https://example.test/a%28b%29)');
    await prepare(mode, 'word', 0, 4, { pasteUrl: false }); await paste('https://example.test'); assert.equal(await text(), 'https://example.test');
    await prepare(mode); assert.equal(await paste('bold', '<p><strong>bold</strong> and <em>italic</em></p>'), true); assert.equal(await text(), '**bold** and *italic*');
    await prepare(mode); await page.evaluate(() => (window as any).editor.pastePlainText('A\tB\r\n1\t2')); assert.equal(await text(), 'A\tB\n1\t2');
    await prepare(mode, table, table.indexOf('x'), table.indexOf('x'), { convertTables: false });
    if (mode === 'source') { assert.equal(await paste('u\tv\ny\tz'), true); assert.equal(await text(), '| A | B |  |\n| --- | --- | --- |\n|  | u | v |\n|  | y | z |'); }
    for (const [id, expected] of [['heading1', '# word'], ['heading6', '###### word'], ['bullet', '- word'], ['ordered', '1. word'], ['taskList', '- [ ] word'], ['quote', '> word']]) {
      await prepare(mode, 'word'); assert.equal(await command(id), true); assert.equal(await text(), expected); await command(id); assert.equal(await text(), 'word');
    }
    for (const [id, marker] of [['bold', '**'], ['italic', '*'], ['strike', '~~'], ['highlight', '=='], ['underline', '<u>'], ['kbd', '<kbd>']]) {
      await prepare(mode, 'word', 0, 4); await command(id); const close = marker.startsWith('<') ? marker.replace('<', '</') : marker;
      assert.equal(await text(), marker + 'word' + close); await command(id); assert.equal(await text(), 'word');
    }
    await prepare(mode, 'word', 0, 4); await command('codeBlock'); assert.equal(await text(), '```\nword\n```'); await command('codeBlock'); assert.equal(await text(), 'word');
    await prepare(mode, '- [ ] task'); await command('taskDone'); assert.equal(await text(), '- [x] task');
    await prepare(mode, '## heading'); await command('headingUp'); assert.equal(await text(), '# heading'); await command('headingDown'); assert.equal(await text(), '## heading');
    await prepare(mode, 'word'); await command('blankAbove'); assert.equal(await text(), '\nword');
    await prepare(mode, 'word'); await command('blankBelow'); assert.equal(await text(), 'word\n');
    await prepare(mode, 'word', 0, 4); await command('link'); assert.ok((await text()).startsWith('[word]('));
    await prepare(mode, 'word', 0, 4); await command('wikiLink'); assert.equal(await text(), '[[word]]');
    await prepare(mode, 'word', 0, 4); await command('image'); assert.ok((await text()).startsWith('!['));
    await prepare(mode, 'word'); await command('rule'); assert.ok((await text()).includes('---'));
    await prepare(mode); await command('insertTable'); assert.ok((await text()).includes('|'));
    await prepare(mode, 'before after', 6); await command('insertTable');
    await waitText('before\n\n|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n\n after');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('before after');
    await page.evaluate(() => (window as any).editor.redo());
    assert.ok((await text()).startsWith('before\n\n|'), 'table redo preserves surrounding text');
    await prepare(mode, 'word', 0, 4); await command('blockMath'); assert.equal(await text(), '$$\nword\n$$'); await command('blockMath'); assert.equal(await text(), 'word');
    await prepare(mode, '**word**', 4); await command('expandSelection'); await command('shrinkSelection');
    assert.equal(await page.evaluate(() => (window as any).editor.view.state.selection.main.head), 4);
    await prepare(mode, '$x$', 0, 3); await command('inlineMath'); assert.equal(await text(), 'x');
    assert.deepEqual(await page.evaluate(() => (window as any).editor.view.state.selection.main.toJSON()), { anchor: 0, head: 1 });
    await prepare(mode, 'one\ntwo', 0); await command('moveDown'); assert.equal(await text(), 'two\none');
    await prepare(mode, 'one\ntwo', 0); await command('copyDown'); assert.equal(await text(), 'one\none\ntwo');
    await prepare(mode, 'one\ntwo', 0); await command('deleteLine'); assert.equal(await text(), 'two');
    await prepare(mode, 'a,b\n1,2', 0, 7); await command('convert'); assert.equal(await text(), '| a | b |\n| --- | --- |\n| 1 | 2 |');
    const quotedCsv = '"a\tb",c\n1,2';
    await prepare(mode, quotedCsv, 0, quotedCsv.length); assert.equal(await command('convert'), true, 'quoted tabs remain CSV field data'); assert.equal(await text(), '| a\tb | c |\n| --- | --- |\n| 1 | 2 |');
  }
  for (const mode of ['source', 'live']) {
    const original = '| A | B | C |\n| --- | --- | --- |\n| a | b | c |\n| d | e | f |\n| g | h | i |';
    for (const id of ['rowAbove', 'rowBelow', 'rowDelete', 'columnBefore', 'columnAfter', 'columnDelete', 'moveRowUp', 'moveRowDown', 'moveColumnLeft', 'moveColumnRight', 'alignLeft', 'alignCenter', 'alignRight']) {
      await prepare(mode, original, original.indexOf(' e ') + 1);
      if (mode === 'live') {
        await page.waitForSelector('tbody textarea');
        await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody tr:nth-child(2) td:nth-child(2) textarea')!; input.focus(); input.setSelectionRange(0, 0); });
      }
      assert.equal(await command(id), true, mode + ': ' + id);
      await page.waitForFunction(original => (window as any).editor.getText() !== original, { timeout: 4000 }, original);
      const changed = await text(); assert.ok(changed.includes('|'), mode + ': ' + id + ' preserves table');
      await page.evaluate(() => (window as any).editor.undo()); await waitText(original);
    }
    await prepare(mode, 'a b', 0);
    await page.evaluate(() => { const g = window as any; g.editor.view.dispatch({ selection: g.EditingFeaturesHarness.EditorSelection.create([g.EditingFeaturesHarness.EditorSelection.range(0, 1), g.EditingFeaturesHarness.EditorSelection.range(2, 3)]) }); });
    await command('bold'); assert.equal(await text(), '**a** **b**'); await command('bold'); assert.equal(await text(), 'a b');
    await prepare(mode, 'a b a', 0, 1); await command('nextOccurrence');
    assert.equal(await page.evaluate(() => (window as any).editor.view.state.selection.ranges.length), 2);
    await prepare(mode, 'one\ntwo', 1); await command('addCursor');
    assert.equal(await page.evaluate(() => (window as any).editor.view.state.selection.ranges.length), 2);
    await prepare(mode, 'one\ntwo', 0, 7); await command('splitCursors');
    assert.equal(await page.evaluate(() => (window as any).editor.view.state.selection.ranges.length), 2);
  }
  for (const [left, right] of [['(', ')'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"], ['`', '`'], ['（', '）'], ['【', '】'], ['“', '”'], ['‘', '’'], ['《', '》'], ['「', '」'], ['『', '』']]) {
    await prepare('live', table, 0); await openCell(); await page.keyboard.type(left); assert.equal(await cell(), left + right, 'native pair ' + left);
    await page.keyboard.press('Backspace'); assert.equal(await cell(), '', 'native delete ' + left);
    await page.keyboard.type(left);
    await page.evaluate(() => (window as any).editor.getTextForSave());
    await page.keyboard.type(right); assert.equal(await cell(), left + right, 'native persisted skip ' + right);
  }
  const selectedCellTable = table.replace('|  | x |', '| word | x |');
  // Native Markdown fixture plus superscript/highlight and Chinese extensions; never
  // derive expectations from the production pair map, which previously hid omissions.
  for (const [left, right] of [['(', ')'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"], ['`', '`'], ['<', '>'], ['*', '*'], ['_', '_'], ['~', '~'], ['$', '$'], ['^', '^'], ['=', '='], ['（', '）'], ['【', '】'], ['“', '”'], ['‘', '’'], ['《', '》'], ['「', '」'], ['『', '』']]) {
    for (const backward of [false, true]) {
      await prepare('live', selectedCellTable, 0, 0, { pairMode: 'off' }); await openCell();
      await page.evaluate(backward => (document.activeElement as HTMLTextAreaElement).setSelectionRange(0, 4, backward ? 'backward' : 'forward'), backward);
      await page.keyboard.type(left); assert.equal(await cell(), left + 'word' + right, 'native selected pair ' + left);
      assert.deepEqual(await page.evaluate(() => { const input = document.activeElement as HTMLTextAreaElement; return [input.selectionStart, input.selectionEnd, input.selectionDirection]; }), [1, 5, backward ? 'backward' : 'forward']);
      await page.evaluate(() => (window as any).editor.getTextForSave());
      assert.ok((await text()).includes(left + 'word' + right), 'cell wrapping reaches the saved document');
    }
  }
  for (const [left, right] of [['*', '*'], ['_', '_'], ['~', '~'], ['<', '>'], ['$', '$'], ['^', '^'], ['=', '=']]) {
    await prepare('live', selectedCellTable, 0); await openCell(); await page.keyboard.type(left.repeat(2));
    assert.equal(await cell(), left.repeat(2) + 'word' + right.repeat(2), 'native repeated marker ' + left);
    await prepare('live', selectedCellTable, 0); await openCell(); await page.keyboard.type(left);
    await page.evaluate(() => (window as any).editor.getTextForSave());
    await page.evaluate(() => (window as any).editor.undo()); await waitText(selectedCellTable);
    await page.evaluate(() => (window as any).editor.redo()); await waitText(selectedCellTable.replace('word', left + 'word' + right));
    await prepare('live', selectedCellTable, 0, 0, { wrapSelection: false }); await openCell();
    await page.keyboard.type(left); assert.equal(await cell(), left);
    await prepare('live', table, 0, 0, { pairMode: 'always', skipMode: 'always', deleteMode: 'always' }); await openCell();
    await page.keyboard.type(left.repeat(2)); assert.equal(await cell(), left.repeat(2), 'native surrounding-only markers stay literal without a selection');
    await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).setSelectionRange(1, 1));
    await page.keyboard.press('Backspace'); assert.equal(await cell(), left, 'native surrounding-only markers do not delete as an automatic empty pair');
  }
  for (const [marker, count, className] of [['^', 1, 'meo-md-superscript'], ['=', 2, 'meo-md-highlight']] as const) {
    await prepare('live', selectedCellTable, 0); await openCell();
    await page.keyboard.type(marker);
    assert.equal(await cell(), marker + 'word' + marker, 'each cell input adds one layer');
    if (count === 2) await page.keyboard.type(marker);
    const marked = marker.repeat(count) + 'word' + marker.repeat(count);
    const expected = selectedCellTable.replace('word', marked);
    await page.evaluate(() => (window as any).editor.getTextForSave());
    await page.keyboard.press('Escape');
    await waitText(expected);
    await page.waitForFunction(className => document.querySelector(`tbody .${className}`)?.textContent === 'word', {}, className);
    await page.evaluate(() => (window as any).editor.undo()); await waitText(selectedCellTable);
    await page.evaluate(() => (window as any).editor.redo()); await waitText(expected);
  }
  await prepare('live', selectedCellTable.replace('word', 'a   b'), 0); await openCell();
  await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).setSelectionRange(1, 4));
  await page.keyboard.type('*'); assert.equal(await cell(), 'a*b', 'native whitespace selection is replaced');
  for (const quote of ['"', "'", '`']) {
    await prepare('live', selectedCellTable.replace('word', quote), 0); await openCell();
    await page.keyboard.type('"'); assert.equal(await cell(), '"', 'native single quote is replaced');
  }
  for (const marker of ['*', '^', '=']) {
    await prepare('live', selectedCellTable, 0); await openCell();
    await session.send('Input.imeSetComposition', { text: marker, selectionStart: 1, selectionEnd: 1 });
    assert.equal(await cell(), marker, 'cell IME preedit remains literal');
    await session.send('Input.insertText', { text: marker }); assert.equal(await cell(), marker + 'word' + marker);
  }
  await prepare('live', selectedCellTable.replace('word', '\\word'), 0); await openCell();
  await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).setSelectionRange(1, 5));
  await page.keyboard.type('_'); assert.equal(await cell(), '\\_word_');
  for (const ticks of ['```', '````']) {
    await prepare('live', table, 0); await openCell(); await page.keyboard.type(ticks); assert.equal(await cell(), ticks, 'native cell keeps literal backtick runs');
  }
  await prepare('live', table, 0); await openCell();
  await session.send('Input.imeSetComposition', { text: '（', selectionStart: 1, selectionEnd: 1 }); assert.equal(await cell(), '（');
  await session.send('Input.insertText', { text: '（' }); assert.equal(await cell(), '（）');
  await page.evaluate(() => (window as any).editor.getTextForSave()); assert.ok((await text()).includes('（）'));
  for (const lists of [true, false]) {
    await prepare('live', table, 0, 0, { lists }); await openCell(); await page.keyboard.type('- item'); await command('cellBreak');
    assert.equal(await cell(), lists ? '- item<br>\n- ' : '- item<br>\n');
  }
  await prepare('live', table, 0); await openCell(); await page.keyboard.type('('); await page.evaluate(() => (window as any).editor.getTextForSave());
  await page.keyboard.press('Backspace'); await page.evaluate(() => (window as any).editor.getTextForSave());
  await page.evaluate(() => (window as any).editor.undo()); await page.waitForFunction(() => (window as any).editor.getText().includes('()'));
  await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.focus(); input.setSelectionRange(1, 1); });
  await page.keyboard.type(')'); assert.equal(await cell(), '()', 'native origins survive undo');
  await prepare('live', table, 0); await openCell(); await page.keyboard.type('('); await page.evaluate(() => { const editor = (window as any).editor; editor.getTextForSave(); editor.setMode('source'); });
  await page.keyboard.type(')'); assert.ok(!(await text()).includes('())'), 'cell origins survive projection to Source');
  await prepare('live', table, 0); await openCell(); await page.keyboard.type('a`b');
  await page.evaluate(() => { const input = document.activeElement as HTMLTextAreaElement; input.setSelectionRange(0, input.value.length); });
  await command('inlineCode'); assert.equal(await cell(), '``a`b``'); await command('inlineCode'); assert.equal(await cell(), 'a`b');
  for (const mode of ['source', 'live']) {
    await prepare(mode, table, table.indexOf('x'), table.indexOf('x'), { convertTables: false });
    const md = '| **H** | V |\n| - | - |\n| a\\|b | c |';
    if (mode === 'live') {
      await openCell();
      await page.evaluate(md => { const data = new DataTransfer(); data.setData('text/plain', md); document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); }, md);
    } else await paste(md);
    assert.ok((await text()).includes('**H**')); assert.ok((await text()).includes('a\\|b'));
    const csv = await page.evaluate(() => (window as any).editor.getTableClipboardText('csv')); assert.ok(typeof csv === 'string');
  }
  const html = await page.evaluate(() => (window as any).EditingFeaturesHarness.parseHtmlTableClipboard('<table><tr><th rowspan="2">A<br>B</th><td colspan="2">C</td></tr><tr><td>D</td><td>E</td></tr></table>'));
  assert.deepEqual(html, { cells: [['A\nB', 'C', ''], ['', 'D', 'E']], source: 'external' });
  assert.equal(await page.evaluate(() => (window as any).EditingFeaturesHarness.parseHtmlTableClipboard('<table><tr><td colspan="10001">x</td></tr></table>')), null);
  const unsafe = await page.evaluate(() => (window as any).EditingFeaturesHarness.clipboardHtmlToMarkdown('<script>throw 1</script><a href="javascript:alert(1)">safe</a><img src="data:text/html,x">'));
  assert.equal(unsafe, 'safe');
  await prepare('source'); await page.keyboard.type('/head');
  await page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 5000 }); await page.keyboard.press('Enter'); assert.equal(await text(), '# ');
  await prepare('source', 'https://a/'); await page.waitForFunction(() => !document.querySelector('.meo-input-suggestions:not([hidden])'));
  const headingDocument = '# Hello **world**\n\n# Hello **world**\n\n# Hello **world**\n\nSetext heading\n============\n\n[Go](#He';
  await prepare('source', headingDocument, headingDocument.length, headingDocument.length, { pairMode: 'off' });
  await page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 5000 });
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.ok((await text()).endsWith('[Go](#hello-world-2'), 'a duplicate heading candidate inserts its rendered anchor');
  assert.equal(await page.evaluate(() => { const g = window as any; return g.EditingFeaturesHarness.findDocumentFragmentPosition(g.editor.view.state, '#hello-world-2'); }), headingDocument.indexOf('# Hello **world**', 1), 'the chosen canonical anchor navigates to the second heading');
  const setextDocument = 'Setext heading\n============\n\n[Go](#Se';
  await prepare('source', setextDocument, setextDocument.length, setextDocument.length, { pairMode: 'off' });
  await page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 5000 }); await page.keyboard.press('Enter');
  assert.ok((await text()).endsWith('[Go](#setext-heading'));
  assert.equal(await page.evaluate(() => { const g = window as any; return g.EditingFeaturesHarness.findDocumentFragmentPosition(g.editor.view.state, '#setext-heading'); }), 0);

  for (const mode of ['source', 'live']) {
    const chineseHeadings = '# 快捷键 **UI** 输入\n\n# 快捷键 **UI** 输入\n\n';
    const query = '[Go](#快';
    await prepare(mode, chineseHeadings + query, undefined, undefined, { pairMode: 'off' });
    await page.waitForSelector('.meo-input-suggestions:not([hidden])');
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
    await waitText(chineseHeadings + '[Go](#快捷键-ui-输入-2');
    for (const href of ['#快捷键-ui-输入-2', '#' + encodeURIComponent('快捷键-ui-输入-2')]) {
      assert.equal(await page.evaluate(href => { const g = window as any; return g.EditingFeaturesHarness.findDocumentFragmentPosition(g.editor.view.state, href); }, href), chineseHeadings.indexOf('# 快捷键', 1), 'readable and existing encoded links navigate to the same duplicate heading');
    }
    const remoteHeading = { label: '快捷键 UI 输入', insert: '快捷键 UI 输入', anchor: '快捷键-ui-输入-2', detail: 'docs/说明.md' };
    for (const wiki of [false, true]) {
      await prepare(mode, '', 0, 0, { pairMode: 'off' }, [remoteHeading]);
      const prefix = wiki ? '[[说明#' : '[Go](说明.md#';
      await page.keyboard.type(prefix + '快'); await page.waitForSelector('.meo-input-suggestions:not([hidden])');
      await page.keyboard.press('Enter'); await waitText(prefix + (wiki ? remoteHeading.insert : remoteHeading.anchor));
    }
  }

  await prepare('source', ':smile:', 7, 7, { emoji: true }); assert.equal(await text(), ':smile:');
  await prepare('source', '', 0, 0, { emoji: true }); await page.keyboard.type(':smi'); await page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 5000 }); await page.keyboard.press('Tab'); assert.equal(await text(), '😄');
  await prepare('source', '', 0, 0, { pairMode: 'off' }, 'documents/note.md'); await page.keyboard.type('[[doc'); await page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 5000 }); await page.keyboard.press('Enter'); assert.equal(await text(), '[[documents/note');
  await prepare('source', '', 0, 0, { pairMode: 'off' }, 'hold'); await page.keyboard.type('[[old');
  await page.waitForFunction(() => typeof (window as any).releaseLinks === 'function');
  await page.evaluate(() => { const g = window as any; g.editor.setText('plain', true); g.releaseLinks([{ label: 'old', insert: 'old', detail: '' }]); });
  await page.waitForFunction(() => !document.querySelector('.meo-input-suggestions:not([hidden])')); assert.equal(await text(), 'plain');
  await prepare('source', '', 0, 0, { pairMode: 'off' }, 'hold'); await page.keyboard.type('[[old');
  await page.waitForFunction(() => typeof (window as any).releaseLinks === 'function');
  await page.evaluate(() => { const g = window as any; g.editor.destroy(); g.editor = null; g.releaseLinks([{ label: 'old', insert: 'old', detail: '' }]); });
  await page.waitForFunction(() => document.querySelectorAll('.meo-input-suggestions').length === 0);
  await prepare('source', 'word', 0, 4); await page.keyboard.type('``'); assert.equal(await text(), '``word``');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.meo-input-suggestions').length), 1, 'destroyed editors remove their popup');
  const candidates: readonly LinkCandidate[] = Array.from({ length: 25 }, (_, index) => ({
    label: index ? 'Note-' + index + '.md' : 'Note-' + '很长的文档标题'.repeat(8) + '.md',
    insert: 'docs/' + index + '/Note with space.md', detail: index === 23 ? '' : index === 24 ? 'Note-24.md' : 'project/docs/' + 'long-folder/'.repeat(8) + index + '/Note with space.md'
  }));
  const repeatedHeadings = '# Shared title\n\n'.repeat(25);
  const openSuggestions = () => page.waitForSelector('.meo-input-suggestions:not([hidden])');
  const settleSuggestions = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const surface = () => page.$eval('.meo-input-suggestions:not([hidden])', popup => {
    const style = getComputedStyle(popup), row = getComputedStyle(popup.querySelector('.meo-input-suggestion')!);
    return { width: style.width, radius: style.borderRadius, shadow: style.boxShadow, font: style.fontFamily, size: style.fontSize, padding: style.padding, rowPadding: row.padding, rowHeight: popup.querySelector('.meo-input-suggestion')!.getBoundingClientRect().height, rowFont: row.fontFamily, rowSize: row.fontSize };
  });
  for (const mode of ['source', 'live']) for (const appearance of ['light', 'dark']) for (const language of ['en', 'zh-CN']) {
    const configureSurface = () => page.evaluate(({ appearance, language }) => {
      const root = document.documentElement, view = (window as any).editor.view;
      root.dataset.editorAppearance = appearance;
      root.style.setProperty('--vscode-sideBar-background', appearance === 'dark' ? '#20252a' : '#ffffff');
      root.style.setProperty('--vscode-panel-border', appearance === 'dark' ? '#454b51' : '#d4d8de');
      root.style.setProperty('--meo-foreground', appearance === 'dark' ? '#dce1e6' : '#24292f');
      root.style.setProperty('--vscode-descriptionForeground', appearance === 'dark' ? '#959da5' : '#68727d');
      (window as any).editor.setUiLanguage(language);
      view.contentDOM.style.fontFamily = 'Consolas, monospace'; view.contentDOM.style.fontSize = '17px';
      view.dispatch({ scrollIntoView: true }); view.requestMeasure();
    }, { appearance, language });
    await prepare(mode); await configureSurface(); await page.keyboard.type('/'); await openSuggestions();
    const expectedSurface = await surface();
    for (const kind of ['documents', 'paths', 'headings', 'emoji']) {
      await prepare(mode, kind === 'headings' ? repeatedHeadings : '', undefined, undefined, { pairMode: 'off', emoji: true }, kind === 'documents' || kind === 'paths' ? candidates : undefined);
      await configureSurface(); await settleSuggestions();
      const query = kind === 'documents' ? '[[Note' : kind === 'paths' ? '[Go](Note' : kind === 'headings' ? '[Go](#Shared' : ':s';
      await page.keyboard.type(query); await openSuggestions(); await settleSuggestions();
      const { width, rowPadding, rowHeight, ...sharedSurface } = await surface();
      const { width: slashWidth, rowPadding: slashPadding, rowHeight: slashHeight, ...slashSurface } = expectedSurface;
      const links = kind === 'documents' || kind === 'paths';
      assert.deepEqual(sharedSurface, slashSurface, [mode, appearance, language, kind].join(':') + ': shares slash shell and editor font');
      assert.equal(width, kind === 'emoji' ? '240px' : slashWidth, kind + ': width follows the candidate content');
      assert.equal(rowPadding, links ? '5px 8px' : slashPadding);
      if (links) assert.ok(rowHeight > slashHeight * 1.5, 'document and path rows reserve two full text lines');
      else assert.equal(rowHeight, slashHeight);
      const layout = await page.$eval('.meo-input-suggestions:not([hidden])', popup => {
        const list = popup.querySelector<HTMLElement>('.meo-suggestion-list')!, row = list.querySelector<HTMLElement>('[aria-selected="true"]')!;
        const label = row.querySelector<HTMLElement>('.meo-suggestion-label')!, detail = row.querySelector<HTMLElement>('.meo-input-suggestion-detail')!;
        const bounds = popup.getBoundingClientRect(), rowBounds = row.getBoundingClientRect();
        const labelBounds = label.getBoundingClientRect(), detailBounds = detail.getBoundingClientRect();
        return {
          clipped: label.getBoundingClientRect().width > 20 && detail.getBoundingClientRect().width > 10 && list.scrollWidth <= list.clientWidth + 1 && detail.getBoundingClientRect().right <= list.getBoundingClientRect().right + 1,
          singleLine: getComputedStyle(label).whiteSpace === 'nowrap' && getComputedStyle(detail).whiteSpace === 'nowrap',
          twoLines: detailBounds.top >= labelBounds.bottom - 1 && Math.abs(detailBounds.left - labelBounds.left) < 1 && Math.abs(detailBounds.width - labelBounds.width) < 1,
          uniformHeight: Array.from(list.children).every(item => Math.abs(item.getBoundingClientRect().height - rowBounds.height) < 1),
          fallback: list.children[23]?.querySelector('.meo-input-suggestion-detail')?.textContent,
          repeatedDetail: list.children[24]?.querySelector('.meo-input-suggestion-detail')?.textContent,
          label: label.textContent, detail: detail.textContent, labelTitle: label.title, detailTitle: detail.title,
          match: row.querySelector('.meo-suggestion-match')?.textContent,
          ellipsis: getComputedStyle(label).textOverflow === 'ellipsis' && getComputedStyle(detail).textOverflow === 'ellipsis',
          selectedTop: Math.abs(parseFloat(popup.style.getPropertyValue('--meo-suggestion-selected-top')) - (rowBounds.top - bounds.top - popup.clientTop)) < 1,
          markerCount: Array.from(list.querySelectorAll('.meo-suggestion-marker')).filter(marker => getComputedStyle(marker).visibility === 'visible').length,
          scrollbar: getComputedStyle(list, '::-webkit-scrollbar').width,
          track: getComputedStyle(list, '::-webkit-scrollbar-track').backgroundColor
        };
      });
      assert.equal(layout.clipped, true, kind + ': long names and paths stay inside the menu');
      assert.equal(layout.singleLine, true); assert.equal(layout.ellipsis, true); assert.equal(layout.selectedTop, true); assert.equal(layout.markerCount, 1);
      assert.equal(layout.twoLines, links, kind + ': only document and path candidates use two aligned lines');
      assert.equal(layout.uniformHeight, true, kind + ': row geometry remains stable for viewport clipping and scrolling');
      if (links) { assert.equal(layout.fallback, candidates[23].insert); assert.equal(layout.repeatedDetail, candidates[24].detail); }
      assert.equal(layout.scrollbar, '6px'); assert.equal(layout.track, 'rgba(0, 0, 0, 0)');
      assert.equal(layout.match?.toLowerCase(), kind === 'headings' ? 'shared' : kind === 'emoji' ? 's' : 'note');
      if (kind === 'headings') assert.equal(layout.detail, '#shared-title', 'duplicate headings expose their canonical anchors');
      else if (kind === 'emoji') { assert.equal(layout.label, ':smile:'); assert.equal(layout.detail, '😄'); }
      else { assert.equal(layout.labelTitle, candidates[0].label); assert.equal(layout.detailTitle, candidates[0].detail); }
      await page.keyboard.press('ArrowDown'); await settleSuggestions();
      assert.equal(await page.$eval('.meo-input-suggestions', popup => popup.querySelector('[aria-selected="true"]') === popup.querySelectorAll('[role="option"]')[1]), true);
      if (kind !== 'emoji') {
        const rowHeight = await page.$eval('.meo-input-suggestion', row => row.getBoundingClientRect().height);
        for (let index = 0; index < 14; index++) await page.keyboard.press('ArrowDown');
        const scrollTop = await page.$eval('.meo-suggestion-list', list => list.scrollTop);
        assert.ok(scrollTop > 0, kind + ': keyboard navigation reaches the next page');
        await page.keyboard.press('ArrowUp');
        assert.equal(await page.$eval('.meo-suggestion-list', list => list.scrollTop), scrollTop, kind + ': navigation inside the viewport does not pin selection to the bottom');
        assert.ok(rowHeight > 0);
      }
      await page.mouse.move(0, 0); await page.hover('.meo-input-suggestion:nth-child(2)');
      assert.equal(await page.$eval('.meo-input-suggestions', popup => popup.querySelector('[aria-selected="true"]') === popup.querySelectorAll('[role="option"]')[1]), true, kind + ': pointer uses the same selected-row state');
      await page.click('.meo-input-suggestion:nth-child(2)');
      const inserted = kind === 'documents' ? '[[docs/1/Note with space' : kind === 'paths' ? '[Go](docs/1/Note%20with%20space.md' : kind === 'headings' ? repeatedHeadings + '[Go](#shared-title-2' : '✨';
      await waitText(inserted);
      assert.equal(await page.evaluate(() => (window as any).editor.view.hasFocus), true, kind + ': accepting keeps document input connected');
    }
  }
  for (const kind of ['documents', 'emoji']) {
    await prepare('source', '', 0, 0, { pairMode: 'off', emoji: true }, kind === 'documents' ? candidates : undefined);
    await page.evaluate(() => { const view = (window as any).editor.view; view.contentDOM.style.fontSize = '29px'; view.requestMeasure(); });
    await page.keyboard.type(kind === 'documents' ? '[[Note' : ':s'); await openSuggestions(); await settleSuggestions();
    assert.equal(await page.$eval('.meo-input-suggestions', popup => {
      const list = popup.querySelector('.meo-suggestion-list')!, bounds = list.getBoundingClientRect();
      const rows = Array.from(list.children).map(row => row.getBoundingClientRect()).filter(row => row.bottom > bounds.top && row.top < bounds.bottom);
      const detail = popup.querySelector<HTMLElement>('.meo-input-suggestion-detail')!;
      return rows.every(row => row.top >= bounds.top - 1 && row.bottom <= bounds.bottom + 1) && (!popup.classList.contains('meo-narrow-suggestions') || detail.scrollWidth <= detail.clientWidth);
    }), true, kind + ': large editor fonts keep full rows and emoji glyphs visible');
  }
  await page.setViewport({ width: 320, height: 320 });
  await prepare('source', '', 0, 0, { pairMode: 'off' }, candidates); await page.keyboard.type('[[Note'); await openSuggestions(); await settleSuggestions();
  const narrow = await page.$eval('.meo-input-suggestions', popup => {
    const bounds = popup.getBoundingClientRect(), list = popup.querySelector('.meo-suggestion-list')!, visible = Array.from(list.children).map(row => row.getBoundingClientRect()).filter(row => row.bottom > list.getBoundingClientRect().top && row.top < list.getBoundingClientRect().bottom);
    return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom, wholeRows: visible.every(row => row.top >= list.getBoundingClientRect().top - 1 && row.bottom <= list.getBoundingClientRect().bottom + 1) };
  });
  assert.ok(narrow.left >= 0 && narrow.right <= 320 && narrow.top >= 0 && narrow.bottom <= 320 && narrow.wholeRows, 'narrow viewport keeps complete rows inside the shared menu');
  await page.keyboard.press('Escape'); await waitText('[[Note');
  assert.deepEqual(errors, []);
  console.log('Editing features: CSV/TSV/HTML codecs; IME, multi-selection, external origins, native table symbols/lists; paste contexts; commands and candidates passed');
} catch (error) {
  console.error('Failure state:', await page.evaluate(() => ({ text: (window as any).editor?.getText(), active: document.activeElement?.outerHTML.slice(0, 1000), suggestions: Array.from(document.querySelectorAll('.meo-input-suggestions'), e => e.outerHTML), focus: (window as any).editor?.view.hasFocus, composing: (window as any).editor?.view.compositionStarted })));
  throw error;
} finally { await closeTestBrowser(browser); }
