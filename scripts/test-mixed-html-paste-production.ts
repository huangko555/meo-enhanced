import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';

const build = await Bun.build({ entrypoints: ['scripts/test-editing-features-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  await page.setViewport({ width: 1000, height: 700 });
  await page.setContent('<!doctype html><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const prepare = async (mode: string, text = '', from = text.length, to = from, preferences = {}) => {
    await page.evaluate(({ mode, text, from, to, preferences }) => {
      const global = window as any;
      global.editor?.destroy();
      global.EditingFeaturesHarness.applyUiTheme(mode === 'live' ? 'light' : 'dark', true);
      global.editor = global.EditingFeaturesHarness.createEditor({ parent: document.querySelector('#app')!,
        text, initialMode: mode, uiLanguage: mode === 'live' ? 'zh-CN' : 'en', initialInputAssistance: preferences, onApplyChanges() {} });
      global.editor.view.dispatch({ selection: { anchor: from, head: to } }); global.editor.view.focus();
    }, { mode, text, from, to, preferences: { ...defaultInputAssistance, ...preferences } });
  };
  const paste = async (plain: string, html: string, custom = '') => {
    await page.evaluate(({ plain, html, custom }) => {
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', plain);
      clipboard.setData('text/html', html);
      if (custom) clipboard.setData('application/x-meo-table-cells+json', custom);
      (window as any).editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
    }, { plain, html, custom });
    return page.evaluate(() => (window as any).editor.getText());
  };
  const undoRedo = async (before: string, after: string) => {
    assert.deepEqual(await page.evaluate(() => (window as any).editor.getHistoryDepth()), { undo: 1, redo: 0 });
    await page.evaluate(() => (window as any).editor.undo());
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), before);
    await page.evaluate(() => (window as any).editor.redo());
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), after);
  };
  const trigger = '.meo-paste-options-trigger';
  const option = (mode: string) => '.meo-paste-options-menu [data-paste-mode="' + mode + '"]';
  const assertMenuExpanded = async (expanded: boolean, label: string) => {
    assert.deepEqual(await page.$eval(trigger, button => {
      const arrow = button.querySelector('svg:last-child')!;
      const transform = getComputedStyle(arrow).transform;
      const menu = button.parentElement!.querySelector<HTMLElement>('[role="menu"]')!;
      return {
        expanded: button.getAttribute('aria-expanded'),
        visible: getComputedStyle(menu).display !== 'none',
        direction: new DOMMatrixReadOnly(transform === 'none' ? undefined : transform).a
      };
    }), { expanded: String(expanded), visible: expanded, direction: expanded ? -1 : 1 }, label);
  };
  const choose = async (mode: string) => {
    await page.waitForSelector(trigger, { visible: true });
    await page.click(trigger);
    await page.waitForSelector(option(mode), { visible: true });
    const pasted = await page.evaluate(() => (window as any).editor.getText());
    await page.hover(option(mode));
    assert.equal(await page.$eval(option(mode), element => element === document.activeElement), true, 'hover moves the menu highlight');
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), pasted, 'hover does not apply a paste option');
    await page.click(option(mode));
    return page.evaluate(() => (window as any).editor.getText());
  };
  const table = '<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>';
  const markdown = '| A | B |\n| --- | --- |\n| 1 | 2 |';
  const mixedHtml = '<p>前文标记：这段文字应保留。</p>' + table + '<p>后文标记：这段文字也应保留。</p>';
  const mixedPlain = '前文标记：这段文字应保留。\nA\tB\n1\t2\n后文标记：这段文字也应保留。';
  const mixedMarkdown = '前文标记：这段文字应保留。\n\n' + markdown + '\n\n后文标记：这段文字也应保留。';
  for (const mode of ['source', 'live']) {
    await page.setViewport({ width: mode === 'source' ? 480 : 1000, height: 700 });
    await prepare(mode, '', 0, 0, { convertTables: false, pasteHtml: false });
    assert.equal(await paste(mixedPlain, mixedHtml), mixedPlain);
    assert.equal(await choose('formatted'), mixedMarkdown, mode + ': one paste overrides both defaults');
    await undoRedo('', mixedMarkdown);

    const originalMarkdown = '# Heading with **bold**\n\n- [x] A [link](https://example.com)\n- Use C#\n\n' + markdown;
    const textOnly = 'Heading with bold\n\nA link\nUse C#\n\nA\tB\n1\t2';
    await prepare(mode);
    await page.keyboard.down('Control');
    assert.equal(await paste(originalMarkdown, ''), originalMarkdown);
    await page.keyboard.up('Control');
    await page.waitForSelector(trigger, { visible: true });
    assert.equal(await page.$eval(trigger, element => element.getAttribute('aria-expanded')), 'false', mode + ': releasing the paste modifier does not open the menu');
    assert.deepEqual(await page.$eval(trigger, element => ({
      text: Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent).join(''),
      icons: element.querySelectorAll('svg').length,
      border: getComputedStyle(element).borderTopWidth,
      monochrome: [...element.querySelectorAll('svg')].every(icon => getComputedStyle(icon).color === getComputedStyle(element).color)
    })), { text: 'Ctrl', icons: 2, border: '1px', monochrome: true }, mode + ': the compact button has a border and neutral icons');
    await page.mouse.move(0, 0);
    await page.keyboard.press('Control');
    await page.waitForSelector(option('plain'), { visible: true });
    await page.keyboard.press('Control');
    await assertMenuExpanded(false, mode + ': a second Ctrl collapses the menu and resets the arrow');
    assert.equal(await page.evaluate(() => document.activeElement === (window as any).editor.view.contentDOM), true,
      mode + ': collapsing with Ctrl returns focus to the editor');
    await page.click(trigger);
    await assertMenuExpanded(true, mode + ': clicking opens the menu and flips the arrow');
    await page.click(trigger);
    await assertMenuExpanded(false, mode + ': clicking again collapses the menu and resets the arrow');
    await page.keyboard.press('Control');
    await assertMenuExpanded(true, mode + ': Ctrl reopens the menu after a click');
    assert.equal(await page.$eval(option('plain'), element => element.textContent), mode === 'live' ? '仅保留文字' : 'Keep text only');
    if (mode === 'live') {
      await page.waitForSelector('.meo-md-html-table', { visible: true });
      const geometry = await page.evaluate(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const table = document.querySelector('.meo-md-html-table')!.getBoundingClientRect();
        const button = document.querySelector('.meo-paste-options-trigger')!.getBoundingClientRect();
        const view = (window as any).editor.view;
        const block = view.lineBlockAt(view.state.selection.main.head);
        return { left: table.left, right: table.right, button: button.left, block: block.type };
      });
      assert.ok(geometry.button >= geometry.left - 8 && geometry.button < geometry.right,
        'a rendered table anchors the menu near its visible content: ' + JSON.stringify(geometry));
    }
    if (process.argv.includes('--capture')) {
      mkdirSync('.local/input-presentation', { recursive: true });
      const appearance = mode === 'live' ? 'light-zh' : 'dark-en';
      await page.screenshot({ path: '.local/input-presentation/paste-options-' + appearance + '.png' });
    }
    assert.equal(await page.$eval(option('formatted'), element => element === document.activeElement), true);
    await page.hover(option('formatted'));
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.$eval(option('plain'), element => element === document.activeElement), true);
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), originalMarkdown, mode + ': moving the highlight does not apply the option');
    const rows = await page.$eval('.meo-paste-options-menu', menu => {
      let rowTop = menu.getBoundingClientRect().top + menu.clientTop;
      return [...menu.querySelectorAll('button')].map(element => {
        const bounds = element.getBoundingClientRect();
        const fillsRow = Math.abs(bounds.top - rowTop) < 1 && Math.abs(bounds.width - menu.clientWidth) < 1;
        rowTop = bounds.bottom;
        return {
          background: getComputedStyle(element).backgroundColor,
          before: getComputedStyle(element, '::before').content,
          decoration: getComputedStyle(element).textDecorationLine,
          fillsRow
        };
      });
    });
    assert.equal(rows[0].background, 'rgba(0, 0, 0, 0)', mode + ': the previous option is clear even with the pointer still over it');
    assert.deepEqual(rows.map(row => row.before), ['none', 'none'], mode + ': choices have no checkmarks');
    assert.deepEqual(rows.map(row => row.decoration), ['none', 'none'], mode + ': focusing an option does not underline the label');
    assert.ok(rows.every(row => row.fillsRow), mode + ': both choices fill the panel edge to edge');
    assert.notEqual(rows[1].background, 'rgba(0, 0, 0, 0)', mode + ': only the focused option is highlighted');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), textOnly, mode + ': Markdown syntax and table structure are removed');
    await undoRedo('', textOnly);

    await prepare(mode, 'label', 0, 5);
    assert.equal(await paste('https://example.com', ''), '[label](https://example.com)');
    assert.equal(await choose('plain'), 'https://example.com', mode + ': text choice replaces the auto-generated link');
    await undoRedo('label', 'https://example.com');

    const next = 'https://new.example/a_(b)';
    const anchor = '<a href="' + next + '">New page</a>';
    for (const [original, selected, expected] of [
      ['[docs](https://old.example/page)', 'https://old.example/page', '[docs](' + next + ')'],
      ['![logo](https://old.example/logo.png "Title")', 'https://old.example/logo.png', '![logo](' + next + ' "Title")'],
      ['<https://old.example>', 'https://old.example', '<' + next + '>'],
      ['[docs][id]\n\n[id]: https://old.example', 'https://old.example', '[docs][id]\n\n[id]: ' + next],
      ['[docs](https://old.example)', 'docs', '[' + next + '](https://old.example)'],
      ['[docs][id]', 'docs', '[' + next + '][id]'],
      ['[docs]\n\n[docs]: https://old.example', 'docs', '[' + next + '][docs]\n\n[docs]: https://old.example'],
      ['![logo](logo.png)', 'logo', '![' + next + '](logo.png)'],
      ['[docs]()', '', '[docs](' + next + ')']
    ] as const) for (const html of ['', anchor]) for (const pasteUrl of [true, false]) {
      const from = selected ? original.indexOf(selected) : original.length - 1;
      await prepare(mode, original, from, from + selected.length, { pasteUrl });
      assert.equal(await paste(next, html), expected, `${mode}: no link inside ${original}, ${html ? 'rich' : 'plain'} URL, pasteUrl ${pasteUrl}`);
      await undoRedo(original, expected);
    }
    for (const [original, selected] of [
      ['[docs](https://old.example)', 'https://old.example'],
      ['[docs](<https://old.example>)', 'https://old.example'],
      ['[docs](<https://old.example>)', '<https://old.example>']
    ] as const) {
      const from = original.indexOf(selected);
      const expected = '[docs](<https://new.example/a)b>)';
      await prepare(mode, original, from, from + selected.length);
      assert.equal(await paste('https://new.example/a)b', ''), expected, mode + ': a literal parenthesis stays in the destination');
      await undoRedo(original, expected);
    }
    const link = '[word](https://new.example/a_%28b%29)';
    for (const [before, after] of [
      ['read ', ' today'], ['see [', '] here'], ['[a](https://a.example)', ''], ['', '[a](https://a.example)'],
      ['[^1]: ', ''], ['- [ ] ', ' done'], ['', ' <https://a.example>']
    ] as const) {
      const original = before + 'word' + after;
      await prepare(mode, original, before.length, before.length + 4);
      assert.equal(await paste(next, ''), before + link + after, `${mode}: the selected word in ${original} becomes the label`);
      await undoRedo(original, before + link + after);
    }

    await prepare(mode);
    const formatted = '# Heading\n\n**Word**\n\n| A | B |\n| --- | --- |\n| **1** | 2 |';
    assert.equal(await paste('Heading\nWord\nA\tB\n1\t2',
      '<h1>Heading</h1><p><b>Word</b></p>' + table.replace('<td>1', '<td><b>1</b>')), formatted, mode + ': regular paste keeps supported formatting by default');
    assert.equal(await choose('plain'), 'Heading\n\nWord\n\nA\tB\n1\t2', mode + ': rich clipboard table and prose become text');

    await prepare(mode);
    assert.equal(await paste('A\tB\n1\t2', '<p>Unstructured HTML</p>'), markdown);
    assert.equal(await choose('plain'), 'A\tB\n1\t2', mode + ': recognized spreadsheet text keeps every row and column');

    await prepare(mode, '', 0, 0, { showPasteOptions: false, pasteHtml: true });
    assert.equal(await paste('bold', '<b>bold</b>'), '**bold**');
    assert.equal(await page.$(trigger), null, mode + ': disabling the menu leaves ordinary formatting enabled');
    await prepare(mode, '', 0, 0, { pasteHtml: false });
    assert.equal(await paste('C# and a * b', ''), 'C# and a * b');
    assert.equal(await page.$(trigger), null, mode + ': ordinary symbols have no alternative paste result');
    assert.equal(await paste('bold', '<b>bold</b>'), 'C# and a * bbold');
    await page.waitForSelector(trigger, { visible: true });
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.$(trigger), null, mode + ': moving the caret retires the action');
    assert.equal(await paste('word', '<strong>word</strong>'), 'C# and a * bbolwordd');
    await page.waitForSelector(trigger, { visible: true });
    await page.keyboard.press('Control');
    await page.waitForSelector(option('plain'), { visible: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.$(trigger), null, mode + ': Escape retires the action');
    assert.equal(await page.evaluate(() => document.activeElement === (window as any).editor.view.contentDOM), true);

    for (const pasteHtml of [false, true]) for (const convertTables of [false, true]) {
      await prepare(mode, '', 0, 0, { pasteHtml, convertTables });
      const expected = pasteHtml && convertTables ? mixedMarkdown : mixedPlain;
      assert.equal(await paste(mixedPlain, mixedHtml), expected, `${mode}: mixed fragment and conversion switches`);
      await undoRedo('', expected);
    }
    for (const [html, original, position, expected] of [
      ['<p>Before</p>' + table, 'suffix', 0, 'Before\n\n' + markdown + '\n\nsuffix'],
      [table + '<p>After</p>', 'prefix', 6, 'prefix\n\n' + markdown + '\n\nAfter'],
      ['<div><span> </span><table><caption>Caption</caption>' + table.slice(7) + '</div>', 'prefix', 6, 'prefix\n\nCaption\n\n' + markdown],
      ['<blockquote>' + table + '</blockquote>', 'prefixsuffix', 6, 'prefix\n\n' + markdown.split('\n').map(line => '> ' + line).join('\n') + '\n\nsuffix'],
      ['<h2>Heading</h2>', 'prefixsuffix', 6, 'prefix\n\n## Heading\n\nsuffix'],
      ['<pre>code</pre>', 'prefixsuffix', 6, 'prefix\n\n```\ncode\n```\n\nsuffix'],
      ['<ul><li>one</li><li>two</li></ul>', 'prefixsuffix', 6, 'prefix\n\n- one\n- two\n\nsuffix'],
      ['<hr>', 'prefixsuffix', 6, 'prefix\n\n---\n\nsuffix'],
      ['<p><strong>inline</strong></p>', 'prefixsuffix', 6, 'prefix**inline**suffix']
    ] as const) {
      await prepare(mode, original, position, position, { pasteHtml: true });
      assert.equal(await paste('plain fallback', html), expected, `${mode}: block edges for ${html.slice(0, 30)}`);
      await undoRedo(original, expected);
    }
    const code = 'import os\n\n\ndef a():  \n \t\n\n    return 1';
    for (const [html, expected] of [
      ['<p>Before</p><pre><code>' + code + '\n</code></pre><p>After</p>', 'Before\n\n```\n' + code + '\n```\n\nAfter'],
      ['<pre>\n\n\na\n\n\n\n</pre>', '```\n\n\na\n\n\n\n```'],
      ['<ul><li>Step<pre>a  \n\n\n \nb</pre></li></ul>', '- Step\n\n  ```\n  a  \n\n\n   \n  b\n  ```'],
      ['<blockquote><pre>a  \n\n\nb</pre></blockquote>', '> ```\n> a  \n>\n>\n> b\n> ```'],
      ['<p>one \u00000\u0000</p><pre>x\u0000\n\n\n\u0000y</pre>', 'one 0\n\n```\nx\n\n\ny\n```'],
      ['<p>one  </p>\n\n\n\n<p>two</p>', 'one\n\ntwo']
    ] as const) {
      await prepare(mode);
      assert.equal(await paste('plain fallback', html), expected, `${mode}: code and prose whitespace for ${JSON.stringify(html)}`);
      await undoRedo('', expected);
    }
    for (const [html, expected] of [
      ['<ul><li>Alpha<ul><li>Beta</li></ul></li><li>Gamma</li></ul>', '- Alpha\n\n  - Beta\n- Gamma'],
      ['<ul><li>Alpha</li><ul><li>Beta</li></ul><li>Gamma</li></ul>', '- Alpha\n\n  - Beta\n- Gamma'],
      ['<ol start="3"><li>Alpha</li><ol><li>Beta</li><li>More</li></ol><li>Gamma</li></ol>', '3. Alpha\n\n   1. Beta\n   2. More\n4. Gamma'],
      ['<ul><li>Alpha</li><ol><li>Beta</li><ul><li>Deep</li></ul></ol><ul><li>Second</li></ul></ul>', '- Alpha\n\n  1. Beta\n\n     - Deep\n\n  - Second'],
      ['<ul><ul><li>Beta</li></ul><li>Gamma</li></ul>', '- Beta\n- Gamma'],
      ['<ul><ol><ol><li>Deep</li></ol></ol></ul>', '1. Deep'],
      ['<ul><li>Alpha</li><ul><ul><li>Deep</li></ul><li>Beta</li></ul></ul>', '- Alpha\n\n  - Deep\n  - Beta']
    ] as const) {
      await prepare(mode);
      assert.equal(await paste('plain fallback', html), expected, `${mode}: nested list ${html}`);
      await undoRedo('', expected);
    }
    for (const [html, expected] of [
      ['<b style="font-weight:normal;" id="docs-internal-guid-1"><span style="font-weight:400">Hello world</span></b>', 'Hello world'],
      ['<b style="font-weight:normal"><p>para one</p><p>para two</p></b>', 'para one\n\npara two'],
      ['<b style="font-weight:normal"><h2>Title</h2><p>a <strong>bold</strong> b</p></b>', '## Title\n\na **bold** b'],
      ['<p><strong style="font-weight: 400">a</strong> <em style="font-style: normal">b</em> <i style="font-style:normal">c</i></p>', 'a b c'],
      ['<p><b>a</b> <b style="color:red">b</b> <strong style="font-weight:700">c</strong> <b style="font-weight:600">d</b></p>', '**a** **b** **c** **d**'],
      ['<p><b style="mso-bidi-font-weight:normal">a</b> <i style="mso-bidi-font-style:normal">b</i> <em style="font-style:italic">c</em></p>', '**a** *b* *c*']
    ] as const) {
      await prepare(mode);
      assert.equal(await paste('plain fallback', html), expected, `${mode}: inline style over the tag for ${html}`);
      await undoRedo('', expected);
    }
    for (const src of ['', 'data:image/png;base64,ignored', 'javascript:ignored']) {
      const image = '<img src="' + src + '">';
      await prepare(mode, 'prefix', 6, 6, { pasteHtml: true });
      assert.equal(await paste('fallback', image + table + '<p>After</p>'), 'prefix\n\n' + markdown + '\n\nAfter', `${mode}: filtered leading image does not hide a block edge`);
      await prepare(mode, 'suffix', 0, 0, { pasteHtml: true });
      assert.equal(await paste('fallback', '<p>Before</p>' + table + image), 'Before\n\n' + markdown + '\n\nsuffix', `${mode}: filtered trailing image does not hide a block edge`);
    }
    await prepare(mode, 'left replace right', 5, 12, { pasteHtml: true });
    assert.equal(await paste(mixedPlain, mixedHtml), 'left ' + mixedMarkdown + ' right');
    await undoRedo('left replace right', 'left ' + mixedMarkdown + ' right');
    for (const pasteHtml of [false, true]) {
      await prepare(mode, '', 0, 0, { pasteHtml });
      assert.equal(await paste('A\tB\n1\t2', '<div>A\tB<br>1\t2</div>'), markdown, `${mode}: TSV with HTML wrapper`);
      await prepare(mode, '', 0, 0, { pasteHtml });
      assert.equal(await paste('A\tB\n1\t2', table), markdown, `${mode}: standalone HTML table`);
    }
    const twoHtml = '<p><strong>Before</strong></p>' + table + '<p>Between</p>' + table + '<p>After</p>';
    await prepare(mode, '', 0, 0, { pasteHtml: true });
    assert.equal(await paste('Before\nA\tB\n1\t2\nBetween\nA\tB\n1\t2\nAfter', twoHtml), '**Before**\n\n' + markdown + '\n\nBetween\n\n' + markdown + '\n\nAfter');
    const formattedHtml = '<div><p><strong>Before</strong> <a href="https://example.test/">link</a></p><table><caption>First table</caption><tr><th>A</th><th>B</th></tr><tr><td rowspan="2"><em>one</em><br>two</td><td>x|y</td></tr><tr><td>z</td></tr></table><p>Between</p><table><tr><th>C</th></tr><tr><td><code>code</code></td></tr></table><p>After</p></div>';
    await prepare(mode, '', 0, 0, { pasteHtml: true });
    assert.equal(await paste('complete fallback', formattedHtml), '**Before** [link](https://example.test/)\n\nFirst table\n\n| A | B |\n| --- | --- |\n| *one*<br>two | x\\|y |\n|  | z |\n\nBetween\n\n| C |\n| --- |\n| `code` |\n\nAfter');
    const invalid = '<p><strong>Before</strong></p><table><tr><td colspan="10001">value</td></tr></table><p>After</p>';
    for (const convertTables of [false, true]) {
      await prepare(mode, '', 0, 0, { pasteHtml: true, convertTables });
      assert.equal(await paste('Before\nvalue\nAfter', invalid), 'Before\nvalue\nAfter', `${mode}: invalid table falls back as a whole`);
      await prepare(mode, '', 0, 0, { pasteHtml: true, convertTables });
      assert.equal(await paste('whole fragment', table + invalid), 'whole fragment', `${mode}: no partially converted siblings`);
    }
    for (const nested of [table, '<table><tr><td colspan="10001">oversized inner table</td></tr></table>']) {
      await prepare(mode, '', 0, 0, { pasteHtml: true });
      assert.equal(await paste('complete nested table text', '<table><tr><td>outer' + nested + '</td></tr></table>'),
        'complete nested table text', `${mode}: unsupported nesting cannot flatten or bypass capacity`);
    }
    await prepare(mode, '```\n\n```', 4, 4, { pasteHtml: true });
    assert.equal(await paste(mixedPlain, mixedHtml), '```\n' + mixedPlain + '\n```', `${mode}: code remains literal`);
    await prepare(mode, 'left right', 0, 0, { pasteHtml: true });
    await page.evaluate(() => {
      const global = window as any;
      global.editor.view.dispatch({ selection: global.EditingFeaturesHarness.EditorSelection.create([
        global.EditingFeaturesHarness.EditorSelection.range(0, 4), global.EditingFeaturesHarness.EditorSelection.range(5, 10)
      ]) });
    });
    assert.equal(await paste(mixedPlain, mixedHtml), mixedPlain + ' ' + mixedPlain, `${mode}: multiple selections use literal paste`);
    await undoRedo('left right', mixedPlain + ' ' + mixedPlain);
    const existing = '| X | Y |\n| --- | --- |\n| old | tail |';
    await prepare(mode, existing, existing.indexOf('old'), existing.indexOf('old'), { pasteHtml: true, convertTables: false });
    assert.equal(await paste(mixedPlain, mixedHtml), '| X | Y |\n| --- | --- |\n| A | B |\n| 1 | 2 |', `${mode}: existing tables still paste a matrix independently of conversion`);
    await prepare(mode, '', 0, 0, { pasteHtml: true });
    assert.equal(await paste('a\tb', '<b>unrelated</b>', JSON.stringify({ version: 1, cells: [['**a**', 'b']] })), '| **a** | b |\n| --- | --- |', `${mode}: editor matrix has priority`);
  }
  await prepare('source', 'prefix', 6, 6, { pasteHtml: true });
  assert.equal(await paste('Caption\nA\tB\n1\t2', '<table><caption><img src="caption.png" alt="Caption"></caption>' + table.slice(7)),
    'prefix\n\n![Caption](caption.png)\n\n' + markdown, 'non-text captions are preserved');
  await prepare('source', '', 0, 0, { pasteHtml: true });
  const parserCalls = await page.evaluate(({ mixedHtml, mixedPlain }) => {
    const parse = DOMParser.prototype.parseFromString;
    let calls = 0;
    DOMParser.prototype.parseFromString = function(...args) { calls++; return parse.apply(this, args); };
    try {
      const clipboard = new DataTransfer(); clipboard.setData('text/plain', mixedPlain); clipboard.setData('text/html', mixedHtml);
      (window as any).editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: clipboard, bubbles: true, cancelable: true }));
      return calls;
    } finally { DOMParser.prototype.parseFromString = parse; }
  }, { mixedHtml, mixedPlain });
  assert.equal(parserCalls, 1, 'classification, formatting and table cells reuse the parsed clipboard DOM');
  // Each table is within its own limit, but the complete clipboard exceeds it.
  const largeTable = '<table>' + '<tr><td>a</td><td>b</td></tr>'.repeat(3000) + '</table>';
  const largePlain = 'Before\n' + 'a\tb\n'.repeat(3000) + 'Between\n' + 'a\tb\n'.repeat(3000) + 'After';
  await prepare('source', '', 0, 0, { pasteHtml: true });
  assert.equal(await paste(largePlain, '<p>Before</p>' + largeTable + '<p>Between</p>' + largeTable + '<p>After</p>'), largePlain, 'all tables share the clipboard capacity');
  await page.setViewport({ width: 1000, height: 180 });
  await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0} #app{display:flex;flex-direction:column} #app>.cm-editor{height:100%;min-height:0}' });
  const edgeMarkdown = '## Modes\n\n' + markdown + '\n\nAfter the table.';
  const edgePlain = 'Modes\n\nA\tB\n1\t2\n\nAfter the table.';
  const edgeHtml = '<h2>Modes</h2>' + table + '<p>After the table.</p>';
  for (const mode of ['source', 'live']) for (const large of [false, true]) {
    const prefix = 'Earlier paragraph.\n\n'.repeat(large ? 4200 : 45);
    const linked = prefix + '[docs](https://old.example)';
    await prepare(mode, linked, prefix.length + 7, linked.length - 1);
    await page.evaluate(() => (window as any).editor.view.dispatch({ scrollIntoView: true }));
    assert.equal(await page.evaluate(() => {
      const scope = window as any;
      return scope.EditingFeaturesHarness.usesLargeDocumentDerivedWorkBudget(scope.editor.view.state);
    }), large, `${mode}: link paste exercises the expected document-scale policy`);
    await page.waitForFunction(() => [...(window as any).editor.view.contentDOM.querySelectorAll('.cm-line')].at(-1)?.querySelector('span'));
    assert.equal(await paste('https://new.example', ''), prefix + '[docs](https://new.example)', `${mode}/${large}: a pasted URL replaces the destination`);
    await undoRedo(linked, prefix + '[docs](https://new.example)');
    for (const [text, html] of [[edgePlain, edgeHtml], [edgeMarkdown, '']]) {
      await prepare(mode, prefix);
      await page.evaluate(() => (window as any).editor.view.dispatch({ scrollIntoView: true }));
      await page.waitForFunction(() => {
        const { view } = (window as any).editor;
        const caret = view.coordsAtPos(view.state.selection.main.head);
        const bottom = view.scrollDOM.getBoundingClientRect().bottom;
        return caret && bottom - caret.bottom >= 0 && bottom - caret.bottom <= 40;
      });
      assert.equal(await page.evaluate(() => {
        const scope = window as any;
        return scope.EditingFeaturesHarness.usesLargeDocumentDerivedWorkBudget(scope.editor.view.state);
      }), large, `${mode}: paste test exercises the expected document-scale policy`);
      assert.equal(await paste(text, html), prefix + edgeMarkdown);
      await page.waitForSelector(trigger, { visible: true });
      const scrollAfterPaste = await page.evaluate(trigger => {
        const { view } = (window as any).editor;
        const caret = view.coordsAtPos(view.state.selection.main.head);
        const bounds = view.scrollDOM.getBoundingClientRect();
        const button = document.querySelector(trigger)!.getBoundingClientRect();
        if (!caret || caret.top < bounds.top || caret.bottom > bounds.bottom
          || button.left < bounds.left || button.right > bounds.right
          || button.top < bounds.top || button.bottom > bounds.bottom) return null;
        return view.scrollDOM.scrollTop;
      }, trigger);
      assert.ok(scrollAfterPaste !== null, `${mode}/${large}: the paste caret and button fit the viewport`);
      if (html) {
        await page.mouse.move(760, 90);
        await page.mouse.wheel({ deltaY: -300 });
        await page.waitForFunction(({ trigger, scrollAfterPaste }) => {
          return (window as any).editor.view.scrollDOM.scrollTop < scrollAfterPaste - 150 && !document.querySelector(trigger);
        }, {}, { trigger, scrollAfterPaste });
        await page.mouse.wheel({ deltaY: 320 });
        await page.waitForFunction(scrollAfterPaste =>
          (window as any).editor.view.scrollDOM.scrollTop >= scrollAfterPaste - 10, {}, scrollAfterPaste);
        assert.equal(await page.$(trigger), null, `${mode}/${large}: a user scroll away retires the paste options`);
        await undoRedo(prefix, prefix + edgeMarkdown);
      } else {
        assert.equal(await choose('plain'), prefix + edgePlain);
        await undoRedo(prefix, prefix + edgePlain);
      }
    }
  }
  console.log('Production paste: both modes, paste options, HTML/Markdown/table text, short viewports, switches, block edges, dual MIME, capacity, literal code and undo/redo passed');
} finally { await closeTestBrowser(browser); }
