import assert from 'node:assert/strict';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';

const build = await Bun.build({ entrypoints: ['scripts/test-table-stability-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 900, height: 650 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const prepare = async (mode: string, text = '', from = text.length, to = from, changes = {}) => {
    await page.evaluate(({ mode, text, from, to, preferences }) => {
      const global = window as any;
      global.__inputEditor?.destroy();
      global.__inputEditor = global.TableStabilityHarness.createEditor({ parent: document.getElementById('app')!, text,
        initialMode: mode, initialInputAssistance: preferences, onApplyChanges() {} });
      global.__inputEditor.view.dispatch({ selection: { anchor: from, head: to } });
      global.__inputEditor.view.focus();
    }, { mode, text, from, to, preferences: { ...defaultInputAssistance, ...changes } });
  };
  const text = () => page.evaluate(() => (window as any).__inputEditor.getText());
  const waitText = async (expected: string) => {
    try { await page.waitForFunction(expected => (window as any).__inputEditor.getText() === expected, { timeout: 5000 }, expected); }
    catch { throw new Error(JSON.stringify({ expected, actual: await text(), state: await page.evaluate(() => ({ history: (window as any).__inputEditor.getHistoryDepth(), selection: (window as any).__inputEditor.view.state.selection.toJSON() })) })); }
  };
  for (const mode of ['source', 'live']) {
    for (const [left, right] of [['(', ')'], ['[', ']'], ['{', '}'], ['"', '"'], ["'", "'"], ['`', '`'], ['（', '）'], ['【', '】'], ['“', '”'], ['‘', '’'], ['《', '》'], ['「', '」'], ['『', '』']]) {
      await prepare(mode);
      await page.keyboard.type(left);
      assert.equal(await text(), left + right, `${mode}: ${left}`);
      await page.keyboard.press('Backspace');
      assert.equal(await text(), '', `${mode}: automatic ${left} deletion`);
      await page.evaluate(() => (window as any).__inputEditor.undo());
      await waitText(left + right);
      // The production history owner reveals the restored edit. Re-enter its gap
      // explicitly to verify that automatic provenance survived the history replay.
      await page.evaluate(() => (window as any).__inputEditor.view.dispatch({ selection: { anchor: 1 } }));
      await page.keyboard.type(right);
      assert.equal(await text(), left + right, `${mode}: provenance after undo and cursor repositioning`);
      await prepare(mode, '文字', 2, 0);
      await page.keyboard.type(left);
      assert.equal(await text(), left + '文字' + right, `${mode}: reverse selected ${left}`);
    }
    // These five entries are surroundingPairs in VS Code's Markdown configuration,
    // independently of its autoClosingPairs. Keep the fixture independent of our rules.
    for (const [left, right] of [['*', '*'], ['_', '_'], ['~', '~'], ['<', '>'], ['$', '$']]) {
      for (const backward of [false, true]) {
        await prepare(mode, 'word', backward ? 4 : 0, backward ? 0 : 4, { pairMode: 'off' });
        await page.keyboard.type(left);
        assert.equal(await text(), left + 'word' + right, `${mode}: selected ${left}, backward=${backward}`);
        assert.deepEqual(await page.evaluate(() => (window as any).__inputEditor.view.state.selection.main.toJSON()),
          backward ? { anchor: 5, head: 1 } : { anchor: 1, head: 5 }, 'keep the inner selection and its direction');
        await page.evaluate(() => (window as any).__inputEditor.undo()); await waitText('word');
        await page.evaluate(() => (window as any).__inputEditor.redo()); await waitText(left + 'word' + right);
      }
      await prepare(mode, 'word', 0, 4);
      await page.keyboard.type(left.repeat(3));
      assert.equal(await text(), left.repeat(3) + 'word' + right.repeat(3), `${mode}: repeated ${left} wraps the retained selection`);
      await prepare(mode, 'one\ntwo', 0, 7);
      await page.keyboard.type(left); assert.equal(await text(), left + 'one\ntwo' + right, `${mode}: multiline ${left}`);
      await prepare(mode, 'word', 0, 4, { wrapSelection: false });
      await page.keyboard.type(left); assert.equal(await text(), left, `${mode}: disabled wrapping replaces the selection`);
      await prepare(mode, '', 0, 0, { pairMode: 'always', skipMode: 'always', deleteMode: 'always' });
      await page.keyboard.type(left); assert.equal(await text(), left, `${mode}: surrounding-only ${left} does not auto-close`);
      await prepare(mode, left + right, 1, 1, { pairMode: 'always', skipMode: 'always', deleteMode: 'always' });
      await page.keyboard.type(right); assert.equal(await text(), left + right.repeat(2), `${mode}: surrounding-only closer is inserted rather than skipped`);
      await prepare(mode, left + right, 1, 1, { deleteMode: 'always' });
      await page.keyboard.press('Backspace'); assert.equal(await text(), right, `${mode}: surrounding-only pair keeps single-character deletion`);
    }
    for (const left of ['(', '[', '{', '"', "'", '`', '<', '*', '_', '~', '$']) {
      await prepare(mode, '\\word', 1, 5);
      await page.keyboard.type(left);
      const right = left === '(' ? ')' : left === '[' ? ']' : left === '{' ? '}' : left === '<' ? '>' : left;
      assert.equal(await text(), '\\' + left + 'word' + right, `${mode}: an escape before the selection does not suppress surrounding`);
      await prepare(mode, ' \t\n ', 0, 4);
      await page.keyboard.type(left); assert.equal(await text(), left, `${mode}: whitespace-only selection uses ordinary replacement`);
    }
    for (const typed of ['"', "'"]) for (const selected of ['"', "'", '`']) {
      await prepare(mode, selected, 0, 1); await page.keyboard.type(typed);
      assert.equal(await text(), typed, `${mode}: replacing a single quote does not surround it`);
    }
    await prepare(mode, '\u00a0', 0, 1); await page.keyboard.type('*');
    assert.equal(await text(), '*\u00a0*', `${mode}: native whitespace exception is restricted to spaces, tabs and line breaks`);
    for (const unsupported of ['=', '#', '+', '-', '|', ')', ']']) {
      await prepare(mode, 'word', 0, 4); await page.keyboard.type(unsupported);
      assert.equal(await text(), unsupported, `${mode}: non-surrounding ${unsupported} keeps replacement behavior`);
    }
    await prepare(mode, '`', 0, 1); await page.keyboard.type('`');
    assert.equal(await text(), '`` ` ``', 'the existing adaptive backtick extension keeps a literal selected backtick');
    await prepare(mode, 'a`b', 0, 3);
    await page.keyboard.type('`');
    assert.equal(await text(), '``a`b``');
    await prepare(mode, 'word', 0, 4, { wrapSelection: false });
    await page.keyboard.type('(');
    assert.equal(await text(), '(');
    await prepare(mode, '', 0, 0, { pairMode: 'off' });
    await page.keyboard.type('(');
    assert.equal(await text(), '(');
    await prepare(mode, 'abc', 0);
    await page.keyboard.type('(');
    assert.equal(await text(), '(abc');
    await prepare(mode, 'abc', 0, 0, { pairMode: 'always' });
    await page.keyboard.type('(');
    assert.equal(await text(), '()abc');
    for (const [skipMode, expected] of [['smart', '())'], ['always', '()'], ['off', '())']]) {
      await prepare(mode, '()', 1, 1, { skipMode });
      await page.keyboard.type(')');
      assert.equal(await text(), expected, `${mode}: manual ${skipMode} skip`);
    }
    for (const [deleteMode, expected] of [['smart', ')'], ['always', ''], ['off', ')']]) {
      await prepare(mode, '()', 1, 1, { deleteMode });
      await page.keyboard.press('Backspace');
      assert.equal(await text(), expected, `${mode}: manual ${deleteMode} delete`);
    }
    await prepare(mode, '- item', 6, 6, { lists: false });
    await page.keyboard.press('Enter');
    assert.equal(await text(), '- item\n');
    await prepare(mode, '- item');
    await page.keyboard.press('Enter');
    assert.equal(await text(), '- item\n- ');
  }
  assert.deepEqual(errors, []);
  console.log('Production input assistance: Live/Source, all native Markdown surrounding pairs/Chinese pairs, forward/reverse/multiline selection, repeated markers, quote/whitespace/escape boundaries, backticks, origins through undo, all modes and list continuation passed');
} finally { await closeTestBrowser(browser); }
