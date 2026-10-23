import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { encodeMarkdownPath, formatLinkDestination, normalizeLinkDestination, isLocalFileLinkDestination, isLikelyLocalLinkDestination } from '../src/foundation/linkDestination';
import exportRuntime from '../src/export/runtime';

const markdown = new MarkdownIt();
for (const destination of ['guide.md', 'guide.markdown#title', 'guide.mdx', 'guide.mdc', '<folder/文档.md>',
  '<folder/文档 file.md>', 'notes%3Av1.md', './file.pdf', '/guide', 'C:%5Cnotes%5Cguide.md', 'file:///C:/notes/guide.md']) {
  assert.equal(isLikelyLocalLinkDestination(destination), true, destination);
}
for (const destination of ['https://example.md', 'mailto:person@example.test', 'www.example.md', 'example.com/page',
  '//example.com/page', 'localhost:3000/page', '#title', '?query', '']) {
  assert.equal(isLikelyLocalLinkDestination(destination), false, destination);
}
for (const [raw, destination] of [
  ['assets/image.png', 'assets/image.png'],
  ['设计资料/截图🖼️.png', '设计资料/截图🖼️.png'],
  ['设计 资料/截图(1)#50%&copy;.png', '设计%20资料/截图%281%29%2350%25%26copy;.png'],
  ['设计资料/字面%E8%AE%BE.png', '设计资料/字面%25E8%25AE%25BE.png'],
  ['../资料/图[1]<2>|3?4.png', '../资料/图%5B1%5D%3C2%3E%7C3%3F4.png'],
  ['目录/图\t1\n2.png', '目录/图%091%0A2.png'],
  ['C:/设计资料/截图.png', 'C:/设计资料/截图.png'],
  ['C:\\设计资料\\截图.png', 'C:%5C设计资料%5C截图.png'],
  ['资料:版本/截图.png', '资料%3A版本/截图.png'],
  ['设计资料/"引号\'与`代码`.png', '设计资料/%22引号%27与%60代码%60.png']
]) {
  assert.equal(encodeMarkdownPath(raw), destination);
  for (const source of [`![截图](${destination})`, `[文件](${destination})`]) {
    const inline = markdown.parseInline(source, {})[0]!;
    const target = inline.children?.find(child => child.type === 'image' || child.type === 'link_open');
    assert.ok(target, 'escaped filename must parse as a link/image destination');
    assert.equal(decodeURIComponent(target.attrGet(target.type === 'image' ? 'src' : 'href')!), raw,
      'Markdown parsing and one resource decode must preserve the exact filename');
  }
}

for (const [destination, display] of [
  ['设计资料/截图.png', '设计资料/截图.png'],
  ['%E8%AE%BE%E8%AE%A1%E8%B5%84%E6%96%99/%E6%88%AA%E5%9B%BE.png', '设计资料/截图.png'],
  ['设计资料/%E6%88%AA%E5%9B%BE%zz.png', '设计资料/截图%zz.png'],
  ['%E4%B8/%E4%B8%AD.png', '%E4%B8/中.png'],
  ['%FF%E4%B8%AD%E6%96%87%E4%B8.png', '%FF中文%E4%B8.png'],
  ['%ED%A0%80%E4%B8%AD.png', '%ED%A0%80中.png'],
  ['%25E4%25B8%25AD.png', '%E4%B8%AD.png'],
  ['https://example.test/%E4%B8%AD%E6%96%87?q=%23%2F#%E6%A0%87%E9%A2%98', 'https://example.test/中文?q=%23%2F#标题']
]) assert.equal(formatLinkDestination(destination), display);

for (const destination of ['D:/notes/link target.md', 'D:\\notes\\link target.md', 'D:%5Cnotes%5Clink%20target.md']) {
  for (const preset of ['default', 'github-readme', 'whitey', 'newsprint', 'obsidian-minimal'] as const) {
    const rendered = exportRuntime.renderPreviewDocument({
      markdownText: `[Local](<${destination}>)`, sourceDocumentPath: 'C:/notes/current.md', uiLanguage: 'en', preset
    });
    assert.match(rendered.html, /href="file:\/\/\/D:\/notes\/link%20target\.md"/,
      `${preset}: absolute local paths retain the same navigable destination`);
    const raw = exportRuntime.renderPreviewDocument({
      markdownText: `<a href="${destination}">Local</a>`, sourceDocumentPath: 'C:/notes/current.md', uiLanguage: 'en', preset
    });
    assert.match(raw.html, /href="file:\/\/\/D:\/notes\/link%20target\.md"/,
      `${preset}: raw HTML links normalize before their early URL filtering`);
  }
}

assert.equal(normalizeLinkDestination('<D:\\notes\\字面%25.md#标题%2F片段>'), 'file:///D:/notes/字面%25.md#标题%2F片段');
assert.equal(normalizeLinkDestination('D:%2Fnotes%2Fguide.md'), 'file:///D:/notes/guide.md');
for (const destination of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html;base64,SGVsbG8=', 'D:relative.md']) {
  assert.equal(isLocalFileLinkDestination(destination), false, 'only absolute filesystem destinations are local file links');
}
for (const preset of ['default', 'github-readme'] as const) {
  const rendered = exportRuntime.renderPreviewDocument({ markdownText: '<a href="javascript:alert(1)">unsafe</a>',
    sourceDocumentPath: 'C:/notes/current.md', uiLanguage: 'en', preset });
  assert.ok(!rendered.html.includes('href="javascript:'), 'local links must not widen executable URL schemes');
}

console.log('Markdown destination filename identity and readable display checks passed');
