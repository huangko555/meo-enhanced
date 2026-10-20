import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { preparePreviewDocument } from '../src/export/runtime';

const inline = new MarkdownIt().inline, prototype = Object.getPrototypeOf(inline), parse = prototype.parse;
let calls = 0;
prototype.parse = function(...args: any[]) { calls++; return parse.apply(this, args); };
let initial = 0, firstTable = 0;
try {
  const text = '# Heading\n\n' + '| A | B |\n| --- | --- |\n| first<br>second | third<BR />fourth |\n\n'.repeat(200);
  const options = { markdownText: text, sourceDocumentPath: '/fixture/inline.md', uiLanguage: 'en' as const };
  const prepared = preparePreviewDocument(options, true);
  initial = calls;
  assert.ok(initial <= 2, `void inline breaks must not eagerly prepare 200 offscreen tables (${initial} inline parses)`);
  const heading = prepared.renderBlock(0), table = prepared.renderBlock(1);
  firstTable = calls - initial;
  assert.ok(heading.html.includes('<h1') && table.html.includes('<table'));
  assert.ok(firstTable > 0 && firstTable < 12, 'requesting one table prepares only its inline group');
  assert.equal(prepared.renderAll().html, preparePreviewDocument(options, false).renderAll().html,
    'lazy table preparation retains the complete eager renderer output and attribute order');
} finally { prototype.parse = parse; }

let comparisons = 0;
for (const preset of ['default', 'github-readme'] as const) {
  for (const before of ['', '<span>\n\n', '<a href="https://example.test">\n\n', '<div>\n\n', '<details>\n\n<summary>Title</summary>\n\n', '<!-- comment -->\n\n']) {
    for (const content of ['plain<br>next', 'plain<BR />next', '`<br>` and **strong**', '\\<br>literal',
      'first<br title="x">next', '<br/>', 'one<br>two<br>three', '<b>first<br>next</b>',
      '[link](https://example.test/) <br> *emphasis*', 'one<br>\n\nsecond', '<!-- <br> -->', 'one</br>two']) {
      const text = `${before}# Heading **strong**\n\n| A | B |\n| --- | --- |\n| ${content} | second |\n\n${content}\n\n</span>\n</a>\n</div>\n</details>\n\nAfter.`;
      const options = { markdownText: text, sourceDocumentPath: '/fixture/inline.md', uiLanguage: 'en' as const, preset };
      const eager = preparePreviewDocument(options, false), lazy = preparePreviewDocument(options, true);
      assert.deepEqual(lazy.blocks, eager.blocks, 'void breaks cannot change cross-root HTML container partitioning');
      assert.deepEqual(lazy.headings, eager.headings);
      assert.equal(lazy.renderAll().html, eager.renderAll().html, `exact inline parity: ${preset}/${JSON.stringify(before)}/${content}`);
      comparisons++;
    }
  }
}
console.log(`Deferred inline: ${initial} initial parses for 200 tables, ${firstTable} for the requested table; ${comparisons} complete HTML/heading/partition comparisons passed`);
