/** Matches the anchors used by Markdown Preview and exported documents. */
export function markdownHeadingAnchor(value: string): string {
  return value.trim().toLowerCase().replace(/<[^>]*>/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}

/** Allocates unique anchors in document order; the first heading to claim an anchor keeps it. */
export function createMarkdownHeadingAnchors(): (source: string) => string {
  const counts = new Map<string, number>();
  const used = new Set<string>();
  return source => {
    const base = markdownHeadingAnchor(source);
    let occurrence = counts.get(base) ?? 0, anchor: string;
    do {
      occurrence += 1;
      anchor = occurrence === 1 ? base : `${base}-${occurrence}`;
    } while (used.has(anchor));
    counts.set(base, occurrence);
    used.add(anchor);
    return anchor;
  };
}
