import assert from 'node:assert/strict';
import { discoverDocumentOperations } from './uat-document-operations';

const document = [
  '# Arbitrary document', '',
  ...Array.from({ length: 24 }, (_, i) => `Paragraph unique ${i}.\n`),
  '```typescript', 'const independentCode = 1;', '```', '',
  '```mermaid', 'flowchart LR', '  Begin --> Finish', '```', '',
  '$$', '\\frac{numerator}{denominator}', '$$', '',
  '| Name | Value |', '| --- | --- |', '| probe | ready |', '',
  '<div>Editable HTML content</div>', '',
  '- Unique list item', '',
  '```latex', '\\fencedFormula', '```', '',
  '~~~mermaid', 'unsupportedShell', '~~~', '',
  'Repeated paragraph', '', 'Repeated paragraph'
].join('\n');
const result = discoverDocumentOperations(document);
assert.deepEqual(discoverDocumentOperations(document), result, 'Selection must be deterministic');
assert.deepEqual(new Set(result.operations.map(operation => operation.kind)), new Set(['outer', 'html', 'table', 'mermaid', 'math']));
assert.equal(result.coverage.text?.selected, 8);
assert.ok(result.operations.some(operation => operation.needle === 'Paragraph unique 0.'));
assert.ok(result.operations.some(operation => operation.needle === 'Paragraph unique 23.'));
assert.equal(result.operations.find(operation => operation.kind === 'table')?.tableCell, 'ready');
assert.equal(discoverDocumentOperations('| Label | Target |\n| --- | --- |\n| Link | [example](https://example.com) |').operations[0]?.tableCell, 'Link');
for (const target of ['https://example.com', 'test@example.com']) {
  assert.equal(discoverDocumentOperations(`| Label | Target |\n| --- | --- |\n| Link | ${target} |`).operations[0]?.tableCell, 'Link');
}
const duplicateRows = discoverDocumentOperations('| A | B |\n| --- | --- |\n| same | values |\n\n| C | D |\n| --- | --- |\n| same  | values  |\n\nOrdinary unique target');
assert.ok(!duplicateRows.operations.some(operation => operation.kind === 'table'));
assert.ok(duplicateRows.unavailable.some(item => item.reason === 'duplicate rendered row values'));
assert.ok(result.operations.every(operation => document.indexOf(operation.needle) === document.lastIndexOf(operation.needle)));
assert.equal(new Set(result.operations.map(operation => operation.marker)).size, result.operations.length);
assert.ok(result.unavailable.some(item => item.category === 'mermaid-shell'));
assert.ok(result.operations.some(operation => operation.kind === 'outer' && operation.needle === '\\fencedFormula'));
assert.ok(!result.operations.some(operation => operation.needle.includes('unsupportedShell')));

const literal = discoverDocumentOperations([
  '```text', '$$', 'literalOnly', '$$', '| A | B |', '| --- | --- |', '| X | Y |', '```', '', 'Ordinary target'
].join('\n'));
assert.ok(literal.operations.every(operation => operation.kind === 'outer'), 'Literal fences cannot create embedded targets');
for (const [category, fragment] of [
  ['html', '<div>\nUnique HTML body\n</div>'],
  ['math', '$$\nrepeat\nrepeat\n$$'],
  ['mermaid', '```mermaid\nrepeat\nrepeat\n```'],
  ['code', '```latex\nrepeat\nrepeat\n```'],
  ['code', '```text\nrepeat\nrepeat\n```'],
  ['table', '| A | B |\n| --- | --- |\n| escaped\\|pipe | value |'],
  ['text', 'Inline <span>markup</span> target']
] as const) {
  const discovered = discoverDocumentOperations(`${fragment}\n\nOrdinary unique target`);
  assert.ok(discovered.unavailable.some(item => item.category === category && item.reason), `${category} omissions must be reported`);
}
assert.throws(() => discoverDocumentOperations(''), /No uniquely addressable/);
assert.throws(() => discoverDocumentOperations('unique __UAT_1__'), /already contains endurance marker/);
console.log('Adaptive endurance operation discovery passed');
