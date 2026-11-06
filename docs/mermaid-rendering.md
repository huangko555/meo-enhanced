# Mermaid rendering

The extension ships one lazy module graph built from Mermaid 12.0.0. SystemJS
loads the same graph in the editor and exported HTML, including directly opened
local files. The editor's native ESM entry and the export script are small
bridges to that graph. ELK is the default for flowcharts, state, class and ER diagrams. Leave the
global layout unset so mindmaps retain their dedicated cose-bilkent layout.
The host selects `classic` and the customizable `base` theme. Diagram authors can
still override the layout, theme, look and `classDef` colors in their source.

Live, Preview and export share the editor's gray surfaces and blue accents in
`src/shared/mermaidPalette.ts`. Preview follows its selected light/dark appearance;
HTML and PDF follow the selected reading appearance; Word uses a light page. Fonts continue to follow
the reading surface. The build preserves all diagram loaders and wraps the unchanged official ELK
worker source in a loadable module. Layout still runs in a dedicated Blob Worker,
with the existing queue, timeout, cancellation and idle-retirement policy.
Rendering loads only packaged resources.

Ordinary diagrams use neutral nodes, text and sequence notes; connections use the
existing blue accent. Pie charts use twelve opaque official Catppuccin Mocha
accents, starting with blue, with dark percentage labels on both light and dark
surfaces. Titles and legends follow the surface. This categorical mapping is
maintained here, not an official Catppuccin Mermaid port.
Categorical color source: https://github.com/catppuccin/catppuccin#-palette.

Word embeds rendered diagrams as PNG images, sized to the A4 page's usable width
and height to avoid cropping tall graphs. PDF keeps diagram headings and one
short description paragraph with the graph; very tall diagrams are scaled to
fit the page. This does not make Word diagram contents editable.

Source split Preview keeps the last valid SVG while preparing a replacement,
including during incomplete syntax. A completed render must still match the
current editor text, even before the next debounced Preview request starts.
Independent Preview scrolling maps its reading anchor through source edits and
diagram height changes; linked scrolling retains the existing interaction owner.

Live block Preview/Split share a transient camera per opening fence. Editing,
undo/redo, mode changes and theme refresh retain zoom/pan; temporary invalid syntax
does not clear it. Successful SVG diagram-type changes, explicit Reset and replacing
the opening fence start a default view. Cameras follow document changes, remain
independent for identical source, and are never stored in SVG caches or Markdown.
After rendering, fully offscreen content receives only the minimum pan correction
needed to bring an edge into reach. Layout can still move nodes within the graph.
Run `bun scripts/test-mermaid-viewport-persistence.ts` for these interactions and
actual Mermaid rendering, alongside `bun scripts/test-mermaid-visible-controls.ts`.

Run `bun run build` then `bun run test:mermaid-compatibility` to check real Live and
Preview rendering, Source typing and focus, stale-render rejection, reading
anchors, author overrides, multiple diagram types and HTML/PDF/Word output.
The layout test compares actual SVG geometry against explicit ELK and Dagre
renders rather than accepting a configuration string as proof of ELK activation.

Mermaid 12 targets ES2024. Browser coverage uses the installed Chromium browser
and does not establish compatibility with every older VS Code/Electron release.
