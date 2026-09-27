/** A conservative fetch hint, not a Markdown parser. Keep nested/unfinished fences warm. */
export function shouldPreloadMermaid(text: string): boolean {
  // Mentioning the library in prose or a URL does not require its large runtime.
  // Actual rendering and newly entered diagrams remain owned by the lazy loader.
  // Matching the last three fence characters also accepts longer fences without
  // quadratic backtracking on a long run of delimiters.
  return /(?:`{3}|~{3})[ \t]*mermaid\b/i.test(text);
}
