import type { MarkdownTreeTransfer } from './markdownTreeTransfer';
import type { ParsedFootnotes, MarkdownPresentationContext, MarkdownCodeFence } from '../../../src/foundation/markdownDocumentContext';

export type MarkdownParseRequest = { readonly id: number; readonly base: number; readonly tabSize: number; readonly blocks: boolean } & (
  | { readonly text: string; readonly changes?: never }
  | { readonly changes: unknown; readonly text?: never }
);
type SourceContextReceipt =
  | { readonly footnotes: ParsedFootnotes; readonly code: readonly MarkdownCodeFence[]; readonly projectedFrom?: never }
  | { readonly projectedFrom: number; readonly footnotes?: never; readonly code?: never };
type PresentationContextReceipt =
  | { readonly value: MarkdownPresentationContext; readonly projectedFrom?: never }
  | { readonly projectedFrom: number; readonly value?: never };

export type MarkdownParseResponse = { readonly id: number } & (
  | { readonly kind: 'syntax'; readonly grammar: string; readonly length: number; readonly tree: MarkdownTreeTransfer;
      readonly languageHosts: Float64Array;
      readonly tabSize: number; readonly error?: never } & SourceContextReceipt
  | { readonly kind: 'blocks'; readonly tabSize: number; readonly error?: never } & PresentationContextReceipt
  | { readonly error: string; readonly tree?: never }
);
