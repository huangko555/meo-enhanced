import assert from 'node:assert/strict';
import { createPreviewDocument } from '../src/export/previewDocument';
import { preparePreviewDocument } from '../src/export/runtime';
import { renderMarkdownToHtml } from '../src/export/renderMarkdown';
import { decodePreviewDocumentManifest } from '../src/protocol/previewDocument';
import { DomUtils, parseDocument } from 'htmlparser2';

const source = Array.from({ length: 18000 }, (_, index) => `const row${index} = { text: "hello", number: 123 };`).join('\n');
const options = { markdownText: '```javascript\n' + source + '\n```', sourceDocumentPath: 'C:/code-bands.md', uiLanguage: 'en' as const };
const document = createPreviewDocument('code-bands', options);
const manifest = document.open(9002).document;
assert.ok(manifest.blocks.length > 500, 'A giant code fence must expose bounded reading bands');
assert.ok(manifest.chunks.every(chunk => (chunk.html.match(/class="meo-export-code-line"/g) ?? []).length <= 32));
assert.ok(decodePreviewDocumentManifest(manifest));
assert.equal(decodePreviewDocumentManifest({ ...manifest, codeSources: [{ id: 'x', language: 'js', source: 5 }] }), null);
assert.equal(decodePreviewDocumentManifest({ ...manifest, codeSources: [manifest.codeSources![0], manifest.codeSources![0]] }), null);
const search = await document.run({ kind: 'search', query: 'row9000', caseSensitive: true, wholeWord: false, selectIndex: 0 });
assert.equal(search.kind === 'search' && search.active?.line, 9002);
const copy = await document.run({ kind: 'copy', from: { block: 0, offset: 0 }, to: { block: manifest.blocks.length - 1, offset: Number.MAX_SAFE_INTEGER } });
assert.equal(copy.kind, 'copy');
if (copy.kind === 'copy') {
  assert.equal((copy.html.match(/class="meo-export-code-block-wrap"/g) ?? []).length, 1);
  assert.ok(copy.html.includes('row0') && copy.html.includes('row17999'));
  const code = DomUtils.findOne(node => node.name === 'code', parseDocument(copy.html).children)!;
  assert.equal(DomUtils.textContent(code), source + '\n');
}
const full = preparePreviewDocument(options, true).renderAll().html;
assert.equal((full.match(/class="meo-export-code-block-wrap"/g) ?? []).length, 1);
assert.equal((full.match(/class="meo-export-code-line meo-export-code-line-source meo-preview-code-line"/g) ?? []).length, 18000);
const accessible = preparePreviewDocument(options).renderAll().html;
assert.equal((accessible.match(/data-line-number=/g) ?? []).length, 18000);
assert.ok(!accessible.includes('hljs-number'), 'Complete interactive Preview must defer large-fence token DOM too');
const standalone = renderMarkdownToHtml({ markdownText: options.markdownText, markdownFilePath: options.sourceDocumentPath, target: 'html' }).html;
assert.equal((standalone.match(/class="meo-export-code-line"/g) ?? []).length, 18000);
assert.ok(standalone.includes('hljs-number'), 'Standalone exports retain their complete syntax tree');
assert.ok(!standalone.includes('meo-preview-code-line'));
for (const language of ['', 'unsupported-code-language']) {
  const plain = preparePreviewDocument({ ...options, markdownText: '```' + language + '\n' + source + '\n```' }).renderAll().html;
  assert.equal((plain.match(/class="meo-export-code-line meo-export-code-line-source meo-preview-code-line"/g) ?? []).length, 18000,
    'Plain and unknown-language code also avoid decorative row DOM in full Preview');
}
for (const closed of [true, false]) {
  const prepared = preparePreviewDocument({ ...options, markdownText: '```javascript\n' + source + (closed ? '\n```' : '') }, true);
  const first = prepared.renderBlock(0).html, middle = prepared.renderBlock(1).html;
  const last = prepared.renderBlock(prepared.blocks.length - 1).html;
  assert.ok(first.includes('data-meo-code-fence-start="true"'));
  assert.ok(!first.includes('data-meo-code-fence-end') && !middle.includes('data-meo-code-fence-start') && !middle.includes('data-meo-code-fence-end'));
  assert.equal(last.includes('data-meo-code-fence-end="true"'), closed, 'Only the last band of a closed fence owns its end boundary');
  assert.ok(!last.includes('data-meo-code-fence-start'));
}
for (const [label, markdownText] of [
  ['ordinary fence', '```javascript\n' + source.split('\n').slice(0, 100).join('\n') + '\n```'],
  ['nested fence', ('```javascript\n' + source + '\n```').split('\n').map(line => '> ' + line).join('\n')],
  ['unknown grammar', '```unsupported-code-language\n' + source + '\n```'],
  ['diagram', '```mermaid\n' + source + '\n```']
]) {
  const prepared = preparePreviewDocument({ ...options, markdownText: markdownText! }, true);
  assert.ok(prepared.blocks.every(block => block.kind !== 'code_band'), `${label} retains its complete semantics`);
}
const github = preparePreviewDocument({ ...options, preset: 'github-readme' }, true);
assert.ok(github.blocks.every(block => block.kind !== 'code_band'));
document.dispose();
console.log('Preview giant code bands, source search, logical copy and complete rendering passed');
