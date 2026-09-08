import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
const build = await Bun.build({ entrypoints: ['scripts/test-highlight-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  for (const scenario of [
    { mode: 'live', delay: 0, composing: false },
    { mode: 'live', delay: 70, composing: false },
    { mode: 'live', delay: 250, composing: false },
    { mode: 'source', delay: 70, composing: false },
    { mode: 'source', delay: 250, composing: false },
    { mode: 'live', delay: 70, composing: true },
    { mode: 'standalone', delay: 70, composing: false },
    { mode: 'standalone', delay: 250, composing: false }
  ]) {
    await page.evaluate(({ mode }) => {
      const harness = (window as any).HighlightHarness;
      harness.setShikiTheme({ name: 'typing', type: 'dark', colors: { 'editor.foreground': '#eeeeee' },
        tokenColors: [
        { scope: ['keyword', 'storage'], settings: { foreground: '#ff0000' } },
        { scope: 'string', settings: { foreground: '#0000ff' } },
          { scope: 'comment', settings: { foreground: '#00ff00' } }
        ] });
      const code = ['const stable = "value";',
        ...Array.from({ length: 3000 }, (_, i) => `const value${i} = "payload";`)].join('\n');
      const text = mode === 'standalone' ? code : `\`\`\`typescript\n${code}\n\`\`\``;
      const parent = document.getElementById('app')!;
      parent.replaceChildren();
      const editor = mode === 'standalone' ? harness.createStandaloneHighlightEditor(parent, text)
        : harness.createEditor({ parent, text, initialMode: mode, onApplyChanges() {} });
      (window as any).typingEditor = editor;
      (window as any).keywordColor = () => {
        const walker = document.createTreeWalker(editor.view.dom, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node.textContent?.includes('const')) return getComputedStyle(node.parentElement!).color;
        }
        return 'missing';
      };
      (window as any).inputColor = () => {
        const { node } = editor.view.domAtPos(editor.view.state.selection.main.head - 1);
        return getComputedStyle(node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement!).color;
      };
      editor.view.dispatch({ selection: { anchor: text.indexOf('value') + 5 } });
      editor.focus();
    }, scenario);
    await page.waitForFunction(() => (window as any).keywordColor() === 'rgb(255, 0, 0)');
    await page.evaluate(() => {
      const state = (window as any).typingSamples = { colors: [], inputColors: [], done: false };
      const sample = () => {
        state.colors.push((window as any).keywordColor());
        state.inputColors.push((window as any).inputColor());
        if (!state.done) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    if (scenario.composing) await page.evaluate(() => {
      (window as any).typingEditor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    await page.keyboard.type('abcdef', { delay: scenario.delay });
    if (scenario.composing) await page.evaluate(() => {
      (window as any).typingEditor.view.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'abcdef' }));
    });
    assert.ok(await page.evaluate(() => (window as any).typingEditor.getText().includes('valueabcdef')),
      'Keyboard input must reach the code block');
    await new Promise(resolve => setTimeout(resolve, 250));
    const colors = await page.evaluate(() => { (window as any).typingSamples.done = true; return (window as any).typingSamples.colors as string[]; });
    assert.ok(colors.length >= 2, 'Capture more than a single painted frame');
    assert.deepEqual([...new Set(colors)], ['rgb(255, 0, 0)'], `Unchanged syntax must stay colored on every frame: ${JSON.stringify(scenario)}`);
    const inputColors = await page.evaluate(() => (window as any).typingSamples.inputColors as string[]);
    assert.deepEqual([...new Set(inputColors)], ['rgb(0, 0, 255)'], `Inserted string characters must retain their token color: ${JSON.stringify(scenario)}`);
    await page.evaluate(() => {
      const editor = (window as any).typingEditor;
      editor.view.dispatch({ changes: { from: editor.getText().indexOf('const stable'), insert: '// ' }, userEvent: 'input.type' });
    });
    await page.waitForFunction(() => (window as any).keywordColor() === 'rgb(0, 255, 0)', { timeout: 10000 });
    if (scenario.mode !== 'standalone') {
      await page.evaluate(() => {
        const editor = (window as any).typingEditor;
        editor.view.dispatch({ changes: { from: 3, to: 13, insert: 'plaintext' }, userEvent: 'input.type' });
      });
      await page.waitForFunction(() => (window as any).keywordColor() !== 'rgb(0, 255, 0)', { timeout: 10000 });
    }
    await page.evaluate(() => (window as any).typingEditor.destroy());
  }
  for (const scenario of [
    { language: 'mermaid', text: 'graph TD\nnodeAlpha --> nodeBeta', marker: 'nodeAlpha' },
    { language: 'latex', text: '\\frac{alpha}{beta}', marker: 'alpha' }
  ]) {
    await page.evaluate(({ language, text, marker }) => {
      const harness = (window as any).HighlightHarness;
      harness.setShikiTheme({
        name: 'nested-typing',
        type: 'dark',
        colors: { 'editor.foreground': '#eeeeee' },
        tokenColors: [
          { scope: ['keyword', 'storage'], settings: { foreground: '#ff0000' } },
          { scope: 'string', settings: { foreground: '#0000ff' } }
        ]
      });
      const parent = document.getElementById('app')!;
      parent.replaceChildren();
      const editor = harness.createStandaloneHighlightEditor(parent, text, language);
      const anchor = text.indexOf(marker) + marker.length;
      editor.view.dispatch({ selection: { anchor } });
      editor.focus();
      (window as any).typingEditor = editor;
      (window as any).inputColor = () => {
        const { node } = editor.view.domAtPos(editor.view.state.selection.main.head - 1);
        return getComputedStyle(node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement!).color;
      };
    }, scenario);
    await page.waitForFunction(() => Boolean((window as any).inputColor()));
    const baselineColor = await page.evaluate(() => (window as any).inputColor() as string);
    await page.evaluate(() => {
      const state = (window as any).typingSamples = { inputColors: [], done: false };
      const sample = () => {
        state.inputColors.push((window as any).inputColor());
        if (!state.done) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.type('abcdef', { delay: 70 });
    await new Promise(resolve => setTimeout(resolve, 250));
    const inputColors = await page.evaluate(() => {
      (window as any).typingSamples.done = true;
      return ((window as any).typingSamples.inputColors as string[]).filter(Boolean);
    });
    assert.ok(inputColors.length >= 2, 'Capture more than a single painted nested-editor frame');
    assert.deepEqual(
      [...new Set(inputColors)],
      [baselineColor],
      `Nested ${scenario.language} input must inherit the preceding character color on every frame`
    );
    await page.evaluate(() => (window as any).typingEditor.destroy());
  }
  for (const scenario of [
    { mode: 'live', fence: '' },
    { mode: 'source', fence: '' },
    { mode: 'live', fence: 'text' },
    { mode: 'source', fence: 'text' }
  ]) {
    await page.evaluate(({ mode, fence }) => {
      const harness = (window as any).HighlightHarness;
      harness.setShikiTheme({
        name: 'plain-typing',
        type: 'dark',
        colors: { 'editor.foreground': '#eeeeee' },
        tokenColors: [{ scope: 'string', settings: { foreground: '#0000ff' } }]
      });
      const code = ['plain value', ...Array.from({ length: 3000 }, (_, i) => `plain row ${i}`)].join('\n');
      const text = `\`\`\`${fence}\n${code}\n\`\`\``;
      const parent = document.getElementById('app')!;
      parent.replaceChildren();
      const editor = harness.createEditor({ parent, text, initialMode: mode, onApplyChanges() {} });
      editor.view.dispatch({ selection: { anchor: text.indexOf('plain value') + 'plain value'.length } });
      editor.focus();
      (window as any).typingEditor = editor;
      (window as any).inputColor = () => {
        const { node } = editor.view.domAtPos(editor.view.state.selection.main.head - 1);
        return getComputedStyle(node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement!).color;
      };
    }, scenario);
    await page.waitForFunction(() => Boolean((window as any).inputColor()));
    const baselineColor = await page.evaluate(() => (window as any).inputColor() as string);
    await page.evaluate(() => {
      const state = (window as any).typingSamples = { inputColors: [], done: false };
      const sample = () => {
        state.inputColors.push((window as any).inputColor());
        if (!state.done) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.keyboard.type('abcdef', { delay: 70 });
    await new Promise(resolve => setTimeout(resolve, 250));
    const result = await page.evaluate(() => {
      (window as any).typingSamples.done = true;
      return (window as any).typingSamples.inputColors as string[];
    });
    const inputColors = result.filter(Boolean);
    assert.ok(inputColors.length >= 2, 'Capture more than a single painted plain-code frame');
    assert.deepEqual(
      [...new Set(inputColors)],
      [baselineColor],
      `Plain code input must inherit the preceding character color on every frame: ${JSON.stringify(scenario)}`
    );
    await page.evaluate(() => (window as any).typingEditor.destroy());
  }
  console.log('Code highlighting remains painted during typing');
} finally { await browser.close(); }
