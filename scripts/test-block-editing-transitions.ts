import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

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
  await page.addStyleTag({ content: fs.readFileSync(path.join(katexDirectory, 'katex.min.css'), 'utf8').replace(/url\((fonts\/[^)]+)\)/g, (_match, file) =>
    `url(data:font/${path.extname(file).slice(1)};base64,${fs.readFileSync(path.join(katexDirectory, file)).toString('base64')})`) });
  await page.addStyleTag({ content: ':root{--meo-font-live:Arial;--meo-font-source:monospace;--meo-font-live-size:16px;--meo-font-source-size:14px}' });
  await page.addScriptTag({ content: fs.readFileSync('webview/dist/mermaid.min.js', 'utf8') });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const frames = (n = 8) => page.evaluate(async n => {
    for (let i = 0; i < n; i++) await new Promise(resolve => requestAnimationFrame(resolve));
  }, n);
  const mount = async (text: string, width: number) => {
    await page.setViewport({ width, height: 800 });
    await page.evaluate(({ text, width }) => {
      const w = window as any;
      w.nativeEditor?.destroy(); document.getElementById('app')!.replaceChildren();
      w.MermaidEditingHarness.applyBuiltInVisualBaseline(width === 520 ? 'light' : 'dark');
      w.MermaidEditingHarness.applyUiTheme(width === 520 ? 'light' : 'dark', false);
      w.MermaidEditingHarness.applyCodeTheme(width === 520 ? 'light' : 'dark');
      w.nativeEditor = w.MermaidEditingHarness.createEditor({ parent: document.getElementById('app'), text,
        initialMode: 'live', uiLanguage: width === 520 ? 'zh-CN' : 'en', onApplyChanges() {} });
    }, { text, width });
    await frames(16);
  };
  const select = async (anchor: number) => {
    await page.evaluate(anchor => {
      const view = (window as any).nativeEditor.view;
      view.dispatch({ selection: { anchor }, scrollIntoView: true }); view.focus();
    }, anchor);
    await frames();
  };
  const read = () => page.evaluate(() => {
    const e = (window as any).nativeEditor, view = e.view, head = view.state.selection.main.head;
    const caret = view.coordsAtPos(head), focused = document.activeElement as HTMLElement;
    const bounds = focused?.getBoundingClientRect();
    const style = focused && getComputedStyle(focused);
    return { text: e.getText(), head, line: view.state.doc.lineAt(head).number, caretTop: caret?.top, caretBottom: caret?.bottom,
      reading: view.dom.classList.contains('meo-block-reading'), focus: focused?.classList.contains('meo-block-reading-target'),
      top: bounds?.top, bottom: bounds?.bottom, editing: view.hasFocus,
      focusIndicator: style?.boxShadow,
      focusOpacity: style?.opacity,
      mode: view.dom.querySelector('.meo-mermaid-toolbar')?.getAttribute('data-meo-mermaid-mode'),
      targets: Array.from(view.dom.querySelectorAll('.meo-block-reading-target')).map((node: any) => node.outerHTML.slice(0, 300)) };
  });
  const clickOutside = async (position: number, keepReading: boolean) => {
    await page.evaluate(position => {
      const view = (window as any).nativeEditor.view;
      view.dispatch({ effects: view.constructor.scrollIntoView(position, { y: 'center' }) });
    }, position);
    await frames(16);
    const point = await page.evaluate(position => {
      const view = (window as any).nativeEditor.view, caret = view.coordsAtPos(position)!;
      return { x: caret.left + .5, y: (caret.top + caret.bottom) / 2, top: caret.top,
        line: view.state.doc.lineAt(position).number };
    }, position);
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await frames(2);
    if (keepReading) assert.ok((await read()).reading, 'Reading presentation remains stable while the pointer is held');
    await page.mouse.up(); await frames(20);
    const after = await read();
    assert.ok(after.editing && !after.reading, 'The new outside text target owns input focus after release');
    assert.equal(after.line, point.line, 'Collapsing the old block preserves the clicked document target');
    assert.ok(Math.abs(after.caretTop! - point.top) <= 2,
      'The clicked prose stays at its screen position: ' + JSON.stringify({ point, after: { head: after.head, top: after.caretTop } }));
  };
  const fixtures = [
    { name: 'math', block: '$$\nx^2 + y^2 = 1\n$$' },
    { name: 'html', block: '<div>\n<p>Alpha</p>\n</div>' },
    { name: 'code', block: '```js\nconst alpha = 1;\n```' },
    { name: 'long-code', block: '```js\n' + Array.from({ length: 70 }, (_, i) => `const value${i} = ${i};`).join('\n') + '\n```' },
    ...[520, 1200].map(width => ({ name: `mermaid-${width}`, width, block: '```mermaid\nflowchart TD\n' +
      Array.from({ length: 24 }, (_, i) => `N${i} --> N${i+1}`).join('\n') + '\n```' }))
  ];
  for (const fixture of fixtures) {
    const width = 'width' in fixture ? fixture.width! : 1200;
    const prefix = 'Before\n\n', text = prefix + fixture.block + '\n\nAfter';
    const opening = prefix.length, closing = opening + fixture.block.lastIndexOf('\n') + 1;
    for (const vertical of [true, false]) for (const forward of [true, false]) {
      await mount(text, width);
      const outside = forward ? opening - 1 : opening + fixture.block.length + 1;
      await select(outside);
      await page.keyboard.press(vertical ? forward ? 'ArrowDown' : 'ArrowUp' : forward ? 'ArrowRight' : 'ArrowLeft');
      await frames();
      const entered = await read();
      assert.equal(entered.line, text.slice(0, forward ? opening : closing).split('\n').length,
        `${fixture.name}: enters through the corresponding source boundary (${vertical}/${forward}) ${JSON.stringify(entered)}`);
      assert.ok(entered.editing && !entered.reading, `${fixture.name}: real source caret`);
      await page.keyboard.press(vertical ? forward ? 'ArrowUp' : 'ArrowDown' : forward ? 'ArrowLeft' : 'ArrowRight');
      await frames();
      const exited = await read();
      assert.equal(exited.line, text.slice(0, outside).split('\n').length, `${fixture.name}: returns to adjacent prose`);
      assert.ok(exited.caretTop! >= 0 && exited.caretBottom! <= 800, `${fixture.name}: exit caret remains visible`);
      assert.equal(exited.text, text);
    }
    for (const eof of [false, true]) {
      await mount(eof ? fixture.block : text, width);
      await select((eof ? 0 : opening) + fixture.block.indexOf('\n') + 1);
      await page.keyboard.press('Escape'); await frames(16);
      const completed = await read();
      assert.ok(completed.reading && completed.focus, `${fixture.name}: Escape returns to visible block focus ${JSON.stringify(completed)}`);
      const focusBorder = /0px 0px 0px ([\d.]+)px inset/.exec(completed.focusIndicator ?? '');
      assert.ok(focusBorder && Number(focusBorder[1]) >= .9 && Number(completed.focusOpacity) >= .99,
        `${fixture.name}: the visible reading target has a painted focus indicator ${completed.focusIndicator}`);
      assert.ok(completed.top! >= 0 && completed.top! < 800, `${fixture.name}: block focus is visible`);
      assert.equal(completed.text, eof ? fixture.block : text, `${fixture.name}: completion never inserts document text`);
      if (!eof) {
        fs.mkdirSync('.local/block-editing-acceptance', { recursive: true });
        await page.screenshot({ path: `.local/block-editing-acceptance/${fixture.name}-reading.png` });
        await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); await frames();
        assert.ok((await read()).editing && !(await read()).reading, `${fixture.name}: reverse tab can return to source without a focus trap`);
        await page.keyboard.press('Escape'); await frames(16);
        await page.keyboard.down('Control'); await page.keyboard.press('a'); await page.keyboard.up('Control'); await frames();
        const selected = await page.evaluate(() => {
          const view = (window as any).nativeEditor.view, range = view.state.selection.main;
          return { from: range.from, to: range.to, focused: view.hasFocus };
        });
        assert.deepEqual(selected, { from: 0, to: text.length, focused: true }, `${fixture.name}: select all stays in the primary document`);
        await select(opening + fixture.block.indexOf('\n') + 1);
        await page.keyboard.press('Escape'); await frames(16);
        await page.keyboard.press('ArrowDown'); await frames();
        assert.equal((await read()).line, text.slice(0, opening + fixture.block.length + 1).split('\n').length,
          `${fixture.name}: a reading block can be left directly with the keyboard`);
        await select(opening + fixture.block.indexOf('\n') + 1);
        await page.keyboard.press('Escape'); await frames(16);
      }
      await page.keyboard.press('Enter'); await frames();
      assert.ok((await read()).editing && !(await read()).reading, `${fixture.name}: Enter resumes source input`);
      if (!eof) {
        const leading = Array.from({ length: 24 }, (_, i) => `Leading ${i}\n`).join('\n') + '\n';
        const pointerText = leading + fixture.block + '\n\nAfter target\n\n' +
          Array.from({ length: 24 }, (_, i) => `Following ${i}\n`).join('\n');
        await mount(pointerText, width);
        await select(leading.length + fixture.block.indexOf('\n') + 1);
        await clickOutside(pointerText.indexOf('After target'), false);
        await select(leading.length + fixture.block.indexOf('\n') + 1);
        await page.keyboard.press('Escape'); await frames(16);
        await clickOutside(pointerText.indexOf('After target'), fixture.name !== 'code' && fixture.name !== 'long-code');
      }
    }
    console.log(`${fixture.name}: four boundaries, source focus, Escape/Enter and document-end completion passed`);
  }

  // A visible line remains editable while folded; only a hidden target reveals
  // the tail. An explicit expansion survives blur and Escape.
  const long = fixtures.find(fixture => fixture.name === 'long-code')!;
  const longText = 'Before\n\n' + long.block + '\n\nAfter';
  await mount(longText, 1200);
  const clickPosition = async (position: number) => {
    const point = await page.evaluate(position => {
      const view = (window as any).nativeEditor.view, caret = view.coordsAtPos(position);
      if (!caret) throw new Error('Missing click target ' + position);
      return { x: caret.left + .5, y: (caret.top + caret.bottom) / 2 };
    }, position);
    await page.mouse.click(point.x, point.y); await frames(16);
  };
  await clickPosition(longText.indexOf('value0') + 2);
  assert.ok(await page.$('.meo-md-long-code-placeholder'), 'Clicking visible code does not expand its hidden tail');
  await select(longText.indexOf('const value9'));
  await page.keyboard.press('ArrowDown'); await frames();
  assert.equal((await read()).line, longText.slice(0, longText.indexOf('const value10')).split('\n').length,
    'Moving down from the last visible source row enters the first hidden row');
  assert.equal(await page.$('.meo-md-long-code-placeholder'), null, 'A hidden keyboard target temporarily expands the tail');
  await page.keyboard.press('ArrowUp'); await frames();
  assert.ok(await page.$('.meo-md-long-code-placeholder'), 'Returning to visible source restores the fold preference');
  await page.keyboard.press('ArrowDown'); await frames();
  await select(longText.indexOf('After'));
  assert.ok(await page.$('.meo-md-long-code-placeholder'), 'Leaving a temporary reveal restores the fold preference');
  await page.click('.meo-md-long-code-placeholder .meo-long-code-action'); await frames();
  await select(longText.indexOf('After'));
  assert.equal(await page.$('.meo-md-long-code-placeholder'), null, 'Explicit expansion survives leaving the block');
  await select(longText.indexOf('value55'));
  await page.keyboard.press('Escape'); await frames(16);
  assert.ok((await read()).focus, 'Long code completion has visible reading focus');
  assert.equal(await page.$('.meo-md-long-code-placeholder'), null, 'Escape keeps a manual expansion');
  console.log('Long code visible/hidden targets and manual expansion preference passed');

  // Final coordinates alone missed a frame of unmounted source. Sample the
  // entire transition through the same production input route.
  const highBlock = '```mermaid\nflowchart TD\n' + Array.from({ length: 70 }, (_, i) => `N${i}[Stage ${i}] --> N${i+1}[Stage ${i+1}]`).join('\n') + '\n```';
  const highText = Array.from({ length: 35 }, (_, i) => `Before ${i}\n`).join('\n') + '\n' + highBlock + '\n\n' +
    Array.from({ length: 35 }, (_, i) => `After ${i}\n`).join('\n');
  const outside = highText.indexOf(highBlock) + highBlock.length + 1;
  await mount(highText, 1200);
  await page.evaluate(position => {
    const e = (window as any).nativeEditor;
    e.scrollToLine(e.view.state.doc.lineAt(position).number - 1, 'top');
  }, highText.indexOf(highBlock));
  await page.waitForSelector('.meo-mermaid-block svg');
  await select(outside);
  await frames(20);
  await page.evaluate(outside => {
    const view = (window as any).nativeEditor.view, caret = view.coordsAtPos(outside)!;
    view.scrollDOM.scrollTop += caret.top - 650;
  }, outside);
  await frames(16);
  for (const key of ['ArrowUp', 'ArrowDown']) {
    await page.evaluate(() => {
      const w = window as any, view = w.nativeEditor.view;
      w.blockTransitionFrames = [];
      let remaining = 32;
      const sample = () => {
        const caret = view.coordsAtPos(view.state.selection.main.head);
        w.blockTransitionFrames.push({ head: view.state.selection.main.head, top: caret?.top, bottom: caret?.bottom });
        if (--remaining) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.press(key); await frames(36);
    const samples = await page.evaluate(() => (window as any).blockTransitionFrames as { head: number; top?: number; bottom?: number }[]);
    const final = samples.at(-1)!;
    assert.ok(samples.filter(sample => sample.head === final.head).every(sample => sample.top !== undefined
      && sample.top >= 0 && sample.bottom! <= 800 && Math.abs(sample.top - final.top!) <= 2),
      `${key}: every transition frame retains the visible source/prose target ${JSON.stringify(samples)}`);
  }
  assert.equal((await read()).text, highText);
  fs.mkdirSync('.local/block-editing-acceptance', { recursive: true });
  await page.screenshot({ path: '.local/block-editing-acceptance/tall-roundtrip.png' });
  console.log('Tall Mermaid transition frames retain the caret without an offscreen intermediate state');
  assert.deepEqual(errors, []);
  console.log('Unified block editing transitions passed');
} catch (error) { failure = error; }
if (failure === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, failure);
