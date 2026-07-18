export type SourceMappedMarkdown = {
  markdown: string;
  sourceLines: number[];
};

export function sliceSourceMappedMarkdown(
  source: SourceMappedMarkdown,
  startLineIndex: number
): SourceMappedMarkdown {
  return {
    markdown: source.markdown.split(/\r?\n/).slice(startLineIndex).join('\n'),
    sourceLines: source.sourceLines.slice(startLineIndex)
  };
}
