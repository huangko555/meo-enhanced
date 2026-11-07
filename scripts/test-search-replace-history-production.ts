import assert from 'node:assert/strict';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';
import { assertHistoryRoundTrip, captureHistoryInteraction } from './history-interaction-contract';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

type ReplaceFixture = { beforeText: string; afterFocus: 'document' | 'table'; label: string; large: boolean };

function plainFixture(large: boolean): ReplaceFixture {
  const prefix = '# Search history\n\n' + 'Earlier paragraph.\n\n'.repeat(58) + '## HISTORY_WITNESS\n\nneedle first\n\n';
  const between = 'Unchanged intervening line.\n'.repeat(52);
  const suffix = '\nneedle second\n\n' + (large ? 'Tail padding.\n'.repeat(8_100) : 'Tail paragraph.\n'.repeat(35));
  return { beforeText: prefix + between + suffix, afterFocus: 'document', label: 'plain', large };
}

function tableBoundaryFixture(next: 'outside' | 'table'): ReplaceFixture {
  const prefix = '# Search table boundary\n\n' + 'Earlier paragraph.\n\n'.repeat(18) + '## HISTORY_WITNESS\n\n';
  const table = (value: string) => `| A | B |\n| --- | --- |\n| ${value} | stable |\n`;
  const gap = '\n' + 'Unchanged intervening line.\n'.repeat(48) + '\n';
  return next === 'outside'
    ? { beforeText: prefix + table('needle first') + gap + 'needle second\n', afterFocus: 'document', label: 'table-to-outside', large: false }
    : { beforeText: prefix + 'needle first\n' + gap + table('needle second'), afterFocus: 'table', label: 'outside-to-table', large: false };
}

async function press(page: import('puppeteer-core').Page, key: string): Promise<void> {
  await page.keyboard.down(modifier);
  try { await page.keyboard.press(key); }
  finally { await page.keyboard.up(modifier); }
}

async function assertTableMatch(page: import('puppeteer-core').Page, text: string, position: number): Promise<void> {
  const lineFrom = text.lastIndexOf('\n', position - 1) + 1;
  if (!text.slice(lineFrom).startsWith('| ')) return;
  const line = text.slice(0, position).split('\n').length;
  // These fixtures deliberately put an unescaped match at offset 0 of body
  // cell (1, 0). The mounted row, native cell range and active mark establish
  // which source target owns a block-widget DOM projection.
  await page.waitForFunction(({ line, position, text }) => {
    const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
    if (view.state.doc.toString() !== text) return false;
    const cells = [...view.contentDOM.querySelectorAll(`.meo-md-html-table:not(.meo-md-html-table-sticky-table) tr[data-source-line-number="${line}"] textarea[data-table-row="1"][data-table-col="0"]`)] as HTMLTextAreaElement[];
    if (cells.length !== 1) return false;
    const input = cells[0]!;
    const table = input.closest('table')!;
    const mark = input.closest('td')?.querySelector('.meo-search-match-active');
    return Number(table.dataset.tableFrom) <= position && Number(table.dataset.tableTo) >= position + 6
      && input === document.activeElement && input.selectionStart === 0 && input.selectionEnd === 6
      && input.value.slice(0, 6) === 'needle' && mark?.textContent === 'needle';
  }, {}, { line, position, text });
}

/**
 * A replacement is one history entry, but its accepted post-action selection
 * deliberately belongs to the *next* remaining match.  That target can be
 * far outside the changed range, so ordinary history fallback rules must not
 * rewrite it during redo.
 */
async function checkReplaceHistory(mode: 'source' | 'live', fixture: ReplaceFixture): Promise<void> {
  const { beforeText, afterFocus, label: fixtureLabel, large } = fixture;
  // A rendered cell must own table-match typing; CodeMirror's document DOM
  // cannot represent source characters replaced by the whole-table widget.
  const beforeFocus = fixtureLabel === 'table-to-outside' ? 'table' : 'document';
  const afterText = beforeText.replace('needle first', 'changed first');
  assert.equal(assessLargeDocument(beforeText).boundedEditorWork, large, 'fixture must use the real optimized-Worker policy');

  const first = beforeText.indexOf('needle'), secondBefore = beforeText.indexOf('needle', first + 1);
  const secondAfter = afterText.indexOf('needle', first + 1);
  assert.ok(first >= 0 && secondBefore > first && secondAfter > first, 'two complete matches are required');
  const page = await browser.newPage();
  const host = await open(page, beforeText, false, mode);
  // Replacement deliberately navigates from the first match to a target more
  // than one screen away.  There is no unchanged mounted-line witness across
  // that legitimate reveal; the contract's reveal mode still observes every
  // accepted-document frame and rejects direction reversal.
  const surface = { witness: null };
  const id = `replace-next-selection/${fixtureLabel}/${mode}/large=${large}`;
  console.log('START ' + id);
  try {
    // Use the product shortcut and controls, not its test-only editor handle.
    await page.evaluate(() => {
      const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
      view.focus();
    });
    await press(page, 'h');
    await page.waitForSelector('.find-panel.is-visible input[aria-label="Find"]');
    await page.type('.find-panel.is-visible input[aria-label="Find"]', 'needle');
    // Enter's focusEditor:false is intentionally not part of this receipt;
    // the explicit next-match command establishes the editor-owned target.
    await page.click('.find-panel.is-visible button[data-tooltip="Next match"]');
    await page.waitForFunction(expected => {
      const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      return view.state.selection.main.from === expected && view.state.selection.main.to === expected + 'needle'.length
    }, {}, first);
    await page.type('.find-panel.is-visible input[aria-label="Replace"]', 'changed');
    // Filling the replacement field moves native focus away from the document.
    // Re-establish the *actual* first-match selection through the public
    // navigation controls before capturing the history boundary.
    await page.click('.find-panel.is-visible button[data-tooltip="Next match"]');
    await page.click('.find-panel.is-visible button[data-tooltip="Previous match"]');
    await page.waitForFunction(expected => {
      const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
      return view.state.selection.main.from === expected && view.state.selection.main.to === expected + 'needle'.length
    }, {}, first);
    await frames(page, 5);
    const before = await captureHistoryInteraction(page, surface);
    assert.equal(before.text, beforeText, id + ': initial document');
    assert.deepEqual(before.ranges, [{ anchor: first, head: first + 'needle'.length }], id + ': initial full match selection');
    assert.equal(before.focus.kind, beforeFocus, id + ': initial search surface');
    await assertTableMatch(page, beforeText, first);

    await page.click('.find-panel.is-visible button[data-tooltip="Replace current match"]');
    await frames(page, 8);
    const after = await captureHistoryInteraction(page, surface);
    assert.equal(after.text, afterText, id + ': replacement must be accepted exactly once');
    assert.deepEqual(after.ranges, [{ anchor: secondAfter, head: secondAfter + 'needle'.length }], id + ': next remaining full match selection');
    assert.equal(after.focus.kind, afterFocus, id + ': replacement must restore the selected search surface');
    await assertTableMatch(page, afterText, secondAfter);
    assert.notEqual(secondAfter, first + 'changed'.length, id + ': remaining target must be outside the changed range');

    // The shared contract observes every rAF frame after each native history
    // transaction, so a transient changed-range caret cannot hide behind the
    // final selection.  Toolbar then keyboard cover both entry points.
    await assertHistoryRoundTrip(page, { ...surface, label: id, before, after, viewport: 'reveal', trigger: 'toolbar',
      settle: direction => assertTableMatch(page, direction === 'undo' ? beforeText : afterText, direction === 'undo' ? first : secondAfter) });
    await page.keyboard.sendCharacter('Q');
    const typed = afterText.slice(0, secondAfter) + 'Q' + afterText.slice(secondAfter + 'needle'.length);
    try {
      await page.waitForFunction(text => (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view.state.doc.toString() === text, {}, typed);
    } catch (error) {
      const state = await page.evaluate(({ first, secondAfter, expectedLength }) => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        return { first: view.state.doc.sliceString(first - 5, first + 35), second: view.state.doc.sliceString(secondAfter - 5, secondAfter + 35),
          lengthDelta: view.state.doc.length - expectedLength, ranges: view.state.selection.ranges,
          active: document.activeElement?.className, focused: document.hasFocus() };
      }, { first, secondAfter, expectedLength: typed.length });
      console.error(JSON.stringify({ id, typingFailure: state, errors: host.errors }));
      throw error;
    }
    await frames(page, 4);
    assert.equal(host.readHost(), typed, id + ': typing after redo must replace the semantic next match');
    assert.deepEqual(host.errors, [], id + ': runtime errors');
  } finally {
    host.dispose();
    await page.close();
  }
}

let failure: unknown;
try {
  // The issue is a source-history semantic, and Live large documents exercise
  // the production split Worker path that must preserve the same selection.
  await checkReplaceHistory('source', plainFixture(false));
  await checkReplaceHistory('live', plainFixture(true));
  await checkReplaceHistory('live', tableBoundaryFixture('outside'));
  await checkReplaceHistory('live', tableBoundaryFixture('table'));
  console.log('Search replacement history passed: Source ordinary, Live optimized Worker, and table-boundary next-match selection through undo/redo');
} catch (error) {
  failure = error;
  throw error;
} finally {
  server.stop(true);
  if (failure === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, failure);
}
