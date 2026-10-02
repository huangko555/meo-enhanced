import { markdownHeadingAnchor } from '../foundation/markdownHeadingAnchor';

/** Count every heading before filtering so search never changes a duplicate's anchor. */
export function markdownHeadingCandidates(headings: readonly { text: string; source: string; line: number }[]) {
  const counts = new Map<string, number>();
  return headings.map(heading => {
    const base = markdownHeadingAnchor(heading.source);
    const occurrence = (counts.get(base) ?? 0) + 1; counts.set(base, occurrence);
    return { text: heading.text, line: heading.line, anchor: occurrence === 1 ? base : `${base}-${occurrence}` };
  });
}
