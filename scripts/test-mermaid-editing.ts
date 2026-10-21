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
  const mount = async (text: string, width: number, language = 'en', appearance: 'light' | 'dark' = 'dark') => {
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
    await page.waitForSelector('.meo-mermaid-block svg');
    await frames();
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
} catch (error) {
  failure = error;
}
if (failure === undefined) await closeTestBrowser(browser);
else await closeTestBrowser(browser, failure);
