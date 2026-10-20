// Full strings are disposable projections of persistent CodeMirror Text. Do not
// store one on every historical snapshot: undo can retain many old revisions.
type ImmutableText = Readonly<{ toString(): string }>;
const projections = new Map<ImmutableText, string>();
const maximumBytes = 8 * 1024 * 1024;
let retainedBytes = 0;

/** All consumers of one immutable revision share its flattening, within a byte budget. */
export function readDocumentTextProjection(snapshot: ImmutableText): string {
  const cached = projections.get(snapshot);
  if (cached !== undefined) {
    projections.delete(snapshot); projections.set(snapshot, cached);
    return cached;
  }
  const text = snapshot.toString();
  rememberDocumentTextProjection(snapshot, text);
  return text;
}

/** The producer has just constructed this exact immutable text from the string. */
export function rememberDocumentTextProjection(snapshot: ImmutableText, text: string): void {
  const previous = projections.get(snapshot);
  if (previous !== undefined) { retainedBytes -= previous.length * 2; projections.delete(snapshot); }
  projections.set(snapshot, text); retainedBytes += text.length * 2;
  // An individual oversized current document remains usable. Adding another
  // projection evicts it; history never turns this exception into an unbounded cache.
  while (retainedBytes > maximumBytes && projections.size > 1) {
    const oldest = projections.keys().next().value!;
    retainedBytes -= projections.get(oldest)!.length * 2; projections.delete(oldest);
  }
}
