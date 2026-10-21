import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
import { defaultShortcuts, changeEditingPreferences } from '../src/application/editingPreferences';
import { planHtmlCommentToggle } from '../webview/src/application/htmlCommentInput';

assert.equal(planHtmlCommentToggle('<!--unfinished', [{ anchor: 8, head: 8 }], false).blocked, true);
assert.equal(planHtmlCommentToggle('text <!--note--> tail', [{ anchor: 2, head: 18 }], false).blocked, true);
assert.deepEqual(defaultShortcuts('mac').lineComment, ['Cmd + /']);
assert.deepEqual(defaultShortcuts('other').selectionComment, ['Alt + Shift + A']);
const changedPreferences = changeEditingPreferences({ input: defaultInputAssistance, shortcuts: {} }, { type: 'bind', command: 'lineComment', keys: ['Ctrl + J'], replaceConflicts: false }, 'other');
assert.deepEqual(changedPreferences.shortcuts.lineComment, ['Ctrl + J']);

const build = await Bun.build({ entrypoints: ['scripts/test-editing-features-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser(), page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error' && message.text().includes('plugin crashed')) errors.push(message.text()); });
try {
  await page.setViewport({ width: 1000, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  await page.evaluate(() => document.addEventListener('keydown', event => {
    const g = window as any;
    if (g.shortcutOverrides !== null && g.editor) g.EditingFeaturesHarness.handleEditorShortcut(event, {
      editor: g.editor, editableMode: 'source', editorSurfaceActive: true, shortcuts: g.shortcutOverrides, platform: 'other',
      requestSave() {}, openFindPanel() {}, requestMode() {}
    });
  }, true));
  const session = await page.createCDPSession();
  let currentMode = '', scenario = 0;
  const prepare = async (mode: string, text = '', anchor = text.length, head = anchor, input = {}) => {
    currentMode = mode; scenario++;
    await page.evaluate(({ mode, text, anchor, head, input }) => {
      const g = window as any; g.editor?.destroy(); g.blocked = 0; g.shortcutOverrides = null;
      g.editor = g.EditingFeaturesHarness.createEditor({ parent: document.getElementById('app')!, text, initialMode: mode,
        initialInputAssistance: input, onApplyChanges() {}, onCommentBlocked() { g.blocked++; } });
      g.editor.view.dispatch({ selection: { anchor, head } }); g.editor.view.focus();
    }, { mode, text, anchor, head, input: { ...defaultInputAssistance, ...input } });
  };
  const text = () => page.evaluate(() => (window as any).editor.getText());
  const selection = () => page.evaluate(() => (window as any).editor.view.state.selection.main.toJSON());
  const command = (id: string) => page.evaluate(id => (window as any).editor.executeCommand(id), id);
  const waitText = async (expected: string) => {
    try { await page.waitForFunction(expected => (window as any).editor.getText() === expected, { timeout: 5000 }, expected); }
    catch { throw new Error(JSON.stringify({ mode: currentMode, scenario, expected, actual: await text(), selection: await selection(),
      nativeSelection: await page.evaluate(() => {
        const view = (window as any).editor.view, native = getSelection()!;
        return native.anchorNode && view.contentDOM.contains(native.anchorNode) ? view.posAtDOM(native.anchorNode, native.anchorOffset) : null;
      }) })); }
  };
  const caret = (at: number) => page.evaluate(at => (window as any).editor.view.dispatch({ selection: { anchor: at } }), at);
  for (const mode of ['source', 'live']) {
    await prepare(mode); await page.keyboard.down('Control'); await page.keyboard.press('Slash'); await page.keyboard.up('Control');
    assert.equal(await text(), '<!---->', mode + ': Ctrl+/ uses the project command');
    assert.deepEqual(await selection(), { anchor: 4, head: 4 });
    await page.keyboard.type('note'); await waitText('<!--note-->');
    await page.keyboard.press('Tab'); assert.deepEqual(await selection(), { anchor: 11, head: 11 });
    await page.keyboard.type('after'); await waitText('<!--note-->after');

    await prepare(mode, 'one\ntwo\nthree', 1, 6); await command('lineComment');
    assert.equal(await text(), '<!--one\ntwo-->\nthree'); assert.deepEqual(await selection(), { anchor: 5, head: 10 });
    await command('lineComment'); assert.equal(await text(), 'one\ntwo\nthree'); assert.deepEqual(await selection(), { anchor: 1, head: 6 });
    await prepare(mode, 'before 中文 after', 9, 7); await command('selectionComment');
    assert.equal(await text(), 'before <!--中文--> after'); assert.deepEqual(await selection(), { anchor: 13, head: 11 });
    await command('selectionComment'); assert.equal(await text(), 'before 中文 after');
    await prepare(mode, 'one\ntwo', 1, 4); await command('lineComment');
    assert.equal(await text(), '<!--one-->\ntwo', 'a selection ending at the next line start excludes that line');
    await prepare(mode, '  \nnext', 1); await command('lineComment');
    assert.equal(await text(), ' <!----> \nnext'); assert.deepEqual(await selection(), { anchor: 5, head: 5 });

    await prepare(mode, 'A <!--  note\n  --> Z', 10); await command('lineComment');
    assert.equal(await text(), 'A   note\n   Z', 'uncomment preserves all interior whitespace');
    await prepare(mode, '<!--one--> two', 0, 14); await command('selectionComment');
    assert.equal(await text(), '<!--one--> two'); assert.equal(await page.evaluate(() => (window as any).blocked), 1);
    await prepare(mode, 'abc', 1); await command('selectionComment');
    assert.equal(await text(), 'a<!---->bc'); await page.evaluate(() => (window as any).editor.undo()); await waitText('abc');
    await page.evaluate(() => (window as any).editor.redo()); await waitText('a<!---->bc');

    await prepare(mode); await page.keyboard.type('<!--'); await waitText('<!---->');
    assert.deepEqual(await selection(), { anchor: 4, head: 4 });
    await page.keyboard.type('note--'); await waitText('<!--note---->');
    await page.keyboard.type('>'); await waitText('<!--note-->'); assert.deepEqual(await selection(), { anchor: 11, head: 11 });
    await prepare(mode); await page.keyboard.type('<!--'); await page.keyboard.press('Backspace'); await waitText('');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('<!---->');
    await caret(4); await page.keyboard.press('Backspace'); await waitText('');
    await prepare(mode, '<!---->', 4); await page.keyboard.press('Backspace'); await waitText('<!--->');
    await prepare(mode, '<!---->', 4, 4, { deleteMode: 'always' }); await page.keyboard.press('Backspace'); await waitText('');
    await prepare(mode, '', 0, 0, { pairMode: 'off' }); await page.keyboard.type('<!--'); await waitText('<!--');
    await prepare(mode, '', 0, 0, { pairMode: 'off' }); await command('selectionComment'); await waitText('<!---->');
    await prepare(mode); await command('selectionComment'); await page.keyboard.press('Enter'); await waitText('<!--\n\n-->');
    assert.deepEqual(await selection(), { anchor: 5, head: 5 }); await page.keyboard.type('body'); await page.keyboard.press('Tab');
    assert.deepEqual(await selection(), { anchor: 13, head: 13 });
    await prepare(mode); await command('selectionComment'); await page.keyboard.press('Escape'); assert.equal(await text(), '<!---->');
    assert.deepEqual(await selection(), { anchor: 4, head: 4 }); await page.keyboard.press('Tab');
    assert.notEqual(await text(), '<!---->', 'Esc ends template interception and restores ordinary Tab');

    await prepare(mode, 'before after', 6); await page.keyboard.type('/comment');
    await page.waitForSelector('[data-command="comment"]'); await page.keyboard.press('Enter');
    await waitText('before<!----> after'); await page.keyboard.type('中文'); await waitText('before<!--中文--> after');
    await page.keyboard.press('Tab'); assert.deepEqual(await selection(), { anchor: 15, head: 15 });
    await prepare(mode, '<!--note-->', 6); await page.keyboard.type('/comment');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('.meo-input-suggestions')!.hidden);
    for (const [skipMode, expected] of [['smart', '<!--note-->-->'], ['always', '<!--note-->'], ['off', '<!--note-->-->']]) {
      await prepare(mode, '<!--note-->', 8, 8, { skipMode }); await page.keyboard.type('-->'); await waitText(expected);
    }
    await prepare(mode, '', 0, 0, { skipMode: 'off' }); await command('selectionComment'); await page.keyboard.type('-->'); await waitText('<!---->-->');
    await prepare(mode, '', 0, 0, { deleteMode: 'off' }); await command('selectionComment'); await page.keyboard.press('Backspace'); await waitText('<!--->');
    await prepare(mode); await command('selectionComment'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Tab'); assert.notEqual(await text(), '<!---->', 'moving outside the field ends template navigation');
    await prepare(mode, 'x', 0, 1); await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('A'); await page.keyboard.up('Shift'); await page.keyboard.up('Alt');
    await waitText('<!--x-->');
    await prepare(mode, 'one\ntwo', 1); await page.evaluate(() => {
      const g = window as any, selection = g.EditingFeaturesHarness.EditorSelection;
      g.editor.view.dispatch({ selection: selection.create([selection.cursor(1), selection.cursor(5)], 1) });
    });
    await command('lineComment'); await waitText('<!--one-->\n<!--two-->');
    assert.deepEqual(await page.evaluate(() => { const selection = (window as any).editor.view.state.selection; return { heads: selection.ranges.map((range: any) => range.head), main: selection.mainIndex }; }), { heads: [5, 16], main: 1 });
    await page.evaluate(() => (window as any).editor.undo()); await waitText('one\ntwo');

    await prepare(mode); await command('selectionComment');
    await session.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 }); await waitText('<!--中文-->');
    assert.equal(await command('lineComment'), false, 'an explicit command cannot interrupt preedit');
    const imeKeys = await page.evaluate(() => {
      const g = window as any; return ['Enter', 'Tab', 'Escape', ' '].map(key => {
        const event = new KeyboardEvent('keydown', { key, isComposing: true, bubbles: true, cancelable: true });
        g.editor.view.contentDOM.dispatchEvent(event); return event.defaultPrevented;
      });
    }); assert.deepEqual(imeKeys, [false, false, false, false]);
    await session.send('Input.insertText', { text: '中文' }); await page.keyboard.press('Tab');
    assert.deepEqual(await selection(), { anchor: 9, head: 9 });
    await prepare(mode, '<!-', 3); await session.send('Input.imeSetComposition', { text: '-', selectionStart: 1, selectionEnd: 1 });
    await waitText('<!--'); await session.send('Input.insertText', { text: '-' }); await waitText('<!--');
    await prepare(mode); await page.evaluate(() => {
      const g = window as any, data = new DataTransfer(); data.setData('text/plain', '<!--');
      g.editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }); await waitText('<!--');

    await prepare(mode, 'text', 2); await page.evaluate(() => {
      const g = window as any, h = g.EditingFeaturesHarness;
      g.editor.view.dispatch({ effects: h.StateEffect.appendConfig.of(h.EditorState.readOnly.of(true)) });
    }); assert.equal(await command('lineComment'), false); assert.equal(await command('selectionComment'), false); assert.equal(await text(), 'text');
    for (const overrides of [{ lineComment: [] }, { lineComment: ['Ctrl + J'] }]) {
      await prepare(mode, 'text', 2); await page.evaluate(overrides => { (window as any).shortcutOverrides = overrides; }, overrides);
      await page.keyboard.down('Control'); await page.keyboard.press('/'); await page.keyboard.up('Control'); assert.equal(await text(), 'text', 'cleared or remapped default never leaks to CodeMirror');
      for (const stroke of [
        { key: '／', code: 'Slash', keyCode: 191, ctrlKey: true },
        { key: '/', code: 'Digit7', keyCode: 55, ctrlKey: true, shiftKey: true }
      ]) {
        await page.evaluate(stroke => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { ...stroke, bubbles: true, cancelable: true })), stroke);
        assert.equal(await text(), 'text', 'alternate slash gestures cannot bypass cleared or remapped shortcuts through CodeMirror');
      }
      if (overrides.lineComment.length) {
        await page.keyboard.down('Control'); await page.keyboard.press('j'); await page.keyboard.up('Control'); await waitText('<!--text-->');
      }
    }
    await prepare(mode, 'x', 0, 1); await page.evaluate(() => { (window as any).shortcutOverrides = { selectionComment: [] }; });
    await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('A'); await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); assert.equal(await text(), 'x');
    await prepare(mode, '`<!--` after', 12); await command('selectionComment'); await waitText('`<!--` after<!---->');
    await prepare(mode, '`<!--` after', 12); await page.keyboard.type('<!--'); await waitText('`<!--` after<!---->');
    await prepare(mode, '<!--\n\n--> tail', 5); await command('selectionComment'); await waitText('\n\n tail');
    await prepare(mode, '<div>note</div>', 7); await command('selectionComment'); await page.keyboard.type('x'); await waitText('<div>no<!--x-->te</div>');
    await prepare(mode, '```js\nconst a = 1;\n```', 12); await command('lineComment'); await waitText('```js\n// const a = 1;\n```');
    await command('lineComment'); await waitText('```js\nconst a = 1;\n```');
    for (const [languages, marker] of [
      [['bash', 'shell', 'sh', 'zsh'], '#'], [['csharp', 'cs', 'c#', 'm', 'powerquery', 'pq'], '//']
    ] as const) for (const language of languages) {
      const document = '```' + language + '\nabc\n```', position = document.indexOf('abc');
      const commented = document.replace('\nabc\n', '\n' + marker + ' abc\n');
      await prepare(mode, document, position + 1);
      await page.evaluate(() => { (window as any).shortcutOverrides = {}; });
      await page.keyboard.down('Control'); await page.keyboard.press('Slash'); await page.keyboard.up('Control');
      assert.equal(await text(), commented, `${mode}/${language}: Ctrl+/ uses the language comment rule`);
      await page.evaluate(() => (window as any).editor.undo()); await waitText(document);
      await page.evaluate(() => (window as any).editor.redo()); await waitText(commented);
      await command('lineComment'); await waitText(document);
      if (marker === '//') {
        await prepare(mode, document, position, position + 3); await command('selectionComment');
        await waitText(document.replace('\nabc\n', '\n/* abc */\n'));
        await command('selectionComment'); await waitText(document);
      }
    }
    await prepare(mode, '```html\n\n```', 8); await page.keyboard.type('<!--');
    assert.ok(!(await text()).includes('<!---->'), 'code keeps literal HTML comment input');
  }
  const table = '| A | B |\n| --- | --- |\n|  | other |';
  const prepareCell = async (value = '', preferences = {}) => {
    await prepare('live', table.replace('|  | other |', '| ' + value + ' | other |'), 0, 0, preferences); await page.waitForSelector('tbody textarea');
    await page.click('tbody textarea');
    await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.setSelectionRange(0, 0); });
  };
  const cell = () => page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; return { value: input.value, from: input.selectionStart, to: input.selectionEnd, focused: document.activeElement === input }; });
  for (const stroke of [
    { key: '/', code: 'Slash', keyCode: 191, ctrlKey: true },
    { key: '／', code: 'Slash', keyCode: 191, ctrlKey: true },
    { key: '/', code: 'Digit7', keyCode: 55, ctrlKey: true, shiftKey: true }
  ]) for (const overrides of [{}, { lineComment: [] }, { lineComment: ['Ctrl + J'] }, { lineComment: ['Ctrl + Shift + /'] }]) {
    await prepareCell('abc');
    await page.evaluate(overrides => { (window as any).shortcutOverrides = overrides; }, overrides);
    const press = () => page.evaluate(stroke => {
      const event = new KeyboardEvent('keydown', { ...stroke, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event); return event.defaultPrevented;
    }, stroke);
    assert.equal(await press(), true, 'equivalent slash gestures are consumed, including cleared/reassigned defaults');
    const expected = !('lineComment' in overrides) || overrides.lineComment?.includes('Ctrl + Shift + /') && stroke.shiftKey ? '<!--abc-->' : 'abc';
    assert.equal((await cell()).value, expected, `table ${stroke.code}/${stroke.key}: honors configured shortcuts`);
    assert.equal((await cell()).focused, true);
    if (expected !== 'abc') { await press(); assert.equal((await cell()).value, 'abc', 'the same gesture also uncomments'); }
    else if (overrides.lineComment?.includes('Ctrl + J')) {
      await page.keyboard.down('Control'); await page.keyboard.press('j'); await page.keyboard.up('Control');
      assert.equal((await cell()).value, '<!--abc-->', 'the reassigned gesture works in the same cell');
    }
  }
  await prepareCell(); await command('selectionComment');
  assert.deepEqual(await cell(), { value: '<!---->', from: 4, to: 4, focused: true });
  await page.keyboard.type('cell'); await page.keyboard.press('Tab');
  assert.deepEqual(await cell(), { value: '<!--cell-->', from: 11, to: 11, focused: true });
  await page.keyboard.type('tail'); assert.equal((await cell()).value, '<!--cell-->tail');
  await prepareCell(); await page.keyboard.type('/comment'); await page.waitForSelector('[data-command="comment"]');
  await page.click('[data-command="comment"]'); await page.keyboard.type('note'); assert.equal((await cell()).value, '<!--note-->');
  await prepareCell(); await page.keyboard.type('<!--'); assert.equal((await cell()).value, '<!---->');
  await page.keyboard.press('Backspace'); assert.equal((await cell()).value, '');
  await prepareCell('abc'); await command('lineComment'); assert.equal((await cell()).value, '<!--abc-->');
  await page.evaluate(() => (window as any).editor.undo()); await waitText(table.replace('|  | other |', '| abc | other |'));
  await page.evaluate(() => (window as any).editor.redo()); await waitText(table.replace('|  | other |', '| <!--abc--> | other |'));
  await prepareCell('中文'); await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.setSelectionRange(0, 2, 'backward'); });
  await command('selectionComment'); assert.deepEqual(await cell(), { value: '<!--中文-->', from: 4, to: 6, focused: true });
  assert.equal(await page.evaluate(() => (document.activeElement as HTMLTextAreaElement).selectionDirection), 'backward');
  await command('selectionComment'); assert.equal((await cell()).value, '中文');
  await prepareCell('<!--note--> tail'); await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.setSelectionRange(0, input.value.length); });
  await command('selectionComment'); assert.equal((await cell()).value, '<!--note--> tail'); assert.equal(await page.evaluate(() => (window as any).blocked), 1);
  await prepareCell(); await command('selectionComment'); await page.keyboard.type('note-->'); assert.equal((await cell()).value, '<!--note-->');
  await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement === document.querySelectorAll('tbody textarea')[1]), true, 'after typing the closing marker normal table navigation resumes');
  await prepareCell(); await command('selectionComment'); await page.keyboard.press('Enter'); assert.ok(!(await text()).includes('<!--\n\n-->'), 'table Enter does not create a block comment');
  await prepareCell(); await command('selectionComment'); await page.keyboard.press('Escape'); assert.equal((await cell()).value, '<!---->');
  await prepareCell('', { pairMode: 'off' }); await page.keyboard.type('<!--'); assert.equal((await cell()).value, '<!--');
  await prepareCell('', { deleteMode: 'off' }); await command('selectionComment'); await page.keyboard.press('Backspace'); assert.equal((await cell()).value, '<!--->');
  await prepareCell(); await command('selectionComment'); await session.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
  assert.equal((await cell()).value, '<!--中文-->');
  assert.equal(await command('lineComment'), false, 'table commands also leave preedit alone');
  await session.send('Input.insertText', { text: '中文' }); await page.keyboard.press('Tab'); assert.equal((await cell()).from, 9);
  await prepareCell('`literal`'); await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.setSelectionRange(3, 3); });
  assert.equal(await command('selectionComment'), false); assert.equal((await cell()).value, '`literal`');
  await prepareCell('<!--a>b-->'); await page.evaluate(() => { const input = document.querySelector<HTMLTextAreaElement>('tbody textarea')!; input.setSelectionRange(7, 7); });
  await page.keyboard.type('/comment'); await page.waitForFunction(() => document.querySelector<HTMLElement>('.meo-input-suggestions')!.hidden);
  assert.deepEqual(errors, []);
  console.log('HTML comment production input: commands, slash, caret, source/live, selections, whitespace, templates, pairing, preferences, history and native table focus passed');
} finally { await closeTestBrowser(browser); }
