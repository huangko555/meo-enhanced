import { setMermaidLayout } from './history-mermaid-chromium';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchTestBrowser } from './browser-test-helpers';

const root = path.resolve(import.meta.dir, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meo-embedded-font-'));
const build = await Bun.build({
  entrypoints: [path.join(root, 'scripts/test-mermaid-editing-entry.ts')],
  outdir: tempDir,
  target: 'browser',
  format: 'iife',
  naming: 'bundle.js'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 720 });
  await page.setContent('<!doctype html><body class="vscode-light"><div id="app"></div></body>');
  await page.addStyleTag({ content: 'html,body,#app{height:100%;margin:0}:root{--meo-background:#fff;--meo-foreground:#24292f;--meo-code-background:#f6f8fa;--meo-surface-background:#fff;--meo-font-live:Arial;--meo-font-live-weight:400;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-weight:400;--meo-font-source-size:14px;--meo-line-height-live:1.6;--meo-line-height-source:1.5;--vscode-editor-font-size:14px}' });
  await page.addStyleTag({ path: path.join(root, 'webview/src/styles.css') });
  await page.addStyleTag({ content: '#app > .cm-editor{height:100%;overflow:hidden}#app > .cm-editor > .cm-scroller{height:100%;overflow:auto}' });
  await page.addScriptTag({ path: path.join(tempDir, 'bundle.js') });
  await page.evaluate(() => {
    (window as any).mermaid = {
      initialize() {},
      async render() { return { svg: '<svg width="800" height="120" viewBox="0 0 800 120"></svg>' }; }
    };
    const lines = Array.from({ length: 76 }, (_, index) => index % 5 === 0
      ? `Node${index} -->|${'long wrapped edge label '.repeat(7)}| Node${index + 1}`
      : `Node${index} --> Node${index + 1}`);
    (window as any).__embeddedFontEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text: ['# Before', '```mermaid', 'flowchart TB', ...lines, '```', '# After'].join('\n'),
      initialMode: 'live', sourceLineNumbers: 'on',
      onApplyChanges() {}
    });
  });
  await page.waitForSelector('.meo-mermaid-mode-btn');
  const measure = async (size: number | null) => {
    await page.evaluate(value => {
      if (value === null) document.documentElement.style.removeProperty('--meo-user-editor-font-size');
      else document.documentElement.style.setProperty('--meo-user-editor-font-size', `${value}px`);
      (window as any).__embeddedFontEditor.scrollToLine(55, 'center');
    }, size);
    await page.evaluate(async () => { for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame); });
    return page.evaluate(() => {
      const v = (window as any).__embeddedFontEditor.view, viewport = v.scrollDOM.getBoundingClientRect();
      const sourceNode = v.domAtPos(v.state.doc.line(55).from).node;
      const line = (sourceNode instanceof Element ? sourceNode : sourceNode.parentElement)!.closest('.cm-line')!;
      const markers = Array.from(v.scrollDOM.querySelectorAll<HTMLElement>(':scope > .cm-gutters .cm-lineNumbers > .cm-gutterElement'))
        .filter(n => /^\d+$/.test(n.textContent?.trim() ?? '') && n.getBoundingClientRect().bottom > viewport.top && n.getBoundingClientRect().top < viewport.bottom);
      return { outerFont: getComputedStyle(v.dom).fontSize, sourceFont: getComputedStyle(line).fontSize,
        inputs: v.dom.querySelectorAll('.cm-content[contenteditable="true"]').length,
        localGutters: v.dom.querySelectorAll('.meo-rendered-block-document-line-number-column').length,
        pairs: markers.map(n => { const number = Number(n.textContent), r = v.coordsAtPos(v.state.doc.line(number).from);
          return { number, delta: r ? n.getBoundingClientRect().top - r.top : null }; }) };
    });
  };
  for (const layout of ['stacked', 'side-by-side'] as const) {
    await setMermaidLayout(page, '__embeddedFontEditor', 2, layout);
    for (const size of [15, 20, 15, null]) {
      const result = await measure(size);
      assert.equal(result.sourceFont, `${size ?? 14}px`, `${layout}: native source uses the requested source font`);
      assert.equal(result.inputs, 1); assert.equal(result.localGutters, 0);
      assert.ok(result.pairs.some(p => p.number >= 50) && result.pairs.every(p => p.delta !== null && Math.abs(p.delta) <= 2),
        `${layout}: document numbers align through deep wrapped source ${JSON.stringify(result)}`);
    }
  }
  await page.setViewport({ width: 700, height: 720 });
  const narrow = await measure(20);
  assert.ok(narrow.pairs.length > 2 && narrow.pairs.every(p => p.delta !== null && Math.abs(p.delta) <= 2));
  for (const kind of ['math', 'html'] as const) {
    for (const width of [900, 700]) {
      await page.setViewport({ width, height: 720 });
      await page.evaluate(kind => {
        (window as any).__embeddedFontEditor.destroy();
        document.getElementById('app')!.replaceChildren();
        const rows = Array.from({ length: 76 }, (_, index) => kind === 'math'
          ? `x_{${index}} = ${'a+b+c+d+'.repeat(index % 5 === 0 ? 14 : 1)}`
          : `<p>Row ${index}: ${'HTML source text '.repeat(index % 5 === 0 ? 14 : 1)}</p>`);
        (window as any).__embeddedFontEditor = (window as any).MermaidEditingHarness.createEditor({
          parent: document.getElementById('app')!,
          text: ['# Before', '', kind === 'math' ? '$$' : '<div>', ...rows,
            kind === 'math' ? '$$' : '</div>', '', '# After'].join('\n'),
          initialMode: 'live',
          onApplyChanges() {}
        });
      }, kind);
      await page.evaluate(() => { const editor = (window as any).__embeddedFontEditor;
        editor.view.dispatch({ selection: { anchor: editor.view.state.doc.line(55).from } }); editor.view.focus(); editor.scrollToLine(55, 'center'); });
      for (const size of [15, 20, 15, null]) {
        await page.evaluate(value => { (window as any).__embeddedFontEditor.preserveViewport(() => {
          if (value === null) document.documentElement.style.removeProperty('--meo-user-editor-font-size');
          else document.documentElement.style.setProperty('--meo-user-editor-font-size', value + 'px');
        }, true); }, size);
        await page.evaluate(async () => { for (let frame = 0; frame < 12; frame++) await new Promise(requestAnimationFrame); });
        const layout = await page.evaluate(() => { const view = (window as any).__embeddedFontEditor.view;
          const line = view.state.doc.line(55), coords = view.coordsAtPos(line.from)!;
          const marker = Array.from(view.dom.querySelectorAll('.cm-lineNumbers > .cm-gutterElement')).find((element: any) => element.textContent.trim() === '55') as HTMLElement;
          const node = view.domAtPos(line.from).node;
          return { editors: view.dom.querySelectorAll('.cm-editor').length, font: getComputedStyle(node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement!).fontSize,
            text: line.text, caret: { top: coords.top, bottom: coords.bottom }, marker: { top: marker.getBoundingClientRect().top, height: marker.getBoundingClientRect().height },
            delta: marker.getBoundingClientRect().top + marker.getBoundingClientRect().height / 2 - (coords.top + coords.bottom) / 2 }; });
        assert.equal(layout.editors, 0, `${kind}/${width}: source uses the main editor`);
        assert.equal(layout.font, (size ?? 14) + 'px', `${kind}/${width}: source follows the current font size`);
        assert.ok(Math.abs(layout.delta) <= 3, `${kind}/${width}: document line numbers align with source: ${JSON.stringify(layout)}`);
        if (size === 20) {
          fs.mkdirSync('.local/embedded-source-font', { recursive: true });
          await page.screenshot({ path: `.local/embedded-source-font/${kind}-${width}.png` });
        }
      }
    }
  }
  const fallbackFonts = await page.evaluate(() => {
    document.documentElement.style.setProperty('--meo-user-editor-font-size', '20px');
    const probe = document.createElement('div');
    probe.innerHTML = '<pre class="meo-mermaid-fallback"><code>fallback source</code></pre><span class="meo-md-image-fallback-text">missing image</span>';
    document.querySelector('#app > .cm-editor')!.appendChild(probe);
    const sizes = Array.from(probe.querySelectorAll<HTMLElement>('code, .meo-md-image-fallback-text'))
      .map((element) => getComputedStyle(element).fontSize);
    probe.remove();
    return sizes;
  });
  assert.deepEqual(fallbackFonts, ['20px', '20px'], 'Fallback content should follow the custom editor font size');
  console.log('Embedded source font size and gutter alignment passed');
} finally {
  await browser.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
}
