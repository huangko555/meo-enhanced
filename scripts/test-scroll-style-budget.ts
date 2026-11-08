import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeTestBrowser } from './browser-test-helpers';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { assessLargeDocument } from '../src/foundation/largeDocument';

// Measure the browser's actual style work, rather than using a hardware-specific
// wall-clock assertion. CodeMirror adjusts the content's inline virtual padding
// on scroll; this must not invalidate every descendant through an HTML color rule.
const directory = '.local/scroll-style-budget';
fs.mkdirSync(directory, { recursive: true });
const makeText = (sections: number) => Array.from({ length: sections }, (_, index) => [
  `# Reading section ${index}`, '',
  ...Array.from({ length: 4 }, (_, paragraph) =>
    `Paragraph ${index}-${paragraph}. ${'Wrapped 中文 **strong** and [linked text](https://example.test). '.repeat(9)}`), '',
  '| Item | Value |', '| --- | --- |', `| ${index} | A table |`, '',
  '```typescript', 'const value = 1;', '```', '',
  '<div style="color:rgb(12,90,140)"><strong>Authored ink</strong></div>', ''
].join('\n')).join('\n');

const reports: unknown[] = [];
try {
  for (const large of [false, true]) for (const mode of ['source', 'live', 'split', 'preview'] as const) {
    const text = makeText(large ? 120 : 12);
    const assessment = assessLargeDocument(text);
    assert.equal(assessment.lightweightSourceSyntax, large);
    assert.equal(assessment.windowedPreview, large);
    const page = await browser.newPage();
    const host = await open(page, text, false, mode === 'split' ? 'source' : mode);
    try {
      if (mode === 'split') {
        await page.click('.source-preview-button');
        await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('.preview-frame')
          ?.contentDocument?.querySelector('main.meo-export-doc'));
      }
      await frames(page, 8);
      const point = await page.$eval(mode === 'preview' ? '.preview-frame' : '.editor-host .cm-scroller', element => {
        const rect = element.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      });
      const readScroll = () => page.evaluate(preview => preview
        ? document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!.scrollingElement!.scrollTop
        : document.querySelector('.editor-host .cm-scroller')!.scrollTop, mode === 'preview');
      const before = await readScroll();
      await page.mouse.move(point.x, point.y);
      for (let step = 0; step < 12; step++) {
        await page.mouse.wheel({ deltaY: 90 });
        await frames(page, 2);
      }
      await frames(page, 8);
      const distance = await readScroll() - before;
      assert.ok(distance > 800, `${mode}: trusted wheels must move the reading surface`);
      assert.equal(host.readHost(), text, `${mode}: reading must not edit the document`);
      assert.deepEqual(host.errors, []);

      if (mode === 'preview') {
        reports.push({ mode, large, distance });
        if (process.argv.includes('--capture')) await page.screenshot({ path: `${directory}/${mode}-${large}.png` });
        continue;
      }
      // One bounded synchronous probe reproduces the inline style mutation made
      // by the production virtual scroller, without parser/worker timing noise.
      await page.tracing.start({ categories: ['devtools.timeline', 'blink.user_timing'] });
      const contentElements = await page.evaluate(() => {
        const content = document.querySelector<HTMLElement>('.editor-host .cm-content')!;
        const previous = content.style.paddingBottom;
        const count = content.querySelectorAll('*').length;
        performance.mark('scroll-style-budget-start');
        for (let index = 0; index < 4; index++) {
          content.style.paddingBottom = `${30 + index}px`;
          void content.offsetHeight;
        }
        content.style.paddingBottom = previous;
        void content.offsetHeight;
        performance.mark('scroll-style-budget-end');
        return count;
      });
      const traceBytes = await page.tracing.stop();
      assert.ok(traceBytes, 'Chromium must return a style trace');
      const trace = JSON.parse(Buffer.from(traceBytes).toString()) as {
        traceEvents: Array<{ name: string; ts: number; tid: number; dur?: number; args?: { elementCount?: number }; }>;
      };
      const start = trace.traceEvents.find(event => event.name === 'scroll-style-budget-start');
      const end = trace.traceEvents.find(event => event.name === 'scroll-style-budget-end');
      assert.ok(start && end, `${mode}: trace must bracket the synchronous probe`);
      const updates = trace.traceEvents.filter(event => event.name === 'UpdateLayoutTree'
        && event.tid === start.tid && event.ts >= start.ts && event.ts <= end.ts);
      const counts = updates.map(event => event.args?.elementCount ?? 0);
      assert.ok(counts.length >= 4, `${mode}: the probe must exercise real style recalculation`);
      const maximum = Math.max(...counts);
      const durationMs = updates.reduce((sum, event) => sum + (event.dur ?? 0), 0) / 1000;
      reports.push({ mode, large, distance, contentElements, durationMs, maximumStyledElements: maximum });
      console.log(JSON.stringify(reports.at(-1)));
      // The content container alone should be dirty. Allow bounded neighboring
      // chrome, but never a significant part of the visible reading subtree.
      assert.ok(contentElements > 100, `${mode}: fixture must contain enough rendered text`);
      assert.ok(maximum < contentElements / 4,
        `${mode}: virtual padding restyled ${maximum}/${contentElements} reading elements`);

      // Overview markers are replaced during ordinary scrolling, even with no
      // diff hunks. Their DOM must not invalidate every line-number descendant
      // through an editor-wide :has() rule.
      await page.tracing.start({ categories: ['devtools.timeline', 'blink.user_timing'] });
      const gutterElements = await page.evaluate(() => {
        const editor = document.querySelector<HTMLElement>('.editor-host .cm-editor')!;
        const marker = document.createElement('div');
        marker.className = 'meo-git-overview-ruler';
        editor.append(marker);
        void editor.offsetHeight;
        const count = editor.querySelectorAll('.cm-gutterElement').length;
        performance.mark('scroll-gutter-budget-start');
        for (let index = 0; index < 4; index++) {
          const end = document.createElement('div');
          end.className = 'meo-git-overview-ruler-file-end';
          marker.replaceChildren(end);
          void editor.offsetHeight;
        }
        performance.mark('scroll-gutter-budget-end');
        marker.remove();
        return count;
      });
      const gutterTraceBytes = await page.tracing.stop();
      assert.ok(gutterTraceBytes);
      const gutterTrace = JSON.parse(Buffer.from(gutterTraceBytes).toString()) as typeof trace;
      const gutterStart = gutterTrace.traceEvents.find(event => event.name === 'scroll-gutter-budget-start');
      const gutterEnd = gutterTrace.traceEvents.find(event => event.name === 'scroll-gutter-budget-end');
      assert.ok(gutterStart && gutterEnd);
      const gutterCounts = gutterTrace.traceEvents.filter(event => event.name === 'UpdateLayoutTree'
        && event.tid === gutterStart.tid && event.ts >= gutterStart.ts && event.ts <= gutterEnd.ts)
        .map(event => event.args?.elementCount ?? 0);
      assert.ok(gutterCounts.length >= 4, 'Overview updates must exercise actual style recalculation');
      const maximumGutterStyledElements = Math.max(...gutterCounts);
      console.log(JSON.stringify({ mode, large, gutterElements, maximumGutterStyledElements }));
      assert.ok(gutterElements > 20, 'The reading surface must contain enough line-number elements');
      assert.ok(maximumGutterStyledElements < gutterElements / 2,
        `${mode}: overview updates restyled ${maximumGutterStyledElements}/${gutterElements} gutter elements`);
      Object.assign(reports.at(-1) as object, { gutterElements, maximumGutterStyledElements });
      if (process.argv.includes('--capture')) await page.screenshot({ path: `${directory}/${mode}-${large}.png` });
    } finally { host.dispose(); await page.close(); }
  }
  console.log('Continuous reading and virtual-scroll style budgets passed in all four views');
} finally {
  fs.writeFileSync(`${directory}/result.json`, `${JSON.stringify(reports, null, 2)}\n`);
  await closeTestBrowser(browser);
  server.stop(true);
}
