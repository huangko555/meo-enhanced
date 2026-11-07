import assert from 'node:assert/strict';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

async function shortcut(page: import('puppeteer-core').Page, key: 'z' | 'y'): Promise<void> {
  await page.keyboard.down(modifier);
  try { await page.keyboard.press(key); }
  finally { await page.keyboard.up(modifier); }
}

type Frame = { text: string; ranges: Array<{ anchor: number; head: number }>; native: number | null; focus: string };

async function observeReplay(page: import('puppeteer-core').Page, action: () => Promise<void>, expectedText: string, label: string): Promise<Frame> {
  await page.evaluate(() => {
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    const frames: Frame[] = [];
    const sample = () => {
      const native = document.getSelection();
      frames.push({ text: view.state.doc.toString(), ranges: view.state.selection.ranges.map((range: any) => ({ anchor: range.anchor, head: range.head })),
        native: native?.focusNode && view.contentDOM.contains(native.focusNode) ? view.posAtDOM(native.focusNode, native.focusOffset) : null,
        focus: document.activeElement === view.contentDOM ? 'document' : document.activeElement?.tagName ?? 'none' });
      (window as any).__pendingTableHistoryFrame = requestAnimationFrame(sample);
    };
    (window as any).__pendingTableHistoryFrames = frames;
    sample();
  });
  try {
    await action();
    await frames(page, 45);
    const trace = await page.evaluate(() => (window as any).__pendingTableHistoryFrames as Frame[]);
    const accepted = trace.filter(frame => frame.text === expectedText);
    assert.ok(accepted.length >= 2, label + ': expected document must be observable in consecutive frames');
    const final = accepted.at(-1)!;
    // No accepted document frame may first publish a stale native caret and
    // repair it later. The final actual target is measured, never reconstructed.
    for (const [index, frame] of accepted.entries()) {
      assert.deepEqual(frame.ranges, final.ranges, label + `: logical selection changed after document acceptance at frame ${index}`);
      assert.equal(frame.native, final.native, label + `: native selection changed after document acceptance at frame ${index}`);
      assert.equal(frame.focus, 'document', label + `: editor focus at frame ${index}`);
    }
    return final;
  } finally {
    await page.evaluate(() => {
      cancelAnimationFrame((window as any).__pendingTableHistoryFrame);
      delete (window as any).__pendingTableHistoryFrame;
      delete (window as any).__pendingTableHistoryFrames;
    });
  }
}

let failure: unknown;
try {
  const beforeText = '# Pending table history\n\n## HISTORY_WITNESS\n\n| A | B |\n| --- | --- |\n| seed | stable |\n\nAfter table.\n';
  const afterText = beforeText.replace('seed', 'seedX');
  const seed = afterText.indexOf('seedX');
  assert.ok(seed >= 0, 'fixture requires the editable cell');
  const page = await browser.newPage();
  const host = await open(page, beforeText, false, 'live');
  try {
    const cell = 'tbody tr:first-child td:first-child textarea';
    await page.waitForSelector(cell);
    await page.click(cell);
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    // Do not give the cell's deferred timer a turn. Preserve a backward native
    // range to prove Source mapping carries both endpoints and direction.
    await page.evaluate(selector => {
      const input = document.querySelector<HTMLTextAreaElement>(selector)!;
      input.setSelectionRange(1, 4, 'backward');
    }, cell);
    await page.click('button[data-mode="source"]');
    await page.waitForFunction(() => document.querySelector<HTMLElement>('#app')?.dataset.mode === 'source'
      && !document.querySelector('.meo-md-html-table-shell'));
    await frames(page, 8);

    const mapped = await page.evaluate(() => {
      const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      const native = document.getSelection();
      return {
        text: view.state.doc.toString(),
        ranges: view.state.selection.ranges.map((range: any) => ({ anchor: range.anchor, head: range.head })),
        native: native?.focusNode && view.contentDOM.contains(native.focusNode) ? view.posAtDOM(native.focusNode, native.focusOffset) : null,
        focused: document.activeElement === view.contentDOM
      };
    });
    assert.equal(mapped.text, afterText, 'immediate Source switch must synchronously commit the pending cell input');
    assert.deepEqual(mapped.ranges, [{ anchor: seed + 4, head: seed + 1 }], 'Source mapping must preserve the backward cell range');
    assert.equal(mapped.native, seed + 1, 'Source native head must preserve the backward direction');
    assert.equal(mapped.focused, true, 'Source must own focus after the table widget is removed');

    const undo = await observeReplay(page, () => shortcut(page, 'z'), beforeText, 'pending-cell/source/undo');
    assert.equal(undo.text, beforeText, 'one undo must remove exactly the pending cell input');
    // There was no document edit other than the cell input: a second undo is a
    // no-op, proving the mode transition itself did not add a history item.
    await shortcut(page, 'z');
    await frames(page, 8);
    assert.equal(await page.evaluate(() => (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.state.doc.toString()), beforeText,
      'mode transition must not be a second history entry');

    const redo = await observeReplay(page, () => shortcut(page, 'y'), afterText, 'pending-cell/source/redo');
    assert.equal(redo.text, afterText, 'redo must restore the committed cell input');
    assert.deepEqual(redo.ranges, [{ anchor: seed + 'seedX'.length, head: seed + 'seedX'.length }],
      'redo must place the Source caret at the restored cell end');
    await page.keyboard.type('Q');
    await frames(page, 6);
    const finalText = await page.evaluate(() => (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.state.doc.toString());
    assert.equal(finalText, beforeText.replace('seed', 'seedXQ'), 'first Source key after redo must append at the restored cell caret');
    assert.equal(host.readHost(), finalText, 'host must receive the final accepted text');
    assert.deepEqual(host.errors, [], 'pending table/mode history runtime errors');
  } finally {
    host.dispose();
    await page.close();
  }
  console.log('Pending table → Source history passed: immediate commit, backward mapping, one history entry, stable undo/redo frames');
} catch (error) {
  failure = error;
  throw error;
} finally {
  server.stop(true);
  if (failure === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, failure);
}
