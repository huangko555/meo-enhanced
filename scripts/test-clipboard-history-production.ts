import assert from 'node:assert/strict';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';
import { captureHistoryInteraction, assertHistoryRoundTrip, assertHistoryCoverage } from './history-interaction-contract';

type Range = { anchor: number; head: number };

const witness = { witness: 'HISTORY_WITNESS' };
const prefix = '# Before\n\n' + 'Earlier paragraph.\n\n'.repeat(55) + '## HISTORY_WITNESS\n\n';
const suffix = '\n\nAfter.\n\n'.repeat(30);
const body = 'alpha beta';
const multiRanges: Range[] = [{ anchor: 5, head: 0 }, { anchor: 6, head: 10 }];
const receipts = [
  'clipboard/source/html-paste',
  'clipboard/live/multi-paste',
  'clipboard/source/multi-cut'
];
const completed: string[] = [];
let failure: unknown;

async function setRanges(page: any, ranges: Range[], mainIndex: number): Promise<void> {
  await page.evaluate(({ ranges, mainIndex }) => {
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const Selection = view.state.selection.constructor;
    view.dispatch({ selection: Selection.create(ranges.map((range: any) => Selection.range(range.anchor, range.head)), mainIndex), scrollIntoView: true });
    view.focus();
  }, { ranges, mainIndex });
}

async function centerSelection(page: any): Promise<void> {
  await page.evaluate(() => {
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const caret = view.coordsAtPos(view.state.selection.main.head);
    const bounds = view.scrollDOM.getBoundingClientRect();
    if (caret) view.scrollDOM.scrollTop += caret.top - bounds.top - bounds.height / 2;
  });
  await frames(page, 4);
}

async function dispatchClipboard(page: any, type: 'paste' | 'cut', plain: string, html?: string): Promise<void> {
  await page.evaluate(({ type, plain, html }) => {
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const clipboard = new DataTransfer();
    clipboard.setData('text/plain', plain);
    if (html !== undefined) clipboard.setData('text/html', html);
    view.contentDOM.dispatchEvent(new ClipboardEvent(type, { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, { type, plain, html });
}

async function enableHtmlPaste(page: any): Promise<void> {
  await page.evaluate(preferences => {
    window.dispatchEvent(new MessageEvent('message', { data: {
      type: 'editingPreferencesChanged', preferences: { input: preferences, shortcuts: {} }, revision: 1
    } }));
  }, { ...defaultInputAssistance, pasteHtml: true });
  await frames(page, 4);
}

try {
  {
    const id = receipts[0]!;
    const original = prefix + 'left word right' + suffix;
    const afterText = prefix + 'left **bold** right' + suffix;
    const page = await browser.newPage();
    const host = await open(page, original, false, 'source');
    try {
      await enableHtmlPaste(page);
      await setRanges(page, [{ anchor: prefix.length + 9, head: prefix.length + 5 }], 0);
      await centerSelection(page);
      const before = await captureHistoryInteraction(page, witness);
      assert.deepEqual(before.ranges, [{ anchor: prefix.length + 9, head: prefix.length + 5 }], id + ': initial backward selection');
      assert.equal(before.mainIndex, 0, id + ': initial primary range');
      await dispatchClipboard(page, 'paste', 'bold', '<strong>bold</strong>');
      await frames(page, 8);
      const after = await captureHistoryInteraction(page, witness);
      assert.equal(after.text, afterText, id + ': exact HTML paste');
      assert.deepEqual(after.ranges, [{ anchor: prefix.length + 13, head: prefix.length + 13 }], id + ': folded caret');
      assert.equal(after.mainIndex, 0, id + ': primary range after paste');
      assert.equal(host.readHost(), afterText, id + ': host text');
      await assertHistoryRoundTrip(page, { ...witness, label: id, before, after });
      await page.keyboard.type('Q');
      await frames(page, 8);
      assert.equal(host.readHost(), prefix + 'left **bold**Q right' + suffix, id + ': input after redo lands at caret');
      completed.push(id);
      assert.deepEqual(host.errors, [], id + ': no runtime errors');
    } finally { host.dispose(); await page.close(); }
  }

  {
    const id = receipts[1]!;
    const original = prefix + body + '\n\n' + 'Padding.\n'.repeat(8100);
    const afterText = prefix + 'Z Z' + '\n\n' + 'Padding.\n'.repeat(8100);
    assert.equal(assessLargeDocument(original).boundedEditorWork, true, id + ': production optimized-document policy');
    const page = await browser.newPage();
    const host = await open(page, original, false, 'live');
    try {
      await setRanges(page, multiRanges.map(range => ({ anchor: range.anchor + prefix.length, head: range.head + prefix.length })), 1);
      await centerSelection(page);
      const before = await captureHistoryInteraction(page, witness);
      const expectedBefore = multiRanges.map(range => ({ anchor: range.anchor + prefix.length, head: range.head + prefix.length }));
      assert.deepEqual(before.ranges, expectedBefore, id + ': initial multi-selection');
      assert.equal(before.mainIndex, 1, id + ': initial primary range');
      await dispatchClipboard(page, 'paste', 'Z');
      await frames(page, 8);
      const after = await captureHistoryInteraction(page, witness);
      assert.equal(after.text, afterText, id + ': exact literal paste');
      assert.deepEqual(after.ranges, [{ anchor: prefix.length + 1, head: prefix.length + 1 }, { anchor: prefix.length + 3, head: prefix.length + 3 }], id + ': folded multi-caret');
      assert.equal(after.mainIndex, 1, id + ': primary range after paste');
      assert.equal(host.readHost(), afterText, id + ': host text');
      await assertHistoryRoundTrip(page, { ...witness, label: id, before, after });
      completed.push(id);
      assert.deepEqual(host.errors, [], id + ': no runtime errors');
    } finally { host.dispose(); await page.close(); }
  }

  {
    const id = receipts[2]!;
    const original = prefix + body + suffix;
    const afterText = prefix + ' ' + suffix;
    const page = await browser.newPage();
    const host = await open(page, original, false, 'source');
    try {
      await setRanges(page, multiRanges.map(range => ({ anchor: range.anchor + prefix.length, head: range.head + prefix.length })), 1);
      await centerSelection(page);
      const before = await captureHistoryInteraction(page, witness);
      const expectedBefore = multiRanges.map(range => ({ anchor: range.anchor + prefix.length, head: range.head + prefix.length }));
      assert.deepEqual(before.ranges, expectedBefore, id + ': initial multi-selection');
      assert.equal(before.mainIndex, 1, id + ': initial primary range');
      await dispatchClipboard(page, 'cut', '');
      await frames(page, 8);
      const after = await captureHistoryInteraction(page, witness);
      assert.equal(after.text, afterText, id + ': exact multi-selection cut');
      assert.deepEqual(after.ranges, [{ anchor: prefix.length, head: prefix.length }, { anchor: prefix.length + 1, head: prefix.length + 1 }], id + ': folded multi-caret');
      assert.equal(after.mainIndex, 1, id + ': primary range after cut');
      assert.equal(host.readHost(), afterText, id + ': host text');
      await assertHistoryRoundTrip(page, { ...witness, label: id, before, after });
      completed.push(id);
      assert.deepEqual(host.errors, [], id + ': no runtime errors');
    } finally { host.dispose(); await page.close(); }
  }
  assertHistoryCoverage(receipts);
  console.log(`Production clipboard history passed: ${completed.length} cases; DOM clipboard conversion, multi-selection paste/cut, and undo/redo contracts covered`);
} catch (error) {
  failure = error;
  throw error;
} finally {
  server.stop(true);
  if (failure === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, failure);
}
