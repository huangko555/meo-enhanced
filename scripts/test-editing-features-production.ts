import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
import type { LinkCandidate } from '../src/protocol/editorServices';
import { detectSuggestionContext } from '../webview/src/application/inputSuggestions';
import { parseDelimitedTable, serializeDelimitedTable, splitMarkdownTableRow, parseMarkdownTable } from '../webview/src/application/delimitedTable';

const imePreferences = { ...defaultInputAssistance, emoji: true };
for (const [before, type, query, length] of [
  [":s'mi", 'emoji', 'smi', 5], [":smi'", 'emoji', 'smi', 5],
  ["[[no'te", 'documents', 'note', 5], ["[Go](no'te", 'paths', 'note', 5],
  ["[Go](O'Reilly#ti'tle", 'headings', 'title', 6]
] as const) {
  const context = detectSuggestionContext(before, imePreferences, true);
  assert.equal(context?.type, type, before + ': IME keeps the candidate context');
  assert.equal(context?.query, query, before + ': pinyin separators affect filtering only');
  assert.equal(context?.length, length, before + ': replacement retains the raw input span');
}
assert.equal(detectSuggestionContext("[Go](O'Reilly", imePreferences)?.query, "O'Reilly", 'literal apostrophes remain valid in file paths');
assert.equal(detectSuggestionContext("[Go](O'Reilly#ti'tle", imePreferences, true)?.target, "O'Reilly", 'IME filtering never rewrites the target document');
assert.equal(detectSuggestionContext(":s'mi", imePreferences), null, 'non-IME emoji names keep their original syntax');

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
    const mixedHtml = '<p>前文标记：这段文字应保留。</p><table><thead><tr><th>名称</th><th>数值</th></tr></thead><tbody><tr><td>测试项</td><td>1</td></tr></tbody></table><p>后文标记：这段文字也应保留。</p>';
    const mixedPlain = '前文标记：这段文字应保留。\n名称\t数值\n测试项\t1\n后文标记：这段文字也应保留。';
    const mixedMarkdown = '前文标记：这段文字应保留。\n\n| 名称 | 数值 |\n| --- | --- |\n| 测试项 | 1 |\n\n后文标记：这段文字也应保留。';
    await prepare(mode, '', 0, 0, { pasteHtml: true }); assert.equal(await paste(mixedPlain, mixedHtml), true);
    assert.equal(await text(), mixedMarkdown, mode + ': mixed HTML preserves prose around its table');
    assert.deepEqual(await page.evaluate(() => (window as any).editor.getHistoryDepth()), { undo: 1, redo: 0 });
    await page.evaluate(() => (window as any).editor.undo()); await waitText('');
    await page.evaluate(() => (window as any).editor.redo()); await waitText(mixedMarkdown);
    for (const preferences of [{ pasteHtml: false }, { convertTables: false }, { pasteHtml: false, convertTables: false }]) {
      await prepare(mode, '', 0, 0, preferences); await paste(mixedPlain, mixedHtml);
      assert.equal(await text(), mixedPlain, mode + ': disabled mixed-content conversion retains the whole plain payload');
    }
    const twoTablesHtml = '<div><p><strong>Before</strong> <a href="https://example.test/">link</a></p><table><caption>First table</caption><tr><th>A</th><th>B</th></tr><tr><td rowspan="2"><em>one</em><br>two</td><td>x|y</td></tr><tr><td>z</td></tr></table><p>Between</p><table><tr><th>C</th></tr><tr><td><code>code</code></td></tr></table><p>After</p></div>';
    const twoTablesMarkdown = '**Before** [link](https://example.test/)\n\nFirst table\n\n| A | B |\n| --- | --- |\n| *one*<br>two | x\\|y |\n|  | z |\n\nBetween\n\n| C |\n| --- |\n| `code` |\n\nAfter';
    await prepare(mode, '', 0, 0, { pasteHtml: true }); await paste('Before link\nA\tB\none\tx|y\n\tz\nBetween\nC\ncode\nAfter', twoTablesHtml);
    assert.equal(await text(), twoTablesMarkdown, mode + ': wrapped HTML retains both tables, intervening prose, caption, spans and inline formatting');
    if (mode === 'live') await page.waitForFunction(() => document.querySelectorAll('.meo-md-html-table-shell').length === 2);
    await prepare(mode, 'left right', 5, 5, { pasteHtml: true }); await paste(mixedPlain, mixedHtml);
    assert.equal(await text(), 'left ' + mixedMarkdown + 'right', mode + ': mixed paste preserves surrounding document text');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('left right');
    await prepare(mode, 'replace me', 0, 10, { pasteHtml: true }); await paste(mixedPlain, mixedHtml);
    assert.equal(await text(), mixedMarkdown, mode + ': mixed paste replaces exactly the selected text');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('replace me');
    await prepare(mode, '', 0, 0, { pasteHtml: true }); await paste('word\tv', '<table><tr><td><strong>word</strong></td><td>v</td></tr></table>'); assert.equal(await text(), '| **word** | v |\n| --- | --- |');
    await prepare(mode); await paste('word\tv', '<table><tr><td><strong>word</strong></td><td>v</td></tr></table>'); assert.equal(await text(), '| word | v |\n| --- | --- |', 'default paste drops HTML formatting while retaining table conversion');
    await prepare(mode, '', 0, 0, { pasteHtml: false }); await paste('word\tv', '<table><tr><td><strong>word</strong></td><td>v</td></tr></table>'); assert.equal(await text(), '| word | v |\n| --- | --- |');
    await prepare(mode, '```\n\n```', 4); await paste('A\tB', '<b>bold</b>'); assert.equal(await text(), '```\nA\tB\n```');
    await prepare(mode, 'word', 0, 4); assert.equal(await paste('https://example.test/a(b)'), true); assert.equal(await text(), '[word](https://example.test/a%28b%29)');
    await prepare(mode, 'word', 0, 4, { pasteUrl: false }); await paste('https://example.test'); assert.equal(await text(), 'https://example.test');
    await prepare(mode); await paste('bold and italic', '<p><strong>bold</strong> and <em>italic</em></p>'); assert.equal(await text(), 'bold and italic', 'HTML formatting is disabled by default');
    await prepare(mode, '', 0, 0, { pasteHtml: true }); assert.equal(await paste('bold', '<p><strong>bold</strong> and <em>italic</em></p>'), true); assert.equal(await text(), '**bold** and *italic*');
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
  await prepare('source', '', 0, 0, { pairMode: 'off' }, [{ label: 'note.md', insert: 'documents/note', detail: 'documents/note.md' }]); await page.keyboard.type('[[doc'); await page.waitForSelector('.meo-input-suggestions:not([hidden])', { timeout: 5000 }); await page.keyboard.press('Enter'); assert.equal(await text(), '[[documents/note');
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
      (window as any).EditingFeaturesHarness.applyUiTheme(appearance, true);
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
      const documents = kind === 'documents';
      assert.deepEqual(sharedSurface, slashSurface, [mode, appearance, language, kind].join(':') + ': shares slash shell and editor font');
      const expectedWidth = kind === 'emoji' ? 14.15 * 17 : kind === 'paths' ? 300
        : kind === 'headings' ? (language === 'en' ? 22.15 : 20.92) * 17 : 416;
      assert.ok(Math.abs(parseFloat(width) - expectedWidth) < 0.1, kind + ': width follows the candidate content and editor font');
      assert.equal(rowPadding, documents ? '5px 8px' : slashPadding);
      if (documents) assert.ok(rowHeight > slashHeight * 1.5, 'Wiki document rows reserve two full text lines');
      else assert.equal(rowHeight, slashHeight);
      const layout = await page.$eval('.meo-input-suggestions:not([hidden])', popup => {
        const list = popup.querySelector<HTMLElement>('.meo-suggestion-list')!, row = list.querySelector<HTMLElement>('[aria-selected="true"]')!;
        const label = row.querySelector<HTMLElement>('.meo-suggestion-label')!, detail = row.querySelector<HTMLElement>('.meo-input-suggestion-detail');
        const bounds = popup.getBoundingClientRect(), rowBounds = row.getBoundingClientRect();
        const labelBounds = label.getBoundingClientRect(), detailBounds = detail?.getBoundingClientRect();
        return {
          clipped: labelBounds.width > 20 && list.scrollWidth <= list.clientWidth + 1 && labelBounds.right <= list.getBoundingClientRect().right + 1 && (!detailBounds || detailBounds.width > 10 && detailBounds.right <= list.getBoundingClientRect().right + 1),
          singleLine: getComputedStyle(label).whiteSpace === 'nowrap' && (!detail || getComputedStyle(detail).whiteSpace === 'nowrap'),
          twoLines: !!detailBounds && detailBounds.top >= labelBounds.bottom - 1 && Math.abs(detailBounds.left - labelBounds.left) < 1 && Math.abs(detailBounds.width - labelBounds.width) < 1,
          uniformHeight: Array.from(list.children).every(item => Math.abs(item.getBoundingClientRect().height - rowBounds.height) < 1),
          fallback: list.children[23]?.querySelector('.meo-input-suggestion-detail')?.textContent,
          repeatedDetail: list.children[24]?.querySelector('.meo-input-suggestion-detail')?.textContent,
          label: label.textContent, detail: detail?.textContent, labelTitle: label.dataset.tooltip, detailTitle: detail?.dataset.tooltip,
          match: row.querySelector('.meo-suggestion-match')?.textContent,
          ellipsis: getComputedStyle(label).textOverflow === 'ellipsis' && (!detail || getComputedStyle(detail).textOverflow === 'ellipsis'),
          selectedTop: Math.abs(parseFloat(popup.style.getPropertyValue('--meo-suggestion-selected-top')) - (rowBounds.top - bounds.top - popup.clientTop)) < 1,
          markerCount: Array.from(list.querySelectorAll('.meo-suggestion-marker')).filter(marker => getComputedStyle(marker).visibility === 'visible').length,
          scrollbar: getComputedStyle(list, '::-webkit-scrollbar').width,
          track: getComputedStyle(list, '::-webkit-scrollbar-track').backgroundColor
        };
      });
      assert.equal(layout.clipped, true, kind + ': long names and paths stay inside the menu');
      assert.equal(layout.singleLine, true); assert.equal(layout.ellipsis, true); assert.equal(layout.selectedTop, true); assert.equal(layout.markerCount, 1);
      assert.equal(layout.twoLines, documents, kind + ': only Wiki document candidates use two aligned lines');
      assert.equal(layout.uniformHeight, true, kind + ': row geometry remains stable for viewport clipping and scrolling');
      if (documents) { assert.equal(layout.fallback, candidates[23].insert); assert.equal(layout.repeatedDetail, candidates[24].detail); }
      assert.equal(layout.scrollbar, '6px'); assert.equal(layout.track, 'rgba(0, 0, 0, 0)');
      assert.equal(layout.match?.toLowerCase(), kind === 'headings' ? 'shared' : kind === 'emoji' ? 's' : 'note');
      if (kind === 'headings') assert.equal(layout.detail, '#shared-title', 'duplicate headings expose their canonical anchors');
      else if (kind === 'emoji') { assert.equal(layout.label, ':smile:'); assert.equal(layout.detail, '😄'); }
      else { assert.equal(layout.labelTitle, candidates[0].label); assert.equal(layout.detailTitle, kind === 'paths' ? undefined : candidates[0].detail); }
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
      const inserted = kind === 'documents' ? '[[docs/1/Note with space.md' : kind === 'paths' ? '[Go](docs/1/Note%20with%20space.md' : kind === 'headings' ? repeatedHeadings + '[Go](#shared-title-2' : '✨';
      await waitText(inserted);
      assert.equal(await page.evaluate(() => (window as any).editor.view.hasFocus), true, kind + ': accepting keeps document input connected');
    }
  }
  const imePrefix = Array.from({ length: 35 }, (_, index) => 'Paragraph ' + index + '\n\n').join('');
  const imeTail = '\n\n' + imePrefix;
  for (const mode of ['source', 'live']) for (const kind of ['documents', 'paths', 'emoji']) for (const slashPreferAbove of [false, true]) {
    const label = [mode, kind, slashPreferAbove ? 'above' : 'below'].join(':');
    const query = kind === 'documents' ? '[[No' : kind === 'paths' ? '[Go](No' : ':s';
    const preedit = kind === 'emoji' ? "m'i" : "'te";
    const committed = kind === 'emoji' ? 'mi' : 'te';
    await prepare(mode, imePrefix + imeTail, imePrefix.length, imePrefix.length, { pairMode: 'off', emoji: true, slashPreferAbove }, kind === 'emoji' ? undefined : candidates);
    await page.evaluate(() => { (window as any).editor.view.dispatch({ scrollIntoView: true }); });
    await settleSuggestions();
    const placeCaret = async (top: number) => {
      await page.evaluate(top => {
        const editor = (window as any).editor, view = editor.view;
        // This fixture owns a new reading position, just like a user scroll.
        // Retire the preceding input's deferred caret reveal before placing it.
        editor.markViewportInteraction();
        view.dispatch({ effects: (window as any).EditingFeaturesHarness.EditorView.scrollIntoView(view.state.selection.main.head, {
          y: 'start', yMargin: top - view.scrollDOM.getBoundingClientRect().top
        }) });
      }, top);
      await settleSuggestions();
      await page.waitForFunction(top => {
        const view = (window as any).editor.view, coords = view.coordsAtPos(view.state.selection.main.head);
        return coords && Math.abs(coords.top - top) <= 1;
      }, { timeout: 2000 }, top);
      await settleSuggestions();
    };
    await placeCaret(360); await page.keyboard.type(query); await openSuggestions(); await settleSuggestions();
    const geometry = () => page.evaluate(() => {
      const view = (window as any).editor.view, caret = view.coordsAtPos(view.state.selection.main.head);
      const popup = document.querySelector<HTMLElement>('.meo-input-suggestions:not([hidden])')!, bounds = popup.getBoundingClientRect();
      const rows = Array.from(popup.querySelectorAll<HTMLElement>('[role="option"]'));
      return { top: bounds.top, bottom: bounds.bottom, caretTop: caret.top, caretBottom: caret.bottom, order: rows.map(row => Number(row.dataset.suggestionIndex)) };
    });
    const initial = await geometry();
    assert.ok(slashPreferAbove ? initial.bottom <= initial.caretTop - 3 : initial.top >= initial.caretBottom + 3, label + ': uses the shared preferred side');
    assert.equal(slashPreferAbove ? initial.order.at(-1) : initial.order[0], 0, label + ': best match stays at the preferred edge');
    await page.keyboard.press(slashPreferAbove ? 'ArrowUp' : 'ArrowDown');
    assert.equal(await page.$eval('.meo-input-suggestion[aria-selected="true"]', row => Number((row as HTMLElement).dataset.suggestionIndex)), 1, label + ': arrows follow visual order');
    await page.$eval('.cm-content', content => {
      content.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      content.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
    });
    await page.waitForFunction(() => !(window as any).editor.view.compositionStarted && document.querySelector('.meo-input-suggestions:not([hidden]) [aria-selected="true"]')?.getAttribute('aria-disabled') === 'false');
    await page.keyboard.press(slashPreferAbove ? 'ArrowUp' : 'ArrowDown');
    assert.equal(await page.$eval('.meo-input-suggestion[aria-selected="true"]', row => Number((row as HTMLElement).dataset.suggestionIndex)), 2, label + ': empty IME cycles preserve the highlighted selection');
    await page.keyboard.press(slashPreferAbove ? 'ArrowDown' : 'ArrowUp');
    await page.keyboard.press(slashPreferAbove ? 'ArrowDown' : 'ArrowUp');
    const ime = await page.createCDPSession();
    await ime.send('Input.imeSetComposition', { text: preedit, selectionStart: preedit.length, selectionEnd: preedit.length });
    await page.waitForFunction(() => {
      const rows = Array.from(document.querySelectorAll('.meo-input-suggestions:not([hidden]) [role="option"]'));
      return rows.length > 0 && rows.every(row => row.getAttribute('aria-disabled') === 'true');
    });
    if (kind === 'emoji') assert.equal(await page.$$eval('.meo-input-suggestion', rows => rows.length), 1, label + ': apostrophes filter to smile');
    const preeditText = await text();
    await page.click('.meo-input-suggestion[aria-selected="true"]');
    assert.equal(await text(), preeditText, label + ': clicking does not commit an IME candidate');
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', 'Tab', 'Escape']) {
      assert.equal(await page.evaluate(key => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true });
        document.activeElement!.dispatchEvent(event); return event.defaultPrevented;
      }, key), false, label + ': leaves ' + key + ' to the IME');
    }
    await ime.send('Input.insertText', { text: committed });
    await page.waitForFunction(() => document.querySelector('.meo-input-suggestions:not([hidden]) [aria-selected="true"]')?.getAttribute('aria-disabled') === 'false');
    await page.keyboard.press('Tab');
    const inserted = kind === 'emoji' ? '😄' : kind === 'documents' ? '[[docs/0/Note with space.md' : '[Go](docs/0/Note%20with%20space.md';
    await waitText(imePrefix + inserted + imeTail); await ime.detach();
    await prepare(mode, imePrefix + imeTail, imePrefix.length, imePrefix.length, { pairMode: 'off', emoji: true, slashPreferAbove }, kind === 'emoji' ? undefined : candidates);
    await page.evaluate(() => { (window as any).editor.view.dispatch({ scrollIntoView: true }); });
    await settleSuggestions(); await placeCaret(360); await page.keyboard.type(query); await openSuggestions();
    await placeCaret(slashPreferAbove ? 22 : 675);
    const fallback = await geometry();
    assert.ok(slashPreferAbove ? fallback.top >= fallback.caretBottom + 3 : fallback.bottom <= fallback.caretTop - 3, label + ': falls back when the preferred side has no room: ' + JSON.stringify(fallback));
    assert.deepEqual(fallback.order, initial.order, label + ': fallback does not reverse the list');
    await page.keyboard.press('Escape');
    assert.equal(await text(), imePrefix + query + imeTail, label + ': dismissal leaves literal input intact');
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
