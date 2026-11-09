import assert from 'node:assert/strict';
import fs from 'node:fs';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { browser, server, open, frames } from './input-presentation-test-helpers';
import { closeTestBrowser } from './browser-test-helpers';

// Keep the semantic list root fixed while its reading band moves. Its distant
// widgets must become real content even though no new top-level root enters.
function fixture(lines: number, mermaid = false, nestedEnd = 600, quote = false): string {
  const rows = Array.from({ length: lines }, (_, index) => index % 2 ? '' : `Reading paragraph ${index}.`);
  rows[249] = '- Containing list:';
  for (let index = 250; index < Math.min(lines - 20, nestedEnd); index++) {
    rows[index] = index % 2 ? '' : `  Continued paragraph ${index}.`;
  }
  const content = mermaid
    ? ['  ```mermaid', '  flowchart LR', '    A[Start] --> B[Check] --> C[Done]', '  ```']
    : ['  | Metric | Value |', '  | --- | ---: |', '  | Sample | 8 |', '  | Pass | 6 |', '', '  $$', '  r=6/8', '  $$', '',
      '  ```typescript', '  const viewportContent = true;', '  ```', '', '  - [ ] Viewport task', '', '  <div>Viewport HTML content</div>', ''];
  rows.splice(348, content.length, ...content);
  if (quote) for (let index = 249; index < nestedEnd; index++) rows[index] = '> ' + rows[index];
  return rows.join('\n');
}

type Sample = { time: number; phase: string; scrolling: boolean; placeholders: number; targets: Array<{ line: number; visible: boolean; ready: boolean }> };
const reports: unknown[] = [], failures: string[] = [];
let primaryError: unknown;
try {
  for (const { large, mermaid, giant = false, quote = false } of [
    ...[false, true].flatMap(large => [false, true].map(mermaid => ({ large, mermaid }))),
    { large: true, mermaid: false, giant: true },
    { large: true, mermaid: false, giant: true, quote: true }
  ]) {
    const text = fixture(giant ? 12_000 : large ? 2_400 : 450, mermaid, giant ? 10_000 : 600, quote);
    assert.equal(assessLargeDocument(text).boundedEditorWork, large, 'Exercise both production policy paths');
    const page = await browser.newPage(), host = await open(page, text, false, 'live');
    const name = `${quote ? 'giant-quote-list' : giant ? 'giant-list' : large ? 'optimized' : 'ordinary'}-${mermaid ? 'mermaid' : 'table-math'}`;
    try {
      await frames(page, 12);
      await page.evaluate(({ mermaid, giant }) => {
        const scope = window as any;
        const view = document.querySelector<any>('.editor-host .cm-content').cmTile.root.view;
        const probe: any = scope.__visibleContent = { active: true, phase: 'outside', samples: [], wheels: [], lastWheel: -Infinity };
        if (giant) {
          let prototype = Object.getPrototypeOf(view.state.doc);
          while (!Object.prototype.hasOwnProperty.call(prototype, 'line')) prototype = Object.getPrototypeOf(prototype);
          const original = prototype.line;
          const iterate = prototype.iterLines;
          probe.reads = 0; probe.rows = 0; probe.countReads = false;
          prototype.line = function(...args: any[]) { if (probe.countReads && this === view.state.doc) probe.reads++; return original.apply(this, args); };
          prototype.iterLines = function(...args: any[]) {
            const iterator = iterate.apply(this, args), next = iterator.next, document = this;
            iterator.next = function(...parameters: any[]) {
              const result = next.apply(this, parameters);
              if (probe.countReads && document === view.state.doc && !result.done) probe.rows++;
              return result;
            };
            return iterator;
          };
          probe.restore = () => { prototype.line = original; prototype.iterLines = iterate; };
        }
        const wheel = (event: WheelEvent) => { probe.wheels.push(event.isTrusted); probe.lastWheel = performance.now(); };
        view.scrollDOM.addEventListener('wheel', wheel, { passive: true });
        probe.stop = () => { probe.active = false; probe.restore?.(); view.scrollDOM.removeEventListener('wheel', wheel); };
        const sample = () => {
          if (!probe.active) return;
          const bounds = view.scrollDOM.getBoundingClientRect();
          const targets = (mermaid ? [349] : [349, 354, 358, 362, 364]).map(line => {
            const block = view.lineBlockAt(view.state.doc.line(line).from), top = view.documentTop + block.top;
            const visible = top < bounds.bottom - 5 && top + block.height > bounds.top + 5;
            let ready = false;
            if (mermaid || line === 349) {
              const element = view.dom.querySelector(`[data-meo-rendered-block-start-line="${line}"]`);
              ready = mermaid ? !!element?.querySelector('.meo-mermaid-svg-wrapper svg') : !!element?.querySelector('table td');
            } else if (line === 354) {
              ready = [...view.dom.querySelectorAll('.katex-display')].some((node: any) => {
                try { return view.state.doc.lineAt(view.posAtDOM(node)).number === line && !!node.querySelector('.katex-html'); }
                catch { return false; }
              });
            } else if (line === 364) ready = !!view.dom.querySelector('[data-meo-rendered-block-start-line="364"] .meo-md-html-content')?.textContent?.includes('Viewport HTML');
            else ready = [...view.dom.querySelectorAll(line === 358 ? '.meo-copy-code-btn' : 'input[type="checkbox"]')].some((node: any) => {
              try { return view.state.doc.lineAt(view.posAtDOM(node)).number === line; } catch { return false; }
            });
            return { line, visible, ready };
          });
          const placeholders = [...view.dom.querySelectorAll('.meo-live-viewport-placeholder')].filter((node: any) => {
            const rect = node.getBoundingClientRect(); return rect.height > 0 && rect.top < bounds.bottom - 5 && rect.bottom > bounds.top + 5;
          }).length;
          probe.samples.push({ time: performance.now(), phase: probe.phase, scrolling: performance.now() - probe.lastWheel < 250, targets, placeholders });
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      }, { mermaid, giant });
      const point = await page.$eval('.editor-host .cm-scroller', node => {
        const bounds = node.getBoundingClientRect(); return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
      });
      await page.mouse.move(point.x, point.y);
      for (const phase of ['cold', 'warm', 'reverse']) {
        // This only positions the approach. The targets enter through trusted
        // native wheel movement, with the original caret left at the start.
        await page.evaluate(({ mermaid, phase }) => {
          const view = document.querySelector<any>('.editor-host .cm-content').cmTile.root.view;
          (window as any).__visibleContent.phase = 'outside';
          view.dispatch({ effects: view.constructor.scrollIntoView(view.state.doc.line(phase === 'reverse' ? 430 : mermaid ? 275 : 180).from, { y: 'start', yMargin: 120 }) });
        }, { mermaid, phase });
        await frames(page, 24);
        await page.evaluate(phase => { const probe = (window as any).__visibleContent; probe.phase = phase; probe.countReads = true; }, phase);
        for (let index = 0; index < 72; index++) {
          const delta = await page.evaluate(index => {
            const view = document.querySelector<any>('.editor-host .cm-content').cmTile.root.view;
            const top = view.documentTop + view.lineBlockAt(view.state.doc.line(349).from).top - view.scrollDOM.getBoundingClientRect().top;
            return top > 430 ? 100 : top < 140 ? -80 : Math.floor(index / 6) % 2 ? -24 : 24;
          }, index);
          await page.mouse.wheel({ deltaY: delta });
          await new Promise(resolve => setTimeout(resolve, 12));
        }
        await page.evaluate(() => { const probe = (window as any).__visibleContent; probe.phase += '-stopped'; probe.countReads = false; });
        await new Promise(resolve => setTimeout(resolve, 800));
      }
      const observation = await page.evaluate(() => {
        const probe = (window as any).__visibleContent; probe.stop(); return { samples: probe.samples as Sample[], wheels: probe.wheels as boolean[], reads: probe.reads as number | undefined, rows: probe.rows as number | undefined };
      });
      assert.equal(observation.wheels.length, 216);
      assert.ok(observation.wheels.every(Boolean), 'Use browser-delivered wheel input');
      assert.equal(host.readHost(), text, 'Reading must not mutate the document');
      assert.deepEqual(host.errors, []);
      const groups = ['cold', 'warm', 'reverse'].flatMap(phase => (mermaid ? [349] : [349, 354, 358, 362, 364]).map(line => {
        const visible = observation.samples.filter(sample => sample.phase === phase && sample.scrolling && sample.targets.some(target => target.line === line && target.visible));
        const ready = visible.filter(sample => sample.targets.some(target => target.line === line && target.ready));
        const firstReady = ready[0]?.time, firstVisible = visible[0]?.time;
        const delay = firstReady === undefined || firstVisible === undefined ? null : firstReady - firstVisible;
        const blankBeforeReady = visible.filter(sample => sample.time < (firstReady ?? Infinity)).length;
        const blankAfterReady = visible.filter(sample => sample.time >= (firstReady ?? Infinity) && !sample.targets.some(target => target.line === line && target.ready)).length;
        const result = { phase, line, frames: visible.length, ready: ready.length, delay, blankBeforeReady, blankAfterReady };
        // Cold Mermaid may load its real local runtime; warmed results and
        // synchronous table/formula widgets must fill during the wheel stream.
        if (visible.length < 8 || ready.length < 8 || (!mermaid || phase !== 'cold') && blankBeforeReady > 4 || blankAfterReady > 1) {
          failures.push(`${name}: ${JSON.stringify(result)}`);
        }
        return result;
      }));
      const placeholderFrames = observation.samples.filter(sample => sample.phase !== 'outside' && sample.scrolling && sample.placeholders > 0).length;
      if (placeholderFrames > 4) failures.push(`${name}: ${placeholderFrames} visible placeholder frames`);
      if (giant && observation.reads! + observation.rows! > 20_000) failures.push(`${name}: reading rebuilt distant list content (${observation.reads} line reads, ${observation.rows} iterated rows)`);
      reports.push({ name, groups, placeholderFrames, reads: observation.reads, rows: observation.rows });
      console.log(JSON.stringify({ name, groups, placeholderFrames, reads: observation.reads, rows: observation.rows }));
    } finally { host.dispose(); await page.close(); }
  }
  assert.deepEqual(failures, [], 'Visible content must appear during continuous scrolling, in cold and warm windows');
} catch (error) { primaryError = error; }
finally {
  const directory = '.local/test-artifacts/live-viewport-content'; fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(`${directory}/latest.json`, JSON.stringify({ passed: primaryError === undefined, reports, failures }, null, 2));
  try { if (primaryError === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primaryError); }
  finally { server.stop(true); }
}
