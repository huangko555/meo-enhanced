import { RangeSetBuilder, StateEffect, StateField, EditorState, Transaction } from '@codemirror/state';
import { GutterMarker, gutter, EditorView } from '@codemirror/view';
import {
  compareDocuments,
  splitDiffLines
} from '../../../src/shared/gitDiffCore';
import { getLiveGitCollapsedBlockAtLine, getLiveGitCollapsedBlocks } from './liveRenderedBlocks';
import { createGitDiffMarkerElement } from './gitDiffMarkerDom';
import {
  clearTableRowDiffProvenanceEffect,
  getDeletedTableRows,
  tableRowDiffProvenanceField,
  tableRowDiffProvenanceHistoryExtension
} from './tableRowDiffProvenance';

const MAX_DIFF_TEXT_CHARS = 1024 * 1024;
const MAX_DIFF_LINES = 1200;
const MAX_DIFF_CELLS = 1_500_000;
const MAX_DIFF_COMPUTATION_TIME_MS = 50;
const NON_RENDERABLE_GIT_BASELINE_REASONS = new Set(['not-repo', 'ignored']);

export const setGitBaselineEffect = StateEffect.define<any>();

interface BaselineSnapshot {
  available: boolean;
  tracked: boolean;
  baseText: string | null;
  baseLines: string[] | null;
  mode?: 'current-edit' | 'recent-save' | 'git-head';
  headOid?: string | null;
  reason?: 'not-file' | 'git-unavailable' | 'not-repo' | 'ignored' | 'too-large' | 'binary' | 'error';
}

export interface MarkerFlags {
  added: boolean;
  modified: boolean;
  baselineLineNumber?: number;
  modifiedRanges?: Array<[number, number]>;
  deleted?: boolean;
  deletionBoundary?: number;
  deletionAtEnd?: boolean;
  baselineFromLine?: number;
  baselineToLine?: number;
  deletionRanges?: Array<[number, number]>;
  eofProxy?: boolean;
  trailingEofProxyOnly?: boolean;
  trailingEofProxySource?: boolean;
  liveBlockStartLine?: number;
  liveBlockEndLine?: number;
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
    mode: snapshot.mode === 'current-edit' || snapshot.mode === 'recent-save' || snapshot.mode === 'git-head'
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

function canRenderGitDiffBaseline(snapshot: BaselineSnapshot | null): boolean {
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

function buildDiffLineFlags(state: EditorState, baseline: BaselineSnapshot | null): (MarkerFlags | undefined)[] | null {
  if (!canRenderGitDiffBaseline(baseline)) {
    return null;
  }

  if (typeof baseline.baseText !== 'string') {
    if (!baseline.tracked || baseline.headOid === null) {
      const lineFlags: (MarkerFlags | undefined)[] = new Array(state.doc.lines);
      const textLength = state.doc.length;
      if (!textLength && state.doc.lines === 1 && state.doc.sliceString(0, state.doc.length) === '') {
        return lineFlags;
      }
      for (let i = 0; i < state.doc.lines; i += 1) {
        lineFlags[i] = { ...emptyMarkerFlags(), added: true };
      }
      return lineFlags;
    }
    return null;
  }

  if (state.doc.length > MAX_DIFF_TEXT_CHARS || baseline.baseText.length > MAX_DIFF_TEXT_CHARS) {
    return null;
  }

  const baselineLineCount = baseline.baseLines?.length ?? splitDiffLines(baseline.baseText).length;
  if (
    state.doc.lines > MAX_DIFF_LINES ||
    baselineLineCount > MAX_DIFF_LINES ||
    state.doc.lines * baselineLineCount > MAX_DIFF_CELLS
  ) {
    return null;
  }

  const result = compareDocuments(baseline.baseText, state.doc.sliceString(0, state.doc.length), {
    maxComputationTimeMs: MAX_DIFF_COMPUTATION_TIME_MS
  });
  if (result.hitTimeout || result.failed) {
    return null;
  }
  const lineFlags: (MarkerFlags | undefined)[] = new Array(state.doc.lines);
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

  const provenance = state.field(tableRowDiffProvenanceField, false);
  provenance?.insertedRanges.between(0, state.doc.length, (from) => {
    const lineIndex = state.doc.lineAt(from).number - 1;
    lineFlags[lineIndex] = {
      ...(lineFlags[lineIndex] ?? emptyMarkerFlags()),
      added: true,
      modified: false,
      modifiedRanges: undefined
    };
  });

  const deletedRows = getDeletedTableRows(state);
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
  return coalesceTrailingEofVisualLineFlag(state.doc, buildDiffLineFlags(state, baseline));
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
    const line = state.doc.line(lineNo);

    while (activeCollapsedBlock && lineNo > activeCollapsedBlock.endLine) {
      collapsedBlockIndex += 1;
      activeCollapsedBlock = collapsedBlocks[collapsedBlockIndex] ?? null;
      activeCollapsedFlags = activeCollapsedBlock ? liveCollapsedBlockMarkerFlags(activeCollapsedBlock, lineFlags) : null;
    }

    if (activeCollapsedBlock && lineNo >= activeCollapsedBlock.startLine && activeCollapsedFlags) {
      if (!activeCollapsedFlags.deleted) {
        builder.add(line.from, line.from, gitMarker(activeCollapsedFlags));
      }
      continue;
    }

    if (isTrailingEofVisualLine(state.doc, lineNo)) {
      if (trailingEofProxyFlags) {
        builder.add(line.from, line.from, gitMarker(trailingEofProxyFlags));
      }
      continue;
    }

    const flags = lineFlags[lineNo - 1];
    if (!flags || flags.trailingEofProxyOnly || (!flags.added && !flags.modified && !flags.deleted)) {
      continue;
    }
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

function liveCollapsedBlockMarkerAtPos(
  state: EditorState,
  lineFlags: (MarkerFlags | undefined)[] | null,
  pos: number
): GitGutterMarker | null {
  if (!Array.isArray(lineFlags)) {
    return null;
  }
  const lineNo = state.doc.lineAt(Math.max(0, Math.min(pos, state.doc.length))).number;
  const block = getLiveGitCollapsedBlockAtLine(state, lineFlags, lineNo);
  // Tables render one marker per visible source row inside their widget. Keeping
  // the collapsed widget marker would paint the entire table as one change.
  return block && block.kind !== 'table' ? gitMarker(liveCollapsedBlockMarkerFlags(block, lineFlags)) : null;
}

export const gitDiffLineFlagsField = StateField.define<(MarkerFlags | undefined)[] | null>({
  create(state: EditorState): (MarkerFlags | undefined)[] | null {
    return buildCoalescedDiffLineFlags(state, state.field(gitBaselineField));
  },
  update(value: (MarkerFlags | undefined)[] | null, tr: Transaction): (MarkerFlags | undefined)[] | null {
    let baselineChanged = false;
    for (const effect of tr.effects) {
      if (effect.is(setGitBaselineEffect)) {
        baselineChanged = true;
        break;
      }
    }
    if (!tr.docChanged && !baselineChanged) {
      return value;
    }
    const baseline = tr.state.field(gitBaselineField);
    return buildCoalescedDiffLineFlags(tr.state, baseline);
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
    if (!tr.docChanged && !baselineChanged) {
      return value;
    }
    return buildGitGutterMarkersFromLineFlags(tr.state, tr.state.field(gitDiffLineFlagsField));
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
      buildGitGutterMarkersFromLineFlags(view.state, view.state.field(gitDiffLineFlagsField, false))
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
    return buildLiveGitGutterMarkersFromLineFlags(view.state, view.state.field(gitDiffLineFlagsField, false));
  },
  widgetMarker(view: EditorView, _widget: any, block: any) {
    return liveCollapsedBlockMarkerAtPos(view.state, view.state.field(gitDiffLineFlagsField, false), block.from);
  }
});

export function gitDiffGutterBaselineExtensions(): any[] {
  return [
    gitBaselineField,
    tableRowDiffProvenanceField,
    tableRowDiffProvenanceHistoryExtension,
    gitDiffLineFlagsField
  ];
}

export function gitDiffGutterRenderExtensions(): any[] {
  return [gitDiffGutterField, gitDiffGutterExtension];
}

export function gitDiffGutterLiveRenderExtensions(): any[] {
  return [gitDiffGutterLiveExtension];
}

interface DiffSegment {
  fromLine: number;
  toLine: number;
  added: boolean;
  modified: boolean;
  deleted: boolean;
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

export function setGitBaseline(view: EditorView, snapshot: any): void {
  view.dispatch({
    effects: [
      setGitBaselineEffect.of(snapshot),
      clearTableRowDiffProvenanceEffect.of(null)
    ]
  });
}

export function getDeletedGapPreview(
  state: EditorState,
  baselineFromLine: number,
  baselineToLine: number,
  options: { maxLines?: number; maxChars?: number } = {}
): { text: string; totalLines: number; shownLines: number; truncated: boolean } | null {
  return getDeletedGapRangesPreview(state, [[baselineFromLine, baselineToLine]], options);
}

export function getDeletedGapRangesPreview(
  state: EditorState,
  ranges: ReadonlyArray<readonly [number, number]>,
  options: { maxLines?: number; maxChars?: number } = {}
): { text: string; totalLines: number; shownLines: number; truncated: boolean } | null {
  return getBaselineRangesPreview(state, ranges, options);
}

export function getBaselineRangesPreview(
  state: EditorState,
  ranges: ReadonlyArray<readonly [number, number]>,
  options: { maxLines?: number; maxChars?: number } = {}
): { text: string; totalLines: number; shownLines: number; truncated: boolean } | null {
  const baseline = state.field(gitBaselineField, false);
  const validRanges = ranges.filter(([fromLine, toLine]) => (
    Number.isInteger(fromLine) && Number.isInteger(toLine) && fromLine >= 1 && toLine >= fromLine
  ));
  if (!baseline?.baseLines || !validRanges.length) {
    return null;
  }
  const totalLines = validRanges.reduce((total, [fromLine, toLine]) => total + toLine - fromLine + 1, 0);
  const maxLines = Math.max(1, options.maxLines ?? 20);
  const maxChars = Math.max(1, options.maxChars ?? 4096);
  const chunks: string[] = [];
  let shownLines = 0;
  for (const [fromLine, toLine] of validRanges) {
    const remainingLines = maxLines - shownLines;
    if (remainingLines <= 0) {
      break;
    }
    const selected = baseline.baseLines.slice(fromLine - 1, Math.min(toLine, fromLine - 1 + remainingLines));
    chunks.push(selected.join('\n'));
    shownLines += selected.length;
  }
  let text = chunks.join('\n…\n');
  let truncated = shownLines < totalLines;
  if (text.length > maxChars) {
    text = text.slice(0, maxChars);
    truncated = true;
  }
  return {
    text,
    totalLines,
    shownLines,
    truncated
  };
}
