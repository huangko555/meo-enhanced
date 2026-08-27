import assert from 'node:assert/strict';
import {
  assessLargeDocument,
  selectInitialEditorMode
} from '../src/application/largeDocumentPolicy';
import { createLargeDocumentFixtures } from './large-document-fixtures';

const fixtures = new Map(createLargeDocumentFixtures().map((fixture) => [fixture.kind, fixture]));
const ordinary = assessLargeDocument(fixtures.get('ordinary')!.text);
const bytesHeavy = assessLargeDocument(fixtures.get('bytes-heavy')!.text);
const linesHeavy = assessLargeDocument(fixtures.get('lines-heavy')!.text);
const richHeavy = assessLargeDocument(fixtures.get('rich-heavy')!.text);
const composite = assessLargeDocument(fixtures.get('composite')!.text);

assert.deepEqual(assessLargeDocument('').dimensions, {
  bytes: 0,
  lines: 1,
  tables: 0,
  mermaid: 0,
  images: 0,
  math: 0,
  richBlocks: 0
});
assert.equal(assessLargeDocument('你好').dimensions.bytes, 6, 'byte pressure must use UTF-8');
assert.equal(ordinary.preferSource, false, 'ordinary documents must retain the Live default');
assert.equal(bytesHeavy.preferSource, true, 'byte pressure must independently select Source');
assert.equal(linesHeavy.preferSource, true, 'line pressure must independently select Source');
assert.equal(richHeavy.preferSource, true, 'rich-block pressure must independently select Source');
assert.equal(composite.preferSource, true, 'combined pressure must select Source');

const combinedSubthresholdText = [
  ...Array.from({ length: 3_900 }, (_, index) => `line-${index} ${'x'.repeat(28)}`),
  ...Array.from({ length: 80 }, (_, index) => [
    `| composite-${index} | value |`,
    '| --- | --- |',
    `| item | ${index} |`,
    ''
  ]).flat()
].join('\n');
const combinedSubthreshold = assessLargeDocument(combinedSubthresholdText);
const isolatedBytes = assessLargeDocument('x'.repeat(combinedSubthreshold.dimensions.bytes));
const isolatedLines = assessLargeDocument('\n'.repeat(combinedSubthreshold.dimensions.lines - 1));
const isolatedRich = assessLargeDocument(Array.from(
  { length: combinedSubthreshold.dimensions.richBlocks },
  (_, index) => `| rich-${index} | value |\n| --- | --- |\n| item | ${index} |`
).join('\n\n'));
assert.ok(combinedSubthreshold.dimensions.bytes < bytesHeavy.dimensions.bytes);
assert.ok(combinedSubthreshold.dimensions.lines < linesHeavy.dimensions.lines);
assert.ok(combinedSubthreshold.dimensions.richBlocks < richHeavy.dimensions.richBlocks);
assert.equal(isolatedBytes.preferSource, false, 'the combined byte contribution must be subthreshold alone');
assert.equal(isolatedLines.preferSource, false, 'the combined line contribution must be subthreshold alone');
assert.equal(isolatedRich.preferSource, false, 'the combined rich-block contribution must be subthreshold alone');
assert.equal(
  combinedSubthreshold.preferSource,
  true,
  'individually subthreshold dimensions must combine into one pressure decision'
);

assert.equal(selectInitialEditorMode({
  text: fixtures.get('ordinary')!.text,
  persistedMode: null,
  documentMode: null,
  optimizationEnabled: true
}), 'live');
assert.equal(selectInitialEditorMode({
  text: fixtures.get('composite')!.text,
  persistedMode: null,
  documentMode: null,
  optimizationEnabled: true
}), 'source');
assert.equal(selectInitialEditorMode({
  text: fixtures.get('composite')!.text,
  persistedMode: null,
  documentMode: null,
  optimizationEnabled: false
}), 'live');
assert.equal(selectInitialEditorMode({
  text: fixtures.get('composite')!.text,
  persistedMode: 'live',
  documentMode: null,
  optimizationEnabled: true
}), 'source', 'another document global Live preference must not disable automatic Source');
assert.equal(selectInitialEditorMode({
  text: fixtures.get('composite')!.text,
  persistedMode: 'preview',
  documentMode: 'live',
  optimizationEnabled: true
}), 'live', 'this document manual Live preference must beat the automatic Source decision');
assert.equal(selectInitialEditorMode({
  text: fixtures.get('ordinary')!.text,
  persistedMode: 'preview',
  documentMode: null,
  optimizationEnabled: true
}), 'preview');

console.log('Large document policy checks passed');
