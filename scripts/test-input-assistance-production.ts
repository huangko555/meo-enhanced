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
  console.log('Production input assistance: Live/Source, English/Chinese pairs, reversed selection, backticks, origins through undo, all modes and list continuation passed');
} finally { await closeTestBrowser(browser); }
