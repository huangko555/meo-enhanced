import assert from 'node:assert/strict';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { browser, server, open, frames, assertStableHistoryPaint, observedPaints } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';
import { captureHistoryInteraction, assertHistoryRoundTrip, assertHistoryCoverage } from './history-interaction-contract';
import { historyFormatCases, formattedHistoryRange } from './history-format-cases';

const target = 'format target', formats = historyFormatCases(target), receipts: string[] = [];
const cases = [...formats.map(([action, formatted]) => ({ action, body: target, formatted,
  beforeRanges: [action === 'bold' ? { anchor: target.length, head: 0 } : { anchor: 0, head: target.length }],
  afterRanges: [formattedHistoryRange(action, formatted, target)], mainIndex: 0 })),
{ action: 'native-ranges', body: 'alpha beta', formatted: '(alpha) (beta)',
  beforeRanges: [{ anchor: 5, head: 0 }, { anchor: 6, head: 10 }],
  afterRanges: [{ anchor: 6, head: 1 }, { anchor: 9, head: 13 }], mainIndex: 1 }];
const modes = ['source', 'live'] as const, scales = [false, true];
const label = (mode: string, large: boolean, action: string) => `format ${mode}/large=${large}/${action}`;
const expectedReceipts = modes.flatMap(mode => scales.flatMap(large => cases.map(({ action }) => label(mode, large, action))));
let failure: unknown;


try {
  for (const mode of modes) for (const large of scales) for (const { action, body, formatted, beforeRanges, afterRanges, mainIndex } of cases) {
    const prefix = '# Before\n\n' + 'Earlier paragraph.\n\n'.repeat(55) + '## HISTORY_WITNESS\n\nBetween witness and target.\n\n';
    const suffix = '\n\n' + (large ? 'Padding.\n'.repeat(8100) : 'After.\n\n'.repeat(30));
    const text = prefix + body + suffix, afterText = prefix + formatted + suffix;
    assert.equal(assessLargeDocument(text).boundedEditorWork, large, 'Use the actual production size policy');
    const page = await browser.newPage(), host = await open(page, text, false, mode);
    const surface = { witness: 'HISTORY_WITNESS' }, id = label(mode, large, action);
    try {
      const offsetRanges = (ranges: Array<{ anchor: number; head: number }>) => ranges.map(range => ({ anchor: range.anchor + prefix.length, head: range.head + prefix.length }));
      await page.evaluate(({ ranges, mainIndex }) => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        const Selection = view.state.selection.constructor;
        view.focus(); view.dispatch({ selection: Selection.create(ranges.map((range: any) => Selection.range(range.anchor, range.head)), mainIndex), scrollIntoView: true });
      }, { ranges: offsetRanges(beforeRanges), mainIndex });
      if (action !== 'native-ranges') await page.waitForSelector('.selection-inline-menu.is-visible');
      await frames(page, 8);
      const clip = await page.evaluate(() => {
        const node = [...document.querySelectorAll<HTMLElement>('.editor-host .cm-line')].find(line => line.textContent?.includes('HISTORY_WITNESS'))!;
        // Keep the unchanged witness on the same compositor text-raster path.
        node.style.willChange = 'transform';
        const rect = node.getBoundingClientRect();
        return { left: Math.ceil(rect.left), top: Math.ceil(rect.top), width: Math.floor(rect.width), height: Math.floor(rect.height) };
      });
      await frames(page, 3);
      const before = await captureHistoryInteraction(page, surface);
      assert.deepEqual(before.ranges, offsetRanges(beforeRanges), id + ': initial selection');
      assert.equal(before.mainIndex, mainIndex, id + ': initial primary range');
      if (action === 'native-ranges') await page.keyboard.type('(');
      else await page.click(`.selection-inline-button[data-action="${action}"]`);
      await frames(page, 8);
      const after = await captureHistoryInteraction(page, surface);
      assert.equal(after.text, afterText, id + ': exact formatting');
      assert.deepEqual(after.ranges, offsetRanges(afterRanges), id + ': intended selection');
      assert.equal(after.mainIndex, mainIndex, id + ': intended primary range');
      await assertHistoryRoundTrip(page, { ...surface, label: id, before, after,
        observePaint: (action, direction) => assertStableHistoryPaint(page, clip, action, id + '/' + direction) }); receipts.push(id);
      assert.deepEqual(host.errors, [], id + ': no runtime errors');
    } finally { host.dispose(); await page.close(); }
  }
  assertHistoryCoverage(expectedReceipts);
  console.log(`Production command history passed: ${receipts.length} cases, ${observedPaints} compositor frames, both modes and actual ordinary/optimized Worker paths`);
} catch (error) { failure = error; throw error; }
finally { server.stop(true); if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure); }
