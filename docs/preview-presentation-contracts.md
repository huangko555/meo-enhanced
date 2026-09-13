# Preview presentation contracts

This document records the invariants that keep Source-side Preview stable. They
apply to both the split Preview and the standalone Preview surface because both
use the same presentation controller.

## Source-to-Preview geometry

- Source lookup and visual lookup are different indexes. Source navigation is
  ordered by source range; Preview capture is ordered by rendered geometry.
- Continuous linked scrolling uses only the longest monotonic in-flow path.
  Semantic blocks that render elsewhere, such as footnote definitions at the
  end of the document, remain available for explicit navigation but must not
  flatten or reverse the main reading-flow projection.
- Nested mappings may describe both a container and its descendants. They are
  input evidence, not independent scroll owners. The cached projection resolves
  them before the scroll hot path; a scroll frame performs no DOM scan.
- Exactly one surface owns a scroll gesture. A follower write must not claim
  ownership or echo a new projection back to the driver.
- Mode transitions carry a continuous position inside the most specific rendered
  source range, not only an integer source line. The destination is measured at
  its final width before that position is projected.
- When a split Preview is already visible and becomes the standalone Preview,
  it remains the transition anchor owner. The final-width layout reprojects that
  same Preview reading point instead of recapturing an approximate Source line.

VS Code's Markdown Preview follows the same broad model: it caches mapped
elements by document version, ignores duplicate list and `pre` containers,
special-cases fenced-code ranges, and filters elements that are not visibly
rendered. See the official
[`scroll-sync.ts`](https://github.com/microsoft/vscode/blob/main/extensions/markdown-language-features/preview-src/scroll-sync.ts).
Its 2026 scroll-sync regression also documents why a reverse-sync guard must
remain active for the whole gesture instead of being cleared by the first
echoed event: [microsoft/vscode#307762](https://github.com/microsoft/vscode/issues/307762).

## Atomic asynchronous presentation

- A visible Mermaid diagram, decoded image, or Shiki-highlighted code block is
  retained until its replacement is ready.
- A changed code block must not expose the renderer's fallback token markup and
  then recolor it in a later visible frame. Tokens are requested while the last
  fully themed block remains connected; the new source and Shiki token DOM are
  committed together.
- Unchanged nodes survive incremental updates so selection, expanded details,
  decoded assets, and layout identity are not discarded.
- A content edit inside or below the visible Preview retains its physical viewport;
  an edit strictly above it maps the top semantic anchor through the text change.
  Presentation-only geometry changes retain the semantic point in the reading
  band, then pin the cached linked-scroll map to the committed position.
- Initial split Preview becomes visible only after both editor layout and Preview
  paint readiness are confirmed. Render completion alone is not a reveal signal.

VS Code's official Preview implementation similarly moves new styles into place
before morphing specifically to prevent an unstyled flash, and preserves equal
nodes during incremental updates. See
[`preview-src/index.ts`](https://github.com/microsoft/vscode/blob/main/extensions/markdown-language-features/preview-src/index.ts).

## Table fit and visible right edge

- Preview tables never create an internal horizontal scrollbar. Column demand
  controls the proportions; when space is insufficient, every column continues
  to shrink and wrap.
- When the readable column target is infeasible, cell padding is reduced before
  content can be clipped. Native list markers are visually omitted only in this
  compressed state because their unbreakable marker box can otherwise exceed a
  narrow cell; the semantic `ul`/`ol`/`li` structure and all text remain intact.
- `scrollWidth <= clientWidth` is not sufficient evidence. Chromium rounds those
  values while collapsed borders and antialiasing use fractional geometry.
- The final painted table edge must remain inside the wrapper's clip edge by at
  least one physical pixel and the declared outer border width. Layout converges
  against `getBoundingClientRect()`, not only the declared CSS width.
- Genuine fixed-width non-table HTML may keep local horizontal overflow, but it
  must not expand the Preview document root.

The browser contract in `scripts/test-source-side-preview.ts` covers the reported
five-column table, narrow many-column tables, raw HTML tables, split Preview,
standalone Preview, displaced footnotes, continuous bidirectional scrolling,
atomic code highlighting, and cross-mode continuous range projection. Delayed
asset geometry is covered by `scripts/test-source-preview-late-layout.ts`. The
standalone reading-surface matrix also checks table descendants across viewport
widths, zoom factors, and device pixel ratios. The pure projection outlier
contract is in `scripts/test-linked-viewport-map.ts`.
