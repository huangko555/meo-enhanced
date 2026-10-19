/**
 * Canonical logical text shared by Draft, Revision and presentation identities.
 * Adapters retain responsibility for the Host document's physical line endings.
 */
export const normalizeDocumentText = (text: string): string => (
  // CodeMirror already emits LF. Keep this common path out of the regexp
  // engine on every Draft/Revision receipt; physical CRLF still enters below.
  text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
);
