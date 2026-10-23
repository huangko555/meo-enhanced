import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 900, height: 750 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: fs.readFileSync('node_modules/katex/dist/katex.min.css', 'utf8').replace(/url\((fonts\/[^)]+)\)/g,
    (_match, file) => `url(data:font/${path.extname(file).slice(1)};base64,${fs.readFileSync(path.join('node_modules/katex/dist', file)).toString('base64')})`) });
  await page.addStyleTag({ content: ':root{--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:Consolas,monospace;--meo-font-source-size:14px;--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b2024;--meo-semantic-blockquoteBorder:#66717c;--meo-semantic-blockquoteForeground:#b6c2ce}' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (text: string) => { (window as any).copiedMath = text; }
  } }));
  const settle = () => page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  const setup = async (text: string) => {
    await page.evaluate(text => {
      const host = window as any;
      host.mathEditor?.destroy(); document.querySelector('#app')!.replaceChildren();
      host.mathEditor = host.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'),
        text, initialMode: 'live', sourceLineNumbers: 'on', uiLanguage: 'zh-CN', onApplyChanges() {} });
    }, text);
    await settle();
  };
  const readText = () => page.evaluate(() => (window as any).mathEditor.getText());
  const shortcut = async (key: string) => {
    await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control');
  };
  const fixtures = [
    { name: 'plain', opening: '', prefix: '' },
    { name: 'list', opening: '- ', prefix: '  ' },
    { name: 'nested-list', opening: '  - ', prefix: '    ' },
    { name: 'list-continuation', opening: '   ', prefix: '   ', before: '1. Item\n' },
    { name: 'quote', opening: '> ', prefix: '> ' },
    { name: 'quote-list', opening: '> - ', prefix: '>   ' },
    { name: 'nested-quote', opening: '> > > ', prefix: '> > > ' },
    { name: 'list-quote', opening: '  > ', prefix: '  > ', before: '- Item\n' },
    { name: 'task-list-continuation', opening: '  ', prefix: '  ', before: '- [ ] Item\n' },
    { name: 'list-tab', opening: '\t', prefix: '\t', before: '- Item\n' },
    { name: 'footnote-quote', opening: '    > ', prefix: '    > ', before: 'Reference[^a].\n\n[^a]: Note' },
    { name: 'footnote', opening: '    ', prefix: '    ', before: 'Reference[^a].\n\n[^a]: Note' }
  ];
  fs.mkdirSync('.local/display-math-alignment', { recursive: true });
  let combinations = 0;
  for (const language of ['math', 'latex', 'tex', 'katex']) {
    for (const [index, fixture] of fixtures.entries()) {
      await page.setViewport({ width: index % 2 ? 520 : 1100, height: 900 });
      const fence = index % 2 ? '~~~~' : '```';
      const text = `${fixture.before ?? 'Before'}\n\n${fixture.opening}${fence}${language}\n${fixture.prefix}x^2 + 1\n${fixture.prefix}${fence}\n\nAfter`;
      await setup(text);
      assert.ok(await page.$('.meo-md-math-fenced-display .katex'), `${language}/${fixture.name}: shared reading component`);
      assert.equal(await page.$('.meo-rendered-block-preview'), null, 'No diagram shell');
      assert.equal(await page.$('.meo-visual-controls'), null, 'No diagram zoom/pan controls');
      const before = await page.evaluate(() => { const ed = (window as any).mathEditor; return {
        selection: ed.view.state.selection.toJSON(), history: ed.getHistoryDepth() }; });
      await page.hover('.meo-md-math-fenced-display');
      await page.click('.meo-md-math-fenced-display .meo-copy-code-btn');
      assert.equal(await page.evaluate(() => (window as any).copiedMath), 'x^2 + 1');
      assert.deepEqual(await page.evaluate(() => { const ed = (window as any).mathEditor; return {
        selection: ed.view.state.selection.toJSON(), history: ed.getHistoryDepth() }; }), before, 'Copy preserves document selection and history');
      await page.click('.meo-md-math-fenced-display .katex'); await settle();
      const layout = await page.evaluate(() => {
        const ed = (window as any).mathEditor;
        const sources = Array.from(document.querySelectorAll<HTMLElement>('.meo-math-source-line'));
        const result = document.querySelector<HTMLElement>('.meo-math-live-result')!;
        const resultRect = result.getBoundingClientRect();
        return { editors: document.querySelectorAll('.cm-editor').length, focused: ed.view.hasFocus,
          source: sources[0]!.textContent, label: result.querySelector('.meo-math-result-status')?.textContent,
          below: result.getBoundingClientRect().top >= sources.at(-1)!.getBoundingClientRect().bottom - 1,
          resultControls: result.querySelectorAll('button,[role="button"]').length,
          edges: sources.map(source => { const rect = source.getBoundingClientRect(); return {
            left: rect.left - resultRect.left, right: rect.right - resultRect.right }; }),
          quoteRails: sources.filter(source => source.matches('.meo-md-quote-source-order')).map(source => {
            const sourceRail = getComputedStyle(source, '::before'), resultRail = getComputedStyle(result, '::before');
            return source.getBoundingClientRect().left + parseFloat(sourceRail.left) + parseFloat(sourceRail.backgroundPositionX)
              - resultRect.left - parseFloat(resultRail.left) - parseFloat(resultRail.backgroundPositionX);
          }) };
      });
      assert.equal(layout.editors, 1, 'Source remains in the document editor');
      assert.ok(layout.focused && layout.below, `${language}/${fixture.name}: source above preview`);
      assert.ok(layout.source?.includes(fence + language), 'Original fence language is visible in source');
      assert.equal(layout.label, '预览');
      assert.equal(layout.resultControls, 0, 'Editing actions belong to source');
      assert.ok(layout.edges.every(edge => Math.abs(edge.left) < 1 && Math.abs(edge.right) < 1),
        `${language}/${fixture.name}: source and result backgrounds must align: ${JSON.stringify(layout.edges)}`);
      assert.ok(layout.quoteRails.every(offset => Math.abs(offset) < 1),
        `${language}/${fixture.name}: quote rails must continue through source and result: ${JSON.stringify(layout.quoteRails)}`);
      const bounds = await page.evaluate(fence => {
        const result = document.querySelector<HTMLElement>('.meo-math-live-result')!.getBoundingClientRect();
        const source = document.querySelector<HTMLElement>('.meo-math-source-start')!.getBoundingClientRect();
        const actions = document.querySelector<HTMLElement>('.meo-math-source-actions')!.getBoundingClientRect();
        const content = document.querySelector<HTMLElement>('.cm-content')!.getBoundingClientRect();
        const view = (window as any).mathEditor.view;
        const caret = view.coordsAtPos(view.state.selection.main.head)!;
        const body = view.state.doc.lineAt(view.state.selection.main.head);
        const opening = view.state.doc.line(body.number - 1), closing = view.state.doc.line(body.number + 1);
        const markers = [opening, closing].map(line => view.coordsAtPos(line.from + line.text.indexOf(fence))!);
        const quoteOffset = body.text.lastIndexOf('>');
        const quote = quoteOffset < 0 ? null : view.coordsAtPos(body.from + quoteOffset + 1);
        return { panelFits: result.left >= content.left && result.right <= content.right + 1,
          actionsFit: actions.left >= source.left && actions.right <= source.right + 1,
          payloadFits: caret.left >= result.left - 1 && caret.left <= result.right + 1,
          delimitersFit: markers.every(marker => marker.left >= result.left - 1 && marker.left <= result.right + 1),
          quoteOutside: !quote || quote.left <= result.left + 1 };
      }, fence);
      assert.ok(Object.values(bounds).every(Boolean),
        `${language}/${fixture.name}: panel, source payload and actions must stay inside the available content: ${JSON.stringify(bounds)}`);
      if (language === 'math' && ['quote', 'list-continuation'].includes(fixture.name)) {
        await page.screenshot({ path: `.local/display-math-alignment/${fixture.name}.png` });
      }
      await page.click('.meo-math-source-actions .meo-select-all-code-btn');
      assert.equal(await page.evaluate(() => { const view = (window as any).mathEditor.view;
        return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to); }), 'x^2 + 1');
      await page.keyboard.press('End'); await page.keyboard.type(' + 2'); await settle();
      assert.equal(await readText(), text.replace('x^2 + 1', 'x^2 + 1 + 2'));
      assert.ok(await page.$eval('.meo-math-live-result', element => element.textContent!.includes('2')));
      await shortcut('z'); await settle();
      assert.equal(await readText(), text, 'Undo restores original syntax');
      const selection = await page.evaluate(() => (window as any).mathEditor.view.state.selection.toJSON());
      for (const mode of ['source', 'live']) {
        await page.evaluate(mode => (window as any).mathEditor.setMode(mode), mode); await settle();
        assert.equal(await readText(), text);
        assert.deepEqual(await page.evaluate(() => (window as any).mathEditor.view.state.selection.toJSON()), selection);
      }
      await page.keyboard.press('Tab'); await settle();
      assert.equal(await readText(), text.replace('x^2 + 1', '  x^2 + 1'), 'TeX source indent stays in the document');
      await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); await settle();
      assert.equal(await readText(), text, 'Outdent preserves Markdown containers');
      await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('y=2'); await settle();
      assert.equal(await readText(), text.replace('x^2 + 1', 'x^2 + 1\n' + fixture.prefix + 'y=2'), 'Enter keeps the source inside its container');
      await shortcut('z'); await settle();
      assert.equal(await readText(), text, 'Undo newline and typing together');
      await shortcut('Enter'); await settle();
      assert.equal(await page.$('.meo-math-live-result'), null, 'Finish editing returns to reading');
      assert.equal(await readText(), text, 'Finishing preserves source');
      for (const target of ['html', 'pdf', 'docx'] as const) {
        const rendered = renderMarkdownToHtml({ markdownText: text, markdownFilePath: 'C:/tmp/math.md', target }).html;
        assert.equal((rendered.match(/class="meo-export-math /g) ?? []).length, 1, `${target}/${language}/${fixture.name}`);
        assert.ok(!rendered.includes('katex-error'));
      }
      combinations++;
    }
  }
  let extremeCombinations = 0;
  for (const fixture of fixtures.filter(fixture => ['nested-quote', 'list-continuation', 'list-tab', 'footnote-quote'].includes(fixture.name))) {
    for (const width of [320, 520]) {
      for (const fontSize of [12, 24]) {
        await page.setViewport({ width, height: 900 });
        await page.evaluate(fontSize => document.documentElement.style.setProperty('--meo-font-source-size', fontSize + 'px'), fontSize);
        const body = '\\frac{' + 'a'.repeat(120) + '}{b}+\\sum_{i=1}^{n}i';
        // No following blank line: the same panel must also close correctly at EOF.
        const text = `${fixture.before ?? 'Before'}\n\n${fixture.opening}\`\`\`math\n${fixture.prefix}${body}\n${fixture.prefix}\`\`\``;
        await setup(text); await page.click('.meo-md-math-fenced-display .katex'); await settle();
        const geometry = await page.evaluate(() => {
          const view = (window as any).mathEditor.view;
          const result = document.querySelector<HTMLElement>('.meo-math-live-result')!;
          const panel = result.getBoundingClientRect();
          const sources = Array.from(document.querySelectorAll<HTMLElement>('.meo-math-source-line'));
          const sourceLine = view.state.doc.lineAt(view.state.selection.main.head);
          const payload = sourceLine.from + sourceLine.text.indexOf('\\frac');
          const caret = view.coordsAtPos(payload)!;
          const bases = Array.from(result.querySelectorAll('.katex-html > .base'), base => base.getBoundingClientRect());
          const actions = document.querySelector<HTMLElement>('.meo-math-source-actions')!.getBoundingClientRect();
          return { edgesAlign: sources.every(source => { const box = source.getBoundingClientRect();
            return Math.abs(box.left - panel.left) < 1 && Math.abs(box.right - panel.right) < 1; }),
            payloadInside: caret.left >= panel.left - 1 && caret.left <= panel.right + 1,
            resultFits: bases.every(base => base.left >= panel.left - 1 && base.right <= panel.right + 1),
            actionsFit: actions.left >= panel.left && actions.right <= panel.right + 1,
            noHorizontalOverflow: result.scrollWidth <= result.clientWidth + 1 };
        });
        assert.ok(Object.values(geometry).every(Boolean), `${fixture.name}/${width}/${fontSize}px/long formula at EOF: ${JSON.stringify(geometry)}`);
        assert.equal(await readText(), text, 'Layout changes preserve all container prefixes and TeX');
        extremeCombinations++;
      }
    }
  }
  await page.setViewport({ width: 320, height: 900 });
  for (const fixture of fixtures.filter(fixture => ['nested-quote', 'list-continuation', 'footnote-quote'].includes(fixture.name))) {
    for (const body of ['', '\\frac{']) {
      const text = `${fixture.before ?? 'Before'}\n\n${fixture.opening}\`\`\`latex\n${fixture.prefix}${body}\n${fixture.prefix}\`\`\``;
      await setup(text); await page.click('.meo-md-math-fenced-display'); await settle();
      const aligned = await page.evaluate(() => {
        const result = document.querySelector<HTMLElement>('.meo-math-live-result')!.getBoundingClientRect();
        return Array.from(document.querySelectorAll<HTMLElement>('.meo-math-source-line')).every(source => {
          const box = source.getBoundingClientRect(); return Math.abs(box.left - result.left) < 1 && Math.abs(box.right - result.right) < 1;
        });
      });
      assert.ok(aligned, `${fixture.name}/${body || 'empty'}: error/empty panels must also align at EOF`);
      assert.equal(await readText(), text);
      extremeCombinations++;
    }
  }
  await page.evaluate(() => document.documentElement.style.removeProperty('--meo-font-source-size'));
  // Copy/select omit optional wrappers without trimming the expression inside.
  for (const [body, expected] of [
    ['$x^2 + 1$', 'x^2 + 1'], ['$$ x^2 + 1 $$', ' x^2 + 1 '],
    ['$$\nx^2 + 1\n$$', 'x^2 + 1'], ['$$\n\n  x^2 + 1  \n\n$$', '\n  x^2 + 1  \n'],
    ['\n  x^2 + 1  \n', '\n  x^2 + 1  \n']
  ]) {
    const text = 'Before\n\n```MATH label\n' + body + '\n```\n\nAfter';
    await setup(text);
    assert.equal(await page.$('.katex-error'), null, body);
    await page.hover('.meo-md-math-fenced-display');
    await page.click('.meo-md-math-fenced-display .meo-copy-code-btn');
    assert.equal(await page.evaluate(() => (window as any).copiedMath), expected);
    assert.equal(await page.$('.meo-md-math-fenced-display .meo-select-all-code-btn'), null);
    await page.click('.meo-md-math-fenced-display .katex'); await settle();
    await page.click('.meo-math-source-actions .meo-select-all-code-btn'); await settle();
    assert.equal(await page.evaluate(() => { const state = (window as any).mathEditor.view.state;
      return state.doc.sliceString(state.selection.main.from, state.selection.main.to); }), expected);
    assert.equal(await readText(), text, 'Copy/select do not rewrite editable wrappers');
    for (const target of ['html', 'pdf', 'docx'] as const) {
      const html = renderMarkdownToHtml({ markdownText: text, markdownFilePath: 'C:/tmp/math.md', target }).html;
      assert.ok(html.includes('class="katex"') && !html.includes('katex-error'));
      const payload = /data-source-b64="([^"]+)"/.exec(html)![1]!;
      assert.equal(Buffer.from(payload, 'base64').toString(), expected, 'Export/Preview copy uses the same body');
    }
  }
  for (const body of ['', '\\frac{', '$$x^2', '\\documentclass{article}']) {
    const text = 'Before\n\n```latex\n' + body + '\n```\n\nAfter';
    await setup(text);
    assert.ok(await page.$('.meo-md-math-fenced-display'), 'Empty/invalid TeX keeps an editable formula component');
    await page.click('.meo-md-math-fenced-display'); await settle();
    assert.ok(await page.$('.meo-math-source-actions .meo-select-all-code-btn'));
    assert.equal(await readText(), text);
  }
  for (const language of ['math', 'latex', 'tex', 'katex']) {
    const text = 'Before\n\n```' + language + '\nx=1\n```\n\nAfter';
    await setup(text); await page.click('.meo-md-math-fenced-display .katex'); await settle();
    await page.click('.meo-math-source-actions .meo-select-all-code-btn');
    await page.keyboard.type('\\frac{'); await settle();
    assert.ok(await page.$('.meo-math-result-status[role="status"]'), 'Incomplete input retains the last valid result');
    assert.ok(await page.$('.meo-math-live-result .katex'));
    for (let undo = 0; undo < 6 && await readText() !== text; undo++) { await shortcut('z'); await settle(); }
    assert.equal(await readText(), text, 'Undo all actual typing groups restores the original body');
    for (const direction of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft']) {
      const forward = direction === 'ArrowDown' || direction === 'ArrowRight';
      await page.evaluate(forward => { const view = (window as any).mathEditor.view;
        const line = view.state.doc.line(forward ? 2 : 6);
        view.dispatch({ selection: { anchor: forward ? line.to : line.from } }); view.focus(); }, forward);
      await page.keyboard.press(direction); await settle();
      assert.ok(await page.$('.meo-math-live-result'), `${language}/${direction}: caret entry reveals source`);
      await shortcut('Enter'); await settle();
    }
  }
  for (const language of ['math', 'latex', 'tex', 'katex']) {
    for (const plain of [false, true]) {
      const text = 'Before\n\n> ```' + language + '\n> x=1\n> ```\n\nAfter';
      await setup(text); await page.click('.meo-md-math-fenced-display .katex'); await settle();
      await page.click('.meo-math-source-actions .meo-select-all-code-btn');
      await page.evaluate(plain => {
        const ed = (window as any).mathEditor;
        if (plain) ed.pastePlainText('p=1\nq=2');
        else {
          const data = new DataTransfer(); data.setData('text/plain', 'p=1\nq=2');
          ed.view.contentDOM.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
        }
      }, plain);
      await settle();
      assert.equal(await readText(), text.replace('> x=1', '> p=1\n> q=2'), `${language}: native/plain paste keeps container and original fence`);
      await shortcut('z'); await settle(); assert.equal(await readText(), text);
    }
  }
  const indentedFence = 'Before\n\n  ```math\n  x=1\n```\n\nAfter';
  await setup(indentedFence); await page.click('.meo-md-math-fenced-display .katex'); await settle();
  assert.equal(await page.evaluate(() => { const view = (window as any).mathEditor.view;
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    return view.state.selection.main.head - line.from; }), 2, 'Fence indentation is respected even when the closing fence is unindented');
  await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.keyboard.type('y=2'); await settle();
  assert.equal(await readText(), indentedFence.replace('  x=1', '  x=1\n  y=2'));
  for (const text of ['Before\n\n```math\nx=1\n\nAfter', 'Before\n\n```javascript\n$$\nx=1\n$$\n```\n\nAfter',
    'Before\n\n```mathml\n<math>x</math>\n```\n\nAfter']) {
    await setup(text);
    assert.equal(await page.$('.meo-md-math-fenced-display'), null, 'Unclosed fences and non-TeX languages remain ordinary editable source');
    assert.equal(await readText(), text);
  }
  assert.deepEqual(errors, []);
  console.log(`Math fences passed: ${combinations} alias/container combinations, ${extremeCombinations} narrow/font/long-formula/EOF combinations, aligned backgrounds and quote rails, shared source/result/actions/history, wrapper copy and HTML/PDF/Word render parity, empty/invalid/unclosed boundaries`);
} catch (error) { primary = error; }
finally { if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
