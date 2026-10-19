import { IterMode, type Tree } from '@lezer/common';
import type { ChangeDesc } from '@codemirror/state';

/** Compare trees for the same immutable Markdown text. Embedded language parsing
 * does not change Live's Markdown presentation. False also means inconclusive. */
export function hasSameLiveMarkdownSyntax(left: Tree, right: Tree): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  const first = left.cursor(IterMode.IgnoreMounts), second = right.cursor(IterMode.IgnoreMounts);
  // A cold completeness check must not become another unbounded input scan.
  for (let nodes = 0; nodes < 131_072; nodes++) {
    if (first.type !== second.type || first.from !== second.from || first.to !== second.to) return false;
    // Incremental parsing preserves immutable outer subtrees even when a
    // mounted language republishes its parent. Matching node identity and
    // bounds already prove every descendant, without flattening it again.
    const enter = !first.tree || first.tree !== second.tree;
    const moreFirst = first.next(enter), moreSecond = second.next(enter);
    if (!moreFirst || !moreSecond) return moreFirst === moreSecond;
  }
  return false;
}

/** Certify the unchanged outer Markdown when a language mounted inside code is
 * still parsing. A same-length partial tree is insufficient: every node outside
 * the edited source block must match at its mapped position. */
export function hasSameLiveMarkdownOutsideBlock(left: Tree, right: Tree, changes: ChangeDesc,
  before: { from: number; to: number }, after: { from: number; to: number }): boolean {
  if (changes.newLength !== right.length || changes.length !== left.length) return false;
  const first = left.cursor(IterMode.IgnoreMounts), second = right.cursor(IterMode.IgnoreMounts);
  const advance = (cursor: typeof first, scope: { from: number; to: number }, enter: boolean) => {
    while (cursor.next(enter)) {
      if (cursor.from >= scope.from && cursor.to <= scope.to) { enter = false; continue; }
      return true;
    }
    return false;
  };
  let enter = true;
  for (let nodes = 0; nodes < 131_072; nodes++) {
    const moreFirst = advance(first, before, enter), moreSecond = advance(second, after, enter);
    if (!moreFirst || !moreSecond) return moreFirst === moreSecond;
    if (first.type !== second.type || changes.mapPos(first.from, 1) !== second.from
      || changes.mapPos(first.to, -1) !== second.to) return false;
    // A shared tree outside the edit maps by one constant displacement. Do not
    // skip a tree that spans another change, even if its endpoints still match.
    enter = !first.tree || first.tree !== second.tree || !!changes.touchesRange(first.from, first.to);
  }
  return false;
}
