/** Cloneable source facts shared by the parser worker and editing surfaces. */
export interface FootnoteReference {
  from: number; to: number; containerFrom: number; containerTo: number;
  label: string; normalizedLabel: string; number: number | null;
  definition: FootnoteDefinition | null;
}

export interface FootnoteDefinition {
  label: string; normalizedLabel: string;
  markerFrom: number; markerTo: number; colonFrom: number; colonTo: number;
  contentFrom: number; contentTo: number; lineFrom: number; lineTo: number;
  number: number | null; firstReferenceFrom: number | null;
  continuationLines: FootnoteContinuationLine[]; isPrimary: boolean;
}

export interface FootnoteContinuationLine {
  from: number; to: number; hideIndentFrom: number | null; hideIndentTo: number | null;
  extraIndentColumns: number;
}

export interface ParsedFootnotes {
  references: FootnoteReference[]; definitions: FootnoteDefinition[];
  numberByLabel: Map<string, number>;
  referencesByContainerKey: Map<string, FootnoteReference[]>;
}

export type MarkdownBlockKind = 'table' | 'mermaid' | 'math' | 'html';
export interface MarkdownBlock {
  kind: MarkdownBlockKind; startLine: number; endLine: number; delimiterLine: number | null;
  lineNumberHiddenFrom: number; lineNumberHiddenTo: number;
}
export type DiscoveredMarkdownBlock = { block: MarkdownBlock; htmlFrom?: number };

export type MarkdownLiteralRange = { from: number; to: number; script?: boolean; htmlCode?: { from: number; to: number } };
export type MarkdownMathRange = {
  from: number; to: number; mode: 'inline' | 'display'; content: string; raw: string; fencedDisplay?: boolean;
  fenceSource?: { text: string; from: number; prefix: string };
};
export interface MarkdownDetailsBlock {
  kind: 'details'; anchorFrom: number; anchorTo: number; summaryFrom: number; summaryTo: number;
  lineFrom: number; lineTo: number; sectionFrom: number; sectionTo: number; bodyFrom: number; bodyTo: number;
  closingFrom: number; closingTo: number; summaryText: string; defaultCollapsed: boolean;
}
export type MarkdownPresentationContext = {
  blocks: DiscoveredMarkdownBlock[]; literals: MarkdownLiteralRange[]; math: MarkdownMathRange[]; details: MarkdownDetailsBlock[];
};

export type MarkdownContextPart =
  | { readonly kind: 'footnotes'; readonly value: ParsedFootnotes }
  | { readonly kind: 'blocks'; readonly value: MarkdownPresentationContext };
