import assert from 'node:assert/strict';
import { createPreviewDocument } from '../src/export/previewDocument';
import { preparePreviewDocument } from '../src/export/runtime';
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
assert.equal((full.match(/class="meo-export-code-line"/g) ?? []).length, 18000);
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
