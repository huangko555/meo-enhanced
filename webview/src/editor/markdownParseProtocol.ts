import type { MarkdownTreeTransfer } from './markdownTreeTransfer';

export type MarkdownParseRequest = { readonly id: number; readonly base: number } & (
  | { readonly text: string; readonly changes?: never }
  | { readonly changes: unknown; readonly text?: never }
);
export type MarkdownParseResponse = { readonly id: number } & (
  | { readonly grammar: string; readonly length: number; readonly tree: MarkdownTreeTransfer; readonly error?: never }
  | { readonly error: string; readonly tree?: never }
);
