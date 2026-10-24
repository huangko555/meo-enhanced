import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const outdir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-code-number-input-'));
const build = await Bun.build({
  entrypoints: [path.join(root, 'scripts/test-code-block-line-numbers-entry.ts')],
  outdir, target: 'browser', format: 'iife', naming: 'bundle.js'
});
assert.ok(build.success, build.logs.map(String).join('\n'));
const prefix = ('## Section\n\n' + 'Paragraph for code numbering. '.repeat(6) + '\n\n').repeat(2_100);
const fixtures = [
  { name: 'small JSON', prefix: '', language: 'json', rows: 9, target: 3, quote: '' },
  { name: 'wrapped JSON row', prefix: '', language: 'json', rows: 12, target: 3, quote: '', wrap: true },
  { name: 'expanded JSON in large document', prefix, language: 'json', rows: 23, target: 3, quote: '', paint: true },
  { name: 'blank JSON row in large document', prefix, language: 'json', rows: 23, target: 13, quote: '' },
  { name: 'last code row before closing fence', prefix, language: 'json', rows: 23, target: 23, quote: '', atEnd: true },
  { name: '99 to 100 rows', prefix, language: 'text', rows: 99, target: 96, quote: '' },
  { name: 'embedded Markdown', prefix, language: 'markdown', rows: 23, target: 3, quote: '' },
  { name: 'quoted JSON', prefix, language: 'json', rows: 23, target: 3, quote: '> ', paint: true }
];
const browser = await launchTestBrowser();
let failure: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 820 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  await page.addStyleTag({ content: ':root{--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#292d31;--meo-line-number-foreground:#8b949e;--meo-semantic-mutedForeground:#8b949e;--meo-font-live:Arial;--meo-font-live-size:16px}' });
  // Geometry-neutral witnesses: cyan marks the middle of each logical row;
  // magenta is its real inner-number glyph, independently checked in pixels.
  await page.addStyleTag({ content: `
    #app[data-number-paint] .cm-line[data-number-row] {
      background-image:linear-gradient(#00ffff,#00ffff)!important;
      background-size:3px 2px!important;background-position:right center!important;background-repeat:no-repeat!important;
    }
    #app[data-number-paint] .meo-md-code-line-numbered:not(.meo-md-quote):not(.meo-md-alert)::before,
    #app[data-number-paint] .meo-md-code-line-numbered:is(.meo-md-quote,.meo-md-alert)::after {color:#ff00ff!important;opacity:1!important}
  ` });
  await page.addScriptTag({ path: path.join(outdir, 'bundle.js') });
  let sampledFrames = 0, paintedFrames = 0;
  for (const fixture of fixtures) {
    await page.setViewport({ width: fixture.wrap ? 520 : 900, height: 820 });
    await page.evaluate(async (fixture) => {
      const w = window as any;
      w.editor?.destroy();
      document.getElementById('app')!.replaceChildren();
      const rows = ['{', '  "chapter": 1,', '  "title": "typing",',
        ...Array(fixture.rows - 5).fill(''), '  "options": {}', '}'];
      if (fixture.wrap) rows[2] = '  "title": "' + 'wrapped logical code row '.repeat(8) + '",';
      const text = fixture.prefix + ['```' + fixture.language, ...rows, '```']
        .map(line => fixture.quote + line).concat('', 'After code.').join('\n');
      const editor = w.editor = w.CodeBlockLineNumbersHarness.createEditor({
        parent: document.getElementById('app'), text, initialMode: 'live', onApplyChanges() {}
      });
      w.firstLine = fixture.prefix.split('\n').length;
      editor.scrollToLine(w.firstLine + 2, 'center');
      await new Promise(resolve => setTimeout(resolve, 400));
      document.querySelector<HTMLElement>('.meo-md-long-code-placeholder .meo-long-code-action')?.click();
      await new Promise(resolve => setTimeout(resolve, 80));
      editor.scrollToLine(w.firstLine + fixture.target, 'center');
      await new Promise(resolve => setTimeout(resolve, 80));
      const line = editor.view.state.doc.line(w.firstLine + fixture.target);
      editor.view.dispatch({ selection: { anchor: line.to - (fixture.atEnd ? 0 : 1) } });
      editor.view.focus();
      w.samples = [];
      w.sample = () => {
        const view = editor.view;
        const closing = view.state.doc.lines - 2;
        const width = Math.max(2, String(closing - w.firstLine - 1).length) + 'ch';
        let checked = 0;
        const errors = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')).flatMap(element => {
          const line = view.state.doc.lineAt(view.posAtDOM(element));
          if (line.number <= w.firstLine || line.number >= closing) return [];
          checked += 1;
          if (fixture.paint && !element.hasAttribute('data-number-row')) element.setAttribute('data-number-row', '');
          const expected = String(line.number - w.firstLine);
          return element.dataset.meoCodeLineNumber === expected
            && element.style.getPropertyValue('--meo-code-line-number-width') === width ? [] : [{
            phase: w.inputPhase, line: line.number, expected, actual: element.dataset.meoCodeLineNumber ?? null,
            width: element.style.getPropertyValue('--meo-code-line-number-width'), expectedWidth: width
          }];
        });
        w.samples.push({ checked, errors });
      };
      // Passive DOM reads never force CodeMirror's pending layout/measurement.
      const frame = () => { w.sample(); w.frame = requestAnimationFrame(frame); };
      if (fixture.paint) {
        w.witnessObserver = new MutationObserver(() => {
          for (const element of editor.view.contentDOM.querySelectorAll<HTMLElement>('.cm-line')) {
            let number: number;
            try { number = editor.view.state.doc.lineAt(editor.view.posAtDOM(element)).number; }
            catch { continue; }
            if (number > w.firstLine && number < editor.view.state.doc.lines - 2
              && !element.hasAttribute('data-number-row')) element.setAttribute('data-number-row', '');
          }
        });
        w.witnessObserver.observe(editor.view.contentDOM, { attributes: true, childList: true, subtree: true, attributeFilter: ['data-number-row'] });
      }
      frame();
    }, fixture);
    const client = fixture.paint ? await page.createCDPSession() : undefined;
    const paints: string[] = [];
    if (client) {
      await page.evaluate(async () => {
        document.getElementById('app')!.setAttribute('data-number-paint', '');
        for (let index = 0; index < 3; index++) await new Promise(requestAnimationFrame);
      });
      client.on('Page.screencastFrame', event => {
        paints.push(event.data);
        void client.send('Page.screencastFrameAck', { sessionId: event.sessionId });
      });
      await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    }
    for (let index = 0; index < 6; index += 1) {
      await page.evaluate(index => { (window as any).inputPhase = 'Enter ' + index; }, index);
      await page.keyboard.press('Enter');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await page.evaluate(() => { (window as any).inputPhase = 'Backspace'; });
    if (fixture.quote) await page.keyboard.sendCharacter('777');
    for (let index = 0; index < 3; index++) await page.keyboard.press('Backspace');
    await page.evaluate(quote => {
      const w = window as any;
      w.inputPhase = 'paste';
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', `\n${quote}  "pasted": 1,\n${quote}  "more": 2,`);
      w.editor.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    }, fixture.quote);
    const beforeUndo = await page.evaluate(() => (window as any).editor.getText());
    assert.ok(beforeUndo.includes('"pasted": 1,'), fixture.name + ': clipboard input inserted the source');
    await page.evaluate(() => { (window as any).inputPhase = 'undo'; });
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    assert.notEqual(await page.evaluate(() => (window as any).editor.getText()), beforeUndo, fixture.name + ': undo changed input');
    await page.evaluate(() => { (window as any).inputPhase = 'redo'; });
    await page.keyboard.down('Control');
    await page.keyboard.press('y');
    await page.keyboard.up('Control');
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), beforeUndo, fixture.name + ': redo restored input');
    await new Promise(resolve => setTimeout(resolve, 1_100));
    if (client) {
      await client.send('Page.stopScreencast');
      assert.ok(paints.length >= 3, fixture.name + ': missing compositor input frames');
      for (const encoded of paints) {
        const { data, info } = await sharp(Buffer.from(encoded, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const cyan = new Set<number>(), magenta = new Set<number>();
        for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
          const offset = (y * info.width + x) * info.channels;
          const r = data[offset]!, g = data[offset + 1]!, b = data[offset + 2]!;
          if (r < 40 && g > 210 && b > 210) cyan.add(y);
          if (r > 170 && g < 80 && b > 170) magenta.add(y);
        }
        const rows = [...cyan].filter(y => y > 20 && y < info.height - 20 && !cyan.has(y - 1));
        if (rows.length <= 3 || rows.some(y => ![...magenta].some(numberY => Math.abs(numberY - y) < 10))) {
          fs.mkdirSync('.local/code-number-paint', { recursive: true });
          fs.writeFileSync('.local/code-number-paint/missing.png', Buffer.from(encoded, 'base64'));
        }
        assert.ok(rows.length > 3, fixture.name + ': missing visible logical-row witnesses');
        assert.ok(rows.every(y => [...magenta].some(numberY => Math.abs(numberY - y) < 10)),
          fixture.name + ': a painted logical row lost its number');
        const rightEdges = rows.map(y => {
          let right = -1;
          for (let yy = y - 8; yy <= y + 8; yy++) for (let xx = 0; xx < info.width; xx++) {
            const offset = (yy * info.width + xx) * info.channels;
            if (data[offset]! > 170 && data[offset + 1]! < 80 && data[offset + 2]! > 170) right = Math.max(right, xx);
          }
          return right;
        });
        assert.ok(Math.max(...rightEdges) - Math.min(...rightEdges) <= 3,
          fixture.name + ': inner number column moved ' + JSON.stringify(rightEdges));
        paintedFrames++;
      }
      await client.detach();
      await page.evaluate(() => { (window as any).witnessObserver.disconnect(); document.getElementById('app')!.removeAttribute('data-number-paint'); });
      fs.mkdirSync('.local/code-number-input', { recursive: true });
      await page.screenshot({ path: `.local/code-number-input/${fixture.quote ? 'quote' : 'root'}.png` });
    }
    const samples = await page.evaluate(() => {
      const w = window as any;
      cancelAnimationFrame(w.frame);
      return w.samples as Array<{ checked: number; errors: unknown[] }>;
    });
    assert.ok(samples.length > 6 && samples.every(sample => sample.checked > 0), fixture.name + ': missing visible code-line samples');
    assert.deepEqual(samples.flatMap(sample => sample.errors).slice(0, 8), [], fixture.name + ': numbers/width must match the current document on every input frame');
    sampledFrames += samples.length;
    console.log(fixture.name + ': native Enter, deletion, multiline insertion, undo/redo stayed numbered');
  }
  console.log(`Code numbering stayed current through ${sampledFrames} passive frames and ${paintedFrames} compositor frames`);
} catch (error) {
  failure = error;
  throw error;
} finally {
  if (failure === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, failure);
  fs.rmSync(outdir, { recursive: true, force: true });
}
