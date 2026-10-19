import { documentLines } from './documentLines';
import { EditorState, type ChangeDesc } from '@codemirror/state';
import { IterMode, type SyntaxNode, type SyntaxNodeRef, type Tree } from '@lezer/common';
import { isThematicBreakLine } from './frontmatter';
import { parseBlockLinePrefix } from './blockIndent';
import { getFencedCodeInfo, resolvedSyntaxTree } from './markdownSyntax';
import { resolveFencedDisplayMathInnerLineRange } from './math';
import { collectDocumentMathRanges } from './displayMathBlocks';
import { isTableDelimiterLine, parseTableInfo } from './tables';
import { collectRenderableHtmlBlocks, getHtmlEditingRange } from './htmlContent';

type LineFlagLike = {
  added?: boolean;
  modified?: boolean;
  deleted?: boolean;
  trailingEofProxyOnly?: boolean;
} | undefined;

export type LiveRenderedBlockKind = 'table' | 'mermaid' | 'math' | 'html';
export type LiveGitChangeKind = 'added' | 'modified' | 'deleted';

export interface LiveRenderedBlock {
  kind: LiveRenderedBlockKind;
  startLine: number;
  endLine: number;
  delimiterLine: number | null;
  lineNumberHiddenFrom: number;
  lineNumberHiddenTo: number;
}

export interface LiveCollapsedGitBlock {
  kind: LiveRenderedBlockKind;
  startLine: number;
  endLine: number;
  canonicalLine: number;
  aggregateChangeKind: LiveGitChangeKind;
  containsLine(lineNo: number): boolean;
}

const renderedBlockCache = new WeakMap<EditorState, { tree: any; blocks: LiveRenderedBlock[] }>();
type DiscoveredBlock = { block: LiveRenderedBlock; htmlFrom?: number };
// Discovery depends on text and the resolved parse. Selection and HTML editing
// only filter that discovery; they must not invalidate its whole-document scans.
const discoveredBlockCache = new WeakMap<EditorState['doc'], { tree: Tree; blocks: DiscoveredBlock[] }>();

/** The caller proves a complete plain-prose projection with unchanged rich
 * membership. Map line coordinates and HTML editing anchors without discovering
 * the same blocks again. Never warm a missing or provisional index. */
export function projectUnchangedLiveRenderedBlocks(
  before: EditorState,
  state: EditorState,
  changes: ChangeDesc,
  oldTree: Tree,
  newTree: Tree
): void {
  const previous = discoveredBlockCache.get(before.doc);
  if (!previous || previous.tree !== oldTree || oldTree.length !== before.doc.length
    || newTree.length !== state.doc.length || before.tabSize !== state.tabSize) return;
  let unchangedLines = true;
  changes.iterChangedRanges((from, to, nextFrom, nextTo) => {
    if (before.doc.lineAt(from).number !== before.doc.lineAt(to).number
      || state.doc.lineAt(nextFrom).number !== state.doc.lineAt(nextTo).number) unchangedLines = false;
  });
  const lineMap = new Map<number, number>();
  const mapLine = (line: number) => {
    let mapped = lineMap.get(line);
    if (mapped === undefined) {
      mapped = state.doc.lineAt(changes.mapPos(before.doc.line(line).from, 1)).number;
      lineMap.set(line, mapped);
    }
    return mapped;
  };
  const blocks = previous.blocks.map(({ block, htmlFrom }) => {
    let mapped = block;
    if (!unchangedLines) {
      const startLine = mapLine(block.startLine), endLine = mapLine(block.endLine);
      mapped = { ...block, startLine, endLine,
        delimiterLine: block.delimiterLine === null ? null : mapLine(block.delimiterLine),
        // Empty HTML/code ranges still follow their block edges. Only the
        // explicit 1..0 sentinel is independent of source line coordinates.
        ...(block.lineNumberHiddenFrom === 1 && block.lineNumberHiddenTo === 0 ? {} : {
          lineNumberHiddenFrom: block.lineNumberHiddenFrom + startLine - block.startLine,
          lineNumberHiddenTo: block.lineNumberHiddenTo + endLine - block.endLine
        })
      };
    }
    return { block: mapped, htmlFrom: htmlFrom === undefined ? undefined : changes.mapPos(htmlFrom, 1) };
  });
  discoveredBlockCache.set(state.doc, { tree: newTree, blocks });
}
const collapsedBlockCache = new WeakMap<EditorState, {
  lineFlags: readonly LineFlagLike[];
  blocks: LiveCollapsedGitBlock[];
}>();

function createRenderedBlock(
  kind: LiveRenderedBlockKind,
  startLine: number,
  endLine: number,
  delimiterLine: number | null
): LiveRenderedBlock | null {
  if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < startLine) {
    return null;
  }

  if (kind === 'table') {
    return {
      kind,
      startLine,
      endLine,
      delimiterLine,
      lineNumberHiddenFrom: 1,
      lineNumberHiddenTo: 0
    };
  }

  return {
    kind,
    startLine,
    endLine,
    delimiterLine: null,
    lineNumberHiddenFrom: startLine + 1,
    lineNumberHiddenTo: endLine - 1
  };
}

function rangesOverlap(fromA: number, toA: number, fromB: number, toB: number): boolean {
  return fromA < toB && toA > fromB;
}

function isTableContentLine(lineText: string): boolean {
  return lineText.includes('|');
}

function isInsideCodeBlock(tree: Tree, pos: number): boolean {
  for (let node: SyntaxNode | null = tree.cursor(IterMode.IgnoreMounts).moveTo(pos, 1).node; node; node = node.parent) {
    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      return true;
    }
  }
  return false;
}

function detectFallbackTableBlocks(
  state: EditorState,
  tree: any,
  parsedTableRanges: Array<{ from: number; to: number }>
): LiveRenderedBlock[] {
  const blocks: LiveRenderedBlock[] = [];

  let scannedThrough = 1;
  for (const delimiterLine of documentLines(state.doc)) {
    const lineNo = delimiterLine.number;
    if (lineNo <= scannedThrough) continue;
    const delimiterText = delimiterLine.text;
    if (isThematicBreakLine(delimiterText)) continue;
    if (!isTableDelimiterLine(delimiterText)) continue;
    const prefix = parseBlockLinePrefix(delimiterText, state.tabSize).prefix;

    const headerLineNo = lineNo - 1;
    const headerLine = state.doc.line(headerLineNo);
    const headerText = headerLine.text;
    if (!isTableContentLine(headerText) || parseBlockLinePrefix(headerText, state.tabSize).prefix !== prefix) continue;

    let endLineNo = lineNo;
    for (let rowLineNo = lineNo + 1; rowLineNo <= state.doc.lines; rowLineNo += 1) {
      const rowLine = state.doc.line(rowLineNo);
      const rowText = rowLine.text;
      if (!isTableContentLine(rowText) || parseBlockLinePrefix(rowText, state.tabSize).prefix !== prefix) break;
      endLineNo = rowLineNo;
    }

    const from = state.doc.line(headerLineNo).from;
    const to = state.doc.line(endLineNo).to;
    if (parsedTableRanges.some((range) => rangesOverlap(from, to, range.from, range.to))) {
      scannedThrough = endLineNo;
      continue;
    }
    if (isInsideCodeBlock(tree, from)) {
      scannedThrough = endLineNo;
      continue;
    }
    const block = createRenderedBlock('table', headerLineNo, endLineNo, lineNo);
    if (block) {
      blocks.push(block);
    }
    scannedThrough = endLineNo;
  }

  return blocks;
}

function resolveMathHiddenLineRange(
  startLine: number,
  endLine: number
): { from: number; to: number } | null {
  const innerLineRange = resolveFencedDisplayMathInnerLineRange(
    startLine,
    endLine
  );
  if (!innerLineRange) {
    return null;
  }

  return {
    from: innerLineRange.innerStartLine,
    to: innerLineRange.innerEndLine
  };
}

function selectionTouchesLineRange(state: EditorState, startLine: number, endLine: number): boolean {
  for (const range of state.selection.ranges) {
    const rangeStartLine = state.doc.lineAt(range.from).number;
    const rangeEndPos = range.to > range.from ? range.to - 1 : range.to;
    const rangeEndLine = state.doc.lineAt(rangeEndPos).number;
    if (rangeStartLine <= endLine && rangeEndLine >= startLine) {
      return true;
    }
  }
  return false;
}

/** Geometry readers can pass this state's published tree to avoid synchronous parsing. */
export function getLiveRenderedBlocks(
  state: EditorState,
  options: { includeSelectedMath?: boolean; tree?: Tree } = {}
): LiveRenderedBlock[] {
  const tree = options.tree ?? resolvedSyntaxTree(state);
  const cached = renderedBlockCache.get(state);
  if (!options.includeSelectedMath && cached && cached.tree === tree) {
    return cached.blocks;
  }

  let discovered = discoveredBlockCache.get(state.doc);
  if (!discovered || discovered.tree !== tree) {
    discovered = { tree, blocks: discoverRenderedBlocks(state, tree) };
    discoveredBlockCache.set(state.doc, discovered);
  }
  const htmlEditingRange = getHtmlEditingRange(state);
  const blocks = discovered.blocks.filter(({ block, htmlFrom }) => {
    if (block.kind === 'html' && htmlEditingRange?.from === htmlFrom) return false;
    return block.kind !== 'math' || options.includeSelectedMath
      || block.lineNumberHiddenTo < block.lineNumberHiddenFrom
      || !selectionTouchesLineRange(state, block.startLine, block.endLine);
  }).map(({ block }) => ({ ...block }));
  if (!options.includeSelectedMath) renderedBlockCache.set(state, { tree, blocks });
  return blocks;
}

function discoverRenderedBlocks(state: EditorState, tree: Tree): DiscoveredBlock[] {
  const blocks: LiveRenderedBlock[] = [];
  const htmlFromByBlock = new Map<LiveRenderedBlock, number>();
  const parsedTableRanges: Array<{ from: number; to: number }> = [];

  tree.iterate({
    mode: IterMode.IgnoreMounts,
    enter(node: SyntaxNodeRef) {
      if (node.name === 'Table') {
        const tableInfo = parseTableInfo(state, node);
        parsedTableRanges.push({ from: tableInfo.from, to: tableInfo.to });
        const block = createRenderedBlock(
          'table',
          tableInfo.startLine,
          tableInfo.endLine,
          tableInfo.delimiterRow?.lineNo ?? null
        );
        if (block) {
          blocks.push(block);
        }
        return;
      }

      if (node.name !== 'FencedCode') {
        return;
      }

      if (getFencedCodeInfo(state, node) !== 'mermaid') {
        return;
      }

      const startLine = state.doc.lineAt(node.from).number;
      const endLine = state.doc.lineAt(Math.max(node.to - 1, node.from)).number;
      const block = createRenderedBlock('mermaid', startLine, endLine, null);
      if (block) {
        blocks.push(block);
      }
    }
  });

  const mathRanges = collectDocumentMathRanges(state, tree, parsedTableRanges);
  for (const mathRange of mathRanges) {
    if (mathRange.mode !== 'display' || mathRange.fencedDisplay !== true) {
      continue;
    }
    const startLine = state.doc.lineAt(mathRange.from).number;
    const endLine = state.doc.lineAt(Math.max(mathRange.to - 1, mathRange.from)).number;
    if (endLine <= startLine) {
      continue;
    }
    const hiddenRange = resolveMathHiddenLineRange(startLine, endLine);
    const block = createRenderedBlock('math', startLine, endLine, null);
    if (block) {
      if (hiddenRange) {
        block.lineNumberHiddenFrom = hiddenRange.from;
        block.lineNumberHiddenTo = hiddenRange.to;
      } else {
        block.lineNumberHiddenFrom = 1;
        block.lineNumberHiddenTo = 0;
      }
      blocks.push(block);
    }
  }

  for (const htmlBlock of collectRenderableHtmlBlocks(state, tree)) {
    const block = createRenderedBlock('html', htmlBlock.startLine, htmlBlock.endLine, null);
    if (!block) continue;
    block.lineNumberHiddenFrom = htmlBlock.startLine + 1;
    block.lineNumberHiddenTo = htmlBlock.endLine;
    htmlFromByBlock.set(block, htmlBlock.from);
    blocks.push(block);
  }

  blocks.push(...detectFallbackTableBlocks(state, tree, parsedTableRanges));
  blocks.sort((left, right) => (
    left.startLine - right.startLine ||
    left.endLine - right.endLine
  ));
  return blocks.map(block => ({ block, htmlFrom: htmlFromByBlock.get(block) }));
}

function createCollapsedBlock(
  block: LiveRenderedBlock,
  canonicalLine: number,
  aggregateChangeKind: LiveGitChangeKind
): LiveCollapsedGitBlock {
  return {
    kind: block.kind,
    startLine: block.startLine,
    endLine: block.endLine,
    canonicalLine,
    aggregateChangeKind,
    containsLine(lineNo: number): boolean {
      return lineNo >= block.startLine && lineNo <= block.endLine;
    }
  };
}

function buildCollapsedBlock(
  block: LiveRenderedBlock,
  lineFlags: readonly LineFlagLike[] | null | undefined
): LiveCollapsedGitBlock | null {
  if (!Array.isArray(lineFlags) || !lineFlags.length) {
    return null;
  }

  let firstChangedLine = 0;
  let hasModified = false;
  let hasAdded = false;
  let hasDeleted = false;
  let hasNonDelimiterChange = false;

  for (let lineNo = block.startLine; lineNo <= block.endLine; lineNo += 1) {
    const flags = lineFlags[lineNo - 1];
    const modified = !!(flags?.modified || flags?.trailingEofProxyOnly);
    const added = !!flags?.added;
    const deleted = !!flags?.deleted;
    if (!modified && !added && !deleted) {
      continue;
    }
    if (!firstChangedLine) {
      firstChangedLine = lineNo;
    }
    if (lineNo !== block.delimiterLine) {
      hasNonDelimiterChange = true;
    }
    if (modified) {
      hasModified = true;
      continue;
    }
    if (added) {
      hasAdded = true;
      continue;
    }
    hasDeleted = true;
  }

  if (!firstChangedLine || (!hasModified && !hasAdded && !hasDeleted)) {
    return null;
  }

  let canonicalLine = firstChangedLine;
  if (
    block.kind === 'table' &&
    block.delimiterLine !== null &&
    !hasNonDelimiterChange &&
    firstChangedLine === block.delimiterLine
  ) {
    canonicalLine = block.startLine;
  }

  const aggregateChangeKind = hasModified ? 'modified' : hasAdded ? 'added' : 'deleted';
  return createCollapsedBlock(block, canonicalLine || block.startLine, aggregateChangeKind);
}

function findCollapsedBlockAtLine(
  blocks: readonly LiveCollapsedGitBlock[],
  lineNo: number
): LiveCollapsedGitBlock | null {
  let low = 0;
  let high = blocks.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const block = blocks[mid];
    if (lineNo < block.startLine) {
      high = mid - 1;
      continue;
    }
    if (lineNo > block.endLine) {
      low = mid + 1;
      continue;
    }
    return block;
  }

  return null;
}

function findRenderedBlockAtLine(
  blocks: readonly LiveRenderedBlock[],
  lineNo: number
): LiveRenderedBlock | null {
  let low = 0;
  let high = blocks.length - 1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const block = blocks[mid];
    if (lineNo < block.startLine) {
      high = mid - 1;
      continue;
    }
    if (lineNo > block.endLine) {
      low = mid + 1;
      continue;
    }
    return block;
  }

  return null;
}

export function getLiveRenderedBlockAtLine(
  state: EditorState,
  lineNo: number
): LiveRenderedBlock | null {
  const blocks = getLiveRenderedBlocks(state);
  if (!blocks.length) {
    return null;
  }
  return findRenderedBlockAtLine(blocks, Math.max(1, Math.floor(lineNo)));
}

export function getLiveGitCollapsedBlocks(
  state: EditorState,
  lineFlags: readonly LineFlagLike[] | null | undefined
): LiveCollapsedGitBlock[] {
  if (!Array.isArray(lineFlags) || !lineFlags.length) {
    return [];
  }

  const cached = collapsedBlockCache.get(state);
  if (cached?.lineFlags === lineFlags) {
    return cached.blocks;
  }

  const collapsed: LiveCollapsedGitBlock[] = [];
  for (const block of getLiveRenderedBlocks(state)) {
    const next = buildCollapsedBlock(block, lineFlags);
    if (next) {
      collapsed.push(next);
    }
  }
  collapsedBlockCache.set(state, { lineFlags, blocks: collapsed });
  return collapsed;
}

export function getLiveGitCollapsedBlockAtLine(
  state: EditorState,
  lineFlags: readonly LineFlagLike[] | null | undefined,
  lineNo: number
): LiveCollapsedGitBlock | null {
  const blocks = getLiveGitCollapsedBlocks(state, lineFlags);
  if (!blocks.length) {
    return null;
  }
  return findCollapsedBlockAtLine(blocks, Math.max(1, Math.floor(lineNo)));
}
