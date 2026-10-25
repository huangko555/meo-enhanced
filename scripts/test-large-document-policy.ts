import assert from 'node:assert/strict';
import {
  assessLargeDocument,
  selectInitialEditorMode
} from '../src/application/largeDocumentPolicy';
import { createLargeDocumentFixtures } from './large-document-fixtures';

const fixtures = new Map(createLargeDocumentFixtures().map((fixture) => [fixture.kind, fixture]));
const ordinary = assessLargeDocument(fixtures.get('ordinary')!.text);
// Exercise growth across independent optimization boundaries, not just one
// oversized fixture. Opening mode need not change with the earlier work limit.
const fence = '```\nx\n```\n\n';
assert.equal(assessLargeDocument(fence.repeat(47)).boundedEditorWork, false);
assert.equal(assessLargeDocument(fence.repeat(48)).boundedEditorWork, true);
assert.equal(assessLargeDocument(fence.repeat(127)).windowedPreview, false);
assert.equal(assessLargeDocument(fence.repeat(128)).windowedPreview, true);
assert.equal(assessLargeDocument(fence.repeat(128)).preferSource, false);
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
  richBlocks: 0,
  codeFences: 0,
  maxLineLength: 0,
  maxCodeBlockLength: 0,
  maxTableRows: 0
});
assert.equal(assessLargeDocument('你好').dimensions.bytes, 6, 'byte pressure must use UTF-8');
assert.equal(ordinary.preferSource, false, 'ordinary documents must retain the Live default');
assert.equal(bytesHeavy.preferSource, true, 'byte pressure must independently select Source');
assert.equal(linesHeavy.preferSource, true, 'line pressure must independently select Source');
assert.equal(richHeavy.preferSource, true, 'rich-block pressure must independently select Source');
assert.equal(composite.preferSource, true, 'combined pressure must select Source');

const shortRich = assessLargeDocument(('| A | B |\n| --- | --- |\n| one | two |\n\n').repeat(100));
assert.equal(shortRich.preferSource, false, 'a shorter rich document keeps the ordinary opening policy');
assert.equal(shortRich.boundedEditorWork, true, 'rendering pressure must not wait for the Source startup threshold');
assert.equal(assessLargeDocument('# Short\n\nOrdinary **text**.').boundedEditorWork, false);
const shortCode = assessLargeDocument(('```javascript\nconst x = 1;\n```\n\n').repeat(50));
assert.equal(shortCode.preferSource, false);
assert.equal(shortCode.dimensions.codeFences, 50);
assert.equal(shortCode.boundedEditorWork, true, 'many short fences also require a bounded editing budget');
const unlabeledCode = assessLargeDocument(('~~~\nplain code\n~~~\n\n').repeat(60));
assert.equal(unlabeledCode.dimensions.codeFences, 60, 'unlabeled tilde fences must count as code blocks');
assert.equal(unlabeledCode.windowedPreview, false, 'sixty small plain fences retain complete Preview');
const mixedPreview = assessLargeDocument(Array.from({ length: 40 }, (_, index) =>
  `## Section ${index}\n\n| A | B |\n| --- | --- |\n| one | two |\n\n`
  + '```javascript\nconst x = 1;\n```\n\n$$\nx^2\n$$\n\n![pixel](image.png)\n\n').join(''));
assert.ok(mixedPreview.pressure < 1 && !mixedPreview.preferSource && !mixedPreview.lightweightSourceSyntax,
  'a short complex document keeps its opening policy and Source coloring');
assert.equal(mixedPreview.windowedPreview, true, 'many rendered resources and fences need bounded Preview before the file-size opening limit');
const diagramPreview = assessLargeDocument('```mermaid\nflowchart LR; A-->B\n```\n\n'.repeat(120));
assert.equal(diagramPreview.windowedPreview, false, 'rich fences must not count twice in the Preview block budget');
const literalExample = assessLargeDocument('````markdown\n```mermaid\nA-->B\n```\n| A | B |\n| --- | --- |\n![literal](image.png)\n$$\nx\n$$\n````');
assert.equal(literalExample.dimensions.codeFences, 1);
assert.equal(literalExample.dimensions.richBlocks, 0, 'literal examples must not count as rendered resources');
assert.equal(assessLargeDocument('> ~~~mermaid\n> A-->B\n> ~~~').dimensions.mermaid, 1);
assert.equal(assessLargeDocument('```latex\nx^2\n```').dimensions.math, 1);
assert.equal(assessLargeDocument('abc\r\n12345\r\n').dimensions.maxLineLength, 5);
assert.equal(assessLargeDocument('```\n' + 'x'.repeat(40_000)).dimensions.maxCodeBlockLength, 40_004);
assert.equal(assessLargeDocument('| A | B |\n| --- | --- |\n| a | b |\n| c | d |\n\nTail').dimensions.maxTableRows, 2);
assert.equal(literalExample.dimensions.maxTableRows, 0);
const indentedTable = assessLargeDocument('    | A | B |\n    | --- | --- |\n' + '    | a | b |\n'.repeat(1200));
assert.equal(indentedTable.dimensions.maxTableRows, 0, 'Indented literal code must not trigger a rendered-table strategy');
assert.equal(indentedTable.windowedPreview, false);
assert.equal(assessLargeDocument('| A | B |\n| --- | --- |\n' + '| --- | --- |\n'.repeat(4_096)).dimensions.maxTableRows, 4_096,
  'delimiter-shaped cell contents must remain rows of one long table');
const singleLongTable = assessLargeDocument('| A | B |\n| --- | --- |\n' + '| a | b |\n'.repeat(1_200));
assert.ok(singleLongTable.pressure < 1 && singleLongTable.preferSource,
  'the optional fast-opening preference must recognize one costly table in a short file');
assert.equal(singleLongTable.boundedEditorWork, true, 'one large editable block needs a work budget regardless of byte density');
assert.equal(singleLongTable.lightweightSourceSyntax, false, 'opening preferences must not change normal Source coloring');
assert.equal(singleLongTable.windowedPreview, true, 'a giant table needs independent Preview reading bands before the byte threshold');
for (const delimiter of ['--- | ---', ':-- | -:', '| - | - |']) {
  const header = delimiter.startsWith('|') ? '| A | B |' : 'A | B';
  const assessment = assessLargeDocument(`${header}\n${delimiter}\n` + 'a | b\n'.repeat(512));
  assert.equal(assessment.dimensions.maxTableRows, 512, 'optional outer pipes and short aligned delimiters retain the same work budget');
  assert.equal(assessment.windowedPreview, false, '512-row Preview startup gains are not stable enough to force a logical document');
  const larger = assessLargeDocument(`${header}\n${delimiter}\n` + 'a | b\n'.repeat(1024));
  assert.equal(larger.windowedPreview, true, '1024-row Preview uses the measured source-backed table path');
  assert.equal(assessment.lightweightSourceSyntax, false);
}

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
  optimizationEnabled: true
}), 'live');
assert.equal(selectInitialEditorMode({
  text: fixtures.get('composite')!.text,
  persistedMode: null,
  optimizationEnabled: true
}), 'source');
assert.equal(selectInitialEditorMode({
  text: fixtures.get('composite')!.text,
  persistedMode: null,
  optimizationEnabled: false
}), 'live');
assert.equal(selectInitialEditorMode({
  text: fixtures.get('composite')!.text,
  persistedMode: 'live',
  optimizationEnabled: true
}), 'source', 'another document global Live preference must not disable automatic Source');
assert.equal(selectInitialEditorMode({
  text: fixtures.get('ordinary')!.text,
  persistedMode: 'preview',
  optimizationEnabled: true
}), 'preview');

console.log('Large document policy checks passed');
