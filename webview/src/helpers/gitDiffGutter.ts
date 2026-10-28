import { readDocumentTextProjection } from '../application/documentTextProjection';
import { RangeSetBuilder, StateEffect, StateField, EditorState, Transaction, type RangeSet, type Text } from '@codemirror/state';
import { GutterMarker, gutter, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { createBackgroundDocumentDiff } from './backgroundDocumentDiff';
import { gitDiffLineFlagsFacet, type MarkerFlags } from './gitDiffPresentation';
import { exceedsLargeDocumentTextBudget } from '../../../src/foundation/largeDocument';
export type { MarkerFlags } from './gitDiffPresentation';
import {
  compareDocuments,
  splitDiffLines,
  type DocumentDiff
} from '../../../src/shared/gitDiffCore';
import {
  getLiveGitCollapsedBlocks,
  getLiveRenderedBlockAtLine
} from './liveRenderedBlocks';
import { createGitDiffMarkerElement } from './gitDiffMarkerDom';
import { getHtmlEditingRange } from './htmlContent';
import {
  getTableTransactionProvenanceSnapshot
} from '../adapters/tableTransactionProvenance';
import {
  isLiveInputDerivedWorkRefresh,
  shouldDeferLiveInputDerivedWork,
  isLiveInputDerivedWorkPending,
  requestLiveInputDerivedWorkOnFrame,
  usesLargeDocumentDerivedWorkBudget
} from '../editor/liveInputDerivedWork';
import type {
  ChangesReviewComparison,
  ChangesReviewDiffSummary,
  ChangesReviewUnavailableReason
} from '../application/changesReview';

const MAX_DIFF_TEXT_CHARS = 1024 * 1024;
const MAX_DIFF_COMPUTATION_TIME_MS = 50;
const NON_RENDERABLE_GIT_BASELINE_REASONS = new Set(['not-repo', 'ignored']);

export const setGitBaselineEffect = StateEffect.define<any>();

interface BaselineSnapshot {
  available: boolean;
  tracked: boolean;
  baseText: string | null;
  baseLines: string[] | null;
  mode?: 'current-edit' | 'recent-save' | 'git-head' | 'fixed';
  generation?: number;
  headOid?: string | null;
  reason?: Exclude<ChangesReviewUnavailableReason, 'timeout'>;
}

const emptyBaseline: BaselineSnapshot = Object.freeze({
  available: false,
  tracked: false,
  baseText: null,
  baseLines: null
});

function normalizeBaselineSnapshot(snapshot: any): BaselineSnapshot {
  if (!snapshot || typeof snapshot !== 'object') {
    return emptyBaseline;
  }
  const baseText = typeof snapshot.baseText === 'string' ? snapshot.baseText : null;
  return {
    available: snapshot.available === true,
    tracked: snapshot.tracked === true,
    generation: snapshot.generation,
    mode: snapshot.mode === 'current-edit' || snapshot.mode === 'recent-save' || snapshot.mode === 'git-head' || snapshot.mode === 'fixed'
      ? snapshot.mode
      : 'git-head',
    headOid: typeof snapshot.headOid === 'string' ? snapshot.headOid : snapshot.headOid === null ? null : undefined,
    baseText,
    baseLines: typeof baseText === 'string' ? splitDiffLines(baseText) : null,
    reason: typeof snapshot.reason === 'string' ? snapshot.reason : undefined
  };
}

const gitBaselineField = StateField.define<BaselineSnapshot>({
  create(): BaselineSnapshot {
    return emptyBaseline;
  },
  update(value: BaselineSnapshot, tr: Transaction): BaselineSnapshot {
    for (const effect of tr.effects) {
      if (effect.is(setGitBaselineEffect)) {
        return normalizeBaselineSnapshot(effect.value);
      }
    }
    return value;
  }
});

class GitGutterMarker extends GutterMarker {
  flags: MarkerFlags;
  key: string;

  constructor(flags: MarkerFlags) {
    super();
    this.flags = flags;
    this.key = JSON.stringify(flags);
  }

  eq(other: GitGutterMarker): boolean {
    return other instanceof GitGutterMarker && other.key === this.key;
  }

  toDOM(): HTMLElement {
    return createGitDiffMarkerElement(this.flags);
  }
}

class GitGutterSpacerMarker extends GutterMarker {
  toDOM(): HTMLElement {
    const el = document.createElement('span');
    el.className = 'meo-git-gutter-marker meo-git-gutter-spacer';
    return el;
  }
}

const MAX_MARKER_CACHE_SIZE = 512;
const markerCache = new Map<string, GitGutterMarker>();
const spacerMarker = new GitGutterSpacerMarker();

function gitMarker(flags: MarkerFlags): GitGutterMarker {
  const key = JSON.stringify(flags);
  let marker = markerCache.get(key);
  if (!marker) {
    marker = new GitGutterMarker(flags);
    if (markerCache.size >= MAX_MARKER_CACHE_SIZE) {
      const oldestKey = markerCache.keys().next().value;
      if (typeof oldestKey === 'string') {
        markerCache.delete(oldestKey);
      }
    }
    markerCache.set(key, marker);
  }
  return marker;
}

function isTrailingEofVisualLine(doc: any, lineNo: number): boolean {
  if (!doc || doc.length <= 0 || doc.lines <= 1 || lineNo !== doc.lines) {
    return false;
  }
  const lastLine = doc.line(doc.lines);
  return lastLine.from === lastLine.to;
}

function emptyMarkerFlags(): MarkerFlags {
  return {
    added: false,
    modified: false
  };
}

const comparisonStatus = Symbol('comparisonStatus');
type GitDiffLineFlags = (MarkerFlags | undefined)[] & {
  [comparisonStatus]?: Pick<ChangesReviewDiffSummary, 'status'> & {
    readonly reason?: ChangesReviewUnavailableReason;
  };
};

type ComparisonOwner = { readonly doc: Text; readonly baseline: BaselineSnapshot };
const comparisonOwners = new WeakMap<GitDiffLineFlags, ComparisonOwner>();
const comparisonCounts = new WeakMap<GitDiffLineFlags, GitDiffLineCounts>();
const acceptBackgroundDiff = StateEffect.define<ComparisonOwner & { readonly result: DocumentDiff | null }>();

export function isGitDiffResultRefresh(transaction: Transaction): boolean {
  return transaction.effects.some(effect => effect.is(acceptBackgroundDiff));
}

/** These effects change comparison presentation, never Markdown structure. */
export function isGitDiffPresentationEffect(effect: StateEffect<unknown>): boolean {
  return effect.is(acceptBackgroundDiff) || effect.is(setGitBaselineEffect);
}

function isCurrentComparison(state: EditorState, flags: GitDiffLineFlags | null | undefined): boolean {
  const owner = flags && comparisonOwners.get(flags);
  return !!owner && owner.doc === state.doc && owner.baseline === state.field(gitBaselineField);
}

function needsBackgroundComparison(state: EditorState, baseline: BaselineSnapshot): boolean {
  if (!canRenderGitDiffBaseline(baseline) || typeof baseline.baseText !== 'string'
    || state.doc.length > MAX_DIFF_TEXT_CHARS || baseline.baseText.length > MAX_DIFF_TEXT_CHARS) return false;
  // A paste can grow a small Source editor before its idle assessment runs. A
  // large baseline also costs work when the current document has become small.
  return usesLargeDocumentDerivedWorkBudget(state)
    || exceedsLargeDocumentTextBudget(state.doc.length, state.doc.lines)
    || exceedsLargeDocumentTextBudget(baseline.baseText.length, baseline.baseLines?.length ?? 1);
}

function lineFlagsWithStatus(
  lineCount: number,
  status: 'pending' | 'ready' | 'unavailable',
  reason?: ChangesReviewUnavailableReason
): GitDiffLineFlags {
  const flags = new Array<MarkerFlags | undefined>(lineCount) as GitDiffLineFlags;
  flags[comparisonStatus] = reason ? { status, reason } : { status };
  return flags;
}

function mergeLineRanges(
  ranges: ReadonlyArray<readonly [number, number]>
): Array<[number, number]> {
  const sorted = ranges
    .map(([fromLine, toLine]) => [fromLine, toLine] as [number, number])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], range[1]);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

function subtractLineRanges(
  ranges: ReadonlyArray<readonly [number, number]>,
  excludedRanges: ReadonlyArray<readonly [number, number]>
): Array<[number, number]> {
  let remaining = mergeLineRanges(ranges);
  for (const [excludedFrom, excludedTo] of mergeLineRanges(excludedRanges)) {
    const next: Array<[number, number]> = [];
    for (const [from, to] of remaining) {
      if (excludedTo < from || excludedFrom > to) {
        next.push([from, to]);
        continue;
      }
      if (excludedFrom > from) next.push([from, excludedFrom - 1]);
      if (excludedTo < to) next.push([excludedTo + 1, to]);
    }
    remaining = next;
  }
  return remaining;
}

function reconcileSnapshotTableDeletions(
  state: EditorState,
  baselineLines: readonly string[],
  lineFlags: (MarkerFlags | undefined)[],
  deletedRows: ReadonlyArray<{
    at: number;
    baselineRanges: ReadonlyArray<readonly [number, number]>;
  }>
): void {
  const candidates = lineFlags.flatMap((flags, lineIndex) => (flags?.deletionRanges ?? []).flatMap(
    ([fromLine, toLine], rangeIndex) => {
      const lines = [];
      for (let baselineLine = fromLine; baselineLine <= toLine; baselineLine += 1) {
        lines.push({ lineIndex, rangeIndex, baselineLine });
      }
      return lines;
    }
  ));
  const claimedCandidates = new Set<string>();
  const removals = new Map<number, number[]>();

  for (const record of deletedRows) {
    const targetLine = state.doc.lineAt(Math.max(0, Math.min(record.at, state.doc.length))).number;
    const tableBlock = getLiveRenderedBlockAtLine(state, targetLine);
    for (const [fromLine, toLine] of record.baselineRanges) {
      for (let provenanceLine = fromLine; provenanceLine <= toLine; provenanceLine += 1) {
        let candidate: (typeof candidates)[number] | undefined;
        let candidateDistance = Number.POSITIVE_INFINITY;
        for (const next of candidates) {
          const key = `${next.lineIndex}:${next.rangeIndex}:${next.baselineLine}`;
          if (claimedCandidates.has(key)) continue;
          if (next.baselineLine === provenanceLine) {
            candidate = next;
            break;
          }
          if (tableBlock?.kind !== 'table') continue;
          const candidateLine = next.lineIndex + 1;
          if (
            candidateLine < tableBlock.startLine ||
            candidateLine > tableBlock.endLine + 1 ||
            baselineLines[next.baselineLine - 1] !== baselineLines[provenanceLine - 1]
          ) {
            continue;
          }
          const distance = Math.abs(candidateLine - targetLine);
          if (distance < candidateDistance) {
            candidate = next;
            candidateDistance = distance;
          }
        }
        if (!candidate) continue;
        claimedCandidates.add(`${candidate.lineIndex}:${candidate.rangeIndex}:${candidate.baselineLine}`);
        const lineRemovals = removals.get(candidate.lineIndex) ?? [];
        lineRemovals.push(candidate.baselineLine);
        removals.set(candidate.lineIndex, lineRemovals);
      }
    }
  }

  for (const [lineIndex, baselineLineNumbers] of removals) {
    const flags = lineFlags[lineIndex];
    if (!flags?.deletionRanges) continue;
    flags.deletionRanges = subtractLineRanges(
      flags.deletionRanges,
      baselineLineNumbers.map((lineNumber) => [lineNumber, lineNumber])
    );
    if (!flags.deletionRanges.length) {
      flags.deleted = false;
      flags.deletionRanges = undefined;
      flags.deletionBoundary = undefined;
      flags.deletionAtEnd = undefined;
      flags.baselineFromLine = undefined;
      flags.baselineToLine = undefined;
      continue;
    }
    flags.baselineFromLine = Math.min(...flags.deletionRanges.map(([from]) => from));
    flags.baselineToLine = Math.max(...flags.deletionRanges.map(([, to]) => to));
  }
}

function coalesceTrailingEofVisualLineFlag(doc: any, lineFlags: (MarkerFlags | undefined)[] | null): (MarkerFlags | undefined)[] | null {
  if (!Array.isArray(lineFlags) || !isTrailingEofVisualLine(doc, doc.lines) || doc.lines < 2) {
    return lineFlags;
  }

  const trailingIndex = doc.lines - 1;
  const previousIndex = trailingIndex - 1;
  const trailingFlags = lineFlags[trailingIndex];
  if (!trailingFlags) {
    return lineFlags;
  }

  const previousFlags = lineFlags[previousIndex] ?? emptyMarkerFlags();
  const previousHadChange = !!(previousFlags.added || previousFlags.modified);
  if (trailingFlags.modified) {
    previousFlags.modified = true;
    previousFlags.modifiedRanges = mergeLineRanges([
      ...(previousFlags.modifiedRanges ?? []),
      ...(trailingFlags.modifiedRanges ?? [])
    ]);
  }
  if (trailingFlags.added) {
    if (previousFlags.added) {
      previousFlags.added = true;
    } else if (!previousHadChange && !trailingFlags.modified) {
      previousFlags.trailingEofProxyOnly = true;
    } else {
      previousFlags.modified = true;
    }
  }
  if (trailingFlags.deleted) {
    previousFlags.deleted = true;
    previousFlags.deletionBoundary = trailingFlags.deletionBoundary;
    previousFlags.deletionAtEnd = true;
    previousFlags.baselineFromLine = trailingFlags.baselineFromLine;
    previousFlags.baselineToLine = trailingFlags.baselineToLine;
    previousFlags.deletionRanges = trailingFlags.deletionRanges;
  }
  previousFlags.trailingEofProxySource = true;
  lineFlags[previousIndex] = previousFlags;
  lineFlags[trailingIndex] = undefined;
  return lineFlags;
}

function canRenderGitDiffBaseline(snapshot: BaselineSnapshot | null): snapshot is BaselineSnapshot {
  if (!snapshot?.available) {
    return false;
  }
  if (!snapshot.reason) {
    return true;
  }
  return !NON_RENDERABLE_GIT_BASELINE_REASONS.has(snapshot.reason);
}

function getTrailingEofProxyFlags(
  doc: any,
  lineFlags: (MarkerFlags | undefined)[] | null
): MarkerFlags | null {
  if (!isTrailingEofVisualLine(doc, doc.lines) || doc.lines <= 1 || !Array.isArray(lineFlags)) {
    return null;
  }

  const previousFlags = lineFlags[doc.lines - 2];
  if (!previousFlags || (!previousFlags.added && !previousFlags.modified)) {
    if (!previousFlags?.trailingEofProxyOnly) {
      return null;
    }
  }
  if (!previousFlags?.trailingEofProxySource && lineFlags[doc.lines - 1]) {
    return null;
  }

  return {
    added: previousFlags?.trailingEofProxyOnly ? false : !!previousFlags?.added,
    modified: previousFlags?.trailingEofProxyOnly ? true : !!previousFlags?.modified,
    modifiedRanges: previousFlags?.modifiedRanges,
    eofProxy: true
  };
}

function buildDiffLineFlags(state: EditorState, baseline: BaselineSnapshot | null, computed?: DocumentDiff | null): GitDiffLineFlags {
  if (!baseline || (!baseline.available && !baseline.reason)) {
    return lineFlagsWithStatus(0, 'pending');
  }
  const baselineUnavailableReason = baseline.reason;
  if (!canRenderGitDiffBaseline(baseline)) {
    return lineFlagsWithStatus(0, 'unavailable', baselineUnavailableReason ?? 'error');
  }

  if (typeof baseline.baseText !== 'string') {
    if (!baseline.tracked || baseline.headOid === null) {
      const lineFlags = lineFlagsWithStatus(state.doc.lines, 'ready');
      const textLength = state.doc.length;
      if (!textLength && state.doc.lines === 1 && state.doc.sliceString(0, state.doc.length) === '') {
        return lineFlags;
      }
      for (let i = 0; i < state.doc.lines; i += 1) {
        lineFlags[i] = { ...emptyMarkerFlags(), added: true };
      }
      return lineFlags;
    }
    return lineFlagsWithStatus(0, 'unavailable', baseline.reason ?? 'error');
  }

  if (state.doc.length > MAX_DIFF_TEXT_CHARS || baseline.baseText.length > MAX_DIFF_TEXT_CHARS) {
    return lineFlagsWithStatus(0, 'unavailable', 'too-large');
  }

  const result = computed === undefined ? compareDocuments(baseline.baseText, state.doc.sliceString(0, state.doc.length), {
    maxComputationTimeMs: MAX_DIFF_COMPUTATION_TIME_MS
  }) : computed;
  if (!result) return lineFlagsWithStatus(0, 'unavailable', 'error');
  if (result.hitTimeout || result.failed) {
    return lineFlagsWithStatus(0, 'unavailable', result.hitTimeout ? 'timeout' : 'error');
  }
  const lineFlags = lineFlagsWithStatus(state.doc.lines, 'ready');
  for (const change of result.lineChanges) {
    if (change.line < 1 || change.line > state.doc.lines) {
      continue;
    }
    lineFlags[change.line - 1] = change.kind === 'added'
      ? { ...emptyMarkerFlags(), added: true }
      : {
          ...emptyMarkerFlags(),
          modified: true,
          modifiedRanges: change.baselineFromLine && change.baselineToLine
            ? [[change.baselineFromLine, change.baselineToLine]]
            : undefined
        };
  }

  for (const gap of result.deletedGaps) {
    const deletionAtEnd = gap.boundary >= state.doc.lines;
    const targetLine = deletionAtEnd
      ? state.doc.lines
      : Math.max(1, Math.min(state.doc.lines, gap.boundary + 1));
    const flags = lineFlags[targetLine - 1] ?? (lineFlags[targetLine - 1] = emptyMarkerFlags());
    flags.deleted = true;
    flags.deletionBoundary = gap.boundary;
    flags.deletionAtEnd = deletionAtEnd;
    flags.baselineFromLine = gap.baselineFromLine;
    flags.baselineToLine = gap.baselineToLine;
    flags.deletionRanges = [
      ...(flags.deletionRanges ?? []),
      [gap.baselineFromLine, gap.baselineToLine]
    ];
  }

  for (let lineNumber = 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const baselineLineNumber = result.currentToBaselineLine[lineNumber];
    if (baselineLineNumber > 0) {
      const flags = lineFlags[lineNumber - 1] ?? (lineFlags[lineNumber - 1] = emptyMarkerFlags());
      flags.baselineLineNumber = baselineLineNumber;
    }
  }

  const provenance = getTableTransactionProvenanceSnapshot(state);
  for (const row of provenance.insertedRows) {
    const lineIndex = state.doc.lineAt(row.from).number - 1;
    lineFlags[lineIndex] = {
      ...(lineFlags[lineIndex] ?? emptyMarkerFlags()),
      added: true,
      modified: false,
      modifiedRanges: undefined
    };
  }

  const deletedRows = provenance.deletedRows;
  reconcileSnapshotTableDeletions(
    state,
    baseline.baseLines ?? splitDiffLines(baseline.baseText),
    lineFlags,
    deletedRows
  );
  const deletedBaselineRanges = mergeLineRanges(deletedRows.flatMap((record) => record.baselineRanges));
  if (deletedBaselineRanges.length) {
    for (const flags of lineFlags) {
      if (!flags?.modifiedRanges?.length) continue;
      flags.modifiedRanges = subtractLineRanges(flags.modifiedRanges, deletedBaselineRanges);
      if (!flags.modifiedRanges.length) {
        flags.modified = false;
        flags.modifiedRanges = undefined;
      }
    }
  }
  for (const record of deletedRows) {
    if (!record.baselineRanges.length) continue;
    const lineNumber = state.doc.lineAt(Math.max(0, Math.min(record.at, state.doc.length))).number;
    const flags = lineFlags[lineNumber - 1] ?? (lineFlags[lineNumber - 1] = emptyMarkerFlags());
    flags.deleted = true;
    flags.deletionAtEnd = record.deletionAtEnd;
    flags.deletionBoundary = record.deletionAtEnd ? lineNumber : Math.max(0, lineNumber - 1);
    flags.deletionRanges = mergeLineRanges([
      ...(flags.deletionRanges ?? []),
      ...record.baselineRanges
    ]);
    flags.baselineFromLine = Math.min(...flags.deletionRanges.map(([from]) => from));
    flags.baselineToLine = Math.max(...flags.deletionRanges.map(([, to]) => to));
  }

  return lineFlags;
}

function buildCoalescedDiffLineFlags(state: EditorState, baseline: BaselineSnapshot | null): (MarkerFlags | undefined)[] | null {
  const flags = coalesceTrailingEofVisualLineFlag(state.doc, buildDiffLineFlags(state, baseline));
  if (flags && baseline) comparisonOwners.set(flags, { doc: state.doc, baseline });
  return flags;
}

function buildGitGutterMarkersFromLineFlags(state: EditorState, lineFlags: (MarkerFlags | undefined)[] | null): any {
  const builder = new RangeSetBuilder<any>();
  if (!lineFlags) {
    return builder.finish();
  }
  const trailingEofProxyFlags = getTrailingEofProxyFlags(state.doc, lineFlags);

  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    if (isTrailingEofVisualLine(state.doc, lineNo)) {
      if (trailingEofProxyFlags) {
        const line = state.doc.line(lineNo);
        builder.add(line.from, line.from, gitMarker(trailingEofProxyFlags));
      }
      continue;
    }
    const flags = lineFlags[lineNo - 1];
    if (!flags || (!flags.added && !flags.modified && !flags.deleted)) {
      continue;
    }
    if (flags.trailingEofProxyOnly) {
      continue;
    }
    const line = state.doc.line(lineNo);
    builder.add(line.from, line.from, gitMarker(flags));
  }

  return builder.finish();
}

function buildLiveGitGutterMarkersFromLineFlags(state: EditorState, lineFlags: (MarkerFlags | undefined)[] | null): any {
  const builder = new RangeSetBuilder<any>();
  if (!lineFlags) {
    return builder.finish();
  }

  const collapsedBlocks = getLiveGitCollapsedBlocks(state, lineFlags);
  let collapsedBlockIndex = 0;
  let activeCollapsedBlock = collapsedBlocks[collapsedBlockIndex] ?? null;
  let activeCollapsedFlags = activeCollapsedBlock ? liveCollapsedBlockMarkerFlags(activeCollapsedBlock, lineFlags) : null;

  const trailingEofProxyFlags = getTrailingEofProxyFlags(state.doc, lineFlags);

  for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
    while (activeCollapsedBlock && lineNo > activeCollapsedBlock.endLine) {
      collapsedBlockIndex += 1;
      activeCollapsedBlock = collapsedBlocks[collapsedBlockIndex] ?? null;
      activeCollapsedFlags = activeCollapsedBlock ? liveCollapsedBlockMarkerFlags(activeCollapsedBlock, lineFlags) : null;
    }

    if (activeCollapsedBlock && lineNo >= activeCollapsedBlock.startLine && activeCollapsedFlags) {
      if (!activeCollapsedFlags.deleted) {
        const line = state.doc.line(lineNo);
        builder.add(line.from, line.from, gitMarker(activeCollapsedFlags));
      }
      continue;
    }

    if (isTrailingEofVisualLine(state.doc, lineNo)) {
      if (trailingEofProxyFlags) {
        const line = state.doc.line(lineNo);
        builder.add(line.from, line.from, gitMarker(trailingEofProxyFlags));
      }
      continue;
    }

    const flags = lineFlags[lineNo - 1];
    if (!flags || flags.trailingEofProxyOnly || (!flags.added && !flags.modified && !flags.deleted)) {
      continue;
    }
    const line = state.doc.line(lineNo);
    builder.add(line.from, line.from, gitMarker(flags));
  }

  return builder.finish();
}

function liveCollapsedBlockMarkerFlags(
  block: { startLine: number; endLine: number; aggregateChangeKind: 'added' | 'modified' | 'deleted' },
  lineFlags: readonly (MarkerFlags | undefined)[]
): MarkerFlags {
  const flags: MarkerFlags = {
    ...emptyMarkerFlags(),
    added: block.aggregateChangeKind === 'added',
    modified: block.aggregateChangeKind === 'modified',
    liveBlockStartLine: block.startLine,
    liveBlockEndLine: block.endLine
  };
  const seenModifiedRanges = new Set<string>();
  const modifiedRanges = lineFlags
    .slice(Math.max(0, block.startLine - 1), block.endLine)
    .flatMap((candidate) => candidate?.modifiedRanges ?? [])
    .filter(([fromLine, toLine]) => {
      const key = `${fromLine}:${toLine}`;
      if (seenModifiedRanges.has(key)) {
        return false;
      }
      seenModifiedRanges.add(key);
      return true;
    });
  flags.modifiedRanges = mergeLineRanges(modifiedRanges);
  if (!flags.modifiedRanges.length) {
    delete flags.modifiedRanges;
  }
  const deletions = lineFlags
    .slice(Math.max(0, block.startLine - 1), block.endLine)
    .filter((candidate): candidate is MarkerFlags => candidate?.deleted === true);
  const deletion = deletions[0];
  if (deletion) {
    flags.deleted = true;
    flags.deletionBoundary = deletion.deletionBoundary;
    flags.deletionAtEnd = deletion.deletionAtEnd;
    flags.baselineFromLine = deletion.baselineFromLine;
    flags.baselineToLine = deletion.baselineToLine;
    const seenRanges = new Set<string>();
    flags.deletionRanges = deletions.flatMap((candidate) => {
      const ranges = candidate.deletionRanges?.length
        ? candidate.deletionRanges
        : Number.isInteger(candidate.baselineFromLine) && Number.isInteger(candidate.baselineToLine)
          ? [[candidate.baselineFromLine!, candidate.baselineToLine!] as [number, number]]
          : [];
      return ranges.filter(([fromLine, toLine]) => {
        const key = `${fromLine}:${toLine}`;
        if (seenRanges.has(key)) {
          return false;
        }
        seenRanges.add(key);
        return true;
      });
    });
  }
  return flags;
}

type LiveGitGutterPresentation = {
  readonly markers: RangeSet<GutterMarker>;
  readonly widgets: RangeSet<GutterMarker>;
};

function buildLiveGitGutterPresentation(state: EditorState, lineFlags: (MarkerFlags | undefined)[] | null): LiveGitGutterPresentation {
  const widgets = new RangeSetBuilder<GutterMarker>();
  for (const block of getLiveGitCollapsedBlocks(state, lineFlags)) {
    // Tables own their visible row markers. Deletions still need a widget
    // marker even when their line markers are represented at a boundary.
    if (block.kind === 'table') continue;
    widgets.add(state.doc.line(block.startLine).from, state.doc.line(block.endLine).to,
      gitMarker(liveCollapsedBlockMarkerFlags(block, lineFlags!)));
  }
  return { markers: buildLiveGitGutterMarkersFromLineFlags(state, lineFlags), widgets: widgets.finish() };
}

export const gitDiffLineFlagsField = StateField.define<(MarkerFlags | undefined)[] | null>({
  create(state: EditorState): (MarkerFlags | undefined)[] | null {
    const baseline = state.field(gitBaselineField);
    return needsBackgroundComparison(state, baseline) ? lineFlagsWithStatus(0, 'pending')
      : buildCoalescedDiffLineFlags(state, baseline);
  },
  update(value: (MarkerFlags | undefined)[] | null, tr: Transaction): (MarkerFlags | undefined)[] | null {
    let baselineChanged = false;
    for (const effect of tr.effects) {
      if (effect.is(setGitBaselineEffect)) {
        baselineChanged = true;
        break;
      }
    }
    const baseline = tr.state.field(gitBaselineField);
    for (const effect of tr.effects) {
      if (effect.is(acceptBackgroundDiff) && !tr.docChanged && !baselineChanged
        && effect.value.doc === tr.state.doc && effect.value.baseline === baseline
        && !isLiveInputDerivedWorkPending(tr.state)) {
        const flags = coalesceTrailingEofVisualLineFlag(tr.state.doc,
          buildDiffLineFlags(tr.state, baseline, effect.value.result));
        if (flags) comparisonOwners.set(flags, { doc: tr.state.doc, baseline });
        return flags;
      }
    }
    if (shouldDeferLiveInputDerivedWork(tr)) {
      return value;
    }
    const budgetChanged = usesLargeDocumentDerivedWorkBudget(tr.state) !== usesLargeDocumentDerivedWorkBudget(tr.startState);
    if (!tr.docChanged && !baselineChanged && !budgetChanged && !isLiveInputDerivedWorkRefresh(tr)) {
      return value;
    }
    if (needsBackgroundComparison(tr.state, baseline)) return value;
    return buildCoalescedDiffLineFlags(tr.state, baseline);
  },
  provide: field => gitDiffLineFlagsFacet.compute([field, gitBaselineField], state => {
    const flags = state.field(field);
    const owner = flags && comparisonOwners.get(flags);
    return flags && owner ? { doc: owner.doc, lines: flags, baseline: owner.baseline,
      baselineCurrent: owner.baseline === state.field(gitBaselineField) } : undefined;
  })
});

const backgroundDiffPlugin = ViewPlugin.fromClass(class {
  private disposed = false;
  private attempted: ComparisonOwner | undefined;
  private readonly requestKey = {};
  private readonly publishKey = {};
  private readonly computation = createBackgroundDocumentDiff(result => {
    const owner = this.attempted;
    if (!owner) return;
    requestLiveInputDerivedWorkOnFrame(this.view, this.publishKey, () => {
      if (this.disposed || owner !== this.attempted || owner.doc !== this.view.state.doc
        || owner.baseline !== this.view.state.field(gitBaselineField)
        || !needsBackgroundComparison(this.view.state, owner.baseline)) return;
      this.view.dispatch({ effects: acceptBackgroundDiff.of({ ...owner, result }) });
    });
  });

  constructor(private readonly view: EditorView) {
    queueMicrotask(() => { if (!this.disposed) this.schedule(); });
  }

  private schedule(): void {
    const state = this.view.state;
    const baseline = state.field(gitBaselineField);
    if (!needsBackgroundComparison(state, baseline)
      || isCurrentComparison(state, state.field(gitDiffLineFlagsField))) return;
    requestLiveInputDerivedWorkOnFrame(this.view, this.requestKey, () => {
      if (this.disposed) return;
      const current = this.view.state;
      const currentBaseline = current.field(gitBaselineField);
      if (!needsBackgroundComparison(current, currentBaseline)
        || isCurrentComparison(current, current.field(gitDiffLineFlagsField))
        || (this.attempted?.doc === current.doc && this.attempted.baseline === currentBaseline)) return;
      this.attempted = { doc: current.doc, baseline: currentBaseline };
      this.computation.request(currentBaseline.baseText!, readDocumentTextProjection(current.doc));
    });
  }

  update(update: ViewUpdate): void {
    if (this.attempted && (this.attempted.doc !== update.state.doc
      || this.attempted.baseline !== update.state.field(gitBaselineField)
      || !needsBackgroundComparison(update.state, this.attempted.baseline))) {
      this.computation.cancel();
      this.attempted = undefined;
    }
    this.schedule();
  }

  destroy(): void {
    this.disposed = true;
    this.attempted = undefined;
    this.computation.dispose();
  }
});

const gitDiffGutterField = StateField.define<any>({
  create(state: EditorState): any {
    return buildGitGutterMarkersFromLineFlags(state, state.field(gitDiffLineFlagsField));
  },
  update(value: any, tr: Transaction): any {
    let baselineChanged = false;
    for (const effect of tr.effects) {
      if (effect.is(setGitBaselineEffect)) {
        baselineChanged = true;
        break;
      }
    }
    if (shouldDeferLiveInputDerivedWork(tr)) return tr.docChanged ? value.map(tr.changes) : value;
    if (!tr.docChanged && !baselineChanged && !isLiveInputDerivedWorkRefresh(tr) && !isGitDiffResultRefresh(tr)) {
      return value;
    }
    return buildGitGutterMarkersFromLineFlags(tr.state, tr.state.field(gitDiffLineFlagsField));
  }
});

const gitDiffLiveGutterField = StateField.define<LiveGitGutterPresentation>({
  create(state: EditorState): LiveGitGutterPresentation {
    return buildLiveGitGutterPresentation(
      state,
      state.field(gitDiffLineFlagsField, false) ?? null
    );
  },
  update(value: LiveGitGutterPresentation, tr: Transaction): LiveGitGutterPresentation {
    const baselineChanged = tr.effects.some((effect) => effect.is(setGitBaselineEffect));
    if (shouldDeferLiveInputDerivedWork(tr)) {
      return tr.docChanged ? { markers: value.markers.map(tr.changes), widgets: value.widgets.map(tr.changes) } : value;
    }
    const presentationChanged = !tr.startState.selection.eq(tr.state.selection)
      || getHtmlEditingRange(tr.startState) !== getHtmlEditingRange(tr.state);
    if (!tr.docChanged && !baselineChanged && !presentationChanged && !isLiveInputDerivedWorkRefresh(tr) && !isGitDiffResultRefresh(tr)) {
      return value;
    }
    return buildLiveGitGutterPresentation(
      tr.state,
      tr.state.field(gitDiffLineFlagsField, false) ?? null
    );
  }
});

const gitDiffGutterExtension = gutter({
  class: 'meo-git-gutter',
  renderEmptyElements: true,
  initialSpacer() {
    return spacerMarker;
  },
  markers(view: EditorView) {
    return (
      view.state.field(gitDiffGutterField, false) ??
      buildGitGutterMarkersFromLineFlags(view.state, view.state.field(gitDiffLineFlagsField, false) ?? null)
    );
  }
});

const gitDiffGutterLiveExtension = gutter({
  class: 'meo-git-gutter',
  renderEmptyElements: true,
  initialSpacer() {
    return spacerMarker;
  },
  markers(view: EditorView) {
    return view.state.field(gitDiffLiveGutterField).markers;
  },
  widgetMarker(view: EditorView, _widget: any, block: any) {
    // Gutter measurement is a read of the accepted presentation. Re-deriving
    // blocks here bypasses input deferral for every intermediate EditorState.
    let marker: GutterMarker | null = null;
    view.state.field(gitDiffLiveGutterField).widgets.between(block.from, block.from, (_from, _to, value) => { marker = value; });
    return marker;
  }
});

export function gitDiffGutterBaselineExtensions(): any[] {
  return [
    gitBaselineField,
    gitDiffLineFlagsField,
    backgroundDiffPlugin
  ];
}

export function gitDiffGutterRenderExtensions(): any[] {
  return [gitDiffGutterField, gitDiffGutterExtension];
}

export function gitDiffGutterLiveRenderExtensions(): any[] {
  return [gitDiffLiveGutterField, gitDiffGutterLiveExtension];
}

interface DiffSegment {
  fromLine: number;
  toLine: number;
  added: boolean;
  modified: boolean;
  deleted: boolean;
}

export type GitDiffLineCounts = {
  readonly added: number;
  readonly deleted: number;
};

export function getGitDiffComparison(state: EditorState): ChangesReviewComparison {
  const baseline = state.field(gitBaselineField);
  return {
    baseline: baseline.mode === 'fixed' ? 'manual' : baseline.mode ?? 'current-edit',
    generation: baseline.generation ?? -1
  };
}

export function getGitDiffSummary(state: EditorState): ChangesReviewDiffSummary {
  const lineFlags = state.field(gitDiffLineFlagsField, false) as GitDiffLineFlags | undefined;
  const computation = lineFlags?.[comparisonStatus];
  if (!computation || computation.status === 'pending' || !isCurrentComparison(state, lineFlags)) {
    return { status: 'pending', added: 0, deleted: 0 };
  }
  if (computation.status === 'unavailable') {
    return {
      status: 'unavailable',
      reason: computation.reason ?? 'error',
      added: 0,
      deleted: 0
    };
  }
  return { status: 'ready', ...getGitDiffLineCounts(state) };
}

export type GitDiffOriginalBlock = {
  readonly at: number;
  readonly side: -1 | 1;
  readonly lines: ReadonlyArray<{ readonly number: number; readonly text: string }>;
};

function collectOriginalRanges(lineFlags: ReadonlyArray<MarkerFlags | undefined>): Array<[number, number]> {
  return mergeLineRanges(lineFlags.flatMap((flags) => [
    ...(flags?.modifiedRanges ?? []),
    ...(flags?.deletionRanges ?? [])
  ]));
}

function countGitDiffLines(
  lineFlags: ReadonlyArray<MarkerFlags | undefined> | null | undefined
): GitDiffLineCounts {
  if (!Array.isArray(lineFlags)) return { added: 0, deleted: 0 };

  const added = lineFlags.reduce((count, flags) => (
    count + (flags && !flags.trailingEofProxyOnly && (flags.added || flags.modified) ? 1 : 0)
  ), 0);
  const deleted = collectOriginalRanges(lineFlags).reduce(
    (count, [fromLine, toLine]) => count + Math.max(0, toLine - fromLine + 1),
    0
  );
  return { added, deleted };
}

export function getGitDiffLineCounts(state: EditorState): GitDiffLineCounts {
  const flags = state.field(gitDiffLineFlagsField, false);
  if (!flags) return { added: 0, deleted: 0 };
  let counts = comparisonCounts.get(flags);
  if (!counts) { counts = countGitDiffLines(flags); comparisonCounts.set(flags, counts); }
  return counts;
}

export function getGitDiffOriginalBlocks(state: EditorState): GitDiffOriginalBlock[] {
  const lineFlags = state.field(gitDiffLineFlagsField, false);
  const baseline = state.field(gitBaselineField, false);
  if (!Array.isArray(lineFlags) || !baseline?.baseLines || !isCurrentComparison(state, lineFlags)) return [];

  const seenRanges = new Set<string>();
  const grouped = new Map<string, { at: number; side: -1 | 1; ranges: Array<[number, number]> }>();
  for (let index = 0; index < lineFlags.length; index += 1) {
    const flags = lineFlags[index];
    if (!flags) continue;
    const candidates = [
      ...(flags.modifiedRanges ?? []).map((range) => ({ range, atEnd: false })),
      ...(flags.deletionRanges ?? []).map((range) => ({ range, atEnd: flags.deletionAtEnd === true }))
    ];
    for (const { range, atEnd } of candidates) {
      const rangeKey = `${range[0]}:${range[1]}`;
      if (seenRanges.has(rangeKey)) continue;
      seenRanges.add(rangeKey);
      const at = atEnd ? state.doc.length : state.doc.line(Math.min(index + 1, state.doc.lines)).from;
      const side: -1 | 1 = atEnd ? 1 : -1;
      const groupKey = `${at}:${side}`;
      const group = grouped.get(groupKey) ?? { at, side, ranges: [] };
      group.ranges.push(range);
      grouped.set(groupKey, group);
    }
  }

  return Array.from(grouped.values())
    .map((group) => ({
      at: group.at,
      side: group.side,
      lines: mergeLineRanges(group.ranges).flatMap(([fromLine, toLine]) => {
        const lines = [];
        for (let line = fromLine; line <= toLine; line += 1) {
          lines.push({ number: line, text: baseline.baseLines?.[line - 1] ?? '' });
        }
        return lines;
      })
    }))
    .sort((left, right) => left.at - right.at || left.side - right.side);
}

export function getGitDiffOverviewSegments(state: EditorState): DiffSegment[] {
  const lineFlags = state.field(gitDiffLineFlagsField, false);
  if (!Array.isArray(lineFlags) || !lineFlags.length) {
    return [];
  }

  const segments: DiffSegment[] = [];
  let active: DiffSegment | null = null;

  const flush = () => {
    if (!active) {
      return;
    }
    segments.push(active);
    active = null;
  };

  for (let lineNo = 1; lineNo <= lineFlags.length; lineNo += 1) {
    const flags = lineFlags[lineNo - 1];
    const added = !!flags?.added;
    const modified = !!flags?.modified || !!flags?.trailingEofProxyOnly;
    const deleted = !!flags?.deleted;
    if (!added && !modified && !deleted) {
      flush();
      continue;
    }

    if (
      active &&
      active.toLine + 1 === lineNo &&
      active.added === added &&
      active.modified === modified &&
      active.deleted === deleted
    ) {
      active.toLine = lineNo;
      continue;
    }

    flush();
    active = { fromLine: lineNo, toLine: lineNo, added, modified, deleted };
  }

  flush();
  return segments;
}
