import assert from 'node:assert/strict';
import { parseDocument, DomUtils } from 'htmlparser2';
import { preparePreviewDocument } from '../src/export/runtime';
import { createPreviewDocument } from '../src/export/previewDocument';
import MarkdownIt from 'markdown-it';
import { createPreviewTableColumnPreferences } from '../webview/src/helpers/previewTableColumns';

const rows = 1600;
const text = '# Before\n\n| Name | Value |\n| --- | --- |\n'
  + Array.from({ length: rows }, (_, row) => `| ROW-${row} | **Value** ${row % 73 === 0 ? 'long content '.repeat(12) : row}<br>next |`).join('\n')
  + '\n\nAfter table.\n';
const options = { markdownText: text, sourceDocumentPath: 'C:/fixture/table.md', uiLanguage: 'en' as const };
const prepared = preparePreviewDocument(options, true);
const tableBlocks = prepared.blocks.filter(block => block.kind === 'table_open');
assert.ok(tableBlocks.length >= 25, `A giant table must expose bounded reading bands, got ${tableBlocks.length}`);
for (const block of [...tableBlocks].reverse()) prepared.renderBlock(block.index);
let mountedRows = 0;
for (const block of tableBlocks) {
  const html = prepared.renderBlock(block.index).html;
  const root = parseDocument(html);
  const count = DomUtils.findAll(element => element.name === 'tr', root.children).length;
  assert.ok(count > 0 && count <= 33, `One requested band must not materialize the complete table (${count} rows)`);
  mountedRows += count;
  assert.ok(block.sourceEndLine - block.sourceLine < 35, 'Source geometry follows the rows in this band');
}
assert.equal(mountedRows, rows + 1, 'The authored header and all body rows occur exactly once');
assert.equal(prepared.renderAll().html, preparePreviewDocument(options).renderAll().html,
  'Standalone rendering and exports retain one complete original table');
const document = createPreviewDocument('table-bands', options);
try {
  const opened = document.open(805);
  const owner = opened.document.blocks.find(block => block.sourceLine <= 805 && block.sourceEndLine >= 805)!;
  assert.ok(owner && owner.kind === 'table_open');
  assert.equal((await document.run({ kind: 'locate', sourceLine: 805 }) as any).block, owner.index);
  const search = await document.run({ kind: 'search', query: 'ROW-1599', caseSensitive: true, wholeWord: false, selectIndex: 0 });
  assert.ok(search.kind === 'search' && search.total === 1 && search.active?.line === 1604,
    `Searching must retain offscreen rows and exact source lines: ${JSON.stringify(search)}`);
  const copied = await document.run({ kind: 'copy', from: { block: tableBlocks[0]!.index, offset: 0 },
    to: { block: tableBlocks.at(-1)!.index, offset: Number.MAX_SAFE_INTEGER } });
  assert.ok(copied.kind === 'copy' && copied.text.includes('ROW-0') && copied.text.includes('ROW-1599'));
  assert.equal((copied.html.match(/ROW-\d+/g) ?? []).length, rows, 'Logical copy includes each unmounted row exactly once');
  assert.equal((copied.html.match(/<table\b/g) ?? []).length, 1, 'Copy joins internal reading bands back into one table');
} finally { document.dispose(); }

for (const value of ['1. first<br>2. second', '> quote<br>next', '<span>**rich**</span> and <kbd>key</kbd>',
  '$x^2$ and [link][ref]', '![pixel](data:image/svg+xml;base64,PHN2Zy8+) and note[^n]', '`escaped\\|pipe` and ==highlight==']) {
  const markdownText = '| Name | Value |\n| --- | --- |\n' + Array.from({ length: 512 }, (_, row) => `| ${row} | ${value} |`).join('\n')
    + '\n\n[ref]: https://example.test/\n[^n]: **Footnote**\n';
  const options = { markdownText, sourceDocumentPath: 'C:/fixture/rich-table.md', uiLanguage: 'en' as const };
  const lazy = preparePreviewDocument(options, true), eager = preparePreviewDocument(options);
  const bands = lazy.blocks.filter(block => block.kind === 'table_open');
  const rows = bands.flatMap(block => DomUtils.findAll(element => element.name === 'tr', parseDocument(lazy.renderBlock(block.index).html).children))
    .map(row => DomUtils.getOuterHTML(row));
  const complete = eager.renderAll().html;
  assert.deepEqual(rows, DomUtils.findAll(element => element.name === 'tr', parseDocument(complete).children).map(row => DomUtils.getOuterHTML(row)),
    `Every rich row preserves the original renderer's exact output: ${value}`);
  assert.equal(lazy.renderAll().html, complete);
}
for (const prefix of ['<details open>\n<summary>Container</summary>\n\n', '<div>\n\n', '> ']) {
  const markdownText = prefix.startsWith('>') ? text.split('\n').map(line => '> ' + line).join('\n') : prefix + text + '\n</div>\n</details>\n';
  const guarded = preparePreviewDocument({ ...options, markdownText }, true);
  assert.ok(guarded.blocks.filter(block => block.kind === 'table_open').length <= 1, 'HTML and nested containers must keep their complete semantics');
}
const nested = preparePreviewDocument({ ...options, markdownText: text.replace('ROW-0', '<table><tr><td>Nested</td></tr></table>') }, true);
assert.equal(nested.blocks.filter(block => block.kind === 'table_open').length, 1, 'Inline nested HTML tables retain one complete outer table');
const crossing = preparePreviewDocument({ ...options,
  markdownText: text.replace('ROW-0', '<span>ROW-0').replace('ROW-1 |', 'ROW-1</span> |') }, true);
assert.equal(crossing.blocks.filter(block => block.kind === 'table_open').length, 1,
  'Raw inline containers crossing authored rows retain one complete table');
// Asking for a reading band must not prepare the other 1568 rows' inline trees.
const prototype = Object.getPrototypeOf(new MarkdownIt().inline), parse = prototype.parse;
let parsed = 0;
prototype.parse = function (...args: any[]) { parsed++; return parse.apply(this, args); };
try {
  const pending = preparePreviewDocument(options, true), before = parsed;
  const middle = pending.blocks.filter(block => block.kind === 'table_open')[20]!;
  pending.renderBlock(middle.index);
  assert.ok(parsed - before <= 70, `A 32-row band must bound inline parsing too, got ${parsed - before}`);
} finally { prototype.parse = parse; }
{
  const preferences = createPreviewTableColumnPreferences();
  const table = (line: number, widths: string) => ({ dataset: { meoPreviewTableOrigin: String(line), meoPreviewTableWidths: widths } }) as HTMLTableElement;
  assert.deepEqual(preferences.read(table(3, '8,100'), 2), [8, 100]);
  preferences.revise('Before\n\n| A | B |\n|---|---|\nold', 'Before\n\n| A | B |\n|---|---|\nvery long edited value');
  assert.deepEqual(preferences.read(table(3, '80,100'), 2), [8, 100], 'Content edits retain accepted columns');
  preferences.revise('Before\n\n| A | B |', 'Prefix\n\nBefore\n\n| A | B |');
  assert.deepEqual(preferences.read(table(5, '80,100'), 2), [8, 100], 'Source-prefix edits map the original table identity');
  assert.deepEqual(preferences.read(table(5, '1,2,3'), 3), [1, 2, 3], 'A changed column schema accepts fresh preferences');
  preferences.revise(null, 'Replacement');
  assert.deepEqual(preferences.read(table(5, '4,5,6'), 3), [4, 5, 6]);
}
console.log(`Preview table bands: ${rows} authored rows, ${tableBlocks.length} bounded blocks; complete export/search/copy and source identities`);
