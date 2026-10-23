import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import { defaultInputAssistance } from '../src/foundation/editingPreferences';
import { mathCompletionSuggestions } from '../webview/src/editor/mathCompletion';

const build = await Bun.build({ entrypoints: ['scripts/test-editing-features-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser(), page = await browser.newPage();
const errors: string[] = [];
let step = 'initial';
page.on('pageerror', error => errors.push(String(error)));
page.on('console', message => { if (message.type() === 'error' && /plugin crashed/i.test(message.text())) errors.push(message.text()); });
try {
  await page.setViewport({ width: 1000, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  const katexDirectory = path.resolve('node_modules/katex/dist');
  const katexCss = readFileSync(path.join(katexDirectory, 'katex.min.css'), 'utf8')
    .replace(/url\(([^)]+)\)/g, (_match, fontPath) => `url(data:font/woff2;base64,${readFileSync(path.join(katexDirectory, fontPath)).toString('base64')})`);
  await page.addStyleTag({ content: katexCss });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const prepare = async (mode: string, marked = '$|$', input = {}) => {
    await page.evaluate(({ mode, marked, input }) => {
      const g = window as any, position = marked.indexOf('|');
      g.editor?.destroy();
      g.editor = g.EditingFeaturesHarness.createEditor({ parent: document.getElementById('app')!,
        text: marked.replace('|', ''), initialMode: mode, initialCursorPos: position,
        initialInputAssistance: input, onApplyChanges() {} });
      g.editor.view.dispatch({ selection: { anchor: position } }); g.editor.view.focus();
    }, { mode, marked, input: { ...defaultInputAssistance, ...input } });
  };
  const text = () => page.evaluate(() => (window as any).editor.getText());
  const caret = () => page.evaluate(() => (window as any).editor.view.state.selection.main.head);
  const open = () => page.waitForSelector('.meo-math-suggestions:not([hidden])', { timeout: 4000 });
  const closed = async () => {
    try { await page.waitForFunction(() => !document.querySelector('.meo-input-suggestions:not([hidden])'), { timeout: 2000 }); }
    catch (error) { throw new Error(step + ': menu remained open: ' + await text(), { cause: error }); }
  };
  const waitText = (expected: string) => page.waitForFunction(expected => (window as any).editor.getText() === expected, { timeout: 4000 }, expected);
  const choose = async (label: string) => {
    await open();
    await page.evaluate(label => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-math-command]')].find(row => row.dataset.mathCommand === label);
      if (!row) throw new Error('Missing math candidate: ' + label);
      row.click();
    }, label);
    await closed();
  };
  for (const mode of ['source', 'live']) {
    step = mode + ': templates';
    await prepare(mode); await page.keyboard.type('\\fr'); await choose('\\frac');
    await waitText('$\\frac{}{}$'); assert.equal(await caret(), 7);
    await page.keyboard.type('\\sq'); await choose('\\sqrt');
    await page.keyboard.type('x'); await page.keyboard.press('Tab');
    await page.keyboard.type('y'); await page.keyboard.press('Tab');
    await waitText('$\\frac{\\sqrt{x}}{y}$');
    assert.equal(await caret(), (await text()).length - 1, mode + ': nested template resumes the denominator and exits at the root end');
    await page.evaluate(() => (window as any).editor.undo());
    await page.evaluate(() => (window as any).editor.redo());
    await waitText('$\\frac{\\sqrt{x}}{y}$');

    await prepare(mode); await page.keyboard.type('\\fr'); await choose('\\frac');
    await page.keyboard.type('a'); await page.keyboard.press('Tab'); await page.keyboard.type('b');
    await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift'); await page.keyboard.type('c');
    await waitText('$\\frac{c}{b}$');
    await page.keyboard.press('Escape'); await closed();

    await prepare(mode); await page.keyboard.type('\\sq'); await choose('\\sqrt');
    await page.keyboard.type('x}'); await waitText('$\\sqrt{x}$');
    assert.equal(await caret(), 9, mode + ': typing a generated closer skips it');

    await prepare(mode, '$\\fr|ac{x}{y}$'); await open();
    assert.equal(await page.$eval('[data-math-command="\\\\frac"] .meo-suggestion-label', node => node.textContent), '\\frac{}{}', mode + ': fixed template remains visible with existing arguments');
    await page.keyboard.press('Enter');
    await waitText('$\\frac{x}{y}$');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('$\\frac{x}{y}$');

    for (const marked of ['$|', '$$\n|\n$$', '$$\n|', ...['math', 'latex', 'tex', 'katex'].map(language => '```' + language + '\n|\n```'), '```math\n|']) {
      await prepare(mode, marked); await page.keyboard.type('\\alp'); await open(); await page.keyboard.press('Tab');
      await waitText(marked.replace('|', '\\alpha'));
    }
    for (const marked of ['|', 'Price $20 and |', '`$|$`', '```js\n|\n```', '[link](|)', '<!-- $|$ -->', '$$\n% |\n$$']) {
      step = mode + ': excluded ' + marked;
      await prepare(mode, marked); await page.keyboard.type('\\alp'); await closed();
      assert.equal(await text(), marked.replace('|', '\\alp'), mode + ': excluded context retains literal input');
    }
    step = mode + ': disabled';
    await prepare(mode, '$|$', { math: false }); await page.keyboard.type('\\alp'); await closed();
    assert.equal(await text(), '$\\alp$');
    await prepare(mode); await page.keyboard.type('\\alp'); await open();
    await page.evaluate(input => (window as any).editor.setInputAssistance(input), { ...defaultInputAssistance, math: false });
    await closed(); assert.equal(await text(), '$\\alp$', mode + ': disabling an open menu leaves the source unchanged');

    step = mode + ': history and dismissal';
    await prepare(mode); await page.keyboard.type('\\sq'); await choose('\\sqrt');
    await page.evaluate(() => (window as any).editor.undo()); await waitText('$\\sq$');
    await page.evaluate(() => (window as any).editor.redo()); await waitText('$\\sqrt{}$');
    await prepare(mode); await page.keyboard.type('\\alp'); await open(); await page.keyboard.press('Escape'); await closed();
    await page.keyboard.press('Enter');
    assert.ok((await text()).includes('\\alp'), mode + ': dismissal does not commit a candidate');

    step = mode + ': environments';
    await prepare(mode, '> $$\n> |\n> $$'); await page.keyboard.type('\\begin{ali'); await choose('\\begin{aligned}');
    await page.keyboard.type('x &= y');
    await waitText('> $$\n> \\begin{aligned}\n>   x &= y\n> \\end{aligned}\n> $$');
    await prepare(mode, '$$\n\\begin{ali|}\nx &= y\n\\end{aligned}\n$$');
    await open();
    assert.equal(await page.$eval('[data-math-command] .meo-suggestion-label', node => node.textContent), '\\begin{aligned} \\end{aligned}', mode + ': matching closer does not change the menu template');
    await choose('\\begin{aligned}');
    await waitText('$$\n\\begin{aligned}\nx &= y\n\\end{aligned}\n$$');

    step = mode + ': composition';
    await prepare(mode); await page.keyboard.type('\\alp'); await open();
    const ime = await page.createCDPSession();
    await ime.send('Input.imeSetComposition', { text: 'zhong', selectionStart: 0, selectionEnd: 5 });
    const beforeImeEnter = await text();
    await page.evaluate(() => (window as any).editor.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true, cancelable: true })));
    assert.equal(await text(), beforeImeEnter, mode + ': IME Enter never commits a completion');
    await ime.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); await ime.detach();

    step = mode + ': modes';
    await prepare(mode); await page.keyboard.type('\\alp'); await open();
    await page.evaluate(mode => (window as any).editor.setMode(mode === 'source' ? 'live' : 'source'), mode); await closed();
    await page.evaluate(mode => (window as any).editor.setMode(mode), mode);
    assert.equal(await text(), '$\\alp$', mode + ': mode changes do not apply suggestions');
    await prepare(mode); await page.keyboard.type('\\alp'); await open();
    await page.evaluate(() => {
      const g = window as any;
      g.editor.view.dispatch({ effects: g.EditingFeaturesHarness.StateEffect.appendConfig.of(g.EditingFeaturesHarness.EditorState.readOnly.of(true)) });
    }); await closed();
    await page.keyboard.press('Enter'); assert.equal(await text(), '$\\alp$', mode + ': read-only state cannot accept a candidate');
  }

  const artifacts = '.local/test-artifacts/math-completion';
  await fs.mkdir(artifacts, { recursive: true });
  const catalog = mathCompletionSuggestions({ type: 'math', query: '', target: '', length: 0, wiki: false,
    from: 0, to: 0, bodyFrom: 0, bodyTo: 0, environment: false, display: true, prefix: '' });
  const queries = [...new Set(catalog.map(item => item.environment ? '\\begin{' : item.label.slice(0, 2).toLowerCase()))];
  const captureCatalog = process.argv.includes('--capture-catalog');
  for (const theme of ['light', 'dark']) for (const language of ['zh-CN', 'en']) {
    await prepare('source', '$|$', { slashPreferAbove: theme === 'dark' });
    await page.evaluate(({ theme, language }) => {
      const g = window as any;
      document.body.classList.toggle('vscode-dark', theme === 'dark');
      document.body.classList.toggle('vscode-light', theme === 'light');
      document.documentElement.style.background = theme === 'dark' ? '#181818' : '#ffffff';
      g.EditingFeaturesHarness.applyUiTheme(theme, false);
      g.editor.setUiLanguage(language);
    }, { theme, language });
    await page.keyboard.type('\\s'); await open();
    assert.equal(await page.$eval('[data-math-command="\\\\sqrt"] .meo-suggestion-label', node => node.textContent), '\\sqrt{}');
    assert.ok(await page.$('[data-math-command="\\\\sqrt"] .meo-math-completion-preview .katex'));
    await page.screenshot({ path: '.local/test-artifacts/math-completion/' + theme + '-' + language + '.png' });
    const seen = new Set<string>();
    const capture = captureCatalog && language === 'zh-CN';
    if (capture) await fs.mkdir(`${artifacts}/catalog/${theme}`, { recursive: true });
    for (const query of queries) {
      await prepare('source', '$$\n' + query + '|\n$$');
      await page.evaluate(language => (window as any).editor.setUiLanguage(language), language);
      await open();
      await page.evaluate(async () => { await document.fonts.ready; await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
      const rows = await page.$$eval('[data-math-command]', nodes => nodes.map(node => {
        const row = node as HTMLElement, preview = row.querySelector<HTMLElement>('.meo-math-completion-preview')!;
        const formula = preview.querySelector<HTMLElement>('.katex')!, bounds = preview.getBoundingClientRect(), math = formula.getBoundingClientRect();
        const fontSize = parseFloat(getComputedStyle(row).fontSize);
        const bordersFit = [...formula.querySelectorAll<HTMLElement>('.katex-html span')].every(element => {
          const style = getComputedStyle(element), border = element.getBoundingClientRect();
          if (![style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(width => parseFloat(width) > 0)
            || border.width === 0 || border.height === 0) return true;
          // Thin rules need space inside the clipping edge, including at fractional zoom.
          return border.left >= bounds.left + 0.5 && border.right <= bounds.right - 0.5
            && border.top >= bounds.top + 0.5 && border.bottom <= bounds.bottom - 0.5;
        });
        return { command: row.dataset.mathCommand!, label: row.querySelector('.meo-suggestion-label')!.textContent,
          labelFits: (row.querySelector('.meo-suggestion-label') as HTMLElement).scrollWidth <= (row.querySelector('.meo-suggestion-label') as HTMLElement).clientWidth + 1,
          height: row.getBoundingClientRect().height, expectedHeight: Math.max(28, 1.45 * fontSize + 6),
          valid: !preview.querySelector('.katex-error'), bordersFit,
          fits: math.left >= bounds.left - 1 && math.right <= bounds.right + 1 && math.top >= bounds.top - 1 && math.bottom <= bounds.bottom + 1 };
      }));
      for (const row of rows) {
        const index = catalog.findIndex(item => item.label === row.command), item = catalog[index]!;
        assert.ok(item, row.command + ': belongs to the catalog');
        assert.equal(row.label, item.insert.replace(/\s*\n\s*/g, ' '), row.command + ': fixed insertion template');
        assert.ok(row.labelFits, row.command + ': the complete insertion template remains visible');
        assert.ok(row.valid && row.fits, row.command + ': complete, valid preview within the row');
        assert.ok(row.bordersFit, row.command + ': visible rules stay clear of clipping edges');
        assert.ok(Math.abs(row.height - row.expectedHeight) < 0.1, row.command + ': equal row height');
        if (capture && !seen.has(row.command)) {
          const selector = '[data-math-command=' + JSON.stringify(row.command) + ']';
          await (await page.$(selector))!.screenshot({ path: `${artifacts}/catalog/${theme}/${String(index + 1).padStart(3, '0')}.png` });
        }
        seen.add(row.command);
      }
    }
    assert.equal(seen.size, catalog.length, theme + '/' + language + ': every catalog entry has a preview');
  }
  if (captureCatalog) await fs.writeFile(`${artifacts}/catalog/catalog.json`, JSON.stringify(catalog.map((item, index) => ({ index: index + 1, label: item.label, insert: item.insert, preview: item.preview })), null, 2));
  await page.setViewport({ width: 360, height: 420 });
  await prepare('source', '$|$'); await page.keyboard.type('\\alp'); await open();
  const bounds = await page.$eval('.meo-math-suggestions', node => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
  assert.ok(bounds.left >= 0 && bounds.right <= 360 && bounds.top >= 0 && bounds.bottom <= 420, 'narrow viewport contains the entire menu');
  assert.deepEqual(errors, []);
  console.log('Math completion production input, nested fields, history, modes, IME and bilingual themes passed');
} finally { await closeTestBrowser(browser); }
