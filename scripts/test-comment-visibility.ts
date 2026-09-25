import assert from 'node:assert/strict';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import exportRuntime from '../src/export/runtime';

const markdownText = [
  'Before<!-- inline <script> -->after',
  '',
  '<!-- block line one',
  'block line two -->',
  '',
  '<div>before<!-- nested note -->after</div>',
  '',
  '```html',
  '<!-- code sample -->',
  '```',
  '',
  'Unfinished <!-- comment'
].join('\n');

for (const showComments of [false, true]) {
  const preview = exportRuntime.renderPreviewDocument({
    markdownText,
    sourceDocumentPath: 'C:/tmp/comments.md',
    uiLanguage: 'en',
    styleEnvironment: { previewFontFamily: '', previewShowComments: showComments }
  }).html;
  for (const target of ['html', 'pdf', 'docx'] as const) {
    const exported = renderMarkdownToHtml({
      markdownText,
      markdownFilePath: 'C:/tmp/comments.md',
      target,
      uiLanguage: 'en',
      showComments
    }).html;
    assert.equal(exported, preview, `${target} comment visibility must match Preview`);
  }
  assert.match(preview, /&lt;!-- code sample --&gt;/, 'code examples remain visible');
  assert.match(preview, /Unfinished/, 'unfinished comments remain visible');
  if (showComments) {
    assert.match(preview, /meo-export-comment-inline/);
    assert.match(preview, /&lt;!-- block line one\nblock line two --&gt;/);
    assert.match(preview, /&lt;!-- inline &lt;script&gt; --&gt;/, 'raw comment text is escaped');
    assert.match(preview, /<div>before<span class="meo-export-comment meo-export-comment-inline"[^>]*>&lt;!-- nested note --&gt;<\/span>after<\/div>/,
      'comments inside HTML keep their original markers without escaping the containing element');
    assert.doesNotMatch(preview, /meo-export-comment-label|>Comment<|>注释</, 'no translated prefix is added');
  } else {
    assert.doesNotMatch(preview, /inline &lt;script&gt;|block line one/);
    assert.match(preview, /<div>beforeafter<\/div>/, 'comments inside HTML are removed without escaping the containing element');
    assert.match(preview, /Beforeafter/, 'hidden inline comments do not insert spaces');
  }
}

console.log('Comment visibility tests passed.');
