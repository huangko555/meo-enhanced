import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-code-update-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
let release!: () => void;
const held = new Promise<void>(resolve => { release = resolve; });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
  await held;
  return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"/>',
    { headers: { 'content-type': 'image/svg+xml' } });
} });
const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  await page.setContent('<!doctype html><style>html,body{height:100%;margin:0}</style><body></body>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: '.preview-host:not([hidden]){height:100%;display:flex;flex-direction:column}.preview-frame{width:100%;height:100%;flex:1}' });
  const src = new URL('/held.svg', server.url).href;
  await page.evaluate(src => { (window as any).__previewImageSizes = { [src]: { width: 640, height: 360 } }; }, src);
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(() => {
    const scope = window as any;
    scope.__initializeImageHandling({ postMessage(message: any) {
      if (message.type === 'resolveImageSrc') queueMicrotask(() => scope.__settleImageSrcRequest({
        type: 'resolvedImageSrc', requestId: message.requestId, result: { ok: true, value: { resolvedUrl: message.url } }
      }));
    } });
  });
  const text = `Before\n\n![plain](${src})\n\nAfter image target\n\n<img src="${src}" width="120" height="80" alt="authored">`;
  const value = exportRuntime.renderPreviewDocument({ markdownText: text, sourceDocumentPath: '/fixture/images.md', uiLanguage: 'en' });
  await page.evaluate(({ text, value }) => {
    const scope = window as any, controller = scope.__previewController;
    controller.setVisible(true);
    scope.__render = controller.requestRender(text, { force: true });
    const message = scope.__previewMessages.findLast((message: any) => message.type === 'requestPreviewRender');
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
  }, { text, value });
  await page.waitForFunction(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    return doc?.querySelector('img[alt="plain"]')?.width === 640;
  });
  const snapshot = () => page.evaluate(() => {
    const doc = (window as any).__previewController.host.querySelector('iframe').contentDocument;
    const plain = doc.querySelector('img[alt="plain"]'), authored = doc.querySelector('img[alt="authored"]');
    const line = [...doc.querySelectorAll('p')].find((node: any) => node.textContent === 'After image target');
    const rect = plain.getBoundingClientRect(), fixed = authored.getBoundingClientRect();
    return { width: rect.width, height: rect.height, lineTop: line.getBoundingClientRect().top,
      naturalWidth: plain.naturalWidth, authoredWidth: fixed.width, authoredHeight: fixed.height,
      authoredWidthAttribute: authored.getAttribute('width'), authoredHeightAttribute: authored.getAttribute('height') };
  });
  const before = await snapshot();
  assert.notEqual(before.naturalWidth, 640, 'network decoding must still be held');
  assert.ok(before.height > 300, 'plain Preview images must reserve their natural geometry before decoding');
  assert.equal(before.authoredWidth, 120);
  assert.equal(before.authoredHeight, 67.5, 'height:auto preserves the natural ratio with authored width');
  assert.equal(before.authoredWidthAttribute, '120');
  assert.equal(before.authoredHeightAttribute, '80');
  release();
  await page.waitForFunction(() => (window as any).__previewController.host.querySelector('iframe').contentDocument
    .querySelector('img[alt="plain"]')?.naturalWidth === 640);
  const after = await snapshot();
  for (const key of ['width', 'height', 'lineTop', 'authoredWidth', 'authoredHeight'] as const) {
    assert.ok(Math.abs(before[key] - after[key]) <= 1, `Preview image decoding moved ${key}: ${JSON.stringify({ before, after })}`);
  }
  await page.evaluate(() => (window as any).__previewController.dispose());
  console.log('Preview image header geometry and authored dimensions passed');
} finally {
  release();
  server.stop(true);
  await browser.close();
}
