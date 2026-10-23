import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-highlight-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser(), page = await browser.newPage();
const errors: string[] = [];
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
let step = 'initial';
try {
  await page.setViewport({ width: 980, height: 660 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  const katexDirectory = path.resolve('node_modules/katex/dist');
  await page.addStyleTag({ content: readFileSync(path.join(katexDirectory, 'katex.min.css'), 'utf8')
    .replace(/url\(([^)]+)\)/g, (_match, fontPath) => `url(data:font/woff2;base64,${readFileSync(path.join(katexDirectory, fontPath)).toString('base64')})`) });
  await page.addStyleTag({ content: ':root{--vscode-editor-font-family:Consolas,monospace;--vscode-editor-font-weight:400;--vscode-editor-font-size:16px;--meo-user-editor-font-size:16px}' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const rules = [
    { scope: 'entity.name.function.math.tex', settings: { foreground: '#cc5500' } },
    { scope: 'constant.character.math.tex', settings: { foreground: '#0066cc' } },
    { scope: 'constant.numeric.math.tex', settings: { foreground: '#008844' } },
    { scope: 'comment.line.math.tex', settings: { foreground: '#885588' } },
    { scope: 'punctuation.math.operator.latex', settings: { foreground: '#aa2277' } }
  ];
  const prepare = async (mode: string, text: string, head = text.indexOf('frac') + 3, theme: any = darkPlus, custom = true) => {
    await page.evaluate(({ mode, text, head, theme, rules, custom }) => {
      const g = window as any, h = g.HighlightHarness;
      g.editor?.destroy();
      const palette = { ...theme, tokenColors: [...theme.tokenColors, ...(custom ? rules : [])] };
      document.body.className = theme.type === 'light' ? 'vscode-light' : 'vscode-dark';
      const style = document.documentElement.style;
      style.setProperty('--vscode-editor-foreground', theme.colors['editor.foreground'] ?? '#d4d4d4');
      style.setProperty('--vscode-editor-background', theme.colors['editor.background'] ?? '#1e1e1e');
      h.applyBuiltInVisualBaseline(theme.type);
      h.setShikiTheme(palette); h.setShikiTheme(palette, 'source');
      style.setProperty('--meo-source-foreground', theme.colors['editor.foreground'] ?? '#d4d4d4');
      style.setProperty('--meo-background', theme.colors['editor.background'] ?? '#1e1e1e');
      style.setProperty('--meo-foreground', theme.colors['editor.foreground'] ?? '#d4d4d4');
      g.editor = h.createEditor({ parent: document.getElementById('app'), text, initialMode: mode,
        initialCursorPos: head, onApplyChanges() {} });
      g.editor.view.dispatch({ selection: { anchor: head } }); g.editor.focus();
    }, { mode, text, head: Math.max(0, head), theme, rules, custom });
  };
  const color = (needle: string, offset = 1) => page.evaluate(({ needle, offset }) => {
    const editor = (window as any).editor, position = editor.getText().indexOf(needle) + offset;
    const dom = editor.view.domAtPos(position, -1), element = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node;
    return getComputedStyle(element).color;
  }, { needle, offset });
  const expectColor = async (needle: string, expected: string, offset = 1) => {
    try {
      await page.waitForFunction(({ needle, expected, offset }) => {
        const editor = (window as any).editor, position = editor.getText().indexOf(needle) + offset;
        const dom = editor.view.domAtPos(position, -1), element = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node;
        return getComputedStyle(element).color === expected;
      }, { timeout: 6000 }, { needle, expected, offset });
    } catch {
      console.error(JSON.stringify({ step, errors, html: await page.$eval('.cm-content', node => node.innerHTML.slice(0, 5000)) }));
      throw new Error(step + ': ' + needle + ' expected ' + expected + ', got ' + await color(needle, offset));
    }
  };
  const formula = String.raw`\frac{x_1}{2} + \alpha`;
  const fixtures = [
    '行内 $' + formula + '$ 结束', '$$' + formula + '$$', '$$\n' + formula + '\n$$',
    ...['math', 'latex', 'tex', 'katex'].map(language => '```' + language + '\n' + formula + '\n```'),
    '> $$\n> ' + formula + '\n> $$',
    '- 公式\n\n  ```math\n  ' + formula + '\n  ```',
    '$' + formula, '$$\n' + formula, '```math\n' + formula,
    '$$\n\\frac{x}{2} + \\alpha + \\% % 注释\n\\alpha\n$$',
    '$' + formula + '$\n\n```python\nprint(9)\n```'
  ];
  for (const mode of ['source', 'live']) for (const theme of [lightPlus, darkPlus]) {
    for (const text of fixtures) {
      step = mode + '/' + theme.type + '/' + text.split('\n')[0];
      await prepare(mode, text, undefined, theme);
      await expectColor('frac', 'rgb(204, 85, 0)');
      await expectColor('2', 'rgb(0, 136, 68)');
      await expectColor('alpha', 'rgb(0, 102, 204)');
      if (text.includes('注释')) {
        await expectColor('注释', 'rgb(136, 85, 136)');
        assert.notEqual(await color('\\%'), 'rgb(136, 85, 136)', step + ': escaped percent is not a comment');
      }
      assert.equal(await page.evaluate(() => (window as any).editor.getText()), text, step + ': paint preserves source');
    }
    step = mode + '/' + theme.type + '/literal boundaries';
    for (const separator of ['\n', '\n\n']) for (const [opening, content, boundary] of [
      ['$$', '\\frac{x}{2}', '## Next'],
      ['$$', '\\frac{x}{2}', '```text'],
      ['$$', '\\frac{x}{2}', '~~~text'],
      ['$$', '\\frac{x}{2}', '```python'],
      ['$$', '\\frac{x', '## Next'],
      ['> $$', '> \\frac{x}{2}', '> ## Next'],
      ['- $$', '  \\frac{x}{2}', '  ## Next'],
      ['> - $$', '>   \\frac{x}{2}', '>   ## Next'],
      ['> $$', '> \\frac{x}{2}', '> ```text'],
      ['> $$', '> \\frac{x}{2}', '> ```python'],
      ['> $$', '> \\frac{x', '> ## Next'],
      ['> $$', '> \\frac{x}{2}', 'outside'],
      ['> > $$', '> > \\frac{x}{2}', '> outside'],
      ['- $$', '  \\frac{x}{2}', 'outside'],
      ['- $$', '  \\frac{x}{2}', '- sibling'],
      ['12. $$', '    \\frac{x}{2}', 'outside'],
      ['> - $$', '>   \\frac{x}{2}', '> outside'],
      ['> - $$', '>   \\frac{x}{2}', '> - sibling']
    ]) {
      step = mode + '/' + theme.type + '/unfinished boundary/' + opening + '/' + boundary + '/' + separator.length;
      const prefix = /^[ \t]*(?:>[ \t]*)*/.exec(boundary)![0];
      const following = boundary + '\n' + prefix + 'ordinary 42 \\alpha';
      // Keep Markdown's own lazy quote/list continuation and code palettes.
      await prepare(mode, opening.replace('$$', 'formula') + '\n' + content + separator + following, 0, theme);
      await page.evaluate(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      const expectedAlpha = await color('alpha'), expectedNumber = await color('42');
      const expectedHeading = boundary.includes('Next') ? await color('Next') : null;
      const text = opening + '\n' + content + separator + following;
      await prepare(mode, text, undefined, theme);
      await expectColor('frac', 'rgb(204, 85, 0)');
      await expectColor('alpha', expectedAlpha);
      await expectColor('42', expectedNumber);
      if (expectedHeading) await expectColor('Next', expectedHeading);
      assert.equal(await page.evaluate(() => (window as any).editor.getText()), text, step + ': recovery preserves source');
    }
    for (const text of ['$$\n\\frac{x}{2}\n\n\\alpha', '$$\n\\frac{x}{2}\n\n\\alpha\n$$',
      '```math\n\\frac{x}{2}\n\n## literal heading\n\\alpha']) {
      step = mode + '/' + theme.type + '/retained blank lines and literal fences';
      await prepare(mode, text, undefined, theme);
      await expectColor('frac', 'rgb(204, 85, 0)');
      await expectColor('alpha', 'rgb(0, 102, 204)');
    }
    for (const content of ['\\frac{x}{2}', '\\frac{x']) for (const [opening, prefix] of [['> $$', '> '], ['- $$', '  '], ['> - $$', '>   ']]) {
      step = mode + '/' + theme.type + '/closed container/' + opening;
      const text = opening + '\n' + prefix + content + '\n' + prefix + '$$\n' + prefix + 'ordinary 42 \\alpha';
      await prepare(mode, text.replaceAll('$$', 'formula'), 0, theme);
      await page.evaluate(async () => { await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      const expected = await color('alpha');
      await prepare(mode, text, undefined, theme);
      await expectColor('frac', 'rgb(204, 85, 0)');
      await expectColor('alpha', expected);
    }
    step = mode + '/' + theme.type + '/successive formulas and containers';
    const successive = '$$\n\\frac{x}{2}\n$$\nordinary 42 \\alpha\n\n> $$\n> \\sqrt{3} + \\omega\n> $$\n\n$$\n\\sum_{i=1}^{n} i + \\gamma\n$$';
    await prepare(mode, successive, undefined, theme);
    await expectColor('alpha', await page.$eval('.cm-content', node => getComputedStyle(node).color));
    for (const needle of ['omega', 'gamma']) {
      await page.evaluate(needle => {
        const editor = (window as any).editor;
        editor.view.dispatch({ selection: { anchor: editor.getText().indexOf(needle) + 2 }, scrollIntoView: true });
      }, needle);
      await expectColor(needle, 'rgb(0, 102, 204)');
    }
    step = mode + '/' + theme.type + '/literal boundaries';
    const literal = String.raw`价格 $5 and $10，转义 \$\alpha，代码 ` + '`$\\alpha$`';
    await prepare(mode, literal, literal.length, theme);
    assert.notEqual(await color('alpha'), 'rgb(0, 102, 204)', step + ': escaped dollars stay literal');
    assert.equal(await page.$$eval('.meo-math-token', nodes => nodes.length), 0, step + ': ordinary code/currency are not Live math');

    for (const text of ['价格 $5 和 $10；转义美元符号：\\$5。', '$10']) {
      step = mode + '/' + theme.type + '/currency/' + text;
      await prepare(mode, text, text.length, theme);
      const receipt = await page.evaluate(async () => {
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        const editor = (window as any).editor, view = editor.view;
        return { foreground: getComputedStyle(view.contentDOM).color,
          digits: [...editor.getText().matchAll(/\d+/g)].map((match: RegExpMatchArray) => {
            const dom = view.domAtPos(match.index! + 1);
            const element = dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node;
            return { text: match[0], color: getComputedStyle(element).color };
          }), mathTokens: view.dom.querySelectorAll('.meo-math-token').length };
      });
      assert.equal(receipt.mathTokens, 0, step + ': currency is not unfinished formula source');
      for (const digit of receipt.digits) assert.equal(digit.color, receipt.foreground, step + ': currency digits keep prose color');
    }
    await prepare(mode, '$10$', 2, theme);
    await expectColor('10', 'rgb(0, 136, 68)');
    if (mode === 'live') {
      for (const text of ['$2+3', '$2+\\fr']) {
        await prepare(mode, text, text.length, theme);
        await expectColor('2', 'rgb(0, 136, 68)');
      }
    }

    step = mode + '/' + theme.type + '/boundary edits and history';
    const bounded = '$$\n\\frac{x}{2}\n$$\n\n## Next\nordinary 42 \\alpha';
    await prepare(mode, bounded, undefined, theme);
    const proseColor = await page.$eval('.cm-content', node => getComputedStyle(node).color);
    await expectColor('alpha', proseColor);
    await page.evaluate(() => {
      const editor = (window as any).editor, from = editor.getText().indexOf('\n$$') + 1;
      editor.view.dispatch({ changes: { from, to: from + 2 } });
    });
    await expectColor('frac', 'rgb(204, 85, 0)');
    await expectColor('alpha', proseColor);
    await page.evaluate(() => (window as any).editor.undo());
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), bounded);
    await page.evaluate(() => (window as any).editor.redo());
    await expectColor('alpha', proseColor);
    const unclosed = bounded.replace('\n$$', '\n');
    await prepare(mode, unclosed, undefined, theme);
    await page.evaluate(() => {
      const editor = (window as any).editor, from = editor.getText().indexOf('## Next');
      editor.view.dispatch({ changes: { from, to: from + 3 } });
    });
    await expectColor('alpha', 'rgb(0, 102, 204)');
    await page.evaluate(() => (window as any).editor.undo());
    await expectColor('alpha', proseColor);
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), unclosed);

    step = mode + '/' + theme.type + '/typing and history';
    await prepare(mode, '$\\alph$', 6, theme);
    await expectColor('alph', 'rgb(0, 102, 204)');
    await page.keyboard.type('a');
    await expectColor('alpha', 'rgb(0, 102, 204)');
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as any).editor.undo());
    await expectColor('alph', 'rgb(0, 102, 204)');
    assert.equal(await page.evaluate(() => (window as any).editor.getText()), '$\\alph$');
    await page.evaluate(() => (window as any).editor.redo());
    await expectColor('alpha', 'rgb(0, 102, 204)');
  }

  for (const mode of ['source', 'live']) for (const closed of [false, true]) {
    step = mode + '/multiline token batches';
    const text = '$$\n\\begin{aligned}\n' + Array.from({ length: 140 }, () => formula + String.raw` \\`).join('\n') + '\n\n\\omega\n\\end{aligned}' + (closed ? '\n$$' : '');
    await prepare(mode, text);
    await expectColor('frac', 'rgb(204, 85, 0)');
    await page.evaluate(() => {
      const editor = (window as any).editor;
      editor.view.dispatch({ selection: { anchor: editor.getText().indexOf('omega') + 2 }, scrollIntoView: true });
    });
    await expectColor('omega', 'rgb(0, 102, 204)');
  }

  step = 'independent Source theme';
  await prepare('live', '$' + formula + '$');
  await expectColor('frac', 'rgb(204, 85, 0)');
  await page.evaluate(theme => {
    const h = (window as any).HighlightHarness;
    h.setShikiTheme({ ...theme, tokenColors: [...theme.tokenColors,
      { scope: 'entity.name.function.math.tex', settings: { foreground: '#9944cc' } }] }, 'source');
    (window as any).editor.setMode('source');
  }, darkPlus);
  await expectColor('frac', 'rgb(153, 68, 204)');
  await page.evaluate(() => (window as any).editor.setMode('live'));
  await expectColor('frac', 'rgb(204, 85, 0)');

  const artifacts = '.local/test-artifacts/math-syntax';
  await fs.mkdir(artifacts, { recursive: true });
  const sample = '# LaTeX 公式源码高亮\n\n行内公式：$\\frac{x_1}{2} + \\alpha = \\sqrt{y}$\n\n$$\n\\begin{aligned}\n  f(x) &= \\frac{a_1 + b^2}{\\sqrt{x}} \\\\\n  g(x) &= \\sum_{i=1}^{n} x_i % 求和\n\\end{aligned}\n$$\n\n公式后的普通正文。';
  for (const theme of [lightPlus, darkPlus]) for (const mode of ['source', 'live']) {
    step = 'screenshot/' + theme.type + '/' + mode;
    await prepare(mode, sample, sample.indexOf('g(x)'), theme, false);
    await page.waitForFunction(() => {
      const view = (window as any).editor.view;
      return view.dom.querySelector('.meo-source-token, .meo-math-token');
    });
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 200)); });
    await page.screenshot({ path: artifacts + '/' + theme.type + '-' + mode + '.png' });
  }
  const unfinishedSample = '# 未闭合公式的范围\n\n$$\n\\frac{x_1}{2} + \\alpha\n\n## 后续正文\n普通文字 123，不属于公式。\n\n```text\n\\beta = 456\n```\n\n正常行内公式：$\\sqrt{x} + \\gamma$';
  for (const mode of ['source', 'live']) {
    await prepare(mode, unfinishedSample, unfinishedSample.indexOf(' + '), darkPlus, false);
    await page.evaluate(async () => { await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 200)); });
    await page.screenshot({ path: artifacts + '/unfinished-dark-' + mode + '.png' });
  }
  const currencySample = '## 普通文字与代码对照\n\n价格 $5 和 $10；转义美元符号：\\$5。\n\n下面是行内代码，可以与真正的公式对照：`$\\frac{x_1}{2} + \\alpha$`。';
  await prepare('live', currencySample, currencySample.indexOf('\n\n下面'), darkPlus, false);
  await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  assert.equal(await page.$$eval('.meo-math-token', nodes => nodes.length), 0, 'Screenshot currency/code must remain literal');
  await page.screenshot({ path: artifacts + '/currency-dark-live.png', clip: { x: 0, y: 0, width: 980, height: 230 } });
  assert.deepEqual(errors, [], 'No tokenizer or editor errors');
  console.log('Math syntax: Source/Live, both themes, every math form, containers, unfinished input, literal boundaries, independent palettes and history passed');
} finally { await closeTestBrowser(browser); }
