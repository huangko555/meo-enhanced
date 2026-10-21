import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import { formatLatexSource } from '../webview/src/editor/latexFormatting';
import { renderMathToHtml } from '../src/shared/mathRenderer';

const expression = String.raw`\begin{aligned}a&=b+c\\d&=\frac{1}{2}\end{aligned}`;
for (const source of [expression, String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`]) {
  const offset = source.indexOf('b');
  const result = await formatLatexSource(source, [0, offset, source.length]);
  assert.equal(result.kind, 'formatted');
  assert.equal(result.source[result.offsets[1]], 'b');
  assert.equal(renderMathToHtml(result.source, 'display'), renderMathToHtml(source, 'display'));
  assert.equal((await formatLatexSource(result.source, result.offsets)).kind, 'unchanged');
}
for (const source of [String.raw`\text{a   b} +  x`, String.raw`\def\foo{ x  y }\foo`, String.raw`\text{line
  break} + x`]) {
  assert.equal((await formatLatexSource(source, [0])).source, source, 'Protected text/macros retain authored source');
}

const build = await Bun.build({ entrypoints: ['scripts/test-html-content-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage(), errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ path: 'node_modules/katex/dist/katex.min.css' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(() => {
    const g = window as any;
    g.shortcuts = {};
    g.tooltips = g.HtmlContentHarness.bindTooltips(document.body, {
      shortcutForCommand: (command: string) => g.HtmlContentHarness.effectiveShortcuts(g.shortcuts, 'other')[command]?.[0]
    });
    document.addEventListener('keydown', event => g.HtmlContentHarness.handleEditorShortcut(event, {
      editor: g.blockEditor, editableMode: 'live', editorSurfaceActive: true, shortcuts: g.shortcuts,
      platform: 'other', requestSave() {}, openFindPanel() {}, requestMode() {}
    }), true);
  });
  const settle = () => page.evaluate(async () => { for (let i = 0; i < 8; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); });
  const mount = async (text: string, language = 'en', appearance = 'light') => {
    await page.evaluate(({ text, language, appearance }) => {
      const g = window as any;
      g.blockEditor?.destroy(); document.querySelector('#app')!.replaceChildren();
      const foreground = appearance === 'dark' ? '#d4d4d4' : '#1f2328';
      for (const [name, value] of Object.entries({ '--meo-foreground': foreground,
        '--vscode-editor-foreground': foreground, '--meo-token-foreground-color': foreground,
        '--vscode-editor-background': appearance === 'dark' ? '#121314' : '#ffffff',
        '--meo-font-live': 'Arial', '--meo-font-live-size': '16px',
        '--meo-font-source': 'monospace', '--meo-font-source-size': '16px' })) document.documentElement.style.setProperty(name, value);
      g.HtmlContentHarness.applyUiTheme(appearance, true);
      g.blockEditor = g.HtmlContentHarness.createEditor({ parent: document.querySelector('#app'), text,
        initialMode: 'live', uiLanguage: language, onApplyChanges() {} });
    }, { text, language, appearance });
    await settle();
  };
  const read = () => page.evaluate(() => (window as any).blockEditor.getText());
  const select = async (needle: string, length = 0) => {
    await page.evaluate(({ needle, length }) => {
      const view = (window as any).blockEditor.view, from = view.state.doc.toString().indexOf(needle);
      if (from < 0) throw new Error('Missing source marker: ' + needle);
      view.dispatch({ selection: { anchor: from, head: from + length }, scrollIntoView: true }); view.focus();
    }, { needle, length });
    await settle();
  };
  const clickFormat = async () => {
    await page.click('.meo-format-math-btn');
    await page.waitForFunction(() => !(document.querySelector('.meo-format-math-btn') as HTMLButtonElement)?.disabled);
    await settle();
  };
  fs.mkdirSync('.local/probes/block-source-formatting', { recursive: true });
  let combinations = 0;
  for (const width of [480, 1050]) for (const appearance of ['light', 'dark']) for (const language of ['en', 'zh-CN']) {
    await page.setViewport({ width, height: 820 });
    const text = `Before\n\n$$\n${expression}\n$$\n\nAfter`;
    await mount(text, language, appearance);
    assert.equal(await page.$('.meo-md-math-fenced-display .meo-select-all-code-btn'), null);
    assert.equal(await page.$('.meo-format-math-btn'), null);
    await select('frac', 4);
    const actions = await page.$eval('.meo-math-source-actions', root => Array.from(root.children).map(node => ({
      name: node.className, text: node.textContent, width: node.getBoundingClientRect().width
    })));
    assert.match(actions[0].name, /select-all/); assert.match(actions[1].name, /format-math/);
    assert.equal(actions[1].text, ''); assert.ok(actions[1].width <= 24);
    await page.hover('.meo-format-math-btn');
    await page.waitForSelector('.meo-tooltip:not([hidden])');
    assert.equal(await page.$eval('.meo-format-math-btn', node => (node as HTMLElement).dataset.tooltipShortcut), 'Alt + Shift + F');
    const preview = await page.$eval('.meo-math-live-result .katex', node => node.innerHTML);
    await clickFormat();
    const formatted = await read();
    assert.notEqual(formatted, text);
    assert.ok(formatted.startsWith('Before\n\n$$\n') && formatted.endsWith('\n$$\n\nAfter'));
    assert.equal(await page.evaluate(() => { const view = (window as any).blockEditor.view;
      return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to); }), 'frac');
    assert.equal(await page.$eval('.meo-math-live-result .katex', node => node.innerHTML), preview);
    await page.screenshot({ path: `.local/probes/block-source-formatting/math-${width}-${appearance}-${language}.png` });
    assert.equal(await page.evaluate(() => (window as any).blockEditor.undo()), true); await settle();
    assert.equal(await read(), text);
    assert.equal(await page.evaluate(() => (window as any).blockEditor.redo()), true); await settle();
    assert.equal(await read(), formatted);
    combinations++;
  }
  // The formatter edits only the expression, retaining Markdown containers and optional math wrappers.
  for (const fixture of [
    { open: '> $$', prefix: '> ', close: '$$', before: 'Before' },
    { open: '- $$', prefix: '  ', close: '$$', before: 'Before' },
    { open: '> - ~~~~latex label', prefix: '>   ', close: '~~~~', before: 'Before', wrapper: true },
    { open: '```math', prefix: '', close: '```', before: 'Before' }
  ]) {
    const body = fixture.wrapper ? '$$\n' + expression + '\n$$' : expression;
    const text = `${fixture.before}\n\n${fixture.open}\n${body.split('\n').map(line => fixture.prefix + line).join('\n')}\n${fixture.prefix}${fixture.close}\n\nAfter`;
    await mount(text); await select('frac', 4); await clickFormat();
    const formatted = await read(); assert.notEqual(formatted, text);
    assert.ok(formatted.startsWith(`${fixture.before}\n\n${fixture.open}\n`));
    assert.ok(formatted.endsWith(`\n${fixture.prefix}${fixture.close}\n\nAfter`));
    assert.ok(formatted.split('\n').slice(3, -3).every(line => line.startsWith(fixture.prefix)));
    await page.evaluate(() => (window as any).blockEditor.undo()); await settle(); assert.equal(await read(), text);
  }
  for (const source of [String.raw`\frac{`, String.raw`\text{a   b} +  x`, String.raw`\def\foo{ x  y }\foo`]) {
    const text = `Before\n\n$$\n${source}\n$$\n\nAfter`;
    await mount(text); await select(source, 1); await clickFormat(); assert.equal(await read(), text);
    assert.match(await page.$eval('.meo-format-math-btn', node => node.getAttribute('aria-label')!), source === '\\frac{' ? /incomplete|invalid/ : /No layout changes/);
  }
  const protectedFormula = String.raw`\def\foo{ x  y }\begin{aligned}a&=\text{hello   world}\\bbb&=\frac12 + \sqrt x\end{aligned}`;
  await mount(`Before\n\n$$\n${protectedFormula}\n$$\n\nAfter`); await select('frac12', 6); await clickFormat();
  const protectedResult = await read();
  assert.ok(protectedResult.includes('\\text{hello   world}') && protectedResult.includes('\\def\\foo{ x  y }'));
  assert.ok(protectedResult.includes('\\frac12 + \\sqrt x') && protectedResult.includes('\\begin{aligned}\n'));
  assert.match(await page.$eval('.meo-format-math-btn', node => node.getAttribute('aria-label')!), /formatted.*retained/);
  assert.equal(await page.$eval('.meo-format-math-btn svg path', node => node.getAttribute('d')), 'M20 6 9 17l-5-5', 'Local protection uses the success check');
  await page.screenshot({ path: '.local/probes/block-source-formatting/math-protected.png' });
  await page.evaluate(() => (window as any).blockEditor.undo()); await settle();
  assert.equal(await read(), `Before\n\n$$\n${protectedFormula}\n$$\n\nAfter`);
  const text = `Before\n\n$$\n${expression}\n$$\n\nAfter`;
  for (const mode of ['live', 'source']) {
    await mount(text); await page.evaluate(mode => (window as any).blockEditor.setMode(mode), mode); await select('frac', 4);
    await page.evaluate(() => { (window as any).shortcuts = { formatHtml: ['Ctrl + Alt + L'] }; (window as any).tooltips.refreshShortcuts(); });
    await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('f');
    await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); await settle(); assert.equal(await read(), text);
    await page.keyboard.down('Control'); await page.keyboard.down('Alt'); await page.keyboard.press('l');
    await page.keyboard.up('Alt'); await page.keyboard.up('Control');
    await page.waitForFunction(text => (window as any).blockEditor.getText() !== text, {}, text);
    await page.evaluate(() => { (window as any).blockEditor.undo(); (window as any).shortcuts = { formatHtml: [] }; }); await settle();
    await page.keyboard.down('Alt'); await page.keyboard.down('Shift'); await page.keyboard.press('f');
    await page.keyboard.up('Shift'); await page.keyboard.up('Alt'); await settle(); assert.equal(await read(), text);
  }
  await mount(text); await select('frac', 4);
  const raced = await page.evaluate(() => {
    const view = (window as any).blockEditor.view;
    (document.querySelector('.meo-format-math-btn') as HTMLButtonElement).click();
    view.dispatch({ changes: { from: view.state.doc.toString().indexOf('b+c'), insert: 'x+' } });
    return view.state.doc.toString();
  });
  await page.waitForFunction(() => !(document.querySelector('.meo-format-math-btn') as HTMLButtonElement)?.disabled);
  assert.equal(await read(), raced, 'Pending format cannot overwrite new input');
  assert.match(await page.$eval('.meo-format-math-btn', node => node.getAttribute('aria-label')!), /changed/);
  // Real Mermaid toolbar updates retain source-only visibility and keyboard order across cached DOM reuse.
  await mount('Before\n\n```mermaid\nflowchart LR\nA --> B\n```\n\nAfter');
  for (const mode of ['preview', 'edit', 'preview', 'edit']) {
    await page.waitForFunction(mode => document.querySelector<HTMLElement>('.meo-mermaid-toolbar')?.dataset.meoMermaidMode === mode, {}, mode);
    const info = await page.$eval('.meo-mermaid-toolbar', node => {
      const select = node.querySelector<HTMLElement>('.meo-select-all-code-btn')!;
      return { hidden: select.hidden, display: getComputedStyle(select).display,
        first: node.firstElementChild === select, second: select.nextElementSibling?.classList.contains('meo-mermaid-mode-btn') };
    });
    assert.equal(info.hidden, mode === 'preview'); assert.equal(info.display === 'none', mode === 'preview');
    assert.ok(info.first && info.second); assert.equal(await page.$('.meo-mermaid-toolbar .meo-source-format-btn'), null);
    await page.click('.meo-mermaid-mode-btn'); await settle();
  }
  assert.deepEqual(errors, []);
  console.log(`Block formatting passed: ${combinations} visual combinations, containers/fences, protected content, history, source/live shortcuts, stale results and Mermaid controls.`);
} catch (error) { primary = error; }
finally { if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
