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

export type MarkdownContextPart =
  | { readonly kind: 'footnotes'; readonly value: ParsedFootnotes }
  | { readonly kind: 'blocks'; readonly value: DiscoveredMarkdownBlock[] };
