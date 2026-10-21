import assert from 'node:assert/strict';
import { closeTestBrowser } from './browser-test-helpers';
import { createLargeDocumentFixtures } from './large-document-fixtures';
import { browser, server, open, frames, assertStablePaint, captureResult, observedPaints } from './input-presentation-test-helpers';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const composite = createLargeDocumentFixtures().find(fixture => fixture.kind === 'composite')!.text;
const header = '| Record | Value | Status | Description |';
const text = Array(3).fill(composite).join('\n\n') + '\n\n# Editing session\n\n'
  + [header, '| --- | --- | --- | --- |', ...Array.from({ length: 32 }, (_, index) =>
    `| item-${index + 1} | ${2401 + index} | stable | Description **bold**, \`code_${index}\`, $x+${index}$ |`),
  '', 'After long table.', '', 'Tail.\n\n'.repeat(100)].join('\n');
const wideHeader = '| ID | Identifier | Category | Source | Created | Updated | Version | Description |';
const wideText = text + '\n\n' + [wideHeader, '| --- | --- | --- | --- | --- | --- | --- | --- |',
  `| 1 | ${'long_identifier_0123456789_'.repeat(50)} | meta | source | 2026-01-01 | 2026-01-02 | 1.0.0 | Description |`,
  '', 'After wide table.', '', 'Tail.\n\n'.repeat(100)].join('\n');
assert.ok(Buffer.byteLength(text) > 1_000_000, 'exercise the real large-document presentation window');

let primary: unknown, stage = 'startup';
try {
  const only = process.argv.find(argument => argument.startsWith('--only='))?.slice(7);
  for (const scene of [0, 1, 2]) {
    const tall = scene === 2, row = tall ? 0 : scene, column = tall ? 0 : 1;
    if (only && only !== String(scene) && !(tall && only === 'tall')) continue;
    const source = tall ? wideText : text, activeHeader = tall ? wideHeader : header;
    const headerFrom = source.indexOf(activeHeader), headerLine = source.slice(0, headerFrom).split('\n').length;
    stage = tall ? 'overgrown narrow table header' : `native table editing session row ${row}`;
    const page = await browser.newPage(), host = await open(page, source);
    try {
      await page.setViewport({ width: 780, height: 570 });
      await page.bringToFront();
      await page.evaluate(from => {
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        view.dispatch({ selection: { anchor: from }, scrollIntoView: true }); view.focus();
      }, headerFrom);
      await delay(600);
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.evaluate(() => {
          const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
          view.scrollDOM.scrollTop += view.coordsAtPos(view.state.selection.main.head).top - view.scrollDOM.getBoundingClientRect().top - 120;
        }); await delay(250);
      }
      await page.locator('.mode-group [data-mode="live"]').click();
      await page.waitForFunction(() => document.querySelector('.editor-host > .cm-editor.meo-mode-live')
        && !document.querySelector('.mode-group [aria-busy="true"]'));
      const shell = `.meo-md-html-table-shell[data-meo-rendered-block-start-line="${headerLine}"]`;
      const selector = `${shell} textarea[data-table-row="${row}"][data-table-col="${column}"]`;
      await page.waitForSelector(selector);
      for (let attempt = 0; attempt < 3; attempt++) {
        await page.evaluate(selector => {
          const input = document.querySelector<HTMLElement>(selector)!;
          document.querySelector('.editor-host .cm-scroller')!.scrollTop += input.getBoundingClientRect().top - 120;
        }, selector); await delay(250);
      }
      const point = await page.$eval(selector, input => { const r = input.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + 10 }; });
      await page.mouse.click(point.x, point.y); await page.keyboard.press('End'); await frames(page, 8);
      const baseline = await page.evaluate(selector => {
        const scope = window as any, input = document.querySelector<HTMLTextAreaElement>(selector)!;
        const view = (document.querySelector('.editor-host .cm-content') as any).cmTile.root.view;
        scope.__sessionSamples = []; scope.__presentationFrames = scope.__sessionSamples; scope.__sessionSampling = true;
        const start = performance.now();
        scope.__sessionStartedAt = start;
        const read = () => ({ t: performance.now() - start, connected: input.isConnected,
          active: document.activeElement === input, top: input.getBoundingClientRect().top,
          bottom: input.getBoundingClientRect().bottom, height: input.getBoundingClientRect().height,
          viewportTop: view.scrollDOM.getBoundingClientRect().top, viewportBottom: view.scrollDOM.getBoundingClientRect().bottom,
          sticky: input.closest('.meo-md-html-table-shell')!.querySelector('.meo-md-html-table-sticky-chrome')!.classList.contains('is-visible'),
          scroll: view.scrollDOM.scrollTop, value: input.value, start: input.selectionStart, end: input.selectionEnd });
        const sample = () => { if (!scope.__sessionSampling) return;
          setTimeout(() => { if (scope.__sessionSampling) scope.__sessionSamples.push(read()); }, 0); requestAnimationFrame(sample);
        }; requestAnimationFrame(sample); return read();
      }, selector);
      // Unedited header glyphs remain at the same Y even as the active header
      // wraps and grows. Compare paints throughout typing and its late commits.
      const clip = await page.$eval(`${shell} .meo-md-html-table:not(.meo-md-html-table-sticky-table) thead th[data-table-col="0"] .meo-md-html-table-cell-preview`, element => {
        const range = document.createRange(); range.selectNodeContents(element);
        const rect = range.getBoundingClientRect();
        return { left: Math.floor(rect.left), top: Math.floor(rect.top), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
      });
      const digits = '1234567890'.repeat(10);
      let typingEndedAt = 0;
      const typeAndSettle = async () => {
        await page.keyboard.type(digits, { delay: 3 });
        typingEndedAt = await page.evaluate(() => performance.now() - (window as any).__sessionStartedAt);
        await delay(8000); // Include auto-commit, worker acceptance and later band/height updates.
      };
      if (tall) await typeAndSettle();
      else await assertStablePaint(page, clip, typeAndSettle, stage);
      const samples = await page.evaluate(() => { const scope = window as any; scope.__sessionSampling = false; return scope.__sessionSamples as typeof baseline[]; });
      assert.ok(samples.length > 30, `${stage}: observe the full quiet interval`);
      for (const sample of samples) {
        assert.ok(sample.connected && sample.active, `${stage}: background presentation removed the editing surface`);
        if (!tall) assert.ok(Math.abs(sample.top - baseline.top) <= 1, `${stage}: active cell moved: ${JSON.stringify(sample)}`);
        assert.equal(sample.start, sample.end, `${stage}: native selection changed`);
      }
      assert.equal(samples.at(-1)!.value, baseline.value + digits);
      assert.equal(samples.at(-1)!.start, baseline.value.length + digits.length, `${stage}: retain the final caret`);
      if (tall) {
        const final = samples.at(-1)!;
        assert.ok(final.height > final.viewportBottom - final.viewportTop, `${stage}: exercise a header taller than its viewport`);
        assert.ok(final.bottom <= final.viewportBottom + 2, `${stage}: retain the end caret in view`);
        assert.ok(samples.every(sample => !sample.sticky), `${stage}: never cover the focused primary header with its clone`);
        for (let index = 1; index < samples.length; index++) assert.ok(samples[index]!.top <= samples[index - 1]!.top + 1,
          `${stage}: competing caret reveals reversed scrolling`);
        const quiet = samples.filter(sample => sample.t > typingEndedAt + 100);
        assert.ok(Math.max(...quiet.map(sample => sample.top)) - Math.min(...quiet.map(sample => sample.top)) <= 1,
          `${stage}: continued moving after input`);
      }
      const expectedLines = source.split('\n'), editedLine = headerLine - 1 + (row === 0 ? 0 : 2);
      expectedLines[editedLine] = expectedLines[editedLine]!.replace(`| ${baseline.value} |`, `| ${baseline.value + digits} |`);
      assert.equal(host.readHost(), expectedLines.join('\n'), `${stage}: commit exact accepted source`);
      const tail = samples.filter(sample => sample.t > samples.at(-1)!.t - 2000).map(sample => sample.scroll);
      assert.ok(Math.max(...tail) - Math.min(...tail) <= 1, `${stage}: continued scrolling after settlement`);
      await captureResult(page, `input-session-${scene}`);
      // A held editing session must yield immediately to actual wheel input.
      const beforeWheel = samples.at(-1)!.scroll;
      await page.mouse.move(730, 450); await page.mouse.wheel({ deltaY: 700 }); await delay(600);
      const afterWheel = await page.$eval('.editor-host .cm-scroller', element => element.scrollTop);
      assert.ok(Math.abs(afterWheel - beforeWheel) > 100, `${stage}: editing ownership blocked user scrolling`);
      assert.deepEqual(host.errors, []);
    } finally { host.dispose(); await page.close(); }
  }
  console.log(`Native input sessions: late commits, stable paint, exact source and user scrolling passed (${observedPaints} paints)`);
} catch (error) { primary = error; console.error('Input session failed during:', stage); throw error; }
finally { server.stop(true); if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
