import { readFileSync } from 'node:fs';

export function mermaidLabelPlugin(adapter, labelStyles) {
  const boundaries = [
    {
      name: 'SVG configuration',
      filter: /[\\/]mermaid[\\/]dist[\\/]mermaid\.core\.mjs$/,
      marker: '  const svg = element.firstChild;\n  const firstChild = svg.firstChild;',
      edit: `  const svg = element.firstChild;\n  enableAdaptiveMermaidLabels(svg, config, processed.config, mermaidLabelThemeCss);\n  const firstChild = svg.firstChild;`,
      helper: 'enableAdaptiveMermaidLabels',
      imports: `import { mermaidLabelThemeCss } from ${JSON.stringify(labelStyles)};\n`
    },
    {
      name: 'HTML label measurement',
      filter: /[\\/]mermaid[\\/]dist[\\/]chunks[\\/]mermaid\.core[\\/].*\.mjs$/,
      marker: '  const bbox = await fastdom_default2.measure(() => div.node().getBoundingClientRect());\n  if (bbox.width === width) {',
      edit: `  const finishMeasurement = prepareMermaidLabelMeasurement(div.node(), width, minWidth);
  const bbox = await fastdom_default2.measure(() => div.node().getBoundingClientRect());
  if (finishMeasurement) {
    finishMeasurement(bbox.width);
  } else if (bbox.width === width) {`,
      helper: 'prepareMermaidLabelMeasurement'
    }
  ];
  const patched = new Set();
  return {
    plugin: { name: 'mermaid-label-layout', setup(builder) {
      for (const boundary of boundaries) builder.onLoad({ filter: boundary.filter }, ({ path }) => {
        const source = readFileSync(path, 'utf8');
        if (!source.includes(boundary.marker)) return;
        if (patched.has(boundary.name) || source.split(boundary.marker).length !== 2) {
          throw new Error(`Ambiguous Mermaid ${boundary.name} boundary`);
        }
        patched.add(boundary.name);
        const imports = `import { ${boundary.helper} } from ${JSON.stringify(adapter)};\n${boundary.imports ?? ''}`;
        return { contents: imports + source.replace(boundary.marker, boundary.edit), loader: 'js' };
      });
    } },
    verify() {
      for (const { name } of boundaries) if (!patched.has(name)) throw new Error(`Missing Mermaid ${name} boundary`);
    }
  };
}
