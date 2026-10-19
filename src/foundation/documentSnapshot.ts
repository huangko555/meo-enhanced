/** Immutable text owned by the document session; full strings are read at I/O seams. */
export interface DocumentTextSnapshot {
  readonly length: number;
  sliceString(from: number, to: number): string;
  equals(other: DocumentTextSnapshot): boolean;
  replace(from: number, to: number, insert: string): DocumentTextSnapshot;
  toString(): string;
}

export type DocumentText = string | DocumentTextSnapshot;
export type DocumentTextChange = Readonly<{ from: number; to: number; insert: string }>;

/** Coordinates refer to before, including when several changes form one transaction. */
export interface DocumentTextEdit {
  readonly before: DocumentTextSnapshot;
  readonly after: DocumentTextSnapshot;
  readonly changes: readonly DocumentTextChange[];
  compose(next: DocumentTextEdit): DocumentTextEdit;
  invert(): DocumentTextEdit;
}

export const readDocumentText = (text: DocumentText): string => typeof text === 'string' ? text : text.toString();
export const equalDocumentText = (left: DocumentText, right: DocumentText): boolean => left === right
  || (left.length === right.length && (typeof left === 'string' || typeof right === 'string'
    ? readDocumentText(left) === readDocumentText(right) : left.equals(right)));

/** Compare only replaced ranges; undoing to the base need not compare the whole document. */
export const isEmptyDocumentEdit = (edit: DocumentTextEdit): boolean => edit.changes.every(
  change => change.to - change.from === change.insert.length
    && edit.before.sliceString(change.from, change.to) === change.insert
);
