import assert from 'node:assert/strict';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { buildExportStyles } from '../src/export/exportStyles';

const markdown = [
  '# Intro',
  '',
  '## **Setup**',
  '',
  '#### Deep `code`',
  '',
  '## Setup'
].join('\n');

const withoutContents = renderMarkdownToHtml({
  markdownText: markdown,
  markdownFilePath: 'C:/tmp/without-contents.md',
  target: 'html',
  includeTableOfContents: false
});
assert.doesNotMatch(withoutContents.html, /meo-export-toc/);

const withContents = renderMarkdownToHtml({
  markdownText: markdown,
  markdownFilePath: 'C:/tmp/with-contents.md',
  target: 'html',
  uiLanguage: 'en',
  includeTableOfContents: true
});
assert.match(withContents.html, /^<nav class="meo-export-toc" aria-label="Contents">/);
assert.match(withContents.html, /<h2 class="meo-export-toc-title">Contents<\/h2>/);
assert.match(withContents.html, /href="#intro">Intro<\/a>/);
assert.match(withContents.html, /href="#setup">Setup<\/a>/);
assert.match(withContents.html, /href="#deep-code">Deep code<\/a>/);
assert.match(withContents.html, /href="#setup-2">Setup<\/a>/);
assert.ok(
  withContents.html.indexOf('class="meo-export-toc"') < withContents.html.indexOf('id="intro"'),
  'table of contents must precede the first heading'
);
assert.ok(
  (withContents.html.match(/class="meo-export-toc-list"/g) ?? []).length >= 3,
  'skipped heading levels must still retain a nested hierarchy'
);

const localized = renderMarkdownToHtml({
  markdownText: '---\n状态: 草稿\n---\n# 标题',
  markdownFilePath: 'C:/tmp/zh-contents.md',
  target: 'pdf',
  uiLanguage: 'zh-CN',
  includeTableOfContents: true
});
assert.match(localized.html, /aria-label="目录"/);
assert.match(localized.html, />目录<\/h2>/);
assert.match(localized.html, /href="#标题">标题<\/a>/);
assert.ok(
  localized.html.indexOf('class="meo-export-toc"') < localized.html.indexOf('class="meo-export-frontmatter"'),
  'table of contents must precede Front Matter'
);

const empty = renderMarkdownToHtml({
  markdownText: 'Paragraph only.',
  markdownFilePath: 'C:/tmp/no-headings.md',
  target: 'pdf',
  includeTableOfContents: true
});
assert.doesNotMatch(empty.html, /meo-export-toc/);

const styles = buildExportStyles({ previewFontFamily: '' }, 'light');
assert.match(
  styles,
  /body\[data-meo-export-target='pdf'\] \.meo-export-toc\s*\{[^}]*break-after:\s*page;/s,
  'PDF contents must force the document body onto a new page'
);
assert.doesNotMatch(
  styles,
  /body\[data-meo-export-target='html'\] \.meo-export-toc\s*\{[^}]*break-after:\s*page;/s,
  'HTML contents must remain in the normal document flow'
);

console.log('Export table of contents checks passed');
