import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Page } from 'puppeteer-core';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

type Fixture = { name: string; kind: 'math' | 'html' | 'code' | 'mermaid'; block: string; body: string; side?: boolean; width?: number };

/** Native pointer/keyboard handoffs, including the intermediate presentation and actual painted frames. */
async function checkBlockEditingHandoffs(page: Page,
  mount: (text: string, width: number) => Promise<void>,
  select: (position: number) => Promise<void>,
  frames: (count?: number) => Promise<unknown>): Promise<void> {
  const mermaid = '```mermaid\nflowchart TD\n' + Array.from({ length: 26 }, (_, i) =>
    `N${i}[Stage ${i}] --> N${i + 1}[Stage ${i + 1}]`).join('\n') + '\n```';
  const fixtures: Fixture[] = [
    { name: 'dollar-math', kind: 'math', block: '$$\nx^2 + y^2 = 1\n$$', body: 'x^2' },
    { name: 'fenced-math', kind: 'math', block: '```tex\nx^2 + y^2 = 1\n```', body: 'x^2' },
    { name: 'quoted-math', kind: 'math', block: '> $$\n> x^2 + y^2 = 1\n> $$', body: 'x^2' },
    { name: 'footnote-math', kind: 'math', block: '[^probe]: note\n\n    $$\n    x^2 + y^2 = 1\n    $$', body: 'x^2' },
    { name: 'html', kind: 'html', block: '<div>\n<p>ALPHA</p>\n</div>', body: 'ALPHA' },
    { name: 'code', kind: 'code', block: '```js\nconst alpha = 1;\n```', body: 'const alpha' },
    { name: 'folded-code', kind: 'code', block: '```js\n' + Array.from({ length: 70 }, (_, i) =>
      `const value${i} = ${i};`).join('\n') + '\n```', body: 'const value0' },
    { name: 'mermaid-stacked', kind: 'mermaid', block: mermaid, body: 'Stage 26' },
    { name: 'mermaid-side', kind: 'mermaid', block: mermaid, body: 'Stage 26', side: true },
    { name: 'mermaid-narrow', kind: 'mermaid', block: mermaid, body: 'Stage 26', width: 520 }
  ];
  const prefix = Array.from({ length: 35 }, (_, i) => `Before paragraph ${i}\n`).join('\n') + '\n';
  const suffix = Array.from({ length: 35 }, (_, i) => `Following paragraph ${i}\n`).join('\n');
  const richSuffix = '\n\n' + Array.from({ length: 49 }, (_, i) => `\`\`\`js\nconst block${i} = ${i};\n\`\`\``).join('\n\n');
  const textSuffix = '\n\n' + Array.from({ length: 3000 }, (_, i) => `Following paragraph ${i}\n`).join('\n');
  const snapshot = () => page.evaluate(() => {
    const view = (window as any).nativeEditor.view;
    const target = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-line'))
      .find((line: any) => line.textContent === 'AFTER TARGET') as HTMLElement | undefined;
    return { head: view.state.selection.main.head, focus: view.hasFocus, top: target?.getBoundingClientRect().top,
      math: view.dom.querySelectorAll('.meo-md-math-fenced-display').length,
      mathEditing: view.dom.querySelectorAll('.meo-math-live-result').length,
      htmlEditing: view.dom.querySelectorAll('.meo-md-html-live-result').length,
      side: view.dom.querySelectorAll('.meo-mermaid-inline-preview').length,
      mermaid: view.dom.querySelector('.meo-mermaid-toolbar')?.getAttribute('data-meo-mermaid-mode') };
  });
  const center = async (position: number) => {
    await page.evaluate(position => {
      const view = (window as any).nativeEditor.view;
      view.dispatch({ effects: view.constructor.scrollIntoView(position, { y: 'center' }) });
    }, position);
    await frames(10);
  };
  const expectEditing = (state: Awaited<ReturnType<typeof snapshot>>, fixture: Fixture, editing: boolean, label: string) => {
    if (fixture.kind === 'math') {
      assert.equal(state.mathEditing, Number(editing), label + ': only the current formula owns an editing result');
      assert.equal(state.math, 1, label + ': exactly one formula result');
    }
    if (fixture.kind === 'html') assert.equal(state.htmlEditing, Number(editing), label + ': HTML result ownership');
    if (fixture.kind === 'mermaid') {
      assert.equal(state.mermaid, editing ? 'edit' : 'preview', label + ': Mermaid presentation');
      assert.equal(state.side, Number(editing && !!fixture.side), label + ': side layout ownership');
    }
  };
  let cases = 0, paintedFrames = 0;
  const selectedCase = process.argv.find(arg => arg.startsWith('--handoff-case='))?.slice('--handoff-case='.length);
  for (const profile of ['ordinary', 'rich', 'text'] as const) for (const fixture of fixtures) {
    if (profile === 'text' && !['dollar-math', 'mermaid-side'].includes(fixture.name)) continue;
    const label = `${profile}/${fixture.name}`, width = fixture.width ?? 1200;
    if (selectedCase && selectedCase !== label) continue;
    const text = prefix + fixture.block + '\n\nAFTER TARGET\n\n' + suffix
      + (profile === 'rich' ? richSuffix : profile === 'text' ? textSuffix : '');
    const body = prefix.length + fixture.block.indexOf(fixture.body);
    let closing = prefix.length + fixture.block.lastIndexOf('\n') + 1;
    let after = text.indexOf('AFTER TARGET');
    await mount(text, width);
    await select(body);
    await center(after);
    if (fixture.side) {
      await page.$eval('.meo-mermaid-layout-btn', (button: any) => button.click());
      await frames(10);
      await center(after);
    }
    await page.evaluate(() => (window as any).nativeEditor.view.focus());
    const before = await snapshot();
    expectEditing(before, fixture, true, label + '/enter');
    if (fixture.kind === 'math') {
      const gutter = await page.evaluate(body => {
        const view = (window as any).nativeEditor.view, caret = view.coordsAtPos(body);
        const cells = Array.from(view.dom.querySelectorAll('.cm-lineNumbers .cm-gutterElement')) as HTMLElement[];
        const cell = cells.find(cell => caret && Math.abs(cell.getBoundingClientRect().top - caret.top) <= 3);
        return cell ? { text: cell.textContent, hidden: cell.classList.contains('meo-md-hide-line-number') } : null;
      }, body);
      assert.ok(gutter && !gutter.hidden, label + ': editable formula keeps its native source line number ' + JSON.stringify(gutter));
    }
    assert.ok(before.top !== undefined && before.top > 150 && before.top < 650, label + ': below-block target starts in mid-viewport');
    let point = await page.evaluate(after => {
      const caret = (window as any).nativeEditor.view.coordsAtPos(after)!;
      return { x: caret.left + 2, y: (caret.top + caret.bottom) / 2 };
    }, after);
    const sideIdentity = fixture.side && await page.evaluate(() => {
      const w = window as any;
      w.handoffSidePanel = document.querySelector('.meo-mermaid-inline-preview');
      return !!w.handoffSidePanel;
    });
    // Leave immediately after real native input, while derived work may still
    // be queued. A settled, selection-only fixture misses that ownership race.
    const insertAt = body + fixture.body.length;
    await page.evaluate(insertAt => {
      const view = (window as any).nativeEditor.view;
      view.dispatch({ selection: { anchor: insertAt } });
    }, insertAt);
    await page.keyboard.type('7');
    const expectedSource = text.slice(0, insertAt) + '7' + text.slice(insertAt);
    assert.equal(await page.evaluate(() => (window as any).nativeEditor.getText()), expectedSource,
      label + ': native digit reaches the selected source position');
    closing++;
    after++;
    if (fixture.kind === 'mermaid' && !fixture.side) {
      // A tall stacked canvas separates its source and following prose by
      // several screens. Finish its actual render before preparing a distant
      // click; immediate handoff during pending work is covered by side mode.
      await page.waitForFunction(() => Array.from(document.querySelectorAll('.meo-mermaid-editing-preview svg'))
        .some(svg => svg.textContent?.includes('Stage 267')));
      // A real wheel gesture retires the input's viewport owner without
      // changing the source selection, as a real scroll to that prose would.
      await page.mouse.move(width / 2, 400);
      await page.mouse.wheel({ deltaY: 1 });
      await center(after);
      point = await page.evaluate(({ after, label }) => {
        const view = (window as any).nativeEditor.view, caret = view.coordsAtPos(after);
        if (!caret) throw new Error(label + ': missing post-input click target ' + JSON.stringify({ after,
          actual: view.state.doc.sliceString(after, after + 30), head: view.state.selection.main.head, viewport: view.viewport }));
        return { x: caret.left + 2, y: (caret.top + caret.bottom) / 2 };
      }, { after, label });
    }
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await frames(10);
    const held = await snapshot();
    expectEditing(held, fixture, true, label + '/held');
    assert.ok(held.top !== undefined && Math.abs(held.top - before.top!) <= 2, label + ': no reflow underneath a held pointer');
    if (sideIdentity) assert.equal(await page.evaluate(() => (window as any).handoffSidePanel ===
      document.querySelector('.meo-mermaid-inline-preview')), true, label + ': held side panel retains DOM identity');
    await page.mouse.up();
    await frames(16);
    const released = await snapshot();
    expectEditing(released, fixture, false, label + '/released');
    assert.ok(released.focus && released.head >= after && released.head <= after + 'AFTER TARGET'.length, label + ': clicked prose owns the caret');
    assert.ok(released.top !== undefined && Math.abs(released.top - before.top!) <= 2, label + ': release retains the clicked prose');
    if (profile === 'rich' && fixture.side) {
      fs.mkdirSync('.local/block-editing-acceptance', { recursive: true });
      await page.screenshot({ path: '.local/block-editing-acceptance/side-pointer-released.png' });
    }

    // Re-enter natively selected source, then leave from its last physical line.
    // The reading attachment must retire even when the source is a different
    // Markdown root or a held presentation selection has already moved away.
    await select(closing);
    await center(after);
    expectEditing(await snapshot(), fixture, true, label + '/keyboard-enter');
    if (fixture.side) {
      await page.addStyleTag({ content: '[data-handoff-witness]{background:#ff00ff!important}' });
      await page.evaluate(() => {
        const view = (window as any).nativeEditor.view;
        const witness = () => {
          for (const line of view.contentDOM.querySelectorAll('.cm-line'))
            if (line.textContent === 'AFTER TARGET' && !line.hasAttribute('data-handoff-witness'))
              line.setAttribute('data-handoff-witness', '');
        };
        witness();
        const observer = new MutationObserver(witness);
        observer.observe(view.contentDOM, { childList: true, subtree: true,
          attributes: true, attributeFilter: ['data-handoff-witness'] });
        (window as any).handoffWitnessObserver = observer;
      });
      // Start recording only after the geometry-neutral witness itself has
      // painted; an initial screencast frame may otherwise precede its style.
      await frames(3);
    }
    const client = fixture.side ? await page.createCDPSession() : null;
    const paints: string[] = [];
    if (client) {
      client.on('Page.screencastFrame', event => {
        paints.push(event.data);
        void client.send('Page.screencastFrameAck', { sessionId: event.sessionId });
      });
      await client.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
      await frames(2);
    }
    await page.keyboard.press('ArrowDown');
    await frames(18);
    if (client) {
      await client.send('Page.stopScreencast');
      const tops: number[] = [];
      for (const encoded of paints) {
        const { data, info } = await sharp(Buffer.from(encoded, 'base64')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        let top = -1;
        for (let y = 0; y < info.height && top < 0; y++) {
          let count = 0;
          for (let x = 0; x < info.width; x++) {
            const offset = (y * info.width + x) * info.channels;
            if (data[offset]! > 240 && data[offset + 1]! < 20 && data[offset + 2]! > 240) count++;
          }
          if (count > 100) top = y;
        }
        tops.push(top);
      }
      if (!tops.every(top => top >= 0 && Math.abs(top - tops.at(-1)!) <= 2)) {
        const folder = `.local/block-editing-acceptance/${profile}-${fixture.name}`;
        fs.mkdirSync(folder, { recursive: true });
        paints.forEach((paint, index) => fs.writeFileSync(`${folder}/${index}.png`, Buffer.from(paint, 'base64')));
        console.log('Handoff paint diagnostic', label, await snapshot(), await page.evaluate(() =>
          document.querySelector('[data-handoff-witness]')?.outerHTML));
      }
      assert.ok(tops.length >= 2 && tops.every(top => top >= 0 && Math.abs(top - tops.at(-1)!) <= 2),
        label + ': actual painted frames never lose/displace the below-block target ' + JSON.stringify(tops));
      paintedFrames += paints.length;
      await client.detach();
      await page.evaluate(() => (window as any).handoffWitnessObserver.disconnect());
    }
    expectEditing(await snapshot(), fixture, false, label + '/keyboard-exit');
    assert.equal(await page.evaluate(() => (window as any).nativeEditor.getText()), expectedSource,
      label + ': only the native digit changes source across handoffs');
    cases++;
  }
  assert.ok(cases > 0, 'Selected handoff case must exist');
  console.log(`Block handoffs passed: ${cases} ordinary/rich/text cases, held pointer/release/keyboard and ${paintedFrames} compositor frames`);
}

const build = await Bun.build({ entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let failure: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  const katexDirectory = 'node_modules/katex/dist';
  await page.addStyleTag({ content: fs.readFileSync(path.join(katexDirectory, 'katex.min.css'), 'utf8')
    .replace(/url\((fonts\/[^)]+)\)/g, (_match, file) =>
      `url(data:font/${path.extname(file).slice(1)};base64,${fs.readFileSync(path.join(katexDirectory, file)).toString('base64')})`) });
  await page.addStyleTag({ content: ':root{--meo-font-live:Arial;--meo-font-source:monospace;--meo-font-live-size:16px;--meo-font-source-size:14px}' });
  await page.addScriptTag({ content: fs.readFileSync('webview/dist/mermaid.min.js', 'utf8') });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const frames = (n = 8) => page.evaluate(async n => {
    for (let i = 0; i < n; i++) await new Promise(resolve => requestAnimationFrame(resolve));
  }, n);
  const mount = async (text: string, width: number) => {
    await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
    await page.evaluate(({ text, width }) => {
      const w = window as any, appearance = width === 520 ? 'light' : 'dark';
      w.nativeEditor?.destroy();
      document.getElementById('app')!.replaceChildren();
      w.MermaidEditingHarness.applyBuiltInVisualBaseline(appearance);
      w.MermaidEditingHarness.applyUiTheme(appearance, false);
      w.MermaidEditingHarness.applyCodeTheme(appearance);
      w.nativeEditor = w.MermaidEditingHarness.createEditor({ parent: document.getElementById('app'), text,
        initialMode: 'live', uiLanguage: width === 520 ? 'zh-CN' : 'en', onApplyChanges() {} });
    }, { text, width });
    await frames(16);
  };
  const select = async (anchor: number) => {
    await page.evaluate(anchor => {
      const view = (window as any).nativeEditor.view;
      view.dispatch({ selection: { anchor }, scrollIntoView: true });
      view.focus();
    }, anchor);
    await frames();
  };
  await checkBlockEditingHandoffs(page, mount, select, frames);
  assert.deepEqual(errors, []);
} catch (error) { failure = error; }
if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure);
