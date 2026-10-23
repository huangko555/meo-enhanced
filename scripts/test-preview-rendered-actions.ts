import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import exportRuntime from '../src/export/runtime';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-code-update-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const script = await build.outputs[0]!.text();
const styles = fs.readFileSync('webview/src/styles.css', 'utf8');
const katex = fs.readFileSync('webview/dist/katex/katex-embedded.css', 'utf8');
const output = '.local/probes/preview-rendered-actions';
fs.mkdirSync(output, { recursive: true });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => {
  if (new URL(request.url).pathname === '/katex-embedded.css') return new Response(katex, { headers: { 'Content-Type': 'text/css' } });
  return new Response('<!doctype html><style>' + styles + '</style><style>html,body{height:100%;margin:0}body{background:#121314;color:#c5cbd3}.preview-host:not([hidden]){height:100%;display:flex;flex-direction:column}.preview-frame{width:100%;height:100%;flex:1}</style><body></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
} });
const origin = `http://127.0.0.1:${server.port}`;
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  await browser.defaultBrowserContext().overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
  const page = await browser.newPage();
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.setViewport({ width: 960, height: 800 });
  await page.goto(origin);
  await page.bringToFront();
  await page.addStyleTag({ url: origin + '/katex-embedded.css' });
  await page.evaluate(href => { document.body.dataset.meoKatexSrc = href; }, origin + '/katex-embedded.css');
  await page.addScriptTag({ path: 'node_modules/mermaid/dist/mermaid.min.js' });
  await page.addScriptTag({ content: script });
  const diagram = 'flowchart LR\nA[中文节点] --> B[Complete diagram]';
  const formula = String.raw`\begin{pmatrix} a & b \\ c & d \end{pmatrix} + \frac{x^2}{\sqrt{y}} + \text{中文}`;
  const aliases = ['math', 'latex', 'tex', 'katex'];
  const markdown = ['# Rendered actions', 'Inline $a^2$ stays unchanged.', '```mermaid\n' + diagram + '\n```',
    '$$\n' + formula + '\n$$', ...aliases.map(alias => '```' + alias + '\nx^2 + \\frac{1}{y}\n```'),
    '```latex\n\\invalidcommand{\n```', '```ts\nconst x = 1;\n```', ...Array.from({ length: 12 }, (_, index) => `Paragraph ${index}.`)].join('\n\n');
  const render = async (text: string, language: 'en' | 'zh-CN', appearance: 'light' | 'dark') => {
    const value = exportRuntime.renderPreviewDocument({ markdownText: text, sourceDocumentPath: 'C:/rendered-actions.md', uiLanguage: language });
    await page.evaluate(({ text, language, appearance, value }) => {
      const scope = window as any;
      const controller = scope.__previewController;
      controller.setUiLanguage(language); controller.setAppearance(appearance); controller.setVisible(true);
      void controller.requestRender(text, { preserveViewport: true });
      const message = scope.__previewMessages.filter((item: any) => item.type === 'requestPreviewRender').at(-1);
      controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
    }, { text, language, appearance, value });
    await page.waitForFunction(() => {
      const doc = document.querySelector<HTMLIFrameElement>('iframe')?.contentDocument;
      return doc?.querySelector('.meo-export-mermaid.is-rendered svg')
        && doc.querySelector('.meo-preview-fullscreen-btn[aria-disabled="false"]');
    });
  };
  const frame = () => page.frames().find(frame => frame.parentFrame() === page.mainFrame())!;
  const click = async (selector: string) => {
    const point = await page.evaluate(selector => {
      const iframe = document.querySelector<HTMLIFrameElement>('iframe')!;
      const button = iframe.contentDocument!.querySelector<HTMLElement>(selector)!;
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect(), bounds = iframe.getBoundingClientRect();
      return { x: bounds.x + rect.x + rect.width / 2, y: bounds.y + rect.y + rect.height / 2 };
    }, selector);
    await page.mouse.move(point.x - 12, point.y + 25);
    await page.mouse.move(point.x, point.y);
    await page.mouse.click(point.x, point.y);
  };
  const copyImage = async (selector: string, filename: string) => {
    await click(selector + ' .meo-copy-image-btn');
    await page.waitForFunction(selector => document.querySelector<HTMLIFrameElement>('iframe')!.contentDocument!
      .querySelector(selector + ' .meo-copy-image-btn')?.classList.contains('copied'), { timeout: 15000 }, selector);
    const result = await page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      const item = items.find(item => item.types.includes('image/png'));
      if (!item) throw new Error('The native clipboard contains no PNG');
      const blob = await item.getType('image/png');
      const image = await createImageBitmap(blob);
      const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = true, ink = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] !== 255) opaque = false;
        if (Math.abs(pixels[index]! - pixels[0]!) + Math.abs(pixels[index + 1]! - pixels[1]!) + Math.abs(pixels[index + 2]! - pixels[2]!) > 40) ink++;
      }
      return { width: canvas.width, height: canvas.height, opaque, ink, background: Array.from(pixels.slice(0, 3)), data: canvas.toDataURL('image/png').split(',')[1]! };
    });
    assert.ok(result.width > 64 && result.height > 64);
    assert.ok(result.opaque, 'PNG background must remain opaque');
    assert.ok(result.ink > 250, 'PNG must contain rendered content rather than an empty background');
    fs.writeFileSync(path.join(output, filename + '.png'), Buffer.from(result.data, 'base64'));
    return result;
  };
  for (const appearance of ['light', 'dark'] as const) {
    for (const language of ['en', 'zh-CN'] as const) {
      await render(markdown, language, appearance);
      await page.waitForFunction(() => !document.querySelector<HTMLIFrameElement>('iframe')!.contentDocument!.querySelector('.meo-copy-image-btn.copied'));
      const labels = await frame().$eval('.meo-export-mermaid > .meo-preview-code-actions', node =>
        Array.from(node.children).map(button => button.getAttribute('aria-label')));
      assert.deepEqual(labels, language === 'en' ? ['View fullscreen', 'Copy as image', 'Copy source'] : ['全屏查看', '复制为图片', '复制源码']);
      assert.equal(await frame().$$eval('.meo-export-math-inline [role="button"]', nodes => nodes.length), 0);
      assert.equal(await frame().$$eval('.meo-export-math-display .meo-preview-fullscreen-btn', nodes => nodes.length), 0);
      assert.equal(await frame().$$eval('.meo-export-code-block-wrap .meo-copy-image-btn', nodes => nodes.length), 0);
      assert.equal(await frame().$$eval('.meo-export-math-display .meo-copy-image-btn', nodes => nodes.length), 6);
      assert.equal(await frame().$eval('.katex-error', node => node.closest('.meo-export-math-display')!
        .querySelector('.meo-copy-image-btn')!.getAttribute('aria-disabled')), 'true');
      await copyImage('.meo-export-mermaid', `${appearance}-${language}-mermaid`);
      const math = await copyImage('.meo-export-math-display', `${appearance}-${language}-math`);
      assert.equal(math.background.every(channel => channel < 80), appearance === 'dark', 'PNG background must follow the content appearance');
      await (await frame().$('.meo-export-math-display'))!.screenshot({ path: path.join(output, `${appearance}-${language}-math-reference.png`) });
      assert.ok(math.width < 1500, 'Formula PNG must crop document-width whitespace');
      await click('.meo-preview-fullscreen-btn');
      await page.waitForSelector('.meo-mermaid-fullscreen');
      const fullscreen = await page.$eval('.meo-mermaid-fullscreen', node => ({ width: node.clientWidth, height: node.clientHeight }));
      assert.ok(fullscreen.width >= 950 && fullscreen.height >= 790, 'The viewer must cover the outer Webview');
      const camera = () => page.$eval('.meo-mermaid-fullscreen .meo-mermaid-svg-wrapper', node => (node as HTMLElement).style.transform);
      const initial = await camera();
      await page.click('.meo-mermaid-fullscreen-controls button');
      assert.notEqual(await camera(), initial, 'Zoom must change the fullscreen camera');
      assert.equal(await page.$$eval('.meo-mermaid-fullscreen .meo-copy-image-btn, .meo-mermaid-fullscreen .meo-copy-code-btn', nodes => nodes.length), 0,
        'Fullscreen only contains viewing controls');
      assert.equal(await page.$$eval('.meo-mermaid-fullscreen-controls button', nodes => nodes.length), 4);
      await page.keyboard.press('Escape');
      await page.waitForSelector('.meo-mermaid-fullscreen', { hidden: true });
      assert.equal(await frame().evaluate(() => document.activeElement?.className), 'meo-preview-fullscreen-btn');
      await page.screenshot({ path: path.join(output, `${appearance}-${language}-controls.png`) });
    }
  }
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: async () => { throw new Error('Clipboard denied'); } });
  });
  await click('.meo-export-math-display .meo-copy-image-btn');
  await page.waitForFunction(() => document.querySelector<HTMLIFrameElement>('iframe')!.contentDocument!
    .querySelector('.meo-preview-action-status')?.textContent?.includes('无法复制图片'));
  assert.equal(await frame().$eval('.meo-export-math-display .meo-copy-image-btn', node => node.classList.contains('copied')), false);
  await click('.meo-preview-fullscreen-btn');
  await page.waitForSelector('.meo-mermaid-fullscreen');
  await render(markdown.replace(diagram, diagram.replace('Complete diagram', 'Updated diagram')), 'zh-CN', 'dark');
  await page.waitForSelector('.meo-mermaid-fullscreen', { hidden: true });
  assert.equal(await frame().$$eval('.meo-export-mermaid .meo-preview-code-actions > [role="button"]', nodes => nodes.length), 3);
  await click('.meo-preview-fullscreen-btn');
  await page.evaluate(() => (window as any).__previewController.setVisible(false));
  assert.equal(await page.$('.meo-mermaid-fullscreen'), null);
  await page.evaluate(() => (window as any).__previewController.dispose());
  console.log('Preview rendered actions: native PNG clipboard, formulas, ordering, fullscreen lifecycle and bilingual light/dark checks passed');
} catch (error) { primaryError = error; }
finally {
  server.stop(true);
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
