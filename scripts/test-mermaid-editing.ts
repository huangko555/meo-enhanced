import assert from 'node:assert/strict';
import fs from 'node:fs';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { chooseMermaidEditingLayout } from '../webview/src/editor/mermaidEditingLayout';

const choose = (width: number, height: number, sourceRows: number, diagram: { width: number; height: number } | null) =>
  chooseMermaidEditingLayout({ width, height, sourceRows, lineHeight: 22, diagram });
assert.equal(choose(600, 700, 40, { width: 200, height: 900 }), 'stacked');
assert.equal(choose(1100, 700, 5, { width: 120, height: 180 }), 'stacked');
assert.equal(choose(1100, 700, 30, { width: 1200, height: 180 }), 'stacked');
assert.equal(choose(1100, 700, 10, { width: 220, height: 1200 }), 'side-by-side');
assert.equal(choose(1100, 700, 30, { width: 500, height: 500 }), 'side-by-side');
assert.equal(choose(1100, 700, 2, { width: 180, height: 180 }), 'stacked');
assert.equal(choose(1100, 700, 40, null), 'stacked');

const build = await Bun.build({
  entrypoints: ['scripts/test-mermaid-editing-entry.ts'],
  target: 'browser',
  format: 'iife'
});
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let failure: unknown;
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setContent(
    '<!doctype html><meta charset="utf-8"><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>'
  );
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({
    content:
      ':root{--meo-font-live:Arial;--meo-font-source:monospace;--meo-font-live-size:16px;--meo-font-source-size:14px}'
  });
  await page.addScriptTag({ content: fs.readFileSync('webview/dist/mermaid.min.js', 'utf8') });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const frames = (count = 8) =>
    page.evaluate(async (count) => {
      for (let i = 0; i < count; i++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }, count);
  const read = () =>
    page.evaluate(() => {
      const e = (window as any).nativeEditor;
      return {
        text: e.getText(),
        head: e.view.state.selection.main.head,
        anchor: e.view.state.selection.main.anchor,
        focus: e.view.hasFocus
      };
    });
  const select = async (text: string) => {
    await page.evaluate((text) => {
      const e = (window as any).nativeEditor;
      const from = e.getText().indexOf(text);
      if (from < 0) throw new Error('Missing source ' + text);
      e.view.dispatch({ selection: { anchor: from, head: from + text.length } });
      e.view.focus();
    }, text);
    await frames();
  };
  const mount = async (text: string, width: number, language = 'en', appearance: 'light' | 'dark' = 'dark', editing = true) => {
    await page.setViewport({ width, height: 800, deviceScaleFactor: 1 });
    await page.evaluate(
      ({ text, language, appearance }) => {
        const w = window as any;
        w.nativeEditor?.destroy();
        document.getElementById('app')!.replaceChildren();
        document.documentElement.dataset.editorAppearance = appearance;
        w.MermaidEditingHarness.applyUiTheme(appearance, false);
        w.MermaidEditingHarness.applyCodeTheme(appearance);
        w.nativeEditor = w.MermaidEditingHarness.createEditor({
          parent: document.getElementById('app'),
          text,
          initialMode: 'live',
          uiLanguage: language,
          onApplyChanges() {}
        });
      },
      { text, language, appearance }
    );
    if (!editing) await page.evaluate(() => {
      const e = (window as any).nativeEditor;
      e.scrollToLine(e.view.state.doc.lineAt(e.getText().indexOf('```mermaid')).number - 1, 'start');
    });
    await page.waitForSelector('.meo-mermaid-block svg');
    await frames();
    if (!editing) return;
    await page.$eval('.meo-mermaid-mode-btn', (b) => (b as HTMLButtonElement).click());
    await frames();
    await page.waitForFunction(
      () => document.querySelector('.meo-mermaid-toolbar')?.getAttribute('data-meo-mermaid-mode') === 'edit'
    );
    assert.equal(
      await page.$$eval('.cm-content[contenteditable="true"]', (nodes) => nodes.length),
      1,
      'Mermaid uses the single main document input'
    );
    assert.equal(await page.$('.meo-mermaid-source-editor'), null, 'No internal source editor remains');
  };
  const assertNavigation = async () => {
    fs.mkdirSync('.local/mermaid-navigation-acceptance', {recursive:true});
    const text = Array.from({ length: 45 }, (_, i) => 'Before paragraph ' + i + '\n').join('\n') + '\n```mermaid\nflowchart TD\n' +
      Array.from({ length: 35 }, (_, i) => `N${i}[Stage ${i}] --> N${i + 1}[Stage ${i + 1}]`).join('\n') + '\n' +
      Array.from({ length: 65 }, (_, i) => '%% comment ' + i).join('\n') + '\n```\n\n' +
      Array.from({ length: 30 }, (_, i) => 'After paragraph ' + i + '\n').join('\n');
    const opening = text.indexOf('```mermaid'), first = text.indexOf('flowchart TD'), closing = text.lastIndexOf('```');
    const geometry = () => page.evaluate(({opening}) => {
      const view = (window as any).nativeEditor.view;
      const bounds = (window as any).MermaidEditingHarness.editorViewportBounds(view);
      const caret = view.coordsAtPos(view.state.selection.main.head);
      const block = view.lineBlockAt(opening);
      const toolbar = view.dom.querySelector(`.meo-mermaid-toolbar[data-meo-block-from="${opening}"]:not([data-meo-floating])`);
      const header = toolbar?.getBoundingClientRect();
      const blockTop = view.documentTop + block.top;
      return {top:bounds.top, bottom:bounds.bottom, caretTop:caret?.top, caretBottom:caret?.bottom,
        blockTop, headerTop:header?.top, headerBottom:header?.bottom, viewportTop:view.scrollDOM.getBoundingClientRect().top,
        scroll:view.scrollDOM.scrollTop, head:view.state.selection.main.head, focused:view.hasFocus};
    }, {opening});
    const observeSwitch = (event: 'click' | 'keydown') => page.evaluate(({opening,event}) => {
      const samples: (number | null)[] = [];
      (window as any).__mermaidNavigationFrames = samples;
      const sample = () => {
        const toolbar = document.querySelector(`.meo-mermaid-toolbar[data-meo-block-from="${opening}"]:not([data-meo-floating])`);
        samples.push(toolbar?.getBoundingClientRect().top ?? null);
        if (samples.length < 20) requestAnimationFrame(sample);
      };
      window.addEventListener(event, () => requestAnimationFrame(sample), {capture:true,once:true});
    }, {opening,event});
    const assertFrames = async (top: number, message: string) => {
      const samples = await page.evaluate(() => (window as any).__mermaidNavigationFrames as (number|null)[]);
      assert.ok(samples.length === 20 && samples.every(value => value !== null && Math.abs(value - top) <= 1.5),
        message + ': ' + JSON.stringify(samples));
    };
    for (const width of [520, 1200]) {
      await mount(text, width, width === 520 ? 'zh-CN' : 'en', width === 520 ? 'light' : 'dark', false);
      await page.evaluate(opening => {
        const view = (window as any).nativeEditor.view;
        view.scrollDOM.scrollTop = view.lineBlockAt(opening).top + 800;
      }, opening);
      await frames(12);
      const sticky = '.meo-block-sticky-header:not([hidden]) .meo-mermaid-mode-btn';
      await page.waitForSelector(sticky, {visible:true});
      await observeSwitch('click');
      await page.click(sticky);
      await frames(24);
      const entered = await geometry();
      assert.equal(entered.head, first, 'Explicit edit starts on the first Mermaid source line');
      assert.ok(Math.abs(entered.headerTop! - entered.viewportTop - 8) <= 1,
        `Sticky edit aligns the block header 8px below the viewport top (${width}): ${JSON.stringify(entered)}`);
      await assertFrames(entered.viewportTop + 8, 'Sticky edit must align before its first painted frame');
      assert.ok(entered.focused && entered.caretTop! >= Math.max(entered.top, entered.headerBottom!) && entered.caretBottom! <= entered.bottom,
        `Sticky edit must reveal the source caret below its header (${width}): ${JSON.stringify(entered)}`);
      assert.equal(Boolean(await page.$('.meo-mermaid-inline-preview')), width === 1200,
        'Navigation covers stacked and side-by-side layouts');
      await page.screenshot({path:`.local/mermaid-navigation-acceptance/enter-${width}.png`});
      for (const exit of ['button', 'escape']) {
        if (exit === 'escape') {
          await page.$eval('.meo-mermaid-toolbar:not([data-meo-floating]) .meo-mermaid-mode-btn', b=>(b as HTMLButtonElement).click());
          await frames(12);
        }
        await page.evaluate(position => {
          const view = (window as any).nativeEditor.view;
          view.dispatch({selection:{anchor:position}, scrollIntoView:true}); view.focus();
        }, text.indexOf('%% comment 55'));
        await frames(16);
        await observeSwitch(exit === 'button' ? 'click' : 'keydown');
        if (exit === 'button') { await page.waitForSelector(sticky,{visible:true}); await page.click(sticky); }
        else await page.keyboard.press('Escape');
        await frames(24);
        const finished = await geometry();
        assert.ok(Math.abs(finished.headerTop! - finished.viewportTop - 8) <= 1,
          `Explicit ${exit} aligns the block header (${width}): ${JSON.stringify(finished)}`);
        await assertFrames(finished.viewportTop + 8, `Explicit ${exit} must not flash through other positions`);
        assert.equal((await read()).text,text,'Navigation never changes Markdown');
        assert.equal(await page.$('.meo-mermaid-editing-preview'),null,'Explicit exit folds source');
        await page.screenshot({path:`.local/mermaid-navigation-acceptance/${exit}-${width}.png`});
      }
      await page.evaluate(() => { (window as any).nativeEditor.view.scrollDOM.scrollTop -= 12; });
      await frames(12);
      const visible = await geometry();
      await page.$eval('.meo-mermaid-toolbar:not([data-meo-floating]) .meo-mermaid-mode-btn', b=>(b as HTMLButtonElement).click());
      await frames(16);
      const reopened = await geometry();
      assert.ok(Math.abs(reopened.scroll - visible.scroll) <= 1,
        'Entering an already visible source does not scroll: ' + JSON.stringify({visible,reopened}));
      await page.keyboard.press('Escape');
      await frames(20);
      assert.ok(Math.abs((await geometry()).scroll - visible.scroll) <= 1,
        'Finishing beside an already visible diagram does not scroll');
      // A fully visible header is the only witness, even when its first source
      // line would fall outside the viewport after expanding.
      await page.evaluate(opening => {
        const view = (window as any).nativeEditor.view;
        const toolbar = view.dom.querySelector(`.meo-mermaid-toolbar[data-meo-block-from="${opening}"]:not([data-meo-floating])`)!;
        const rect = toolbar.getBoundingClientRect();
        view.scrollDOM.scrollTop += rect.bottom - view.scrollDOM.getBoundingClientRect().bottom + 2;
      }, opening);
      await frames(12);
      const bottomHeader = await geometry();
      await observeSwitch('click');
      await page.$eval('.meo-mermaid-toolbar:not([data-meo-floating]) .meo-mermaid-mode-btn', b=>(b as HTMLButtonElement).click());
      await frames(24);
      const bottomEntered = await geometry();
      assert.ok(Math.abs(bottomEntered.headerTop! - bottomHeader.headerTop!) <= 1,
        `A fully visible bottom header stays in place on entry (${width}): ${JSON.stringify({bottomHeader,bottomEntered})}`);
      await assertFrames(bottomHeader.headerTop!, 'Entering beside a visible bottom header must not flicker');
      await observeSwitch('keydown');
      await page.keyboard.press('Escape');
      await frames(24);
      assert.ok(Math.abs((await geometry()).headerTop! - bottomHeader.headerTop!) <= 1,
        'A fully visible bottom header stays in place on exit');
      await assertFrames(bottomHeader.headerTop!, 'Finishing beside a visible bottom header must not flicker');
      await page.evaluate(() => { (window as any).nativeEditor.view.scrollDOM.scrollTop -= 14; });
      await frames(12);
      const clipped = await geometry();
      assert.ok(clipped.headerTop! < clipped.bottom && clipped.headerBottom! > clipped.bottom,
        'Fixture exposes only part of the original header');
      await observeSwitch('click');
      await page.$eval('.meo-mermaid-toolbar:not([data-meo-floating]) .meo-mermaid-mode-btn', b=>(b as HTMLButtonElement).click());
      await frames(24);
      await assertFrames(clipped.viewportTop + 8, 'A partially clipped header aligns to the top on entry');
      await page.keyboard.press('Escape');
      await frames(24);
      await page.$eval('.meo-mermaid-toolbar:not([data-meo-floating]) .meo-mermaid-mode-btn', b=>(b as HTMLButtonElement).click());
      await frames(12);
      await page.evaluate(position => {
        const view = (window as any).nativeEditor.view;
        view.dispatch({selection:{anchor:position},scrollIntoView:true});view.focus();
      }, closing + 3);
      await frames(12);
      await page.keyboard.press('ArrowDown');
      await frames(24);
      const left = await geometry();
      assert.ok(left.head > closing + 3 && left.caretTop! >= left.top && left.caretBottom! <= left.bottom,
        `Natural keyboard exit follows the outside caret (${width}): ${JSON.stringify(left)}`);
      assert.equal(await page.$('.meo-mermaid-editing-preview'),null);
      await page.$eval('.meo-mermaid-toolbar:not([data-meo-floating]) .meo-mermaid-mode-btn', b=>(b as HTMLButtonElement).click());
      await frames(24);
      const after = text.indexOf('After paragraph 8');
      const point = await page.evaluate(async position => {
        const view = (window as any).nativeEditor.view;
        view.scrollDOM.scrollTop = view.lineBlockAt(position).top - 200;
        for (let i=0;i<12;i++) await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
        const caret = view.coordsAtPos(position)!;
        return {x:caret.left+3,y:(caret.top+caret.bottom)/2};
      },after);
      assert.ok(await page.$('.meo-mermaid-editing-preview'), 'Preparing the prose click must keep source open');
      await page.mouse.click(point.x,point.y);
      await frames(24);
      const clicked = await geometry();
      assert.ok(clicked.head >= after && clicked.head <= after + 'After paragraph 8'.length &&
        clicked.caretTop! >= clicked.top && clicked.caretBottom! <= clicked.bottom,
        `Clicking prose follows its caret without returning to the diagram (${width}): ${JSON.stringify(clicked)}`);
      assert.equal(await page.$('.meo-mermaid-editing-preview'),null);
      assert.equal((await read()).text,text);
      await page.evaluate(opening => {
        const view = (window as any).nativeEditor.view;
        view.scrollDOM.scrollTop = view.lineBlockAt(opening).top + 800;
      },opening);
      await frames(12);
      await page.waitForSelector(sticky,{visible:true});
      await page.click(sticky);
      await frames(2);
      const beforeWheel = await geometry();
      await page.mouse.move(width/2,400);
      await page.mouse.wheel({deltaY:400});
      await frames(12);
      const wheeled = await geometry();
      assert.ok(wheeled.scroll > beforeWheel.scroll + 100, 'A new wheel gesture supersedes the edit reveal');
      await frames(24);
      assert.ok(Math.abs((await geometry()).scroll-wheeled.scroll) <= 2,
        'Settling a reveal must not pull back a later wheel gesture');
      const tail = text.slice(0, opening) + '```mermaid\nflowchart LR\nA --> B\n' +
        Array.from({length:65}, (_, i) => '%% tail comment ' + i).join('\n') + '\n```';
      await mount(tail, width, width === 520 ? 'zh-CN' : 'en', width === 520 ? 'light' : 'dark', false);
      await page.$eval('.meo-mermaid-toolbar:not([data-meo-floating]) .meo-mermaid-mode-btn', b=>(b as HTMLButtonElement).click());
      await frames(24);
      await page.evaluate(position => {
        const view = (window as any).nativeEditor.view;
        view.dispatch({selection:{anchor:position},scrollIntoView:true}); view.focus();
      }, tail.indexOf('%% tail comment 55'));
      await frames(16);
      await observeSwitch('keydown');
      await page.keyboard.press('Escape');
      await frames(24);
      const boundary = await geometry();
      const atEnd = await page.evaluate(() => {
        const view = (window as any).nativeEditor.view;
        return Math.abs(view.scrollDOM.scrollTop - (view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight)) <= 1;
      });
      assert.ok(boundary.headerTop! >= boundary.viewportTop && boundary.headerBottom! <= boundary.bottom && atEnd,
        'Document-end clamping keeps the original header visible: ' + JSON.stringify(boundary));
      await assertFrames(boundary.headerTop!, 'Document-end exit must not flicker while clamping');
      assert.equal((await read()).text, tail, 'Exiting at the document end never inserts a line');
      console.log(`Mermaid explicit/natural navigation passed (${width})`);
    }
  };
  const assertKeyboardEntry = async () => {
    fs.mkdirSync('.local/mermaid-navigation-acceptance', {recursive:true});
    const text = Array.from({length:35}, (_, i) => 'Before ' + i + '\n').join('\n') +
      '\n```mermaid\nflowchart TD\nA-->B-->C-->D-->E-->F-->G-->H-->I-->J-->K-->L-->M-->N-->O\n```\n\n' +
      Array.from({length:35}, (_, i) => 'After ' + i + '\n').join('\n');
    const opening = text.indexOf('```mermaid'), closing = text.lastIndexOf('```');
    for (const {width,height} of [{width:520,height:800},{width:1200,height:800},{width:1200,height:360}])
    for (const key of ['ArrowUp','ArrowLeft','ArrowDown','ArrowRight']) {
      const forward = key === 'ArrowDown' || key === 'ArrowRight';
      await mount(text, width, width === 520 ? 'zh-CN' : 'en', width === 520 ? 'light' : 'dark', false);
      await page.setViewport({width,height,deviceScaleFactor:1});
      await page.evaluate(({position,height}) => {
        const view = (window as any).nativeEditor.view;
        view.dispatch({selection:{anchor:position}});
        view.scrollDOM.scrollTop = view.lineBlockAt(position).top - Math.min(400,height-100);
        view.focus();
      }, {position:forward ? opening - 1 : closing + 4,height});
      await frames(24);
      assert.equal(await page.$('.meo-mermaid-editing-preview'),null, 'Keyboard entry starts in reading mode');
      const before = await page.evaluate(() => (window as any).nativeEditor.view.scrollDOM.scrollTop);
      await page.keyboard.press(key);
      await frames(24);
      const entered = await page.evaluate(() => {
        const view = (window as any).nativeEditor.view;
        const bounds = (window as any).MermaidEditingHarness.editorViewportBounds(view);
        const caret = view.coordsAtPos(view.state.selection.main.head);
        return {head:view.state.selection.main.head, caretTop:caret?.top, caretBottom:caret?.bottom,
          top:bounds.top,bottom:bounds.bottom,scroll:view.scrollDOM.scrollTop};
      });
      assert.equal(entered.head, forward ? opening : closing + (key === 'ArrowLeft' ? 3 : 0),
        key + ' enters the corresponding fence');
      assert.ok(await page.$('.meo-mermaid-editing-preview'), key + ' expands the Mermaid source');
      assert.ok(entered.caretTop! >= entered.top && entered.caretBottom! <= entered.bottom,
        `Entering a tall diagram must keep the final caret visible (${width}x${height}/${key}): ${JSON.stringify(entered)}`);
      if (forward) assert.ok(Math.abs(entered.scroll-before) <= 1, 'An already visible entry caret needs no scroll');
      assert.equal((await read()).text,text,'Natural entry does not change Markdown');
      if (key === 'ArrowUp') await page.screenshot({path:`.local/mermaid-navigation-acceptance/keyboard-entry-${width}-${height}.png`});
      console.log(`Tall Mermaid keyboard entry passed (${width}x${height}/${key})`);
    }
  };
  const assertKeyboardBoundaryStability = async () => {
    fs.mkdirSync('.local/mermaid-navigation-acceptance', {recursive:true});
    const text = Array.from({length:35}, (_, i) => 'Before ' + i + '\n').join('\n') +
      '\n```mermaid\nflowchart TD\n' + Array.from({length:70}, (_, i) => `N${i}[Stage ${i}] --> N${i+1}[Stage ${i+1}]`).join('\n') +
      '\n```\n\n' + Array.from({length:35}, (_, i) => 'After ' + i + '\n').join('\n');
    const opening = text.indexOf('```mermaid'), closing = text.lastIndexOf('```');
    for (const width of [520,1200]) for (const fromAbove of [false,true]) for (const vertical of [true,false])
    for (const screenTop of width===1200 && !fromAbove && vertical ? [650,45] : [fromAbove?160:650]) {
      const outside = fromAbove ? opening-1 : closing+4;
      await mount(text,width,width===520?'zh-CN':'en',width===520?'light':'dark',false);
      await page.evaluate(({outside,screenTop}) => {
        const view = (window as any).nativeEditor.view;
        view.dispatch({selection:{anchor:outside}});
        view.scrollDOM.scrollTop = view.lineBlockAt(outside).top - screenTop;
        view.focus();
      },{outside,screenTop});
      await frames(24);
      const boundary = () => page.evaluate(outside => {
        const view = (window as any).nativeEditor.view;
        const caret = view.coordsAtPos(view.state.selection.main.head);
        const bounds = (window as any).MermaidEditingHarness.editorViewportBounds(view);
        return {top:view.coordsAtPos(outside)?.top,caretTop:caret?.top,caretBottom:caret?.bottom,
          viewportTop:bounds.top,viewportBottom:bounds.bottom,head:view.state.selection.main.head,lineHeight:view.defaultLineHeight};
      },outside);
      const before = await boundary();
      for (let cycle=0;cycle<3;cycle++) for (const entering of [true,false]) {
        const backward = entering !== fromAbove;
        await page.keyboard.press(vertical ? backward ? 'ArrowUp':'ArrowDown' : backward ? 'ArrowLeft':'ArrowRight');
        await frames(24);
        const after = await boundary();
        assert.ok(after.caretTop!>=after.viewportTop && after.caretBottom!<=after.viewportBottom,
          'Boundary retention must preserve the existing visible-caret baseline: '+JSON.stringify(after));
        if (entering && !fromAbove && width===520) {
          assert.ok(Math.abs(after.caretTop!-(before.caretTop!-before.lineHeight))<=1.5,
            'A stacked preview between the fence and prose must preserve the natural caret row: '+JSON.stringify({before,after}));
        } else assert.ok(after.top!==undefined && Math.abs(after.top-before.top!)<=(screenTop<80?before.lineHeight+1.5:1.5),
          `Keyboard boundary stays at its original screen Y (${width}/${fromAbove}/${cycle}/${entering}): ${JSON.stringify({before,after})}`);
        const editing = await page.$$eval(`.meo-mermaid-toolbar[data-meo-block-from="${opening}"]`,
          nodes => nodes.some(node => (node as HTMLElement).dataset.meoMermaidMode==='edit'));
        assert.equal(editing,entering,'The visible toolbar follows the natural boundary transition');
        if (cycle===0 && vertical && !fromAbove && screenTop>80) await page.screenshot({
          path:`.local/mermaid-navigation-acceptance/boundary-${width}-${entering?'edit':'read'}.png`
        });
      }
      assert.equal((await read()).text,text);
      console.log(`Mermaid keyboard boundary roundtrip passed (${width}/${fromAbove?'above':'below'}/${vertical?'vertical':'horizontal'}/${screenTop})`);
    }
  };
  const boundaryOnly = process.argv.includes('--boundary-navigation-only');
  if (!boundaryOnly && !process.argv.includes('--keyboard-navigation-only')) await assertNavigation();
  if (!boundaryOnly) await assertKeyboardEntry();
  await assertKeyboardBoundaryStability();
  if (process.argv.includes('--navigation-only') || process.argv.includes('--keyboard-navigation-only') || boundaryOnly) {
    assert.deepEqual(errors, []);
    console.log('Mermaid navigation contract passed');
    process.exitCode = 0;
  } else {
  const containers = [
    { name: 'plain', before: 'Before\n\n', prefix: '' },
    { name: 'list', before: 'Before\n\n- Parent\n\n', prefix: '  ' },
    { name: 'nested-list', before: 'Before\n\n- Parent\n  - Child\n\n', prefix: '    ' },
    { name: 'quote', before: 'Before\n\n', prefix: '> ' },
    { name: 'quote-list', before: 'Before\n\n> - Parent\n>\n', prefix: '>   ' },
    { name: 'footnote', before: 'Before[^1]\n\n[^1]: Note\n\n', prefix: '    ' }
  ];
  let cases = 0;
  for (const width of [520, 1100])
    for (const c of containers) {
      const text =
        c.before +
        ['```mermaid', 'flowchart LR', '  A[Initial] --> B[End]', '```'].map((line) => c.prefix + line).join('\n') +
        '\n\nAfter';
      await mount(text, width);
      assert.equal(await page.$$eval('[data-meo-code-line-number]', nodes => nodes.length), 0,
        'Mermaid uses only the main document gutter');
      const join = await page.$eval('.meo-mermaid-source-join', line => {
        const preview = line.nextElementSibling!, a = line.getBoundingClientRect(), b = preview.getBoundingClientRect();
        return { radius: getComputedStyle(line).borderBottomLeftRadius,
          background: getComputedStyle(line).backgroundColor === getComputedStyle(preview).backgroundColor,
          edges: [b.top - a.bottom, b.left - a.left, b.right - a.right] };
      });
      assert.ok(join.radius === '0px' && join.background && join.edges.every(distance => Math.abs(distance) <= 1),
        `${c.name}/${width}: source and preview join continuously ${JSON.stringify(join)}`);
      await page.waitForFunction(() => {
        const e = (window as any).nativeEditor, v = e.view;
        const color = (text: string) => {
          const node = v.domAtPos(e.getText().indexOf(text) + 2).node;
          return getComputedStyle(node.nodeType === Node.TEXT_NODE ? node.parentElement : node).color;
        };
        return color('flowchart') !== color('Initial');
      });
      assert.equal((await read()).text, text, `${c.name}: opening does not modify Markdown`);
      await select('Initial');
      await page.keyboard.type('Changed');
      await frames();
      assert.equal(await page.$$eval('[data-meo-code-line-number]', nodes => nodes.length), 0,
        'Input refresh does not restore Mermaid local numbers');
      assert.equal((await read()).text, text.replace('Initial', 'Changed'));
      await page.waitForFunction(() =>
        document.querySelector('.meo-mermaid-block svg')?.textContent?.includes('Changed')
      );
      await page.keyboard.down('Control');
      await page.keyboard.press('z');
      await page.keyboard.up('Control');
      await frames();
      assert.equal((await read()).text, text, `${c.name}: native undo`);
      await page.keyboard.down('Control');
      await page.keyboard.press('y');
      await page.keyboard.up('Control');
      await frames();
      assert.equal((await read()).text, text.replace('Initial', 'Changed'), `${c.name}: native redo`);
      await select('Changed');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      await frames();
      assert.ok(
        (await read()).text.includes('Changed\n' + c.prefix + ']'),
        `${c.name}: Enter preserves the container exactly once`
      );
      await page.keyboard.press('Tab');
      await frames();
      assert.ok((await read()).text.includes('Changed\n' + c.prefix + '  ]'));
      await page.keyboard.down('Shift');
      await page.keyboard.press('Tab');
      await page.keyboard.up('Shift');
      await frames();
      assert.ok((await read()).text.includes('Changed\n' + c.prefix + ']'));
      await page.$eval('.meo-select-all-code-btn', (b) => (b as HTMLButtonElement).click());
      await frames();
      const selected = await read();
      assert.ok(selected.anchor > selected.text.indexOf('```mermaid'));
      assert.ok(selected.head < selected.text.lastIndexOf('```'));
      await page.evaluate(() => {
        (window as any).nativeEditor.pastePlainText('flowchart LR\nA[中文] --> B[结果]');
      });
      await frames();
      assert.ok((await read()).text.includes(c.prefix + 'flowchart LR\n' + c.prefix + 'A[中文] --> B[结果]'));
      await select('中文');
      const client = await page.createCDPSession();
      await client.send('Input.imeSetComposition', { text: '新', selectionStart: 1, selectionEnd: 1 });
      await client.send('Input.imeSetComposition', { text: '新的', selectionStart: 2, selectionEnd: 2 });
      await client.send('Input.insertText', { text: '新的' });
      await client.detach();
      await frames(12);
      assert.ok((await read()).text.includes('A[新的]'));
      assert.equal((await read()).focus, true);
      const beforeMode = await read();
      await page.evaluate(() => {
        const e = (window as any).nativeEditor;
        e.setMode('source');
        e.setMode('live');
      });
      await frames();
      assert.equal((await read()).head, beforeMode.head);
      assert.equal((await read()).text, beforeMode.text);
      await page.$eval('.meo-select-all-code-btn', (b) => (b as HTMLButtonElement).click());
      await page.keyboard.press('Backspace');
      await frames();
      assert.ok(
        (await read()).text.includes('```mermaid\n' + c.prefix + '\n' + c.prefix + '```'),
        `${c.name}: empty source and fences survive`
      );
      assert.equal((await read()).focus, true);
      await page.keyboard.type('flowchart LR\nA-->B');
      await frames();
      await page.$eval('.meo-mermaid-mode-btn', (b) => (b as HTMLButtonElement).click());
      await frames();
      assert.equal(await page.$('.meo-mermaid-inline-preview'), null);
      assert.equal(
        await page.$eval('.meo-mermaid-toolbar', (e) => (e as HTMLElement).dataset.meoMermaidMode),
        'preview'
      );
      cases++;
      console.log('Native Mermaid input:', c.name, width);
    }
  for (const [index, c] of containers.entries()) {
    const payload = ['flowchart TD', 'A[Start] --> B[End]',
      ...Array.from({ length: 80 }, (_, number) => '%% source comment ' + number +
        ' reading context'.repeat(number % 13 === 0 ? 12 : 1))];
    const text = c.before + ['```mermaid', ...payload, '```'].map(line => c.prefix + line).join('\n') + '\n\nAfter';
    await mount(text, 1100, index % 2 ? 'zh-CN' : 'en', index % 2 ? 'light' : 'dark');
    await page.waitForSelector('.meo-mermaid-inline-preview');
    assert.equal(await page.$eval('.meo-mermaid-inline-preview .meo-native-source-preview-label', e => getComputedStyle(e).display), 'flex',
      'Side layout shares the preview heading and its layout action');
    assert.equal(await page.$eval('.meo-mermaid-inline-preview .meo-mermaid-layout-btn', e => e.textContent),
      index % 2 ? '切换为上下' : 'Switch to rows');
    const proseWidth = await page.evaluate(() => {
      const v = (window as any).nativeEditor.view, n = v.domAtPos(2).node;
      return (n.nodeType === Node.TEXT_NODE ? n.parentElement : n).closest('.cm-line').getBoundingClientRect().width;
    });
    await page.click('.meo-mermaid-layout-btn');
    await frames();
    assert.equal(await page.evaluate(() => {
      const v = (window as any).nativeEditor.view, n = v.domAtPos(2).node;
      return (n.nodeType === Node.TEXT_NODE ? n.parentElement : n).closest('.cm-line').getBoundingClientRect().width;
    }), proseWidth, c.name + ': switching a block layout leaves prose width unchanged');
    await page.evaluate(() => {
      const e = (window as any).nativeEditor, v = e.view;
      v.scrollDOM.scrollTop = v.lineBlockAt(e.getText().lastIndexOf('```')).top - 100;
    });
    await frames(12);
    await page.waitForSelector('.meo-native-source-preview-label .meo-mermaid-layout-btn');
    await page.click('.meo-mermaid-layout-btn');
    await frames();
    await page.evaluate(() => {
      const e = (window as any).nativeEditor, v = e.view, pos = e.getText().indexOf('source comment 40');
      v.dispatch({ selection: { anchor: pos + 5 } }); v.focus();
    });
    await frames();
    await page.evaluate(() => {
      const e = (window as any).nativeEditor, v = e.view;
      v.scrollDOM.scrollTop = v.lineBlockAt(e.getText().indexOf('source comment 40')).top - 100;
    });
    await frames(12);
    const middle = await page.evaluate(() => {
      const v = (window as any).nativeEditor.view, pane = document.querySelector('.meo-mermaid-inline-preview')!;
      const p = pane.getBoundingClientRect(), canvas = pane.querySelector('.meo-mermaid-editing-preview')!.getBoundingClientRect();
      const viewport = v.scrollDOM.getBoundingClientRect(), caret = v.coordsAtPos(v.state.selection.main.head);
      const n = v.domAtPos((window as any).nativeEditor.getText().indexOf('source comment 39')).node;
      const wrapped = (n.nodeType === Node.TEXT_NODE ? n.parentElement : n).closest('.cm-line');
      const walker = document.createTreeWalker(wrapped, NodeFilter.SHOW_TEXT), rights: number[] = [];
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (text.parentElement?.closest('.meo-md-code-container-prefix')) continue;
        const range = document.createRange(); range.selectNodeContents(text);
        for (const rect of range.getClientRects()) if (rect.width > 0) rights.push(rect.right);
      }
      return { paneTop: p.top, canvasTop: canvas.top, canvasBottom: canvas.bottom,
        diagramTop: pane.querySelector('.meo-mermaid-block')!.getBoundingClientRect().top,
        viewportTop: viewport.top, viewportBottom: viewport.bottom, paneLeft: p.left,
        caretRight: caret.right, wrapRight: Math.max(...rights) };
    });
    assert.ok(middle.paneTop < middle.viewportTop && middle.canvasTop >= middle.viewportTop && middle.diagramTop >= middle.viewportTop + 28 &&
      middle.canvasBottom <= middle.viewportBottom + 1 && middle.caretRight < middle.paneLeft && middle.wrapRight <= middle.paneLeft + 1,
      `${c.name}: long source keeps its caret and sticky preview in separate visible columns ${JSON.stringify(middle)}`);
    await page.evaluate(() => {
      const e = (window as any).nativeEditor, v = e.view;
      v.scrollDOM.scrollTop = v.lineBlockAt(e.getText().lastIndexOf('```')).top - v.scrollDOM.clientHeight / 2;
    });
    await frames(12);
    const end = await page.evaluate(() => {
      const e = (window as any).nativeEditor, v = e.view, pane = document.querySelector('.meo-mermaid-inline-preview')!;
      const row = (position: number) => { const n = v.domAtPos(position).node;
        return (n.nodeType === Node.TEXT_NODE ? n.parentElement : n).closest('.cm-line').getBoundingClientRect(); };
      const closing = row(e.getText().lastIndexOf('```')), after = row(e.getText().lastIndexOf('After'));
      const p = pane.getBoundingClientRect(), canvas = pane.querySelector('.meo-mermaid-editing-preview')!.getBoundingClientRect();
      return { right: p.right - closing.right, bottom: p.bottom - closing.bottom,
        withinBlock: canvas.bottom <= p.bottom + 1, beforeProse: p.bottom <= after.top };
    });
    assert.ok(Math.abs(end.right) <= 1 && Math.abs(end.bottom) <= 1 && end.withinBlock && end.beforeProse,
      `${c.name}: sticky preview stops at the block boundary ${JSON.stringify(end)}`);
    assert.equal((await read()).text, text, 'Layout and scrolling never change Markdown');
  }
  for (const appearance of ['light', 'dark'] as const) {
    const sequence = 'Before\n\n> ```mermaid\n> sequenceDiagram\n>   participant Reader\n>   participant Editor\n>   Reader->>Editor: Edit document\n> ```\n\nAfter';
    await mount(sequence, 1100, 'en', appearance);
    await page.waitForFunction(() => {
      const e = (window as any).nativeEditor, v = e.view;
      const color = (text: string) => {
        const node = v.domAtPos(e.getText().indexOf(text) + 2).node;
        return getComputedStyle(node.nodeType === Node.TEXT_NODE ? node.parentElement : node).color;
      };
      return new Set(['sequenceDiagram', 'Reader', 'Edit document'].map(color)).size === 3;
    });
    assert.equal((await read()).text, sequence, 'Lazy Mermaid highlighting preserves original container source');
    assert.equal((await read()).focus, true, 'Lazy highlighting preserves native editing focus');
    await page.$eval('.meo-mermaid-layout-btn', b => (b as HTMLElement).click());
    await frames(12);
    const short = await page.evaluate(() => {
      const pane = document.querySelector('.meo-mermaid-inline-preview')!.getBoundingClientRect();
      const space = document.querySelector('.meo-mermaid-side-space')!.getBoundingClientRect();
      return { height: pane.height, tail: space.height, right: pane.right - space.right, bottom: pane.bottom - space.bottom };
    });
    assert.ok(short.height >= 300 && short.tail > 0 && Math.abs(short.right) <= 1 && Math.abs(short.bottom) <= 1,
      `Short source reserves only its missing preview height ${JSON.stringify(short)}`);
    assert.equal((await read()).text, sequence, 'Reserving preview height does not add document lines');
  }
  const long =
    'Before\n\n```mermaid\nflowchart TD\n' +
    Array.from({ length: 20 }, (_, i) => `N${i} --> N${i + 1}`).join('\n') +
    '\n```\n\nAfter';
  await mount(long, 1200);
  await page.waitForSelector('.meo-mermaid-inline-preview');
  await page.evaluate(() => {
    const e = (window as any).nativeEditor;
    (window as any).sidePreviewWitness = document.querySelector('.meo-mermaid-inline-preview');
    e.view.dispatch({selection:{anchor:e.getText().indexOf('N5'),head:0}}); e.view.focus();
  });
  await frames();
  assert.equal(await page.evaluate(() => document.querySelector('.meo-mermaid-inline-preview') === (window as any).sidePreviewWitness),
    true, 'Cross-block selection keeps the current side layout and diagram');
  await page.evaluate(() => {
    const e = (window as any).nativeEditor;
    e.view.dispatch({ selection: { anchor: e.getText().indexOf('N5'), head: e.getText().length } });
  });
  await frames();
  assert.equal(await page.evaluate(() => document.querySelector('.meo-mermaid-inline-preview') === (window as any).sidePreviewWitness),
    true, 'Forward cross-block selection also retains the side panel');
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await frames();
  assert.equal(await page.evaluate(() => document.querySelector('.meo-mermaid-inline-preview') === (window as any).sidePreviewWitness),
    true, 'Main-document select-all retains the editing layout');
  await page.evaluate(() => ((window as any).nativeEditor.view.contentDOM as HTMLElement).blur());
  await frames();
  assert.equal(await page.evaluate(() => document.querySelector('.meo-mermaid-inline-preview') === (window as any).sidePreviewWitness),
    true, 'Temporary blur retains the editing layout');
  await select('N5');
  const drag = await page.evaluate(() => {
    const e = (window as any).nativeEditor, v = e.view;
    v.scrollDOM.scrollTop = 0;
    const from = v.coordsAtPos(e.getText().indexOf('N1'))!, to = v.coordsAtPos(2)!;
    return { from: { x: from.left + 2, y: (from.top + from.bottom) / 2 },
      to: { x: to.left + 2, y: (to.top + to.bottom) / 2 } };
  });
  await page.mouse.move(drag.from.x, drag.from.y);
  await page.mouse.down();
  await page.mouse.move(drag.to.x, drag.to.y, { steps: 12 });
  await page.mouse.up();
  await frames();
  const dragged = await read();
  assert.ok(dragged.anchor > long.indexOf('```mermaid') && dragged.head < long.indexOf('```mermaid'),
    'Native mouse drag actually crosses from source into preceding prose');
  assert.equal(await page.evaluate(() => document.querySelector('.meo-mermaid-inline-preview') === (window as any).sidePreviewWitness),
    true, 'Native mouse drag retains the same side preview');
  await select('N5');
  await page.evaluate(() => {
    document.body.classList.add('meo-content-max-width-enabled');
    document.documentElement.style.setProperty('--meo-content-max-width', '700px');
  });
  await frames();
  assert.ok(
    (await page.$eval('.cm-content', (e) => e.getBoundingClientRect().width)) > 300,
    'Side layout gives source its column width instead of inheriting full-page centering padding'
  );
  const beforeWidth = await page.$eval('.cm-scroller', (e) => e.getBoundingClientRect().width);
  const beforePadding = await page.$eval('.meo-mermaid-inline-source', e => parseFloat(getComputedStyle(e).paddingRight));
  const separator = await page.$eval('.meo-mermaid-inline-separator', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + 100 };
  });
  await page.mouse.move(separator.x, separator.y);
  await page.mouse.down();
  await page.mouse.move(separator.x + 80, separator.y, { steps: 5 });
  await page.mouse.up();
  await frames();
  assert.equal(await page.$eval('.cm-scroller', (e) => e.getBoundingClientRect().width), beforeWidth,
    'Dragging a block separator does not resize the document viewport');
  assert.ok(await page.$eval('.meo-mermaid-inline-source', e => parseFloat(getComputedStyle(e).paddingRight)) < beforePadding - 50,
    'Dragging changes only this block source width');
  await select('N10');
  await page.keyboard.type('Edited');
  await frames();
  assert.ok(await page.$('.meo-mermaid-inline-preview'));
  await page.$eval('.meo-mermaid-layout-btn', (b) => (b as HTMLButtonElement).click());
  await frames();
  assert.equal(await page.$('.meo-mermaid-inline-preview'), null);
  await page.$eval('.meo-mermaid-mode-btn', (b) => (b as HTMLButtonElement).click());
  await frames();
  await page.$eval('.meo-mermaid-mode-btn', (b) => (b as HTMLButtonElement).click());
  await frames();
  assert.equal(await page.$('.meo-mermaid-inline-preview'), null, 'Manual stacked preference persists');
  await page.$eval('.meo-mermaid-layout-btn', (b) => (b as HTMLButtonElement).click());
  await frames();
  await page.setViewport({ width: 520, height: 800 });
  await frames();
  assert.equal(await page.$('.meo-mermaid-inline-preview'), null);
  await page.setViewport({ width: 1200, height: 800 });
  await frames();
  assert.ok(await page.$('.meo-mermaid-inline-preview'), 'Narrow fallback retains the preference');
  await page.evaluate(() => {
    const e = (window as any).nativeEditor;
    e.view.dispatch({ changes: { from: e.getText().length, insert: '\n\n```mermaid\nflowchart LR\nSecond --> Chart\n```' } });
    (window as any).sidePreviewWitness = document.querySelector('.meo-mermaid-inline-preview');
    e.view.dispatch({ selection: { anchor: e.getText().indexOf('N5'), head: e.getText().indexOf('Second') + 3 } });
  });
  await frames();
  assert.equal(await page.evaluate(() => document.querySelector('.meo-mermaid-inline-preview') === (window as any).sidePreviewWitness),
    true, 'Selection ending inside another Mermaid does not switch the active diagram');
  await page.evaluate(() => document.body.classList.remove('meo-content-max-width-enabled'));
  for (const appearance of ['light', 'dark'] as const)
    for (const language of ['zh-CN', 'en']) {
      await mount('Before\n\n```mermaid\nflowchart LR\nA[Initial] --> B\n```\n\nAfter', 1100, language, appearance);
      const copy = await page.$eval('.meo-copy-code-btn', (e) => e.getAttribute('aria-label'));
      assert.match(copy ?? '', language === 'en' ? /Copy/ : /复制/);
      assert.ok(await page.$('.meo-copy-image-btn'));
      assert.ok(await page.$('.meo-select-all-code-btn'));
      await select('Initial');
      await page.keyboard.type('Unfinished[');
      await frames(20);
      await page.waitForSelector('.meo-mermaid-error-badge');
      assert.match(
        await page.$eval('.meo-mermaid-error-badge', (e) => e.textContent ?? ''),
        language === 'en' ? /Mermaid error/ : /Mermaid 错误/
      );
      await page.$eval('.meo-copy-image-btn', (e) => e.dispatchEvent(new PointerEvent('pointerenter')));
      assert.equal(await page.$eval('.meo-copy-image-btn', (e) => e.getAttribute('aria-disabled')), 'true');
      fs.mkdirSync('.local/mermaid-native-acceptance', { recursive: true });
      await page.screenshot({ path: `.local/mermaid-native-acceptance/${appearance}-${language}.png` });
    }
  assert.deepEqual(errors, []);
  console.log(
    `Native Mermaid editing passed: ${cases} container/width cases, six long-source containers, local layout, history, IME, controls and bilingual appearances`
  );
  }
} catch (error) {
  failure = error;
}
if (failure === undefined) await closeTestBrowser(browser);
else await closeTestBrowser(browser, failure);
