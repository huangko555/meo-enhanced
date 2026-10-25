import assert from 'node:assert/strict';
import { DomUtils, parseDocument } from 'htmlparser2';
import { createPreviewDocument } from '../src/export/previewDocument';
import { preparePreviewDocument } from '../src/export/runtime';

for (const kind of ['ul', 'ol', 'blockquote']) {
  const markdownText = Array.from({ length: 600 }, (_, index) => kind === 'blockquote' ? `> Paragraph ${index} **text**\n>`
    : `${kind === 'ol' ? `${index + 7}.` : '-'} Item ${index} **text**${index % 20 ? '' : `\n\n${kind === 'ol' ? '      ' : '  '}nested paragraph`}`).join('\n');
  const options = { markdownText, sourceDocumentPath: 'C:/container.md', uiLanguage: 'en' as const };
  const document = createPreviewDocument(kind, options), manifest = document.open(1).document;
  assert.ok(manifest.blocks.length >= 18, `${kind} must expose bounded child bands`);
  for (const chunk of manifest.chunks) {
    const root = DomUtils.findOne(node => node.name === kind, parseDocument(chunk.html).children)!;
    assert.ok(root.children.filter(node => node.type === 'tag' && node.name === (kind === 'blockquote' ? 'p' : 'li')).length <= 32);
  }
  const copy = await document.run({ kind: 'copy', from: { block: 0, offset: 0 }, to: { block: manifest.blocks.length - 1, offset: Number.MAX_SAFE_INTEGER } });
  assert.equal(copy.kind, 'copy');
  if (copy.kind === 'copy') {
    const copied = parseDocument(copy.html), full = parseDocument(preparePreviewDocument(options, true).renderAll().html);
    assert.equal(DomUtils.textContent(copied), DomUtils.textContent(full));
    assert.equal(DomUtils.findAll(node => node.name === kind, copied.children).length, 1);
    if (kind === 'ol') assert.equal(DomUtils.findOne(node => node.name === 'ol', copied.children)?.attribs.start, '7');
  }
  const search = await document.run({ kind: 'search', query: `${kind === 'blockquote' ? 'Paragraph' : 'Item'} 599`, caseSensitive: true, wholeWord: false, selectIndex: 0 });
  assert.ok(search.kind === 'search' && search.active && search.active.block > 10);
  document.dispose();
}
const taskSource = Array.from({ length: 600 }, (_, index) => `- [${index % 2 ? 'x' : ' '}] Task ${index}\n  - Nested child ${index}`).join('\n');
const taskOptions = { markdownText: taskSource, sourceDocumentPath: 'C:/tasks.md', uiLanguage: 'en' as const };
const tasks = preparePreviewDocument(taskOptions, true);
const taskBands = tasks.blocks.map(block => tasks.renderBlock(block.index).html).join('');
const taskFull = tasks.renderAll().html;
for (const className of ['meo-export-task-item', 'meo-export-task-checkbox']) {
  assert.equal(taskBands.split(className).length, taskFull.split(className).length, `${className} survives list bands`);
}
for (const markdownText of ['<div>\n\n' + taskSource + '\n\n</div>', '> [!NOTE]\n>\n' + Array.from({ length: 300 }, () => '> Paragraph\n>').join('\n')]) {
  const prepared = preparePreviewDocument({ ...taskOptions, markdownText }, true);
  assert.ok(prepared.blocks.every(block => !block.kind.endsWith('_band')), 'Raw containers and alerts retain complete semantics');
}
console.log('Preview list/quote bands preserve complete children, numbering, search and logical copy');
