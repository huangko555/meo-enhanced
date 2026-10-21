import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: fs.readFileSync('node_modules/katex/dist/katex.min.css', 'utf8').replace(/url\((fonts\/[^)]+)\)/g,
    (_match, file) => `url(data:font/${path.extname(file).slice(1)};base64,${fs.readFileSync(path.join('node_modules/katex/dist', file)).toString('base64')})`) });
  await page.addStyleTag({ content: ':root{--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-size:16px;--meo-semantic-codeCopyBackground:transparent;--meo-semantic-codeCopyHoverBackground:rgba(127,127,127,.2)}' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).copiedMath = text; } } }));
  const settle = () => page.evaluate(async () => { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  const fixtures = [
    { name: 'plain', prefix: '', opening: '$$' },
    { name: 'list', prefix: '  ', opening: '- $$' },
    { name: 'nested-list', prefix: '    ', opening: '  - $$' },
    { name: 'quote', prefix: '> ', opening: '> $$' },
    { name: 'quote-list', prefix: '>   ', opening: '> - $$' },
    { name: 'footnote', prefix: '    ', opening: '    $$', before: 'Before\n\nReference[^a].\n\n[^a]: Note' }
  ];
  let combinations = 0;
  for (const width of [520, 1100]) {
    await page.setViewport({ width, height: 900 });
    for (const fixture of fixtures) {
      await page.evaluate(fixture => {
        const host = window as any;
        host.mathEditor?.destroy();
        document.querySelector('#app')!.replaceChildren();
        host.mathEditor = host.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'),
          text: `${fixture.before ?? 'Before'}\n\n${fixture.opening}\n${fixture.prefix}x^2 + 1\n${fixture.prefix}$$\n\nAfter`,
          initialMode: 'live', onApplyChanges() {} });
      }, fixture);
      await settle();
      const initial = await page.$eval('.meo-md-math-fenced-display', element => ({
        background: getComputedStyle(element).backgroundColor,
        controls: element.querySelectorAll('.meo-visual-controls').length,
        copy: element.querySelectorAll('.meo-copy-code-btn').length,
        shell: !!element.closest('.meo-rendered-block-preview')
      }));
      assert.deepEqual(initial, { background: 'rgba(0, 0, 0, 0)', controls: 0, copy: 1, shell: false }, fixture.name);
      const docBeforeCopy = await page.evaluate(() => (window as any).mathEditor.view.state.doc.toString());
      const beforeCopy = await page.evaluate(() => { const editor = (window as any).mathEditor; return {
        selection: editor.view.state.selection.toJSON(), history: editor.getHistoryDepth() }; });
      await page.hover('.meo-md-math-fenced-display');
      assert.equal(await page.$eval('.meo-math-copy-actions', element => getComputedStyle(element).opacity), '1');
      await page.click('.meo-md-math-fenced-display .meo-copy-code-btn');
      assert.equal(await page.evaluate(() => (window as any).copiedMath), 'x^2 + 1');
      assert.equal(await page.evaluate(() => (window as any).mathEditor.view.state.doc.toString()), docBeforeCopy);
      assert.deepEqual(await page.evaluate(() => { const editor = (window as any).mathEditor; return {
        selection: editor.view.state.selection.toJSON(), history: editor.getHistoryDepth() }; }), beforeCopy);
      await page.click('.meo-md-math-fenced-display .katex');
      await settle();
      const editing = await page.evaluate(() => {
        const view = (window as any).mathEditor.view;
        const sourceLine = view.state.doc.lineAt(view.state.selection.main.head);
        const caret = view.coordsAtPos(view.state.selection.main.head);
        const preview = document.querySelector('.meo-math-live-result')!.getBoundingClientRect();
        return { editors: document.querySelectorAll('.cm-editor').length, focused: view.hasFocus,
          text: sourceLine.text, caretTop: caret?.top, previewTop: preview.top,
          payloadInside: caret!.left >= preview.left - 1 && caret!.left <= preview.right + 1,
          edges: Array.from(document.querySelectorAll('.meo-math-source-line'), source => {
            const rect = source.getBoundingClientRect(); return { left: rect.left - preview.left, right: rect.right - preview.right };
          }) };
      });
      assert.equal(editing.editors, 1, 'Formula source must use the document editor');
      assert.equal(editing.focused, true);
      assert.ok(editing.text.includes('x^2'));
      assert.ok(editing.previewTop > editing.caretTop!, 'Result must follow source');
      assert.ok(editing.payloadInside, `${fixture.name}/${width}: TeX source must remain inside the panel`);
      assert.ok(editing.edges.every(edge => Math.abs(edge.left) < 1 && Math.abs(edge.right) < 1),
        `${fixture.name}/${width}: source and result backgrounds must align: ${JSON.stringify(editing.edges)}`);
      const controls = await page.evaluate(() => {
        const view = (window as any).mathEditor.view;
        const actions = view.dom.querySelector('.meo-math-source-actions') as HTMLElement;
        const preview = view.dom.querySelector('.meo-math-live-result') as HTMLElement;
        const copy = actions.querySelector('.meo-copy-code-btn') as HTMLElement;
        const select = actions.querySelector('.meo-select-all-code-btn') as HTMLElement;
        return { previewLabel: preview.querySelector('.meo-math-result-status')?.textContent,
          resultButtons: preview.querySelectorAll('[role="button"]').length,
          controlsTop: actions.getBoundingClientRect().top,
          previewTop: preview.getBoundingClientRect().top,
          copyColor: getComputedStyle(copy).color, selectColor: getComputedStyle(select).color,
          overlap: copy.getBoundingClientRect().left < select.getBoundingClientRect().right };
      });
      assert.equal(controls.previewLabel, 'Preview');
      assert.equal(controls.resultButtons, 0, 'Editing controls belong to the source');
      assert.ok(controls.controlsTop < controls.previewTop);
      assert.equal(controls.copyColor, controls.selectColor, 'Formula actions share ordinary code button colors');
      assert.equal(controls.overlap, false);
      const selected = await page.evaluate(() => { const view = (window as any).mathEditor.view;
        const head = view.state.selection.main.head; view.dispatch({ selection: { anchor: head, head: head + 3 } });
        return view.state.selection.toJSON(); });
      await page.hover('.meo-math-source-start'); await page.click('.meo-math-source-actions .meo-copy-code-btn');
      assert.deepEqual(await page.evaluate(() => (window as any).mathEditor.view.state.selection.toJSON()), selected, 'Copy preserves source selection');
      assert.equal(await page.evaluate(() => (window as any).mathEditor.view.hasFocus), true);
      await page.click('.meo-math-live-result .katex');
      assert.deepEqual(await page.evaluate(() => (window as any).mathEditor.view.state.selection.toJSON()), selected, 'Result click preserves the source caret');
      await page.click('.meo-math-source-actions .meo-select-all-code-btn');
      assert.equal(await page.evaluate(() => { const view = (window as any).mathEditor.view;
        return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to); }), 'x^2 + 1');
      assert.equal(await page.evaluate(() => (window as any).mathEditor.view.hasFocus), true);
      await page.keyboard.press('End');
      await page.keyboard.type(' + 2');
      await settle();
      assert.ok((await page.$eval('.meo-math-live-result', element => element.textContent))!.includes('2'));
      await page.keyboard.down('Control'); await page.keyboard.press('z'); await page.keyboard.up('Control');
      await settle();
      assert.equal(await page.evaluate(() => (window as any).mathEditor.view.state.doc.toString()), docBeforeCopy);
      await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control');
      await settle();
      assert.equal(await page.$('.meo-math-live-result'), null);
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('meo-block-reading-target')), true);
      assert.equal(await page.evaluate(() => (window as any).mathEditor.view.state.doc.toString()), docBeforeCopy,
        'Finishing returns to block reading focus without changing document text');
      const positions = await page.evaluate(() => {
        const view = (window as any).mathEditor.view;
        const lines = Array.from({ length: view.state.doc.lines }, (_, index) => view.state.doc.line(index + 1));
        const opening = lines.find((line: any) => line.text.includes('$$')) as any;
        const closing = lines.find((line: any) => line.number > opening.number && line.text.includes('$$')) as any;
        return { opening: opening.number, closing: closing.number };
      });
      for (const direction of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) {
        const forward = direction === 'ArrowDown' || direction === 'ArrowRight';
        await page.evaluate(({ positions, forward }) => {
          const view = (window as any).mathEditor.view;
          const line = view.state.doc.line(forward ? positions.opening - 1 : positions.closing + 1);
          view.dispatch({ selection: { anchor: forward ? line.to : line.from } }); view.focus();
        }, { positions, forward });
        await page.keyboard.press(direction); await settle();
        assert.ok(await page.$('.meo-math-live-result'), 'Arrow navigation must reveal source');
        await page.keyboard.down('Control'); await page.keyboard.press('Enter'); await page.keyboard.up('Control'); await settle();
      }
      for (const direction of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) {
        const forward = direction === 'ArrowDown' || direction === 'ArrowRight';
        await page.evaluate(({ positions, forward }) => { const view = (window as any).mathEditor.view;
          const boundary = view.state.doc.line(forward ? positions.closing : positions.opening);
          view.dispatch({ selection: { anchor: forward ? boundary.to : boundary.from } }); view.focus();
        }, { positions, forward });
        await settle(); assert.ok(await page.$('.meo-math-live-result'));
        await page.keyboard.press(direction); await settle();
        assert.equal(await page.$('.meo-math-live-result'), null, 'Leaving delimiters returns to reading');
      }
      await page.click('.meo-md-math-fenced-display .katex'); await settle();
      const originalSelection = await page.evaluate(() => (window as any).mathEditor.view.state.selection.toJSON());
      for (const mode of ['source', 'live']) {
        await page.evaluate(mode => (window as any).mathEditor.setMode(mode), mode); await settle();
        assert.deepEqual(await page.evaluate(() => (window as any).mathEditor.view.state.selection.toJSON()), originalSelection, 'Global mode changes preserve the document selection');
      }
      const originalHistory = await page.evaluate(() => (window as any).mathEditor.getHistoryDepth());
      await page.$eval('.meo-math-source-actions .meo-copy-code-btn', element => (element as HTMLElement).focus());
      assert.ok(await page.$('.meo-math-live-result'), 'Keyboard focus and blur do not collapse source');
      await page.keyboard.press('Enter'); await settle();
      assert.deepEqual(await page.evaluate(() => (window as any).mathEditor.getHistoryDepth()), originalHistory);
      await page.evaluate(() => { const view = (window as any).mathEditor.view;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        view.dispatch({ changes: { from: line.from + line.text.indexOf('x^2'), to: line.to, insert: '\\frac{' },
          selection: { anchor: line.from + line.text.indexOf('x^2') + 6 } }); view.focus(); });
      await settle();
      assert.ok(await page.$('.meo-math-result-status[role="status"]'), 'Incomplete input labels the last valid result');
      assert.ok(await page.$('.meo-math-live-result .katex'));
      await page.hover('.meo-math-source-start'); await page.click('.meo-math-source-actions .meo-copy-code-btn');
      assert.equal(await page.evaluate(() => (window as any).copiedMath), '\\frac{', 'Copy uses current source even if the preview is stale');
      await page.keyboard.type('a}{b}'); await settle();
      assert.equal(await page.$('.meo-math-result-status[role="status"]'), null, 'Completed input replaces the stale result');
      await page.evaluate(prefix => { const view = (window as any).mathEditor.view;
        const line = view.state.doc.lineAt(view.state.selection.main.head);
        view.dispatch({ changes: { from: line.from + prefix.length, to: line.to, insert: '' }, selection: { anchor: line.from + prefix.length } });
      }, fixture.prefix); await settle();
      assert.ok(await page.$('.meo-math-live-result'), 'Empty formulas keep the editable block');
      await page.keyboard.type('x = 2'); await settle();
      const beforeIndent = await page.evaluate(() => (window as any).mathEditor.view.state.doc.toString());
      await page.keyboard.press('Tab'); await settle();
      assert.ok(await page.$('.meo-math-live-result'), 'Indenting retains the formula container');
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); await settle();
      assert.equal(await page.evaluate(() => (window as any).mathEditor.view.state.doc.toString()), beforeIndent, 'Tab and Shift+Tab preserve the container and restore source');
      await page.keyboard.press('Enter'); await page.keyboard.type('+ y'); await settle();
      assert.ok(await page.$('.meo-math-live-result .katex'), 'Newlines retain container prefixes and the live formula');
      assert.equal(await page.evaluate(() => (window as any).mathEditor.view.hasFocus), true);
      const client = await page.createCDPSession();
      await client.send('Input.imeSetComposition', { text: '中', selectionStart: 1, selectionEnd: 1 });
      await client.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
      await client.send('Input.insertText', { text: '中文' });
      await client.detach(); await settle();
      assert.equal(await page.evaluate(() => (window as any).mathEditor.view.state.doc.toString().match(/中文/g)?.length), 1, 'Composition commits exactly once');
      assert.equal(await page.evaluate(() => (window as any).mathEditor.view.hasFocus), true);
      await page.evaluate(() => { const view = (window as any).mathEditor.view; const data = new DataTransfer();
        data.setData('text/plain', '\n  + z');
        view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true })); });
      await settle();
      assert.ok(await page.$('.meo-math-live-result'), `${fixture.name}: multiline paste retains the editable formula: ${await page.evaluate(() => (window as any).mathEditor.view.state.doc.toString())}`);
      assert.equal(await page.evaluate(() => (window as any).mathEditor.view.state.doc.toString().includes('  + z')), true, 'Paste preserves intentional indentation');
      const visibleSource = await page.$$eval('.cm-line.meo-math-source-line', lines => lines.map(line => line.textContent));
      assert.ok(visibleSource.some(line => line?.includes('+ y中文')), `${fixture.name}: TeX operators remain visible source: ${JSON.stringify(visibleSource)}`);
      assert.ok(visibleSource.some(line => line?.includes('  + z')), `${fixture.name}: TeX indentation remains visible source: ${JSON.stringify(visibleSource)}`);
      if (width === 1100 && fixture.name === 'plain') {
        fs.mkdirSync('.local/display-math', { recursive: true });
        await page.screenshot({ path: '.local/display-math/source-above-result.png' });
      }
      combinations++;
    }
  }
  for (const source of ['x=' + Array.from({ length: 24 }, (_, index) => `a_{${index}}`).join('+'), '\\begin{pmatrix}' + Array.from({ length: 3 }, () => Array.from({ length: 12 }, (_, index) => String(index)).join('&')).join('\\\\') + '\\end{pmatrix}']) {
    await page.setViewport({ width: 520, height: 900 });
    await page.evaluate(source => { const host = window as any; host.mathEditor.destroy(); document.querySelector('#app')!.replaceChildren();
      host.mathEditor = host.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'), text: `Before\n\n$$\n${source}\n$$\n\nAfter`, initialMode: 'live', onApplyChanges() {} }); }, source);
    await settle();
    const geometry = await page.$eval('.meo-md-math-fenced-display', element => {
      const root = element.getBoundingClientRect();
      const boxes = Array.from(element.querySelectorAll('.katex-html .base')).map(base => base.getBoundingClientRect());
      return { width: root.width, left: root.left, right: root.right, min: Math.min(...boxes.map(rect => rect.left)), max: Math.max(...boxes.map(rect => rect.right)), scroll: element.scrollWidth - element.clientWidth };
    });
    assert.ok(geometry.scroll <= 1 && geometry.min >= geometry.left - 1 && geometry.max <= geometry.right + 1, JSON.stringify(geometry));
  }
  await page.evaluate(() => { const host = window as any; host.mathEditor.destroy(); document.querySelector('#app')!.replaceChildren();
    host.mathEditor = host.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'), text: 'Before\n\n> $$\n>\n> $$\n\nAfter', initialMode: 'live', onApplyChanges() {} }); });
  await settle();
  await page.hover('.meo-md-math-fenced-display'); await page.click('.meo-md-math-fenced-display .meo-copy-code-btn');
  assert.equal(await page.evaluate(() => (window as any).copiedMath), '', 'A bare quote marker is a Markdown container, not formula source');
  await page.click('.meo-md-math-fenced-display'); await settle();
  assert.equal(await page.evaluate(() => { const view = (window as any).mathEditor.view; return view.state.doc.lineAt(view.state.selection.main.head).number; }), 4, 'Entering a bare empty quote line keeps the caret in the formula body');
  await page.keyboard.type(' x'); await settle();
  assert.ok(await page.$('.meo-math-live-result .katex'));
  for (const appearance of ['light', 'dark']) {
    await page.setViewport({ width: 950, height: 800 });
    await page.evaluate(appearance => {
      const host = window as any;
      host.mathEditor.destroy(); document.querySelector('#app')!.replaceChildren();
      document.documentElement.dataset.editorAppearance = appearance;
      const light = appearance === 'light';
      for (const [name, value] of Object.entries({ '--meo-background': light ? '#fafafa' : '#24292e',
        '--meo-foreground': light ? '#24292e' : '#e6edf3', '--meo-code-background': light ? '#f0f1f3' : '#1b2024',
        '--vscode-editor-background': light ? '#fafafa' : '#24292e',
        '--vscode-editor-foreground': light ? '#24292e' : '#e6edf3',
        '--meo-code-palette-background': light ? '#f0f1f3' : '#1b2024',
        '--meo-code-palette-foreground': light ? '#24292e' : '#e6edf3' }))
        document.documentElement.style.setProperty(name, value);
      document.body.className = light ? 'vscode-light' : 'vscode-dark';
      host.MermaidEditingHarness.applyUiTheme(appearance, true);
      host.mathEditor = host.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'), uiLanguage: 'zh-CN',
        text: '# 公式编辑\n\n$$\nr = \\frac{6}{8} \\times 100\\% = 75\\%\n$$\n\n源码在上，预览在下。\n\n$$\nx^2+y^2=z^2\n$$\n\n正文继续。',
        initialMode: 'live', onApplyChanges() {} });
    }, appearance); await settle();
    await page.click('.meo-md-math-fenced-display .katex'); await settle();
    const visual = await page.evaluate(() => {
      const source = document.querySelector('.meo-math-source-line')!;
      const result = document.querySelector('.meo-math-live-result')!;
      const copy = document.querySelector('.meo-math-source-actions .meo-copy-code-btn')!;
      const actions = document.querySelector('.meo-math-source-actions')!;
      const probe = document.createElement('span');
      probe.style.color = 'var(--meo-code-action-foreground)';
      document.body.append(probe);
      const expectedColor = getComputedStyle(probe).color;
      probe.remove();
      const sourceRect = source.getBoundingClientRect(), actionRect = actions.getBoundingClientRect();
      return { source: getComputedStyle(source).backgroundColor, result: getComputedStyle(result).backgroundColor,
        color: getComputedStyle(copy).color, expectedColor, label: result.querySelector('.meo-math-result-status')?.textContent,
        controlsFit: actionRect.top >= sourceRect.top && actionRect.bottom <= sourceRect.bottom + 1 };
    });
    assert.equal(visual.source, visual.result);
    assert.notEqual(visual.source, 'rgba(0, 0, 0, 0)');
    assert.equal(visual.color, visual.expectedColor);
    assert.equal(visual.label, '预览');
    assert.ok(visual.controlsFit, 'Toolbar must fit the existing delimiter line without adding a document row');
    await page.screenshot({ path: `.local/display-math/editing-${appearance}.png` });
  }
  assert.deepEqual(errors, []);
  console.log(`Display math editing passed: ${combinations} container/width combinations, copy/selection, four-way entry/exit, live result, undo, global modes, errors, empty input, IME, paste and long formula layout`);
} catch (error) { primary = error; } finally {
  if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary);
}
