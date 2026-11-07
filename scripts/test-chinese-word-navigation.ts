import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-chinese-words-'));
type Range = { anchor: number; head: number };
type Mode = 'source' | 'live';
// CodeMirror's group commands use Alt on macOS, and Cmd adds a selection range there.
const wordModifier = process.platform === 'darwin' ? 'Alt' : 'Control';
const addRangeModifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function frames(page: Page, count = 2) {
  await page.evaluate(async count => {
    for (let frame = 0; frame < count; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }, count);
}

async function open(page: Page, text: string, mode: Mode, ranges: Range[] = [{ anchor: 0, head: 0 }], main = 0) {
  await page.evaluate(({ text, mode, ranges, main }) => {
    const scope = window as any;
    scope.__wordEditor?.destroy();
    scope.__wordEdits = 0;
    scope.__wordEditor = scope.__createWordEditor({
      parent: document.getElementById('app'), text, initialMode: mode,
      onApplyChanges() { scope.__wordEdits++; }
    });
    const view = scope.__wordEditor.view;
    view.dispatch({ selection: scope.__wordSelection.create(ranges.map((range: Range) =>
      scope.__wordSelection.range(range.anchor, range.head)), main) });
    scope.__wordEditor.focus();
  }, { text, mode, ranges, main });
  await frames(page);
}

async function select(page: Page, ranges: Range[], main = 0) {
  await page.evaluate(({ ranges, main }) => {
    const scope = window as any;
    scope.__wordEditor.view.dispatch({ selection: scope.__wordSelection.create(ranges.map((range: Range) =>
      scope.__wordSelection.range(range.anchor, range.head)), main) });
    scope.__wordEditor.focus();
  }, { ranges, main });
}

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const scope = window as any, view = scope.__wordEditor.view;
    return {
      text: view.state.doc.toString(),
      ranges: view.state.selection.ranges.map(({ anchor, head }: Range) => ({ anchor, head })),
      main: view.state.selection.mainIndex,
      edits: scope.__wordEdits,
      optimized: scope.__wordOptimized(view.state),
      policy: scope.__wordAssessment(view.state.doc.toString()).boundedEditorWork
    };
  });
}

async function control(page: Page, key: string, shift = false) {
  await page.keyboard.down(wordModifier);
  if (shift) await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  if (shift) await page.keyboard.up('Shift');
  await page.keyboard.up(wordModifier);
}

async function history(page: Page, direction: 'undo' | 'redo') {
  await page.evaluate(async direction => { await (window as any).__wordEditor[direction](); }, direction);
  await frames(page);
}

async function assertSelection(page: Page, ranges: Range[], main = 0, message = '') {
  const actual = await snapshot(page);
  assert.deepEqual(actual.ranges, ranges, message);
  assert.equal(actual.main, main, `${message} main selection`);
}

async function keyboardCases(page: Page, mode: Mode) {
  const text = '中文分词测试';
  await open(page, text, mode);
  assert.equal((await snapshot(page)).optimized, false, `${mode} ordinary work budget`);
  for (const head of [2, 4, 6]) {
    await control(page, 'ArrowRight');
    await assertSelection(page, [{ anchor: head, head }], 0, `${mode} next Chinese word`);
  }
  for (const head of [4, 2, 0]) {
    await control(page, 'ArrowLeft');
    await assertSelection(page, [{ anchor: head, head }], 0, `${mode} previous Chinese word`);
  }
  await control(page, 'ArrowLeft');
  await assertSelection(page, [{ anchor: 0, head: 0 }], 0, `${mode} beginning boundary`);
  await control(page, 'Backspace');
  assert.equal((await snapshot(page)).text, text, `${mode} backspace at document start does not delete`);
  await control(page, 'ArrowRight', true);
  await assertSelection(page, [{ anchor: 0, head: 2 }], 0, `${mode} word extension`);
  await control(page, 'ArrowLeft');
  await assertSelection(page, [{ anchor: 0, head: 0 }], 0, `${mode} collapse selection`);

  await open(page, 'foo_bar中文分词', mode);
  for (const head of [7, 9, 11]) {
    await control(page, 'ArrowRight');
    await assertSelection(page, [{ anchor: head, head }], 0, `${mode} ASCII identifier and adjacent Chinese boundaries`);
  }
  await open(page, "can't a.b中文", mode);
  for (const head of [3, 4, 5, 7, 8, 9, 11]) {
    await control(page, 'ArrowRight');
    await assertSelection(page, [{ anchor: head, head }], 0, `${mode} non-Chinese punctuation keeps character-group boundaries`);
  }
  await open(page, '中文   分词', mode, [{ anchor: 2, head: 2 }]);
  await control(page, 'ArrowRight');
  await assertSelection(page, [{ anchor: 7, head: 7 }], 0, `${mode} movement skips whitespace to next word edge`);

  const multiline = `${text}\n${text}\n${text}`;
  const initial = [{ anchor: 1, head: 1 }, { anchor: 11, head: 9 }, { anchor: 14, head: 16 }];
  await open(page, multiline, mode, initial, 1);
  await control(page, 'ArrowRight');
  await assertSelection(page, [{ anchor: 2, head: 2 }, { anchor: 11, head: 11 }, { anchor: 16, head: 16 }], 1,
    `${mode} mixed empty, backward and forward ranges`);
  await select(page, initial, 1);
  await control(page, 'ArrowRight', true);
  await assertSelection(page, [{ anchor: 1, head: 2 }, { anchor: 11, head: 11 }, { anchor: 14, head: 18 }], 1,
    `${mode} extending preserves each anchor and main range`);
  await select(page, initial, 1);
  await control(page, 'ArrowLeft');
  await assertSelection(page, [{ anchor: 0, head: 0 }, { anchor: 9, head: 9 }, { anchor: 14, head: 14 }], 1,
    `${mode} backward movement collapses each selected range toward its start`);
  await select(page, initial, 1);
  await control(page, 'ArrowLeft', true);
  await assertSelection(page, [{ anchor: 1, head: 0 }, { anchor: 11, head: 7 }, { anchor: 14, head: 14 }], 1,
    `${mode} backward extension retains positive and negative selection directions`);
  await select(page, initial, 1);
  await control(page, 'Backspace');
  assert.equal((await snapshot(page)).text, '文分词测试\n中文测试\n分词测试', `${mode} backward deletion mixes cursors and both selection directions`);
  await assertSelection(page, [{ anchor: 0, head: 0 }, { anchor: 8, head: 8 }, { anchor: 11, head: 11 }], 1);
  await history(page, 'undo');
  assert.equal((await snapshot(page)).text, multiline);
  await assertSelection(page, initial, 1, `${mode} undo restores mixed original range directions`);

  // Both cursors inside the first word delete overlapping source intervals.
  const overlap = [{ anchor: 1, head: 1 }, { anchor: 2, head: 2 }, { anchor: 9, head: 9 }];
  await open(page, `${text}\n${text}`, mode, overlap, 2);
  await control(page, 'Backspace');
  let state = await snapshot(page);
  assert.equal(state.text, '分词测试\n分词测试', `${mode} overlapping backward deletions use one original document`);
  assert.deepEqual(state.ranges, [{ anchor: 0, head: 0 }, { anchor: 5, head: 5 }]);
  assert.equal(state.main, 1);
  assert.equal(state.edits, 1, `${mode} all deletions share one transaction`);
  await history(page, 'undo');
  state = await snapshot(page);
  assert.equal(state.text, `${text}\n${text}`);
  assert.deepEqual(state.ranges, overlap, `${mode} one undo restores every original cursor`);
  assert.equal(state.main, 2);
  await history(page, 'redo');
  assert.equal((await snapshot(page)).text, '分词测试\n分词测试');

  const forward = [{ anchor: 0, head: 0 }, { anchor: 1, head: 1 }, { anchor: 7, head: 9 }];
  await open(page, `${text}\n${text}`, mode, forward, 2);
  await control(page, 'Delete');
  assert.equal((await snapshot(page)).text, '分词测试\n分词测试', `${mode} overlapping forward deletion and selected text`);
  await assertSelection(page, [{ anchor: 0, head: 0 }, { anchor: 5, head: 5 }], 1);

  await open(page, '中文\n分词', mode, [{ anchor: 2, head: 2 }]);
  await control(page, 'Delete');
  assert.equal((await snapshot(page)).text, '中文分词', `${mode} line end deletes one newline`);
  await history(page, 'undo');
  await select(page, [{ anchor: 3, head: 3 }]);
  await control(page, 'Backspace');
  assert.equal((await snapshot(page)).text, '中文分词', `${mode} line start deletes one newline`);
  // Chinese word deletion must retain the native history caret contract.
  // Character deletion and general multi-selection history live in the history suite.
  for (const [key, caret] of [['Backspace', 4], ['Delete', 2]] as const) {
    const label = `${mode} word ${key}`;
    await open(page, text, mode, [{ anchor: caret, head: caret }]);
    await control(page, key);
    const deleted = await snapshot(page);
    await history(page, 'undo');
    assert.equal((await snapshot(page)).text, text, `${label} undo text`);
    await assertSelection(page, [{ anchor: caret, head: caret }], 0, `${label} undo restores the original caret`);
    await history(page, 'redo');
    assert.equal((await snapshot(page)).text, deleted.text, `${label} redo text`);
    await assertSelection(page, deleted.ranges, 0, `${label} redo restores the caret after deletion`);
  }
  await open(page, text, mode, [{ anchor: text.length, head: text.length }]);
  await control(page, 'Delete');
  await assertSelection(page, [{ anchor: text.length, head: text.length }]);
  assert.equal((await snapshot(page)).text, text);

  for (const [spaces, expected] of [[' ', '分词'], ['   ', '中文分词']]) {
    const value = `中文${spaces}分词`;
    await open(page, value, mode, [{ anchor: 2 + spaces.length, head: 2 + spaces.length }]);
    await control(page, 'Backspace');
    assert.equal((await snapshot(page)).text, expected, `${mode} whitespace deletion policy ${spaces.length}`);
  }
  const family = '👩‍👩‍👧‍👦';
  await open(page, `中文${family}分词`, mode, [{ anchor: 2, head: 2 }]);
  await control(page, 'ArrowRight');
  await assertSelection(page, [{ anchor: 2 + family.length, head: 2 + family.length }], 0, `${mode} emoji cluster movement`);
  await control(page, 'Backspace');
  assert.equal((await snapshot(page)).text, '中文分词', `${mode} emoji cluster deletion`);
  await open(page, '中文e\u0301分词', mode, [{ anchor: 2, head: 2 }]);
  await control(page, 'Delete');
  assert.equal((await snapshot(page)).text, '中文分词', `${mode} combining mark stays attached`);
  await open(page, '𠮷中文', mode);
  await control(page, 'ArrowRight');
  await assertSelection(page, [{ anchor: 2, head: 2 }], 0, `${mode} supplementary Han character is indivisible`);
  await control(page, 'Backspace');
  assert.equal((await snapshot(page)).text, '中文', `${mode} supplementary Han deletion`);
}

async function compatibilityCases(page: Page, mode: Mode) {
  const commands = [
    ['left', 'ArrowLeft', false], ['right', 'ArrowRight', false],
    ['extendLeft', 'ArrowLeft', true], ['extendRight', 'ArrowRight', true],
    ['backspace', 'Backspace', false], ['delete', 'Delete', false]
  ] as const;
  for (const text of ['alpha beta', "can't a.b foo_bar42", 'a\t \n  beta', 'e\u0301 👩‍👩‍👧‍👦 123', 'אבג דהו', 'alpha אבג beta', 'かなカナ한글']) {
    for (const head of [0, text.indexOf(' ') >= 0 ? text.indexOf(' ') : 2, text.length]) {
      for (const [name, key, shift] of commands) {
        await open(page, text, mode, [{ anchor: head, head }]);
        await control(page, key, shift);
        const actual = await snapshot(page);
        await open(page, text, mode, [{ anchor: head, head }]);
        await page.evaluate(name => {
          const scope = window as any;
          scope.__nativeWordCommands[name](scope.__wordEditor.view);
        }, name);
        const expected = await snapshot(page);
        assert.deepEqual({ text: actual.text, ranges: actual.ranges, main: actual.main },
          { text: expected.text, ranges: expected.ranges, main: expected.main },
          `${mode} native non-Chinese compatibility: ${JSON.stringify(text)} / ${head} / ${name}`);
      }
    }
  }
}

async function inputOwnershipCases(page: Page, mode: Mode) {
  await open(page, '中文分词测试', mode, [{ anchor: 2, head: 2 }]);
  await page.evaluate(() => (window as any).__makeWordEditorReadOnly());
  for (const key of ['Backspace', 'Delete']) await control(page, key);
  let state = await snapshot(page);
  assert.equal(state.text, '中文分词测试', `${mode} read-only word deletion`);
  assert.equal(state.edits, 0);

  await open(page, '中文分词测试', mode, [{ anchor: 2, head: 2 }]);
  const client = await page.createCDPSession();
  try {
    await client.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 5, selectionEnd: 5 });
    await frames(page);
    assert.equal(await page.evaluate(() => (window as any).__wordEditor.view.composing), true);
    await page.evaluate(() => {
      const scope = window as any, view = scope.__wordEditor.view;
      scope.__wordSegmentProbe = scope.__observeWordSegmentation();
      for (const key of ['ArrowLeft', 'ArrowRight', 'Backspace', 'Delete']) {
        view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
          key, ctrlKey: !/Mac/.test(navigator.platform), altKey: /Mac/.test(navigator.platform),
          isComposing: true, bubbles: true, cancelable: true
        }));
      }
    });
    assert.deepEqual(await page.evaluate(() => (window as any).__wordSegmentProbe.take()), [],
      `${mode} IME candidate keys never enter Chinese word segmentation`);
    state = await snapshot(page);
    assert.ok(state.text.includes('zhong'), `${mode} preedit survives candidate keys`);
  } finally {
    await page.evaluate(() => (window as any).__wordSegmentProbe?.restore());
    await client.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 });
    await client.detach();
  }

  await open(page, '中文分词测试', mode, [{ anchor: 2, head: 2 }]);
  await page.evaluate(() => {
    const input = document.createElement('input'); input.id = 'word-other-input'; input.value = 'alpha beta';
    document.body.append(input); input.focus(); input.setSelectionRange(10, 10);
  });
  await control(page, 'Backspace');
  assert.equal((await snapshot(page)).text, '中文分词测试', `${mode} an outside input owns word deletion`);
  assert.equal(await page.$eval('#word-other-input', input => (input as HTMLInputElement).value), 'alpha ');
  await page.$eval('#word-other-input', input => input.remove());

  await open(page, 'alpha beta', mode);
  await page.evaluate(() => { const scope = window as any; scope.__wordSegmentProbe = scope.__observeWordSegmentation(); });
  try {
    await control(page, 'ArrowRight');
    assert.deepEqual(await page.evaluate(() => (window as any).__wordSegmentProbe.take()), [],
      `${mode} non-Chinese input does not start a segmentation window`);
  } finally { await page.evaluate(() => (window as any).__wordSegmentProbe.restore()); }

  if (mode === 'live') {
    await open(page, '| 名称 |\n| --- |\n| 中文分词测试 |', mode);
    await page.click('tbody td .meo-md-html-table-cell-preview');
    await page.evaluate(() => {
      const input = document.activeElement as HTMLTextAreaElement;
      if (input.tagName !== 'TEXTAREA') throw new Error('Expected the native table input');
      input.setSelectionRange(6, 6);
      const scope = window as any; scope.__wordSegmentProbe = scope.__observeWordSegmentation();
    });
    try {
      await control(page, 'ArrowLeft');
      assert.deepEqual(await page.evaluate(() => (window as any).__wordSegmentProbe.take()), [],
        'Live native table input retains word navigation ownership');
      assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA');
      assert.equal((await snapshot(page)).text, '| 名称 |\n| --- |\n| 中文分词测试 |');
    } finally { await page.evaluate(() => (window as any).__wordSegmentProbe.restore()); }
  }
}

async function point(page: Page, position: number) {
  return page.evaluate(position => {
    const view = (window as any).__wordEditor.view;
    const start = view.coordsAtPos(position), end = view.coordsAtPos(position + 1);
    return { x: (start.left + end.left) / 2, y: (start.top + start.bottom) / 2 };
  }, position);
}

async function mouseCases(page: Page, mode: Mode) {
  await open(page, '中文分词测试\n中文分词测试', mode);
  const first = await point(page, 0), second = await point(page, 2), last = await point(page, 4);
  await page.mouse.click(first.x, first.y, { count: 2 });
  await assertSelection(page, [{ anchor: 0, head: 2 }], 0, `${mode} double click selects one Chinese word`);
  const other = await point(page, 7);
  await page.keyboard.down(addRangeModifier);
  await page.mouse.click(other.x, other.y, { count: 2 });
  await page.keyboard.up(addRangeModifier);
  await assertSelection(page, [{ anchor: 0, head: 2 }, { anchor: 7, head: 9 }], 1,
    `${mode} add-range double click retains the first word`);
  await select(page, [{ anchor: 0, head: 2 }]);
  await page.keyboard.down('Shift');
  await page.mouse.click(last.x, last.y, { count: 2 });
  await page.keyboard.up('Shift');
  await assertSelection(page, [{ anchor: 0, head: 6 }], 0, `${mode} shift double click extends selection`);

  // Begin on the middle word, drag both ways, then fold back within that word.
  await page.mouse.move(second.x, second.y);
  await page.mouse.down({ clickCount: 2 });
  await page.mouse.move(last.x, last.y, { steps: 4 });
  await assertSelection(page, [{ anchor: 2, head: 6 }], 0, `${mode} double click drag forward`);
  await page.mouse.move(first.x, first.y, { steps: 4 });
  await assertSelection(page, [{ anchor: 4, head: 0 }], 0, `${mode} double click drag backward`);
  await page.mouse.move(second.x, second.y, { steps: 4 });
  await page.mouse.up();
  const folded = (await snapshot(page)).ranges[0];
  assert.equal(Math.min(folded.anchor, folded.head), 2);
  assert.equal(Math.max(folded.anchor, folded.head), 4, `${mode} drag foldback retains the original whole word`);

  const formatted = '中文**分词**测试\n\n后续正文';
  await open(page, formatted, mode);
  const inside = await point(page, 4), following = await point(page, 8);
  await page.mouse.move(inside.x, inside.y);
  await page.mouse.down({ clickCount: 2 });
  await frames(page, 3);
  const held = await point(page, 8);
  assert.ok(Math.abs(held.x - following.x) <= 1 && Math.abs(held.y - following.y) <= 1,
    `${mode} double-click hold retains the formatted text geometry`);
  await page.mouse.move(following.x, following.y, { steps: 4 });
  await assertSelection(page, [{ anchor: 4, head: 10 }], 0, `${mode} word drag crosses inline formatting`);
  await page.mouse.up();
  await frames(page, 4);
  await assertSelection(page, [{ anchor: 4, head: 10 }], 0, `${mode} release preserves the accepted source range`);
  assert.equal((await snapshot(page)).text, formatted);
  if (process.argv.includes('--capture')) {
    fs.mkdirSync(path.join(root, '.local'), { recursive: true });
    await page.screenshot({ path: path.join(root, '.local', `chinese-word-navigation-${mode}.png`) });
  }
}

async function scaleCases(page: Page, mode: Mode) {
  for (const { text, positions } of [
    { text: '中文分词测试\n'.repeat(9_000), positions: [2, 4] },
    { text: `${'中文分词测试'.repeat(15_000)}\n尾部`, positions: [4094, 4096] }
  ]) {
    await open(page, text, mode, positions.map(head => ({ anchor: head, head })), 1);
    const before = await snapshot(page);
    assert.equal(before.policy, true, `${mode} scale fixture enters production size policy`);
    assert.equal(before.optimized, true, `${mode} scale fixture uses actual derived-work budget`);
    await page.evaluate(() => { const scope = window as any; scope.__wordSegmentProbe = scope.__observeWordSegmentation(); });
    try {
      await control(page, 'ArrowRight');
      const moveInputs: number[] = await page.evaluate(() => (window as any).__wordSegmentProbe.take());
      assert.ok(moveInputs.length > 0 && moveInputs.length <= (positions[0] === 2 ? 1 : 2),
        `${mode} one operation reuses segmentation for neighboring cursors: ${moveInputs}`);
      assert.ok(moveInputs.every(length => length <= 12_288), `${mode} segmentation input stays bounded: ${moveInputs}`);
      await assertSelection(page, positions.map(head => ({ anchor: head + 2, head: head + 2 })), 1);
      await control(page, 'Backspace');
      const deleteInputs: number[] = await page.evaluate(() => (window as any).__wordSegmentProbe.take());
      assert.ok(deleteInputs.length > 0 && deleteInputs.length <= (positions[0] === 2 ? 1 : 2)
        && deleteInputs.every(length => length <= 12_288),
        `${mode} deletion reuses bounded segmentation windows: ${deleteInputs}`);
      const after = await snapshot(page);
      assert.equal(after.text, text.slice(0, positions[0]) + text.slice(positions[1]! + 2), `${mode} large-document multi-cursor deletion`);
      assert.equal(after.edits, 1);
      await history(page, 'undo');
      const restored = await snapshot(page);
      assert.equal(restored.text, text);
      assert.deepEqual(restored.ranges, positions.map(head => ({ anchor: head + 2, head: head + 2 })));
      assert.equal(restored.main, 1);
    } finally { await page.evaluate(() => (window as any).__wordSegmentProbe.restore()); }
  }
}

async function main() {
  const build = await Bun.build({ entrypoints: [path.join(root, 'scripts/test-chinese-word-navigation-entry.ts')],
    outdir: temporary, naming: 'bundle.js', format: 'iife', target: 'browser' });
  if (!build.success) throw new Error(build.logs.map(String).join('\n'));
  const browser = await launchTestBrowser();
  let failure: unknown;
  try {
    const prepare = async (page: Page, mac = false) => {
      await page.setViewport({ width: 1000, height: 640 });
      await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}#app{display:flex}</style><div id="app"></div>');
      if (mac) await page.evaluate(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }));
      await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
      await page.addStyleTag({ content: ':root{--meo-background:#fff;--meo-foreground:#111;--meo-code-background:#f4f4f4;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-live-weight:400;--meo-font-source:monospace;--meo-font-source-size:16px;--meo-font-source-weight:400;--meo-line-height-live:1.6;--meo-line-height-source:1.5}' });
      await page.addScriptTag({ path: path.join(temporary, 'bundle.js') });
    };
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(String(error)));
    await prepare(page);
    const failures: unknown[] = [];
    for (const mode of process.argv.includes('--mac-only') ? [] : ['source', 'live'] as const) for (const [label, run] of [
      ['keyboard/multi-cursor/history', keyboardCases], ['native compatibility', compatibilityCases], ['input ownership', inputOwnershipCases],
      ['pointer', mouseCases], ['optimized scale', scaleCases]
    ] as const) {
      try {
        await run(page, mode);
        console.log(`Chinese word navigation ${mode} ${label} passed`);
      } catch (error) {
        console.error(`Chinese word navigation ${mode} ${label} failed`, error);
        failures.push(error);
      }
    }
    await page.evaluate(() => (window as any).__wordEditor?.destroy());
    const mac = await browser.newPage();
    mac.on('pageerror', error => errors.push(String(error)));
    await prepare(mac, true);
    await open(mac, '中文分词测试', 'source');
    await mac.keyboard.down('Alt'); await mac.keyboard.press('ArrowRight'); await mac.keyboard.up('Alt');
    await assertSelection(mac, [{ anchor: 2, head: 2 }], 0, 'macOS platform fixture: Option word navigation');
    await mac.keyboard.down('Alt'); await mac.keyboard.down('Shift'); await mac.keyboard.press('ArrowRight');
    await mac.keyboard.up('Shift'); await mac.keyboard.up('Alt');
    await assertSelection(mac, [{ anchor: 2, head: 4 }], 0, 'macOS platform fixture: Shift+Option selection');
    await mac.keyboard.down('Alt'); await mac.keyboard.press('Backspace'); await mac.keyboard.up('Alt');
    assert.equal((await snapshot(mac)).text, '中文测试', 'macOS platform fixture: Option deletion');
    await mac.evaluate(() => (window as any).__wordEditor.destroy()); await mac.close();
    console.log('Chinese word navigation macOS platform key fixture passed');
    assert.deepEqual(errors, [], 'browser errors');
    if (failures.length) throw new AggregateError(failures, 'Chinese word navigation regressions failed');
  } catch (error) { failure = error; throw error; }
  finally { if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure); }
}

try { await main(); } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
