import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-block-sticky-header-production-entry.ts'], target: 'browser', format: 'iife' });
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const browser = await launchTestBrowser();
const header = '.meo-block-sticky-header:not([hidden])';
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1050, height: 640 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ path: 'node_modules/katex/dist/katex.min.css' });
  await page.addStyleTag({ content: ':root{--meo-background:#fff;--meo-foreground:#24292f;--meo-code-background:#f6f8fa;--meo-surface-background:#fff;--meo-color-base05:#0969da;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:500;--meo-font-source-size:14px;--meo-semantic-mutedForeground:#57606a;--meo-semantic-codeCopyHoverBackground:#eaeef2;--vscode-editor-font-family:monospace;--vscode-editor-font-size:14px;--vscode-editor-line-height:20px}' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  await page.evaluate(() => {
    (window as any).mermaid = { initialize() {}, async render() {
      return { svg: '<svg width="320" height="1000" viewBox="0 0 320 1000"><rect x="50" y="20" width="220" height="100" fill="none" stroke="currentColor"/><text x="140" y="70">Start</text><path d="M160 120v800" stroke="currentColor"/></svg>' };
    } };
    (window as any).__clipboard = '';
    Object.defineProperty(navigator, 'clipboard', { value: { async writeText(text: string) { (window as any).__clipboard = text; } }, configurable: true });
    (window as any).__disposeTooltips = (window as any).BlockStickyHeaderHarness.bindTooltips(document.body);
  });
  const frames = async (count = 8) => page.evaluate(async count => {
    for (let i = 0; i < count; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  }, count);
  const mount = async (text: string) => {
    await page.evaluate(text => {
      (window as any).__editor?.destroy();
      (window as any).__editor = (window as any).BlockStickyHeaderHarness.createEditor({ parent: document.getElementById('app'), text,
        initialMode: 'live', initialLongCodeBlockFolding: false, uiLanguage: 'zh-CN', onApplyChanges() {} });
    }, text);
    await frames(12);
  };
  const pin = async (line = 1, offset = 180) => {
    if (line > 1) {
      await page.evaluate(line => (window as any).__editor.scrollToLine(line, 'top'), line);
      await frames(15);
    }
    await page.evaluate(({ line, offset }) => {
      const view = (window as any).__editor.view;
      view.scrollDOM.scrollTop = line > 1 ? view.scrollDOM.scrollTop + offset : view.lineBlockAt(view.state.doc.line(line).from).top + offset;
    }, { line, offset });
    await page.waitForSelector(header, { timeout: 5000 });
    await frames();
  };
  const code = ['```typescript', ...Array.from({ length: 180 }, (_, i) => `const value${i} = ${i};`), '```'].join('\n');
  const after = '\n\n' + Array.from({ length: 30 }, (_, i) => `Paragraph ${i}`).join('\n\n');
  await mount(code + after);
  assert.equal(await page.$(header), null, 'original header remains in place before crossing the top edge');
  await page.evaluate(() => { const view = (window as any).__editor.view; view.dispatch({ selection: { anchor: view.state.doc.line(100).from } }); });
  await pin(1, 2200);
  assert.equal(await page.$('.cm-content .meo-code-block-actions'), null, 'ordinary header is virtualized away');
  assert.equal(await page.$eval(header + ' .meo-block-sticky-language', el => el.textContent), 'typescript');
  assert.equal(await page.$$eval(header, els => els.length), 1);
  const geometry = await page.$eval(header, el => {
    const rect = el.getBoundingClientRect(), scroller = document.querySelector('#app > .cm-editor > .cm-scroller')!.getBoundingClientRect();
    return { top: rect.top - scroller.top, height: rect.height, opaque: getComputedStyle(el).backgroundColor, cursor: getComputedStyle(el).cursor };
  });
  assert.equal(geometry.top, 0); assert.equal(geometry.height, 30); assert.equal(geometry.cursor, 'default');
  assert.notEqual(geometry.opaque, 'rgba(0, 0, 0, 0)');
  await page.evaluate(() => (window as any).__editor.scrollToLine(100, 'top')); await frames(15);
  const caretBelowHeader = await page.evaluate(() => {
    const view = (window as any).__editor.view;
    return view.coordsAtPos(view.state.doc.line(100).from).top >= document.querySelector('.meo-block-sticky-header:not([hidden])')!.getBoundingClientRect().bottom - 1;
  });
  assert.equal(caretBelowHeader, true, 'explicit line-top navigation avoids header occlusion');
  const beforeClick = await page.evaluate(() => (window as any).__editor.view.state.selection.main.toJSON());
  await page.click(header + ' .meo-block-sticky-language');
  assert.deepEqual(await page.evaluate(() => (window as any).__editor.view.state.selection.main.toJSON()), beforeClick, 'passive header must not place the caret');
  await page.click(header + ' .meo-copy-code-btn');
  assert.equal(await page.evaluate(() => (window as any).__clipboard), code.split('\n').slice(1, -1).join('\n'));
  await page.click(header + ' .meo-select-all-code-btn');
  assert.equal(await page.evaluate(() => {
    const view = (window as any).__editor.view; return view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
  }), code.split('\n').slice(1, -1).join('\n'));
  const scrollBefore = await page.evaluate(() => (window as any).__editor.view.scrollDOM.scrollTop);
  await page.hover(header + ' .meo-block-sticky-language'); await page.mouse.wheel({ deltaY: 90 }); await frames();
  assert.ok(await page.evaluate(() => (window as any).__editor.view.scrollDOM.scrollTop) > scrollBefore, 'wheel over header scrolls document');
  await page.evaluate(() => {
    const editor = (window as any).__editor; editor.setText(editor.getText().replace('value0 = 0', 'value0 = 999'));
  });
  await frames(); await page.click(header + ' .meo-copy-code-btn');
  assert.ok((await page.evaluate(() => (window as any).__clipboard)).includes('value0 = 999'), 'copy reads the updated block');
  await page.evaluate(() => (window as any).__editor.scrollToLine(188, 'top')); await frames(15);
  assert.equal(await page.$(header), null, 'header leaves with its block');
  await pin();
  await page.evaluate(() => { const host = document.getElementById('app')!; host.style.transform = 'scale(0.85)'; host.style.transformOrigin = 'top left'; });
  await frames(12);
  const transformedHeader = await page.$eval(header, el => {
    const rect = el.getBoundingClientRect(), viewport = document.querySelector('#app > .cm-editor > .cm-scroller')!.getBoundingClientRect();
    return { top: rect.top - viewport.top, height: rect.height, right: rect.right - viewport.right };
  });
  assert.ok(Math.abs(transformedHeader.top) < 1 && Math.abs(transformedHeader.height - 30) < 1 && transformedHeader.right <= 0, 'fixed geometry respects transformed containing blocks');
  await page.evaluate(() => { document.getElementById('app')!.style.transform = ''; }); await frames(12);
  await page.evaluate(() => (window as any).__editor.setMode('source')); await frames();
  assert.equal(await page.$('.meo-block-sticky-header'), null, 'Source removes the live projection');

  const secondCode = ['```python', ...Array.from({ length: 50 }, (_, i) => `print(${i})`), '```'].join('\n');
  await mount(code + '\n\n' + secondCode + after);
  await pin(184, 180);
  assert.equal(await page.$eval(header + ' .meo-block-sticky-language', el => el.textContent), 'python', 'scrolling chooses the block at the top edge');
  await page.click(header + ' .meo-copy-code-btn');
  assert.equal(await page.evaluate(() => (window as any).__clipboard), secondCode.split('\n').slice(1, -1).join('\n'));
  await mount(Array.from({ length: 50 }, (_, i) => `    indented${i}`).join('\n') + after);
  await pin(); await page.click(header + ' .meo-copy-code-btn');
  assert.ok((await page.evaluate(() => (window as any).__clipboard)).startsWith('indented0'), 'indented code reuses source-aware copy');
  await mount('```js\nshort\n```' + after);
  await page.evaluate(() => { (window as any).__editor.view.scrollDOM.scrollTop = 40; }); await frames();
  assert.equal(await page.$(header), null, 'short block with insufficient remaining content does not float');

  const mermaid = ['```mermaid', 'flowchart TD', ...Array.from({ length: 45 }, (_, i) => `N${i} --> N${i + 1}`), '```'].join('\n');
  await mount(mermaid + after); await page.waitForSelector('.meo-mermaid-block svg'); await pin();
  assert.equal(await page.$eval(header + ' .meo-block-sticky-language', el => el.textContent), 'mermaid');
  await page.click(header + ' .meo-copy-code-btn');
  assert.equal(await page.evaluate(() => (window as any).__clipboard), mermaid, 'Mermaid preserves the original full-block copy contract');
  assert.equal(await page.$$eval(header + ' .meo-visual-control-btn', els => els.length), 4);
  await page.evaluate(() => (window as any).__editor.setUiLanguage('en')); await frames(12);
  assert.equal(await page.$eval(header + ' .meo-mermaid-mode-btn', el => (el as HTMLElement).dataset.tooltip), 'Switch to split view');
  await page.evaluate(() => (window as any).__editor.setUiLanguage('zh-CN')); await frames(12);
  assert.notEqual(await page.$eval(header + ' .meo-mermaid-mode-btn', el => (el as HTMLElement).dataset.tooltip), 'Switch to split view');

  const transform = await page.$eval('.meo-mermaid-svg-wrapper', el => (el as HTMLElement).style.transform);
  await page.click(header + ' .meo-visual-control-btn');
  assert.notEqual(await page.$eval('.meo-mermaid-svg-wrapper', el => (el as HTMLElement).style.transform), transform, 'floating zoom updates original preview');
  await page.click(header + ' .meo-visual-control-btn:nth-child(3)');
  await page.hover(header + ' .meo-mermaid-mode-btn');
  await page.waitForSelector('.meo-tooltip.is-visible');
  await page.click(header + ' .meo-mermaid-mode-btn'); await frames(15);
  await page.waitForSelector('.meo-mermaid-editing-block.is-split');
  assert.equal(await page.$eval('.meo-tooltip.is-visible .meo-tooltip-label', el => el.textContent),
    await page.$eval(header + ' .meo-mermaid-mode-btn', el => (el as HTMLElement).dataset.tooltip), 'hovered mode tooltip changes without re-entry');
  assert.ok(await page.$(header), 'Split retains a single header');
  assert.equal(await page.$eval(header + ' .meo-mermaid-toolbar', el => (el as HTMLElement).dataset.meoMermaidMode), 'split');
  await page.evaluate(() => { (window as any).__editor.view.scrollDOM.scrollTop = 0; }); await frames(15);
  assert.equal(await page.$$eval('.cm-content .meo-mermaid-toolbar .meo-visual-control-btn', els => els.length), 4, 'returning to the original header restores its preview controls');
  await pin();
  await page.click(header + ' .meo-mermaid-mode-btn'); await frames(15);
  await page.waitForSelector('.meo-mermaid-editing-block.is-source');
  assert.equal(await page.$(header + ' .meo-visual-controls'), null, 'Source has no preview controls');
  await page.click(header + ' .meo-mermaid-mode-btn'); await frames(15); await pin();
  await page.click(header + ' .meo-visual-control-btn:nth-child(4)');
  await page.waitForSelector('.meo-mermaid-fullscreen-scrim'); await frames();
  assert.equal(await page.$(header), null, 'fullscreen hides floating header');
  await page.keyboard.press('Escape'); await frames(15); await pin();
  await page.setViewport({ width: 280, height: 640 }); await frames(12);
  assert.ok(await page.$(header + ' .meo-rendered-block-preview-actions.is-collapsed'));
  await page.click(header + ' summary');
  assert.ok(await page.$eval(header + ' .meo-visual-control-btn', el => el.getBoundingClientRect().height > 0));
  await page.setViewport({ width: 1050, height: 640 }); await frames();

  await page.evaluate(() => { const editor = (window as any).__editor; editor.setSearchQuery('N30'); editor.findNext('N30', { focusEditor: false }); });
  await frames(15); await pin();
  assert.equal(await page.$eval(header + ' .meo-mermaid-toolbar', el => (el as HTMLElement).dataset.meoMermaidMode), 'split', 'floating mode follows temporary search presentation');
  await page.click(header + ' .meo-mermaid-mode-btn'); await frames(15);
  assert.ok(await page.$('.meo-mermaid-editing-block.is-source'), 'manual action overrides the temporary search mode');

  const math = ['$$', '\\begin{aligned}', ...Array.from({ length: 30 }, (_, i) => `x_{${i}} &= ${i} \\\\`), '\\end{aligned}', '$$'].join('\n');
  await mount(math + after); await pin();
  assert.equal(await page.$eval(header + ' .meo-block-sticky-language', el => el.textContent), 'latex');
  await page.click(header + ' .meo-copy-code-btn');
  assert.equal(await page.evaluate(() => (window as any).__clipboard), math.split('\n').slice(1, -1).join('\n'), 'math copies the original source span');
  assert.equal(await page.$$eval(header + ' .meo-visual-control-btn', els => els.length), 4);
  const mathTransform = await page.$eval('.meo-latex-math-canvas', el => (el as HTMLElement).style.cssText);
  await page.click(header + ' .meo-visual-control-btn');
  assert.notEqual(await page.$eval('.meo-latex-math-canvas', el => (el as HTMLElement).style.cssText), mathTransform, 'floating math controls share the preview viewport');
  await page.click(header + ' .meo-visual-control-btn:nth-child(4)'); await frames();
  await page.waitForSelector('.meo-latex-math-fullscreen-scrim');
  assert.equal(await page.$(header), null);
  await page.keyboard.press('Escape'); await frames(15); await pin();
  await page.click(header + ' .meo-latex-math-mode-btn'); await frames(15);
  await page.waitForSelector('.meo-latex-math-editing-block.is-split');
  assert.ok(await page.$(header));
  await page.click(header + ' .meo-latex-math-mode-btn'); await frames(15);
  await page.waitForSelector('.meo-latex-math-editing-block.is-source');
  assert.equal(await page.$(header + ' .meo-visual-controls'), null);
  await page.evaluate(() => (window as any).__editor.setText('Removed block\n\nParagraph')); await frames(12);
  assert.equal(await page.$(header), null, 'deleted block cannot leave stale actions');
  await page.evaluate(() => { (window as any).__editor.destroy(); (window as any).__disposeTooltips.dispose(); });
  assert.equal(await page.$('.meo-block-sticky-header'), null);
  assert.deepEqual(errors, []);
  console.log('Block sticky header production: code, Mermaid, math, actions, geometry and lifecycle passed');
} finally { await browser.close(); }
