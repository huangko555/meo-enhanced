import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState, type Transaction } from '@codemirror/state';
import type { SyntaxNode, Tree } from '@lezer/common';
import { isInsideFrontmatter, parseFrontmatter } from './frontmatter';

/** Returns CodeMirror's published, possibly partial tree without extending the parse synchronously. */
export function currentSyntaxTree(state: EditorState): ReturnType<typeof syntaxTree> {
  return syntaxTree(state);
}

/** Detects a parser publication transaction as well as a document-driven tree replacement. */
export function syntaxTreeChanged(transaction: Transaction): boolean {
  return syntaxTree(transaction.startState) !== syntaxTree(transaction.state);
}

/** Reads the normalized language/info token owned by a fenced-code syntax node. */
export function getFencedCodeInfo(state: EditorState, node: any): string | null {
  for (let child = node.node.firstChild; child; child = child.nextSibling) {
    if (child.name === 'CodeInfo') {
      return state.doc.sliceString(child.from, child.to).trim().toLowerCase();
    }
  }
  return null;
}

export function resolvedSyntaxTree(state: EditorState, timeout: number = 50): Tree {
  return ensureSyntaxTree(state, state.doc.length, timeout) ?? syntaxTree(state);
}
export function headingLevelFromName(name: string): number | null {
  const match = /^(?:ATXHeading([1-6])|SetextHeading([12]))$/.exec(name);
  return match ? Number(match[1] ?? match[2]) : null;
}

/** Content bounds exclude heading markers, including the entire Setext underline line. */
export function headingContentRange(state: EditorState, node: SyntaxNode): { from: number; to: number } {
  if (node.name.startsWith('SetextHeading')) {
    return { from: node.from, to: state.doc.lineAt(node.lastChild!.from).from - 1 };
  }
  const raw = state.doc.sliceString(node.from, node.to);
  const from = node.from + (raw.match(/^#{1,6}\s+/)?.[0].length ?? 0);
  return {
    from,
    to: Math.max(from, node.to - (raw.match(/\s+#+\s*$/)?.[0].length ?? 0))
  };
}

export interface HeadingInfo {
  level: number;
  text: string;
  inlineSegments?: HeadingInlineSegment[];
  line: number;
  from: number;
}

export interface HeadingInlineSegment {
  text: string;
  strong: boolean;
  emphasis: boolean;
  strikethrough: boolean;
  highlight: boolean;
}

export interface DetailsBlockInfo {
  kind: 'details';
  anchorFrom: number;
  anchorTo: number;
  summaryFrom: number;
  summaryTo: number;
  lineFrom: number;
  lineTo: number;
  sectionFrom: number;
  sectionTo: number;
  bodyFrom: number;
  bodyTo: number;
  closingFrom: number;
  closingTo: number;
  summaryText: string;
  defaultCollapsed: boolean;
}

const detailsOpenTagPattern = /<details\b[^>]*>/i;
const detailsCloseTagPattern = /<\/details\s*>/i;
const summaryTagPattern = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i;

function extractHeadingInlineSegments(state: EditorState, headingNode: any): HeadingInlineSegment[] {
  const { from: contentFrom, to: contentTo } = headingContentRange(state, headingNode);
  const hiddenRanges: Array<{ from: number; to: number }> = [];
  const styleRanges: Array<{
    from: number;
    to: number;
    style: 'strong' | 'emphasis' | 'strikethrough' | 'highlight';
  }> = [];

  const visit = (node: any, parentName = '') => {
    if (node.name === 'StrongEmphasis') styleRanges.push({ from: node.from, to: node.to, style: 'strong' });
    else if (node.name === 'Emphasis') styleRanges.push({ from: node.from, to: node.to, style: 'emphasis' });
    else if (node.name === 'Strikethrough') styleRanges.push({ from: node.from, to: node.to, style: 'strikethrough' });
    else if (node.name === 'Highlight') styleRanges.push({ from: node.from, to: node.to, style: 'highlight' });
    else if (
      node.name === 'EmphasisMark' ||
      node.name === 'StrikethroughMark' ||
      node.name === 'HighlightMark' ||
      node.name === 'CodeMark' ||
      node.name === 'LinkMark' ||
      node.name === 'LinkLabel' ||
      node.name === 'QuoteMark' ||
      (node.name === 'URL' && (parentName === 'Link' || parentName === 'Image'))
    ) {
      hiddenRanges.push({ from: node.from, to: node.to });
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, node.name);
  };
  visit(headingNode);

  const boundaries = new Set([contentFrom, contentTo]);
  for (const range of [...hiddenRanges, ...styleRanges]) {
    boundaries.add(Math.max(contentFrom, Math.min(contentTo, range.from)));
    boundaries.add(Math.max(contentFrom, Math.min(contentTo, range.to)));
  }
  const positions = [...boundaries].sort((left, right) => left - right);
  const segments: HeadingInlineSegment[] = [];
  for (let index = 0; index < positions.length - 1; index += 1) {
    const from = positions[index];
    const to = positions[index + 1];
    if (from === to || hiddenRanges.some((range) => from >= range.from && from < range.to)) continue;
    const styles = {
      strong: styleRanges.some((range) => range.style === 'strong' && from >= range.from && from < range.to),
      emphasis: styleRanges.some((range) => range.style === 'emphasis' && from >= range.from && from < range.to),
      strikethrough: styleRanges.some((range) => range.style === 'strikethrough' && from >= range.from && from < range.to),
      highlight: styleRanges.some((range) => range.style === 'highlight' && from >= range.from && from < range.to)
    };
    const text = state.doc.sliceString(from, to);
    segments.push({ text: headingNode.name.startsWith('SetextHeading') ? text.replace(/\s+/g, ' ') : text, ...styles });
  }
  return segments;
}

export function extractHeadings(state: EditorState, tree: Tree = resolvedSyntaxTree(state)): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const frontmatter = parseFrontmatter(state);

  tree.iterate({
    enter(node: any) {
      const headingLevel = headingLevelFromName(node.name);
      if (headingLevel !== null && !isInsideFrontmatter(frontmatter, node.from)) {
        const line = state.doc.lineAt(node.from);
        const inlineSegments = extractHeadingInlineSegments(state, node.node);
        const rawText = inlineSegments.map((segment) => segment.text).join('');
        const text = (node.name.startsWith('SetextHeading') ? rawText.replace(/\s+/g, ' ') : rawText).trim();
        headings.push({
          level: headingLevel,
          text,
          inlineSegments,
          line: line.number,
          from: node.from
        });
      }
    }
  });

  return headings;
}

function hasDetailsOpenAttribute(openTag: string): boolean {
  const attributeText = openTag
    .replace(/^<details\b/i, '')
    .replace(/>$/, '');
  return /(?:^|[\s/])open(?=[\s=/>]|$)/i.test(attributeText);
}

function normalizeSummaryText(rawText: string | undefined): string {
  const text = String(rawText ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text || 'Details';
}

export function extractDetailsBlocks(
  state: EditorState,
  tree: Tree = resolvedSyntaxTree(state)
): DetailsBlockInfo[] {
  const detailsBlocks: DetailsBlockInfo[] = [];
  const pendingBlocks: Array<{
    anchorFrom: number;
    anchorTo: number;
    summaryFrom: number;
    summaryTo: number;
    lineFrom: number;
    lineTo: number;
    summaryText: string;
    defaultCollapsed: boolean;
  }> = [];
  tree.iterate({
    enter(node: any) {
      if (node.name !== 'HTMLBlock') {
        return;
      }

      const rawText = state.doc.sliceString(node.from, node.to);
      const openTagMatch = rawText.match(detailsOpenTagPattern);
      if (openTagMatch) {
        const openingLine = state.doc.lineAt(node.from);
        const summaryMatch = rawText.match(summaryTagPattern);
        const openerTo = typeof summaryMatch?.index === 'number'
          ? node.from + summaryMatch.index + summaryMatch[0].length
          : openingLine.to;
        const summaryFrom = typeof summaryMatch?.index === 'number'
          ? node.from + summaryMatch.index
          : node.from;
        const summaryTo = typeof summaryMatch?.index === 'number'
          ? openerTo
          : openingLine.to;
        pendingBlocks.push({
          anchorFrom: node.from,
          anchorTo: openerTo,
          summaryFrom,
          summaryTo,
          lineFrom: openingLine.from,
          lineTo: openingLine.to,
          summaryText: normalizeSummaryText(summaryMatch?.[1]),
          defaultCollapsed: !hasDetailsOpenAttribute(openTagMatch[0])
        });
      }

      const closeTagMatch = rawText.match(detailsCloseTagPattern);
      if (!closeTagMatch || typeof closeTagMatch.index !== 'number') {
        return;
      }

      const openBlock = pendingBlocks.pop();
      if (!openBlock) {
        return;
      }

      const closingFrom = node.from + closeTagMatch.index;
      const closingLine = state.doc.lineAt(closingFrom);

      detailsBlocks.push({
        kind: 'details',
        anchorFrom: openBlock.anchorFrom,
        anchorTo: openBlock.anchorTo,
        summaryFrom: openBlock.summaryFrom,
        summaryTo: openBlock.summaryTo,
        lineFrom: openBlock.lineFrom,
        lineTo: openBlock.lineTo,
        sectionFrom: openBlock.anchorFrom,
        sectionTo: closingLine.to,
        bodyFrom: openBlock.anchorTo,
        bodyTo: closingFrom,
        closingFrom,
        closingTo: closingLine.to,
        summaryText: openBlock.summaryText,
        defaultCollapsed: openBlock.defaultCollapsed
      });
    }
  });

  detailsBlocks.sort((a, b) => a.anchorFrom - b.anchorFrom);
  return detailsBlocks;
}
