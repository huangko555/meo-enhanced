import assert from 'node:assert/strict';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';
import { captureHistoryInteraction, assertHistoryRoundTrip, assertHistoryCoverage } from './history-interaction-contract';

const modes = ['source', 'live'] as const, scales = [false, true];
const receipts: string[] = [];
const label = (mode: string, large: boolean, action: string) => `deletion ${mode}/large=${large}/${action}`;
const deletionCases = [
  { action: 'chinese-word-backspace-noop-main', body: 'x\n中文分词测试',
    ranges: [{ anchor: 0, head: 0 }, { anchor: 6, head: 6 }], main: 0, mainAtDocumentStart: true,
    key: 'Backspace', word: true, deleted: 'x\n中文测试' },
  { action: 'character-backspace', body: 'alpha beta gamma', ranges: [{ anchor: 10, head: 10 }], main: 0,
    key: 'Backspace', word: false, deleted: 'alpha bet gamma' },
  { action: 'word-backspace', body: 'alpha beta gamma', ranges: [{ anchor: 10, head: 10 }], main: 0,
    key: 'Backspace', word: true, deleted: 'alpha  gamma' },
  { action: 'word-delete', body: 'alpha beta gamma', ranges: [{ anchor: 6, head: 6 }], main: 0,
    key: 'Delete', word: true, deleted: 'alpha  gamma' },
  { action: 'backward-selection-delete', body: 'alpha beta gamma', ranges: [{ anchor: 10, head: 6 }], main: 0,
    key: 'Backspace', word: false, deleted: 'alpha  gamma' },
  { action: 'multiple-selection-delete', body: 'abcd\nefgh\nijkl',
    ranges: [{ anchor: 2, head: 2 }, { anchor: 8, head: 6 }, { anchor: 10, head: 12 }], main: 1,
    key: 'Backspace', word: false, deleted: 'acd\neh\nkl' },
  { action: 'chinese-word-backspace', body: '中文分词测试', ranges: [{ anchor: 4, head: 4 }], main: 0,
    key: 'Backspace', word: true, deleted: '中文测试' },
  { action: 'chinese-word-delete', body: '中文分词测试', ranges: [{ anchor: 2, head: 2 }], main: 0,
    key: 'Delete', word: true, deleted: '中文测试' },
  { action: 'chinese-multiple-delete', body: '中文分词测试\n中文分词测试',
    ranges: [{ anchor: 2, head: 2 }, { anchor: 11, head: 9 }], main: 1,
    key: 'Backspace', word: true, deleted: '分词测试\n中文测试' }
];
const expectedReceipts = modes.flatMap(mode => scales.flatMap(large => deletionCases.map(({ action }) => label(mode, large, action))));
let failure: unknown;

try {
  for (const mode of modes) for (const large of scales) for (const fixture of deletionCases) {
    const prefix = '# HISTORY_WITNESS\n\n';
    const suffix = '\n\n' + (large ? 'Padding.\n'.repeat(8100) : 'After.\n\n'.repeat(30));
    const text = prefix + fixture.body + suffix, expectedText = prefix + fixture.deleted + suffix;
    assert.equal(assessLargeDocument(text).boundedEditorWork, large);
    const page = await browser.newPage(), host = await open(page, text, false, mode);
    const surface = { witness: 'HISTORY_WITNESS' }, id = label(mode, large, fixture.action);
    try {
      const ranges = fixture.ranges.map((range, index) => 'mainAtDocumentStart' in fixture && fixture.mainAtDocumentStart && index === fixture.main
        ? { anchor: 0, head: 0 }
        : { anchor: prefix.length + range.anchor, head: prefix.length + range.head });
      await page.evaluate(({ ranges, main }) => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        const Selection = view.state.selection.constructor;
        view.dispatch({ selection: Selection.create(ranges.map((range: any) => Selection.range(range.anchor, range.head)), main) });
        view.focus();
      }, { ranges, main: fixture.main });
      await frames(page, 8);
      const before = await captureHistoryInteraction(page, surface);
      assert.deepEqual(before.ranges, ranges, id + ': original directed selections');
      assert.equal(before.mainIndex, fixture.main, id + ': original primary selection');
      const modifier = process.platform === 'darwin' ? 'Alt' : 'Control';
      if (fixture.word) await page.keyboard.down(modifier);
      await page.keyboard.press(fixture.key);
      if (fixture.word) await page.keyboard.up(modifier);
      await frames(page, 8);
      const after = await captureHistoryInteraction(page, surface);
      assert.equal(after.text, expectedText, id + ': native deletion');
      await assertHistoryRoundTrip(page, { ...surface, label: id, before, after }); receipts.push(id);
      await page.keyboard.type('Z');
      await frames(page, 4);
      let continued = after.text;
      for (const range of [...after.ranges].reverse()) {
        const from = Math.min(range.anchor, range.head), to = Math.max(range.anchor, range.head);
        continued = continued.slice(0, from) + 'Z' + continued.slice(to);
      }
      assert.equal((await captureHistoryInteraction(page, surface)).text, continued, id + ': continued native input');
      assert.equal(host.readHost(), continued, id + ': exact host source after history and input');
      assert.deepEqual(host.errors, [], id + ': no runtime errors');
    } finally { host.dispose(); await page.close(); }
  }
  assertHistoryCoverage(expectedReceipts);
  console.log(`Production deletion history passed: ${receipts.length} cases, both modes and actual ordinary/optimized Worker paths`);
} catch (error) { failure = error; throw error; }
finally { server.stop(true); if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure); }
