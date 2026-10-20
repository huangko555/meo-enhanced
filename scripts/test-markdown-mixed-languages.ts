import assert from 'node:assert/strict';
import { EditorState } from '@codemirror/state';
import { Language, ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { html } from '@codemirror/lang-html';
import type { MarkdownParser } from '@lezer/markdown';
import { highlightTree } from '@lezer/highlight';
import type { Tree } from '@lezer/common';
import { editorMarkdownLanguage } from '../webview/src/liveMode';
import { inlineMarkdownExtensions } from '../webview/src/helpers/inlineMarkdownParser';
import { resolveCodeLanguage } from '../webview/src/helpers/codeBlocks';
import { sourceHighlightStyle, sourceMarkdownHighlightProps } from '../webview/src/theme';

const outer = (markdownLanguage.parser as MarkdownParser).configure([
  ...inlineMarkdownExtensions, { props: [sourceMarkdownHighlightProps] }, { remove: ['Emoji'] }
]);
const referenceLanguage = markdown({ base: new Language(markdownLanguage.data, outer), addKeymap: false,
  codeLanguages: resolveCodeLanguage, htmlTagLanguage: html({ matchClosingTags: false }) });
const cases = [
  '```javascript title="sample"\nconst value = "😀"; // comment\n```',
  '> ```javascript\n> const value = 1;\n>\n> const other = "x";\n> ```',
  '- item\n\n  ```typescript\n  interface Value { key: string }\n  ```',
  '~~~python\ndef value():\n    return "text"\n~~~',
  '```json\n{"key": true, "value": 42}\n```',
  '```css\n.sample { color: red; }\n```',
  '```html\n<div title="x"><script>const a = 1;</script></div>\n```',
  '```markdown\n# Nested **heading**\n```',
  '<section class="x">\n  <strong>HTML</strong>\n</section>',
  '> <section>\n> <em>nested</em>\n> </section>',
  '- <section>\n  <em>nested</em>\n  </section>',
  '<style>body { color: red; }</style>\n\n<script>const value = "a";</script>',
  'A <kbd>Ctrl</kbd> key, <span style="color:red">inline HTML</span>, and `literal`.',
  '<!-- Comment\ncontinued -->',
  '> <!-- Comment\n> continued -->',
  '```unknown\nliteral content **not emphasis**\n```',
  '    const indented = "literal";',
  'Paragraph[^note].\n\n[^note]: ```javascript\n    const nested = 1;\n    ```'
];
const spans = (tree: Tree) => {
  const result: unknown[] = [];
  highlightTree(tree, sourceHighlightStyle, (from, to, classes) => result.push([from, to, classes]));
  return result;
};
for (const [index, doc] of cases.entries()) {
  const referenceState = EditorState.create({ doc, extensions: referenceLanguage });
  const actualState = EditorState.create({ doc, extensions: editorMarkdownLanguage });
  const reference = ensureSyntaxTree(referenceState, doc.length, 10_000)!;
  const actual = ensureSyntaxTree(actualState, doc.length, 10_000)!;
  assert.equal(actual.toString(), reference.toString(), `outer syntax ${index}`);
  assert.deepEqual(spans(actual), spans(reference), `full mixed-language palette and source coordinates ${index}`);
  for (let position = 0; position < doc.length; position += 3) {
    const path = (tree: Tree) => {
      const result: unknown[] = [];
      for (let node = tree.resolveInner(position); node; node = node.parent!) result.push([node.name, node.from, node.to]);
      return result;
    };
    assert.deepEqual(path(actual), path(reference), `nested language path ${index}:${position}`);
  }
}
console.log(`Mixed languages: ${cases.length} exact official-parser comparisons, including containers, overlays, HTML/script/style, aliases and source coordinates passed`);
