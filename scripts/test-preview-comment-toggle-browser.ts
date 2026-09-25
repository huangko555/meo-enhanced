import assert from 'node:assert/strict';
import { launchTestBrowser } from './browser-test-helpers';
import exportRuntime from '../src/export/runtime';

const build = await Bun.build({
  entrypoints: ['scripts/test-preview-reading-surface-production-entry.ts'],
  target: 'browser', format: 'iife'
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));

const browser = await launchTestBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 700 });
  await page.setContent('<!doctype html><style>html,body,#app{height:100%;margin:0}</style><div id="app"></div>');
  await page.addStyleTag({ path: 'webview/src/styles.css' });
  await page.exposeFunction('__renderPreview', (message: any) => {
    if (message.type !== 'requestPreviewRender') return null;
    return {
      type: 'previewRenderResult',
      requestId: message.requestId,
      result: { ok: true, value: exportRuntime.renderPreviewDocument({
        markdownText: message.text,
        sourceDocumentPath: 'C:/tmp/preview-comment-toggle.md',
        uiLanguage: message.uiLanguage,
        styleEnvironment: message.environment
      }) }
    };
  });
  await page.addScriptTag({ content: `window.acquireVsCodeApi=()=>({getState(){},setState(){},postMessage(message){window.__renderPreview(message).then(response=>{if(response)window.dispatchEvent(new MessageEvent('message',{data:response}));});}});` });
  await page.addScriptTag({ content: await build.outputs[0]!.text() });
  const waitFor = async (label: string, predicate: () => unknown) => {
    try {
      await page.waitForFunction(predicate, { timeout: 5000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        mode: document.querySelector<HTMLElement>('.editor-root')?.dataset.mode,
        button: document.querySelector('.preview-show-comments')?.outerHTML,
        frameText: document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body?.textContent?.slice(0, 300),
        status: document.querySelector('.preview-status')?.textContent
      }));
      throw new Error(`${label}: ${JSON.stringify(state)}`, { cause: error });
    }
  };
  const text = 'Before\n\n<!-- visible when enabled -->\n\nAfter\n\n<div>\n<p>First paragraph</p>\n<!-- nested note -->\n<p>Second paragraph</p>\n</div>';
  await page.evaluate(text => window.dispatchEvent(new MessageEvent('message', { data: {
    type: 'init', documentId: 'file:///preview-comment-toggle.md', text, version: 1,
    savedRevision: { version: 1, text }, diagnostics: [], mode: 'preview', uiLanguage: 'en',
    sourceLineNumbers: 'on', previewAppearance: 'light', previewFontFamily: '', previewSourceColoring: true,
    previewShowComments: false,
    editorAppearance: 'dark', gitChangesGutter: false, gitDiffLineHighlights: false, gitDiffDetailsVisible: false,
    diffBaselineMode: 'current-edit', fixedBaselinePinned: false, fixedBaselineActive: false,
    contentMaxWidthEnabled: false, findOptions: { wholeWord: false, caseSensitive: false },
    outlinePosition: 'right', outlineVisible: false, outlineWidth: 260, vscodeTheme: null
  } })), text);
  await waitFor('preview mode', () => document.querySelector<HTMLElement>('.editor-root')?.dataset.mode === 'preview');
  await waitFor('initial render', () => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body?.textContent?.includes('After'));
  assert.equal(await page.$eval('.preview-show-comments', element => element.getAttribute('aria-pressed')), 'false');
  await page.click('.preview-show-comments');
  await waitFor('comment render', () => document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body?.textContent?.includes('visible when enabled'));
  assert.equal(await page.$eval('.preview-show-comments', element => element.getAttribute('aria-pressed')), 'true');
  const htmlCommentGap = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const paragraph = Array.from(doc.querySelectorAll<HTMLParagraphElement>('p'))
      .find(element => element.textContent === 'First paragraph')!;
    const next = paragraph.nextElementSibling;
    const style = doc.defaultView!.getComputedStyle(paragraph);
    return {
      nextIsComment: next?.classList.contains('meo-export-comment-inline'),
      ratio: parseFloat(style.marginBottom) / parseFloat(style.fontSize)
    };
  });
  assert.equal(htmlCommentGap.nextIsComment, true);
  assert.ok(Math.abs(htmlCommentGap.ratio - 0.4) < 0.01);
  await page.click('.preview-show-comments');
  await waitFor('comment hidden again', () => {
    const text = document.querySelector<HTMLIFrameElement>('.preview-frame')?.contentDocument?.body?.textContent;
    return text?.includes('After') && !text.includes('visible when enabled');
  });
  assert.equal(await page.$eval('.preview-show-comments', element => element.getAttribute('aria-pressed')), 'false');
  await page.close();
  console.log('Preview comment toggle browser test passed.');
} finally {
  await browser.close();
}
