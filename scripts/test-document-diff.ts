import {
  buildCurrentToBaselineLineMapFromLines,
  compareDocuments
} from '../src/shared/gitDiffCore';

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
  { line: 2, kind: 'modified', baselineFromLine: 2, baselineToLine: 4 }
], 'a replacement hunk is marked modified across its complete original range');
assertEqual(replacementWithExtraDeletion.deletedGaps, [], 'a replacement hunk does not invent a separate deletion marker');

const replacementWithExtraInsertion = compareDocuments(
  'first\nold\nlast',
  'first\nnew one\nnew two\nlast'
);
assertEqual(replacementWithExtraInsertion.lineChanges, [
  { line: 2, kind: 'modified', baselineFromLine: 2, baselineToLine: 2 },
  { line: 3, kind: 'modified', baselineFromLine: 2, baselineToLine: 2 }
], 'all current lines in a replacement hunk are marked modified');
assertEqual(replacementWithExtraInsertion.deletedGaps, [], 'splitting one line does not invent a deletion');

const replacementWithSingleDeletion = compareDocuments(
  'first\nold one\nold two\nlast',
  'first\nnew\nlast'
);
assertEqual(replacementWithSingleDeletion.lineChanges, [
  { line: 2, kind: 'modified', baselineFromLine: 2, baselineToLine: 3 }
], 'merging lines exposes the complete original range as one modified hunk');
assertEqual(replacementWithSingleDeletion.deletedGaps, [], 'merged replacement content does not create a second deletion marker');

const insertion = compareDocuments('first\nlast', 'first\nnew\nlast');
assertEqual(insertion.lineChanges, [{ line: 2, kind: 'added' }], 'inserted line is marked added');
assertEqual(insertion.deletedGaps, [], 'insertion has no deletion gap');

const ambiguousInlineDeletion = compareDocuments('a\nab', 'a\na');
assertEqual(ambiguousInlineDeletion.lineChanges, [
  { line: 2, kind: 'modified', baselineFromLine: 2, baselineToLine: 2 }
], 'inline deletion keeps the original line identity when adjacent text is ambiguous');
assertEqual(ambiguousInlineDeletion.deletedGaps, [], 'inline deletion does not invent a deleted line');

const leadingInlineDeletionNearDuplicate = compareDocuments('ab\na', 'a\na');
assertEqual(leadingInlineDeletionNearDuplicate.lineChanges, [
  { line: 1, kind: 'modified', baselineFromLine: 1, baselineToLine: 1 }
], 'inline deletion keeps its line identity when it becomes equal to the next line');
assertEqual(leadingInlineDeletionNearDuplicate.deletedGaps, [], 'leading inline deletion does not invent a deleted line');

const clearedMiddleLine = compareDocuments('first\ntext\nlast', 'first\n\nlast');
assertEqual(clearedMiddleLine.lineChanges, [
  { line: 2, kind: 'modified', baselineFromLine: 2, baselineToLine: 2 }
], 'clearing a line without removing its newline is a modification');
assertEqual(clearedMiddleLine.deletedGaps, [], 'clearing a line does not invent a deleted line');

const adjacentEditsStartingFromEmptyLine = compareDocuments(
  'before\n\nClick reveal keeps the break\n\nafter',
  'before\n123\nClick reveal keeps the break123\n\nafter'
);
assertEqual(adjacentEditsStartingFromEmptyLine.lineChanges, [
  { line: 2, kind: 'modified', baselineFromLine: 2, baselineToLine: 3 },
  { line: 3, kind: 'modified', baselineFromLine: 2, baselineToLine: 3 }
], 'adjacent edited lines keep their identities when the first baseline line is empty');
assertEqual(
  adjacentEditsStartingFromEmptyLine.deletedGaps,
  [],
  'adjacent edits starting from an empty line do not invent a deletion'
);

const adjacentEditsBeforeRepeatedDivider = compareDocuments(
  'before\n---\nsection\n---\nafter',
  'before\n123\nsection123\n---\nafter'
);
assertEqual(adjacentEditsBeforeRepeatedDivider.lineChanges, [
  { line: 2, kind: 'modified', baselineFromLine: 2, baselineToLine: 3 },
  { line: 3, kind: 'modified', baselineFromLine: 2, baselineToLine: 3 }
], 'adjacent edits keep their identities before a repeated non-empty line');
assertEqual(adjacentEditsBeforeRepeatedDivider.deletedGaps, [], 'a repeated non-empty line does not invent a deletion');

const structuralChangesAroundBlankLine = compareDocuments(
  'before\nremoved\n\nafter',
  'before\n\nadded\nafter'
);
assertEqual(structuralChangesAroundBlankLine.lineChanges, [
  { line: 3, kind: 'added' }
], 'a real insertion around an unchanged blank line remains added');
assertEqual(structuralChangesAroundBlankLine.deletedGaps, [{
  boundary: 1,
  baselineFromLine: 2,
  baselineToLine: 2
}], 'a real deletion around an unchanged blank line remains deleted');

const deletionBeforeTextAndInsertionAfterIt = compareDocuments(
  'before\n\n\nLONG\n\nHEADING\n\nafter',
  'before\nLONG\n\n\nHEADING\n\nafter'
);
assertEqual(deletionBeforeTextAndInsertionAfterIt.lineChanges, [
  { line: 3, kind: 'added' }
], 'unchanged non-empty lines remain anchors when blank lines move around them');
assertEqual(deletionBeforeTextAndInsertionAfterIt.deletedGaps, [{
  boundary: 1,
  baselineFromLine: 2,
  baselineToLine: 3
}], 'blank lines deleted before unchanged text stay attached before that text');

const clearedFinalLine = compareDocuments('first\ntext', 'first\n');
assertEqual(clearedFinalLine.lineChanges, [
  { line: 2, kind: 'modified', baselineFromLine: 2, baselineToLine: 2 }
], 'clearing the final line keeps the trailing empty line identity');
assertEqual(clearedFinalLine.deletedGaps, [], 'clearing the final line does not invent a deleted line');

const clearedOnlyLine = compareDocuments('text', '');
assertEqual(clearedOnlyLine.lineChanges, [
  { line: 1, kind: 'modified', baselineFromLine: 1, baselineToLine: 1 }
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
  kind: 'modified',
  baselineFromLine: 1,
  baselineToLine: 2
}], 'clearing a document keeps its only editor line as modified');
assertEqual(wholeDocumentDeletion.deletedGaps, [], 'clearing a document is represented by one complete modified hunk');

const timeoutBaseLines = Array.from({ length: 1200 }, (_, index) => `original ${index}`);
const timeoutCurrentLines = Array.from({ length: 1200 }, (_, index) => `modified ${index}`);
const timedOutLineMap = buildCurrentToBaselineLineMapFromLines(timeoutBaseLines, timeoutCurrentLines, {
  maxComputationTimeMs: 1
});
assertEqual(timedOutLineMap, null, 'a timed-out line map is discarded instead of caching approximate blame identities');

console.log('document diff checks passed');
