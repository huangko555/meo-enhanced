import { createMarkdownHeadingAnchors } from '../foundation/markdownHeadingAnchor';

/** Count every heading before filtering so search never changes a duplicate's anchor. */
export function markdownHeadingCandidates(headings: readonly { text: string; source: string; line: number }[]) {
  const anchor = createMarkdownHeadingAnchors();
  return headings.map(heading => ({ text: heading.text, line: heading.line, anchor: anchor(heading.source) }));
}
