import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
import { emptyMarkdownTable, parseMarkdownTable } from '../webview/src/application/delimitedTable';

for (const [cols, rows] of [[13, 12], [1, 9999], [5000, 1]]) {
  const generated = emptyMarkdownTable(cols, rows);
  assert.ok(generated, 'positive sizes can exceed ten while remaining within table capacity');
  const table = parseMarkdownTable(generated)!;
  assert.equal(table.cells.length, rows + 1, 'capacity counts the header');
  assert.ok(table.cells.every(row => row.length === cols));
}
for (const [cols, rows] of [[0, 2], [3, 0], [-1, 2], [1.5, 2], [1, 10000], [5001, 1], [Number.MAX_SAFE_INTEGER, 1], [Infinity, 2], [1, NaN]]) {
  assert.equal(emptyMarkdownTable(cols, rows), null, 'invalid or oversized values are rejected before allocating');
}

const build = await Bun.build({ entrypoints: ['scripts/test-editing-features-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser(), page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error' && message.text().includes('plugin crashed')) errors.push(message.text()) });
try {
  await page.setViewport({ width: 1000, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}:root{--vscode-panel-border:#666}</style><div id="app"></div>');
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
  const settlePosition = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
  const watchPopup = () => page.evaluate(() => {
    const g = window as any, popup = document.querySelector<HTMLElement>('.meo-input-suggestions')!;
    const sample = { hiddenFrames: 0, replaced: false, frame: 0 }; g.slashVisibility = sample;
    const tick = () => {
      if (popup.hidden) sample.hiddenFrames++;
      if (!popup.isConnected || document.querySelector('.meo-input-suggestions') !== popup) sample.replaced = true;
      sample.frame = requestAnimationFrame(tick);
    }; sample.frame = requestAnimationFrame(tick);
  });
  const popupContinuity = () => page.evaluate(() => {
    const sample = (window as any).slashVisibility; cancelAnimationFrame(sample.frame);
    return { hiddenFrames: sample.hiddenFrames, replaced: sample.replaced };
  });
  const placeAnchor = async (offset: number) => {
    await page.evaluate(() => (window as any).editor.view.dispatch({ scrollIntoView: true })); await settlePosition();
    await page.evaluate(offset => {
      const g = window as any, view = g.editor.view, coords = view.coordsAtPos(g.slashAnchor ?? view.state.selection.main.head);
      view.scrollDOM.scrollTop += coords.top - view.scrollDOM.getBoundingClientRect().top - offset;
    }, offset); await settlePosition();
  };
  const geometry = () => page.evaluate(() => {
    const g = window as any, view = g.editor.view, anchor = view.coordsAtPos(g.slashAnchor), popup = document.querySelector<HTMLElement>('.meo-input-suggestions')!, menu = popup.getBoundingClientRect(), scroller = view.scrollDOM.getBoundingClientRect();
    return { anchor: { top: anchor.top, bottom: anchor.bottom, left: anchor.left }, menu: { top: menu.top, bottom: menu.bottom, left: menu.left, right: menu.right, height: menu.height }, viewport: { top: scroller.top, bottom: scroller.bottom }, scrollTop: view.scrollDOM.scrollTop };
  });
  const completeRows = async (label: string) => {
    await settlePosition();
    // Native scroll limits round clientHeight/scrollTop; allow one CSS pixel at fractional edges.
    const layout = await page.evaluate(() => {
      const list = document.querySelector<HTMLElement>('.meo-slash-list')!, bounds = list.getBoundingClientRect();
      const rows = Array.from(list.children).map(row => {
        const box = row.getBoundingClientRect();
        return { command: (row as HTMLElement).dataset.command, selected: row.getAttribute('aria-selected') === 'true', top: box.top, bottom: box.bottom };
      });
      return { top: bounds.top, bottom: bounds.bottom, visible: rows.filter(row => row.bottom > bounds.top + 1 && row.top < bounds.bottom - 1), selected: rows.find(row => row.selected) };
    });
    assert.ok(layout.visible.length > 0 && layout.visible.every(row => row.top >= layout.top - 1 && row.bottom <= layout.bottom + 1), label + ': every visible command row fits completely: ' + JSON.stringify(layout));
    assert.ok(layout.selected && layout.selected.top >= layout.top - 1 && layout.selected.bottom <= layout.bottom + 1, label + ': the selected command remains fully visible: ' + JSON.stringify(layout));
  };
  for (const mode of ['source', 'live']) {
    await prepare(mode); await page.keyboard.type('/'); await open(); await completeRows(mode + ': preferred menu height'); await watchPopup();
    await page.keyboard.type('bold', { delay: 60 }); await open();
    assert.deepEqual(await popupContinuity(), { hiddenFrames: 0, replaced: false }, mode + ': filtering retains the visible popup without blank frames');
    await page.click('[data-command="bold"] .meo-suggestion-command'); await waitText('****');
    await page.keyboard.type('word'); await waitText('**word**');
    await prepare(mode); await page.keyboard.type('/table'); await open();
    for (const [character, display, disabled] of [['6', '/table6xN', 'true'], ['x', '/table6xN', 'true'], ['6', '/table6x6', 'false']]) {
      await page.keyboard.type(character); await open();
      assert.equal(await page.$eval('.meo-suggestion-command', row => row.textContent), display);
      assert.equal(await page.$eval('.meo-input-suggestion', row => row.getAttribute('aria-disabled')), disabled, mode + ': incomplete dimensions cannot execute');
    }
    await page.keyboard.press('Backspace'); await open();
    assert.equal(await page.$eval('.meo-input-suggestion', row => row.getAttribute('aria-disabled')), 'true', mode + ': deleting a column count returns to a pending suggestion');
    await page.keyboard.type('6'); await open();
    await page.keyboard.press('Enter');
    const sizedTable = await page.evaluate(() => (window as any).EditingFeaturesHarness.parseMarkdownTable((window as any).editor.getText()));
    assert.equal(sizedTable.cells.length, 7, mode + ': six data rows plus header');
    assert.ok(sizedTable.cells.every((row: string[]) => row.length === 6), mode + ': six columns');
    const longDocument = Array.from({ length: 120 }, (_, index) => 'Line ' + String(index).padStart(3, '0') + ' sample text').join('\n\n');
    const anchor = longDocument.indexOf('Line 060') + 8;
    await prepare(mode, longDocument, anchor); await page.evaluate(anchor => { (window as any).slashAnchor = anchor; }, anchor);
    await placeAnchor(90); await page.keyboard.type('/'); await open();
    const initial = await geometry();
    assert.ok(Math.abs(initial.menu.top - initial.anchor.bottom - 4) < 2, mode + ': initially opens below the slash');
    await page.evaluate(() => { (window as any).editor.view.scrollDOM.scrollTop -= 60; }); await settlePosition();
    const moved = await geometry();
    assert.ok(Math.abs(moved.menu.top - initial.menu.top - 60) < 2, mode + ': follows document scrolling');
    await page.keyboard.type('bold'); await open();
    assert.ok(Math.abs((await geometry()).menu.left - initial.menu.left) < 2, mode + ': follows the slash rather than the query caret');
    await placeAnchor(675);
    const above = await geometry(); assert.ok(above.menu.bottom <= above.anchor.top - 3, mode + ': flips above at the bottom edge');
    await placeAnchor(22);
    const below = await geometry(); assert.ok(below.menu.top >= below.anchor.bottom + 3, mode + ': flips below at the top edge');
    await page.evaluate(() => { const g = window as any, view = g.editor.view; view.scrollDOM.scrollTop += view.coordsAtPos(g.slashAnchor).bottom - view.scrollDOM.getBoundingClientRect().top + 40; });
    await closed();
    await page.evaluate(scrollTop => { (window as any).editor.view.scrollDOM.scrollTop = scrollTop; }, below.scrollTop); await settlePosition(); await closed();
    await page.keyboard.type('i'); await closed();
    assert.equal(await text(), longDocument.slice(0, anchor) + '/boldi' + longDocument.slice(anchor), mode + ': automatic dismissal preserves text and does not reopen on scrolling back or typing');
    await prepare(mode, longDocument, anchor); await page.evaluate(anchor => { (window as any).slashAnchor = anchor; }, anchor);
    await placeAnchor(150); await page.keyboard.type('/'); await open();
    const pageRows = await page.$eval('.meo-slash-list', list => Math.floor(list.clientHeight / list.firstElementChild!.getBoundingClientRect().height));
    const navigationRowHeight = await page.$eval('.meo-slash-suggestion', row => row.getBoundingClientRect().height);
    for (let index = 0; index < pageRows; index++) await page.keyboard.press('ArrowDown');
    await completeRows(mode + ': crosses the first page boundary');
    const firstScrolled = await page.$eval('.meo-slash-list', list => list.scrollTop);
    assert.ok(Math.abs(firstScrolled - navigationRowHeight) <= 1, mode + ': crossing the lower edge scrolls only one row');
    await page.keyboard.press('ArrowUp'); await completeRows(mode + ': moves up within the second page');
    assert.equal(await page.$eval('.meo-slash-list', list => list.scrollTop), firstScrolled, mode + ': moving up inside the viewport keeps the scroll');
    await page.keyboard.press('ArrowDown'); await completeRows(mode + ': moves back down within the second page');
    assert.equal(await page.$eval('.meo-slash-list', list => list.scrollTop), firstScrolled, mode + ': moving down inside the viewport keeps the scroll');
    for (let index = 0; index < pageRows; index++) await page.keyboard.press('ArrowUp');
    await completeRows(mode + ': crosses the upper edge');
    assert.equal(await page.$eval('.meo-slash-list', list => list.scrollTop), 0, mode + ': crossing the upper edge reveals the first row');
    await page.evaluate(() => { (window as any).slashSelectionList = document.querySelector('.meo-slash-list'); });
    await page.keyboard.press('ArrowUp'); await completeRows(mode + ': last command before shrinking');
    const tailScroll = await page.$eval('.meo-slash-list', list => list.scrollTop);
    await page.keyboard.press('ArrowUp'); await completeRows(mode + ': moves up within the visible tail');
    assert.equal(await page.$eval('.meo-slash-list', list => list.scrollTop), tailScroll, mode + ': moving within the visible list does not scroll');
    assert.equal(await page.evaluate(() => document.querySelector('.meo-slash-list') === (window as any).slashSelectionList), true, mode + ': keyboard selection retains the list DOM');
    await page.keyboard.press('ArrowDown'); await completeRows(mode + ': returns to the last visible command');
    assert.equal(await page.$eval('.meo-slash-list', list => list.scrollTop), tailScroll, mode + ': moving back within the visible list keeps its scroll');
    await page.setViewport({ width: 1000, height: 320 });
    await completeRows(mode + ': selected command after shrinking the viewport');
    await prepare(mode, longDocument, anchor); await page.evaluate(anchor => { (window as any).slashAnchor = anchor; }, anchor); await placeAnchor(150);
    await page.keyboard.type('/'); await open();
    const compact = await geometry();
    assert.ok(compact.menu.height < 170 && compact.menu.top >= compact.viewport.top && compact.menu.bottom <= compact.viewport.bottom, mode + ': shrinks within the visible editor when neither side fits');
    await completeRows(mode + ': constrained menu');
    await page.keyboard.press('ArrowUp'); await completeRows(mode + ': wraps to the last command');
    await page.keyboard.press('ArrowDown'); await completeRows(mode + ': wraps to the first command');
    const beforeListScroll = compact.menu.top;
    await page.evaluate(() => { document.querySelector('.meo-slash-list')!.scrollTop = 100; }); await settlePosition();
    assert.ok(Math.abs((await geometry()).menu.top - beforeListScroll) < 2, mode + ': scrolling the candidate list does not move the document anchor');
    await page.setViewport({ width: 800, height: 280 }); await settlePosition();
    const resized = await geometry();
    assert.ok(resized.menu.top >= resized.viewport.top && resized.menu.bottom <= resized.viewport.bottom && resized.menu.right <= 800, mode + ': remains inside the editor after a window resize');
    await page.keyboard.press('End'); await closed();
    await page.setViewport({ width: 1000, height: 320 });
    for (const fontSize of [23, 29]) for (const offset of [40, 260]) {
      await prepare(mode, longDocument, anchor);
      await page.evaluate(({ anchor, fontSize }) => {
        const g = window as any; g.slashAnchor = anchor;
        g.editor.view.contentDOM.style.fontSize = fontSize + 'px'; g.editor.view.requestMeasure();
      }, { anchor, fontSize });
      await settlePosition(); await placeAnchor(offset); await page.keyboard.type('/'); await open();
      const label = mode + ': ' + fontSize + 'px at ' + (offset === 40 ? 'top' : 'bottom');
      await completeRows(label);
      const rowHeight = await page.$eval('.meo-slash-suggestion', row => row.getBoundingClientRect().height);
      assert.ok(Math.abs(rowHeight - Math.round(rowHeight)) > 0.01, label + ': exercises fractional row heights');
      const placement = await geometry();
      assert.ok(offset === 40 ? placement.menu.top >= placement.anchor.bottom + 3 : placement.menu.bottom <= placement.anchor.top - 3, label + ': opens on the side with space');
      await page.keyboard.press('ArrowUp'); await completeRows(label + ': last command');
      const fontTailScroll = await page.$eval('.meo-slash-list', list => list.scrollTop);
      await page.keyboard.press('ArrowUp'); await completeRows(label + ': previous command');
      assert.equal(await page.$eval('.meo-slash-list', list => list.scrollTop), fontTailScroll, label + ': visible upward selection keeps its scroll');
      await page.keyboard.press('ArrowDown'); await completeRows(label + ': last command again');
      assert.equal(await page.$eval('.meo-slash-list', list => list.scrollTop), fontTailScroll, label + ': visible downward selection keeps its scroll');
      const listScroll = await page.$eval('.meo-slash-list', list => list.scrollTop);
      const documentScroll = placement.scrollTop;
      await page.evaluate(() => { window.dispatchEvent(new Event('resize')); }); await settlePosition();
      assert.equal(await page.$eval('.meo-slash-list', list => list.scrollTop), listScroll, label + ': repositioning preserves internal scroll');
      assert.equal((await geometry()).scrollTop, documentScroll, label + ': keyboard navigation does not scroll the document');
      await completeRows(label + ': after repositioning');
      await page.keyboard.press('ArrowDown'); await completeRows(label + ': first command again');
      await page.keyboard.press('Escape'); await closed();
    }
    await page.setViewport({ width: 1000, height: 720 });
    await page.evaluate(() => { delete (window as any).slashAnchor; });
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
    await ime.send('Input.imeSetComposition', { text: "bo'l", selectionStart: 4, selectionEnd: 4 });
    await page.waitForFunction(() => document.querySelectorAll('.meo-input-suggestion').length === 2 && document.querySelector('.meo-suggestion-match')?.textContent === 'bol');
    await ime.send('Input.insertText', { text: "bo'l" }); await open(); await page.keyboard.press('Enter'); await waitText('****');
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
    for (const invalid of [' ', '.', '-', '_', '中', '/', '’']) {
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
    await prepare(mode); await page.keyboard.type('/table'); await open();
    assert.equal(await page.$eval('.meo-suggestion-command', row => row.textContent), '/tableNxN', 'default table advertises its optional dimensions');
    await page.keyboard.press('Enter');
    await waitText('|  |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |');
    if (mode === 'live') await page.waitForFunction(() => document.activeElement instanceof HTMLTextAreaElement && document.activeElement.dataset.tableRow === '0');
    await page.keyboard.type('Header'); await waitText('| Header |  |  |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |');
    await prepare(mode); await page.keyboard.type('/table3x4'); await open();
    assert.equal(await page.$eval('.meo-suggestion-command', row => row.textContent), '/table3x4');
    assert.equal(await page.$eval('.meo-input-suggestion-detail', row => row.textContent), '3 data rows × 4 cols');
    await page.keyboard.press('Enter');
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
    for (const [cols, rows] of [[0, 2], [3, 0], [10000, 2], [2, 10000], [1.5, 2]]) {
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
    for (const query of ['table0x3', 'table2x', '3x0', 'table3', '100x100', '6', '6x', 'table10X', 'table100000000000000000000x2']) {
      await prepare(mode); await page.keyboard.type('/' + query); await open();
      assert.equal(await page.$eval('.meo-input-suggestion', row => row.getAttribute('aria-disabled')), 'true', query + ': pending or out-of-range sizes stay visible');
      await page.click('.meo-input-suggestion'); await waitText('/' + query); await open();
      await page.keyboard.press('Enter'); assert.ok((await text()).startsWith('/' + query + '\n'), query + ': incomplete or invalid dimensions never execute a default'); await closed();
    }
    for (const query of ['table6q', 'table6xx6', 'tablex6', 'table6x6x']) {
      await prepare(mode); await page.keyboard.type('/' + query); await closed(); await waitText('/' + query);
    }
    for (const query of ['table10x10', 'table10X10', 'table10×10', '6x6', 'table06x04', 'table12x13', '11X2']) {
      await prepare(mode); await page.keyboard.type('/' + query); await open();
      await page.keyboard.press('Tab');
      const table = await page.evaluate(() => (window as any).EditingFeaturesHarness.parseMarkdownTable((window as any).editor.getText()));
      const [rows, cols] = query.replace(/^table/, '').split(/[xX×]/).map(Number);
      assert.equal(table.cells.length, rows + 1, query + ': data rows plus header');
      assert.ok(table.cells.every((row: string[]) => row.length === cols), query + ': requested columns');
    }
    await prepare(mode); await page.keyboard.type('/table1x0'); await open();
    await page.keyboard.press('Backspace'); await page.keyboard.type('2'); await open(); await page.keyboard.press('Enter');
    await waitText('|  |  |\n| --- | --- |\n|  |  |');
    await prepare(mode, '', 0, { slash: false }); await page.keyboard.type('/table6x'); await page.keyboard.press('Tab');
    const literalTab = await text();
    assert.ok(literalTab.includes('/table6x'), mode + ': ordinary Tab preserves the literal input');
    await prepare(mode); await page.keyboard.type('/table6x'); await open(); await page.keyboard.press('Tab'); await waitText(literalTab);
    await prepare(mode); await page.keyboard.type('/table6x'); await open(); await page.keyboard.press('Escape'); await closed(); await waitText('/table6x');

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
  await prepareCell(); await page.keyboard.type('/'); await open(); await watchPopup();
  await page.keyboard.type('bold', { delay: 60 }); await open();
  await page.waitForFunction(() => (window as any).editor.getText().includes('/bold'));
  await settlePosition();
  assert.deepEqual(await popupContinuity(), { hiddenFrames: 0, replaced: false }, 'native filtering and automatic cell commits keep the popup visible');
  await prepareCell(); await page.keyboard.type('/b'); await open();
  const pressedBounds = await page.$eval('[data-command="bold"]', element => {
    (window as any).pressedSlashCandidate = element;
    const rect = element.getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(pressedBounds.x, pressedBounds.y); await page.mouse.down();
  await page.waitForFunction(() => (window as any).editor.getText().includes('/b')); await settlePosition();
  assert.equal(await page.evaluate(() => (window as any).pressedSlashCandidate === document.querySelector('[data-command="bold"]')), true, 'automatic commits retain the candidate between pointerdown and click');
  await page.mouse.up(); await page.keyboard.type('held');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), '**held**', 'a click held across the cell commit executes and retains the caret');
  for (const [command, expected] of [
    ['bold', '**word**'], ['italic', '*word*'], ['boldItalic', '***word***'], ['strike', '~~word~~'],
    ['highlight', '==word=='], ['subscript', '~word~'], ['superscript', '^word^'], ['inlineCode', '`word`'], ['inlineMath', '$word$'], ['lineBreak', '<br>\nword'],
    ['link', '[word](url)'], ['linkTitle', '[word](url "title")'], ['autoLink', '<word>'], ['image', '![word](url)'], ['imageTitle', '![word](url "title")']
  ]) {
    await prepareCell(); await page.keyboard.type('/' + (command === 'bold' ? '' : command.toLowerCase())); await open();
    await page.click(`[data-command="${command}"] .meo-suggestion-command`);
    assert.equal(await page.evaluate(() => document.activeElement instanceof HTMLTextAreaElement && document.activeElement.isConnected), true, command + ': mouse selection retains the editable cell');
    await page.keyboard.type('word');
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), expected, command + ': subsequent typing reaches the command caret/field');
    await page.evaluate(() => (window as any).editor.getTextForSave());
    assert.equal(await page.evaluate(() => document.activeElement instanceof HTMLTextAreaElement), true, command + ': committing after the mouse action retains focus');
  }
  await prepareCell(); await page.keyboard.type('/linktitle'); await open(); await page.click('[data-command="linkTitle"]');
  for (const value of ['Label', 'target', 'Hint']) { await page.keyboard.type(value); await page.keyboard.press('Tab'); }
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), '[Label](target "Hint")', 'mouse-selected templates retain Tab navigation');
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
  for (const query of ['table', 'table6', 'table6x', 'table6x6']) {
    await prepareCell(); await page.keyboard.type('/' + query); await closed();
  }
  assert.equal(await page.evaluate(() => (window as any).editor.executeCommand('insertTable')), false);
  await prepareCell(); await page.keyboard.type('/'); await open();
  const nativeIme = await page.createCDPSession();
  await nativeIme.send('Input.imeSetComposition', { text: 'bold', selectionStart: 4, selectionEnd: 4 });
  await page.waitForFunction(() => document.querySelectorAll('.meo-input-suggestion').length === 2);
  for (const key of [' ', 'Enter', 'ArrowDown', 'Escape']) assert.equal(await page.evaluate(key => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true }); document.activeElement!.dispatchEvent(event); return event.defaultPrevented;
  }, key), false, 'native IME owns ' + key);
  await nativeIme.send('Input.imeSetComposition', { text: "bo'l", selectionStart: 4, selectionEnd: 4 });
  await page.waitForFunction(() => document.querySelector('.meo-suggestion-match')?.textContent === 'bol');
  await nativeIme.send('Input.insertText', { text: "bo'l" }); await open(); await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).value), '****'); await nativeIme.detach();
  const prefix = Array.from({ length: 60 }, (_, index) => 'Before ' + index).join('\n\n') + '\n\n';
  await prepare('live', prefix + table + '\n\n' + prefix, prefix.length);
  await page.evaluate(() => (window as any).editor.view.dispatch({ scrollIntoView: true })); await settlePosition();
  await page.waitForSelector('tbody textarea');
  await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.focus(); input.scrollIntoView({ block: 'center' }); input.setSelectionRange(0, 0); });
  await settlePosition(); await page.keyboard.type('/bold'); await open();
  // Take the scroll baseline after the native commit's viewport restoration has settled.
  await page.waitForFunction(() => (window as any).editor.view.state.doc.toString().includes('| /bold | x |'));
  await settlePosition();
  const cellTop = () => page.$eval('.meo-input-suggestions', element => element.getBoundingClientRect().top);
  const originalCellTop = await cellTop();
  const cellBeforeScroll = await page.evaluate(() => ({ input: document.activeElement!.getBoundingClientRect().top, scroll: (window as any).editor.view.scrollDOM.scrollTop }));
  await page.evaluate(() => { (window as any).editor.view.scrollDOM.scrollTop -= 40; }); await settlePosition();
  const cellAfterScroll = await page.evaluate(() => ({ input: document.activeElement!.getBoundingClientRect().top, scroll: (window as any).editor.view.scrollDOM.scrollTop, popup: document.querySelector('.meo-input-suggestions')!.getBoundingClientRect().top }));
  assert.ok(Math.abs(cellAfterScroll.input - cellBeforeScroll.input - 40) < 2, 'the native cell actually moves with the document scroll');
  assert.ok(Math.abs(cellAfterScroll.popup - originalCellTop - 40) < 2, 'native cell popup follows document scrolling: ' + JSON.stringify({ before: cellBeforeScroll, after: cellAfterScroll, originalCellTop }));
  await page.evaluate(() => { const input = document.activeElement as HTMLTextAreaElement, view = (window as any).editor.view; view.scrollDOM.scrollTop += input.getBoundingClientRect().bottom - view.scrollDOM.getBoundingClientRect().top + 40; });
  await closed();
  await page.evaluate(() => { (document.activeElement as HTMLTextAreaElement).scrollIntoView({ block: 'center' }); }); await settlePosition(); await closed();
  await page.setViewport({ width: 1000, height: 320 });
  await prepareCell(); await page.keyboard.type('/'); await open(); await completeRows('native cell: constrained menu');
  await page.keyboard.press('ArrowUp'); await completeRows('native cell: last command');
  const nativeTailScroll = await page.$eval('.meo-slash-list', list => list.scrollTop);
  await page.keyboard.press('ArrowUp'); await completeRows('native cell: previous visible command');
  assert.equal(await page.$eval('.meo-slash-list', list => list.scrollTop), nativeTailScroll, 'native cell: visible selection keeps internal scroll');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await completeRows('native cell: first command');
  await page.keyboard.press('Escape'); await closed();
  await page.setViewport({ width: 1000, height: 720 });
  const wideTable = ['A', '---', 'x'].map(value => '| ' + Array(10).fill(value).join(' | ') + ' |').join('\n');
  await prepare('live', wideTable, 0); await page.waitForSelector('tbody textarea');
  await page.evaluate(() => {
    const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!, wrap = input.closest<HTMLElement>('.meo-md-html-table-wrap')!;
    wrap.style.width = '150px'; input.focus(); input.setSelectionRange(0, 0);
  }); await settlePosition(); await page.keyboard.type('/b'); await open();
  assert.ok(await page.$eval('.meo-input-suggestions', popup => popup.getBoundingClientRect().width > 150), 'native menus can extend beyond a narrow cell');
  await page.evaluate(() => {
    const wrap = document.querySelector<HTMLElement>('.meo-md-html-table-wrap')!; wrap.scrollLeft = wrap.scrollWidth;
    if (!wrap.scrollLeft) throw new Error('The horizontal clipping fixture must actually overflow');
  }); await closed();
  await page.evaluate(() => { document.querySelector('.meo-md-html-table-wrap')!.scrollLeft = 0; }); await settlePosition(); await closed();
  await prepareCell('word '.repeat(50));
  await page.evaluate(() => {
    const input = document.activeElement as HTMLTextAreaElement;
    input.style.height = '32px'; input.style.maxHeight = '32px'; input.style.overflowY = 'auto';
  }); await page.keyboard.type('/b'); await open();
  await page.evaluate(() => { (document.activeElement as HTMLTextAreaElement).scrollTop = 0; }); await closed();
  assert.deepEqual(errors, []);
  console.log('Slash commands production contracts passed');
} catch (error) {
  console.error('Slash failure:', await page.evaluate(() => ({ text: (window as any).editor?.getText(), active: document.activeElement?.outerHTML.slice(0, 300), popup: document.querySelector('.meo-input-suggestions')?.outerHTML })));
  throw error;
} finally { await closeTestBrowser(browser); }
