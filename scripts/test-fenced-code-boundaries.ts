import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import darkPlus from '@shikijs/themes/dark-plus';
import lightPlus from '@shikijs/themes/light-plus';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-highlight-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let step = 'initial';
let page:import('puppeteer-core').Page;
try {
  page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1020, height: 720 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ path: 'webview/dist/mermaid.min.js' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const prepare = async (text: string, theme: typeof darkPlus, mode = 'live') => {
    await page.evaluate(({ text, theme, mode }) => {
      const g = window as any, h = g.HighlightHarness;
      g.editor?.destroy();
      document.body.className = 'vscode-' + theme.type;
      h.applyBuiltInVisualBaseline(theme.type);
      const style = document.documentElement.style;
      for (const [key, value] of Object.entries({
        '--vscode-editor-font-family': 'Consolas,monospace', '--vscode-editor-font-size': '16px',
        '--meo-user-editor-font-size': '16px', '--vscode-editor-foreground': theme.colors['editor.foreground'],
        '--vscode-editor-background': theme.colors['editor.background'], '--meo-source-foreground': theme.colors['editor.foreground'],
        '--meo-background': theme.colors['editor.background'], '--meo-foreground': theme.colors['editor.foreground']
      })) style.setProperty(key, value as string);
      h.setShikiTheme(theme); h.setShikiTheme(theme, 'source');
      g.editor = h.createEditor({ parent: document.getElementById('app'), text, initialMode: mode, initialCursorPos: 0, onApplyChanges() {} });
    }, { text, theme, mode });
  };
  const text = () => page.evaluate(() => (window as any).editor.getText() as string);
  const control = async (key: 'End' | 'z' | 'y') => {
    await page.keyboard.down('Control');
    await page.keyboard.press(key);
    await page.keyboard.up('Control');
  };
  const color = (needle: string) => page.evaluate(needle => {
    const g = window as any, view = g.editor.view;
    const dom = view.domAtPos(g.editor.getText().indexOf(needle) + 2);
    return getComputedStyle(dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node).color;
  }, needle);
  const expectColor = async (needle: string, expected: string) => {
    await page.waitForFunction(({ needle, expected }) => {
      const g = window as any, view = g.editor.view;
      const dom = view.domAtPos(g.editor.getText().indexOf(needle) + 2);
      return getComputedStyle(dom.node.nodeType === Node.TEXT_NODE ? dom.node.parentElement : dom.node).color === expected;
    }, { timeout: 4000 }, { needle, expected }).catch(async () => {
      throw new Error(`${step}: ${needle} expected ${expected}, got ${await color(needle)}`);
    });
  };
  const artifacts = '.local/test-artifacts/fenced-code-boundaries';
  await fs.mkdir(artifacts, { recursive: true });
  const contexts = [
    { name: 'root', opening: '', prefix: '', after: '' },
    { name: 'quote', opening: '> ', prefix: '> ', after: '\noutside 777' },
    { name: 'list', opening: '- ', prefix: '  ', after: '\noutside 777' },
    { name: 'quote-list', opening: '> - ', prefix: '>   ', after: '\n> outside 777' },
    { name: 'ordered-list', opening: '12. ', prefix: '    ', after: '\noutside 777' },
    { name: 'nested-quote', opening: '> > ', prefix: '> > ', after: '\n> outside 777' }
  ];
  let checked = 0;
  if (!process.argv.includes('--mermaid-only')) for (const theme of [darkPlus, lightPlus]) for (const mode of ['source', 'live']) {
    const expected = theme.type === 'light' ? 'rgb(0, 112, 193)' : 'rgb(79, 193, 255)';
    for (const context of contexts) for (const marker of ['```', '~~~']) {
      const code = context.opening + marker + 'javascript\n' + context.prefix + 'const firstValue = 111;\n'
        + context.prefix + 'const finalValue = 222;';
      step = `${theme.type}/${mode}/${context.name}/${marker}/unfinished`;
      await prepare(code + context.after, theme, mode);
      await expectColor('finalValue', expected);
      assert.equal(await text(), code + context.after, step + ': coloring preserves source');
      // Inserting/removing a closer must include the final payload line both ways.
      await page.evaluate(({ from, insert }) => (window as any).editor.view.dispatch({ changes: { from, insert } }),
        { from: code.length, insert: '\n' + context.prefix + marker });
      await expectColor('finalValue', expected);
      await page.evaluate(({ from, to }) => (window as any).editor.view.dispatch({ changes: { from, to } }),
        { from: code.length, to: code.length + context.prefix.length + marker.length + 1 });
      await expectColor('finalValue', expected);
      assert.equal(await text(), code + context.after, step + ': deleting the closer preserves payload');
      checked++;
    }
    step = `${theme.type}/${mode}/single payload line`;
    await prepare('```javascript\nconst finalValue = 222;', theme, mode);
    await expectColor('finalValue', expected);
    if (mode === 'live') await page.screenshot({ path: `${artifacts}/${theme.type}-code-unfinished.png`, clip: { x: 0, y: 0, width: 1020, height: 130 } });
    checked++;
  }
  if (!process.argv.includes('--code-only')) for (const theme of [darkPlus, lightPlus]) for (const context of contexts) {
    for (const marker of ['```', '~~~']) for (const closed of [false, true]) {
      step = `${theme.type}/Mermaid/${context.name}/${marker}/${closed ? 'closed' : 'unfinished'}`;
      const original = context.opening + marker + 'mermaid\n' + context.prefix + 'flowchart LR\n'
        + context.prefix + 'A --> B' + (closed ? '\n' + context.prefix + marker : '') + context.after;
      await prepare(original, theme);
      await page.waitForSelector('.meo-mermaid-mode-btn', { timeout: 4000 });
      // Preview -> Split, through the same control used by a reader.
      await page.$eval('.meo-mermaid-mode-btn', (button: HTMLButtonElement) => button.click());
      await page.waitForSelector('#app > .cm-editor > .cm-scroller > .cm-content', { timeout: 4000 });
      const source = '#app > .cm-editor > .cm-scroller > .cm-content';
      assert.equal(await page.$$eval(source, nodes=>nodes.length),1,step+': one native document input');
      await page.evaluate(()=>{const e=(window as any).editor;const pos=e.getText().indexOf('A --> B')+7;e.view.dispatch({selection:{anchor:pos}});e.view.focus();});
      await page.keyboard.press('Enter');
      await page.keyboard.type('C --> D');
      const expected = original.replace('A --> B', 'A --> B\n' + context.prefix + 'C --> D');
      assert.equal(await text(), expected, step + ': source edits write exactly once and preserve the surrounding container');
      await control('z');
      await control('z');
      assert.equal(await text(), original, step + ': undo restores the original document');
      await control('y');
      await control('y');
      assert.equal(await text(), expected, step + ': undo/redo preserves the complete payload');
      if (context.name === 'root' && !closed && marker === '```') {
        await page.waitForFunction(() => {
          const labels = [...document.querySelectorAll('.meo-mermaid-block svg .nodeLabel')].map(node => node.textContent);
          return labels.includes('C') && labels.includes('D');
        }, { timeout: 4000 });
        await page.screenshot({ path: `${artifacts}/${theme.type}-mermaid-unfinished.png`, clip: { x: 0, y: 0, width: 1020, height: 270 } });
        await page.$eval('.meo-mermaid-mode-btn', (button: HTMLElement) => button.click());
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.meo-mermaid-toolbar')?.dataset.meoMermaidMode === 'preview');
        assert.equal(await text(), expected, 'Hiding unfinished source preserves the entire payload');
        await page.$eval('.meo-mermaid-mode-btn', (button: HTMLElement) => button.click());
        await page.waitForFunction(() => document.querySelector<HTMLElement>('.meo-mermaid-toolbar')?.dataset.meoMermaidMode === 'edit');
      }
      checked++;
    }
  }
  if (!process.argv.includes('--code-only')) for (const theme of [darkPlus, lightPlus]) {
    for (const initial of ['```mermaid\nflowchart LR\nA --> B\n```']) {
      step = `${theme.type}/Mermaid/remove closer while split`;
      await prepare(initial, theme);
      await page.waitForSelector('.meo-mermaid-mode-btn');
      await page.$eval('.meo-mermaid-mode-btn', (button: HTMLButtonElement) => button.click());
      const source = '#app > .cm-editor > .cm-scroller > .cm-content';
      await page.waitForSelector(source);
      let original = initial;
      if (initial.endsWith('```')) {
        original = initial.slice(0, -4);
        await page.evaluate(from => (window as any).editor.view.dispatch({ changes: { from, to: (window as any).editor.getText().length } }), original.length);
      }
      await page.evaluate(()=>{const e=(window as any).editor;e.view.dispatch({selection:{anchor:e.getText().length}});e.view.focus();});
      await page.keyboard.press('Enter');
      await page.keyboard.type('C --> D');
      assert.equal(await text(), original + '\nC --> D', step + ': final payload stays inside the editing range');
      checked++;
    }
    step = `${theme.type}/Mermaid/author an unfinished fence`;
    await prepare('```mermaid\n', theme);
    await page.evaluate(() => {
      const editor = (window as any).editor;
      editor.view.dispatch({ selection: { anchor: editor.getText().length } });
      editor.focus();
    });
    let authored = '```mermaid\n';
    for (const row of ['flowchart LR', 'A --> B', 'C --> D']) {
      await page.keyboard.type(row, { delay: 10 });
      authored += row;
      assert.equal(await text(), authored, step + ': typing never loses its native source target');
      await page.keyboard.press('Enter');
      authored += '\n';
      assert.equal(await text(), authored, step + ': trailing blank lines stay editable');
    }
    checked++;
  }
  assert.deepEqual(errors, [], 'No browser exceptions');
  console.log(`Fenced-code boundaries passed (${checked} Source/Live and Mermaid editing cases)`);
} catch (error) {
  throw new Error(`${step}: ${String(error)}`, { cause: error });
} finally { await closeTestBrowser(browser); }
