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
  await page.setContent('<!doctype html><body><div id="app"></div></body>');
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
      initialMode: 'live',
      onApplyChanges() {}
    });
  });
  await page.waitForSelector('.meo-mermaid-mode-btn');
  const measure = async (kind: 'mermaid' | 'latex-math', size: number | null) => {
    await page.evaluate((value) => {
      if (value === null) document.documentElement.style.removeProperty('--meo-user-editor-font-size');
      else document.documentElement.style.setProperty('--meo-user-editor-font-size', `${value}px`);
    }, size);
    await page.evaluate(async () => { for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame); });
    for (let attempt = 0; attempt < 4; attempt++) await page.evaluate(async (blockKind) => {
      const scroller = document.querySelector<HTMLElement>('#app > .cm-editor > .cm-scroller')!;
      const block = document.querySelector<HTMLElement>(`.meo-${blockKind}-editing-block`)!;
      scroller.scrollTop += block.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        + block.getBoundingClientRect().height * 0.65;
      for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame);
    }, kind);
    return page.evaluate((blockKind) => {
      const outer = document.querySelector<HTMLElement>('#app > .cm-editor')!;
      const inner = document.querySelector<HTMLElement>(`.meo-${blockKind}-source-editor > .cm-editor`)!;
      const column = outer.querySelector<HTMLElement>('.meo-rendered-block-document-line-number-column')!;
      const labels = Array.from(column.querySelectorAll<HTMLElement>('.meo-rendered-block-document-line-number'));
      const markers = Array.from(inner.querySelectorAll<HTMLElement>('.cm-lineNumbers > .cm-gutterElement'))
        .filter((element) => /^\d+$/.test(element.textContent?.trim() ?? '') && element.getBoundingClientRect().height > 0);
      const visible = markers.filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > 0 && rect.top < window.innerHeight;
      });
      return {
        outerFont: getComputedStyle(outer).fontSize,
        innerFont: getComputedStyle(inner).fontSize,
        renderedMarkers: markers.length,
        totalLines: labels.length,
        visiblePairs: visible.map((marker) => {
          const number = Number(marker.textContent!.trim());
          const label = labels[number - 1];
          const textTop = (element: HTMLElement) => {
            const range = document.createRange();
            range.selectNodeContents(element);
            return range.getBoundingClientRect().top;
          };
          return { number,
            documentNumber: label ? Number(label.textContent) : null,
            delta: label ? label.getBoundingClientRect().top - marker.getBoundingClientRect().top : null,
            textDelta: label ? textTop(label) - textTop(marker) : null };
        })
      };
    }, kind);
  };
  for (const mode of ['split', 'source'] as const) {
    if (mode === 'source') {
      await page.evaluate(() => { document.querySelector<HTMLElement>('#app > .cm-editor > .cm-scroller')!.scrollTop = 0; });
      await page.waitForSelector('.meo-mermaid-mode-btn');
    }
    await page.locator('.meo-mermaid-mode-btn').click();
    await page.waitForSelector(`.meo-mermaid-editing-block.is-${mode}`);
    for (const size of [15, 20, 15]) {
      const result = await measure('mermaid', size);
      assert.equal(result.outerFont, `${size}px`, `${mode} outer font`);
      assert.equal(result.innerFont, `${size}px`, `${mode} embedded source font`);
      assert.ok(result.visiblePairs.length >= 3, `${mode} should expose visible source lines: ${JSON.stringify(result)}`);
      assert.ok(result.renderedMarkers < result.totalLines && result.visiblePairs.some((pair) => pair.number >= 50),
        `${mode} should measure a deep virtualized part of the source: ${JSON.stringify(result)}`);
      assert.ok(result.visiblePairs.every((pair) => pair.delta !== null && Math.abs(pair.delta) <= 2),
        `${mode} outer line numbers should align with embedded source: ${JSON.stringify(result)}`);
      assert.ok(result.visiblePairs.every((pair) => pair.documentNumber === pair.number + 2),
        `${mode} outer line numbers should identify the matching document lines: ${JSON.stringify(result)}`);
      assert.ok(result.visiblePairs.every((pair) => pair.textDelta !== null && Math.abs(pair.textDelta) <= 3),
        `${mode} line number text should align with embedded source: ${JSON.stringify(result)}`);
    }
    const automatic = await measure('mermaid', null);
    assert.equal(automatic.innerFont, '14px', `${mode} automatic source font`);
    assert.ok(automatic.visiblePairs.every((pair) => pair.textDelta !== null && Math.abs(pair.textDelta) <= 3),
      `${mode} automatic outer line numbers should align: ${JSON.stringify(automatic)}`);
  }
  await page.setViewport({ width: 700, height: 720 });
  const narrowMermaid = await measure('mermaid', 20);
  assert.ok(narrowMermaid.visiblePairs.some((pair) => pair.number >= 50)
    && narrowMermaid.visiblePairs.every((pair) => pair.textDelta !== null && Math.abs(pair.textDelta) <= 3),
  `Narrow Mermaid source line numbers should align: ${JSON.stringify(narrowMermaid)}`);
  await page.setViewport({ width: 900, height: 720 });
  await page.evaluate(() => {
    (window as any).__embeddedFontEditor.destroy();
    document.getElementById('app')!.replaceChildren();
    (window as any).__embeddedFontEditor = (window as any).MermaidEditingHarness.createEditor({
      parent: document.getElementById('app')!,
      text: ['# Before', '$$', ...Array.from({ length: 76 }, (_, index) =>
        `x_{${index}} = ${'a+b+c+d+'.repeat(index % 5 === 0 ? 14 : 1)}`), '$$', '# After'].join('\n'),
      initialMode: 'live',
      onApplyChanges() {}
    });
  });
  await page.waitForSelector('.meo-latex-math-mode-btn');
  for (const mode of ['split', 'source'] as const) {
    if (mode === 'source') {
      await page.evaluate(() => { document.querySelector<HTMLElement>('#app > .cm-editor > .cm-scroller')!.scrollTop = 0; });
      await page.waitForSelector('.meo-latex-math-mode-btn');
    }
    await page.locator('.meo-latex-math-mode-btn').click();
    await page.waitForSelector(`.meo-latex-math-editing-block.is-${mode}`);
    for (const size of [15, 20, 15]) {
      const result = await measure('latex-math', size);
      assert.equal(result.innerFont, `${size}px`, `LaTeX ${mode} embedded source font`);
      assert.ok(result.renderedMarkers < result.totalLines && result.visiblePairs.some((pair) => pair.number >= 50),
        `LaTeX ${mode} should measure deep source lines: ${JSON.stringify(result)}`);
      assert.ok(result.visiblePairs.every((pair) => pair.delta !== null && Math.abs(pair.delta) <= 2),
        `LaTeX ${mode} outer line numbers should align with embedded source: ${JSON.stringify(result)}`);
      assert.ok(result.visiblePairs.every((pair) => pair.documentNumber === pair.number + 2),
        `LaTeX ${mode} outer line numbers should identify the matching document lines: ${JSON.stringify(result)}`);
      assert.ok(result.visiblePairs.every((pair) => pair.textDelta !== null && Math.abs(pair.textDelta) <= 3),
        `LaTeX ${mode} line number text should align with embedded source: ${JSON.stringify(result)}`);
    }
    const automatic = await measure('latex-math', null);
    assert.equal(automatic.innerFont, '14px', `LaTeX ${mode} automatic source font`);
    assert.ok(automatic.visiblePairs.every((pair) => pair.textDelta !== null && Math.abs(pair.textDelta) <= 3),
      `LaTeX ${mode} automatic outer line numbers should align: ${JSON.stringify(automatic)}`);
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
