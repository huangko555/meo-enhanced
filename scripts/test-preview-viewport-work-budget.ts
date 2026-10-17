import assert from 'node:assert/strict';
import { closeTestBrowser, launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-code-update-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const text = '# Viewport budget\n\nEarly reference[^early].\n\n[^early]: Footnote rendered after the final section.\n\n'
  + Array.from({ length: 4_100 }, (_, index) => `Paragraph ${index}.\n\n`).join('')
  + '<details>\n<summary>Closed section</summary>\n\n## Hidden heading\n\nHidden paragraph.\n\n</details>\n\n'
  + '## Final section\n\nFinal paragraph.';
const browser = await launchTestBrowser();
let primaryError: unknown;
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(String(error)));
  await page.setViewport({ width: 1100, height: 720 });
  await page.setContent('<!doctype html><style>html,body{height:100%;margin:0}</style><body></body>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.addStyleTag({ content: '.preview-host:not([hidden]){height:100%;display:flex;flex-direction:column}.preview-frame{width:100%;height:100%;flex:1}' });
  await page.addScriptTag({ content: await build.outputs[0].text() });
  const value = exportRuntime.renderPreviewDocument({ markdownText: text, sourceDocumentPath: 'C:/preview-budget.md', uiLanguage: 'en' });
  await page.evaluate(({ text, value }) => {
    const scope = window as any;
    const controller = scope.__previewController;
    controller.setVisible(true);
    controller.setSourceColoring(false);
    void controller.requestRender(text);
    const message = scope.__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1);
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: message.requestId, result: { ok: true, value } });
  }, { text, value });
  await page.waitForFunction(() => !!(window as any).__previewRenderedAt);
  await new Promise(resolve => setTimeout(resolve, 250));
  const reads = await page.evaluate(() => {
    const controller = (window as any).__previewController;
    const adapter = controller.getOutlineAdapter();
    const frame = controller.host.querySelector('iframe') as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    const prototype = (frame.contentWindow as any).Element.prototype;
    const rect = prototype.getBoundingClientRect;
    const rects = prototype.getClientRects;
    controller.captureLinkedGeometry();
    let sourceReads = 0;
    prototype.getBoundingClientRect = function() { if (this.hasAttribute('data-source-line')) sourceReads++; return rect.call(this); };
    prototype.getClientRects = function() { if (this.hasAttribute('data-source-line')) sourceReads++; return rects.call(this); };
    try {
      for (let repeat = 0; repeat < 10; repeat++) {
        adapter.getVisibleDocumentRange();
        adapter.getViewportAnchorOffset();
      }
    } finally {
      prototype.getBoundingClientRect = rect;
      prototype.getClientRects = rects;
    }
    return { sourceReads, sources: doc.querySelectorAll('[data-source-line]').length };
  });
  assert.ok(reads.sources > 4_000);
  console.log('Preview repeated viewport reads:', reads);
  assert.ok(reads.sourceReads < 100, 'scroll/outline queries must reuse the measured source index instead of measuring the whole document');
  for (const position of [0, 0.53, 1]) {
    const result = await page.evaluate(position => {
      const controller = (window as any).__previewController;
      const frame = controller.host.querySelector('iframe') as HTMLIFrameElement;
      const doc = frame.contentDocument!;
      const scroller = doc.scrollingElement!;
      scroller.scrollTop = position * (scroller.scrollHeight - scroller.clientHeight);
      const height = frame.contentWindow!.innerHeight;
      const rendered = Array.from(doc.querySelectorAll<HTMLElement>('[data-source-line]'))
        .filter(element => element.getClientRects().length)
        .map(element => {
          const rect = element.getBoundingClientRect();
          return { start: Number(element.dataset.sourceLine), top: rect.top, bottom: rect.bottom };
        });
      const visible = rendered.filter(entry => entry.bottom > entry.top && entry.bottom > 0 && entry.top < height);
      const lines = visible.map(entry => entry.start);
      const anchors = rendered.filter(entry => entry.top <= height * 0.2)
        .sort((a, b) => a.top - b.top || a.bottom - b.bottom || a.start - b.start);
      const adapter = controller.getOutlineAdapter();
      return { actual: adapter.getVisibleDocumentRange(), anchor: adapter.getViewportAnchorOffset(),
        expected: { from: Math.min(...lines), to: Math.max(...lines), fromLine: Math.min(...lines), toLine: Math.max(...lines) },
        expectedAnchor: anchors.at(-1)?.start ?? 1 };
    }, position);
    assert.deepEqual(result.actual, result.expected, `visible source range at ${position}`);
    assert.equal(result.anchor, result.expectedAnchor, `visual anchor at ${position}, including relocated footnotes`);
  }
  const hidden = await page.evaluate(() => {
    const controller = (window as any).__previewController;
    controller.setVisible(false);
    return controller.getOutlineAdapter().getVisibleDocumentRange();
  });
  assert.deepEqual(hidden, { from: 1, to: 1, fromLine: 1, toLine: 1 });
  assert.deepEqual(errors, []);
  await page.evaluate(() => (window as any).__previewController.dispose());
  console.log('Preview viewport source index, visual footnote order and hidden surface budget passed');
} catch (error) {
  primaryError = error;
  throw error;
} finally {
  if (primaryError === undefined) await closeTestBrowser(browser);
  else await closeTestBrowser(browser, primaryError);
}
