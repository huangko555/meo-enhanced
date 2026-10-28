import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { assessLargeDocument } from '../src/foundation/largeDocument';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let failure: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 950, height: 800 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: fs.readFileSync('node_modules/katex/dist/katex.min.css', 'utf8')
    .replace(/url\((fonts\/[^)]+)\)/g, (_match, file) => `url(data:font/${path.extname(file).slice(1)};base64,${fs.readFileSync(path.join('node_modules/katex/dist', file)).toString('base64')})`) });
  await page.addStyleTag({ content: ':root{--meo-font-live:Arial;--meo-font-source:Consolas,monospace;--meo-font-live-size:16px;--meo-font-source-size:14px}' });
  await page.addStyleTag({ content: '[data-pointer-layout-target]{background:#ff00ff!important}' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const frames = (count = 10) => page.evaluate(async count => {
    for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame);
  }, count);
  const failures: string[] = [];
  const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
  let cases = 0, paintedFrames = 0;
  for (const large of [false, true]) for (const kind of ['footnote', 'math'] as const) {
    if (only && only !== kind) continue;
    for (const length of kind === 'footnote' ? [1, 8] : [1, 26]) {
      if (process.argv.includes('--minimal') && length !== 1) continue;
      const block = kind === 'footnote' ? (length === 1 ? '' : length === 8 ? '# ' : '')
        + 'CLICK HERE with a footnote[^long-note-reference].' + (length === 26 ? ' More prose with note[^long-note-reference].'.repeat(8) : '')
        : '$$\n' + Array.from({ length }, () => '\\frac{a+b}{c+d}').join(' + ') + '\n$$';
      const prefix = Array.from({ length: 40 }, (_, i) => `Before paragraph ${i}\n`).join('\n') + '\n'
        + (kind === 'footnote' ? 'PREVIOUS ' + 'text[^long-note-reference] '.repeat(20) + '\n\n' : '');
      const text = prefix + block + '\n\nAFTER TARGET\n\n' + Array.from({ length: large ? 12000 : 60 }, (_, i) => `Following ${i}\n`).join('\n')
        + '\n[^long-note-reference]: Note.';
      const label = `${large ? 'large' : 'ordinary'}/${kind}/${length}`;
      assert.equal(assessLargeDocument(text).boundedEditorWork, large, label + ': production size policy');
      const body = prefix.length + (kind === 'math' ? 3 : length === 8 ? 2 : 0);
      const after = text.indexOf('AFTER TARGET');
      await page.evaluate(text => {
        const w = window as any;
        w.ed?.destroy(); document.getElementById('app')!.replaceChildren();
        w.ed = w.MermaidEditingHarness.createEditor({ parent: document.getElementById('app'), text,
          initialMode: 'live', sourceLineNumbers: 'on', onApplyChanges() {} });
      }, text);
      await frames(16);
      assert.equal(await page.evaluate(() => (window as any).MermaidEditingHarness.usesLargeDocumentDerivedWorkBudget(
        (window as any).ed.view.state)), large, label + ': actual derived-work budget');
      const snapshot = () => page.evaluate(({ body, after }) => {
        const v = (window as any).ed.view;
        const rows = [body, after].map(pos => {
          const r = v.coordsAtPos(pos);
          const n = v.state.doc.lineAt(pos).number;
          const gutter = Array.from(v.dom.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
            .find(e => e.textContent === String(n) && getComputedStyle(e).visibility !== 'hidden');
          const node = v.domAtPos(pos).node;
          const line = (node.nodeType === 1 ? node : node.parentElement)?.closest('.cm-line');
          return { top: r?.top, bottom: r?.bottom, lineTop: line?.getBoundingClientRect().top,
            gutter: gutter?.getBoundingClientRect().top, hidden: gutter?.classList.contains('meo-md-hide-line-number'), n };
        });
        return { rows, scroll: v.scrollDOM.scrollTop, head: v.state.selection.main.head,
          refs: v.dom.querySelectorAll('.meo-md-footnote-ref').length,
          editing: !!v.dom.querySelector('.meo-math-live-result') };
      }, { body, after });
      const center = async (pos: number) => {
        await page.evaluate(pos => { const v = (window as any).ed.view; v.dispatch({ effects: v.constructor.scrollIntoView(pos, { y: 'center' }) }); }, pos);
        await frames();
      };
      const click = async (pos: number, retain = false) => {
        const point = await page.evaluate(pos => { const r = (window as any).ed.view.coordsAtPos(pos)!;
          return { x: Math.ceil(r.left + 2), y: Math.floor((r.top + r.bottom) / 2) }; }, pos);
        const before = await snapshot();
        const top = retain ? await page.evaluate(({ pos, needle }) => {
          const w = window as any, v = w.ed.view, dom = v.domAtPos(pos).node;
          const line = (dom.nodeType === 1 ? dom : dom.parentElement).closest('.cm-line');
          const mark = () => { for (const row of v.contentDOM.querySelectorAll('.cm-line'))
            if (row.textContent.includes(needle) && !row.hasAttribute('data-pointer-layout-target')) row.setAttribute('data-pointer-layout-target', ''); };
          mark(); w.pointerLayoutObserver = new MutationObserver(mark);
          w.pointerLayoutObserver.observe(v.contentDOM, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['data-pointer-layout-target'] });
          return line.getBoundingClientRect().top;
        }, { pos, needle: kind === 'footnote' ? 'CLICK HERE' : 'AFTER TARGET' }) : 0;
        const client = retain ? await page.createCDPSession() : null, paints: string[] = [];
        if (client) {
          client.on('Page.screencastFrame', event => { paints.push(event.data); void client.send('Page.screencastFrameAck', { sessionId: event.sessionId }); });
          await frames(3); await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 }); await frames(2);
        }
        assert.ok(point.y > 40 && point.y < 780, label + ': visible pointer target');
        await page.mouse.move(point.x, point.y); await page.mouse.down(); await frames(3);
        const held = await snapshot();
        if (Math.abs(held.rows[kind === 'footnote' ? 0 : 1]!.top! - before.rows[kind === 'footnote' ? 0 : 1]!.top!) > 2)
          failures.push(`${kind}/${length}: held pointer moves target ${JSON.stringify({ before, held })}`);
        await page.mouse.up();
        const samples = [];
        for (let i = 0; i < 12; i++) { await frames(1); samples.push(await snapshot()); }
        if (client) {
          await client.send('Page.stopScreencast'); await client.detach();
          assert.ok(paints.length >= 2, label + ': observe actual compositor frames');
          for (const encoded of paints) {
            const { data, info } = await sharp(Buffer.from(encoded, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
            let paintedTop = -1;
            for (let y = 0; y < info.height && paintedTop < 0; y++) {
              let count = 0;
              for (let x = 0; x < info.width; x++) {
                const i = (y * info.width + x) * info.channels;
                if (data[i]! > 240 && data[i + 1]! < 20 && data[i + 2]! > 240) count++;
              }
              if (count > 100) paintedTop = y;
            }
            assert.ok(paintedTop >= 0 && Math.abs(paintedTop - Math.round(top)) <= 2,
              label + ': painted pointer target moved ' + JSON.stringify({ top, paintedTop }));
            paintedFrames++;
          }
          await page.evaluate(() => { (window as any).pointerLayoutObserver.disconnect();
            document.querySelector('[data-pointer-layout-target]')?.removeAttribute('data-pointer-layout-target'); });
        }
        return samples;
      };
      await center(body);
      if (kind === 'footnote') {
        await page.evaluate(pos => { const v = (window as any).ed.view; v.dispatch({ selection: { anchor: pos } }); v.focus(); }, text.indexOf('PREVIOUS'));
        await frames(); await center(body);
      }
      const reading = await snapshot();
      const entered = await click(body, kind === 'footnote');
      const entry = entered.at(-1)!;
      if (kind === 'footnote') {
        if (Math.abs(entry.rows[0]!.top! - reading.rows[0]!.top!) > 2)
          failures.push(`${kind}/${length}: click moves line ${JSON.stringify({ reading, entry })}`);
      } else {
        // Inspect actual document line numbers while source is expanded.
        assert.ok(entry.editing, label + ': formula source entered');
        for (const sample of entered) for (const row of sample.rows) {
          if (row.top !== undefined && row.top > 0 && row.top < 780 && (row.gutter === undefined || row.hidden
            || row.lineTop === undefined || Math.abs(row.lineTop - row.gutter) > 1))
            failures.push(`${kind}/${length}: entry gutter drift ${JSON.stringify(sample)}`);
        }
        await center(after);
        const before = await snapshot();
        const exited = await click(after, true);
        for (const sample of exited) {
          if (Math.abs(sample.rows[1]!.top! - before.rows[1]!.top!) > 2)
            failures.push(`${kind}/${length}: exit moves target ${JSON.stringify({ before, sample })}`);
          const row = sample.rows[1]!;
          if (row.gutter === undefined || row.hidden || row.lineTop === undefined || Math.abs(row.lineTop - row.gutter) > 1)
            failures.push(`${kind}/${length}: exit gutter drift ${JSON.stringify(sample)}`);
        }
        assert.equal(exited.at(-1)!.editing, false, label + ': formula source retired');
      }
      assert.equal(await page.evaluate(() => (window as any).ed.getText()), text, label + ': text unchanged');
      const final = await snapshot(), target = kind === 'footnote' ? body : after;
      assert.ok(final.head >= target && final.head < target + 12, label + ': clicked text owns the caret');
      fs.mkdirSync('.local/live-pointer-layout', { recursive: true });
      await page.screenshot({ path: `.local/live-pointer-layout/${label.replaceAll('/', '-')}.png` });
      cases++;
    }
  }
  assert.deepEqual([...new Set(failures)], []);
  assert.deepEqual(errors, []);
  console.log(`Live pointer layout passed: ${cases} ordinary/large cases, source gutters and ${paintedFrames} painted frames`);
} catch (error) { failure = error; }
if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure);
