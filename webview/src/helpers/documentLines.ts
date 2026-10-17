import type { Line, Text } from '@codemirror/state';

type DocumentLine = Pick<Line, 'from' | 'to' | 'number' | 'text' | 'length'>;

/**
 * Walks immutable text once. Full-document fallbacks should use this instead of
 * seeking each line through the text tree and then slicing the same text again.
 * No document-sized cache is retained by editor history.
 */
export function* documentLines(document: Text): IterableIterator<DocumentLine> {
  let from = 0;
  let number = 1;
  for (const text of document.iterLines()) {
    const length = text.length;
    yield { from, to: from + length, number, text, length };
    from += length + 1;
    number += 1;
  }
}
