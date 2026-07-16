import { DefaultLinesDiffComputer } from 'vscode-diff';

export type DiffComputeOptions = {
  maxComputationTimeMs?: number;
};

export type DocumentLineChange = {
  line: number;
  kind: 'added' | 'modified';
  baselineFromLine?: number;
  baselineToLine?: number;
};

export type DeletedGap = {
  boundary: number;
  baselineFromLine: number;
  baselineToLine: number;
};

export type DocumentDiff = {
  lineChanges: DocumentLineChange[];
  deletedGaps: DeletedGap[];
  currentToBaselineLine: Int32Array;
  hitTimeout: boolean;
  failed: boolean;
};

const DEFAULT_MAX_COMPUTATION_TIME_MS = 1000;
const diffComputer = new DefaultLinesDiffComputer();

export function normalizeDiffLine(lineText: string): string {
  return lineText.endsWith('\r') ? lineText.slice(0, -1) : lineText;
}

export function splitDiffLines(text: string): string[] {
  return `${text ?? ''}`.split('\n').map(normalizeDiffLine);
}

function splitDocumentContentLines(text: string, logicalLines = splitDiffLines(text)): string[] {
  if (text === '') {
    return [];
  }
  if (text.endsWith('\n')) {
    return logicalLines.slice(0, -1);
  }
  return logicalLines;
}

function splitComparableDocumentLines(baseText: string, currentText: string): {
  baseLines: string[];
  currentLines: string[];
} {
  const logicalBaseLines = splitDiffLines(baseText);
  const logicalCurrentLines = splitDiffLines(currentText);
  let baseLines = splitDocumentContentLines(baseText, logicalBaseLines);
  let currentLines = splitDocumentContentLines(currentText, logicalCurrentLines);

  // CodeMirror always has one visual line. Keep that line when its content was
  // cleared, while still ignoring a terminal-newline-only difference.
  if (
    baseText !== '' &&
    (currentText === '' || logicalBaseLines.length === logicalCurrentLines.length)
  ) {
    baseLines = logicalBaseLines;
    currentLines = logicalCurrentLines;
  }

  return { baseLines, currentLines };
}

function emptyDocumentDiff(currentLineCount: number, hitTimeout = false, failed = false): DocumentDiff {
  return {
    lineChanges: [],
    deletedGaps: [],
    currentToBaselineLine: new Int32Array(currentLineCount + 1),
    hitTimeout,
    failed
  };
}

function computeLineDiff(
  baseLines: string[],
  currentLines: string[],
  options: DiffComputeOptions
) {
  return diffComputer.computeDiff(baseLines, currentLines, {
    ignoreTrimWhitespace: false,
    computeMoves: false,
    maxComputationTimeMs: options.maxComputationTimeMs ?? DEFAULT_MAX_COMPUTATION_TIME_MS
  });
}

function buildDocumentDiffFromChanges(
  baseLines: string[],
  currentLines: string[],
  changes: ReturnType<DefaultLinesDiffComputer['computeDiff']>['changes'],
  hitTimeout: boolean
): DocumentDiff {
  const result = emptyDocumentDiff(currentLines.length, hitTimeout);
  let baselineCursor = 1;
  let currentCursor = 1;

  for (const change of changes) {
    const original = change.original;
    const modified = change.modified;
    const unchangedCount = Math.min(
      original.startLineNumber - baselineCursor,
      modified.startLineNumber - currentCursor
    );
    for (let offset = 0; offset < unchangedCount; offset += 1) {
      result.currentToBaselineLine[currentCursor + offset] = baselineCursor + offset;
    }

    if (original.isEmpty) {
      for (let line = modified.startLineNumber; line < modified.endLineNumberExclusive; line += 1) {
        result.lineChanges.push({ line, kind: 'added' });
      }
    } else if (modified.isEmpty) {
      result.deletedGaps.push({
        boundary: Math.max(0, modified.startLineNumber - 1),
        baselineFromLine: original.startLineNumber,
        baselineToLine: original.endLineNumberExclusive - 1
      });
    } else {
      const baselineFromLine = original.startLineNumber;
      const baselineToLine = original.endLineNumberExclusive - 1;
      const pairedLineCount = Math.min(original.length, modified.length);
      for (let offset = 0; offset < modified.length; offset += 1) {
        const line = modified.startLineNumber + offset;
        result.lineChanges.push({
          line,
          kind: 'modified',
          baselineFromLine,
          baselineToLine
        });
        if (offset < pairedLineCount) {
          result.currentToBaselineLine[line] = original.startLineNumber + offset;
        }
      }
    }

    baselineCursor = original.endLineNumberExclusive;
    currentCursor = modified.endLineNumberExclusive;
  }

  const trailingUnchangedCount = Math.min(
    baseLines.length - baselineCursor + 1,
    currentLines.length - currentCursor + 1
  );
  for (let offset = 0; offset < trailingUnchangedCount; offset += 1) {
    result.currentToBaselineLine[currentCursor + offset] = baselineCursor + offset;
  }

  return result;
}

export function buildCurrentToBaselineLineMapFromLines(
  baseLines: string[],
  currentLines: string[],
  options: DiffComputeOptions = {}
): Int32Array | null {
  if (baseLines.length === 0 || currentLines.length === 0) {
    return new Int32Array(currentLines.length + 1);
  }
  try {
    const diff = computeLineDiff(baseLines, currentLines, options);
    if (diff.hitTimeout) {
      return null;
    }
    return buildDocumentDiffFromChanges(baseLines, currentLines, diff.changes, diff.hitTimeout)
      .currentToBaselineLine;
  } catch {
    return null;
  }
}

export function buildCurrentToBaselineLineMap(
  baseText: string,
  currentText: string,
  options: DiffComputeOptions = {}
): Int32Array | null {
  const { baseLines, currentLines } = splitComparableDocumentLines(baseText, currentText);
  return buildCurrentToBaselineLineMapFromLines(baseLines, currentLines, options);
}

export function compareDocuments(
  baseText: string,
  currentText: string,
  options: DiffComputeOptions = {}
): DocumentDiff {
  const { baseLines, currentLines } = splitComparableDocumentLines(baseText, currentText);
  if (baseLines.length === 0) {
    const result = emptyDocumentDiff(currentLines.length);
    for (let line = 1; line <= currentLines.length; line += 1) {
      result.lineChanges.push({ line, kind: 'added' });
    }
    return result;
  }
  if (currentLines.length === 0) {
    const result = emptyDocumentDiff(0);
    result.deletedGaps.push({
      boundary: 0,
      baselineFromLine: 1,
      baselineToLine: baseLines.length
    });
    return result;
  }
  try {
    const diff = computeLineDiff(baseLines, currentLines, options);
    return buildDocumentDiffFromChanges(baseLines, currentLines, diff.changes, diff.hitTimeout);
  } catch {
    // A diff failure must not destabilize the editor transaction that requested it.
    return emptyDocumentDiff(currentLines.length, false, true);
  }
}
