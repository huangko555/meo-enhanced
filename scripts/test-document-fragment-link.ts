import assert from 'node:assert/strict';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { findDocumentFragmentPosition, getLinkHrefAtSourcePosition, hrefFromSourceLinkNode } from '../webview/src/helpers/linkNavigation';
import { withMarkdownSyntaxSnapshot } from '../webview/src/helpers/markdownSyntax';

const documentText = [
  '# 表格宽度测试',
  '',
  '# 重复标题',
  '',
  '# 重复标题',
  '',
  '# Foo',
  '',
  '# Foo-1',
  '',
  '# Foo',
  '',
  '# [VS Code](https://code.visualstudio.com/)',
  '',
  '# **Bold** and `code`',
  '',
  '# [Reference][target]',
  '',
  '[target]: https://example.com',
].join('\n');
const state = EditorState.create({
  doc: documentText,
  extensions: [markdown()],
});

const cases = [
  ['#表格宽度测试', 0],
  ['#%E8%A1%A8%E6%A0%BC%E5%AE%BD%E5%BA%A6%E6%B5%8B%E8%AF%95', 0],
  ['#重复标题', documentText.indexOf('# 重复标题')],
  ['#重复标题-1', documentText.lastIndexOf('# 重复标题')],
  ['#foo-2', documentText.lastIndexOf('# Foo')],
  ['#vs-code', documentText.indexOf('# [VS Code]')],
  ['#bold-and-code', documentText.indexOf('# **Bold**')],
  ['#reference', documentText.indexOf('# [Reference]')],
] as const;

for (const [href, expected] of cases) {
  const actual = findDocumentFragmentPosition(state, href);
  if (actual !== expected) {
    throw new Error(`Fragment ${href} resolved to ${actual}; expected ${expected}`);
  }
}

const referenceText = '[Known][target]\n\n[target]: https://example.com/reference';
const referenceState = EditorState.create({ doc: referenceText, extensions: [markdown()] });
const partial = markdownLanguage.parser.parse('[Known][target]');
const complete = markdownLanguage.parser.parse(referenceText);
const link = partial.topNode.firstChild!.firstChild!;
assert.equal(withMarkdownSyntaxSnapshot(referenceState, partial, () => hrefFromSourceLinkNode(referenceState, link)), '');
assert.equal(withMarkdownSyntaxSnapshot(referenceState, complete, () => hrefFromSourceLinkNode(referenceState, link)),
  'https://example.com/reference', 'a later syntax publication must invalidate the same-document reference cache');

const punctuationUrl = 'https://example.com/a!';
for (const [doc, token, expected] of [
  ['[Read](' + punctuationUrl + ')', 'Read', punctuationUrl],
  ['[Read][target]\n\n[target]: ' + punctuationUrl, 'Read', punctuationUrl],
  ['<' + punctuationUrl + '>', 'https', punctuationUrl],
  ['Read ' + punctuationUrl, 'https', 'https://example.com/a']
]) {
  const linkState = EditorState.create({ doc, extensions: [markdown()] });
  assert.equal(getLinkHrefAtSourcePosition(linkState, doc.indexOf(token) + 1), expected, doc);
}
console.log('document fragment link checks passed');
