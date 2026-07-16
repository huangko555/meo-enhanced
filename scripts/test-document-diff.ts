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

const replacementWithExtraInsertion = compareDocuments(
  'first\nold\nlast',
  'first\nnew one\nnew two\nlast'
);
assertEqual(replacementWithExtraInsertion.lineChanges, [
  { line: 2, kind: 'modified' },
  { line: 3, kind: 'added' }
], 'splitting one line keeps one modified line and marks the extra line added');
assertEqual(replacementWithExtraInsertion.deletedGaps, [], 'splitting one line does not invent a deletion');

const replacementWithSingleDeletion = compareDocuments(
  'first\nold one\nold two\nlast',
  'first\nnew\nlast'
);
assertEqual(replacementWithSingleDeletion.lineChanges, [
  { line: 2, kind: 'modified' }
], 'merging two lines keeps one modified line');
assertEqual(replacementWithSingleDeletion.deletedGaps, [{
  boundary: 2,
  baselineFromLine: 3,
  baselineToLine: 3
}], 'merging two lines leaves one deleted line');

const insertion = compareDocuments('first\nlast', 'first\nnew\nlast');
assertEqual(insertion.lineChanges, [{ line: 2, kind: 'added' }], 'inserted line is marked added');
assertEqual(insertion.deletedGaps, [], 'insertion has no deletion gap');

const ambiguousInlineDeletion = compareDocuments('a\nab', 'a\na');
assertEqual(ambiguousInlineDeletion.lineChanges, [
  { line: 2, kind: 'modified' }
], 'inline deletion keeps the original line identity when adjacent text is ambiguous');
assertEqual(ambiguousInlineDeletion.deletedGaps, [], 'inline deletion does not invent a deleted line');

const leadingInlineDeletionNearDuplicate = compareDocuments('ab\na', 'a\na');
assertEqual(leadingInlineDeletionNearDuplicate.lineChanges, [
  { line: 1, kind: 'modified' }
], 'inline deletion keeps its line identity when it becomes equal to the next line');
assertEqual(leadingInlineDeletionNearDuplicate.deletedGaps, [], 'leading inline deletion does not invent a deleted line');

const clearedMiddleLine = compareDocuments('first\ntext\nlast', 'first\n\nlast');
assertEqual(clearedMiddleLine.lineChanges, [
  { line: 2, kind: 'modified' }
], 'clearing a line without removing its newline is a modification');
assertEqual(clearedMiddleLine.deletedGaps, [], 'clearing a line does not invent a deleted line');

const clearedFinalLine = compareDocuments('first\ntext', 'first\n');
assertEqual(clearedFinalLine.lineChanges, [
  { line: 2, kind: 'modified' }
], 'clearing the final line keeps the trailing empty line identity');
assertEqual(clearedFinalLine.deletedGaps, [], 'clearing the final line does not invent a deleted line');

const clearedOnlyLine = compareDocuments('text', '');
assertEqual(clearedOnlyLine.lineChanges, [
  { line: 1, kind: 'modified' }
], 'clearing the only editor line is a modification');
assertEqual(clearedOnlyLine.deletedGaps, [], 'clearing the only editor line does not delete the line itself');

const balancedStructuralChanges = compareDocuments('A\nB\nC', 'A\nC\nD');
assertEqual(balancedStructuralChanges.lineChanges, [
  { line: 3, kind: 'added' }
], 'balanced structural changes keep their unchanged anchor and added line');
assertEqual(balancedStructuralChanges.deletedGaps, [{
  boundary: 1,
  baselineFromLine: 2,
  baselineToLine: 2
}], 'balanced structural changes retain the genuinely deleted line');

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
assertEqual(wholeDocumentDeletion.lineChanges, [{
  line: 1,
  kind: 'modified'
}], 'clearing a document keeps its only editor line as modified');
assertEqual(wholeDocumentDeletion.deletedGaps, [{
  boundary: 1,
  baselineFromLine: 2,
  baselineToLine: 2
}], 'clearing a document deletes only the remaining structural line');

console.log('document diff checks passed');
