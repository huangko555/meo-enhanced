import { IterMode, type Tree } from '@lezer/common';

/** Compare trees for the same immutable Markdown text. Embedded language parsing
 * does not change Live's Markdown presentation. False also means inconclusive. */
export function hasSameLiveMarkdownSyntax(left: Tree, right: Tree): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const first = left.cursor(IterMode.IgnoreMounts), second = right.cursor(IterMode.IgnoreMounts);
  // A cold completeness check must not become another unbounded input scan.
  for (let nodes = 0; nodes < 131_072; nodes++) {
    if (first.type !== second.type || first.from !== second.from || first.to !== second.to) return false;
    const moreFirst = first.next(), moreSecond = second.next();
    if (!moreFirst || !moreSecond) return moreFirst === moreSecond;
  }
  return false;
}
