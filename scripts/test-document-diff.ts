import { compareDocuments } from '../src/shared/gitDiffCore';

function assertEqual(actual: unknown, expected: unknown, label: string): void {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(`${label}: expected ${expectedJson}, got ${actualJson}`);
  }
}

const middleDeletion = compareDocuments(
  'first\nremoved one\nremoved two\nlast',
  'first\nlast'
);
assertEqual(middleDeletion.lineChanges, [], 'pure deletion does not mark surviving lines');
assertEqual(middleDeletion.deletedGaps, [{
  boundary: 1,
  baselineFromLine: 2,
  baselineToLine: 3
}], 'middle deletion is attached between surviving lines');

const edgeDeletions = compareDocuments(
  'before\nfirst\nlast\nafter',
  'first\nlast'
);
assertEqual(edgeDeletions.deletedGaps, [
  { boundary: 0, baselineFromLine: 1, baselineToLine: 1 },
  { boundary: 2, baselineFromLine: 4, baselineToLine: 4 }
], 'leading and trailing deletions use document boundaries');

const replacementWithExtraDeletion = compareDocuments(
  'first\nold one\nold two\nold three\nlast',
  'first\nnew\nlast'
);
assertEqual(replacementWithExtraDeletion.lineChanges, [
  { line: 2, kind: 'modified' }
], 'paired replacement is marked modified');
assertEqual(replacementWithExtraDeletion.deletedGaps, [{
  boundary: 2,
  baselineFromLine: 3,
  baselineToLine: 4
}], 'unpaired replacement lines remain visible as a deletion gap');

const insertion = compareDocuments('first\nlast', 'first\nnew\nlast');
assertEqual(insertion.lineChanges, [{ line: 2, kind: 'added' }], 'inserted line is marked added');
assertEqual(insertion.deletedGaps, [], 'insertion has no deletion gap');

const firstContent = compareDocuments('', 'first');
assertEqual(firstContent.lineChanges, [{ line: 1, kind: 'added' }], 'first content in an empty document is added');
assertEqual(firstContent.deletedGaps, [], 'first content does not invent a deletion');

const terminalNewlineOnly = compareDocuments('first\n', 'first');
assertEqual(terminalNewlineOnly.lineChanges, [], 'removing only the terminal newline does not mark content');
assertEqual(terminalNewlineOnly.deletedGaps, [], 'terminal newline is not exposed as deleted content');

const crlfOnly = compareDocuments('first\r\nlast\r\n', 'first\nlast\n');
assertEqual(crlfOnly.lineChanges, [], 'line-ending normalization does not mark content');
assertEqual(crlfOnly.deletedGaps, [], 'line-ending normalization does not invent deletions');

const wholeDocumentDeletion = compareDocuments('first\nsecond', '');
assertEqual(wholeDocumentDeletion.lineChanges, [], 'empty visual line is not a modified content line');
assertEqual(wholeDocumentDeletion.deletedGaps, [{
  boundary: 0,
  baselineFromLine: 1,
  baselineToLine: 2
}], 'whole-document deletion is attached above the empty visual line');

console.log('document diff checks passed');
