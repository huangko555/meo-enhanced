/** Matches the anchors used by Markdown Preview and exported documents. */
export function markdownHeadingAnchor(value: string): string {
  return value.trim().toLowerCase().replace(/<[^>]*>/g, '')
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, '')
    .replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}
