// Mermaid measures these HTML labels before mounting the SVG. Give the label
// box the same wrapping rules in both contexts while honoring its max-width.
export const mermaidLabelThemeCss = `
div:has(> .nodeLabel > p),
div:has(> .edgeLabel > p) {
  display: block !important;
  width: max-content !important;
}
/* Mermaid may reserve more space than the node label's wrapping width. */
div:has(> .nodeLabel > p) {
  margin-inline: auto;
}
.nodeLabel > p,
.edgeLabel > p {
  white-space: normal !important;
  overflow-wrap: anywhere !important;
  word-break: normal !important;
}`;
