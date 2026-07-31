import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { collectPunctuationClosingInlineStyles, type InlineStyleNodeName } from './inlineStyleFallback';

export function resolvedSyntaxTree(state: EditorState, timeout: number = 50): any {
  return ensureSyntaxTree(state, state.doc.length, timeout) ?? syntaxTree(state);
}

export function headingLevelFromName(name: string): number | null {
  if (!name.startsWith('ATXHeading')) {
    return null;
  }

  const level = Number.parseInt(name.slice('ATXHeading'.length), 10);
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : null;
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

export interface HeadingSection extends HeadingInfo {
  sectionFrom: number;
  sectionTo: number;
  headingFrom: number;
  headingTo: number;
  lineFrom: number;
  lineTo: number;
  collapseFrom: number;
  collapseTo: number;
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
  const raw = state.doc.sliceString(headingNode.from, headingNode.to);
  const prefixLength = raw.match(/^#{1,6}\s+/)?.[0].length ?? 0;
  const suffixLength = raw.match(/\s+#+\s*$/)?.[0].length ?? 0;
  const contentFrom = headingNode.from + prefixLength;
  const contentTo = Math.max(contentFrom, headingNode.to - suffixLength);
  const hiddenRanges: Array<{ from: number; to: number }> = [];
  const styleRanges: Array<{
    from: number;
    to: number;
    style: 'strong' | 'emphasis' | 'strikethrough' | 'highlight';
    nodeName: InlineStyleNodeName;
  }> = [];

  const visit = (node: any, parentName = '') => {
    if (node.name === 'StrongEmphasis') styleRanges.push({ from: node.from, to: node.to, style: 'strong', nodeName: node.name });
    else if (node.name === 'Emphasis') styleRanges.push({ from: node.from, to: node.to, style: 'emphasis', nodeName: node.name });
    else if (node.name === 'Strikethrough') styleRanges.push({ from: node.from, to: node.to, style: 'strikethrough', nodeName: node.name });
    else if (node.name === 'Highlight') styleRanges.push({ from: node.from, to: node.to, style: 'highlight', nodeName: node.name });
    else if (
      node.name === 'EmphasisMark' ||
      node.name === 'StrikethroughMark' ||
      node.name === 'HighlightMark' ||
      node.name === 'CodeMark' ||
      node.name === 'LinkMark' ||
      node.name === 'LinkLabel' ||
      (node.name === 'URL' && (parentName === 'Link' || parentName === 'Image'))
    ) {
      hiddenRanges.push({ from: node.from, to: node.to });
    }
    for (let child = node.firstChild; child; child = child.nextSibling) visit(child, node.name);
  };
  visit(headingNode);

  const fallbackStyleByNodeName = {
    StrongEmphasis: 'strong',
    Emphasis: 'emphasis',
    Strikethrough: 'strikethrough',
    Highlight: 'highlight'
  } as const;
  for (const range of collectPunctuationClosingInlineStyles(raw, headingNode.from, styleRanges)) {
    styleRanges.push({
      from: range.from,
      to: range.to,
      style: fallbackStyleByNodeName[range.nodeName],
      nodeName: range.nodeName
    });
    hiddenRanges.push(
      { from: range.from, to: range.contentFrom },
      { from: range.closeFrom, to: range.to }
    );
  }

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
    segments.push({ text: state.doc.sliceString(from, to), ...styles });
  }
  return segments;
}

export function extractHeadings(state: EditorState): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const tree = resolvedSyntaxTree(state);

  tree.iterate({
    enter(node: any) {
      const headingLevel = headingLevelFromName(node.name);
      if (headingLevel !== null) {
        const line = state.doc.lineAt(node.from);
        const inlineSegments = extractHeadingInlineSegments(state, node.node);
        const text = inlineSegments.map((segment) => segment.text).join('').trim();
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

export function extractDetailsBlocks(state: EditorState): DetailsBlockInfo[] {
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
  const tree = resolvedSyntaxTree(state);

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

export function extractHeadingSections(state: EditorState): HeadingSection[] {
  const headings: HeadingSection[] = [];
  const tree = resolvedSyntaxTree(state);

  tree.iterate({
    enter(node: any) {
      const headingLevel = headingLevelFromName(node.name);
      if (headingLevel === null) {
        return;
      }

      const line = state.doc.lineAt(node.from);
      let text = state.doc.sliceString(node.from, node.to);
      text = text.replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '').trim();
      headings.push({
        level: headingLevel,
        text,
        from: node.from,
        line: line.number,
        sectionFrom: node.from,
        sectionTo: state.doc.length,
        headingFrom: node.from,
        headingTo: node.to,
        lineFrom: line.from,
        lineTo: line.to,
        collapseFrom: line.to,
        collapseTo: state.doc.length
      });
    }
  });

  for (let index = 0; index < headings.length; index += 1) {
    const heading = headings[index];
    for (let nextIndex = index + 1; nextIndex < headings.length; nextIndex += 1) {
      const nextHeading = headings[nextIndex];
      if (nextHeading.level <= heading.level) {
        heading.sectionTo = nextHeading.headingFrom;
        const previousLineNo = Math.max(heading.line, nextHeading.line - 1);
        heading.collapseTo = state.doc.line(previousLineNo).to;
        break;
      }
    }
  }

  return headings;
}
