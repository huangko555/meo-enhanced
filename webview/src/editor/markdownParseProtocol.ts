import type { MarkdownTreeTransfer } from './markdownTreeTransfer';
import type { ParsedFootnotes, DiscoveredMarkdownBlock } from '../../../src/foundation/markdownDocumentContext';

export type MarkdownParseRequest = { readonly id: number; readonly base: number; readonly tabSize: number; readonly blocks: boolean } & (
  | { readonly text: string; readonly changes?: never }
  | { readonly changes: unknown; readonly text?: never }
);
export type MarkdownParseResponse = { readonly id: number } & (
  | { readonly kind: 'syntax'; readonly grammar: string; readonly length: number; readonly tree: MarkdownTreeTransfer;
      readonly tabSize: number; readonly footnotes: ParsedFootnotes; readonly error?: never }
  | { readonly kind: 'blocks'; readonly tabSize: number; readonly value: DiscoveredMarkdownBlock[]; readonly error?: never }
  | { readonly error: string; readonly tree?: never }
);
