/**
 * Canonical logical text shared by Draft, Revision and presentation identities.
 * Adapters retain responsibility for the Host document's physical line endings.
 */
export const normalizeDocumentText = (text: string): string => text.replace(/\r\n?/g, '\n');
