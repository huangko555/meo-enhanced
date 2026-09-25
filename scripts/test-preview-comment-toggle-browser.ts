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
  const visibleComments = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    return Array.from(doc.querySelectorAll<HTMLElement>('.meo-export-comment')).map(comment => {
      const style = doc.defaultView!.getComputedStyle(comment);
      return {
        text: comment.textContent,
        border: style.borderTopWidth,
        background: style.backgroundColor,
        fontStyle: style.fontStyle
      };
    });
  });
  assert.ok(visibleComments.some(comment => comment.text === '<!-- visible when enabled -->'));
  assert.ok(visibleComments.some(comment => comment.text === '<!-- nested note -->'));
  assert.ok(visibleComments.every(comment => comment.border === '0px' &&
    comment.background === 'rgba(0, 0, 0, 0)' && comment.fontStyle === 'italic'));
  const htmlCommentGap = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const paragraph = Array.from(doc.querySelectorAll<HTMLParagraphElement>('p'))
      .find(element => element.textContent === 'First paragraph')!;
    const comment = paragraph.nextElementSibling as HTMLElement;
    const following = comment.nextElementSibling as HTMLElement;
    return {
      nextIsComment: comment.classList.contains('meo-export-comment-inline'),
      before: comment.getBoundingClientRect().top - paragraph.getBoundingClientRect().bottom,
      after: following.getBoundingClientRect().top - comment.getBoundingClientRect().bottom
    };
  });
  assert.equal(htmlCommentGap.nextIsComment, true);
  const standaloneCommentGap = await page.evaluate(() => {
    const doc = document.querySelector<HTMLIFrameElement>('.preview-frame')!.contentDocument!;
    const paragraph = Array.from(doc.querySelectorAll<HTMLParagraphElement>('p'))
      .find(element => element.textContent === 'Before')!;
    const wrapper = paragraph.nextElementSibling as HTMLElement;
    const comment = wrapper.querySelector<HTMLElement>('aside.meo-export-comment')!;
    const following = wrapper.nextElementSibling as HTMLElement;
    return {
      nextIsComment: wrapper.classList.contains('meo-export-html-block') && Boolean(comment),
      before: comment.getBoundingClientRect().top - paragraph.getBoundingClientRect().bottom,
      after: following.getBoundingClientRect().top - comment.getBoundingClientRect().bottom
    };
  });
  assert.equal(standaloneCommentGap.nextIsComment, true, JSON.stringify(standaloneCommentGap));
  assert.ok(Math.abs(htmlCommentGap.before - htmlCommentGap.after) <= 2, JSON.stringify({ htmlCommentGap, standaloneCommentGap }));
  assert.ok(Math.abs(standaloneCommentGap.before - standaloneCommentGap.after) <= 2, JSON.stringify(standaloneCommentGap));
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
