import assert from 'node:assert/strict';
import fs from 'node:fs';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-mermaid-editing-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const fetch = () => new Response(
  '<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app" class="editor-host"></div>',
  { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
let server: ReturnType<typeof Bun.serve>;
for (let attempt = 0; ; attempt++) {
  try {
    // Windows can assign port 0 a low port that Chromium blocks (for example 6669).
    server = Bun.serve({ hostname: '127.0.0.1', port: 40000 + process.pid % 20000 + attempt, fetch });
    break;
  } catch (error) {
    if (attempt >= 9 || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
  }
}
const origin = `http://127.0.0.1:${server.port}`;
const browser = await launchTestBrowser();
let primary: unknown;
try {
  await browser.defaultBrowserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 850 });
  await page.goto(origin);
  await page.bringToFront();
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ path: 'webview/dist/katex/katex-embedded.css' });
  await page.addStyleTag({ content: ':root{--meo-font-live:Arial;--meo-font-live-size:16px;--meo-font-source:monospace;--meo-font-source-size:16px}' });
  await page.addScriptTag({ path: 'node_modules/mermaid/dist/mermaid.min.js' });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const settle = () => page.evaluate(async () => {
    for (let index = 0; index < 12; index++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
  const create = async (text: string, language = 'en', appearance = 'dark') => {
    await page.evaluate(({ text, language, appearance }) => {
      const scope = window as any;
      scope.imageEditor?.destroy(); document.querySelector('#app')!.replaceChildren();
      document.body.className = appearance === 'dark' ? 'vscode-dark' : 'vscode-light';
      scope.MermaidEditingHarness.applyUiTheme(appearance, true);
      scope.MermaidEditingHarness.applyCodeTheme(appearance);
      scope.imageEditor = scope.MermaidEditingHarness.createEditor({ parent: document.querySelector('#app'),
        text, uiLanguage: language, initialMode: 'live', onApplyChanges() {} });
    }, { text, language, appearance });
    await settle();
  };
  const snapshot = () => page.evaluate(() => {
    const editor = (window as any).imageEditor;
    return { text: editor.getText(), selection: editor.view.state.selection.toJSON(), history: editor.getHistoryDepth(),
      scroll: editor.view.scrollDOM.scrollTop };
  });
  const copy = async (actions: string, keyboard = false) => {
    await page.mouse.move(1, 1);
    await page.hover(actions);
    await page.hover(actions + ' .meo-copy-image-btn');
    assert.equal(await page.$eval(actions + ' .meo-copy-image-btn', node => node.getAttribute('aria-disabled')), 'false',
      JSON.stringify({ actions, state: await snapshot(), blocks: await page.$$eval('.meo-md-math-fenced-display, .meo-mermaid-block', nodes => nodes.map(node => ({ data: { ...(node as HTMLElement).dataset }, text: node.textContent?.slice(0, 150) }))) }));
    const before = await snapshot();
    if (keyboard) { await page.focus(actions + ' .meo-copy-image-btn'); await page.keyboard.press('Enter'); }
    else await page.click(actions + ' .meo-copy-image-btn');
    await page.waitForFunction(actions => document.querySelector(actions + ' .meo-copy-image-btn')?.classList.contains('copied'),
      { timeout: 15000 }, actions);
    assert.deepEqual(await snapshot(), before, 'Copying an image preserves text, selection, history and reading position');
    const image = await page.evaluate(async () => {
      const item = (await navigator.clipboard.read()).find(item => item.types.includes('image/png'))!;
      const bitmap = await createImageBitmap(await item.getType('image/png'));
      const canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext('2d')!; context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let ink = 0, opaque = true;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] !== 255) opaque = false;
        if (Math.abs(pixels[index]! - pixels[0]!) + Math.abs(pixels[index + 1]! - pixels[1]!) + Math.abs(pixels[index + 2]! - pixels[2]!) > 40) ink++;
      }
      return { width: bitmap.width, height: bitmap.height, ink, opaque, data: canvas.toDataURL('image/png').split(',')[1]! };
    });
    assert.ok(image.width > 64 && image.height > 64 && image.ink > 200 && image.opaque, JSON.stringify({ ...image, data: undefined }));
    return image;
  };
  const order = async (actions: string, language: string) => {
    const labels = await page.$$eval(actions + ' > [role="button"], ' + actions + ' > button', nodes => nodes.map(node => node.getAttribute('aria-label')));
    assert.deepEqual(labels.slice(-2), language === 'en' ? ['Copy as image', 'Copy source'] : ['复制为图片', '复制源码']);
    const bounds = await page.$eval(actions, node => {
      const image = node.querySelector('.meo-copy-image-btn')!.getBoundingClientRect();
      const source = node.querySelector('.meo-copy-code-btn')!.getBoundingClientRect();
      return { right: image.right, left: source.left, width: image.width, height: image.height };
    });
    assert.ok(bounds.right <= bounds.left + 1, JSON.stringify(bounds));
    assert.equal(bounds.width, 22); assert.equal(bounds.height, 20);
  };
  const formula = String.raw`\frac{x^2}{\sqrt{y}} + \begin{pmatrix} a & b \\ c & d \end{pmatrix}`;
  const diagram = 'flowchart LR\nA[中文节点] --> B[Complete diagram]';
  const changeMode = async () => {
    await page.hover('.meo-mermaid-mode-btn');
    await page.waitForFunction(() => {
      const button = document.querySelector('.meo-mermaid-mode-btn')!;
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    });
    await page.click('.meo-mermaid-mode-btn'); await settle();
  };
  fs.mkdirSync('.local/probes/live-image-copy', { recursive: true });
  for (const appearance of ['dark', 'light']) for (const language of ['en', 'zh-CN']) {
    await create(`Before\n\n$$\n${formula}\n$$\n\nAfter with inline $x^2$.`, language, appearance);
    await order('.meo-math-copy-actions', language);
    assert.equal(await page.$$eval('.meo-md-math-inline .meo-copy-image-btn, .meo-md-math-fenced-display .meo-mermaid-zoom-btn', nodes => nodes.length), 0);
    const math = await copy('.meo-math-copy-actions');
    assert.ok(math.width < 1500, 'Math copying trims document-width whitespace');
    fs.writeFileSync(`.local/probes/live-image-copy/${appearance}-${language}-math.png`, Buffer.from(math.data, 'base64'));
    await page.evaluate(language => (window as any).imageEditor.setUiLanguage(language), language === 'en' ? 'zh-CN' : 'en');
    await settle();
    assert.equal(await page.$eval('.meo-math-copy-actions .meo-copy-image-btn', node => node.getAttribute('aria-label')),
      language === 'en' ? '已复制图片' : 'Image copied', 'Mounted formula image feedback follows the panel language');
    await page.evaluate(language => (window as any).imageEditor.setUiLanguage(language), language); await settle();
    await page.click('.meo-md-math-fenced-display .katex'); await settle();
    await order('.meo-math-source-actions', language);
    await copy('.meo-math-source-actions', true);
    await page.evaluate(() => {
      const editor = (window as any).imageEditor, view = editor.view;
      const line = view.state.doc.line(4);
      view.dispatch({ changes: { from: line.from, to: line.to, insert: '\\frac{' }, selection: { anchor: line.from + 6 } }); view.focus();
    });
    await settle();
    await page.mouse.move(1, 1);
    await page.hover('.meo-math-source-actions .meo-copy-image-btn');
    assert.equal(await page.$eval('.meo-math-source-actions .meo-copy-image-btn', node => node.getAttribute('aria-disabled')), 'true',
      'An incomplete formula must not copy the retained old result');
    await page.keyboard.type('a}{b}'); await settle();
    await copy('.meo-math-source-actions');

    await create(`Before\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\nAfter`, language, appearance);
    await page.waitForSelector('.meo-mermaid-block svg');
    await order('.meo-mermaid-toolbar', language);
    const png = await copy('.meo-mermaid-toolbar');
    fs.writeFileSync(`.local/probes/live-image-copy/${appearance}-${language}-mermaid.png`, Buffer.from(png.data, 'base64'));
    await page.evaluate(language => (window as any).imageEditor.setUiLanguage(language), language === 'en' ? 'zh-CN' : 'en');
    await settle(); await order('.meo-mermaid-toolbar', language === 'en' ? 'zh-CN' : 'en');
    await page.evaluate(language => (window as any).imageEditor.setUiLanguage(language), language); await settle();
    await page.hover('.meo-mermaid-block');
    await page.click('.meo-mermaid-preview-controls .meo-mermaid-zoom-btn:last-child');
    await page.waitForSelector('.meo-mermaid-fullscreen');
    assert.equal(await page.$$eval('.meo-mermaid-fullscreen .meo-copy-image-btn, .meo-mermaid-fullscreen .meo-copy-code-btn', nodes => nodes.length), 0);
    assert.equal(await page.$$eval('.meo-mermaid-fullscreen-controls button', nodes => nodes.length), 4);
    await page.keyboard.press('Escape');
    await changeMode();
    assert.ok(await page.$('.meo-mermaid-editing-preview'));
    await copy('.meo-mermaid-toolbar', true);
    await page.$eval('.meo-mermaid-layout-btn',b=>(b as HTMLElement).click()); await settle();
    await copy('.meo-mermaid-toolbar', true);
    await changeMode(); await copy('.meo-mermaid-toolbar');
  }
  await create(`Before\n\n\`\`\`mermaid\n${diagram}\n\`\`\`\n\nAfter`);
  await page.waitForSelector('.meo-mermaid-block svg');
  await page.evaluate(() => {
    const editor = (window as any).imageEditor, view = editor.view;
    const from = editor.getText().indexOf('A[中文节点]');
    view.dispatch({ changes: { from, to: view.state.doc.lineAt(from).to, insert: 'A[unfinished' } });
  });
  await page.waitForSelector('.meo-mermaid-error-badge');
  await page.focus('.meo-mermaid-toolbar .meo-copy-image-btn');
  assert.equal(await page.$eval('.meo-copy-image-btn', node => node.getAttribute('aria-disabled')), 'true',
    'A Mermaid error must not copy the retained old diagram');
  await page.evaluate(() => navigator.clipboard.writeText('unavailable-diagram'));
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'unavailable-diagram');
  for (const alias of ['math', 'latex', 'tex', 'katex']) {
    await create(`Before\n\n\`\`\`${alias}\nx^2 + \\frac{1}{y}\n\`\`\`\n\nAfter`);
    await copy('.meo-math-copy-actions');
  }
  await create('Before\n\n```mermaid\nflowchart TD\n' + Array.from({ length: 30 }, (_, index) => `A${index} --> A${index + 1}`).join('\n') + '\n```\n\nAfter');
  await page.waitForSelector('.meo-mermaid-block svg');
  const tall = await copy('.meo-mermaid-toolbar');
  await page.evaluate(() => { (window as any).imageEditor.view.scrollDOM.scrollTop = 250; });
  const floating = '.meo-block-sticky-header:not([hidden]) .meo-mermaid-toolbar';
  await page.waitForSelector(floating);
  await order(floating, 'en');
  const sticky = await copy(floating);
  assert.deepEqual({ width: sticky.width, height: sticky.height }, { width: tall.width, height: tall.height },
    'The floating toolbar copies the complete owner diagram, independent of scroll clipping');
  await create('Before\n\n$$\nx^2\n$$\n\nAfter');
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'write', { configurable: true,
    value: async () => { throw new Error('Clipboard denied'); } }));
  await page.hover('.meo-math-copy-actions'); await page.click('.meo-math-copy-actions .meo-copy-image-btn');
  await page.waitForFunction(() => document.querySelector('.meo-preview-action-status')?.textContent?.includes('Could not copy image'));
  assert.equal(await page.$eval('.meo-copy-image-btn', node => node.classList.contains('copied')), false);
  await page.evaluate(() => (window as any).imageEditor.destroy());
  console.log('Live PNG copying: native clipboard, reading/editing math, aliases, Mermaid modes, ordering, fullscreen and bilingual themes passed');
} catch (error) { primary = error; }
finally {
  server.stop(true);
  if (primary === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primary);
}
