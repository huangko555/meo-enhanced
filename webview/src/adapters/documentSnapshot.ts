import { ChangeSet, Text } from '@codemirror/state';
import { normalizeDocumentText } from '../../../src/foundation/documentText';
import type { DocumentTextEdit, DocumentTextSnapshot } from '../../../src/foundation/documentSnapshot';

const snapshots = new WeakMap<Text, CodeMirrorDocumentSnapshot>();

class CodeMirrorDocumentSnapshot implements DocumentTextSnapshot {
  private cachedText: string | undefined;
  constructor(readonly value: Text) {}
  get length(): number { return this.value.length; }
  sliceString(from: number, to: number): string { return this.value.sliceString(from, to); }
  equals(other: DocumentTextSnapshot): boolean {
    return other instanceof CodeMirrorDocumentSnapshot
      ? this.value.eq(other.value) : this.toString() === other.toString();
  }
  replace(from: number, to: number, insert: string): DocumentTextSnapshot {
    return documentSnapshot(this.value.replace(from, to, Text.of(insert.split('\n'))));
  }
  toString(): string { return this.cachedText ??= this.value.toString(); }
}

export function documentSnapshot(text: Text): DocumentTextSnapshot {
  let snapshot = snapshots.get(text);
  if (!snapshot) { snapshot = new CodeMirrorDocumentSnapshot(text); snapshots.set(text, snapshot); }
  return snapshot;
}

export function documentSnapshotFromString(text: string): DocumentTextSnapshot {
  return documentSnapshot(Text.of(normalizeDocumentText(text).split('\n')));
}

class CodeMirrorDocumentEdit implements DocumentTextEdit {
  private cachedChanges: DocumentTextEdit['changes'] | undefined;
  readonly before: DocumentTextSnapshot;
  readonly after: DocumentTextSnapshot;
  constructor(readonly changeSet: ChangeSet, before: Text, after: Text) {
    this.before = documentSnapshot(before);
    this.after = documentSnapshot(after);
  }
  get changes(): DocumentTextEdit['changes'] {
    if (!this.cachedChanges) {
      const before = this.before;
      const after = this.after;
      const splitsPair = (text: DocumentTextSnapshot, offset: number): boolean => offset > 0 && offset < text.length
        && /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text.sliceString(offset - 1, offset + 1));
      const ranges: { from: number; to: number; fromB: number; toB: number }[] = [];
      this.changeSet.iterChanges((from, to, fromB, toB) => {
        if (splitsPair(before, from) || splitsPair(after, fromB)) { from -= 1; fromB -= 1; }
        if (splitsPair(before, to) || splitsPair(after, toB)) { to += 1; toB += 1; }
        const previous = ranges.at(-1);
        if (previous && from <= previous.to) {
          previous.to = Math.max(previous.to, to);
          previous.toB = Math.max(previous.toB, toB);
        } else ranges.push({ from, to, fromB, toB });
      });
      this.cachedChanges = ranges.map(range => ({ from: range.from, to: range.to,
        insert: after.sliceString(range.fromB, range.toB) }));
    }
    return this.cachedChanges;
  }
  compose(next: DocumentTextEdit): DocumentTextEdit {
    if (!(next instanceof CodeMirrorDocumentEdit) || !this.after.equals(next.before)) {
      throw new Error('Document edits do not share a text checkpoint');
    }
    return new CodeMirrorDocumentEdit(this.changeSet.compose(next.changeSet),
      (this.before as CodeMirrorDocumentSnapshot).value, (next.after as CodeMirrorDocumentSnapshot).value);
  }
  invert(): DocumentTextEdit {
    return new CodeMirrorDocumentEdit(this.changeSet.invert((this.before as CodeMirrorDocumentSnapshot).value),
      (this.after as CodeMirrorDocumentSnapshot).value, (this.before as CodeMirrorDocumentSnapshot).value);
  }
}

export function documentEdit(changes: ChangeSet, before: Text, after: Text): DocumentTextEdit {
  return new CodeMirrorDocumentEdit(changes, before, after);
}
