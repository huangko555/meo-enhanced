/**
 * Canonical logical text shared by Draft, Revision and presentation identities.
 * Adapters retain responsibility for the Host document's physical line endings.
 */
export const normalizeDocumentText = (text: string): string => (
  // CodeMirror already emits LF. Keep this common path out of the regexp
  // engine on every Draft/Revision receipt; physical CRLF still enters below.
  text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
);

/** One bounded UTF-16 replacement, preserving complete surrogate pairs. */
export function createDocumentTextReplacement(previousText: string, nextText: string): {
  readonly from: number; readonly to: number; readonly insert: string;
} {
  let from = 0;
  const commonLength = Math.min(previousText.length, nextText.length);
  while (from < commonLength && previousText.charCodeAt(from) === nextText.charCodeAt(from)) from += 1;
  let previousTo = previousText.length;
  let nextTo = nextText.length;
  while (previousTo > from && nextTo > from
    && previousText.charCodeAt(previousTo - 1) === nextText.charCodeAt(nextTo - 1)) {
    previousTo -= 1;
    nextTo -= 1;
  }
  if (splitsSurrogatePair(previousText, from) || splitsSurrogatePair(nextText, from)) from -= 1;
  if (splitsSurrogatePair(previousText, previousTo) || splitsSurrogatePair(nextText, nextTo)) {
    previousTo += 1;
    nextTo += 1;
  }
  return { from, to: previousTo, insert: nextText.slice(from, nextTo) };
}

function splitsSurrogatePair(text: string, offset: number): boolean {
  const before = text.charCodeAt(offset - 1);
  const after = text.charCodeAt(offset);
  return before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
}
