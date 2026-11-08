/** Shared by GitHub Preview and standalone HTML/PDF; the default renderer keeps its own theme. */
export function getGithubMermaidConfig(darkMode: boolean) {
  const edgeBackground = darkMode ? '#333333' : 'rgba(232,232,232,.8)';
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: darkMode ? 'dark' : 'default',
    fontFamily: '"trebuchet ms", verdana, arial, sans-serif',
    themeVariables: { darkMode },
    htmlLabels: true,
    markdownAutoWrap: true,
    flowchart: { htmlLabels: true, diagramPadding: 48, padding: 8, rankSpacing: 40, nodeSpacing: 40, wrappingWidth: 120 },
    // GitHub's current renderer reserves room for narrow labels and labelled edges.
    // Measure these spaces during layout rather than stretching the resulting SVG.
    // Mermaid's inline wrapping cap must not shrink a label below its measured foreignObject.
    themeCSS: `.node .label foreignObject div { min-width: 120px; max-width: none !important; padding-block: 4px; }
.edgeLabel .label foreignObject div:has(p:not(:empty)) { padding: 20px; background: transparent; }
.edgeLabel p { background: ${edgeBackground}; width: max-content; margin: 0 auto; }
.node rect, .node polygon, .node circle, .node .outer-path { filter: drop-shadow(1px 2px 2px rgba(185,185,185,1)); }`,
    legacyMathML: true,
    forceLegacyMathML: true
  } as const;
}
