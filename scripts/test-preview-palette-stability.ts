import assert from 'node:assert/strict';
import fs from 'node:fs';
import { launchTestBrowser, closeTestBrowser } from './browser-test-helpers';
import runtime from '../src/export/runtime';

const build = await Bun.build({ entrypoints: ['scripts/test-preview-code-update-entry.ts'], target: 'browser', format: 'iife' });
assert.ok(build.success, build.logs.map(String).join('\n'));
const text = '# Stable palette\n\nA **formatted** paragraph.\n\n'.repeat(20);
const payload = runtime.renderPreviewDocument({ markdownText: text, sourceDocumentPath: 'C:/palette.md', uiLanguage: 'en' });
const browser = await launchTestBrowser();
let primary: unknown;
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 900, height: 760 });
  await page.setContent('<!doctype html><style>' + fs.readFileSync('webview/src/styles.css', 'utf8')
    + '</style><style>html,body{height:100%;margin:0}body{background:rgb(31,32,33)}</style><body></body>');
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  await page.evaluate(({ text, payload }) => {
    const scope = window as any, controller = scope.__previewController;
    controller.setAppearance('dark'); controller.setVisible(true);
    void controller.requestRender(text);
    const request = scope.__previewMessages.filter((message: any) => message.type === 'requestPreviewRender').at(-1);
    controller.acceptRenderResponse({ type: 'previewRenderResult', requestId: request.requestId, result: { ok: true, value: payload } });
  }, { text, payload });
  await page.waitForFunction(() => !!(window as any).__previewRenderedAt);
  const observation = await page.evaluate(() => {
    const controller = (window as any).__previewController, doc = document.querySelector('iframe')!.contentDocument!;
    controller.refreshDocumentBackground();
    const observer = new MutationObserver(() => {});
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style'], attributeOldValue: true });
    for (let index = 0; index < 3; index++) controller.refreshDocumentBackground();
    const records = observer.takeRecords(), mutations = records.length; observer.disconnect();
    const styles = mutations ? [...records.slice(0, 2).map(record => record.oldValue), doc.documentElement.style.cssText] : [];
    document.body.style.backgroundColor = 'rgb(44, 45, 46)';
    controller.refreshDocumentBackground();
    return { mutations, styles, background: doc.defaultView!.getComputedStyle(doc.body).backgroundColor };
  });
  console.log(JSON.stringify(observation));
  assert.equal(observation.mutations, 0, 'An unchanged Preview palette must not remove/reapply root styles and invalidate the entire reading tree');
  assert.equal(observation.background, 'rgb(44, 45, 46)', 'An actual carrier palette change must still reach Preview');
  await page.evaluate(() => (window as any).__previewController.dispose());
  console.log('Preview palette refresh retains unchanged root styles and applies real color changes');
} catch (error) { primary = error; throw error; }
finally { if (primary === undefined) await closeTestBrowser(browser); else await closeTestBrowser(browser, primary); }
