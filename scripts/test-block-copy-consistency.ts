import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({ width: 1100, height: 850 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: ':root{--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-size:14px;--meo-background:#24292e;--meo-foreground:#e6edf3;--meo-code-background:#1b2024}' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(() => {
    // Copy behavior belongs to the production editor/toolbars, independent of diagram layout.
    (window as any).mermaid = { initialize() {}, async render() {
      return { svg: '<svg width="400" height="100" viewBox="0 0 400 100"><text x="20" y="50">Diagram</text></svg>' };
    } };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      async writeText(text: string) { (window as any).copiedBlock = text; }
    } });
  });
  const settle = () => page.evaluate(async () => {
    for (let i = 0; i < 8; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  const mount = async (text: string) => {
    await page.evaluate(text => {
      const host = window as any;
      host.copyEditor?.destroy(); document.querySelector('#app')!.replaceChildren();
      host.copyEditor = host.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'),
        text, initialMode: 'live', uiLanguage: 'zh-CN', sourceLineNumbers: 'on', onApplyChanges() {} });
    }, text);
    await settle();
  };
  const copy = async (selector: string, expected: string) => {
    const before = await page.evaluate(() => { const editor = (window as any).copyEditor; return {
      text: editor.getText(), selection: editor.view.state.selection.toJSON(), history: editor.getHistoryDepth()
    }; });
    await page.$eval(selector, node => {
      if (node.getAttribute('aria-label') !== '复制源码' || (node as HTMLElement).dataset.tooltip !== '复制源码') {
        throw new Error('All block copy controls must use the same concise label');
      }
      (node as HTMLElement).click();
    });
    await settle();
    assert.equal(await page.evaluate(() => (window as any).copiedBlock), expected);
    assert.deepEqual(await page.evaluate(() => { const editor = (window as any).copyEditor; return {
      text: editor.getText(), selection: editor.view.state.selection.toJSON(), history: editor.getHistoryDepth()
    }; }), before, 'Copy does not modify source, outer selection or history');
  };
  let checked = 0;
  for (const prefix of ['', '> ', '  ', '>   ']) {
    const before = prefix === '  ' ? '- Item' : prefix === '>   ' ? '> - Item' : 'Before';
    for (const body of ['flowchart LR\n  A[中文] --> B', '\nflowchart LR\n  A --> B\n\n']) {
      const text = before + '\n\n' + prefix + '~~~~mermaid\n'
        + body.split('\n').map(line => prefix + line).join('\n') + '\n' + prefix + '~~~~\n\nAfter';
      await mount(text);
      for (const mode of ['preview', 'edit']) {
        if (mode !== 'preview') {
          await page.$eval('.meo-mermaid-mode-btn', node => (node as HTMLElement).click()); await settle();
        }
        assert.equal(await page.$eval('.meo-mermaid-toolbar', node => (node as HTMLElement).dataset.meoMermaidMode), mode);
        await copy('.meo-mermaid-toolbar .meo-copy-code-btn', body);
        checked++;
      }
      await page.$eval('.meo-mermaid-toolbar .meo-select-all-code-btn', node => (node as HTMLElement).click()); await settle();
      assert.equal(await page.evaluate(() => {
        const inner = (window as any).copyEditor.view;
        return inner.state.sliceDoc(inner.state.selection.main.from, inner.state.selection.main.to);
      }), body.replaceAll('\n','\n'+prefix), 'Native select-all retains Markdown container prefixes');
      await page.keyboard.type('flowchart TD\n  X --> Y'); await settle();
      await copy('.meo-mermaid-toolbar .meo-copy-code-btn', 'flowchart TD\n  X --> Y');
      await page.evaluate(() => (window as any).copyEditor.setMode('source')); await settle();
      assert.equal(await page.evaluate(() => (window as any).copyEditor.getText()),
        before + '\n\n' + prefix + '~~~~mermaid\n' + prefix + 'flowchart TD\n' + prefix + '  X --> Y\n' + prefix + '~~~~\n\nAfter',
        'Source mode retains the original fence and container');
    }
    const body = '\n  const text = "中文 <&> $$";\n\n\treturn text;  \n';
    await mount(before + '\n\n' + prefix + '~~~~typescript\n'
      + body.split('\n').map(line => prefix + line).join('\n') + '\n' + prefix + '~~~~\n\nAfter');
    await copy('.meo-code-block-actions .meo-copy-code-btn', body);
    checked++;
  }
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).copyEditor.destroy());
  console.log(`Block copy consistency passed: ${checked} Mermaid modes/code containers, exact whitespace, selection and current edits`);
} catch (error) {
  primary = error;
} finally {
  if (primary === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primary);
}
