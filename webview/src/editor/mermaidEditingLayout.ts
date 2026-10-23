export type MermaidEditingLayout = 'stacked' | 'side-by-side';
export const MERMAID_SIDE_MIN_WIDTH = 760;

/** A first-entry preference; never rearrange the editor while typing. */
export function chooseMermaidEditingLayout(input: {
  width: number;
  height: number;
  sourceRows: number;
  lineHeight: number;
  diagram: { width: number; height: number } | null;
}): MermaidEditingLayout {
  const { width, height, diagram } = input;
  if (width < MERMAID_SIDE_MIN_WIDTH || !diagram || diagram.width <= 0 || diagram.height <= 0) return 'stacked';
  const sourceHeight = input.sourceRows * input.lineHeight;
  const diagramHeight = diagram.height * Math.min(1, Math.max(0, width - 48) / diagram.width);
  if (sourceHeight + diagramHeight + 80 < height * 0.8) return 'stacked';
  const ratio = diagram.width / diagram.height;
  if (ratio >= 1.8) return 'stacked';
  if (ratio <= 0.6 || sourceHeight >= height * 0.5 || sourceHeight + diagramHeight + 80 > height) return 'side-by-side';
  return 'stacked';
}
