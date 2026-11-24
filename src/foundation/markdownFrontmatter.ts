/** Lines owned by leading frontmatter, including both delimiters; 0 without a closed block. */
export function markdownFrontmatterLineCount(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return 0;
  return lines.findIndex((line, index) => index > 0 && line.trim() === '---') + 1;
}

/** Excludes frontmatter from a Markdown parse while keeping later line numbers. */
export function blankMarkdownFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  const count = markdownFrontmatterLineCount(lines);
  return count ? lines.fill('', 0, count).join('\n') : text;
}
